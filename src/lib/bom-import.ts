import { connectDb } from "@/lib/db";
import { ActivityLog, BomLink, Part } from "@/lib/models";
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

  return {
    documentId: coords.documentId,
    elementId: coords.elementId,
    documentName: doc.name,
    elementName: el?.name ?? "",
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
 * library part is not a reason to refuse to *manufacture* it. The item is
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
 * Whether the BOM's part-number column looks unmapped rather than genuinely empty.
 *
 * Parts need a part number before they can be ordered, so rows without one are
 * held back. But that check leans on PLM having found the part-number
 * column in the first place, and column names differ between tenants. If not a
 * single row carries a number, an unmapped column is far likelier than an
 * assembly of entirely unnumbered parts — and blocking the whole import on a
 * parsing miss would be a bad way to find out.
 *
 * So in that case nothing is pre-filtered, and the decision falls to the
 * server-side check, which reads the real part rather than the table.
 */
export function partNumberColumnMissing(table: BomTable): boolean {
  const rows = table.lines.filter((l) => l.source && !l.isAssembly);
  return rows.length > 0 && rows.every((l) => !String(l.partNumber ?? "").trim());
}

/** Whether a row can be ordered, and why not when it cannot. */
export function assessLine(
  line: BomLine,
  columnMissing: boolean
): { importable: boolean; reason: string | null } {
  if (!line.source || line.isAssembly) {
    return { importable: false, reason: line.unresolvable };
  }
  if (!columnMissing && !String(line.partNumber ?? "").trim()) {
    return {
      importable: false,
      reason:
        "No part number. A manufacturing order cannot be raised without one — " +
        "give the part a number in Onshape and import the assembly again.",
    };
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
  const columnMissing = partNumberColumnMissing(table);
  return table.lines.filter((l) => assessLine(l, columnMissing).importable);
}

/**
 * Enrol selected BOM rows as manufacturing items.
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
  } = {}
): Promise<{ assembly: AssemblyInfo; result: BomImportResult }> {
  await connectDb();

  const client = await clientForUser(session.userId);
  const [assembly, table] = await Promise.all([
    describeAssembly(client, coords),
    client.getAssemblyBom(coords, { multiLevel: opts.multiLevel !== false }),
  ]);

  const wanted = new Set(selectedKeys);
  const chosen = importableLines(table).filter((l) => wanted.has(l.key)).slice(0, MAX_IMPORT);

  /*
   * Guard against two BOM rows collapsing onto one manufacturing item.
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
   * This is the substantive difference from a manufacturing-order import, which
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
        configuration: "default",
        workspaceId: assembly.workspaceId,
        versionId: assembly.versionId,
      },
      {
        trigger: "bom-import",
        client,
        create: true,
        kind: "assembly",
        createdBy: { userId: session.userId, email: session.email },
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

  // Sequential on purpose. Onshape rate-limits per account, and a burst of
  // parallel metadata writes is the fastest way to get the whole import
  // throttled halfway through.
  for (const line of chosen) {
    const base: Omit<BomImportLine, "outcome" | "message" | "number" | "partId" | "warning"> = {
      key: line.key,
      name: line.name,
      partNumber: line.partNumber,
      quantity: line.quantity,
    };

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
      if (parentPlmId && sync.partId) {
        const wasLinked = await BomLink.exists({
          enterpriseId: session.enterpriseId,
          parentId: parentPlmId,
          childId: sync.partId,
        });
        if (!wasLinked || opts.updateQuantities) {
          await upsertBomLink(
            session.enterpriseId,
            parentPlmId,
            sync.partId,
            line.quantity,
            { documentId: assembly.documentId, elementId: assembly.elementId }
            // No find number: the BOM parser does not read an item-number
            // column yet, and BomLink.findNumber stays empty until it does.
          );
        }
      }

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

  return { assembly, result: { created, existing, failed, warned, skipped, lines } };
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
    const id = `${part.documentId}:${part.elementId}:${part.partId}:${part.configuration}`;
    for (const l of byIdentity.get(id) ?? []) {
      tracked.set(l.key, {
        partId: String(part._id),
        number: part.number ?? null,
        revision: part.revision ?? "",
        lifecycleState: part.lifecycleState ?? "",
      });
    }
  }

  return tracked;
}
