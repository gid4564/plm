import type {
  OnshapeClient, PartCoords, PartMetadata, PropertyDef, OnshapeUser, WebhookRegistration, ElementInfo, Thumbnail, WebhookSummary, ElementPart, DocumentInfo, AssemblyCoords,
} from "./types";
import type {
  PartExport, ReleasePackage, ReleasePackageItem, ReleaseWorkflow, WorkflowAction,
  CreateReleasePackageInput, DrawingCoords, FileExport,
} from "./types";
import { parseBom, type BomTable } from "./bom";
import { parseMassProperties, type MassProperties } from "./mass-properties";
import type { ExportFormat } from "./export-formats";
import { mapStandardProperties, resolveEnumLabel, toDefinitions, toDisplayString, type RawProperty } from "./standard-properties";

/**
 * Live Onshape REST client.
 *
 * Endpoint shapes are taken from Onshape's public API docs. The one endpoint
 * that is not clearly documented is enumerating enterprise custom-property
 * definitions — ONSHAPE_METADATA_SCHEMA_PATH exists so you can point this at
 * whatever your tenant actually serves without touching code. Verify it in the
 * Onshape API Explorer before trusting discovery in production.
 */
/**
 * Read a write permission off a document response.
 *
 * Onshape reports this in more than one way depending on endpoint and account
 * type, so several shapes are accepted. Returning null — "it did not say" — is
 * deliberate: guessing "no" would block legitimate writes, and guessing "yes"
 * is what the caller already does anyway.
 */
function readWritePermission(doc: Record<string, any> | null | undefined): boolean | null {
  if (!doc) return null;

  const set = doc.permissionSet ?? doc.permissions;
  if (Array.isArray(set) && set.length) {
    const upper = set.map((x) => String(x).toUpperCase());
    return upper.includes("WRITE") || upper.includes("OWNER") || upper.includes("FULL");
  }

  const one = doc.permission ?? doc.accessLevel;
  if (typeof one === "string" && one.trim()) {
    const v = one.toUpperCase();
    if (["READ", "ANONYMOUS_ACCESS", "NONE"].includes(v)) return false;
    if (["WRITE", "OWNER", "FULL", "DELETE", "RESHARE"].includes(v)) return true;
  }

  return null;
}

/**
 * How long to wait for a translation before giving up.
 *
 * Generous, because a first request on a cold part studio is slower than the
 * rest, but bounded — a request that hangs indefinitely is worse than one that
 * says so and lets the user try again.
 */
export const TRANSLATION_TIMEOUT_MS = 90_000;

/**
 * How long to wait before each check on a translation job.
 *
 * Written out rather than computed, because the number of calls this costs
 * matters more than the elegance of the curve. Onshape's rate limit is shared
 * with everyone else on the tenant, and a job that is stuck is exactly when
 * polling hardest is least welcome.
 *
 * A geometric backoff capped at two seconds used to live here and spent up to
 * 48 calls on a single export. These six cover the same ninety seconds, and
 * because most single-part translations land inside the first few seconds, the
 * usual cost is one check — two for a slower one.
 *
 * The trade is up to three seconds of extra wait on a translation that would
 * have finished almost immediately. Worth it: nobody watching a progress
 * spinner can tell three seconds from one, and the calls are real.
 */
export const TRANSLATION_POLL_SCHEDULE_MS = [3_000, 5_000, 10_000, 20_000, 25_000, 25_000];

export class LiveOnshapeClient implements OnshapeClient {
  readonly mode = "live" as const;

  constructor(
    private accessToken: string,
    private apiUrl = process.env.ONSHAPE_API_URL || "https://cad.onshape.com/api",
    /**
     * Obtain a fresh access token, when Onshape rejects the current one.
     *
     * Supplied by the factory, which owns the stored credentials. Without it a
     * token invalidated out of band — the user re-authorised the app, an admin
     * revoked it, a refresh elsewhere rotated it — kills every call until
     * somebody notices and reconnects by hand. On the webhook path nobody is
     * watching, so syncing simply stops.
     *
     * Returns null when it cannot be refreshed, which is a real answer: the
     * connection needs a person, and retrying forever would only bury that.
     */
    private onUnauthorized?: () => Promise<string | null>
  ) {}

