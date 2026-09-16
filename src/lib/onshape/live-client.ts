import type {
  OnshapeClient, PartCoords, PartMetadata, PropertyDef, OnshapeUser, WebhookRegistration, ElementInfo, Thumbnail, WebhookSummary, ElementPart, DocumentInfo, AssemblyCoords,
  OnshapeTask, OnshapeComment, CommentContext,
  FoundTask,} from "./types";
import type {
  PartExport, ReleasePackage, ReleasePackageItem, ReleaseWorkflow, WorkflowAction,
  CreateReleasePackageInput, DrawingCoords, FileExport,
} from "./types";
import { parseBom, type BomTable } from "./bom";
import { describeShape } from "./describe-payload";
import { classify } from "./element-type";
import { parseWorkflowSnapshot } from "./workflow-snapshot";
import { objectTypeCode, objectTypeName, resolveTaskCommentContext } from "./object-types";
import { parseMassProperties, type MassProperties } from "./mass-properties";
import type { ExportFormat } from "./export-formats";
import { looksCoded, mapStandardProperties, resolveEnumLabel, toDefinitions, toDisplayString, type RawProperty } from "./standard-properties";

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
 * The most tasks Onshape will return in one page.
 *
 * From its OpenAPI definition for `getActionItems` (`limit`: minimum 1,
 * maximum 100), and enforced server-side — a larger value is a 400, not a
 * silently clamped request.
 */
export const TASKS_PAGE_MAX = 100;

/**
 * How many pages of `POST /tasks/find` to follow.
 *
 * Bounded because that endpoint's paging is in the body and an Onshape that
 * ignored it would return page one for ever. 30 pages of 100 covers any demo
 * tenant many times over, and the loop also stops as soon as a page yields
 * nothing new — which is the guard that actually catches ignored paging.
 */
export const FIND_TASKS_MAX_PAGES = 30;

/**
 * Statuses that mean a proxy answered, not Onshape.
 *
 * 502/503/504 are produced in front of the API. Nothing about the request
 * caused them, and treating them as API errors sends people looking for a
 * fault in a perfectly good call.
 */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Waits before re-trying a gateway error, for a request safe to repeat.
 *
 * Short, because these clear in seconds, and few, because a gateway that is
 * still failing after three attempts is an outage rather than a blip.
 */
const GATEWAY_RETRY_MS = [400, 1200, 3000];

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

/**
 * A task's properties, from both places Onshape keeps them.
 *
 * `properties` holds the metadata schema's fields; `workflowInfo.properties`
 * holds the workflow's — including Comment and Assigned to, which exist
 * nowhere else. Merged by property id, with the workflow's last so it wins on
 * a clash: it is the set the task's own state declares editable.
 */
/**
 * The Comment property in a set of workflow properties, if there is one.
 *
 * Matched by name rather than by a hardcoded id: the id belongs to the
 * tenant's own published workflow, and another tenant's will differ. Required
 * to be editable, because a read-only property is not a place to write.
 *
 * Shared between tasks and release packages — both run the same
 * `BTWorkflowSnapshotInfo` workflow shape (confirmed for tasks; see
 * docs/ONSHAPE-INTEGRATION-SPEC.md T2), so a Comment property on either is
 * found the same way.
 */
export function findCommentProperty<
  P extends { propertyId: string; name: string; valueType: string; editable: boolean }
>(props: P[]): P | null {
  return (
    props.find((p) => p.editable && p.valueType === "STRING" && /^comment$/i.test(p.name)) ??
    props.find((p) => p.editable && p.valueType === "STRING" && /comment|note|remark/i.test(p.name)) ??
    null
  );
}

function mergeTaskProperties(d: any): any[] {
  const top = Array.isArray(d?.properties) ? d.properties : [];
  const wf = Array.isArray(d?.workflowInfo?.properties) ? d.workflowInfo.properties : [];
  const byId = new Map<string, any>();
  for (const pr of [...top, ...wf]) {
    const id = String(pr?.propertyId ?? "");
    if (id) byId.set(id, pr);
  }
  return [...byId.values()];
}

