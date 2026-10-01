import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { BomLink, Part, Product } from "@/lib/models";
import { plainAttributes } from "@/lib/sync";
import { listDefinitions, missingForRelease } from "@/lib/attributes";
import { taskCountsForParts } from "@/lib/tasks";
import { starReasonsForParts } from "@/lib/star-release";
import { listVariantsFor, type VariantDoc } from "@/lib/variants";

/**
 * A product's bill of materials, structured and flattened.
 *
 * Built from the BomLink edge collection rather than from Onshape on demand:
 * the structure PLM holds is what was imported and reviewed, it carries PLM's
 * own numbers and states, and a BOM that needs an Onshape round trip per level
 * is a BOM nobody opens twice.
 *
 * Two shapes come out of one walk:
 *
 *   structured  the tree, as Onshape shows it — each node with its own
 *               quantity and the total implied by its parents
 *   flattened   one row per distinct part, with the quantities summed across
 *               every place it appears
 *
 * Both are produced together because the flattened view is the structured walk
 * with the rows collapsed, and doing it twice invites the two to disagree about
 * quantities — which is the one thing a BOM must not do.
 */

export type BomNode = {
  /** Stable id for this position in the tree, not for the part. */
  key: string;
  partId: string;
  number: string | null;
  name: string;
  description: string;
  material: string;
  kind: "part" | "assembly";
  lifecycleState: string;
  revision: string;
  starCount: number;
  plmOnly: boolean;
  iteration: number;
  productName: string;
  findNumber: string;
  /** Quantity of this part within its immediate parent. */
  quantity: number;
  /** Quantity in the product overall: this quantity times every parent's. */
  totalQuantity: number;
  level: number;
  massKg: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** The id of the edge that put this node under its parent. Null for a root. */
  linkId: string | null;
  /** Effectivity of this component *in this parent*, distinct from the part's. */
  linkEffectiveFrom: string | null;
  linkEffectiveTo: string | null;
  /**
   * Which variants of the parent assembly this position belongs to. Empty
   * means every variant — see BomLink.variantIds and Variant's own comment.
   */
  linkVariantIds: string[];
  children: BomNode[];
  /**
   * Release-required attributes this part still lacks, by label.
   *
   * Carried on the BOM row because that is where the gaps become visible as a
   * body of work: a product's worth of parts each missing two or three fields
   * is the situation, and finding them one part page at a time is most of the
   * effort.
   */
  missingForRelease: string[];
  /** Set when this part appears elsewhere in the same BOM too. */
  alsoUsedElsewhere: boolean;
  /** Set when the walk stopped here because the part contains itself. */
  cycle: boolean;
  /**
   * Onshape tasks open against this part.
   *
   * On the BOM because this is where it changes a decision: a component with a
   * change request against it is not settled, and a BOM is exactly what gets
   * signed off without anybody checking each part's own page.
   */
  openTaskCount: number;
  taskCount: number;
  /** This part's star releases, newest first, for hovering its "*" — see RevChip. */
  starReasons: string[];
  /**
   * Set when this node is shown as a root only because nothing reachable
   * contained it — see `unreachable` on the result.
   */
  unreachable: boolean;
};

export type BomRow = Omit<BomNode, "children" | "key" | "level" | "quantity"> & {
  /** How many of this part the product needs in total. */
  totalQuantity: number;
  /** How many separate places in the structure it appears. */
  usedIn: number;
  /** The shallowest level it appears at. */
  level: number;
};

