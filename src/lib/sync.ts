import { connectDb } from "@/lib/db";
import { resolveProductById, resolveUnassignedProduct } from "@/lib/products";
import { classify } from "@/lib/onshape/element-type";
import {
  ActivityLog, AttributeDefinition, Enterprise, Part, PartIteration, PartThumbnail, SelfWrite,
} from "@/lib/models";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { bindAttributeProperties } from "@/lib/onshape/properties";
import { listDefinitions, mapInbound, mapOutbound, type AttrDef } from "@/lib/attributes";
import { nextNumber } from "@/lib/numbering";
import { captureWorkspaceGeometry, deleteGeometryForPart, geometryCaptureEnabled } from "@/lib/geometry";
import type { OnshapeClient, PartCoords, PartMetadata } from "@/lib/onshape/types";

/* -------------------------------------------------------------------------- */
/* Configuration normalisation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a configuration string to the value used in the identity key.
 *
 * Onshape reports configuration inconsistently across entry points — a panel
 * launch, a webhook and a manual re-sync can each describe the same
 * unconfigured part differently. Since configuration is part of the uniqueness
 * key, those differences create duplicate parts with separate part numbers.
 *
 * With Enterprise.ignoreConfigurations on (the default), every variant
 * collapses to "default", so one CAD part is always one PLM part.
 */
export async function normalizeConfiguration(
  enterpriseId: string,
  raw: string | null | undefined
): Promise<string> {
  return (await configurationNormalizer(enterpriseId))(raw);
}

/**
 * The same rule, resolved once for callers that key many parts at a time.
 *
 * A BOM import normalises a hundred rows against one enterprise setting;
 * re-reading the enterprise per row is wasted work, and reimplementing the rule
 * locally to avoid that is how the identity keys drift apart again.
 */
/**
 * One spelling for a configuration string.
 *
 * Onshape hands the same configuration over as "Size=Large;Kind=A" from a
 * panel, "Kind=A;Size=Large" or a URL-encoded "Size=Large%3BKind=A" from the
 * BOM. Decoded and sorted so those compare equal; otherwise a part saved from
 * its Part Studio is not recognised when an assembly BOM names it.
 */
export function canonicalConfiguration(v: string): string {
  const dec = (t: string) => {
    const x = t.replace(/\+/g, " ");
    try { return decodeURIComponent(x); } catch { return x; }
  };
  return dec(v)
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? p : `${p.slice(0, i).trim()}=${p.slice(i + 1).trim()}`;
    })
    .sort()
    .join(";");
}

/**
 * The configuration to look a part up under when the caller only knows which
 * CAD part it is.
 *
 * Release packages and webhooks often do not say which configuration they mean,
 * and assuming "default" looks up an identity PLM does not hold for any part
 * saved under a real configuration — so a release created a second copy, and
 * a metadata edit was dropped. A stated configuration wins; otherwise, when
 * PLM holds exactly one part for this document, tab and part, that part's
 * configuration is used; otherwise "default".
 */
export async function resolveHeldConfiguration(
  enterpriseId: string,
  c: { documentId: string; elementId: string; partId?: string | null },
  stated?: string | null
): Promise<string> {
  const given = String(stated ?? "").trim();
  if (given && given !== "default" && !/^\{\$.*\}$/.test(given)) return given;

  const held: any[] = await Part.find({
    enterpriseId,
    documentId: c.documentId,
    elementId: c.elementId,
    partId: c.partId || "",
  }).select("configuration").limit(2).lean();

  return held.length === 1 ? String(held[0].configuration || "default") : (given || "default");
}

export async function configurationNormalizer(
  enterpriseId: string
): Promise<(raw?: string | null) => string> {
  const ent: any = await Enterprise.findById(enterpriseId).lean();
  const ignore = ent?.ignoreConfigurations !== false;

  return (raw?: string | null) => {
    const v = String(raw ?? "").trim();
    if (ignore) return "default";
    if (!v || /^\{\$.*\}$/.test(v)) return "default";
    return canonicalConfiguration(v) || "default";
  };
}

/* -------------------------------------------------------------------------- */
/* Numbering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Allocate the PLM number for a part or assembly.
 *
 * PLM is the number master, so this is issued here and pushed to Onshape —
 * the reverse of MOS, which refused to enrol a part that had no CAD part
 * number. A PLM system that waited for CAD to name things would have nothing
 * to govern.
 */
export async function allocatePartNumber(
  enterpriseId: string,
  kind: "part" | "assembly"
): Promise<string> {
  const { number } = await nextNumber(enterpriseId, kind === "assembly" ? "ASSEMBLY" : "PART");
  return number;
}

/* -------------------------------------------------------------------------- */
/* Echo suppression                                                            */
/* -------------------------------------------------------------------------- */

const selfWriteKey = (enterpriseId: string, c: PartCoords) =>
  `${enterpriseId}:${c.documentId}:${c.elementId}:${c.partId}:${c.configuration || "default"}`;

