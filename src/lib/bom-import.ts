import { connectDb } from "@/lib/db";
import { inImportOrder, structureFromIndent } from "@/lib/bom-structure";
import { currentProductFor } from "@/lib/products";
import { ActivityLog, BomLink, Part, Product } from "@/lib/models";
import { clientForUser } from "@/lib/onshape/factory";
import { syncPartFromOnshape, configurationNormalizer } from "@/lib/sync";
import type { BomLine, BomTable } from "@/lib/onshape/bom";
import type { AssemblyCoords, OnshapeClient, PartCoords, PartMetadata } from "@/lib/onshape/types";

/**
 * Ceiling on one import.
 *
 * Each line costs a metadata read plus a property write, so a large assembly
 * turns into hundreds of Onshape calls against a rate limit shared with
 * everyone else on the tenant. Importing in slices is a mild inconvenience;
 * exhausting the tenant's quota mid-demo is not.
 */
export const MAX_IMPORT = 100;

export type BomImportLine = {
  key: string;
  name: string;
  partNumber: string;
  quantity: number;
  outcome: "created" | "existing" | "failed" | "skipped";
  number: string | null;
  partId: string | null;
  message: string;
  /** Set when the part was brought in but something about it needs saying. */
  warning: string | null;
};

export type BomImportResult = {
  created: number;
  existing: number;
  failed: number;
  /** Imported, but with something worth reading — usually a failed write-back. */
  warned: number;
  /** Left out deliberately, with a reason. */
  skipped: number;
  /**
   * The product everything in this import was filed into, and why.
   *
   * Reported because it is a decision the import makes on the user's behalf,
   * and the wrong answer splits a product structure in a way that is tedious to
   * unpick — so it should be visible at the moment it happens rather than
   * discovered later on the BOM page.
   */
  product: {
    id: string | null;
    name: string;
    source: "assembly" | "current" | "unassigned";
  };
  /**
   * Parts under this assembly that sit in a different product.
   *
   * Not moved — a part may have been filed elsewhere deliberately, and an
   * import is the wrong event to override that. Named so somebody can decide,
   * with the BOM page's bulk move as the remedy.
   */
  elsewhere: { partId: string; number: string | null; productName: string }[];
  /**
   * Structure edges removed because the assembly no longer has them.
   *
   * Reported because it is the one outcome of an import that takes something
   * away, and somebody watching a BOM shrink deserves to be told rather than
   * left to notice.
   */
  removedLinks: number;
  lines: BomImportLine[];
};

export type AssemblyInfo = {
  documentId: string;
  elementId: string;
  documentName: string;
  elementName: string;
  /** PARTSTUDIO | ASSEMBLY | ... , or null when Onshape did not say. */
  elementType: string | null;
  workspaceId: string | null;
  versionId: string | null;
};

/** Name the assembly for provenance and for the page heading. */
export async function describeAssembly(
  client: OnshapeClient,
  coords: AssemblyCoords
): Promise<AssemblyInfo> {
  // getElementInfo keys off document/workspace/element; partId is unused here.
  const probe: PartCoords = {
    documentId: coords.documentId,
    elementId: coords.elementId,
    partId: "",
    workspaceId: coords.workspaceId ?? null,
    versionId: coords.versionId ?? null,
  };

  const [doc, el] = await Promise.all([
    client.getDocumentInfo(coords.documentId).catch(() => ({ name: "", defaultWorkspaceId: null, accessError: null, canWrite: null })),
    client.getElementInfo(probe).catch(() => null),
  ]);

  /*
   * The assembly's Name property, for the configuration being read.
   *
   * The tab name is one string whatever the configuration, but an assembly's
   * Name property can be driven by its configuration ("… 50 kg"), and that is
   * the name people mean. Falls back to the tab name if Onshape will not say.
   */
  let configuredName = "";
  if (coords.configuration && coords.configuration !== "default") {
    try {
      const md = await client.getPartMetadata({ ...probe, configuration: coords.configuration });
      configuredName = String(md.partName || "").trim();
    } catch {
      // Cosmetic; the tab name below still identifies the assembly.
    }
  }

  return {
    documentId: coords.documentId,
    elementId: coords.elementId,
    documentName: doc.name,
    elementName: configuredName || el?.name || "",
    elementType: el?.elementType || null,
    workspaceId: coords.workspaceId ?? null,
    versionId: coords.versionId ?? null,
  };
}