export type BomResult = {
  product: { id: string; name: string } | null;
  /** The date the BOM was resolved at, or null when unfiltered. */
  asOf: string | null;
  roots: BomNode[];
  /**
   * Every top-level assembly in the product, whatever `rootId` narrowed the
   * result to — the choices for the "show one assembly" filter. Each
   * configuration of an Onshape assembly is its own PLM assembly, so this is
   * how a product with several of them is narrowed to one.
   */
  availableRoots: { id: string; number: string | null; name: string; configuration: string; kind: string }[];
  flat: BomRow[];
  totals: {
    /** Distinct parts, and total pieces. */
    distinctParts: number;
    totalPieces: number;
    assemblies: number;
    released: number;
    inWork: number;
    underReview: number;
    /** Rolled up from the leaves. Null when any leaf has no mass. */
    massKg: number | null;
    /** How many leaves had no mass, which is why the rollup may be null. */
    missingMass: number;
    /** Distinct parts short of a release-required attribute. */
    needingAttributes: number;
    /** Distinct parts with at least one open Onshape task against them. */
    withOpenTasks: number;
    maxDepth: number;
  };
  /** Parts excluded because they were not effective at `asOf`. */
  excludedByDate: { partId: string; number: string | null; name: string; reason: string }[];
  /**
   * Component positions excluded because the *edge* was not effective.
   *
   * Kept apart from `excludedByDate`, which is about parts, because the two
   * mean different things to a reader: a part exclusion says "this part is not
   * current", a link exclusion says "this assembly does not use it any more" —
   * and the part is very likely still current elsewhere. Conflating them would
   * make a routine substitution look like a retired part.
   */
  excludedLinks: {
    linkId: string;
    parentId: string;
    parentNumber: string | null;
    childId: string;
    childNumber: string | null;
    childName: string;
    reason: string;
  }[];
  /** Cycles found, which are data faults worth naming rather than hiding. */
  cycles: { partId: string; number: string | null; path: string[] }[];
  /**
   * Every variant defined anywhere in this product's BOM, across every
   * top-level assembly that has any — so a picker can be built without a
   * second request. Empty on a product with no variants defined at all.
   */
  availableVariants: (VariantDoc & { parentNumber: string | null; parentName: string })[];
  /**
   * Parts in the product that no root reaches, shown as extra roots.
   *
   * Two causes, both real. A cycle makes every part in it somebody's child, so
   * the whole loop has no root and the BOM would otherwise be nearly empty —
   * which is how a structure fault turns into a page that looks merely wrong.
   * And a part whose only parent is filed under a different product is a child
   * of something this walk never starts from.
   *
   * Either way the part is in the product and has to appear, so it is walked as
   * a root and flagged rather than dropped.
   */
  unreachable: { partId: string; number: string | null; name: string }[];
};