/** Called immediately before writing to Onshape. */
export async function markSelfWrite(enterpriseId: string, coords: PartCoords): Promise<void> {
  await SelfWrite.create({ key: selfWriteKey(enterpriseId, coords), createdAt: new Date() });
}

/**
 * True when this event is plausibly the echo of our own recent write.
 *
 * Advisory only — it annotates the audit log, it does NOT skip the sync.
 * Dropping the event outright would silently discard any genuine designer edit
 * that lands inside the TTL window, which is common right after a first sync
 * stamps the part number.
 *
 * The push/webhook loop terminates without needing a drop: every push is
 * conditional on the value actually differing, so the echo produces no second
 * push and the chain ends after one extra round trip.
 */
export async function consumeSelfWriteMarker(
  enterpriseId: string,
  coords: PartCoords
): Promise<boolean> {
  const hit = await SelfWrite.findOneAndDelete({
    key: selfWriteKey(enterpriseId, coords),
    createdAt: { $gt: new Date(Date.now() - 90_000) },
  });
  return Boolean(hit);
}

/* -------------------------------------------------------------------------- */
/* Reading versus writing                                                      */
/*                                                                            */
/* These are not the same place, and conflating them corrupts records.         */
/*                                                                            */
/* A released part belongs to the version the release produced: revision A,    */
/* state Released. The workspace holds whatever is being worked on now, which  */
/* may have no revision at all. So: read the workspace for current truth, and  */
/* write to the workspace because a version is immutable and cannot take the   */
/* part number.                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where this part's details should be read from.
 *
 * The workspace, whenever there is one. Pinning reads to the version a part was
 * released at looks right and is not: the pin goes stale the moment a newer
 * revision is released, and Onshape then correctly reports the pinned revision
 * as Obsolete. A part at revision C would walk backwards to B, Released to
 * Obsolete — worse than the problem pinning was meant to solve, because the
 * record moved and the movement looked authoritative.
 *
 * A version is used only when there is no workspace to read — a part in a
 * linked library document, reachable only at the version the assembly pins.
 */
export function readCoords(c: PartCoords): PartCoords {
  if (!c.workspaceId) return c;
  return { ...c, workspaceId: c.workspaceId, versionId: null };
}

/**
 * Fall back to the workspace PLM already knows this part lives in.
 *
 * Releasing revision D obsoletes revision C, and Onshape reports both — so a
 * release produces a burst of events, one of which names the revision just
 * superseded. Every revision of a part shares one identity here, so that last
 * event would overwrite the record that had correctly moved to D, walking it
 * back to C and Released back to Obsolete.
 *
 * An event carrying only a version is therefore read against the workspace on
 * record instead. The workspace is the part's current truth and cannot go
 * stale, and it is a value already held, so this costs nothing.
 */
export function preferKnownWorkspace(c: PartCoords, knownWorkspaceId: string | null): PartCoords {
  if (c.workspaceId) return c;
  if (!knownWorkspaceId) return c;
  return { ...c, workspaceId: knownWorkspaceId };
}

/** Where PLM-owned properties must be written. Only a workspace can take them. */
export function writeCoords(c: PartCoords): PartCoords {
  if (!c.workspaceId) return c;
  return { ...c, workspaceId: c.workspaceId, versionId: null };
}

/* -------------------------------------------------------------------------- */
/* Element type                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which PLM object kind an Onshape element type becomes.
 *
 * PLM accepts assemblies as first-class objects, which MOS did not: an
 * assembly is a released, revisioned thing with a structure beneath it, not
 * merely a container to explode. A drawing is deliberately absent — drawings
 * are their own object type and arrive through the release package, not
 * through part sync.
 */
export function kindForElementType(elementType: string): "part" | "assembly" | null {
  switch (String(elementType ?? "").toUpperCase()) {
    case "PARTSTUDIO": return "part";
    case "ASSEMBLY": return "assembly";
    case "DRAWING": return null;
  }

  /*
   * Anything else goes through the classifier before being refused.
   *
   * The elements endpoint reports a word, so the cases above normally settle
   * it. But the same enum arrives as a *number* elsewhere in this API — a
   * release package item sends `0` for a Part Studio — and now that the
   * drawing refusal above this function is unconditional, a numeric value
   * reaching here would refuse a perfectly good part. `classify` already knows
   * the code table, so the two places cannot disagree.
   */
  const c = classify({ elementType });
  /*
   * Only a confident classification is accepted here.
   *
   * classify's job elsewhere is to always produce an answer — the numbering
   * extension has to allocate *something*. This function's job is the
   * opposite: it decides whether to sync at all, so an unrecognised element
   * (a blob, a feature studio, a tab type added after this was written) must be
   * refused rather than guessed into a part. Without this, making the drawing
   * refusal unconditional would have let every unknown tab type through as one.
   */
  if (!c.confident) return null;
  if (c.type === "PART") return "part";
  if (c.type === "ASSEMBLY") return "assembly";
  return null;
}