/**
 * Decide which coordinates to enrol a BOM row under.
 *
 * A row can name its source by version or microversion, both immutable. Where a
 * writable workspace can be found PLM uses it, which is the same
 * substitution the webhook receiver makes for revision events, so every
 * enrolment path lands on identical coordinates.
 *
 * When one cannot be found — typically a part pulled from a linked library
 * document the user can reach through the assembly but cannot open on its own —
 * the version coordinates are used anyway. They read perfectly well; only the
 * MO-number write back into Onshape will fail.
 *
 * That distinction matters: being unable to stamp a number onto somebody else's
 * library part is not a reason to refuse to *track* it. The part is
 * created either way and the failed push is recorded against it, which is
 * exactly how the rest of PLM treats a write it could not complete.
 */
async function resolveImportCoords(
  client: OnshapeClient,
  line: BomLine
): Promise<{ coords: PartCoords; writable: boolean; reason: string | null }> {
  const src = line.source!;
  const doc = await client.getDocumentInfo(src.documentId);
  const where = doc.name ? `"${doc.name}"` : `document ${src.documentId}`;

  // A workspace is where writes have to go; a version cannot take one.
  const workspaceId = src.workspaceId ?? doc.defaultWorkspaceId;

  if (doc.canWrite !== false && workspaceId) {
    // Keep the version the BOM named. The workspace is only where the MO number
    // goes; the version is the one the assembly actually uses, and it is what
    // the part's revision and state should be read from.
    return { coords: { ...src, workspaceId, versionId: src.versionId ?? null }, writable: true, reason: null };
  }

  // Not writable. Read the part exactly as the BOM named it, which for a
  // library part is the version the assembly actually uses.
  if (doc.canWrite === false) {
    return {
      coords: src,
      writable: false,
      reason:
        `Tracked, but the MO number was not written back: ${where} is read-only to this ` +
        `account. Library and standard-content parts — screws, washers, bearings — live in ` +
        `documents nobody can write to, so there is nowhere to put the number.`,
    };
  }

  if (src.versionId) {
    const because = doc.accessError
      ? `it cannot be opened directly (${doc.accessError.slice(0, 160)})`
      : "it reports no default workspace";
    return {
      coords: src,
      writable: false,
      reason:
        `Tracked, but the MO number could not be written back: this part lives in ${where}, ` +
        `referenced by the assembly at a fixed version, and ${because}.`,
    };
  }

  const because = doc.accessError
    ? `it cannot be opened directly (${doc.accessError.slice(0, 160)})`
    : "it reports no default workspace";
  throw new Error(
    `Cannot read this part: it lives in ${where}, the BOM references it by ` +
    `${line.sourceWvmType === "m" ? "a microversion" : "no usable version"}, and ${because}.`
  );
}

/**
 * Everything PLM mirrors, taken from the BOM row instead of the part.
 *
 * Used only when the part's own document is unreadable. The bill of materials
 * is a first-class Onshape source — it is how the assembly reports what it is
 * built from — so a part described there is properly tracked, not guessed at.
 * The values are labelled as coming from the BOM so nobody later mistakes them
 * for a direct read.
 */
function metadataFromBomRow(
  line: BomLine,
  coords: PartCoords,
  assembly: AssemblyInfo
): PartMetadata {
  const fields: [string, string][] = [
    ["Part number", line.partNumber],
    ["Name", line.name],
    ["Description", line.description],
    ["Material", line.material],
    ["Revision", line.revision],
    ["State", line.state],
    ["Vendor", line.vendor],
    ["Project", line.project],
    ["Quantity in assembly", String(line.quantity)],
  ];

  return {
    coords,
    documentName: assembly.documentName,
    elementName: `${assembly.elementName || "assembly"} (bill of materials)`,
    partName: line.name,
    partNumber: line.partNumber,
    revision: line.revision,
    description: line.description,
    material: line.material,
    state: line.state,
    vendor: line.vendor,
    project: line.project,
    // No propertyIds exist for BOM columns, so there is nothing to key by and
    // nothing to teach the property map.
    raw: {},
    definitions: [],
    properties: fields
      .filter(([, v]) => v)
      .map(([name, value]) => ({ propertyId: "", name: `${name} (from BOM)`, value })),
  };
}