/** One comment, from Onshape's BTCommentInfo. */
function toComment(d: Record<string, any>): OnshapeComment {
  return {
    id: String(d?.id ?? ""),
    message: String(d?.message ?? ""),
    authorEmail: String(d?.user?.email ?? ""),
    authorName: String(d?.user?.name ?? ""),
    createdAt: String(d?.createdAt ?? ""),
    /*
     * Kept, not interpreted. The code that means "task" is undocumented, and
     * echoing back the one Onshape used is how a reply gets addressed without
     * anybody having to know it.
     */
    objectType: typeof d?.objectType === "number" ? d.objectType : null,
    objectId: String(d?.objectId ?? ""),
    /* The anchor, so a new comment can be placed the same way this one was. */
    documentId: String(d?.documentId ?? ""),
    workspaceId: String(d?.workspaceId ?? ""),
    versionId: String(d?.versionId ?? ""),
    elementId: String(d?.elementId ?? ""),
  };
}

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
    private onUnauthorized?: () => Promise<string | null>,
    /**
     * The enterprise this client reads on behalf of.
     *
     * Only used to look up the property schema, so that a coded value can be
     * named from the tenant's own definitions. Optional: without it, coded
     * values are shown as codes rather than guessed at.
     */
    private companyId?: string
  ) {}

  private headersFor(init: RequestInit): HeadersInit {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    };
  }

  private async req<T>(
    path: string,
    init: RequestInit = {},
    isRetry = false,
    gatewayAttempt = 0
  ): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: this.headersFor(init),
      cache: "no-store",
    });

    /*
     * A gateway error is not an answer, so it is retried.
     *
     * 502, 503 and 504 with an HTML body come from a proxy in front of
     * Onshape, not from Onshape's API — nothing about the request produced
     * them, and the same request a moment later usually succeeds. This was
     * diagnosed the hard way: a comment POST and an unrelated release-package
     * GET both returned a 502 HTML page in the same minute, and the comment
     * looked like a bad request for as long as it was the only call anybody was
     * watching.
     *
     * Only for a request that is safe to repeat. A POST that may already have
     * taken effect must not be sent twice — a duplicated comment or a
     * double-applied transition is worse than an error — so anything other
     * than a GET fails and says what happened.
     */
    if (GATEWAY_STATUSES.has(res.status)) {
      const method = String(init.method ?? "GET").toUpperCase();
      const retryable = method === "GET" && gatewayAttempt < GATEWAY_RETRY_MS.length;
      if (retryable) {
        const wait = GATEWAY_RETRY_MS[gatewayAttempt];
        console.warn(
          `[PLM] Onshape returned ${res.status} for ${method} ${path} — a gateway error, ` +
          `not an API response. Retrying in ${wait}ms ` +
          `(${gatewayAttempt + 1}/${GATEWAY_RETRY_MS.length}).`
        );
        await new Promise((r) => setTimeout(r, wait));
        return this.req<T>(path, init, isRetry, gatewayAttempt + 1);
      }
    }

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

      /*
       * An HTML body means a proxy answered, not Onshape.
       *
       * Dumping the markup into a message somebody reads on a page is the
       * worst of both: it buries the status and it invites them to look for a
       * problem in their request. Said plainly instead, with the HTML dropped.
       */
      const isHtml = /^\s*<(!doctype|html)/i.test(body);
      if (isHtml || GATEWAY_STATUSES.has(res.status)) {
        throw new Error(
          `Onshape ${init.method || "GET"} ${path} -> ${res.status}: Onshape's gateway ` +
          `answered instead of its API${isHtml ? " (an HTML error page)" : ""}. This is not a ` +
          `problem with the request — the same call usually succeeds a moment later. ` +
          `If it keeps happening, Onshape's status page is the place to look.`
        );
      }

      throw new Error(
        `Onshape ${init.method || "GET"} ${path} -> ${res.status}: ${body.slice(0, 500)}` +
        (res.status === 401
          ? ` — the stored Onshape token was rejected and could not be refreshed. ` +
            `Press Connect Onshape in Settings to re-authorise the account this ` +
            `enterprise acts as.`
          : "")
      );
    }

    /*
     * A 200 whose body is not JSON is the same class of problem.
     *
     * A proxy can answer 200 with an HTML page, and `res.json()` then throws
     * something about unexpected token "<" that says nothing useful.
     */
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new Error(
        `Onshape ${init.method || "GET"} ${path} -> ${res.status} but answered with an HTML ` +
        `page rather than JSON. That is a gateway response, not an API one.`
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Onshape ${init.method || "GET"} ${path} -> ${res.status} with a body that is not ` +
        `JSON: ${text.slice(0, 200)}`
      );
    }
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
    /*
     * `objectTypeOrdinal` is REQUIRED, not optional as this call used to send
     * it. Omitting it now earns a 400 naming
     * `BTRestMetadataSchema.getMetadataSchema.objectTypeOrdinal`, `"must not
     * be null"` — caught live, on a real tenant, where it silently disabled
     * every coded value this endpoint exists to name.
     *
     * The endpoint is unpublished (absent from Onshape's OpenAPI definition,
     * the same way findTasks and several task endpoints are — see
     * docs/ONSHAPE-INTEGRATION-SPEC.md), so which ordinal to send is not
     * documented either. It is inferred from `BTMetadataObjectType`'s
     * declared order — the same inference object-types.ts already uses for a
     * comment's objectType — and PART is what this call's one consumer,
     * `getPartMetadata`, actually needs: a part's own coded properties
     * (State, say) resolved against the tenant's schema.
     * `ONSHAPE_METADATA_SCHEMA_OBJECT_TYPE` overrides the ordinal, so being
     * wrong here costs a line of configuration rather than a rebuild.
     */
    const configuredType = Number(process.env.ONSHAPE_METADATA_SCHEMA_OBJECT_TYPE);
    const objectTypeOrdinal = Number.isInteger(configuredType) ? configuredType : objectTypeCode("PART");
    // ownerType 1 = company/enterprise.
    const data = await this.req<Record<string, any>>(
      `${path}?ownerId=${encodeURIComponent(companyId)}&ownerType=1&active=true` +
      `&objectTypeOrdinal=${objectTypeOrdinal}`
    );

    const rows: any[] = data.items ?? data.properties ?? (Array.isArray(data) ? data : []);
    return rows.map((p) => ({
      propertyId: String(p.id ?? p.propertyId),
      name: String(p.name ?? ""),
      valueType: String(p.valueType ?? p.type ?? "STRING"),
      /*
       * Both shapes, because they answer different questions.
       *
       * This used to keep only `String(e.value)` and drop `e.label` on the
       * floor — so a State option arriving as {value: 2, label: "Released"}
       * became the bare string "2", and the label Onshape had already supplied
       * was gone. `enumOptions` keeps the pair; `enumValues` stays for the
       * callers that only want a list of permissible values.
       */
      enumValues: Array.isArray(p.enumValues)
        ? p.enumValues.map((e: any) => String(e?.value ?? e))
        : undefined,
      enumOptions: Array.isArray(p.enumValues)
        ? p.enumValues.map((e: any) =>
            e && typeof e === "object"
              ? { value: e.value, label: String(e.label ?? e.value ?? "") }
              : { value: e, label: String(e) }
          )
        : undefined,
      builtIn: Boolean(p.builtIn ?? p.isBuiltIn ?? false),
    }));
  }

  /**
   * The enterprise property schema, cached per company.
   *
   * Read so that a property arriving with a bare code can be named from the
   * tenant's own definitions rather than from a table of Onshape's stock states
   * hardcoded here. Which states exist, and what their codes are, is a fact
   * about the customer's workflow — the schema endpoint is the only thing
   * entitled to answer it.
   */
  private async schemaFor(companyId: string): Promise<PropertyDef[] | null> {
    const hit = LiveOnshapeClient.schemaCache.get(companyId);
    if (hit && Date.now() - hit.at < LiveOnshapeClient.CACHE_TTL) return hit.value;

    try {
      const defs = await this.listPropertyDefinitions(companyId);
      LiveOnshapeClient.schemaCache.set(companyId, { at: Date.now(), value: defs });
      return defs;
    } catch (err: any) {
      /*
       * Cache the failure too, briefly.
       *
       * This is an enrichment, not the read itself. A tenant whose schema
       * endpoint is unavailable — or a token without the scope for it — must
       * still get its part metadata, with codes shown as codes. Without the
       * negative cache every property of every part would retry it.
       */
      console.warn(
        `[PLM] could not read the property schema for company ${companyId}, so coded ` +
        `values cannot be named: ${err?.message ?? err}`
      );
      LiveOnshapeClient.schemaCache.set(companyId, { at: Date.now(), value: null });
      return null;
    }
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
    /*
     * An assembly is addressed as an element, a part as a part within one.
     *
     * With no partId the part form degenerates to ".../e/{eid}/p/", and Onshape
     * reads that empty trailing segment as a wildcard — "Category overrides
     * endpoint does not support wildcard requests" on a write, which names
     * neither the element nor the missing id. Every part-scoped URL in this
     * client had the same latent fault, because MOS never tracked assemblies.
     */
    const partId = String(c.partId ?? "").trim();
    const subject = partId
      ? `/e/${c.elementId}/p/${encodeURIComponent(partId)}`
      : `/e/${c.elementId}`;

    return `/metadata/d/${c.documentId}/${wv}${subject}${cfg}`;
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
  /** Payload shapes already reported, so a log line appears once, not per call. */
  private static reportedShapes = new Set<string>();
  private static schemaCache = new Map<string, { at: number; value: PropertyDef[] | null }>();
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
  async getAssemblyBom(
    c: AssemblyCoords,
    opts: { multiLevel?: boolean; indented?: boolean } = {}
  ): Promise<BomTable> {
    const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;
    const base = process.env.ONSHAPE_BOM_PATH || "/assemblies";

    /*
     * `indented=true`, which is where the structure comes from.
     *
     * This used to send `false`, so Onshape returned a flat list with every
     * row at indentLevel 0 — the hierarchy was discarded before PLM ever saw
     * it, and no amount of work downstream could recover it. Onshape's own
     * default for this parameter is true; sending false was a MOS inheritance,
     * where a manufacturing order cares how many to make and not what contains
     * what.
     *
     * An indented multi-level BOM is a flat list whose ORDER carries the tree:
     * each row's parent is the nearest row above it one level shallower. That
     * is reconstructed in lib/bom-structure.ts.
     */
    const indented = opts.indented !== false;

    const q = new URLSearchParams({
      indented: String(indented),
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

    const table = parseBom(payload, { indented });

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
  private async reqBinary(
    path: string,
    isRetry = false,
    /**
     * What to ask Onshape for.
     *
     * Defaults to anything. It matters for glTF: that endpoint offers
     * `model/gltf+json` and `model/gltf-binary` at the SAME quality value, so
     * `*​/*` leaves the choice to Onshape and the answer is not guaranteed to
     * be the single-file form PLM stores.
     */
    accept = "*/*"
  ): Promise<{ data: Buffer; contentType: string }> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: accept },
      cache: "no-store",
    });

    // Same single reactive refresh as req(); binary downloads are how
    // thumbnails and exports leave, and they fail the same way.
    if (res.status === 401 && !isRetry && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.accessToken = fresh;
        return this.reqBinary(path, true, accept);
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
   * Export a part or assembly as glTF, for the record kept against a release.
   *
   * Two different endpoints, because Onshape treats them differently:
   *
   *   A PART is synchronous — `GET .../partid/{pid}/gltf` returns the bytes.
   *     One call, no job, no polling.
   *   An ASSEMBLY is a job — `POST .../export/gltf` returns the same
   *     `BTTranslationRequestInfo` a translation does, so it goes through the
   *     existing poll-and-collect path rather than a second implementation.
   *
   * GLB is requested explicitly. The endpoint offers `model/gltf+json` and
   * `model/gltf-binary` at equal quality values, so without an Accept header
   * the choice is Onshape's — and the JSON form may reference external
   * buffers, which would leave PLM holding part of a model.
   */
  async exportGltf(
    c: PartCoords,
    opts: { isAssembly?: boolean } = {}
  ): Promise<FileExport> {
    const started = Date.now();
    /*
     * A released item is pinned to a version, so this normally resolves to
     * `v/{versionId}` — which is the whole point: the geometry stored is the
     * geometry as released, not whatever the workspace holds now.
     */
    const wv = c.workspaceId ? `w/${c.workspaceId}` : `v/${c.versionId}`;

    if (!opts.isAssembly) {
      if (!c.partId) {
        throw new Error(
          "Onshape's part glTF export needs a part id, and this record has none. " +
          "An assembly is exported through the assembly endpoint instead."
        );
      }
      const base = process.env.ONSHAPE_PARTS_PATH || "/parts";
      const q = new URLSearchParams();
      if (c.configuration && c.configuration !== "default") q.set("configuration", c.configuration);
      const path =
        `${base}/d/${c.documentId}/${wv}/e/${c.elementId}` +
        `/partid/${encodeURIComponent(c.partId)}/gltf${q.toString() ? `?${q}` : ""}`;

      const { data, contentType } = await this.reqBinary(path, false, "model/gltf-binary");
      return { data, contentType, via: "direct", elapsedMs: Date.now() - started };
    }

    /*
     * An assembly. Note the coordinate segment: this endpoint takes {wv} —
     * workspace or version only, no microversion — which is what a released
     * item always has anyway.
     */
    const base = process.env.ONSHAPE_ASSEMBLY_TRANSLATIONS_PATH || "/assemblies";
    const submitted = await this.req<Record<string, any>>(
      `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/export/gltf`,
      {
        method: "POST",
        body: JSON.stringify({
          /* Hidden instances are not part of the released product. */
          excludeHiddenEntities: true,
          storeInDocument: false,
          notifyUser: false,
        }),
      }
    );
    return this.awaitTranslation(submitted, c.documentId, "glTF export", started);
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
    /*
     * An assembly's mass comes from the assembly endpoint, and covers the whole
     * assembly — so there is no partId to filter by. Sending an empty one asks
     * a Part Studio about a part that does not exist.
     */
    const partId = String(c.partId ?? "").trim();
    const base = partId
      ? process.env.ONSHAPE_MASSPROPERTIES_PATH || "/partstudios"
      : process.env.ONSHAPE_ASSEMBLY_MASSPROPERTIES_PATH || "/assemblies";
    const cfg =
      c.configuration && c.configuration !== "default" && !/^\{\$.*\}$/.test(c.configuration)
        ? `&configuration=${encodeURIComponent(c.configuration)}`
        : "";
    const filter = partId ? `partId=${encodeURIComponent(partId)}` : "";
    const query = [filter, cfg.replace(/^&/, "")].filter(Boolean).join("&");

    const payload = await this.req<Record<string, any>>(
      `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/massproperties${query ? `?${query}` : ""}`
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

    /*
     * A direct download addresses one part. An assembly has no partId, so it
     * can only be produced by a translation — which handles every format
     * anyway, at the cost of a job rather than a single call.
     */
    const partId = String(c.partId ?? "").trim();
    if (partId && format.strategy === "direct" && format.directPath) {
      const base = process.env.ONSHAPE_PARTS_PATH || "/parts";
      const path =
        `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/partid/${encodeURIComponent(partId)}` +
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
    const partId = String(c.partId ?? "").trim();
    const base = partId
      ? process.env.ONSHAPE_TRANSLATIONS_PATH || "/partstudios"
      : process.env.ONSHAPE_ASSEMBLY_TRANSLATIONS_PATH || "/assemblies";

    const submitted = await this.req<Record<string, any>>(
      `${base}/d/${c.documentId}/${wv}/e/${c.elementId}/translations`,
      {
        method: "POST",
        body: JSON.stringify({
          formatName: format.formatName,
          // Just this part, not everything in the Part Studio. An assembly is
          // exported whole, so it names no part at all — sending an empty
          // partIds asks for a part with no id.
          ...(partId ? { partIds: partId } : {}),
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

    /*
     * Fill in options the metadata payload left out.
     *
     * Onshape's metadata response does not always inline a property's enum
     * options — and when it does not, a State stored as the integer 2 has
     * nothing to be resolved against, so PLM showed "Unknown (2)". It was
     * right to refuse to guess: which states exist and what their codes are
     * depends on the tenant's workflow. But the tenant does publish that, in
     * the property schema, and PLM simply never asked.
     *
     * Only fetched when something actually needs it, and cached per company.
     */
    const needsOptions = props.some((p) => !p.enumValues?.length && looksCoded(p));
    if (needsOptions && this.companyId) {
      const defs = await this.schemaFor(this.companyId);
      const byId = new Map((defs ?? []).map((d) => [d.propertyId, d]));
      for (const p of props) {
        if (p.enumValues?.length) continue;
        const d = byId.get(p.propertyId);
        if (d?.enumOptions?.length) {
          p.enumValues = d.enumOptions.map((o) => ({ value: o.value, label: o.label }));
          p.valueType = p.valueType || d.valueType;
        }
      }
    }

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
      /*
       * The tenant's own definitions when the schema was read, which carry the
       * real valueType and option lists; otherwise the ones inferred from the
       * payload, where every property is a plain string.
       */
      definitions:
        (this.companyId
          ? LiveOnshapeClient.schemaCache.get(this.companyId)?.value ?? null
          : null) ?? toDefinitions(props),
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
  /**
   * Flatten a release package's item tree.
   *
   * Onshape nests items: a drawing arrives as a root item with the parts it
   * documents as its `children`, and the top-level `items` array holds only
   * the roots. PLM read only that array, so a package whose root was a drawing
   * reported one item — the drawing — and the part in the release was invisible.
   * The visible symptom was a released drawing with no parts associated to it,
   * which looked like a broken link in PLM rather than half a package.
   *
   * It went unnoticed because a package whose root is a part has
   * `children: []`, and every package examined until now was that shape.
   *
   * A child listed in its parent's `manuallyRemovedChildrenIds` was taken out
   * of the release by hand and must not be pulled back in.
   */
  private static flattenPackageItems(roots: any[], onUnmatchedRemoval?: (ids: string[]) => void): any[] {
    const out: any[] = [];

    const walk = (items: any[], depth: number) => {
      // Onshape's own structure is shallow; this only stops a cycle in a
      // malformed payload from hanging the request.
      if (depth > 12) return;

      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        out.push(it);

        const kids: any[] = Array.isArray(it.children) ? it.children : [];
        if (!kids.length) continue;

        const removed = (Array.isArray(it.manuallyRemovedChildrenIds)
          ? it.manuallyRemovedChildrenIds
          : []
        ).map((x: unknown) => String(x));

        const kept = kids.filter((k) => {
          if (!removed.length) return true;
          const id = String(k?.id ?? "");
          /*
           * The removal list holds composite keys, not bare item ids, so a
           * containment test is used in both directions rather than equality.
           */
          return !removed.some((r: string) => r === id || (id && r.includes(id)));
        });

        if (removed.length && kept.length === kids.length && onUnmatchedRemoval) {
          // Nothing matched: the key format is not what this assumes, and
          // silently keeping a removed item is the failure worth reporting.
          onUnmatchedRemoval(removed);
        }

        walk(kept, depth + 1);
      }
    };

    walk(Array.isArray(roots) ? roots : [], 0);
    return out;
  }

  private toReleasePackage(d: Record<string, any>): ReleasePackage {
    const roots: any[] = Array.isArray(d?.items) ? d.items : [];
    const rawItems: any[] = LiveOnshapeClient.flattenPackageItems(roots, (removed) => {
      const key = `rp-removal|${removed[0]?.slice(0, 24) ?? ""}`;
      if (LiveOnshapeClient.reportedShapes.has(key)) return;
      LiveOnshapeClient.reportedShapes.add(key);
      console.warn(
        `[PLM] release package ${d?.id}: an item lists manuallyRemovedChildrenIds ` +
        `${JSON.stringify(removed)} but none matched a child's id, so nothing was ` +
        `excluded. An item somebody removed from the release by hand may have been ` +
        `brought back in — the id format above is what this needs to match.`
      );
    });

    if (roots.length !== rawItems.length) {
      const key = `rp-nested|${roots.length}-${rawItems.length}`;
      if (!LiveOnshapeClient.reportedShapes.has(key)) {
        LiveOnshapeClient.reportedShapes.add(key);
        console.log(
          `[PLM] release package: ${roots.length} root item(s) contained ` +
          `${rawItems.length - roots.length} nested item(s); all ${rawItems.length} are in ` +
          `the release.`
        );
      }
    }

    const items: ReleasePackageItem[] = rawItems.map((it: any) => ({
      id: String(it?.id ?? ""),
      documentId: String(it?.documentId ?? it?.document?.id ?? ""),
      elementId: String(it?.elementId ?? it?.element?.id ?? ""),
      partId: String(it?.partId ?? it?.partIdentity ?? ""),
      /*
       * A word, never the raw value.
       *
       * Onshape sends `elementType` as a number on a release package item
       * (`0` for a Part Studio, confirmed), so `String(0).toUpperCase()` is
       * "0" — and the takeover compares this against "DRAWING" and "ASSEMBLY".
       * Neither ever matched, so *every* item went down the part branch: a
       * drawing had a PLM part created for it and appeared in the parts list,
       * while the drawing loop skipped it, leaving no Drawing record, nothing
       * on the release, and no association to the part it documents.
       *
       * `classify` already existed for this — it was written when the numbering
       * extension hit the same numeric enum — and it reads the structural
       * evidence (a partId means a part; the mime type names the rest) before
       * falling back to the code table.
       */
      elementType: classify(it ?? {}).type,
      name: String(it?.name ?? it?.elementName ?? ""),
      partNumber: String(it?.partNumber ?? ""),
      revisionId: String(it?.revisionId ?? ""),
      revision: String(it?.revision ?? ""),
      versionId: String(it?.versionId ?? it?.version?.id ?? ""),
    }));

    /*
     * Where the workflow information might be.
     *
     * A live enterprise returned a package PLM read as state `""` with no
     * actions, which is how the release refused with a message blaming the
     * service account's approver rights — a cause nothing in the payload
     * supported. Neither the state nor the actions were where this looked.
     *
     * The action enum on this endpoint is unknown U2 in the integration spec,
     * and the plan recorded there is to read the actions off a live package
     * rather than infer them. These are candidate container names, not
     * documented ones: each is tried, the one that hit is logged, and a miss
     * logs the payload's shape so the real name can be read off it. Nothing
     * here invents an action id — an action with no id is discarded.
     */
    const actionPaths: [string, unknown][] = [
      ["workflowActions", d?.workflowActions],
      ["actions", d?.actions],
      ["availableActions", d?.availableActions],
      ["transitions", d?.transitions],
      ["workflow.actions", d?.workflow?.actions],
      ["workflow.availableActions", d?.workflow?.availableActions],
      ["workflow.transitions", d?.workflow?.transitions],
      ["workflow.workflowActions", d?.workflow?.workflowActions],
      ["actionableInfo.actions", d?.actionableInfo?.actions],
      ["nextActions", d?.nextActions],
      ["allowedActions", d?.allowedActions],
    ];
    /*
     * Any real array counts, empty or not — a released, obsoleted or
     * rejected package genuinely has no further actions, and requiring a
     * non-empty array to count as "found" turned that correct answer into a
     * false "NO actions found" warning on every terminal package. See the
     * identical fix and fuller explanation in workflow-snapshot.ts, which a
     * task hits the same way.
     */
    const actionHit = actionPaths.find(([, v]) => Array.isArray(v));
    const rawActions: any[] = (actionHit?.[1] as any[]) ?? [];

    const availableActions: WorkflowAction[] = rawActions.map((a: any) => {
      // An action may arrive as a bare string on some shapes, in which case the
      // string is both its id and its type.
      if (typeof a === "string") return { id: a, label: a, type: a.toUpperCase() };
      return {
        id: String(a?.id ?? a?.actionId ?? a?.action ?? a?.name ?? ""),
        label: String(a?.label ?? a?.name ?? a?.action ?? ""),
        type: String(a?.type ?? a?.actionType ?? a?.action ?? "").toUpperCase(),
        isApproverAction: Boolean(a?.isApproverAction),
        allowIfNoApprovers: Boolean(a?.allowIfNoApprovers),
        alwaysAllow: Boolean(a?.alwaysAllow),
        isAdminOverride: Boolean(a?.isAdminOverride),
        isCreatorOverride: Boolean(a?.isCreatorOverride),
        requiredProperties: (Array.isArray(a?.requiredProperties) ? a.requiredProperties : [])
          .map((x: unknown) => String(x))
          .filter(Boolean),
      };
    }).filter((a) => a.id);

    /*
     * Where the state is, read off a live package.
     *
     * `workflow.state` is an **object** — {name, displayName,
     * approverSourceProperty, ...} — not a string, which is why a candidate
     * path of that name found nothing and the release refused with state `""`.
     * The name is one level further down, and the display name sits beside it
     * under a third key again.
     *
     * `displayName` is preferred: "Pending" rather than whatever the workflow
     * JSON calls the state internally, and this string is shown to people.
     * [confirmed] against a live enterprise package, 2026-09-10.
     */
    const statePaths: [string, unknown][] = [
      ["workflow.state.displayName", d?.workflow?.state?.displayName],
      ["workflow.currentStateDisplayName", d?.workflow?.currentStateDisplayName],
      ["workflow.state.name", d?.workflow?.state?.name],
      ["workflow.metadataState", d?.workflow?.metadataState],
      // Both forms of the same key: an object on the package shape confirmed
      // above, but a bare string costs nothing to accept and one less way to
      // read `""` off a package that plainly states its state.
      ["workflow.state", typeof d?.workflow?.state === "string" ? d.workflow.state : undefined],
      ["state", typeof d?.state === "string" ? d.state : undefined],
      ["stateName", d?.stateName],
      ["workflowState", typeof d?.workflowState === "string" ? d.workflowState : undefined],
      ["workflowState.name", d?.workflowState?.name],
      ["workflow.stateName", d?.workflow?.stateName],
      ["workflow.currentState", typeof d?.workflow?.currentState === "string" ? d.workflow.currentState : undefined],
      ["currentState.name", d?.currentState?.name],
      ["stateInfo.name", d?.stateInfo?.name],
    ];
    const stateHit = statePaths.find(([, v]) => typeof v === "string" && v !== "");
    const state = String(stateHit?.[1] ?? "");

    /*
     * Onshape returns a property bag as an array of {propertyId, value}
     * elsewhere in this API — metadata does — while this type declares a
     * record. An array cast to a record is not a record: every lookup by
     * property id would miss, silently.
     */
    /*
     * The same properties, with their metadata kept — where a Comment
     * property (or anything else worth finding by name) has to be looked up.
     *
     * A task keeps its workflow properties — Comment, Assigned to — in
     * `workflowInfo.properties`, separate from the metadata schema in
     * `properties` (docs/ONSHAPE-INTEGRATION-SPEC.md T6, [confirmed]). A
     * release package runs the same `BTWorkflowSnapshotInfo` workflow (T2),
     * so it is tried in the same place first; `workflow.properties` is tried
     * too, since the rest of a package's workflow state lives under
     * `workflow` rather than `workflowInfo` (see actionPaths/statePaths
     * above) and Onshape's naming here is not documented either way.
     * Whichever hits is logged once; a miss logs nothing extra — the
     * `rp-miss`/`rp-shape` logging above already dumps the payload shape when
     * state or actions are not found, and a package with none of these paths
     * populated simply has no workflow properties, which is a valid outcome.
     */
    const propDefPaths: [string, unknown][] = [
      ["workflowInfo.properties", d?.workflowInfo?.properties],
      ["workflow.properties", d?.workflow?.properties],
    ];
    const propDefHit = propDefPaths.find(([, v]) => Array.isArray(v) && v.length > 0);
    if (propDefHit) {
      const key = `rp-propdefs|${propDefHit[0]}`;
      if (!LiveOnshapeClient.reportedShapes.has(key)) {
        LiveOnshapeClient.reportedShapes.add(key);
        console.log(
          `[PLM] release package ${d?.id}: workflow property definitions from ` +
          `"${propDefHit[0]}" (${(propDefHit[1] as any[]).length}: ` +
          `${(propDefHit[1] as any[]).map((p: any) => p?.name).filter(Boolean).join(", ")})`
        );
      }
    }
    const propertyDefs: ReleasePackage["propertyDefs"] = (
      (propDefHit?.[1] as any[] | undefined) ?? []
    ).map((p: any) => ({
      propertyId: String(p?.propertyId ?? ""),
      name: String(p?.name ?? ""),
      value: p?.value,
      valueType: String(p?.valueType ?? ""),
      editable: Boolean(p?.editable),
    })).filter((p) => p.propertyId);

    const properties: Record<string, unknown> = Array.isArray(d?.properties)
      ? Object.fromEntries(
          (d.properties as any[])
            .filter((p) => p?.propertyId != null)
            .map((p) => [String(p.propertyId), p?.value])
        )
      : ((d?.properties ?? {}) as Record<string, unknown>);

    const id = String(d?.id ?? d?.rpid ?? "");

    /*
     * Report what was found, and on a miss report the shape.
     *
     * Logged once per package rather than per call: the transition path reads
     * the package again straight after, and a duplicated line makes it look
     * like two packages are in play.
     */
    if (stateHit && actionHit) {
      const key = `rp-shape|${stateHit[0]}|${actionHit[0]}`;
      if (!LiveOnshapeClient.reportedShapes.has(key)) {
        LiveOnshapeClient.reportedShapes.add(key);
        console.log(
          `[PLM] release package shape: state from "${stateHit[0]}", ` +
          `actions from "${actionHit[0]}" (${availableActions.length}: ` +
          `${availableActions.map((a) => `${a.id}/${a.type}`).join(", ")})`
        );
      }
    } else if (!LiveOnshapeClient.reportedShapes.has(`rp-miss|${id}`)) {
      LiveOnshapeClient.reportedShapes.add(`rp-miss|${id}`);
      console.warn(
        `[PLM] release package ${id}: ` +
        `${stateHit ? `state from "${stateHit[0]}"` : "NO state found"}, ` +
        `${actionHit ? `actions from "${actionHit[0]}"` : "NO actions found"}. ` +
        `Tried state: ${statePaths.map(([k]) => k).join(", ")}. ` +
        `Tried actions: ${actionPaths.map(([k]) => k).join(", ")}. ` +
        `Payload shape: ${describeShape(d, 3)}`
      );
    }

    const transitionStatus = (Array.isArray(d?.transitionStatus) ? d.transitionStatus : []).map(
      (t: any) => ({
        summaryState: String(t?.summaryState ?? ""),
        lastStage: String(t?.lastStage ?? ""),
        errorMessage: String(t?.errorMessage ?? ""),
        sequenceNumber: typeof t?.sequenceNumber === "number" ? t.sequenceNumber : null,
        lastUpdatedAt: String(t?.lastUpdatedAt ?? ""),
      })
    );

    return {
      id,
      /*
       * An object on a real package: {companyId, workflowId, versionId}.
       *
       * `String()` of that is "[object Object]", which is what PLM had been
       * storing on every release taken over — visible on the release page as
       * the workflow id. [confirmed] against a live package.
       */
      workflowId: String(
        d?.workflowId?.workflowId ?? d?.workflowId ?? d?.wfid ?? ""
      ),
      state,
      changeOrderId: String(d?.changeOrderId ?? ""),
      items,
      properties,
      propertyDefs,
      availableActions,
      permissions: {
        approverIds: (Array.isArray(d?.workflow?.approverIds) ? d.workflow.approverIds : [])
          .map((x: unknown) => String(x)),
        isCreator: Boolean(d?.workflow?.isCreator),
        createdById: String(d?.createdBy?.id ?? ""),
      },
      transitionStatus,
      /*
       * Not a package-level field.
       *
       * A live package carries `syncedWithPLM` on each *item*, and the
       * package-level marker for an external PLM is `workflow.usesExternalPlm`.
       * Reading the top level meant this was always false. (Unknown U4 asked
       * whether the flag is writable; it now at least reads.)
       */
      syncedWithPLM: Boolean(
        d?.syncedWithPLM ??
        d?.workflow?.usesExternalPlm ??
        (Array.isArray(d?.items) && d.items.length > 0
          ? d.items.every((i: any) => i?.syncedWithPLM)
          : false)
      ),
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
    /*
     * The workflow action is a QUERY parameter, `wfaction`.
     *
     * This was previously sent as `{action: actionId}` in the body — and
     * `action` is a real query parameter on this endpoint, but it means
     * something else entirely: `UPDATE | ADD_ITEMS | REMOVE_ITEMS | SAVE_DRAFT`,
     * defaulting to UPDATE. So Onshape received a body field it does not
     * define, performed an empty UPDATE, and returned 200 with the package
     * untouched. No error, `transitionStatus` still HEALTHY, state still
     * Pending — a release that silently never happened.
     *
     * From Onshape's published OpenAPI definition of `updateReleasePackage`
     * (cad.onshape.com/api/openapi), which documents `wfaction` as
     * `SUBMIT | CREATE_AND_RELEASE | RELEASE | REJECT | OBSOLETE | DISCARD |
     * CREATE_AND_OBSOLETE` for the stock workflows, and workflow-defined
     * values for a custom one. [confirmed]
     */
    /*
     * `action=UPDATE` is sent alongside it, as every example in Onshape's
     * release-management guide does. The OpenAPI definition says `action`
     * defaults to UPDATE, so this should be redundant — but the documented
     * calls are the contract that is known to work, and the cost of matching
     * them exactly is nothing.
     */
    const path =
      `/releasepackages/${encodeURIComponent(rpid)}` +
      `?action=UPDATE&wfaction=${encodeURIComponent(actionId)}`;

    /*
     * The body is required, and its schema (BTUpdateReleasePackageParams) has
     * exactly three optional fields: itemIds, items and properties. There is no
     * field for a comment, so the reviewer's note stays in PLM — which is where
     * the audit trail lives anyway. Property values are sent as the documented
     * array of {propertyId, value}, not as a map.
     */
    const body: Record<string, unknown> = {};
    if (opts.properties && Object.keys(opts.properties).length) {
      body.properties = Object.entries(opts.properties).map(([propertyId, value]) => ({
        propertyId,
        value,
      }));
    }

    const d = await this.req<Record<string, any>>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
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
        /*
         * `items` and nothing else.
         *
         * BTReleasePackageParams has exactly one field. `wfid` is already in
         * the path; `changeOrderId` is **read-only** — it exists on the
         * response type but not on this request, so PLM's number never reached
         * Onshape and the "tracked by changeOrderId" idea never worked; and
         * package-level `properties` is not a field here either, though each
         * *item* accepts its own. All three were being sent and silently
         * discarded. [confirmed from Onshape's OpenAPI definition]
         *
         * `workspaceId` and `partIdentity` are available on the item schema
         * too, and are worth passing when known: a package item identifies
         * exactly which version of which element is being released.
         */
        body: JSON.stringify({
          items: input.items.map((i) => ({
            documentId: i.documentId,
            elementId: i.elementId,
            ...(i.partId ? { partId: i.partId } : {}),
            ...(i.revisionId ? { revisionId: i.revisionId } : {}),
            ...(i.versionId ? { versionId: i.versionId } : {}),
            ...(i.workspaceId ? { workspaceId: i.workspaceId } : {}),
            ...(i.properties
              ? {
                  properties: Object.entries(i.properties).map(([propertyId, value]) => ({
                    propertyId,
                    value,
                  })),
                }
              : {}),
          })),
        }),
      }
    );
    return this.toReleasePackage(d);
  }

  /* ======================================================================== */
  /* Tasks                                                                     */
  /*                                                                          */
  /* A task carries the same BTWorkflowSnapshotInfo as a release package, so   */
  /* its state and its transitions are read by the shared parser rather than   */
  /* a second implementation — see lib/onshape/workflow-snapshot.ts.           */
  /* ======================================================================== */

  async listTasks(
    opts: { userId?: string; documentId?: string; status?: number; limit?: number; offset?: number } = {}
  ): Promise<OnshapeTask[]> {
    const q = new URLSearchParams();
    if (opts.userId) q.set("userId", opts.userId);
    if (opts.documentId) q.set("documentId", opts.documentId);
    /*
     * `status` is an undocumented integer whose Onshape default is 2. Sent only
     * when a caller asks, so the default behaviour is Onshape's own rather than
     * a guess of ours about what the codes mean.
     */
    if (opts.status != null) q.set("status", String(opts.status));
    /*
     * 100 is Onshape's hard maximum for this endpoint, not a guess.
     *
     * It is declared in the OpenAPI definition (`maximum: 100`) and enforced —
     * asking for more earns a 400 naming
     * `BTRestTask.getActionItems.limit`. PLM asked for 200 because that
     * inspection read the parameter's default and did not read its maximum.
     *
     * A caller wanting more than a page uses `offset`; see `TASKS_PAGE_MAX`.
     */
    q.set("limit", String(Math.min(TASKS_PAGE_MAX, Math.max(1, opts.limit ?? TASKS_PAGE_MAX))));
    if (opts.offset) q.set("offset", String(opts.offset));

    const path = `${process.env.ONSHAPE_TASKS_PATH || "/tasks"}?${q.toString()}`;
    const data = await this.req<Record<string, any>>(path);

    const rows: any[] = Array.isArray(data)
      ? data
      : data.items ?? data.tasks ?? data.actionItems ?? [];

    if (!Array.isArray(rows) || (rows.length === 0 && !Array.isArray(data))) {
      const key = `tasks-shape|${Object.keys(data ?? {}).join(",")}`;
      if (!LiveOnshapeClient.reportedShapes.has(key)) {
        LiveOnshapeClient.reportedShapes.add(key);
        console.log(
          `[PLM] task list came back with no recognised rows. Shape: ${describeShape(data, 2)}`
        );
      }
    }

    return rows.map((r) => this.toTask(r));
  }

  /**
   * Every task in the enterprise, via the internal search endpoint.
   *
   * See the interface for why this exists and what is and is not guessable
   * about it. In short: `getActionItems` shows only what the calling account
   * created or was assigned unless it is a company admin, and on the tenant
   * this was built against that was 8 tasks out of 174.
   *
   * Paging is in the body. Onshape's own `next` URL uses query `offset` and
   * `limit` and ignores both, so following it re-reads the first page for
   * ever; `from`/`size` in the body is what moves. Pages are followed until
   * one comes back short or stops yielding anything new — the second guard
   * matters because a body Onshape does not understand would otherwise return
   * page one indefinitely.
   */
  async findTasks(opts: { from?: number; size?: number } = {}): Promise<FoundTask[]> {
    const base = process.env.ONSHAPE_TASKS_PATH || "/tasks";
    const path = `${base}/find`;

    const size = Math.min(TASKS_PAGE_MAX, Math.max(1, opts.size ?? TASKS_PAGE_MAX));
    const start = Math.max(0, opts.from ?? 0);

    /* One page only, when the caller asked for a specific window. */
    const single = opts.from != null;

    const seen = new Set<string>();
    const out: FoundTask[] = [];

    for (let page = 0; page < FIND_TASKS_MAX_PAGES; page++) {
      const from = start + page * size;

      let data: Record<string, any>;
      try {
        data = await this.req<Record<string, any>>(path, {
          method: "POST",
          body: JSON.stringify({ from, size }),
        });
      } catch (err: any) {
        /*
         * Reported, not thrown.
         *
         * This endpoint is unpublished, so a tenant that does not expose it is
         * a normal outcome rather than a fault. The caller still has whatever
         * `getActionItems` gave it, and losing that to an exception here would
         * make PLM's task board depend on an endpoint Onshape never promised.
         */
        const key = `find-tasks|${String(err?.message ?? "").slice(0, 60)}`;
        if (!LiveOnshapeClient.reportedShapes.has(key)) {
          LiveOnshapeClient.reportedShapes.add(key);
          console.log(
            `[PLM] POST ${path} is unavailable, so the task list is limited to the ` +
            `integration account's own action items. Onshape said: ${err?.message ?? err}`
          );
        }
        break;
      }

      const rows: any[] = Array.isArray(data) ? data : data?.items ?? [];
      let fresh = 0;
      for (const r of rows) {
        const id = String(r?.id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh++;
        out.push({
          id,
          name: String(r?.name ?? r?.simpleName ?? ""),
          taskType: String(r?.taskType ?? ""),
          displayState: String(r?.state ?? r?.workflowState ?? ""),
          documentId: String(r?.documentId ?? ""),
        });
      }

      if (single || rows.length < size || fresh === 0) break;
    }

    return out;
  }

  async getTask(taskId: string): Promise<OnshapeTask> {
    const base = process.env.ONSHAPE_TASKS_PATH || "/tasks";
    return this.toTask(
      await this.req<Record<string, any>>(`${base}/${encodeURIComponent(taskId)}`)
    );
  }

  async transitionTask(taskId: string, transition: string): Promise<OnshapeTask> {
    const base = process.env.ONSHAPE_TASKS_PATH || "/tasks";
    /*
     * The transition is a PATH segment, and the value is an action's `action`
     * field — not its `type`. Onshape's release packages taught this the hard
     * way: `{type: "APPROVE", action: "RELEASE"}`, and only `RELEASE` works.
     */
    const d = await this.req<Record<string, any>>(
      `${base}/${encodeURIComponent(taskId)}/${encodeURIComponent(transition)}`,
      { method: "POST", body: JSON.stringify({}) }
    );

    /*
     * The response may be the updated task or may be empty. Re-read rather than
     * trust it — a task board that shows a stale state after the click someone
     * just made is worse than one extra call.
     */
    const fromPost = this.toTask(d);
    if (fromPost.state) return fromPost;
    return this.getTask(taskId);
  }

  async updateTask(
    taskId: string,
    patch: { name?: string; description?: string; propertyValues?: Record<string, unknown> }
  ): Promise<OnshapeTask> {
    const base = process.env.ONSHAPE_TASKS_PATH || "/tasks";
    /*
     * BTUpdateTaskParams names these `nameParamValue` and
     * `descriptionParamValue` — not `name` and `description`. Sending the
     * obvious pair would be accepted and ignored, which is exactly how the
     * release transition failed silently for a day.
     */
    const body: Record<string, unknown> = {};
    if (patch.name != null) body.nameParamValue = patch.name;
    if (patch.description != null) body.descriptionParamValue = patch.description;
    /*
     * Properties go as the documented array of {propertyId, value} — this is
     * where a task's due date, priority and task state actually live, none of
     * which is a top-level field.
     */
    if (patch.propertyValues && Object.keys(patch.propertyValues).length) {
      body.propertyValues = Object.entries(patch.propertyValues).map(([propertyId, value]) => ({
        propertyId,
        value,
      }));
    }

    await this.req(`${base}/${encodeURIComponent(taskId)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return this.getTask(taskId);
  }

  async commentOnTask(
    taskId: string,
    message: string,
    _opts: CommentContext = {}
  ): Promise<OnshapeComment> {
    /*
     * A comment is a WORKFLOW PROPERTY WRITE, not a /comments POST.
     *
     * Onshape's own UI posts `POST /tasks/{tid}` with
     * `propertyValues: [{propertyId: <the Comment property>, value: <text>}]`,
     * and the task comes back with the message appended to its `comments`
     * array. That is the whole mechanism.
     *
     * Three rounds went into `/comments` before this — 500, then 404, then
     * 400 for every objectType tried — because the Comment property lives in
     * `workflowInfo.properties` and PLM was only reading the top-level
     * `properties`. Nothing was wrong with the request except the endpoint.
     *
     * The property id is read off the task rather than hardcoded: it belongs
     * to the tenant's published task workflow, and another tenant's will
     * differ.
     */
    const task = await this.getTask(taskId);
    const prop = findCommentProperty(task.properties);
    if (!prop) {
      throw new Error(
        `This task's workflow has no Comment property, so there is nowhere to post a ` +
        `comment. Onshape adds one through the task workflow, not through the comment ` +
        `API — the properties it does have are: ` +
        `${task.properties.map((p) => p.name).filter(Boolean).join(", ") || "none"}.`
      );
    }

    const before = new Set(task.comments.map((c) => c.id));
    const after = await this.updateTask(taskId, { propertyValues: { [prop.propertyId]: message } });

    /*
     * The comment Onshape created, identified by being the one that was not
     * there before. The update response carries the whole thread, so there is
     * no need to guess at an id or re-read.
     */
    const created = after.comments.find((c) => !before.has(c.id));
    if (created) return created;

    /*
     * Accepted but no new comment came back. Reported rather than fabricated:
     * a comment PLM claims exists and Onshape does not hold is worse than an
     * error somebody can act on.
     */
    throw new Error(
      `Onshape accepted the write to the Comment property but returned no new comment on ` +
      `the task. The text may not have been recorded.`
    );
  }

  async deleteTask(taskId: string): Promise<void> {
    const base = process.env.ONSHAPE_TASKS_PATH || "/tasks";
    /*
     * No body, and no response worth parsing. `req` returns undefined for a
     * 204 and this endpoint declares only a default response, so anything
     * other than a throw means it went through.
     */
    await this.req(`${base}/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  }

  /** One task, from whatever Onshape returned. */  /** One task, from whatever Onshape returned. */
  private toTask(d: Record<string, any>): OnshapeTask {
    const wf = parseWorkflowSnapshot(d, {
      label: `task ${d?.id ?? "(no id)"}`,
      wf: d?.workflowInfo?.workflow ?? d?.workflow,
    });

    const users: any[] = Array.isArray(d?.users) ? d.users : [];
    const items: any[] = Array.isArray(d?.taskItems) ? d.taskItems : [];

    return {
      id: String(d?.id ?? ""),
      name: String(d?.name ?? d?.simpleName ?? ""),
      description: String(d?.description ?? ""),
      state: wf.state || String(d?.state ?? d?.workflowState ?? ""),
      status: typeof d?.status === "number" ? d.status : null,
      taskType: String(d?.taskType ?? ""),
      documentId: String(d?.documentId ?? ""),
      documentName: String(d?.documentName ?? ""),
      elementId: String(d?.elementId ?? ""),
      workspaceId: d?.workspaceId ? String(d.workspaceId) : null,
      versionId: d?.versionId ? String(d.versionId) : null,
      objectId: String(d?.objectId ?? ""),
      creatorEmail: String(d?.creator?.email ?? ""),
      creatorName: String(d?.creator?.name ?? ""),
      assignees: users.map((u) => ({
        onshapeUserId: String(u?.id ?? ""),
        email: String(u?.email ?? ""),
        name: String(u?.name ?? [u?.firstName, u?.lastName].filter(Boolean).join(" ")),
        // Onshape's own marker for "this person has done their part".
        acted: Boolean(u?.acted),
      })),
      resolvedAt: d?.resolvedAt ? String(d.resolvedAt) : null,
      resolvedByEmail: String(d?.resolvedBy?.email ?? ""),
      items: items.map((i) => ({
        label: String(i?.name ?? i?.fileName ?? i?.partId ?? "item"),
        documentId: String(i?.documentId ?? ""),
        elementId: String(i?.elementId ?? ""),
        partId: String(i?.partId ?? ""),
        // The same numeric enum as everywhere else, so the same classifier.
        elementType: classify(i ?? {}).type,
      })),
      comments: (Array.isArray(d?.comments) ? d.comments : []).map(toComment),
      availableActions: wf.actions.map((a) => ({ id: a.id, label: a.label, type: a.type })),
      /*
       * BOTH property sets, and the workflow's come second so they win.
       *
       * A task carries `properties` (Name, Description, Category, State, Due
       * date, Completed date, Priority) AND `workflowInfo.properties` (Name,
       * Description, **Comment**, **Assigned to**). Reading only the top level
       * is why PLM could not find a comment field and concluded there was
       * none — the Comment property was one level down the whole time.
       *
       * Where both define a property of the same name the workflow's is the
       * live one, since that is the set its own state declares editable.
       */
      properties: mergeTaskProperties(d).map((pr: any) => ({
        propertyId: String(pr?.propertyId ?? ""),
        name: String(pr?.name ?? ""),
        value: pr?.value ?? null,
        valueType: String(pr?.valueType ?? "STRING").toUpperCase(),
        editable: Boolean(pr?.editable),
        required: Boolean(pr?.required),
        enumValues: (Array.isArray(pr?.enumValues) ? pr.enumValues : []).map((e: any) => ({
          value: String(e?.value ?? ""),
          label: String(e?.label ?? e?.value ?? ""),
        })),
      })).filter((pr: any) => pr.propertyId),
      /*
       * Commentable means its workflow has a Comment property.
       *
       * Not "has a document", which is what this said while PLM was trying to
       * comment through `/comments`. A comment is a write to the workflow's
       * Comment property, so what decides it is whether the tenant's published
       * task workflow declares one — and Onshape's stock task workflow does.
       */
      /*
       * Onshape's own answer, not a guess. A task can be undeletable and
       * still discardable through its workflow — a live one was exactly that.
       */
      deletable: Boolean(d?.deletable),
      commentable: mergeTaskProperties(d).some(
        (pr: any) =>
          Boolean(pr?.editable) &&
          String(pr?.valueType ?? "").toUpperCase() === "STRING" &&
          /comment|note|remark/i.test(String(pr?.name ?? ""))
      ),
      raw: d ?? {},
    };
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