/* -------------------------------------------------------------------------- */
/* Onshape -> PLM                                                              */
/* -------------------------------------------------------------------------- */

export type SyncResult = {
  action: "created" | "updated" | "unchanged" | "skipped-unknown" | "skipped-wrong-element";
  partId: string;
  number: string | null;
  numberPushed: boolean;
  /** Attribute key -> { from, to }, plus revision/state when those moved. */
  changes: Record<string, { from: unknown; to: unknown }>;
  /** The iteration this sync produced, when it produced one. */
  iteration: number | null;
  /** Values Onshape sent that the metamodel refused. */
  rejected: Record<string, string>;
  /** Why the part itself could not be read, when details came from elsewhere. */
  readFailure: string | null;
};

/**
 * Reconcile one Onshape part or assembly into PLM.
 *
 * Creates the object and allocates a PLM number on first sight; otherwise
 * updates only the mapped attributes that actually changed, respecting each
 * attribute's direction, authority and editability. A real change to a
 * pre-release object produces a new iteration with a snapshot, which is the
 * pre-release history Onshape does not keep in a readable form.
 *
 * Retries once on a Mongoose `VersionError` — "No matching document found
 * for id ... version N" — before giving up. That error means another sync
 * of the same part landed between this one's read and its `save()`; caught
 * live, from two webhook deliveries close enough together to overlap. A
 * retry re-reads the part fresh and recomputes every diff against whatever
 * the other sync just wrote, so it converges rather than racing again — and
 * the Onshape writes a retried attempt repeats (a property push-back) are
 * themselves idempotent, so repeating one changes nothing beyond a second,
 * harmless network call.
 */
export async function syncPartFromOnshape(
  enterpriseId: string,
  coords: PartCoords,
  opts: Parameters<typeof syncPartFromOnshapeOnce>[2] = {}
): Promise<SyncResult> {
  try {
    return await syncPartFromOnshapeOnce(enterpriseId, coords, opts);
  } catch (err: any) {
    if (err?.name !== "VersionError") throw err;
    console.warn(
      `[PLM] sync of ${coords.partId || coords.elementId} hit a concurrent write ` +
      `(${err.message}); retrying once against the current record.`
    );
    return await syncPartFromOnshapeOnce(enterpriseId, coords, opts);
  }
}