/**
 * Whether a row can be brought into PLM, and why not when it cannot.
 *
 * A missing part number is NOT a reason. **PLM is the number master**: it
 * issues the number and writes it back onto the Onshape part, so an unnumbered
 * part is the normal case on the way in, not a defect to be sent back.
 *
 * That check was inherited from MOS, where a part number was a precondition for
 * raising a manufacturing order against an existing number. It greyed the row
 * out with "give the part a number in Onshape and import the assembly again" —
 * advice that asked the user to do by hand the one job PLM exists to do. A
 * companion heuristic (`partNumberColumnMissing`) existed purely to soften it
 * when the column looked unmapped, and went with it.
 *
 * What genuinely blocks a row is not being able to identify the part in
 * Onshape: no document, no tab, or no part id. Those are addresses, not data
 * PLM can supply.
 */
export function assessLine(line: BomLine): { importable: boolean; reason: string | null } {
  /*
   * A subassembly is importable, as an assembly.
   *
   * It was refused because MOS could only raise a manufacturing order for a
   * part. PLM tracks assemblies, and refusing them here is what flattened a
   * multi-level BOM: the subassembly was skipped and its children were
   * attached to whatever was above it.
   *
   * `source` is the test that remains, and it is the right one — a row PLM
   * cannot address in Onshape is a row it cannot track, whatever it is.
   */
  if (!line.source) {
    return { importable: false, reason: line.unresolvable };
  }
  return { importable: true, reason: null };
}

/**
 * Record that a parent consumes a quantity of a child.
 *
 * An upsert on the parent/child pair, because an assembly's own bill of
 * materials is the only source of truth for how many of a part IT uses — so a
 * re-import of that assembly replaces its own edge outright, and every other
 * parent's edge is untouched. Importing assembly A tells PLM nothing about
 * assembly B.
 *
 * Where-used is the same collection read from the other end: query by childId
 * instead of parentId. That symmetry is the reason structure lives in its own
 * collection rather than in an array on the parent — with embedded arrays,
 * "where is this used" means scanning every assembly in the tenant.
 */