/** Parse a YYYY-MM-DD (or ISO) date, returning null for anything unusable. */
export function parseAsOf(raw: string | null | undefined): Date | null {
  if (!raw || raw === "all") return null;
  if (raw === "today") return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A date attribute as stored, which may be a Date, a string, or absent. */
function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Whether a part is valid to build on a given date.
 *
 * Open at both ends: an empty `effectiveFrom` means it always has been, and an
 * empty `effectiveTo` means it still is. That matters more than it looks —
 * every part starts with both empty, so treating an empty end as a closed
 * boundary would make the date filter hide the entire BOM.
 */
export function isEffectiveAt(
  attrs: Record<string, unknown>,
  at: Date | null
): { effective: boolean; reason: string } {
  if (!at) return { effective: true, reason: "" };

  const from = asDate(attrs.effectiveFrom);
  const to = asDate(attrs.effectiveTo);
  const day = (d: Date) => d.toISOString().slice(0, 10);

  if (from && at.getTime() < from.getTime()) {
    return { effective: false, reason: `not effective until ${day(from)}` };
  }
  if (to && at.getTime() > to.getTime()) {
    return { effective: false, reason: `superseded after ${day(to)}` };
  }
  return { effective: true, reason: "" };
}

export async function buildProductBom(
  enterpriseId: string,
  productId: string,
  opts: { asOf?: Date | null; variantId?: string | null; rootId?: string | null } = {}
): Promise<BomResult> {
  await connectDb();

  const product: any = await Product.findOne({ _id: productId, enterpriseId }).lean();
  const asOf = opts.asOf ?? null;
  const variantId = opts.variantId ?? null;

  /*
   * Every part in the product, and every edge in the enterprise.
   *
   * The edges are not filtered by product on purpose: an assembly in this
   * product can legitimately contain a part filed under another one — a shared
   * fastener, a part that moved — and a BOM that silently dropped those would
   * understate what the product is built from. The parts are fetched by id
   * after the walk for exactly that reason.
   */
  const own: any[] = await Part.find({ enterpriseId, productId })
    .select("number name kind lifecycleState revision starCount plmOnly iteration attributes productName")
    .lean();

  if (!product) {
    return emptyResult(null, asOf);
  }

  /* The metamodel, read once — the gaps are the same question for every row. */
  const defs = await listDefinitions(enterpriseId, "PART");

  const links: any[] = await BomLink.find({ enterpriseId })
    .select("parentId childId quantity findNumber effectiveFrom effectiveTo variantIds")
    .lean();

  /* Children by parent, and the set of parts that are somebody's child. */
  const childrenOf = new Map<string, any[]>();
  const isChild = new Set<string>();
  for (const l of links) {
    const p = String(l.parentId);
    const c = String(l.childId);
    // A self-edge is a data fault — it renders as "contains itself" and makes
    // any walk non-terminating. Excluded here and reported below.
    if (p === c) continue;
    childrenOf.set(p, [...(childrenOf.get(p) ?? []), l]);
    isChild.add(c);
  }

  /*
   * Parts referenced by the walk but not filed under this product, fetched so
   * a shared component still shows its number and state rather than a blank.
   */
  const ownIds = new Set(own.map((p) => String(p._id)));
  const referenced = new Set<string>();
  const collect = (id: string, depth: number) => {
    if (depth > 24) return;
    for (const l of childrenOf.get(id) ?? []) {
      const c = String(l.childId);
      if (!ownIds.has(c)) referenced.add(c);
      collect(c, depth + 1);
    }
  };
  for (const p of own) collect(String(p._id), 0);

  const extra: any[] = referenced.size
    ? await Part.find({
        enterpriseId,
        _id: { $in: [...referenced].map((x) => new Types.ObjectId(x)) },
      })
        .select("number name kind lifecycleState revision starCount plmOnly iteration attributes productName")
        .lean()
    : [];

  const byId = new Map<string, any>(
    [...own, ...extra].map((p) => [String(p._id), p])
  );

  /*
   * Every variant defined anywhere in this BOM, fetched once so the walk
   * below can filter by id without a query per link, and so the response can
   * hand a picker its options without a second round trip.
   */
  const variantRows = await listVariantsFor(enterpriseId, [...byId.keys()]);
  const availableVariants: BomResult["availableVariants"] = variantRows.map((v) => {
    const parent = byId.get(v.parentPartId);
    return { ...v, parentNumber: parent?.number ?? null, parentName: parent?.name ?? "" };
  });
  const variantName = variantId
    ? availableVariants.find((v) => v.id === variantId)?.name ?? null
    : null;

  /*
   * The roots: parts in this product that nothing in the structure contains.
   *
   * A part that is somebody's child appears under its parent instead, so
   * listing it at the top as well would double every quantity in the flattened
   * view. A product of loose parts with no structure at all has every part as a
   * root, which is correct — that is what its BOM is.
   */
  const allRoots = own
    .filter((p) => !isChild.has(String(p._id)))
    .sort((a, b) => String(a.number ?? "").localeCompare(String(b.number ?? "")));
  const availableRoots: BomResult["availableRoots"] = allRoots.map((p: any) => ({
    id: String(p._id),
    number: p.number ?? null,
    name: p.name ?? "",
    configuration: p.configuration && p.configuration !== "default" ? String(p.configuration) : "",
    kind: p.kind ?? "part",
  }));
  // Narrowing to one assembly. An id that is no longer a root is ignored
  // rather than emptying the BOM.
  const rootId = opts.rootId && allRoots.some((p: any) => String(p._id) === opts.rootId) ? opts.rootId : null;
  const roots = rootId ? allRoots.filter((p: any) => String(p._id) === rootId) : allRoots;

  const excludedByDate: BomResult["excludedByDate"] = [];
  const excludedLinks: BomResult["excludedLinks"] = [];
  const seenExcludedLink = new Set<string>();
  const cycles: BomResult["cycles"] = [];
  const seenExcluded = new Set<string>();

  /* How many times each part appears anywhere in this BOM. */
  const appearances = new Map<string, number>();

  const flat = new Map<string, BomRow>();
  let maxDepth = 0;
  let missingMass = 0;
  let massKg: number | null = 0;

  function walk(
    partRow: any,
    quantity: number,
    parentTotal: number,
    level: number,
    path: string[],
    findNumber: string,
    /** The edge that reached this node, so its own window travels with it. */
    viaLink?: any
  ): BomNode | null {
    const id = String(partRow._id);
    const attrs = plainAttributes(partRow.attributes);

    const eff = isEffectiveAt(attrs, asOf);
    if (!eff.effective) {
      if (!seenExcluded.has(id)) {
        seenExcluded.add(id);
        excludedByDate.push({
          partId: id, number: partRow.number ?? null, name: partRow.name ?? "", reason: eff.reason,
        });
      }
      /*
       * The subtree goes with it. An assembly that is not valid to build is not
       * a route to its children on that date — they may still appear elsewhere
       * in the BOM under a parent that is effective, and if they do not, they
       * genuinely are not needed.
       */
      return null;
    }

    const totalQuantity = quantity * parentTotal;
    maxDepth = Math.max(maxDepth, level);
    appearances.set(id, (appearances.get(id) ?? 0) + 1);

    const mass = typeof attrs.mass === "number" ? attrs.mass : null;

    const node: BomNode = {
      key: `${path.join(">")}>${id}`,
      partId: id,
      number: partRow.number ?? null,
      name: partRow.name ?? "",
      description: String(attrs.description ?? ""),
      material: String(attrs.material ?? ""),
      kind: partRow.kind === "assembly" ? "assembly" : "part",
      lifecycleState: partRow.lifecycleState ?? "",
      revision: partRow.revision ?? "",
      starCount: partRow.starCount ?? 0,
      plmOnly: Boolean(partRow.plmOnly),
      iteration: partRow.iteration ?? 1,
      productName: partRow.productName ?? "",
      findNumber,
      quantity,
      totalQuantity,
      level,
      massKg: mass,
      effectiveFrom: asDate(attrs.effectiveFrom)?.toISOString() ?? null,
      effectiveTo: asDate(attrs.effectiveTo)?.toISOString() ?? null,
      linkId: viaLink ? String(viaLink._id) : null,
      linkEffectiveFrom: asDate(viaLink?.effectiveFrom)?.toISOString() ?? null,
      linkEffectiveTo: asDate(viaLink?.effectiveTo)?.toISOString() ?? null,
      linkVariantIds: (viaLink?.variantIds ?? []).map(String),
      missingForRelease: missingForRelease(defs, attrs),
      children: [],
      alsoUsedElsewhere: false,
      cycle: false,
      unreachable: false,
      /* Filled in by the pass that walks the finished tree. */
      openTaskCount: 0,
      taskCount: 0,
      starReasons: [],
    };

    /*
     * A part that contains itself, directly or through a chain.
     *
     * This has actually happened in this database — a duplicate merge
     * repointed both ends of an edge onto the same row — so it is guarded
     * rather than assumed away. Recursing would not terminate.
     */
    if (path.includes(id)) {
      node.cycle = true;
      cycles.push({ partId: id, number: partRow.number ?? null, path: [...path, id] });
      return node;
    }

    const kids = childrenOf.get(id) ?? [];
    for (const l of kids) {
      const child = byId.get(String(l.childId));
      if (!child) continue;

      /*
       * Is this component in this assembly on that date?
       *
       * Checked before the child's own effectivity and reported separately,
       * because pruning a link removes ONE path to the part — not the part.
       * The same part reached through another effective edge still appears,
       * which is exactly what a substitution looks like: the superseded bolt
       * leaves this assembly and stays perfectly current everywhere else.
       */
      const linkEff = isEffectiveAt(
        { effectiveFrom: l.effectiveFrom, effectiveTo: l.effectiveTo },
        asOf
      );
      if (!linkEff.effective) {
        const lid = String(l._id);
        if (!seenExcludedLink.has(lid)) {
          seenExcludedLink.add(lid);
          excludedLinks.push({
            linkId: lid,
            parentId: id,
            parentNumber: partRow.number ?? null,
            childId: String(l.childId),
            childNumber: child.number ?? null,
            childName: child.name ?? "",
            reason: linkEff.reason,
          });
        }
        continue;
      }

      /*
       * Is this component tagged for the variant being viewed?
       *
       * An untagged edge (the common case — most of a BOM does not vary) is
       * never filtered. A tagged one is shown only when its tags include the
       * requested variant — that is the whole mechanism: three sibling edges
       * under one assembly, each a different sized part, each tagged with the
       * one or more models that use it.
       */
      if (variantId) {
        const tags: string[] = (l.variantIds ?? []).map(String);
        if (tags.length && !tags.includes(variantId)) {
          const lid = String(l._id);
          if (!seenExcludedLink.has(lid)) {
            seenExcludedLink.add(lid);
            excludedLinks.push({
              linkId: lid,
              parentId: id,
              parentNumber: partRow.number ?? null,
              childId: String(l.childId),
              childNumber: child.number ?? null,
              childName: child.name ?? "",
              reason: `not part of the "${variantName ?? variantId}" variant`,
            });
          }
          continue;
        }
      }

      const childNode = walk(
        child,
        Number(l.quantity) || 1,
        totalQuantity,
        level + 1,
        [...path, id],
        String(l.findNumber ?? ""),
        l
      );
      if (childNode) node.children.push(childNode);
    }

    node.children.sort((a, b) => {
      // Find numbers first where the CAD gave them, then part number.
      if (a.findNumber && b.findNumber) return a.findNumber.localeCompare(b.findNumber, undefined, { numeric: true });
      return String(a.number ?? "").localeCompare(String(b.number ?? ""));
    });

    /* The flattened row: one per part, quantities summed across appearances. */
    const existing = flat.get(id);
    if (existing) {
      existing.totalQuantity += totalQuantity;
      existing.usedIn += 1;
      existing.level = Math.min(existing.level, level);
    } else {
      const { children: _c, key: _k, quantity: _q, ...rest } = node;
      flat.set(id, { ...rest, totalQuantity, usedIn: 1, level });
    }

    /*
     * Mass rolls up from leaves only.
     *
     * An assembly's own recorded mass is itself a rollup — Onshape computes it
     * from its components — so adding both would count everything twice.
     */
    if (!kids.length) {
      if (mass == null) {
        missingMass += 1;
        massKg = null;
      } else if (massKg !== null) {
        massKg += mass * totalQuantity;
      }
    }

    return node;
  }

  const builtRoots: BomNode[] = [];
  for (const r of roots) {
    const node = walk(r, 1, 1, 0, [], "");
    if (node) builtRoots.push(node);
  }

  /*
   * Anything in the product the roots never reached.
   *
   * Walked as additional roots so the BOM shows the whole product. Without
   * this, a single self-referencing edge or one cross-product parent could
   * hide most of a structure with nothing to say why.
   */
  /*
   * Reachability ignoring every date, which is a different question from
   * whether the walk visited a node.
   *
   * `appearances` cannot answer it: a component pruned by the date filter was
   * not visited either, and treating that as "unreachable" resurrected it as a
   * top-level row — so a superseded bolt came back at the top of the BOM having
   * just been correctly removed from its assembly. That defeats the filter and
   * looks like a bug in it.
   *
   * So this walks the structure with effectivity switched off. A part nothing
   * contains at all is genuinely unreachable and is shown as an extra root; a
   * part something contains, but not on this date, is simply not in the BOM
   * today, and is reported through excludedLinks instead.
   */
  const structurallyReachable = new Set<string>();
  const reach = (id: string, depth: number) => {
    if (depth > 24 || structurallyReachable.has(id)) return;
    structurallyReachable.add(id);
    for (const l of childrenOf.get(id) ?? []) reach(String(l.childId), depth + 1);
  };
  for (const r of roots) reach(String(r._id), 0);

  const unreachable: BomResult["unreachable"] = [];
  for (const r of own) {
    const id = String(r._id);
    if (structurallyReachable.has(id)) continue;
    // Reachability is judged from the chosen assembly, so every other
    // assembly's parts would read as orphans. Not a fault — skip.
    if (rootId) continue;
    unreachable.push({ partId: id, number: r.number ?? null, name: r.name ?? "" });
    const node = walk(r, 1, 1, 0, [], "");
    if (node) {
      node.unreachable = true;
      builtRoots.push(node);
    }
  }

  /* Self-edges, reported even though the walk skipped them. */
  for (const l of links) {
    if (String(l.parentId) !== String(l.childId)) continue;
    const row = byId.get(String(l.parentId));
    if (!row) continue;
    cycles.push({ partId: String(l.parentId), number: row.number ?? null, path: [String(l.parentId), String(l.parentId)] });
  }

  /*
   * Open tasks, for every part in the BOM in one query.
   *
   * Counted here rather than per row: a product BOM is hundreds of rows, and
   * the same part can appear at several positions — each of which must show
   * the same count, from one read.
   */
  const taskCounts = await taskCountsForParts(enterpriseId, [...flat.keys()]);
  // Same one-query-for-the-whole-BOM discipline, for hovering a starred
  // revision's "*" in the tree.
  const starReasons = await starReasonsForParts(enterpriseId, [...flat.keys()]);

  /* Mark the nodes whose part appears more than once, and carry their tasks. */
  const markShared = (nodes: BomNode[]) => {
    for (const n of nodes) {
      n.alsoUsedElsewhere = (appearances.get(n.partId) ?? 0) > 1;
      const c = taskCounts.get(n.partId);
      n.openTaskCount = c?.open ?? 0;
      n.taskCount = c?.total ?? 0;
      n.starReasons = starReasons.get(n.partId) ?? [];
      markShared(n.children);
    }
  };
  markShared(builtRoots);

  const rows = [...flat.values()].sort((a, b) =>
    String(a.number ?? "").localeCompare(String(b.number ?? ""))
  );
  for (const r of rows) {
    const c = taskCounts.get(r.partId);
    r.openTaskCount = c?.open ?? 0;
    r.taskCount = c?.total ?? 0;
    r.starReasons = starReasons.get(r.partId) ?? [];
  }

  return {
    product: { id: String(product._id), name: product.name },
    asOf: asOf ? asOf.toISOString() : null,
    roots: builtRoots,
    availableRoots,
    flat: rows,
    totals: {
      distinctParts: rows.length,
      totalPieces: rows.reduce((t, r) => t + r.totalQuantity, 0),
      assemblies: rows.filter((r) => r.kind === "assembly").length,
      released: rows.filter((r) => r.lifecycleState === "Released").length,
      inWork: rows.filter((r) => r.lifecycleState === "In Work").length,
      underReview: rows.filter((r) => r.lifecycleState === "Under Review").length,
      massKg: massKg === null ? null : Math.round(massKg * 1e6) / 1e6,
      missingMass,
      needingAttributes: rows.filter((r) => r.missingForRelease.length > 0).length,
      withOpenTasks: rows.filter((r) => r.openTaskCount > 0).length,
      maxDepth,
    },
    excludedByDate,
    excludedLinks,
    cycles,
    unreachable,
    availableVariants,
  };
}

function emptyResult(
  product: { id: string; name: string } | null,
  asOf: Date | null
): BomResult {
  return {
    product,
    asOf: asOf ? asOf.toISOString() : null,
    roots: [],
    availableRoots: [],
    flat: [],
    totals: {
      distinctParts: 0, totalPieces: 0, assemblies: 0, released: 0, inWork: 0,
      underReview: 0, massKg: null, missingMass: 0, needingAttributes: 0, withOpenTasks: 0,
      maxDepth: 0,
    },
    excludedByDate: [],
    excludedLinks: [],
    cycles: [],
    unreachable: [],
    availableVariants: [],
  };
}