async function syncPartFromOnshapeOnce(
  enterpriseId: string,
  coords: PartCoords,
  opts: {
    trigger?: string;
    client?: OnshapeClient;
    /**
     * Whether an unseen part may be brought into PLM.
     *
     * Defaults to false so that merely editing a property in Onshape does not
     * allocate a PLM number. Creation is deliberate: someone presses Sync in
     * the panel, or a release package names the part.
     */
    create?: boolean;
    /** Lifecycle state for a newly created object. Ignored if it already exists. */
    initialState?: string;
    /**
     * The product a newly created part is filed into.
     *
     * Ignored for a part that already exists: a sync mirrors CAD, and moving
     * somebody's part between products because a webhook fired is not
     * mirroring. Left unset, a new part goes to "Unassigned" — an automatic
     * path has nobody to ask, and a part quietly belonging to whichever
     * product the integration account happened to have selected would be worse
     * than one visibly belonging to none.
     */
    productId?: string | null;
    /** Who is bringing the part in. Omitted for automatic paths. */
    createdBy?: { userId: string; email: string };
    /**
     * This sync is driven by a release, and its version is authoritative.
     *
     * Only a release knows which revision is current, and the revision exists
     * only on the version — the workspace does not carry one. So a release
     * reads its own version and is the one thing allowed to move revision and
     * lifecycle state; everything else reads the workspace and leaves them be.
     */
    fromRelease?: boolean;
    /** The revision Onshape assigned, when this sync follows a completed release. */
    releaseRevision?: string;
    releaseId?: string;
    /**
     * Reason this part can never be written back to.
     *
     * Set only when the caller already knows the write is impossible — a part
     * from standard content, or from a document the account cannot write to.
     * Onshape rejects those every time, so attempting one spends a call from a
     * shared rate limit to learn something already known. The object is
     * recorded as blocked rather than pending, because nobody should chase it.
     */
    writeBackBlocked?: string;
    /**
     * Part details to use when the part itself cannot be read.
     *
     * An assembly can reference parts from documents the account has no access
     * to. Onshape still reports those parts fully in the assembly's bill of
     * materials, so refusing to track them because a second, redundant call is
     * forbidden would throw away data already in hand.
     *
     * Only consulted if the metadata read actually fails.
     */
    metadataFallback?: PartMetadata;
    /** Force the object kind, when the caller already knows it. */
    kind?: "part" | "assembly";
  } = {}
): Promise<SyncResult> {
  await connectDb();

  const trigger = opts.trigger || "manual";
  const mayCreate = opts.create === true;
  const client = opts.client ?? (await clientForEnterprise(enterpriseId)).client;

  const configuration = await normalizeConfiguration(enterpriseId, coords.configuration);
  const identity = {
    enterpriseId,
    documentId: coords.documentId,
    elementId: coords.elementId,
    partId: coords.partId || "",
    configuration,
  };

  // Fetched rather than merely counted: what PLM already knows about this part
  // decides where to read it from, and that has to be settled before the read.
  const existing: any = await Part.findOne(identity);

  const nothing = (action: SyncResult["action"]): SyncResult => ({
    action, partId: "", number: null, numberPushed: false,
    changes: {}, iteration: null, rejected: {}, readFailure: null,
  });

  if (!mayCreate && !existing) {
    await ActivityLog.create({
      enterpriseId, direction: "onshape->plm", action: "skipped", trigger, ok: true,
      message:
        `Part ${coords.partId || coords.elementId} is not in PLM, and "${trigger}" does not ` +
        `create objects. Use Sync to PLM in the Onshape panel, or raise a release candidate.`,
    });
    return nothing("skipped-unknown");
  }

  /*
   * Prefer the workspace this part is already known to live in — see
   * preferKnownWorkspace. A release burst includes an event naming the
   * revision just superseded, and reading that against the workspace on record
   * is what stops the record walking backwards.
   */
  const known = preferKnownWorkspace(coords, existing?.workspaceId ?? null);

  // A release is read at its own version, because that is the only place the
  // revision exists. Writes still go to the workspace further down.
  const coordsForRead: PartCoords =
    opts.fromRelease && coords.versionId
      ? { ...known, workspaceId: null, versionId: coords.versionId }
      : known;

  /*
   * Establish what kind of object this is before mirroring anything onto it.
   *
   * MOS refused everything that was not a Part Studio. PLM accepts assemblies
   * too, but still has to refuse a drawing and — importantly — an assembly
   * element carrying a partId, which describes an *instance* of a part defined
   * elsewhere. Syncing that would create a second PLM object for a part
   * already tracked against its own Part Studio.
   */
  let kind: "part" | "assembly" = opts.kind ?? existing?.kind ?? "part";

  /*
   * The element check runs even when the caller states the kind.
   *
   * It used to be skipped entirely whenever `opts.kind` was given — and the
   * release takeover always gives it, computed from the package item's
   * elementType. When that elementType turned out to be a *number*, every item
   * was labelled "part", including drawings, and passing that label switched
   * off the very guard that would have caught it. A drawing therefore had a PLM
   * part created for it and appeared in the parts list.
   *
   * A caller may reasonably assert part versus assembly — it sometimes knows
   * better than a lookup, and for an assembly with no partId there is little to
   * infer from. Nothing, though, should be able to assert that a drawing is a
   * part. So the refusal is unconditional and the inference is what defers.
   */
  if (client.getElementInfo) {
    const el = await client.getElementInfo(readCoords(coordsForRead));
    if (el?.elementType) {
      const resolved = kindForElementType(el.elementType);

      /*
       * Refusing to sync and inferring a kind are two different questions.
       *
       * A *confident* non-syncable answer — a drawing — is refused however the
       * call arrived, including when the caller asserted a kind: that is the
       * hole the release takeover fell through. Mere ignorance is different. An
       * unrecognised tab type is refused when PLM was relying on the lookup to
       * decide, because guessing it into a part is how a drawing became one;
       * but it does not override a caller that already knows what it has, which
       * is the case for an assembly the elements endpoint describes only by a
       * code this code table is not yet sure of.
       */
      const confidentlyNotSyncable = !resolved && classify({ elementType: el.elementType }).confident;
      if (!resolved && (confidentlyNotSyncable || !opts.kind)) {
        await ActivityLog.create({
          enterpriseId, direction: "onshape->plm", action: "skipped", trigger, ok: true,
          message:
            `Refusing to sync "${el.name}": Onshape reports it as ${el.elementType}. Parts ` +
            `and assemblies are synced here; drawings arrive with a release package.` +
            (opts.kind
              ? ` The caller asked for a ${opts.kind}, and this refusal overrides that ` +
                `deliberately — Onshape is the authority on what the element is.`
              : ""),
        });
        return nothing("skipped-wrong-element");
      }
      if (resolved === "assembly" && coords.partId) {
        throw new Error(
          `Refusing to sync: "${el.name}" is an Assembly and a part was named inside it. ` +
          `That is an instance of a part defined in a Part Studio — sync it there instead, ` +
          `or import the assembly's structure.`
        );
      }
      // The caller's assertion wins for part-versus-assembly only. `resolved`
      // can still be null here — an unrecognised type the caller vouched for —
      // in which case its own assertion stands.
      if (!opts.kind && resolved) kind = resolved;
    }
  }

  let meta: PartMetadata;
  let readFailure: string | null = null;
  try {
    meta = await client.getPartMetadata(readCoords(coordsForRead));
  } catch (err: any) {
    if (!opts.metadataFallback) throw err;
    meta = opts.metadataFallback;
    readFailure = String(err?.message ?? err);
  }

  // Data that came from somewhere other than the part cannot be written back to
  // the part either, whatever the caller asked for.
  const blocked: string | null =
    opts.writeBackBlocked ??
    (readFailure
      ? "The part itself could not be read from Onshape, so there is nothing to write to."
      : null);

  /*
   * Keep the attribute mapping current from the part's own metadata.
   *
   * Every metadata response names its properties, so a real part is the most
   * reliable source of this tenant's property ids. Doing it here means the
   * mapping repairs itself the first time any part is seen, instead of
   * depending on a discovery run having succeeded earlier.
   */
  if (meta.definitions?.length) {
    await bindAttributeProperties(enterpriseId, meta.definitions);
  }

  const defs = await listDefinitions(enterpriseId, "PART");

  let part: any = existing;
  const isNew = !part;
  let isNewResolved = isNew;
  const changes: SyncResult["changes"] = {};
  let numberPushed = false;
  /** Whether this part's number came from Onshape's own existing value rather than PLM's counter. */
  let numberAdopted = false;

  if (isNew) {
    /*
     * A part that already carries a Part Number in Onshape keeps it.
     *
     * PLM is the number master going forward, but "going forward" is the
     * operative word: a legacy part, or one somebody numbered by hand before
     * it was ever synced, is not PLM's to renumber the instant it first sees
     * it. Overwriting a real, pre-existing number on first contact is
     * indistinguishable — from the CAD side — from PLM getting it wrong, and
     * it does exactly that unconditionally today. From here on, once PLM has
     * adopted or minted a number for a part, this part is PLM's to number and
     * the usual push-what-differs logic below applies as it always has —
     * this only changes the very first sync.
     */
    const existingNumber = meta.partNumber.trim();
    numberAdopted = Boolean(existingNumber);
    const number = existingNumber || await allocatePartNumber(enterpriseId, kind);
    const state = opts.initialState || "In Work";

    // Seed defaults, then fold in what Onshape says. Defaults first so an
    // attribute Onshape has an opinion about is not overwritten by ours.
    const seeded: Record<string, unknown> = {};
    for (const d of defs) if (d.defaultValue != null) seeded[d.key] = d.defaultValue;
    seeded.number = number;

    const inbound = mapInbound(defs, meta.properties ?? [], seeded, state, { name: meta.partName });

    /*
     * Every part belongs to a product, so this is resolved before the part
     * exists rather than patched on afterwards — a part that is briefly in no
     * product is a part that a concurrent page load can render with a blank
     * grouping, and a count that is briefly wrong.
     */
    const filedInto = opts.productId
      ? (await resolveProductById(enterpriseId, opts.productId)) ??
        (await resolveUnassignedProduct(enterpriseId))
      : await resolveUnassignedProduct(enterpriseId);

    part = new Part({
      ...identity,
      kind,
      number,
      name: meta.partName || meta.elementName || "",
      lifecycleState: state,
      revision: opts.fromRelease ? (opts.releaseRevision ?? meta.revision ?? "") : "",
      iteration: 1,
      attributes: inbound.values,
      onshapeProperties: meta.properties,
      onshapeState: meta.state ?? "",
      // Both are kept, and they mean different things: workspaceId is where the
      // part number gets written, versionId is the release this record is for.
      workspaceId: known.workspaceId ?? meta.coords.workspaceId ?? null,
      versionId: coords.versionId ?? null,
      documentName: meta.documentName,
      elementName: meta.elementName,
      firstSyncedAt: new Date(),
      lastSyncedFromOnshapeAt: new Date(),
      createdByUserId: opts.createdBy?.userId ?? null,
      createdByEmail: opts.createdBy?.email ?? null,
      releaseId: opts.releaseId ?? null,
      productId: filedInto.productId,
      productName: filedInto.productName,
    });

    for (const [k, [from, to]] of Object.entries(inbound.changed)) changes[k] = { from, to };
    changes.number = { from: null, to: number };

    try {
      await part.save();
    } catch (err: any) {
      // Two webhooks racing on the same unseen part both miss the findOne and
      // both try to insert. The unique index rejects the loser, which then
      // adopts the winner's record rather than creating a second PLM number.
      if (err?.code === 11000) {
        const winner: any = await Part.findOne(identity);
        if (!winner) throw err;
        part = winner;
        isNewResolved = false;
      } else {
        throw err;
      }
    }

    if (isNewResolved) {
      await snapshotIteration(part, "sync", Object.keys(inbound.changed), opts);

      /*
       * A first look at the part, captured before there is anything to
       * release. Skipped when this sync itself came from a release: that path
       * captures the released version separately, at the version Onshape just
       * produced, which is the geometry that actually matters once it exists.
       * Capturing the workspace here too would spend a second Onshape call to
       * store a row this same request is about to make stale.
       *
       * Also skipped for a part `blocked` already marks as read-only —
       * standard content and library parts (screws, washers, bearings, the
       * same population the write-back and the thumbnail already refuse).
       * Onshape's gltf export 403s for these exactly the way a property
       * write does, and unlike a part that just has not synced yet, that
       * answer never changes — attempting it would only spend a call to
       * store the same refusal as a "failed" row forever.
       */
      if (!opts.fromRelease && !blocked && (await geometryCaptureEnabled(enterpriseId))) {
        await captureWorkspaceGeometry(client, enterpriseId, String(part._id), readCoords(coordsForRead), {
          isAssembly: kind === "assembly",
        });
      }
    }
  }

  if (!isNewResolved) {
    const state = String(part.lifecycleState ?? "In Work");
    const current = plainAttributes(part.attributes);
    const inbound = mapInbound(defs, meta.properties ?? [], current, state, { name: meta.partName });

    for (const [k, [from, to]] of Object.entries(inbound.changed)) changes[k] = { from, to };
    if (Object.keys(inbound.changed).length) {
      part.attributes = inbound.values;
      part.markModified("attributes");
    }

    /*
     * Revision and lifecycle state belong to the release, and only a release
     * moves them.
     *
     * The workspace carries no revision at all, so mirroring it would wipe
     * revision "C" to "". Guarding on "the incoming reading has no revision"
     * would instead freeze both fields permanently, because that is true of
     * every workspace read.
     *
     * The real rule is about provenance, not content: a reading taken from the
     * workspace is not evidence about which revision is current, so it gets no
     * say. A part that has never been released has no release to protect.
     */
    const heldRelease = String(part.revision ?? "") !== "";
    const mayMoveRelease = opts.fromRelease === true || !heldRelease;

    if (mayMoveRelease) {
      const incomingRev = opts.releaseRevision ?? meta.revision ?? "";
      if (String(part.revision ?? "") !== String(incomingRev)) {
        changes.revision = { from: part.revision, to: incomingRev };
        part.revision = incomingRev;
        // A genuine new revision — see PartSchema.starCount.
        part.starCount = 0;
      }
    }

    // Onshape's own state is mirrored for comparison but never drives PLM's
    // lifecycle: the two systems' state machines are not the same shape, and
    // PLM's is the one its governance rules are written against.
    if (String(part.onshapeState ?? "") !== String(meta.state ?? "")) {
      changes.onshapeState = { from: part.onshapeState, to: meta.state };
      part.onshapeState = meta.state ?? "";
    }

    // Context refresh — not treated as a meaningful change.
    part.workspaceId = known.workspaceId ?? part.workspaceId;
    part.versionId = coords.versionId ?? part.versionId;
    if (meta.documentName) part.documentName = meta.documentName;
    if (meta.elementName) part.elementName = meta.elementName;
    if (meta.partName) part.name = meta.partName;
    part.onshapeProperties = meta.properties;
    part.lastSyncedFromOnshapeAt = new Date();

    // Backfill for records that predate numbering, or whose allocation failed.
    // Same rule as a first sync: Onshape's own existing value wins over a
    // freshly minted one, for the same reason — see the isNew branch above.
    if (!part.number) {
      const existingNumber = meta.partNumber.trim();
      numberAdopted = Boolean(existingNumber);
      part.number = existingNumber || await allocatePartNumber(enterpriseId, part.kind ?? kind);
      changes.number = { from: null, to: part.number };
    } else {
      /*
       * A number present in Onshape wins over the one PLM has stored.
       *
       * The number originated in PLM — Onshape's number generator extension
       * asked for it — so whatever sits in Onshape's Part number property is
       * the number PLM issued for this part, even when it is a newer one than
       * the record holds (the part was renumbered in Onshape by asking PLM
       * again). Pushing the stored number back over it would silently undo
       * that. Only an empty Onshape value falls through to the push below.
       */
      const onshapeNumber = meta.partNumber.trim();
      if (onshapeNumber && onshapeNumber !== part.number) {
        changes.number = { from: part.number, to: onshapeNumber };
        part.number = onshapeNumber;
        numberAdopted = true;
      }
    }

    await part.save();

    /*
     * A real change earns an iteration.
     *
     * Only attribute and revision movement counts — a context refresh or an
     * unchanged re-sync does not, or a nightly re-sync of a thousand parts
     * would bury the genuine history under a thousand identical snapshots.
     */
    const substantive = Object.keys(inbound.changed).length > 0 || changes.revision != null;
    if (substantive) {
      part.iteration = (part.iteration ?? 1) + 1;
      await part.save();
      await snapshotIteration(
        part,
        opts.fromRelease ? "release" : "sync",
        Object.keys(inbound.changed),
        opts
      );
    }

    /*
     * A geometry-affecting change invalidates the cached rendering.
     *
     * Dropped rather than re-fetched: rendering is slow and rate-limited, and
     * nobody may look at this part again for weeks. The next viewer pays for a
     * fresh image; everyone else pays nothing.
     */
    if (substantive) {
      await PartThumbnail.deleteOne({ partId: part._id }).catch(() => {});
    }
  }

  /* ------------------------- Push PLM-owned values out -------------------- */

  const outbound = mapOutbound(defs, {
    ...plainAttributes(part.attributes),
    number: part.number,
  });

  if (blocked) {
    // Not an error and not outstanding work: a settled, expected state.
    part.writeBackBlocked = blocked;
    part.pushPending = false;
    part.lastPushError = null;
    await part.save();
  } else if (Object.keys(outbound).length === 0) {
    part.pushPending = true;
    part.lastPushError =
      "No PLM attribute is mapped to an Onshape property yet. Run discovery in Settings, " +
      "or set the Onshape property on each attribute in the attribute schema.";
    await part.save();
  } else {
    // Only write what Onshape does not already agree with. Without this, every
    // sync writes, every write echoes back as a metadata event, and the loop
    // never settles.
    const differs = Object.entries(outbound).filter(
      ([pid, v]) => String(meta.raw?.[pid] ?? "") !== String(v ?? "")
    );

    if (differs.length) {
      try {
        const to = writeCoords(known);
        await markSelfWrite(enterpriseId, to);
        await client.updatePartProperties(to, Object.fromEntries(differs));
        part.lastPushedToOnshapeAt = new Date();
        part.pushPending = false;
        part.lastPushError = null;
        // Access may have been granted since; a write that lands proves it.
        part.writeBackBlocked = null;
        await part.save();
        numberPushed = differs.some(([pid]) => pid === numberPropertyId(defs));
      } catch (err: any) {
        part.pushPending = true;
        part.lastPushError = String(err?.message ?? err);
        await part.save();
      }
    }
  }

  const action: SyncResult["action"] = isNewResolved
    ? "created"
    : Object.keys(changes).length > 0
      ? "updated"
      : "unchanged";

  await ActivityLog.create({
    enterpriseId,
    partId: part._id,
    releaseId: opts.releaseId ?? null,
    direction: "onshape->plm",
    action,
    trigger,
    ok: !part.pushPending,
    message:
      (isNewResolved
        ? `Created ${part.number} from Onshape ${kind} "${part.name || coords.partId}"` +
          (numberAdopted ? " — kept the number already set in Onshape" : "")
        : action === "updated"
          ? `Updated ${Object.keys(changes).length} field(s) at iteration ${part.iteration}`
          : "No changes") +
      (readFailure
        ? `. Details came from the assembly's bill of materials because the part itself ` +
          `could not be read (${readFailure.slice(0, 200)})`
        : ""),
    changes: Object.keys(changes).length ? changes : null,
  });

  return {
    action,
    partId: String(part._id),
    number: part.number,
    numberPushed,
    changes,
    iteration: part.iteration ?? null,
    rejected: {},
    readFailure,
  };
}