  private headersFor(init: RequestInit): HeadersInit {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    };
  }

  private async req<T>(path: string, init: RequestInit = {}, isRetry = false): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: this.headersFor(init),
      cache: "no-store",
    });

    /*
     * One retry on 401, and only one.
     *
     * The proactive refresh in the factory covers a token that is *about* to
     * expire, which is not the same thing as one Onshape has decided to reject.
     * A single reactive attempt turns that from a permanent failure into a
     * round trip; retrying more than once would just hammer an endpoint that
     * has already given its answer.
     */
    if (res.status === 401 && !isRetry && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.accessToken = fresh;
        return this.req<T>(path, init, true);
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Onshape ${init.method || "GET"} ${path} -> ${res.status}: ${body.slice(0, 500)}` +
        (res.status === 401
          ? ` — the stored Onshape token was rejected and could not be refreshed. ` +
            `Press Connect Onshape in Settings to re-authorise the account this ` +
            `enterprise acts as.`
          : "")
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getAuthenticatedUser(): Promise<OnshapeUser> {
    const u = await this.req<Record<string, any>>("/users/sessioninfo");
    return {
      id: String(u.id ?? ""),
      email: String(u.email ?? ""),
      name: String(u.name ?? u.email ?? ""),
      companyId: u.company?.id ? String(u.company.id) : null,
      companyName: u.company?.name ? String(u.company.name) : null,
      companyDomain: u.company?.enterpriseBaseUrl ? String(u.company.enterpriseBaseUrl) : null,
    };
  }

  async listPropertyDefinitions(companyId: string): Promise<PropertyDef[]> {
    const path = process.env.ONSHAPE_METADATA_SCHEMA_PATH || "/metadataschema";
    // ownerType 1 = company/enterprise.
    const data = await this.req<Record<string, any>>(
      `${path}?ownerId=${encodeURIComponent(companyId)}&ownerType=1&active=true`
    );

    const rows: any[] = data.items ?? data.properties ?? (Array.isArray(data) ? data : []);
    return rows.map((p) => ({
      propertyId: String(p.id ?? p.propertyId),
      name: String(p.name ?? ""),
      valueType: String(p.valueType ?? p.type ?? "STRING"),
      enumValues: Array.isArray(p.enumValues)
        ? p.enumValues.map((e: any) => String(e.value ?? e))
        : undefined,
      builtIn: Boolean(p.builtIn ?? p.isBuiltIn ?? false),
    }));
  }

  /** Onshape addresses parts as /d/{did}/{w|v}/{wvid}/e/{eid}/p/{partId}. */
  private metadataPath(c: PartCoords): string {
    const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;

    // "default", empty, or an unsubstituted {$configuration} placeholder all mean
    // "no configuration". Sending the placeholder through earns a 400 from
    // Onshape, so it is filtered here as well as at the panel boundary.
    const isPlaceholder = /^\{\$.*\}$/.test(c.configuration ?? "");
    const cfg = c.configuration && c.configuration !== "default" && !isPlaceholder
      ? `?configuration=${encodeURIComponent(c.configuration)}`
      : "";
    return `/metadata/d/${c.documentId}/${wv}/e/${c.elementId}/p/${encodeURIComponent(c.partId)}${cfg}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Element and document lookups                                            */
  /*                                                                         */
  /* Both the display names and the element type come from the same two       */
  /* endpoints, so they share one cache. Fetching them separately meant every  */
  /* sync hit the elements endpoint twice for the same answer.                */
  /*                                                                         */
  /* Cached per process for five minutes: names and tab types change rarely,   */
  /* and syncing a whole Part Studio would otherwise repeat the same lookups   */
  /* once per part.                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Documents Onshape has refused a write to during this process.
   *
   * A standard-content part is used many times over in one assembly. Without
   * this, every instance re-learns the same 403 — and the permission report is
   * not always present, so the refusal itself is the most reliable evidence
   * there is.
   */
  private static readOnlyDocuments = new Set<string>();

  private static elementCache = new Map<string, { at: number; value: ElementInfo | null }>();
  private static documentCache = new Map<string, { at: number; value: DocumentInfo }>();
  private static readonly CACHE_TTL = 5 * 60_000;

  private async fetchElement(c: PartCoords): Promise<ElementInfo | null> {
    const key = `${c.documentId}:${c.workspaceId ?? c.versionId}:${c.elementId}`;
    const hit = LiveOnshapeClient.elementCache.get(key);
    if (hit && Date.now() - hit.at < LiveOnshapeClient.CACHE_TTL) return hit.value;

    let value: ElementInfo | null = null;
    try {
      const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;
      const els = await this.req<any[]>(
        `/documents/d/${c.documentId}/${wv}/elements?elementId=${encodeURIComponent(c.elementId)}`
      );
      const el = Array.isArray(els) ? els.find((e) => String(e.id) === c.elementId) ?? els[0] : null;
      if (el) {
        value = {
          id: String(el.id),
          name: String(el.name ?? ""),
          elementType: String(el.elementType ?? el.type ?? "").toUpperCase(),
        };
      }
    } catch {
      // Leave value null; callers treat that as "unknown" rather than failing.
    }

    LiveOnshapeClient.elementCache.set(key, { at: Date.now(), value });
    return value;
  }

  async getDocumentInfo(documentId: string): Promise<DocumentInfo> {
    const hit = LiveOnshapeClient.documentCache.get(documentId);
    if (hit && Date.now() - hit.at < LiveOnshapeClient.CACHE_TTL) return hit.value;

    let value: DocumentInfo = { name: "", defaultWorkspaceId: null, accessError: null, canWrite: null };
    try {
      const doc = await this.req<Record<string, any>>(`/documents/${documentId}`);
      value = {
        name: String(doc?.name ?? ""),
        defaultWorkspaceId: doc?.defaultWorkspace?.id ? String(doc.defaultWorkspace.id) : null,
        accessError: null,
        canWrite: readWritePermission(doc),
      };
    } catch (err: any) {
      // Keep the reason. A linked document the caller cannot open fails here,
      // and callers need to tell that apart from a document with no workspace.
      value.accessError = String(err?.message ?? err);
    }

    // Second chance for a document that was readable but reported no default
    // workspace. Costs a call only on that path, and the result is cached.
    if (!value.defaultWorkspaceId && !value.accessError) {
      try {
        const rows = await this.req<any[]>(`/documents/d/${documentId}/workspaces`);
        const list = Array.isArray(rows) ? rows : [];
        const main = list.find((w) => String(w?.name ?? "").toLowerCase() === "main") ?? list[0];
        if (main?.id) value.defaultWorkspaceId = String(main.id);
      } catch (err: any) {
        value.accessError = String(err?.message ?? err);
      }
    }

    // A refusal already observed outranks anything the permission field claims.
    if (LiveOnshapeClient.readOnlyDocuments.has(documentId)) value.canWrite = false;

    LiveOnshapeClient.documentCache.set(documentId, { at: Date.now(), value });
    return value;
  }

  private async fetchDocumentName(documentId: string): Promise<string> {
    return (await this.getDocumentInfo(documentId)).name;
  }

  /**
   * Parts in an element, with their part numbers.
   *
   * Needed because a revision event names the part by number, not id — the id
   * is PLM's identity key, so it has to be looked up before anything can be
   * created.
   */
  async listElementParts(c: PartCoords): Promise<ElementPart[]> {
    try {
      const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;
      const rows = await this.req<any[]>(`/parts/d/${c.documentId}/${wv}/e/${c.elementId}`);
      return (Array.isArray(rows) ? rows : []).map((p) => ({
        partId: String(p.partId ?? p.id ?? ""),
        partNumber: String(p.partNumber ?? ""),
        name: String(p.name ?? ""),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Exploded bill of materials for an assembly.
   *
   * indented=false with multiLevel=true is the manufacturing view: one row per
   * distinct part with the total quantity the whole assembly consumes, rather
   * than a tree that has to be summed by hand.
   *
   * generateIfAbsent matters for the demo path — an assembly nobody has opened
   * a BOM table on has no stored BOM, and without this the call returns nothing
   * for a perfectly valid assembly.
   *
   * The base path is overridable for the same reason as the metadata schema
   * endpoint: this is one of the API surfaces whose published shape has not
   * matched every tenant.
   */
  async getAssemblyBom(c: AssemblyCoords, opts: { multiLevel?: boolean } = {}): Promise<BomTable> {
    const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;
    const base = process.env.ONSHAPE_BOM_PATH || "/assemblies";

    const q = new URLSearchParams({
      indented: "false",
      multiLevel: String(opts.multiLevel !== false),
      generateIfAbsent: "true",
      includeItemMicroversions: "false",
      thumbnail: "false",
    });
    if (c.configuration && c.configuration !== "default" && !/^\{\$.*\}$/.test(c.configuration)) {
      q.set("configuration", c.configuration);
    }

    const payload = await this.req<Record<string, any>>(
      `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/bom?${q}`
    );

    const table = parseBom(payload);

    // A valid assembly that parses to nothing means the payload is a shape this
    // parser has not met. Say so in the log with the keys that were actually
    // returned — that is the difference between a five-minute fix and a guess.
    if (table.lines.length === 0) {
      console.warn(
        `[PLM] BOM parsed to 0 rows (shape=${table.shape}) for element ${c.elementId}. ` +
        `Top-level keys: ${Object.keys(payload ?? {}).join(", ") || "none"}`
      );
    }

    return table;
  }

  async getElementInfo(c: PartCoords): Promise<ElementInfo | null> {
    return this.fetchElement(c);
  }

  /**
   * Render the part as an image.
   *
   * Uses the shaded-views endpoint rather than the thumbnail endpoint: it is
   * part-specific, honours configurations, and lets us pick a size. pixelSize=0
   * asks Onshape to fit the model to the frame.
   *
   * Onshape returns base64 strings in JSON rather than image bytes, so the
   * result is decoded here and the caller only ever handles a Buffer.
   *
   * Returns null rather than throwing — a missing picture must never break a
   * page that is otherwise fine.
   */
  /**
   * A rendering of one part, or of a whole assembly.
   *
   * The two need different endpoints, and this is the reason an assembly synced
   * without a picture: the part endpoint addresses its subject as
   * `.../e/{eid}/partid/{partId}/shadedviews`, and an assembly has no partId —
   * so the URL came out as `partid//shadedviews`, which Onshape rejects. MOS
   * never hit this because it refused to track assemblies at all.
   *
   * An assembly is rendered from the assembly endpoint instead, which takes the
   * element alone. Both paths are env-overridable, and both degrade to null
   * rather than throwing: a missing picture is a cosmetic problem, and the
   * caller shows a placeholder.
   */
  async getPartThumbnail(c: PartCoords, size = 300): Promise<Thumbnail | null> {
    const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;
    const cfg = c.configuration && c.configuration !== "default" && !/^\{\$.*\}$/.test(c.configuration)
      ? `&configuration=${encodeURIComponent(c.configuration)}`
      : "";

    // An isometric-ish view, so a rendering reads as a solid rather than a
    // silhouette. Shared by both endpoints.
    const view =
      `outputWidth=${size}&outputHeight=${size}&pixelSize=0` +
      `&viewMatrix=0.612,0.612,0,0,-0.354,0.354,0.866,0,0.707,-0.707,0.5,0`;

    const partId = String(c.partId ?? "").trim();
    const path = partId
      ? `${process.env.ONSHAPE_SHADEDVIEWS_PATH || "/parts"}` +
        `/d/${c.documentId}/${wv}/e/${c.elementId}/partid/${encodeURIComponent(partId)}` +
        `/shadedviews?${view}${cfg}`
      : `${process.env.ONSHAPE_ASSEMBLY_SHADEDVIEWS_PATH || "/assemblies"}` +
        `/d/${c.documentId}/${wv}/e/${c.elementId}` +
        `/shadedviews?${view}${cfg}`;

    try {
      const res = await this.req<Record<string, any>>(path);
      const b64 = Array.isArray(res?.images) ? res.images[0] : res?.images;
      if (!b64 || typeof b64 !== "string") return null;
      return { contentType: "image/png", data: Buffer.from(b64, "base64") };
    } catch (err: any) {
      // Logged rather than silent: a whole catalogue with no pictures is worth
      // being able to explain, and the reason is only ever in the response.
      console.warn(
        `[PLM] no thumbnail for ${partId ? `part ${partId}` : `assembly ${c.elementId}`}: ` +
        `${String(err?.message ?? err).slice(0, 200)}`
      );
      return null;
    }
  }

  /** Fetch bytes rather than JSON. Onshape redirects downloads, so follow them. */
  private async reqBinary(path: string, isRetry = false): Promise<{ data: Buffer; contentType: string }> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "*/*" },
      cache: "no-store",
    });

    // Same single reactive refresh as req(); binary downloads are how
    // thumbnails and exports leave, and they fail the same way.
    if (res.status === 401 && !isRetry && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.accessToken = fresh;
        return this.reqBinary(path, true);
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Onshape GET ${path} -> ${res.status}: ${body.slice(0, 300)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
  }

  /**
   * Export one part.
   *
   * Two routes, chosen by the format. A direct download is a single GET. A
   * translation is a job: submit it, poll until Onshape says it is done, then
   * collect the file it produced. The polling is the interesting part — it is
   * the only place in this integration that is not request/response — so the
   * job id and elapsed time come back with the bytes, and land in the audit log.
   */
  /**
   * Mass properties for one part.
   *
   * Base path is overridable for the same reason as the others here: this is
   * another endpoint whose published shape has not matched every tenant. Read
   * against the same coordinates the caller resolved for everything else —
   * the workspace where there is one, the pinned version only for a part with
   * no other home.
   */
  async getMassProperties(c: PartCoords): Promise<MassProperties> {
    const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;
    const base = process.env.ONSHAPE_MASSPROPERTIES_PATH || "/partstudios";
    const cfg =
      c.configuration && c.configuration !== "default" && !/^\{\$.*\}$/.test(c.configuration)
        ? `&configuration=${encodeURIComponent(c.configuration)}`
        : "";

    const payload = await this.req<Record<string, any>>(
      `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/massproperties?partId=${encodeURIComponent(c.partId)}${cfg}`
    );

    const result = parseMassProperties(payload, c.partId);

    if (result.shape !== "bodies") {
      console.warn(
        `[PLM] mass properties for part ${c.partId} did not parse (shape=${result.shape}). ` +
        `Top-level keys: ${Object.keys(payload ?? {}).join(", ") || "none"}`
      );
    }

    return result;
  }

  async exportPart(c: PartCoords, format: ExportFormat): Promise<PartExport> {
    const started = Date.now();
    const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;
    const cfg =
      c.configuration && c.configuration !== "default" && !/^\{\$.*\}$/.test(c.configuration)
        ? `&configuration=${encodeURIComponent(c.configuration)}`
        : "";

    if (format.strategy === "direct" && format.directPath) {
      const base = process.env.ONSHAPE_PARTS_PATH || "/parts";
      const path =
        `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/partid/${encodeURIComponent(c.partId)}` +
        `/${format.directPath}?units=millimeter${cfg}`;
      const { data, contentType } = await this.reqBinary(path);
      return { data, contentType, via: "direct", elapsedMs: Date.now() - started };
    }

    return this.exportViaTranslation(c, format, wv, cfg, started);
  }

  /** Submit a translation, wait for it, and fetch the result. */
  private async exportViaTranslation(
    c: PartCoords,
    format: ExportFormat,
    wv: string,
    cfg: string,
    started: number
  ): Promise<PartExport> {
    const base = process.env.ONSHAPE_TRANSLATIONS_PATH || "/partstudios";

    const submitted = await this.req<Record<string, any>>(
      `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/translations`,
      {
        method: "POST",
        body: JSON.stringify({
          formatName: format.formatName,
          // Just this part, not everything in the Part Studio.
          partIds: c.partId,
          // Hand the file back rather than dropping it into the user's document.
          storeInDocument: false,
          flattenAssemblies: false,
          ...(c.configuration && c.configuration !== "default" && !/^\{\$.*\}$/.test(c.configuration)
            ? { configuration: c.configuration }
            : {}),
        }),
      }
    );

    return this.awaitTranslation(submitted, c.documentId, format.label, started);
  }

  /**
   * Wait for a submitted translation job and fetch its result.
   *
   * Shared by part exports and drawing PDFs because the contract is identical —
   * submit, poll until Onshape says DONE, download the external data it names.
   * Extracted rather than duplicated: the polling schedule below is a tuned
   * compromise about call volume against a shared rate limit, and two copies of
   * it would inevitably drift apart.
   */
  private async awaitTranslation(
    submitted: Record<string, any>,
    documentId: string,
    label: string,
    started: number
  ): Promise<FileExport> {
    const translationId = String(submitted?.id ?? "");
    if (!translationId) {
      throw new Error(
        `Onshape accepted the ${label} request but returned no translation id. ` +
        `Response keys: ${Object.keys(submitted ?? {}).join(", ") || "none"}`
      );
    }

    // Poll. Onshape gives no completion callback, so waiting is the contract.
    // Backs off gently: most single-part translations finish within seconds, and
    // a tight loop on a shared rate limit helps nobody.
    const deadline = started + TRANSLATION_TIMEOUT_MS;
    // The submit response often already says DONE for a small part, in which
    // case this costs no checks at all.
    let state = String(submitted?.requestState ?? "ACTIVE").toUpperCase();
    let job: Record<string, any> = submitted;
    let checks = 0;

    while (state === "ACTIVE" || state === "PENDING") {
      if (Date.now() > deadline) {
        throw new Error(
          `Onshape is still translating this part to ${label} after ` +
          `${Math.round(TRANSLATION_TIMEOUT_MS / 1000)}s (job ${translationId}, ` +
          `${checks} check${checks === 1 ? "" : "s"}). Large or complex parts can ` +
          `take longer — try again in a moment.`
        );
      }

      // Never start a wait that would run past the deadline: with gaps this
      // long, an unclamped one would overshoot the stated timeout by 25s.
      const scheduled =
        TRANSLATION_POLL_SCHEDULE_MS[Math.min(checks, TRANSLATION_POLL_SCHEDULE_MS.length - 1)];
      const waitMs = Math.min(scheduled, deadline - Date.now());
      await new Promise((r) => setTimeout(r, waitMs));

      job = await this.req<Record<string, any>>(`/translations/${translationId}`);
      state = String(job?.requestState ?? "").toUpperCase();
      checks++;
    }

    if (state !== "DONE") {
      throw new Error(
        `Onshape could not produce ${label}: ${job?.failureReason || state || "unknown failure"} ` +
        `(job ${translationId}).`
      );
    }

    const externalId = String(
      job?.resultExternalDataIds?.[0] ?? job?.resultDocumentId ?? ""
    );
    if (!externalId) {
      throw new Error(
        `Translation ${translationId} finished but named no result file. ` +
        `Response keys: ${Object.keys(job ?? {}).join(", ")}`
      );
    }

    const { data, contentType } = await this.reqBinary(
      `/documents/d/${documentId}/externaldata/${encodeURIComponent(externalId)}`
    );

    return { data, contentType, via: "translation", translationId, elapsedMs: Date.now() - started };
  }

  async getPartMetadata(coords: PartCoords): Promise<PartMetadata> {
    const data = await this.req<Record<string, any>>(this.metadataPath(coords));

    // Onshape returns a flat list of {propertyId, name, value}. Keep it intact —
    // the annotated list is what makes an unexpected property name diagnosable
    // instead of just producing a blank field.
    const props: RawProperty[] = ((data.properties ?? []) as any[]).map((p) => {
      const enumValues = Array.isArray(p.enumValues)
        ? p.enumValues.map((e: any) =>
            e && typeof e === "object" ? { value: e.value, label: e.label } : { value: e }
          )
        : undefined;
      return {
        propertyId: String(p.propertyId ?? ""),
        name: String(p.name ?? ""),
        value: p.value,
        valueType: String(p.valueType ?? p.type ?? ""),
        enumValues,
      };
    });

    const raw: Record<string, unknown> = {};
    for (const p of props) if (p.propertyId) raw[p.propertyId] = p.value;

    const std = mapStandardProperties(props);

    // Show labels in the diagnostic list as well; a bare code there is just as
    // unhelpful as one in a field. The original stays in `raw`.
    const display: (RawProperty & { raw?: unknown; options?: unknown })[] = props.map((p) => {
      const shown = p.enumValues?.length
        ? resolveEnumLabel(p.value, p.enumValues)
        : toDisplayString(p.value);
      // Keep the code only when it is not already the thing being shown.
      const raw = String(p.value ?? "") !== shown ? p.value : undefined;
      return { ...p, value: shown, raw, options: p.enumValues?.length ? p.enumValues : undefined };
    });

    // The metadata payload rarely carries these; fall back to explicit lookups.
    let documentName = String(data.documentName ?? "");
    let elementName = String(data.elementName ?? "");
    if (!documentName || !elementName) {
      // Both usually served from cache — getElementInfo has normally run first.
      const [docName, el] = await Promise.all([
        documentName ? Promise.resolve(documentName) : this.fetchDocumentName(coords.documentId),
        elementName ? Promise.resolve(null) : this.fetchElement(coords),
      ]);
      documentName = documentName || docName;
      elementName = elementName || el?.name || "";
    }

    return {
      coords,
      documentName,
      elementName,
      partName: std.partName || String(data.partName ?? ""),
      partNumber: std.partNumber,
      revision: std.revision,
      description: std.description,
      material: std.material,
      state: std.state,
      vendor: std.vendor,
      project: std.project,
      raw,
      definitions: toDefinitions(props),
      properties: display,
    };
  }

  async updatePartProperties(coords: PartCoords, values: Record<string, unknown>): Promise<void> {
    const href = `${this.apiUrl}${this.metadataPath(coords)}`;
    try {
      await this.req(this.metadataPath(coords), {
        method: "POST",
        body: JSON.stringify({
          items: [
            {
              href,
              properties: Object.entries(values).map(([propertyId, value]) => ({ propertyId, value })),
            },
          ],
        }),
      });
    } catch (err: any) {
      // Note a document that refuses writes, so the next part from the same
      // library is not another wasted call against a shared rate limit.
      if (/\b40[13]\b/.test(String(err?.message ?? ""))) {
        LiveOnshapeClient.readOnlyDocuments.add(coords.documentId);
        LiveOnshapeClient.documentCache.delete(coords.documentId);
      }
      throw err;
    }
  }

  async registerWebhook(companyId: string, callbackUrl: string, events: string[]): Promise<WebhookRegistration> {
    const res = await this.req<Record<string, any>>("/webhooks", {
      method: "POST",
      body: JSON.stringify({
        companyId,
        events,
        url: callbackUrl,
        options: { collapseEvents: false },
        // Persist across quiet periods instead of being auto-reaped.
        isTransient: false,
      }),
    });
    // Report what Onshape actually accepted. It can register a subset without
    // failing, and a silently dropped event looks identical to one that never
    // fires.
    return {
      id: String(res.id),
      events: Array.isArray(res.events) ? res.events.map(String) : [],
    };
  }

  /**
   * Every webhook Onshape holds for this company.
   *
   * Needed because re-registering used to leave the previous subscription live.
   * Those orphans keep delivering events PLM can no longer attribute, and
   * there is no way to notice them without asking Onshape what exists.
   */
  async listWebhooks(companyId: string): Promise<WebhookSummary[]> {
    try {
      const res = await this.req<Record<string, any>>(
        `/webhooks?company=${encodeURIComponent(companyId)}`
      );
      const rows: any[] = res?.items ?? (Array.isArray(res) ? res : []);
      return rows.map((w) => ({
        id: String(w.id ?? ""),
        url: String(w.url ?? ""),
        events: Array.isArray(w.events) ? w.events.map(String) : [],
      }));
    } catch {
      return [];
    }
  }

  async unregisterWebhook(webhookId: string): Promise<void> {
    await this.req(`/webhooks/${webhookId}`, { method: "DELETE" });
  }

  /* ======================================================================== */
  /* Release management                                                        */
  /*                                                                          */
  /* This is the least well documented corner of Onshape's API — its own       */
  /* forum answer on the subject says so. Every path here is either confirmed  */
  /* from the changelog or marked below as needing verification against a live */
  /* tenant; see docs/ONSHAPE-INTEGRATION-SPEC.md for what is settled and what */
  /* is not. Responses are parsed defensively and kept whole in `raw`, because */
  /* a field this code did not know to read is otherwise lost for good.        */
  /* ======================================================================== */

  /**
   * The enterprise's release workflow.
   *
   * Tries the company policies endpoint first, which is where the forum answer
   * says the workflow id lives, then falls back to the active-workflow list.
   * Both are tried because neither is documented well enough to rely on alone,
   * and a wrong guess here disables the whole release takeover.
   */
  async getReleaseWorkflow(companyId: string): Promise<ReleaseWorkflow | null> {
    const candidates: (() => Promise<Record<string, any>>)[] = [
      () => this.req(`/companies/${encodeURIComponent(companyId)}/policies`),
      () => this.req(`/workflow/active`),
    ];

    for (const fetchOne of candidates) {
      let data: Record<string, any>;
      try {
        data = await fetchOne();
      } catch {
        // A 404 here means this tenant does not serve that shape. Try the next.
        continue;
      }

      // The id turns up under several names across the two endpoints. Look for
      // any of them rather than assuming one, and take the first that is set.
      const wf =
        data?.releaseWorkflow ??
        data?.workflow ??
        (Array.isArray(data?.workflows) ? data.workflows.find((w: any) => w?.active) ?? data.workflows[0] : null) ??
        (Array.isArray(data?.items) ? data.items[0] : null);

      const id = String(wf?.id ?? wf?.workflowId ?? data?.releaseWorkflowId ?? "");
      if (id) return { id, name: String(wf?.name ?? wf?.label ?? "Release") };
    }

    return null;
  }

  /**
   * Normalise a release-package response.
   *
   * Field names are read leniently for the reason given above the block: the
   * documented surface is thin, and several of these were established from
   * changelog entries rather than a schema. Anything unrecognised survives in
   * `raw`.
   */
  private toReleasePackage(d: Record<string, any>): ReleasePackage {
    const rawItems: any[] = Array.isArray(d?.items) ? d.items : [];

    const items: ReleasePackageItem[] = rawItems.map((it: any) => ({
      id: String(it?.id ?? ""),
      documentId: String(it?.documentId ?? it?.document?.id ?? ""),
      elementId: String(it?.elementId ?? it?.element?.id ?? ""),
      partId: String(it?.partId ?? it?.partIdentity ?? ""),
      elementType: String(it?.elementType ?? it?.type ?? "").toUpperCase(),
      name: String(it?.name ?? it?.elementName ?? ""),
      partNumber: String(it?.partNumber ?? ""),
      revisionId: String(it?.revisionId ?? ""),
      revision: String(it?.revision ?? ""),
      versionId: String(it?.versionId ?? it?.version?.id ?? ""),
    }));

    const rawActions: any[] = Array.isArray(d?.workflowActions)
      ? d.workflowActions
      : Array.isArray(d?.actions)
        ? d.actions
        : Array.isArray(d?.availableActions)
          ? d.availableActions
          : [];

    const availableActions: WorkflowAction[] = rawActions.map((a: any) => {
      // An action may arrive as a bare string on some shapes, in which case the
      // string is both its id and its type.
      if (typeof a === "string") return { id: a, label: a, type: a.toUpperCase() };
      return {
        id: String(a?.id ?? a?.actionId ?? a?.action ?? a?.name ?? ""),
        label: String(a?.label ?? a?.name ?? a?.action ?? ""),
        type: String(a?.type ?? a?.actionType ?? a?.action ?? "").toUpperCase(),
      };
    }).filter((a) => a.id);

    return {
      id: String(d?.id ?? d?.rpid ?? ""),
      workflowId: String(d?.workflowId ?? d?.wfid ?? ""),
      state: String(d?.state ?? d?.stateName ?? d?.workflowState ?? ""),
      changeOrderId: String(d?.changeOrderId ?? ""),
      items,
      properties: (d?.properties ?? {}) as Record<string, unknown>,
      availableActions,
      syncedWithPLM: Boolean(d?.syncedWithPLM),
      raw: d ?? {},
    };
  }

  async getReleasePackage(rpid: string): Promise<ReleasePackage> {
    const d = await this.req<Record<string, any>>(
      `/releasepackages/${encodeURIComponent(rpid)}`
    );
    return this.toReleasePackage(d);
  }

  /**
   * Transition a release package.
   *
   * The action id is the caller's, taken from the package's own
   * availableActions. This method deliberately does not choose it: which
   * transition means "approve" is a property of the tenant's workflow JSON, and
   * deciding that here would bake one enterprise's configuration into the
   * client.
   */
  async transitionReleasePackage(
    rpid: string,
    actionId: string,
    opts: { properties?: Record<string, unknown>; note?: string } = {}
  ): Promise<ReleasePackage> {
    const d = await this.req<Record<string, any>>(
      `/releasepackages/${encodeURIComponent(rpid)}`,
      {
        method: "POST",
        body: JSON.stringify({
          action: actionId,
          ...(opts.properties ? { properties: opts.properties } : {}),
          ...(opts.note ? { comment: opts.note } : {}),
        }),
      }
    );
    return this.toReleasePackage(d);
  }

  async createReleasePackage(
    wfid: string,
    input: CreateReleasePackageInput
  ): Promise<ReleasePackage> {
    const d = await this.req<Record<string, any>>(
      `/releasepackages/release/${encodeURIComponent(wfid)}`,
      {
        method: "POST",
        body: JSON.stringify({
          wfid,
          changeOrderId: input.changeOrderId,
          items: input.items.map((i) => ({
            documentId: i.documentId,
            elementId: i.elementId,
            ...(i.partId ? { partId: i.partId } : {}),
            ...(i.revisionId ? { revisionId: i.revisionId } : {}),
          })),
          ...(input.properties ? { properties: input.properties } : {}),
        }),
      }
    );
    return this.toReleasePackage(d);
  }

  async getWorkflowObjectState(objectId: string): Promise<string> {
    const d = await this.req<Record<string, any>>(
      `/workflow/obj/${encodeURIComponent(objectId)}`
    );
    return String(d?.state ?? d?.stateName ?? d?.workflowState ?? "");
  }

  /* ======================================================================== */
  /* Drawings                                                                  */
  /* ======================================================================== */

  async listElements(coords: {
    documentId: string;
    workspaceId?: string | null;
    versionId?: string | null;
  }): Promise<ElementInfo[]> {
    const wv = coords.versionId ? `v/${coords.versionId}` : `w/${coords.workspaceId}`;
    const rows = await this.req<Record<string, any>[]>(
      `/documents/d/${coords.documentId}/${wv}/elements`
    );
    return (rows ?? []).map((e) => ({
      id: String(e?.id ?? ""),
      name: String(e?.name ?? ""),
      elementType: String(e?.elementType ?? e?.type ?? "").toUpperCase(),
    }));
  }

  /**
   * Export a drawing to PDF.
   *
   * Which workspace or version is addressed is the whole point of this call
   * being made twice per release. Exported from the workspace, the sheet has no
   * revision, no watermark, and unfilled title-block fields; exported from the
   * version the release produced, it has all three. Same endpoint, same
   * parameters — only the coordinates differ.
   */
  async exportDrawingPdf(coords: DrawingCoords): Promise<FileExport> {
    const started = Date.now();
    const base = process.env.ONSHAPE_DRAWINGS_PATH || "/drawings";
    const wv = coords.versionId ? `v/${coords.versionId}` : `w/${coords.workspaceId}`;

    const submitted = await this.req<Record<string, any>>(
      `${base}/d/${coords.documentId}/${wv}/e/${coords.elementId}/translations`,
      {
        method: "POST",
        body: JSON.stringify({
          formatName: "PDF",
          // Hand the file back rather than dropping a blob into the user's
          // document — a released drawing does not need a copy of itself
          // deposited in the CAD data.
          storeInDocument: false,
        }),
      }
    );

    const out = await this.awaitTranslation(submitted, coords.documentId, "PDF", started);
    // Onshape does not always label the result; the format was ours to choose.
    return { ...out, contentType: out.contentType || "application/pdf" };
  }
}