export async function upsertBomLink(
  enterpriseId: string,
  parentId: string,
  childId: string,
  quantity: number,
  source: { documentId: string; elementId: string },
  findNumber = ""
): Promise<void> {
  // A part that somehow appears inside itself would make the structure cyclic
  // and every tree walk non-terminating. Onshape will not produce this, but a
  // stale identity collapse could, and the cost of the check is nothing.
  if (parentId === childId) return;

  /*
   * The fields are named, not spread, and that is load-bearing.
   *
   * `effectiveFrom` and `effectiveTo` on the edge are PLM's own — a CAD BOM has
   * no notion of a date — so a re-import must not touch them. Somebody who set
   * a component to be superseded next quarter would otherwise lose it the next
   * time the assembly was re-read, and the BOM would quietly go back to showing
   * the old component for ever.
   */
  await BomLink.updateOne(
    { enterpriseId, parentId, childId },
    {
      $set: {
        quantity,
        findNumber,
        sourceDocumentId: source.documentId,
        sourceElementId: source.elementId,
        lastImportedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/** Rows that could become PLM parts, in BOM order. */
export function importableLines(table: BomTable): BomLine[] {
  return table.lines.filter((l) => assessLine(l).importable);
}

/**
 * Bring selected BOM rows into PLM as parts, under the assembly's structure.
 *
 * The caller sends only the row keys; the quantities and coordinates are taken
 * from a fresh server-side BOM read. That is the whole point of the feature —
 * quantities come from the model, not from a number somebody typed — so they
 * must not be accepted from the browser.
 *
 * One bad row never aborts the batch: a part in a document the user cannot
 * reach, or one whose element has been deleted, is recorded against its own
 * line and the rest of the assembly still imports.
 */
export async function importBomLines(
  session: { userId: string; email: string; enterpriseId: string },
  coords: AssemblyCoords,
  selectedKeys: string[],
  opts: {
    multiLevel?: boolean;
    /**
     * Whether a re-import overwrites quantities already recorded.
     *
     * Quantity lives on the structure edge, and the model is its source of
     * truth — but someone may have corrected one deliberately, so a re-import
     * only overwrites when asked to.
     */
    updateQuantities?: boolean;
    /**
     * Whether to remove edges the assembly no longer has.
     *
     * Applies only to a full import — a partial selection says nothing about
     * the rows left unticked. Defaults to on: a BOM that silently overstates
     * what a product contains is worse than one that drops a row somebody
     * deleted in CAD.
     */
    reconcileStructure?: boolean;
  } = {}
): Promise<{ assembly: AssemblyInfo; result: BomImportResult }> {
  await connectDb();

  /*
   * The product every part in this import is filed into.
   *
   * **Inherited from the assembly when PLM already has it**, and only otherwise
   * from the person importing. That ordering is the point: one assembly's parts
   * belong together, and an import is not a statement about where they should
   * live — it is a statement about what contains what.
   *
   * Without it, adding a subassembly in Onshape months later and re-importing
   * filed the new parts into whatever product the importer happened to have
   * selected at the time, splitting one product structure across two. Nobody
   * chose that; it was simply the only answer the code had.
   *
   * Resolved before anything is created, so the assembly and every part under
   * it get the same answer — including the subassemblies, which are created by
   * the same walk.
   */
  const existingTop: any = await Part.findOne({
    enterpriseId: session.enterpriseId,
    documentId: coords.documentId,
    elementId: coords.elementId,
    partId: "",
  })
    .select("productId productName")
    .lean();

  const inheritedProductId = existingTop?.productId ? String(existingTop.productId) : null;
  const filedInto =
    inheritedProductId ?? (await currentProductFor(session.userId))?.productId ?? null;
  const productSource: "assembly" | "current" | "unassigned" = inheritedProductId
    ? "assembly"
    : filedInto
      ? "current"
      : "unassigned";

  const client = await clientForUser(session.userId);
  const [assembly, table] = await Promise.all([
    describeAssembly(client, coords),
    client.getAssemblyBom(coords, { multiLevel: opts.multiLevel !== false }),
  ]);

  const wanted = new Set(selectedKeys);
  const chosen = importableLines(table).filter((l) => wanted.has(l.key)).slice(0, MAX_IMPORT);

  /*
   * Guard against two BOM rows collapsing onto one PLM part.
   *
   * PLM keys an item by part *without* its configuration when
   * ignoreConfigurations is on, which is the default and is what stops the same
   * part arriving twice through different entry points. Standard content breaks
   * that assumption: an M6x20 and an M6x40 screw are the same document, tab and
   * part id, and differ only in the configuration. Under the default rule they
   * are one item, so importing both would silently overwrite the first one's
   * quantity with the second's.
   *
   * Rather than merge them or change the identity rule, the first is imported
   * and the rest are reported. A wrong quantity that nobody is told about is
   * far worse than a row that explains why it was left out.
   */
  const normalize = await configurationNormalizer(session.enterpriseId);
  const identityOf = (l: BomLine) =>
    `${l.source!.documentId}:${l.source!.elementId}:${l.source!.partId}:${normalize(l.source!.configuration)}`;

  const claimed = new Map<string, BomLine>();
  const collisions = new Map<string, BomLine>();

  for (const line of chosen) {
    const id = identityOf(line);
    const owner = claimed.get(id);
    if (!owner) claimed.set(id, line);
    else if (owner.source!.configuration !== line.source!.configuration) collisions.set(line.key, owner);
  }

  /*
   * The assembly is a PLM object in its own right, and it has to exist before
   * its children can point at it.
   *
   * This is the substantive difference from a quantity-only import, which
   * only ever wanted the leaves. An assembly here is a released, revisioned
   * thing with a structure beneath it — so it is synced first, as kind
   * "assembly", and every edge below is anchored to it.
   */
  let parentPlmId: string | null = null;
  let parentError: string | null = null;
  try {
    const parentSync = await syncPartFromOnshape(
      session.enterpriseId,
      {
        documentId: assembly.documentId,
        elementId: assembly.elementId,
        partId: "",
        configuration: coords.configuration ? normalize(coords.configuration) : "default",
        workspaceId: assembly.workspaceId,
        versionId: assembly.versionId,
      },
      {
        trigger: "bom-import",
        client,
        create: true,
        kind: "assembly",
        createdBy: { userId: session.userId, email: session.email },
        // The assembly belongs in the same product as the parts under it.
        productId: filedInto,
      }
    );
    parentPlmId = parentSync.partId || null;
  } catch (err: any) {
    // The children are still worth importing without it: a structure PLM
    // cannot anchor is a lesser loss than no parts at all.
    parentError = String(err?.message ?? err);
  }

  const lines: BomImportLine[] = [];
  let created = 0;
  let existing = 0;
  let failed = 0;
  let warned = 0;
  let skipped = 0;

  /*
   * The hierarchy, and the bookkeeping the walk needs.
   *
   * `structure` is null for a flat table — a caller that asked Onshape for an
   * unindented BOM gets the old behaviour, every row under the assembly that
   * was read.
   *
   * `plmIdByRow` maps a row's position to the PLM part it became, which is how
   * a child finds its parent. `childrenSeen` records what each parent was
   * observed to contain, for the reconciliation afterwards.
   */
  const structure = table.indented ? structureFromIndent(table) : null;
  const plmIdByRow = new Map<number, string>();
  const childrenSeen = new Map<string, Set<string>>();

  /*
   * Parents before children, which is a precondition rather than a nicety: a
   * child's edge cannot be written until its parent exists in PLM. For a flat
   * table the selection order stands.
   */
  /*
   * The row's index travels with it, rather than being looked up by key.
   *
   * A key is not unique in an indented table — the same part in two
   * subassemblies is deliberately two rows — so a key→index map silently
   * resolved to whichever row came last. When that row happened to be a
   * childless copy of a subassembly, every child of the real one was left
   * unlinked and the import quietly flattened again. Carrying the index
   * removes the lookup, and with it the assumption.
   */
  /*
   * Every importable row, not only the selected ones.
   *
   * A row PLM already tracks needs no sync — nothing changed, and spending an
   * Onshape call to confirm that is exactly what the selection is for
   * avoiding — but it still needs its structure edge, or the BOM view is
   * missing every child that was not freshly selected this time. Before, the
   * walk covered only `chosen`, so an already-tracked part left unticked
   * (which is every one of them, by default — see the panel's "New" filter)
   * was never linked at all: not created, because it existed; not linked,
   * because it was not selected. It simply vanished from the structure.
   *
   * The cap below still applies only to what gets freshly synced — a row
   * that is merely being looked up and linked costs one indexed Mongo read,
   * not an Onshape call, so there is nothing here for MAX_IMPORT to protect.
   */
  const chosenKeys = new Set(chosen.map((c) => c.key));
  const ordered: { line: BomLine; index: number | null }[] = structure
    ? inImportOrder(structure).map((r) => ({ line: r.line, index: r.index }))
    : importableLines(table).map((line) => ({ line, index: null }));

  /*
   * Resolve this row's parent and record the edge to it — the one piece of
   * work shared by a freshly synced row and an already-tracked one merely
   * being linked back in.
   *
   * `plmIdByRow` is filled as the walk proceeds, and the walk is in import
   * order — parents before children — so a child's parent is always already
   * known by the time its edge is written. Every imported row used to be
   * linked to the top-level assembly regardless of depth, which flattened a
   * multi-level BOM: a bolt inside a subassembly became a direct child of the
   * whole product, and the structured BOM view showed one level however deep
   * the CAD went.
   */
  async function linkToParent(
    rowIndex: number | null, childPartId: string, quantity: number
  ): Promise<"linked" | "cycle" | "no-parent"> {
    const structuredParent = rowIndex != null && structure ? structure.rows[rowIndex].parentIndex : null;
    const linkParentId = structuredParent != null ? plmIdByRow.get(structuredParent) ?? null : parentPlmId;

    if (!linkParentId) return "no-parent";
    // A part cannot contain itself; the guard in upsertBomLink refuses it,
    // but reaching it would mean the reconstruction produced a cycle.
    if (String(linkParentId) === String(childPartId)) return "cycle";

    const wasLinked = await BomLink.exists({
      enterpriseId: session.enterpriseId, parentId: linkParentId, childId: childPartId,
    });
    if (!wasLinked || opts.updateQuantities) {
      await upsertBomLink(
        session.enterpriseId, linkParentId, childPartId, quantity,
        { documentId: assembly.documentId, elementId: assembly.elementId }
        // No find number: the BOM parser does not read an item-number
        // column yet, and BomLink.findNumber stays empty until it does.
      );
    }

    /* What each parent was seen to contain, for the reconciliation below. */
    const seenFor = childrenSeen.get(String(linkParentId)) ?? new Set<string>();
    seenFor.add(String(childPartId));
    childrenSeen.set(String(linkParentId), seenFor);
    return "linked";
  }

  // Sequential on purpose. Onshape rate-limits per account, and a burst of
  // parallel metadata writes is the fastest way to get the whole import
  // throttled halfway through.
  for (const { line, index: rowIndex } of ordered) {
    const base: Omit<BomImportLine, "outcome" | "message" | "number" | "partId" | "warning"> = {
      key: line.key,
      name: line.name,
      partNumber: line.partNumber,
      quantity: line.quantity,
    };

    if (!chosenKeys.has(line.key)) {
      /*
       * Not selected for this import — worth something only if PLM already
       * has it. There is nothing to create and nothing to re-read from
       * Onshape, only the structure to bring current: the model still
       * contains it, whether or not it was ticked this time.
       */
      const src = line.source!;
      const already: any = await Part.findOne({
        enterpriseId: session.enterpriseId,
        documentId: src.documentId, elementId: src.elementId, partId: src.partId,
        configuration: normalize(src.configuration),
      }).select("_id number").lean();

      // Genuinely new AND not selected — left out, exactly as before.
      if (!already) continue;

      const childPartId = String(already._id);
      const outcome = await linkToParent(rowIndex, childPartId, line.quantity);
      if (outcome === "cycle") continue;
      if (rowIndex != null) plmIdByRow.set(rowIndex, childPartId);
      if (outcome === "linked") {
        existing++;
        lines.push({
          ...base,
          outcome: "existing",
          number: already.number ?? null,
          partId: childPartId,
          message: `Already in PLM as ${already.number}; linked into this assembly's structure.`,
          warning: null,
        });
      }
      continue;
    }

    const clashesWith = collisions.get(line.key);
    if (clashesWith) {
      skipped++;
      lines.push({
        ...base,
        outcome: "skipped",
        number: null,
        partId: null,
        message:
          `Not imported: this is a different configuration of the same part as ` +
          `"${clashesWith.name || clashesWith.partNumber || "another row"}", and this PLM is set to ` +
          `treat every configuration of a part as one PLM part. Importing both would ` +
          `overwrite that row's quantity. Import it on its own, or turn off "collapse ` +
          `configurations" in Settings to give each variant its own part number.`,
        warning: null,
      });
      continue;
    }

    try {
      const { coords: partCoords, writable, reason } = await resolveImportCoords(client, line);

      const sync = await syncPartFromOnshape(session.enterpriseId, partCoords, {
        trigger: "bom-import",
        client,
        create: true,
        createdBy: { userId: session.userId, email: session.email },
        writeBackBlocked: writable ? undefined : (reason ?? undefined),
        metadataFallback: metadataFromBomRow(line, partCoords, assembly),
        /*
         * A subassembly row is an assembly, and stating it matters: without a
         * kind, sync infers one from the element, and an assembly row has no
         * partId for the part-versus-assembly inference to work from.
         */
        kind: line.isAssembly ? "assembly" : "part",
        // Every part in one import lands in one product — resolved once above
        // rather than per line, so a product created mid-import cannot split
        // one assembly across two.
        productId: filedInto,
      });

      if (sync.action === "skipped-wrong-element") {
        skipped++;
        lines.push({
          ...base,
          outcome: "skipped",
          number: null,
          partId: null,
          message:
            "Not imported: this row does not resolve to a part or assembly Onshape will " +
            "let PLM track.",
          warning: null,
        });
        continue;
      }

      const wasCreated = sync.action === "created";

      // What actually happened outranks what the resolver predicted: a part
      // read straight from the BOM needs saying so, whatever the reason for
      // there being no write-back.
      const note = sync.readFailure
        ? `Tracked from the assembly's bill of materials. The part's own document could not be ` +
          `read by this account, so its details come from the BOM and the MO number was not ` +
          `written back to Onshape.`
        : writable
          ? null
          : reason;
      /*
       * Quantity belongs on the edge, not on the part.
       *
       * A part used four times in one assembly and twice in another has two
       * quantities, and neither is a property of the part — which is exactly
       * what an embedded field got wrong. The edge is also what answers
       * "where is this used", read from the other end.
       */
      if (sync.partId) {
        const outcome = await linkToParent(rowIndex, sync.partId, line.quantity);
        if (outcome === "cycle") {
          lines.push({
            ...base,
            outcome: "skipped" as const, number: sync.number, partId: sync.partId,
            message: "Not linked: the structure made this part its own parent.",
            warning: null,
          });
          continue;
        }
      }

      if (rowIndex != null && sync.partId) plmIdByRow.set(rowIndex, sync.partId);

      // Explain the block in the part's own terms. Onshape's rejection says
      // nothing about *why* PLM tried, and this is what someone reads on the
      // part page months later.
      if (note && sync.partId) {
        await Part.updateOne({ _id: sync.partId }, { $set: { writeBackBlocked: note } });
      }

      if (wasCreated) created++; else existing++;
      if (note) warned++;

      lines.push({
        ...base,
        outcome: wasCreated ? "created" : "existing",
        number: sync.number,
        partId: sync.partId || null,
        message: wasCreated
          ? `Created ${sync.number} with quantity ${line.quantity}.`
          : opts.updateQuantities
            ? `Already in PLM as ${sync.number}; quantity set to ${line.quantity}.`
            : `Already in PLM as ${sync.number}; quantity left as it was.`,
        warning: note,
      });
    } catch (err: any) {
      failed++;
      lines.push({
        ...base,
        outcome: "failed",
        number: null,
        partId: null,
        message: String(err?.message ?? err),
        warning: null,
      });
    }
  }

  await ActivityLog.create({
    enterpriseId: session.enterpriseId,
    partId: parentPlmId ?? null,
    direction: "onshape->plm",
    action: created > 0 ? "created" : "unchanged",
    trigger: "bom-import",
    ok: failed === 0 && !parentError,
    message:
      `${session.email} imported the BOM of "${assembly.elementName || assembly.elementId}" ` +
      `(${assembly.documentName}): ${created} created, ${existing} already in PLM, ` +
      `${failed} failed${warned ? `, ${warned} with no write-back to Onshape` : ""}` +
      `${skipped ? `, ${skipped} skipped as duplicate identities` : ""}.` +
      (parentError
        ? ` The assembly itself could not be brought into PLM (${parentError.slice(0, 200)}), ` +
          `so no structure was recorded — the parts were imported without it.`
        : ""),
  });

  /*
   * Remove edges the assembly no longer has.
   *
   * The other half of keeping a BOM current: an import that only ever adds
   * leaves a part in PLM's structure long after it was deleted from the CAD,
   * and the BOM then overstates what the product is built from — quietly, and
   * in the direction that gets parts ordered.
   *
   * The rule is the one already stated for quantities: an assembly's own bill
   * of materials is the only source of truth for what IT contains. So each
   * parent observed in this read has its edges reconciled against what was
   * observed under it, and no other parent is touched.
   *
   * Safe on a partial selection now, which it was not before: `childrenSeen`
   * used to record only freshly synced rows, so a normal "just the new ones"
   * import saw a handful of children and would have deleted every existing
   * edge to everything else in the assembly. Now every already-tracked child
   * is looked up and recorded whether or not it was selected — see the walk
   * above — so `childrenSeen` reflects the model's true current contents
   * regardless of the selection. A row that is neither selected nor already
   * tracked is simply new and untouched, and a part PLM has never heard of
   * has no edge to wrongly prune in the first place.
   */
  let removedLinks = 0;

  if (opts.reconcileStructure !== false && structure) {
    /* The assembly itself counts as a parent, even if nothing was left under it. */
    if (parentPlmId && !childrenSeen.has(String(parentPlmId))) {
      childrenSeen.set(String(parentPlmId), new Set());
    }

    for (const [parentId, seenChildren] of childrenSeen) {
      const stale: any[] = await BomLink.find({
        enterpriseId: session.enterpriseId,
        parentId,
        childId: { $nin: [...seenChildren] },
      })
        .select("_id")
        .lean();

      for (const link of stale) {
        await BomLink.deleteOne({ _id: link._id });
        removedLinks++;
      }
    }
  }

  /*
   * Parts under this assembly filed under something else.
   *
   * Read after the import rather than tracked during it, because it has to
   * include parts that were already there — the ones a previous import filed
   * into a different product are exactly the case worth surfacing.
   */
  const elsewhere: BomImportResult["elsewhere"] = [];
  if (filedInto) {
    const touched = [...plmIdByRow.values()];
    if (parentPlmId) touched.push(parentPlmId);
    const strays: any[] = await Part.find({
      enterpriseId: session.enterpriseId,
      _id: { $in: touched },
      productId: { $ne: filedInto },
    })
      .select("number productName")
      .lean();
    for (const x of strays) {
      elsewhere.push({
        partId: String(x._id),
        number: x.number ?? null,
        productName: x.productName || "no product",
      });
    }
  }

  const productName =
    existingTop?.productName ||
    (filedInto ? (await Product.findById(filedInto).select("name").lean() as any)?.name ?? "" : "");

  return {
    assembly,
    result: {
      created, existing, failed, warned, skipped, removedLinks, lines,
      product: { id: filedInto, name: productName || "Unassigned", source: productSource },
      elsewhere,
    },
  };
}

export type TrackedRow = {
  partId: string;
  number: string | null;
  revision: string;
  lifecycleState: string;
};

/** Mark which BOM rows PLM already holds, for the selection table. */
export async function annotateTracked(
  enterpriseId: string,
  lines: BomLine[]
): Promise<Map<string, TrackedRow>> {
  await connectDb();

  const tracked = new Map<string, TrackedRow>();
  const resolvable = lines.filter((l) => l.source);
  if (!resolvable.length) return tracked;

  // Identity must be keyed exactly as the sync engine keys it, or every row
  // reports as untracked and the import quietly re-enrols parts already held.
  const normalize = await configurationNormalizer(enterpriseId);
  const byIdentity = new Map<string, BomLine[]>();

  for (const l of resolvable) {
    const src = l.source!;
    const id = `${src.documentId}:${src.elementId}:${src.partId}:${normalize(src.configuration)}`;
    const bucket = byIdentity.get(id);
    if (bucket) bucket.push(l);
    else byIdentity.set(id, [l]);
  }

  const parts: any[] = await Part.find({
    enterpriseId,
    partId: { $in: resolvable.map((l) => l.source!.partId) },
  }).lean();

  for (const part of parts) {
    // Stored values predate canonical spelling, so both sides are normalised.
    const id = `${part.documentId}:${part.elementId}:${part.partId}:${normalize(part.configuration)}`;
    for (const l of byIdentity.get(id) ?? []) {
      tracked.set(l.key, {
        partId: String(part._id),
        number: part.number ?? null,
        revision: part.revision ?? "",
        lifecycleState: part.lifecycleState ?? "",
      });
    }
  }

  // A row whose part is in PLM, but under another configuration string, is
  // the near-miss behind "saved from the Part Studio but not recognised".
  // Logged with both spellings so the difference is visible, not guessed at.
  for (const l of resolvable) {
    if (tracked.has(l.key)) continue;
    const src = l.source!;
    const near = parts.filter((p) => p.documentId === src.documentId && p.elementId === src.elementId && p.partId === src.partId);
    if (near.length) {
      console.warn(
        `[PLM] BOM row ${l.partNumber || src.partId} not matched to a tracked part. ` +
        `BOM says configuration "${src.configuration}"; PLM holds ${near.map((p) => `"${p.configuration}"`).join(", ")}.`
      );
    }
  }

  return tracked;
}