/** The Onshape property the PLM number is written to, if one is mapped. */
function numberPropertyId(defs: AttrDef[]): string {
  return defs.find((d) => d.key === "number")?.onshapePropertyId ?? "";
}

/** Mongoose hands Mixed back in several shapes; normalise to a plain object. */
export function plainAttributes(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (v instanceof Map) return Object.fromEntries(v);
  return { ...(v as Record<string, unknown>) };
}

/**
 * Record the object's current state as an iteration.
 *
 * Written after the save rather than before, so the snapshot is of what was
 * actually stored. A failure to snapshot is logged and swallowed: losing a line
 * of history is bad, but failing the sync that produced the data is worse.
 */
async function snapshotIteration(
  part: any,
  cause: string,
  changedKeys: string[],
  opts: { createdBy?: { email: string }; releaseId?: string }
): Promise<void> {
  try {
    await PartIteration.create({
      enterpriseId: part.enterpriseId,
      partId: part._id,
      iteration: part.iteration ?? 1,
      revision: part.revision ?? "",
      lifecycleState: part.lifecycleState,
      attributes: plainAttributes(part.attributes),
      onshapeVersionId: part.versionId ?? null,
      cause,
      changedKeys,
      createdByEmail: opts.createdBy?.email ?? null,
      releaseId: opts.releaseId ?? null,
    });
  } catch (err: any) {
    // A duplicate iteration number means a concurrent sync already recorded
    // this one. Nothing is lost, and nothing needs doing.
    if (err?.code !== 11000) {
      console.warn(`[PLM] could not snapshot iteration for part ${part._id}: ${err?.message ?? err}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* PLM -> Onshape                                                              */
/* -------------------------------------------------------------------------- */

export type PushResult = { ok: boolean; written: Record<string, unknown>; error?: string };

/**
 * Write PLM-owned attribute values into Onshape.
 *
 * Which values those are is not decided here — it is whatever the metamodel
 * says is directed outbound. That is the point of the mapping table: adding a
 * PLM field that Onshape should carry is a configuration change, not a code
 * change.
 */
export async function pushPartToOnshape(
  partId: string,
  opts: { trigger?: string; client?: OnshapeClient } = {}
): Promise<PushResult> {
  await connectDb();

  const part: any = await Part.findById(partId);
  if (!part) return { ok: false, written: {}, error: "Part not found" };

  const trigger = opts.trigger || "manual";

  if (part.writeBackBlocked) {
    return { ok: false, written: {}, error: part.writeBackBlocked };
  }

  const defs = await listDefinitions(String(part.enterpriseId), "PART");
  const written = mapOutbound(defs, {
    ...plainAttributes(part.attributes),
    number: part.number,
  });

  if (Object.keys(written).length === 0) {
    const error =
      "No PLM attribute is directed to Onshape. Map one in the attribute schema first.";
    part.pushPending = true;
    part.lastPushError = error;
    await part.save();
    return { ok: false, written: {}, error };
  }

  const client = opts.client ?? (await clientForEnterprise(String(part.enterpriseId))).client;

  const to = writeCoords({
    documentId: part.documentId,
    elementId: part.elementId,
    partId: part.partId,
    configuration: part.configuration,
    workspaceId: part.workspaceId,
    versionId: part.versionId,
  });

  try {
    await markSelfWrite(String(part.enterpriseId), to);
    await client.updatePartProperties(to, written);

    part.lastPushedToOnshapeAt = new Date();
    part.pushPending = false;
    part.lastPushError = null;
    part.writeBackBlocked = null;
    await part.save();

    await ActivityLog.create({
      enterpriseId: part.enterpriseId,
      partId: part._id,
      direction: "plm->onshape",
      action: "pushed",
      trigger,
      ok: true,
      message: `Wrote ${Object.keys(written).length} property/properties to Onshape`,
      changes: written,
    });

    return { ok: true, written };
  } catch (err: any) {
    const error = String(err?.message ?? err);
    part.pushPending = true;
    part.lastPushError = error;
    await part.save();

    await ActivityLog.create({
      enterpriseId: part.enterpriseId,
      partId: part._id,
      direction: "plm->onshape",
      action: "error",
      trigger,
      ok: false,
      message: error.slice(0, 500),
    });

    return { ok: false, written, error };
  }
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                     */
/* -------------------------------------------------------------------------- */

export type DeleteResult = {
  ok: boolean;
  /** Whether the PLM values were cleared off the Onshape part first. */
  cleared: boolean;
  clearError: string | null;
};

/**
 * Remove a part from PLM, clearing what PLM wrote onto the CAD part.
 *
 * Leaving a stale PLM number on a part nobody is tracking any more is worse
 * than a failed clear: it makes the CAD data assert a governance relationship
 * that no longer exists. So the clear is attempted first — but its failure does
 * not block the delete, because a part in a document we can no longer write to
 * would otherwise be impossible to remove.
 *
 * A released part is refused outright. That is not a cleanup decision; it is a
 * records decision, and PLM's whole purpose is that released history does not
 * simply disappear.
 */
export async function deletePart(
  partId: string,
  opts: { trigger?: string; client?: OnshapeClient; force?: boolean } = {}
): Promise<DeleteResult> {
  await connectDb();

  const part: any = await Part.findById(partId);
  if (!part) return { ok: false, cleared: false, clearError: "Part not found" };

  if (part.revision && !opts.force) {
    return {
      ok: false,
      cleared: false,
      clearError:
        `${part.number} is at revision ${part.revision} and has been released. ` +
        `Released records are not deleted — obsolete it instead.`,
    };
  }

  let cleared = false;
  let clearError: string | null = null;

  if (!part.writeBackBlocked) {
    const defs = await listDefinitions(String(part.enterpriseId), "PART");
    // Same mapping, emptied: clear exactly what PLM is responsible for having
    // written, and nothing else.
    const blanks = Object.fromEntries(
      Object.keys(mapOutbound(defs, { ...plainAttributes(part.attributes), number: part.number }))
        .map((pid) => [pid, ""])
    );

    if (Object.keys(blanks).length) {
      try {
        const client = opts.client ?? (await clientForEnterprise(String(part.enterpriseId))).client;
        const to = writeCoords({
          documentId: part.documentId,
          elementId: part.elementId,
          partId: part.partId,
          configuration: part.configuration,
          workspaceId: part.workspaceId,
          versionId: part.versionId,
        });
        await markSelfWrite(String(part.enterpriseId), to);
        await client.updatePartProperties(to, blanks);
        cleared = true;
      } catch (err: any) {
        clearError = String(err?.message ?? err);
      }
    }
  }

  await PartThumbnail.deleteOne({ partId: part._id }).catch(() => {});
  await PartIteration.deleteMany({ partId: part._id }).catch(() => {});
  await deleteGeometryForPart(part._id).catch(() => {});
  await Part.deleteOne({ _id: part._id });

  await ActivityLog.create({
    enterpriseId: part.enterpriseId,
    direction: "plm->onshape",
    action: "deleted",
    trigger: opts.trigger || "manual",
    ok: true,
    message:
      `Removed ${part.number || part.partId} from PLM` +
      (cleared
        ? " and cleared its values in Onshape"
        : clearError
          ? `; its Onshape values could not be cleared (${clearError.slice(0, 200)})`
          : ""),
  });

  return { ok: true, cleared, clearError };
}
