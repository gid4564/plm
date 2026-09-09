import type { BomTable } from "./bom";
import type { ExportFormat } from "./export-formats";
import type { MassProperties } from "./mass-properties";

/** Stable identity of a part inside Onshape. */
export type PartCoords = {
  documentId: string;
  elementId: string;
  partId: string;
  configuration?: string;
  /** Context for building URLs; not part of identity. */
  workspaceId?: string | null;
  versionId?: string | null;
};

/** One enterprise custom-property definition. */
export type PropertyDef = {
  propertyId: string;
  name: string;
  valueType: string;      // STRING | ENUM | BOOL | INT | DOUBLE | DATE ...
  enumValues?: string[];
  builtIn?: boolean;
};

/** Part metadata as the MOS cares about it. */
export type PartMetadata = {
  coords: PartCoords;
  documentName: string;
  elementName: string;
  partName: string;
  partNumber: string;
  revision: string;
  description: string;
  material: string;
  state: string;
  vendor: string;
  project: string;
  /** propertyId -> value, verbatim. */
  raw: Record<string, unknown>;
  /**
   * Property definitions as reported on this part.
   *
   * Onshape returns name alongside propertyId on every metadata response, which
   * makes a real part the most reliable source of the enterprise's custom
   * property ids — there is no dependably documented company-level schema
   * endpoint.
   */
  definitions: PropertyDef[];
  /** Every property Onshape returned, name and value intact, for diagnostics. */
  properties: { propertyId: string; name: string; value: unknown }[];
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export type OnshapeUser = {
  id: string;
  email: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  /** The enterprise's own vanity URL (e.g. https://acme.onshape.com), if it has one. */
  companyDomain: string | null;
};

export type WebhookRegistration = {
  id: string;
  /** Events Onshape echoed back, which may be fewer than were requested. */
  events: string[];
};

export type WebhookSummary = {
  id: string;
  url: string;
  events: string[];
};

/**
 * Everything the MOS needs from Onshape. The mock and live implementations are
 * interchangeable; nothing above this interface knows which one is in play.
 */
export type Thumbnail = {
  contentType: string;
  data: Buffer;
};

export type ElementPart = {
  partId: string;
  partNumber: string;
  name: string;
};

export type DocumentInfo = {
  name: string;
  /** Where writes must go: a version is immutable. */
  defaultWorkspaceId: string | null;
  /**
   * Why the document could not be read, when it could not be.
   *
   * A BOM can reference parts from documents the caller has no direct access
   * to — reachable through the version the assembly pins, but not openable in
   * their own right. Without the reason, that is indistinguishable from a
   * document that simply has no default workspace.
   */
  accessError: string | null;
  /**
   * Whether this account may write to the document. null when Onshape did not
   * say, in which case callers should try and handle the refusal.
   *
   * Standard content — the library screws and washers Onshape supplies — lives
   * in a document everyone can read and nobody can write. It resolves to a
   * perfectly good default workspace, so a workspace alone is not evidence that
   * a write will be accepted.
   */
  canWrite: boolean | null;
};

/** An assembly tab, addressed for a BOM read. */
export type AssemblyCoords = {
  documentId: string;
  elementId: string;
  workspaceId?: string | null;
  versionId?: string | null;
  configuration?: string | null;
};

export type ElementInfo = {
  id: string;
  name: string;
  /** PARTSTUDIO | ASSEMBLY | DRAWING | BLOB | ... */
  elementType: string;
};

/** A part exported to a neutral CAD format. */
export type PartExport = {
  data: Buffer;
  contentType: string;
  /** How Onshape produced it, for the audit trail. */
  via: "direct" | "translation";
  /** Present when a translation job was used; useful when one goes wrong. */
  translationId?: string;
  elapsedMs: number;
};

/* -------------------------------------------------------------------------- */
/* Release management                                                          */
/*                                                                            */
/* Shapes here follow Onshape's release-package API as far as it is publicly   */
/* documented. Two things are deliberately modelled as data rather than        */
/* assumed in code:                                                           */
/*                                                                            */
/*  - `availableActions` — which transitions a package currently offers. Only  */
/*    REASSIGN_TASK is confirmed in Onshape's changelog; the approve and       */
/*    reject action names come from the tenant's own workflow JSON, so they    */
/*    are read off the package rather than hard-coded. See docs/ONSHAPE-       */
/*    INTEGRATION-SPEC.md, unknown U2.                                        */
/*  - `raw` — the whole response, kept because this part of the API is thinly  */
/*    documented and a field we did not know to look for is otherwise lost.    */
/* -------------------------------------------------------------------------- */

/** One transition a release package currently offers. */
export type WorkflowAction = {
  /** The identifier the transition call needs. */
  id: string;
  /** Human label, when Onshape supplies one. */
  label: string;
  /**
   * The action's type as the workflow declares it — APPROVE, REJECT, SUBMIT,
   * REASSIGN_TASK and so on. This is what the release logic matches on, rather
   * than the id, because ids are per-tenant but the types are the workflow
   * vocabulary.
   */
  type: string;
};

/** One item inside a release package. */
export type ReleasePackageItem = {
  /** Onshape's id for the item within the package. */
  id: string;
  documentId: string;
  elementId: string;
  /** Empty for a drawing or an assembly tab: those are elements, not parts. */
  partId: string;
  /** PARTSTUDIO | ASSEMBLY | DRAWING */
  elementType: string;
  name: string;
  partNumber: string;
  /** Onshape's revision record id for this item, present from rel-1.192. */
  revisionId: string;
  /** The revision letter, once the release has completed. Empty before that. */
  revision: string;
  /** The version the release produced, needed to export the released drawing. */
  versionId: string;
};

export type ReleasePackage = {
  /** Release package id (rpid). */
  id: string;
  /** Workflow id (wfid) the package runs on. */
  workflowId: string;
  /** Onshape's state name, e.g. PENDING, RELEASED, REJECTED. */
  state: string;
  /** The caller-supplied tracking id, which is how PLM finds its own release. */
  changeOrderId: string;
  items: ReleasePackageItem[];
  /** Workflow properties, keyed by property id. */
  properties: Record<string, unknown>;
  availableActions: WorkflowAction[];
  /** Onshape's own marker that a PLM system is handling this package. */
  syncedWithPLM: boolean;
  /** The complete response, for diagnosing a field this type does not cover. */
  raw: Record<string, unknown>;
};

/** The release workflow an enterprise releases through. */
export type ReleaseWorkflow = {
  id: string;
  name: string;
};

/** What PLM supplies when it raises a release package itself. */
export type CreateReleasePackageInput = {
  /** PLM's own release number, so the package can be traced back here. */
  changeOrderId: string;
  items: { documentId: string; elementId: string; partId?: string; revisionId?: string }[];
  /** Workflow properties, keyed by property id. */
  properties?: Record<string, unknown>;
};

/** A drawing tab, addressed for a PDF export. */
export type DrawingCoords = {
  documentId: string;
  elementId: string;
  workspaceId?: string | null;
  versionId?: string | null;
};

/** A file Onshape produced from an element. */
export type FileExport = {
  data: Buffer;
  contentType: string;
  /** How Onshape produced it, for the audit trail. */
  via: "direct" | "translation";
  /** Present when a translation job was used; useful when one goes wrong. */
  translationId?: string;
  elapsedMs: number;
};

export interface OnshapeClient {
  readonly mode: "mock" | "live";

  /** Identify what kind of tab an element is, before assuming it holds parts. */
  getElementInfo(coords: PartCoords): Promise<ElementInfo | null>;

  /**
   * Exploded bill of materials for an assembly.
   *
   * multiLevel walks subassemblies and rolls their quantities up, which is the
   * total a manufacturing order actually needs; the top-level-only view is
   * offered for assemblies that are bought or built as units.
   */
  getAssemblyBom(coords: AssemblyCoords, opts?: { multiLevel?: boolean }): Promise<BomTable>;

  /** Parts in an element, used to resolve a part number to a part id. */
  listElementParts(coords: PartCoords): Promise<ElementPart[]>;

  /** Document name and its default workspace. */
  getDocumentInfo(documentId: string): Promise<DocumentInfo>;

  /**
   * Export one part to a neutral CAD format.
   *
   * Some formats come straight off the part; the rest are produced by Onshape's
   * translation service, which is a job to be submitted and waited on. The
   * client hides that difference — callers ask for a format and get bytes.
   */
  exportPart(coords: PartCoords, format: ExportFormat): Promise<PartExport>;

  /** Mass, volume, surface area and centroid for one part. */
  getMassProperties(coords: PartCoords): Promise<MassProperties>;

  /** Rendered image of the part, or null when one cannot be produced. */
  getPartThumbnail(coords: PartCoords, size: number): Promise<Thumbnail | null>;

  getAuthenticatedUser(): Promise<OnshapeUser>;

  /** Enterprise custom-property definitions, used for name-based discovery. */
  listPropertyDefinitions(companyId: string): Promise<PropertyDef[]>;

  getPartMetadata(coords: PartCoords): Promise<PartMetadata>;

  /** Write propertyId -> value pairs onto a part. */
  updatePartProperties(coords: PartCoords, values: Record<string, unknown>): Promise<void>;

  registerWebhook(companyId: string, callbackUrl: string, events: string[]): Promise<WebhookRegistration>;
  /** Every webhook Onshape currently holds for this company. */
  listWebhooks(companyId: string): Promise<WebhookSummary[]>;
  unregisterWebhook(webhookId: string): Promise<void>;

  /* ----------------------------- Release management ---------------------- */

  /**
   * The release workflow this enterprise releases through.
   *
   * Needed before a package can be created or its transitions understood.
   * Returns null when the tenant has no custom workflow published, which is
   * a normal state and not an error — it just means releases cannot be taken
   * over yet.
   */
  getReleaseWorkflow(companyId: string): Promise<ReleaseWorkflow | null>;

  /** Read a release package, including the transitions it currently offers. */
  getReleasePackage(rpid: string): Promise<ReleasePackage>;

  /**
   * Perform a transition on a release package.
   *
   * `actionId` comes from the package's own availableActions — never from a
   * constant here. The tenant's workflow JSON decides what those are, and a
   * hard-coded "APPROVE" would work on one enterprise and fail silently on the
   * next. `properties` carries any workflow fields the transition requires,
   * such as the approver field an APPROVE transition reads.
   */
  transitionReleasePackage(
    rpid: string,
    actionId: string,
    opts?: { properties?: Record<string, unknown>; note?: string }
  ): Promise<ReleasePackage>;

  /** Raise a release package from PLM, rather than reacting to one. */
  createReleasePackage(wfid: string, input: CreateReleasePackageInput): Promise<ReleasePackage>;

  /**
   * Lightweight state check on any workflow object.
   *
   * Onshape added this as an explicit alternative to re-reading a whole release
   * package just to see where it is, so it is what the post-release poll uses.
   */
  getWorkflowObjectState(objectId: string): Promise<string>;

  /* --------------------------------- Drawings ---------------------------- */

  /** Every tab in a document, used to find the drawings belonging to a part. */
  listElements(coords: { documentId: string; workspaceId?: string | null; versionId?: string | null }): Promise<ElementInfo[]>;

  /**
   * Export a drawing to PDF.
   *
   * Asynchronous, like a part translation: submit, poll, fetch. Which
   * workspace or version is addressed decides what comes back — the same sheet
   * exported from a workspace has no revision or watermark, and exported from
   * the version a release produced has both.
   */
  exportDrawingPdf(coords: DrawingCoords): Promise<FileExport>;
}
