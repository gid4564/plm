import { connectDb } from "@/lib/db";
import {
  MockOnshapeDrawing, MockOnshapePart, MockPropertyDef, MockReleasePackage, MockOnshapeTask,
} from "@/lib/models";
import type {
  OnshapeClient, PartCoords, PartMetadata, PropertyDef, OnshapeUser, WebhookRegistration, ElementInfo, Thumbnail, WebhookSummary, ElementPart, DocumentInfo, AssemblyCoords,
  OnshapeTask, OnshapeComment, CommentContext,
  FoundTask,} from "./types";
import type { BomLine, BomTable } from "./bom";
import type { ExportFormat } from "./export-formats";
import type {
  PartExport, ReleasePackage, ReleasePackageItem, ReleaseWorkflow, WorkflowAction,
  CreateReleasePackageInput, DrawingCoords, FileExport,
} from "./types";
import type { MassProperties } from "./mass-properties";
import { mapStandardProperties, resolveEnumLabel, toDisplayString, type RawProperty } from "./standard-properties";
import { classify } from "./element-type";
import { resolveTaskCommentContext } from "./object-types";

/**
 * Stand-in for Onshape, backed by the same MongoDB PLM uses.
 *
 * Persisting mock state (rather than holding it in memory) means the simulator
 * UI, the webhook receiver and the panel all observe the same "Onshape" — edits
 * survive restarts and behave like a real tenant.
 */
export class MockOnshapeClient implements OnshapeClient {
  readonly mode = "mock" as const;

  constructor(private companyId: string, private actingUser?: { id: string; email: string; name: string }) {}

  async getAuthenticatedUser(): Promise<OnshapeUser> {
    return {
      id: this.actingUser?.id ?? "mock-user-1",
      email: this.actingUser?.email ?? "designer@mockenterprise.test",
      name: this.actingUser?.name ?? "Mock Designer",
      companyId: this.companyId,
      companyName: "Mock Enterprise",
      companyDomain: null,
    };
  }

  async listPropertyDefinitions(companyId: string): Promise<PropertyDef[]> {
    await connectDb();
    const defs = await MockPropertyDef.find({ companyId }).lean();
    return defs.map((d: any) => ({
      propertyId: d.propertyId,
      name: d.name,
      valueType: d.valueType,
      enumValues: d.enumValues?.length ? d.enumValues : undefined,
      enumOptions: d.enumOptions?.length
        ? d.enumOptions.map((o: any) => ({ value: o.value, label: o.label }))
        : undefined,
      builtIn: d.builtIn,
    }));
  }

  /*
   * Identity of one thing in the simulator.
   *
   * partId is normalised to a string rather than passed through, because an
   * assembly arrives with it empty or absent, and Mongoose strips an
   * `undefined` value from a filter instead of matching on it. That would turn
   * a lookup for "the assembly element" into "any part in this element", and
   * quietly return a part's data for an assembly — the mock's exact analogue of
   * the live bug where an empty partId built `/p/` and Onshape read it as a
   * wildcard. An empty string matches the assembly row and nothing else.
   */
  private query(c: PartCoords) {
    return {
      companyId: this.companyId,
      documentId: c.documentId,
      elementId: c.elementId,
      partId: String(c.partId ?? ""),
      configuration: c.configuration || "default",
    };
  }

  /** True when these coordinates address an element, not a part inside one. */
  private isElementScoped(c: PartCoords) {
    return !String(c.partId ?? "").trim();
  }

  /**
   * How to refer to a missing thing in an error.
   *
   * An assembly has no part id, so the part-shaped message read
   * "no part at  to measure" — a blank where the identifier should be, which
   * looks like a truncated string rather than a thing that legitimately has no
   * part id.
   */
  private describe(c: PartCoords) {
    return this.isElementScoped(c)
      ? `assembly element ${c.elementId} in document ${c.documentId}`
      : `part ${c.partId} in ${c.documentId}/${c.elementId}`;
  }

  /**
   * The identifier the stand-in geometry and colour derive from.
   *
   * An assembly has no part id, and seeding from an empty string gave every
   * assembly the same hue and the same measurements.
   */
  private seedKey(c: PartCoords) {
    return this.isElementScoped(c) ? String(c.elementId) : String(c.partId);
  }

  async getElementInfo(coords: PartCoords): Promise<ElementInfo | null> {
    await connectDb();
    const part: any = await MockOnshapePart.findOne(this.query(coords)).lean();
    if (part) {
      return {
        id: coords.elementId,
        name: part.elementName,
        elementType: String(part.elementType ?? "PARTSTUDIO").toUpperCase(),
      };
    }

    /*
     * Drawing tabs have to answer here too.
     *
     * Without this, asking about a drawing element fell through to "no part
     * found" and the caller reported a raw lookup failure — where a real tenant
     * answers `elementType: "DRAWING"` and lets PLM refuse it with an
     * explanation. A mock that cannot produce the refusal is a mock that hides
     * whether the refusal works.
     */
    const drawing: any = await MockOnshapeDrawing.findOne({
      companyId: this.companyId,
      documentId: coords.documentId,
      elementId: coords.elementId,
    }).lean();
    if (drawing) {
      return { id: coords.elementId, name: drawing.elementName, elementType: "DRAWING" };
    }

    // An empty partId means the caller is asking about the tab itself, which is
    // how a BOM read probes an assembly. The simulator has no dedicated
    // assembly tabs, so one is described for the document instead — enough for
    // the BOM path to work end to end.
    if (!coords.partId) {
      const doc: any = await MockOnshapePart.findOne({
        companyId: this.companyId,
        documentId: coords.documentId,
      }).lean();
      if (doc) {
        return {
          id: coords.elementId,
          name: `${doc.documentName || "Document"} (simulated assembly)`,
          elementType: "ASSEMBLY",
        };
      }
    }

    return null;
  }

  /**
   * Stand-in rendering: a labelled tile rather than real geometry.
   *
   * The simulator has no CAD kernel, so this exists to exercise the same
   * fetch/cache/serve path the live client uses. Colour is derived from the part
   * id so each part is visually distinct and stable across reloads.
   */
  async getPartThumbnail(coords: PartCoords, size = 300): Promise<Thumbnail | null> {
    await connectDb();
    const part: any = await MockOnshapePart.findOne(this.query(coords)).lean();
    if (!part) return null;

    const defs = await this.listPropertyDefinitions(this.companyId);
    const nameId = defs.find((d) => d.name.toLowerCase() === "name")?.propertyId;
    const label = String(
      (part.properties || {})[nameId ?? ""] || part.elementName || this.seedKey(coords)
    );

    let h = 0;
    for (const ch of this.seedKey(coords)) h = (h * 31 + ch.charCodeAt(0)) % 360;

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="hsl(${h},52%,68%)"/><stop offset="1" stop-color="hsl(${h},52%,46%)"/>` +
      `</linearGradient></defs>` +
      `<rect width="${size}" height="${size}" fill="#eef1f5"/>` +
      `<rect x="${size * 0.16}" y="${size * 0.16}" width="${size * 0.68}" height="${size * 0.68}" rx="${size * 0.06}" fill="url(#g)"/>` +
      `<text x="50%" y="52%" text-anchor="middle" font-family="system-ui,sans-serif" ` +
      `font-size="${size * 0.3}" font-weight="700" fill="#fff" opacity="0.92">` +
      `${label.slice(0, 2).toUpperCase().replace(/[<>&]/g, "")}</text>` +
      `<text x="50%" y="88%" text-anchor="middle" font-family="ui-monospace,monospace" ` +
      `font-size="${size * 0.075}" fill="#5c6773">${String(
        this.isElementScoped(coords) ? part.elementName || "assembly" : coords.partId
      ).replace(/[<>&]/g, "")}</text>` +
      `</svg>`;

    return { contentType: "image/svg+xml", data: Buffer.from(svg, "utf8") };
  }

  /**
   * Stand-in bill of materials.
   *
   * The simulator models Part Studios only, so there is no real assembly to
   * explode. Every part in the document is treated as a line of the requested
   * element's BOM, with a quantity derived from the part id so the same part
   * always reports the same count.
   *
   * The point is to exercise the import path — parse, select, enrol, roll up
   * quantities — against the same interface the live client implements, not to
   * simulate assembly structure.
   */
  async getAssemblyBom(
    c: AssemblyCoords,
    opts: { multiLevel?: boolean; indented?: boolean } = {}
  ): Promise<BomTable> {
    const indented = opts.indented !== false;
    await connectDb();

    const all: any[] = await MockOnshapePart.find({
      companyId: this.companyId,
      documentId: c.documentId,
    }).lean();

    // Say plainly that the simulator has never heard of this document, rather
    // than returning an empty BOM. A real Onshape link pasted into a mock
    // instance lands here, and "no rows" reads as a broken feature when the
    // actual answer is that nothing is talking to Onshape at all.
    if (all.length === 0) {
      throw new Error(
        `The Onshape simulator has no document ${c.documentId}. ` +
        `This PLM is running in simulator mode (ONSHAPE_MODE=mock), so links to real ` +
        `Onshape documents cannot be read. Use a simulator document, or run against a ` +
        `live Onshape enterprise.`
      );
    }

    // Prefer parts from other tabs, so the "assembly" is not a BOM of itself.
    // A single-tab document falls back to everything, which is still useful.
    /*
     * Parts from other tabs, so the "assembly" is not a BOM of itself — and
     * not the subassembly element either, which is emitted as its own row
     * below.
     *
     * Without that second exclusion the subassembly appeared twice: once as
     * the parent row and once as an ordinary part. The two shared a key, and
     * the importer's key→index lookup resolved to the childless copy, so every
     * child was left unlinked and the import silently flattened. The importer
     * no longer depends on key uniqueness, but a BOM listing an assembly as
     * one of its own parts was never a faithful simulation.
     */
    const others = all.filter(
      (p) => p.elementId !== c.elementId && !p.isSubassembly
    );
    const rows = others.length ? others : all.filter((p) => p.elementId !== c.elementId);

    const defs = await this.listPropertyDefinitions(this.companyId);
    const idFor = (name: string) =>
      defs.find((d) => d.name.toLowerCase() === name)?.propertyId ?? "";
    const numId = idFor("part number");
    const nameId = idFor("name");
    const descId = idFor("description");
    const matId = idFor("material");
    const revId = idFor("revision");

    /*
     * A subassembly to nest half the parts under, when structure was asked for.
     *
     * An indented BOM's whole point is that rows sit under other rows, so a
     * simulator that only ever produced one level could not exercise the
     * structured import at all — not the hierarchy reconstruction, not bringing
     * a subassembly in as a PLM assembly, and not the per-parent reconciliation.
     */
    const sub: any = indented
      ? await MockOnshapePart.findOne({
          companyId: this.companyId,
          documentId: c.documentId,
          isSubassembly: true,
        }).lean()
      : null;

    const lines: BomLine[] = rows.map((p) => {
      let h = 0;
      for (const ch of String(p.partId)) h = (h * 31 + ch.charCodeAt(0)) % 97;
      const props = p.properties || {};

      return {
        key: `${p.documentId}:${p.elementId}:${p.partId}:${p.configuration || "default"}`,
        quantity: 1 + (h % 4),
        partNumber: toDisplayString(props[numId]),
        name: toDisplayString(props[nameId]) || p.partId,
        description: toDisplayString(props[descId]),
        material: toDisplayString(props[matId]),
        revision: toDisplayString(props[revId]),
        state: "",
        vendor: "",
        project: "",
        // The first half go under the subassembly, the rest stay at the top.
        indentLevel: indented && sub && rows.indexOf(p) < Math.ceil(rows.length / 2) ? 1 : 0,
        isAssembly: false,
        source: {
          documentId: p.documentId,
          elementId: p.elementId,
          partId: p.partId,
          configuration: p.configuration || "default",
          workspaceId: p.workspaceId ?? null,
          versionId: null,
        },
        sourceWvmType: "w",
        unresolvable: null,
      };
    });

    /*
     * The subassembly row itself, inserted ahead of its children.
     *
     * An indented BOM is a flat list whose order carries the hierarchy: a row's
     * parent is the nearest row above it one level shallower. So the
     * subassembly has to come first, or its children would attach to whatever
     * preceded them.
     */
    if (indented && sub) {
      const subProps = sub.properties || {};
      lines.unshift({
        // Index-prefixed, as parseBom keys an indented row.
        key: `0:${sub.documentId}:${sub.elementId}::default`,
        quantity: 1,
        partNumber: toDisplayString(subProps[numId]),
        name: toDisplayString(subProps[nameId]) || sub.elementName || "Subassembly",
        description: toDisplayString(subProps[descId]),
        material: "",
        revision: "",
        state: "",
        vendor: "",
        project: "",
        indentLevel: 0,
        isAssembly: true,
        source: {
          documentId: sub.documentId,
          elementId: sub.elementId,
          // An assembly is an element, so there is no part within it.
          partId: "",
          configuration: "default",
          workspaceId: sub.workspaceId ?? null,
          versionId: null,
        },
        sourceWvmType: "w",
        unresolvable: null,
      });
    }

    return {
      lines,
      headers: ["Item", "Quantity", "Part number", "Name", "Description", "Material"],
      shape: "mock",
      indented,
    };
  }

  /**
   * Stand-in export.
   *
   * The simulator has no geometry, so this produces a small, well-formed file
   * of the right shape — a real tetrahedron for STL, a readable placeholder
   * otherwise. Enough to exercise the whole path: request, wait, download,
   * filename. Translation formats pause briefly so the waiting state in the UI
   * is something you can actually see.
   */
  async exportPart(coords: PartCoords, format: ExportFormat): Promise<PartExport> {
    const started = Date.now();
    await connectDb();

    const part: any = await MockOnshapePart.findOne(this.query(coords)).lean();
    if (!part) throw new Error(`Mock Onshape: nothing at ${this.describe(coords)} to export`);

    if (format.strategy === "translation") {
      await new Promise((r) => setTimeout(r, 900));
    }

    const label = `${part.documentName || "Document"} / ${coords.partId}`;
    let body: string;

    if (format.id === "STL") {
      // A valid ASCII STL, so the file opens in a viewer rather than erroring.
      const facet = (n: string, a: string, b: string, c2: string) =>
        `  facet normal ${n}\n    outer loop\n      vertex ${a}\n      vertex ${b}\n` +
        `      vertex ${c2}\n    endloop\n  endfacet\n`;
      body =
        `solid ${coords.partId}\n` +
        facet("0 0 -1", "0 0 0", "10 0 0", "0 10 0") +
        facet("0 -1 0", "0 0 0", "0 0 10", "10 0 0") +
        facet("-1 0 0", "0 0 0", "0 10 0", "0 0 10") +
        facet("0.577 0.577 0.577", "10 0 0", "0 0 10", "0 10 0") +
        `endsolid ${coords.partId}\n`;
    } else {
      body =
        `${format.label} export produced by the PLM Onshape simulator.\n` +
        `This deployment is running in simulator mode, so there is no geometry to\n` +
        `translate. Against a live Onshape enterprise this file would contain the\n` +
        `real ${format.label} data for the part.\n\n` +
        `Part: ${label}\nConfiguration: ${coords.configuration || "default"}\n` +
        `Generated: ${new Date().toISOString()}\n`;
    }

    return {
      data: Buffer.from(body, "utf8"),
      contentType: format.contentType,
      via: format.strategy,
      translationId: format.strategy === "translation" ? `mock-translation-${coords.partId}` : undefined,
      elapsedMs: Date.now() - started,
    };
  }

  async listElementParts(c: PartCoords): Promise<ElementPart[]> {
    await connectDb();
    const parts: any[] = await MockOnshapePart.find({
      companyId: this.companyId, documentId: c.documentId, elementId: c.elementId,
    }).lean();

    const defs = await this.listPropertyDefinitions(this.companyId);
    const numId = defs.find((d) => d.name.toLowerCase() === "part number")?.propertyId ?? "";
    const nameId = defs.find((d) => d.name.toLowerCase() === "name")?.propertyId ?? "";

    return parts.map((p) => ({
      partId: p.partId,
      partNumber: String((p.properties || {})[numId] ?? ""),
      name: String((p.properties || {})[nameId] ?? ""),
    }));
  }

  async getDocumentInfo(documentId: string): Promise<DocumentInfo> {
    await connectDb();
    const p: any = await MockOnshapePart.findOne({ companyId: this.companyId, documentId }).lean();
    return { name: p?.documentName ?? "", defaultWorkspaceId: p?.workspaceId ?? null, accessError: null, canWrite: true };
  }

  /**
   * Stand-in mass properties.
   *
   * The simulator has no CAD kernel, so there is no real geometry to measure.
   * What it can do honestly is the one behaviour this feature exists to show:
   * a part with no Material property reports no mass, exactly as a real
   * Onshape part with nothing assigned would. Volume and centroid are a
   * deterministic, plausible-sized solid derived from the part id, so the
   * same part always reports the same numbers.
   *
   * An assembly is rolled up from the parts in its document rather than
   * measured as a solid, because that is what a real assembly does: material
   * is not a property of an assembly, so measuring one the part way would
   * report no mass for an assembly whose parts are all steel.
   */
  async getMassProperties(coords: PartCoords): Promise<MassProperties> {
    await connectDb();

    const defs = await this.listPropertyDefinitions(this.companyId);
    const materialId = defs.find((d) => d.name.toLowerCase() === "material")?.propertyId ?? "";

    if (this.isElementScoped(coords)) {
      const asm: any = await MockOnshapePart.findOne(this.query(coords)).lean();
      if (!asm) throw new Error(`Mock Onshape: nothing at ${this.describe(coords)} to measure`);

      const members: any[] = await MockOnshapePart.find({
        companyId: this.companyId,
        documentId: coords.documentId,
        partId: { $nin: [null, ""] },
      }).lean();

      const measured = members.map((m) =>
        this.measureSolid(String(m.partId), toDisplayString((m.properties || {})[materialId]))
      );
      const volumeM3 = measured.reduce((t, m) => t + m.volumeM3, 0);
      const surfaceAreaM2 = measured.reduce((t, m) => t + m.surfaceAreaM2, 0);
      const withMass = measured.filter((m) => m.massKg !== null);

      /*
       * No mass unless every member has one. A partial sum is worse than no
       * answer: it reads as the assembly's weight while silently omitting the
       * components that have no material assigned, and someone would quote it.
       */
      const complete = measured.length > 0 && withMass.length === measured.length;

      return {
        hasMass: complete,
        massKg: complete ? withMass.reduce((t, m) => t + (m.massKg ?? 0), 0) : null,
        volumeM3,
        centroidM: [0, 0, 0],
        surfaceAreaM2,
        shape: "mock",
      };
    }

    const part: any = await MockOnshapePart.findOne(this.query(coords)).lean();
    if (!part) throw new Error(`Mock Onshape: nothing at ${this.describe(coords)} to measure`);

    const solid = this.measureSolid(
      this.seedKey(coords),
      toDisplayString((part.properties || {})[materialId])
    );
    return {
      hasMass: solid.massKg !== null,
      massKg: solid.massKg,
      volumeM3: solid.volumeM3,
      centroidM: solid.centroidM,
      surfaceAreaM2: solid.surfaceAreaM2,
      shape: "mock",
    };
  }

  /**
   * One stand-in solid: a deterministic size from `key`, and a mass only if a
   * material was assigned.
   */
  private measureSolid(key: string, material: string) {
    let seed = 0;
    for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
    const sideM = 0.02 + (seed % 100) / 1000; // 20-119mm across, roughly hand-sized
    const volumeM3 = sideM ** 3 * 0.4; // a solid, not a cube — 40% fill
    const surfaceAreaM2 = sideM * sideM * 3;
    const centroidM: [number, number, number] = [0, 0, sideM / 2];

    if (!material) return { massKg: null, volumeM3, surfaceAreaM2, centroidM };

    // Rough densities (kg/m^3) for the materials the simulator's own seed data
    // uses. Anything unrecognised still gets a plausible mid-range density
    // rather than reporting no mass for a material that plainly is one.
    const density =
      /steel|4340|1018/i.test(material) ? 7850 :
      /aluminium|aluminum|6061/i.test(material) ? 2700 :
      /bronze/i.test(material) ? 8800 :
      /titanium/i.test(material) ? 4500 :
      2700;

    return { massKg: volumeM3 * density, volumeM3, surfaceAreaM2, centroidM };
  }

  async getPartMetadata(coords: PartCoords): Promise<PartMetadata> {
    await connectDb();
    const part: any = await MockOnshapePart.findOne(this.query(coords)).lean();
    if (!part) throw new Error(`Mock Onshape: nothing at ${this.describe(coords)}`);

    const defs = await this.listPropertyDefinitions(this.companyId);
    const nameById = new Map(defs.map((d) => [d.propertyId, d.name]));

    const raw: Record<string, unknown> = { ...(part.properties || {}) };
    const defById = new Map(defs.map((d) => [d.propertyId, d]));
    const props: RawProperty[] = Object.entries(raw).map(([propertyId, value]) => {
      const d = defById.get(propertyId);
      return {
        propertyId,
        name: nameById.get(propertyId) ?? "",
        value,
        valueType: d?.valueType,
        // Real code/label pairs where the definition has them; otherwise widen
        // a plain label list to the same shape, so both resolve identically to
        // the live path.
        enumValues:
          d?.enumOptions?.length
            ? d.enumOptions
            : d?.enumValues?.length
              ? d.enumValues.map((v) => ({ value: v, label: v }))
              : undefined,
      };
    });

    const std = mapStandardProperties(props);
    const display: (RawProperty & { raw?: unknown; options?: unknown })[] = props.map((p) => {
      const shown = p.enumValues?.length
        ? resolveEnumLabel(p.value, p.enumValues)
        : toDisplayString(p.value);
      // Keep the code only when it is not already the thing being shown.
      const raw = String(p.value ?? "") !== shown ? p.value : undefined;
      return { ...p, value: shown, raw, options: p.enumValues?.length ? p.enumValues : undefined };
    });

    return {
      coords: { ...coords, workspaceId: coords.workspaceId ?? part.workspaceId },
      documentName: part.documentName,
      elementName: part.elementName,
      partName: std.partName,
      partNumber: std.partNumber,
      revision: std.revision,
      description: std.description,
      material: std.material,
      state: std.state,
      vendor: std.vendor,
      project: std.project,
      raw,
      definitions: defs,
      properties: display,
    };
  }

  async updatePartProperties(coords: PartCoords, values: Record<string, unknown>): Promise<void> {
    await connectDb();
    const q = this.query(coords);
    const part: any = await MockOnshapePart.findOne(q);
    if (!part) throw new Error(`Mock Onshape: cannot write, nothing at ${this.describe(coords)}`);

    part.properties = { ...(part.properties || {}), ...values };
    part.markModified("properties");
    await part.save();
  }

  /* ======================================================================== */
  /* Tasks                                                                     */
  /* ======================================================================== */

  /**
   * The transitions a task offers, by state.
   *
   * Onshape's stock task workflow, as far as PLM needs it: a task is opened,
   * worked on, and resolved — with a reopen from the resolved state, because a
   * task interface that cannot reopen anything is not one anybody would trust.
   *
   * The ids are what a transition call sends, and they are deliberately
   * different from the types — the same distinction that made release packages
   * fail silently, mirrored here so any client conflating the two breaks
   * locally rather than against a tenant.
   */
  private taskActionsFor(
    state: string,
    style: string = "stock"
  ): { id: string; label: string; type: string }[] {
    /*
     * Onshape's stock task workflow has NO transition that starts work.
     *
     * An open task on a live tenant offers exactly COMPLETE(APPROVE) and
     * OS_DISCARD(DELETE). Progress is the "Task State" property's business,
     * not the workflow's. The simulator used to offer an invented START here,
     * so PLM's "In Progress" column passed every test and then failed against
     * every real tenant with "Onshape offers no start transition".
     */
    const stock = style !== "extended";

    switch (state.toUpperCase()) {
      /*
       * The ids a live tenant's stock task workflow actually offers, read off
       * a real task: COMPLETE (type APPROVE) and OS_DISCARD (type DELETE).
       * The invented ones this had before happened to work only because
       * matching is by type — which is precisely the coincidence that hides a
       * client conflating id with type.
       */
      case "OPEN":
        return [
          ...(stock ? [] : [{ id: "START", label: "Start work", type: "SUBMIT" }]),
          { id: "COMPLETE", label: "Complete", type: "APPROVE" },
          { id: "OS_DISCARD", label: "Discard", type: "DELETE" },
        ];
      case "IN PROGRESS":
        return [
          { id: "COMPLETE", label: "Complete", type: "APPROVE" },
          { id: "REJECT", label: "Reject", type: "REJECT" },
          { id: "OS_DISCARD", label: "Discard", type: "DELETE" },
        ];
      case "RESOLVED":
      case "REJECTED":
        /*
         * A completed task on the live tenant offered NO actions at all — it
         * could not be reopened, deleted or discarded. The stock workflow here
         * is the generous version of that; a tenant where nothing is on offer
         * is modelled by t-closed in the task tests.
         */
        return [{ id: "REOPEN", label: "Reopen", type: "SUBMIT" }];
      default:
        return [];
    }
  }

  private stateAfter(state: string, transition: string): string | null {
    const t = transition.toUpperCase();
    if (t === "START") return "In Progress";
    if (t === "COMPLETE") return "Resolved";
    if (t === "REJECT") return "Rejected";
    if (t === "REOPEN") return "Open";
    /*
     * A discard is terminal, and the state has to change or the mock lies: a
     * task still reading "Open" after a successful discard would let PLM
     * report it gone while the board still showed it as work to do.
     */
    if (t === "OS_DISCARD") return "Discarded";
    return null;
  }

  private toTask(d: any): OnshapeTask {
    return {
      id: String(d.taskId),
      name: d.name ?? "",
      description: d.description ?? "",
      state: d.state ?? "",
      status: typeof d.status === "number" ? d.status : null,
      taskType: d.taskType ?? "",
      documentId: d.documentId ?? "",
      documentName: d.documentName ?? "",
      elementId: d.elementId ?? "",
      workspaceId: null,
      versionId: null,
      objectId: d.objectId ?? "",
      creatorEmail: d.creatorEmail ?? "",
      creatorName: d.creatorName ?? "",
      assignees: (d.assignees ?? []).map((a: any) => ({
        onshapeUserId: a.onshapeUserId ?? "",
        email: a.email ?? "",
        name: a.name ?? "",
        acted: Boolean(a.acted),
      })),
      resolvedAt: d.resolvedAt ? new Date(d.resolvedAt).toISOString() : null,
      resolvedByEmail: d.resolvedByEmail ?? "",
      items: (d.items ?? []).map((i: any) => ({
        label: i.label ?? "",
        documentId: i.documentId ?? "",
        elementId: i.elementId ?? "",
        partId: i.partId ?? "",
        // A real task item carries `dataType` and leaves `mimeType` null.
        elementType: classify({ ...i, dataType: i.dataType, elementType: i.elementType }).type,
      })),
      comments: (d.comments ?? []).map((c: any) => ({
        id: c.id,
        message: c.message,
        authorEmail: c.authorEmail ?? "",
        authorName: c.authorName ?? "",
        createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : "",
        objectType: typeof c.objectType === "number" ? c.objectType : null,
        objectId: String(d.taskId),
        /* The anchor, which is what PLM copies onto a new comment. */
        documentId: d.documentId ?? "",
        workspaceId: "",
        versionId: "",
        elementId: d.elementId ?? "",
      })),
      availableActions: this.taskActionsFor(d.state ?? "", d.workflowStyle),
      properties: (d.properties ?? []).map((pr: any) => ({
        propertyId: pr.propertyId, name: pr.name, value: pr.value ?? null,
        valueType: pr.valueType ?? "STRING",
        editable: Boolean(pr.editable), required: Boolean(pr.required),
        enumValues: pr.enumValues ?? [],
      })),
      /*
       * Commentable means the workflow declares a Comment property — the same
       * rule the live client applies, since that is where a comment is written.
       */
      /*
       * The simulator mirrors the distinction a live task showed: deletable
       * and discardable are different answers, and a task can be the second
       * without being the first.
       */
      deletable: d.deletable !== false,
      commentable: (d.properties ?? []).some(
        (pr: any) =>
          pr.editable && String(pr.valueType).toUpperCase() === "STRING" &&
          /comment|note|remark/i.test(String(pr.name ?? ""))
      ),
      raw: d,
    };
  }

  async listTasks(
    opts: { userId?: string; documentId?: string; status?: number; limit?: number; offset?: number } = {}
  ): Promise<OnshapeTask[]> {
    await connectDb();
    /*
     * Only the tasks the calling account would actually be shown.
     *
     * `getActionItems` is not "every task" — see visibleAsActionItem on the
     * model. Returning everything here would make the simulator disagree with
     * every live tenant in exactly the way that hides whether findTasks is
     * wired up at all.
     */
    const q: Record<string, unknown> = { companyId: this.companyId, visibleAsActionItem: { $ne: false } };
    if (opts.documentId) q.documentId = opts.documentId;
    const rows: any[] = await MockOnshapeTask.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(200, opts.limit ?? 100))
      .skip(opts.offset ?? 0)
      .lean();
    return rows.map((r) => this.toTask(r));
  }

  /**
   * The internal search: every task, in the search's own shape.
   *
   * Deliberately returns rows `listTasks` does not, and deliberately returns
   * them as `FoundTask` rather than `OnshapeTask` — the live projection has no
   * workflow snapshot, so promoting it to a task would invent a state and a
   * set of transitions. Anything that needs those has to call `getTask`.
   */
  async findTasks(opts: { from?: number; size?: number } = {}): Promise<FoundTask[]> {
    await connectDb();
    const size = Math.min(100, Math.max(1, opts.size ?? 100));
    const rows: any[] = await MockOnshapeTask.find({ companyId: this.companyId })
      .sort({ createdAt: -1 })
      .skip(Math.max(0, opts.from ?? 0))
      .limit(size)
      .lean();
    return rows.map((r) => ({
      id: String(r.taskId),
      name: String(r.name ?? ""),
      taskType: String(r.taskType ?? ""),
      /* A display string, as the live search gives — not the workflow state. */
      displayState: String(r.state ?? ""),
      documentId: String(r.documentId ?? ""),
    }));
  }

  async getTask(taskId: string): Promise<OnshapeTask> {
    await connectDb();
    const d: any = await MockOnshapeTask.findOne({ companyId: this.companyId, taskId }).lean();
    if (!d) throw new Error(`Mock Onshape has no task "${taskId}".`);
    /*
     * The orphaned-task 500, reproduced. A live tenant had 7 of these: they
     * list but will not read, and a caller that ignores the failure puts a
     * nameless card on the board.
     */
    if (d.hydrateFails) {
      throw new Error(
        `Onshape GET /tasks/${taskId} -> 500: An internal error has occurred; ` +
        `support code 9e6f7294436fcb752a8a104d`
      );
    }
    return this.toTask(d);
  }

  async transitionTask(taskId: string, transition: string): Promise<OnshapeTask> {
    await connectDb();
    const doc: any = await MockOnshapeTask.findOne({ companyId: this.companyId, taskId });
    if (!doc) throw new Error(`Mock Onshape has no task "${taskId}".`);

    const offered = this.taskActionsFor(doc.state, doc.workflowStyle);
    if (!offered.some((a) => a.id === transition)) {
      /*
       * The same refusal a real tenant gives, and worth mocking faithfully: a
       * transition the state does not offer is how a stale board tries to act
       * on a task somebody else already moved.
       */
      throw new Error(
        `Mock Onshape: "${transition}" is not available from state ${doc.state}. ` +
        `Available: ${offered.map((a) => a.id).join(", ") || "none"}.`
      );
    }

    const next = this.stateAfter(doc.state, transition);
    if (next) doc.state = next;
    if (next === "Resolved") {
      doc.resolvedAt = new Date();
      doc.resolvedByEmail = this.actingUser?.email ?? "service@mockenterprise.test";
    } else {
      doc.resolvedAt = null;
      doc.resolvedByEmail = "";
    }
    await doc.save();
    return this.toTask(doc.toObject());
  }

  async updateTask(
    taskId: string,
    patch: { name?: string; description?: string; propertyValues?: Record<string, unknown> }
  ): Promise<OnshapeTask> {
    await connectDb();
    const doc: any = await MockOnshapeTask.findOne({ companyId: this.companyId, taskId });
    if (!doc) throw new Error(`Mock Onshape has no task "${taskId}".`);
    if (patch.name != null) doc.name = patch.name;
    if (patch.description != null) doc.description = patch.description;
    for (const [propertyId, value] of Object.entries(patch.propertyValues ?? {})) {
      const pr = (doc.properties ?? []).find((x: any) => x.propertyId === propertyId);
      if (!pr) {
        throw new Error(`Mock Onshape: this task has no property ${propertyId}.`);
      }
      if (!pr.editable) {
        // The same refusal a real tenant gives for a read-only property.
        throw new Error(`Mock Onshape: "${pr.name}" is read-only on this task.`);
      }
      pr.value = value;
    }
    doc.markModified("properties");
    await doc.save();
    return this.toTask(doc.toObject());
  }

  async commentOnTask(
    taskId: string,
    message: string,
    _opts: CommentContext = {}
  ): Promise<OnshapeComment> {
    await connectDb();
    const doc: any = await MockOnshapeTask.findOne({ companyId: this.companyId, taskId });
    if (!doc) throw new Error(`Mock Onshape has no task "${taskId}".`);

    /*
     * A comment is a write to the workflow's Comment property.
     *
     * That is what Onshape's own UI does — `POST /tasks/{tid}` with
     * `propertyValues: [{propertyId: <Comment>, value: <text>}]` — and the
     * task comes back with the message appended to its thread. The simulator
     * refuses a task whose workflow has no such property, because PLM spent
     * three rounds posting to `/comments` and a mock that accepted anything
     * could not have shown that the endpoint was wrong.
     */
    const prop = (doc.properties ?? []).find(
      (pr: any) =>
        pr.editable && String(pr.valueType).toUpperCase() === "STRING" &&
        /comment|note|remark/i.test(String(pr.name ?? ""))
    );
    if (!prop) {
      throw new Error(
        `Mock Onshape: this task's workflow has no Comment property, so there is nowhere ` +
        `to post a comment. Onshape appends one by writing that property, not through the ` +
        `comment API.`
      );
    }

    const comment = {
      id: `mock-comment-${Math.random().toString(36).slice(2, 10)}`,
      message,
      authorEmail: this.actingUser?.email ?? "service@mockenterprise.test",
      authorName: this.actingUser?.name ?? "PLM service account",
      createdAt: new Date(),
      /*
       * 10, which is what a live tenant returned on a task comment — not 14.
       * BTMetadataObjectType's ordinal for TASK is 14, and this is the
       * evidence that its ordinals are not the comment API's codes.
       */
      objectType: 10,
    };
    doc.comments.push(comment);
    /* Onshape leaves the property itself empty after appending the comment. */
    prop.value = "";
    doc.markModified("properties");
    await doc.save();

    return {
      id: comment.id,
      message: comment.message,
      authorEmail: comment.authorEmail,
      authorName: comment.authorName,
      createdAt: comment.createdAt.toISOString(),
      objectType: comment.objectType,
      objectId: taskId,
      // Onshape reports the task's own id as the comment's documentId.
      documentId: taskId,
      workspaceId: "",
      versionId: "",
      elementId: "",
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    await connectDb();
    const doc: any = await MockOnshapeTask.findOne({ companyId: this.companyId, taskId });
    if (!doc) throw new Error(`Mock Onshape has no task "${taskId}".`);
    /*
     * Refuse what Onshape refuses. A task it reports as `deletable: false`
     * cannot be deleted, and a simulator that deleted anything would let PLM
     * offer a button that fails on a real tenant.
     */
    if (doc.deletable === false) {
      throw new Error(
        `Mock Onshape: task "${taskId}" is not deletable. Onshape reports deletable:false ` +
        `for such a task — discard it through its workflow instead.`
      );
    }
    await MockOnshapeTask.deleteOne({ companyId: this.companyId, taskId });
  }

  async registerWebhook(companyId: string, callbackUrl: string, events: string[]): Promise<WebhookRegistration> {
    // No real subscription to make — the simulator posts directly to the receiver.
    return { id: `mock-webhook-${companyId}`, events };
  }

  async listWebhooks(companyId: string): Promise<WebhookSummary[]> {
    // The simulator posts directly to the receiver; no real subscriptions exist.
    return [];
  }

  async unregisterWebhook(): Promise<void> {
    /* no-op */
  }

  /* ======================================================================== */
  /* Release management                                                        */
  /*                                                                          */
  /* The mock implements the release *mechanics*, not a caricature of them:    */
  /* a package sits in a state, offers exactly the transitions that state      */
  /* allows, and creates revisions when a release completes. That matters      */
  /* because the real integration has to read the available actions off the    */
  /* package rather than assume them — a mock that always offered "APPROVE"    */
  /* would let code ship that only works against a mock.                      */
  /* ======================================================================== */

  /**
   * The transitions a package in this state offers.
   *
   * Named after the workflow action *types* Onshape's custom-workflow schema
   * uses, since those are the vocabulary the release logic matches on. The ids
   * are deliberately not the same strings as the types: on a real tenant they
   * are per-workflow identifiers, and code that conflated the two would work
   * here and fail there.
   */
  /**
   * The transitions a package offers, by state.
   *
   * The ids are Onshape's real ones, read off a live enterprise package: an
   * APPROVE-type action is posted back as `RELEASE`, not `APPROVE` — the type
   * and the id differ, and that is worth mirroring exactly, because a client
   * that conflated them would work against a mock using invented ids and fail
   * against a tenant. `DELETE` is on a live package too, and is deliberately
   * included so nothing may quietly resolve "reject" to it.
   */
  private actionsFor(state: string): WorkflowAction[] {
    switch (state.toUpperCase()) {
      case "PENDING":
        return [
          { id: "RELEASE", label: "Release", type: "APPROVE" },
          { id: "REJECT", label: "Reject", type: "REJECT" },
          { id: "REASSIGN_TASK", label: "Reassign", type: "REASSIGN_TASK" },
          { id: "DELETE", label: "Delete", type: "DELETE" },
        ];
      case "REJECTED":
        return [{ id: "SUBMIT", label: "Resubmit", type: "SUBMIT" }];
      case "RELEASED":
        return [{ id: "OBSOLETE", label: "Obsolete", type: "OBSOLETE" }];
      default:
        return [];
    }
  }

  private toPackage(d: any): ReleasePackage {
    const items: ReleasePackageItem[] = (d.items ?? []).map((it: any) => ({
      id: String(it.id ?? ""),
      documentId: String(it.documentId ?? ""),
      elementId: String(it.elementId ?? ""),
      partId: String(it.partId ?? ""),
      // Classified, not stringified — the same treatment the live client needs,
      // so a mock package's drawing is recognisable as one here too.
      elementType: classify(it ?? {}).type,
      name: String(it.name ?? ""),
      partNumber: String(it.partNumber ?? ""),
      revisionId: String(it.revisionId ?? ""),
      revision: String(it.revision ?? ""),
      versionId: String(it.versionId ?? ""),
    }));

    return {
      id: String(d.rpid),
      workflowId: String(d.wfid ?? ""),
      state: String(d.state ?? ""),
      /*
       * The simulator transitions synchronously, so it reports no work in
       * progress. Present so the field exists on both clients, and so a caller
       * that reads it does not have to special-case the mock.
       */
      transitionStatus: [],
      /*
       * The simulator lets the caller do anything its workflow offers, and says
       * so rather than leaving the field empty: an empty approver list with
       * `allowIfNoApprovers` is itself a meaningful state on a real tenant.
       */
      permissions: { approverIds: [], isCreator: false, createdById: "" },
      changeOrderId: String(d.changeOrderId ?? ""),
      items,
      properties: (d.properties ?? {}) as Record<string, unknown>,
      availableActions: this.actionsFor(String(d.state ?? "")),
      syncedWithPLM: Boolean(d.syncedWithPLM),
      raw: d as Record<string, unknown>,
    };
  }

  async getReleaseWorkflow(_companyId: string): Promise<ReleaseWorkflow | null> {
    return { id: "mock-workflow", name: "Mock release workflow" };
  }

  async getReleasePackage(rpid: string): Promise<ReleasePackage> {
    await connectDb();
    const d: any = await MockReleasePackage.findOne({ companyId: this.companyId, rpid }).lean();
    if (!d) throw new Error(`Mock Onshape has no release package "${rpid}".`);
    return this.toPackage(d);
  }

  /**
   * The next revision letter for an item that already has revisions.
   *
   * A→B→C, matching Onshape's default alphabetical scheme. Onshape owns the
   * scheme on a real tenant, and PLM only records what it is told — so this
   * exists to give PLM something realistic to be told, not to be authoritative.
   */
  private nextRevision(existing: { revision: string }[]): string {
    if (!existing.length) return "A";
    const last = existing[existing.length - 1].revision || "A";
    const code = last.charCodeAt(last.length - 1);
    return code >= 90 ? last + "A" : String.fromCharCode(code + 1);
  }

  async transitionReleasePackage(
    rpid: string,
    actionId: string,
    opts: { properties?: Record<string, unknown>; note?: string } = {}
  ): Promise<ReleasePackage> {
    await connectDb();
    const doc: any = await MockReleasePackage.findOne({ companyId: this.companyId, rpid });
    if (!doc) throw new Error(`Mock Onshape has no release package "${rpid}".`);

    const action = this.actionsFor(doc.state).find((a) => a.id === actionId);
    if (!action) {
      // The same refusal a real tenant gives, and worth mocking faithfully: an
      // action that was available when the package was read may not be by the
      // time the transition is attempted.
      throw new Error(
        `Mock Onshape refused action "${actionId}" on a package in state ` +
        `${doc.state}. Available: ${this.actionsFor(doc.state).map((a) => a.id).join(", ") || "none"}.`
      );
    }

    if (action.type === "APPROVE") {
      doc.state = "RELEASED";

      // Creating the revisions is the part that matters downstream: it is what
      // gives the released drawing a version to be exported from, and what a
      // real onshape.revision.created webhook would be announcing.
      for (const item of doc.items) {
        const isDrawing = String(item.elementType).toUpperCase() === "DRAWING";
        const Model: any = isDrawing ? MockOnshapeDrawing : MockOnshapePart;
        const q: any = {
          companyId: this.companyId,
          documentId: item.documentId,
          elementId: item.elementId,
        };
        if (!isDrawing && item.partId) q.partId = item.partId;

        const target: any = await Model.findOne(q);
        if (!target) continue;

        const revision = this.nextRevision(target.revisions ?? []);
        const versionId = `mock-v-${Date.now().toString(36)}-${revision}`;
        target.revisions = [...(target.revisions ?? []), { revision, versionId, createdAt: new Date() }];
        await target.save();

        item.revision = revision;
        item.versionId = versionId;
      }
    } else if (action.type === "REJECT") {
      doc.state = "REJECTED";
    } else if (action.type === "SUBMIT") {
      doc.state = "PENDING";
    } else if (action.type === "OBSOLETE") {
      doc.state = "OBSOLETE";
    }

    if (opts.properties) doc.properties = { ...(doc.properties ?? {}), ...opts.properties };
    doc.markModified("items");
    doc.markModified("properties");
    await doc.save();

    return this.toPackage(doc.toObject());
  }

  async createReleasePackage(
    wfid: string,
    input: CreateReleasePackageInput
  ): Promise<ReleasePackage> {
    await connectDb();
    const rpid = `mock-rp-${Date.now().toString(36)}`;

    // Resolve each requested item against the mock tenant, so the package
    // carries the names and numbers a real one would.
    const items: any[] = [];
    for (const [i, req] of input.items.entries()) {
      const part: any = await MockOnshapePart.findOne({
        companyId: this.companyId,
        documentId: req.documentId,
        elementId: req.elementId,
        ...(req.partId ? { partId: req.partId } : {}),
      }).lean();

      items.push({
        id: `${rpid}-i${i}`,
        documentId: req.documentId,
        elementId: req.elementId,
        partId: req.partId ?? part?.partId ?? "",
        elementType: part?.elementType ?? "PARTSTUDIO",
        name: part?.elementName ?? "",
        partNumber: "",
        revisionId: req.revisionId ?? "",
        revision: "",
        versionId: "",
      });
    }

    // Onshape adds every active drawing to a package itself — the changelog
    // deprecated the flag that used to request it. Mocking that is what lets
    // the drawing side of the release be exercised without a tenant.
    const partElementIds = new Set(items.map((i) => i.elementId));
    const drawings: any[] = await MockOnshapeDrawing.find({ companyId: this.companyId }).lean();
    for (const [j, dwg] of drawings.entries()) {
      const draws = (dwg.partIds ?? []).some((pid: string) =>
        items.some((i) => i.partId === pid)
      );
      if (!draws || partElementIds.has(dwg.elementId)) continue;
      items.push({
        id: `${rpid}-d${j}`,
        documentId: dwg.documentId,
        elementId: dwg.elementId,
        partId: "",
        elementType: "DRAWING",
        name: dwg.elementName ?? "",
        partNumber: "",
        revisionId: "",
        revision: "",
        versionId: "",
      });
    }

    const created = await MockReleasePackage.create({
      companyId: this.companyId,
      rpid,
      wfid,
      /*
       * Generated here, as Onshape generates it.
       *
       * It is a read-only field on the real API — present on the response, not
       * the request — so a caller cannot choose it. The simulator minting its
       * own is what makes that true locally too; it previously echoed back
       * whatever the caller passed, which is precisely why the impossible
       * round trip went unnoticed.
       */
      changeOrderId: `CO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      state: "PENDING",
      items,
      properties: {},
      createdByEmail: this.actingUser?.email ?? "designer@mockenterprise.test",
    });

    return this.toPackage(created.toObject());
  }

  async getWorkflowObjectState(objectId: string): Promise<string> {
    await connectDb();
    const d: any = await MockReleasePackage.findOne({
      companyId: this.companyId,
      rpid: objectId,
    }).lean();
    return d ? String(d.state) : "";
  }

  /* ======================================================================== */
  /* Drawings                                                                  */
  /* ======================================================================== */

  async listElements(coords: {
    documentId: string;
    workspaceId?: string | null;
    versionId?: string | null;
  }): Promise<ElementInfo[]> {
    await connectDb();
    const out: ElementInfo[] = [];

    const parts: any[] = await MockOnshapePart.find({
      companyId: this.companyId,
      documentId: coords.documentId,
    }).lean();
    const seen = new Set<string>();
    for (const p of parts) {
      if (seen.has(p.elementId)) continue;
      seen.add(p.elementId);
      out.push({
        id: p.elementId,
        name: p.elementName ?? "",
        elementType: String(p.elementType ?? "PARTSTUDIO").toUpperCase(),
      });
    }

    const drawings: any[] = await MockOnshapeDrawing.find({
      companyId: this.companyId,
      documentId: coords.documentId,
    }).lean();
    for (const d of drawings) {
      out.push({ id: d.elementId, name: d.elementName ?? "", elementType: "DRAWING" });
    }

    return out;
  }

  /**
   * A stand-in drawing PDF.
   *
   * Generated rather than stubbed with a fixed file, and it renders the fields
   * that are the whole point of exporting twice: the revision and the version
   * it came from. A demo showing the as-submitted and as-released sheets side
   * by side is only convincing if the two actually differ, so the sheet says
   * which one it is.
   */
  async exportDrawingPdf(coords: DrawingCoords): Promise<FileExport> {
    const started = Date.now();
    await connectDb();

    const dwg: any = await MockOnshapeDrawing.findOne({
      companyId: this.companyId,
      documentId: coords.documentId,
      elementId: coords.elementId,
    }).lean();

    // A version was asked for, so report the revision that version carries.
    const rev = coords.versionId
      ? (dwg?.revisions ?? []).find((r: any) => r.versionId === coords.versionId)?.revision ?? ""
      : "";

    const lines = [
      dwg?.elementName || "Drawing",
      dwg?.documentName ? `Document: ${dwg.documentName}` : "",
      rev ? `Revision: ${rev}` : "Revision: (none - not yet released)",
      rev ? "RELEASED" : "PRELIMINARY - NOT FOR MANUFACTURE",
      coords.versionId ? `Version: ${coords.versionId}` : "Source: workspace",
      `Exported: ${new Date().toISOString()}`,
    ].filter(Boolean);

    return {
      data: buildMockPdf(lines),
      contentType: "application/pdf",
      via: "translation",
      translationId: `mock-tx-${Date.now().toString(36)}`,
      elapsedMs: Date.now() - started,
    };
  }
}


/* -------------------------------------------------------------------------- */

/**
 * Build a valid one-page PDF containing the given lines.
 *
 * Hand-assembled because the alternative is a PDF library in the dependency
 * list purely for mock mode. It is a real PDF — cross-reference table, correct
 * byte offsets — so the demo's drawing viewer, download and page count all
 * behave as they would with a sheet from Onshape. A placeholder that only
 * looked like a PDF would fail in the one place it matters: on screen.
 */
function buildMockPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const text = lines
    .map((l, i) => `BT /F1 ${i === 0 ? 18 : 11} Tf 60 ${700 - i * 26} Td (${esc(l)}) Tj ET`)
    .join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "";
  const offsets: number[] = [];
  const header = "%PDF-1.4\n";
  let pos = header.length;

  objects.forEach((o, i) => {
    const chunk = `${i + 1} 0 obj\n${o}\nendobj\n`;
    offsets.push(pos);
    body += chunk;
    pos += Buffer.byteLength(chunk, "latin1");
  });

  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, "latin1");
}
