# PLM ⇄ Onshape integration — API spec for review

Written from Onshape's public documentation, changelog, help pages, forum, and the
official `onshape-public/inventory-oauth2-app` sample. **Nothing here is invented.**
Every claim carries a confidence marker:

- **[confirmed]** — stated in Onshape's own docs, changelog, or sample source.
- **[likely]** — from the forum or inferred from a changelog entry; the shape is
  probably right but the exact field names need one live call to be sure.
- **[unknown]** — I could not establish it from public sources. These are listed
  together at the end; each one needs either a live tenant or your knowledge.

MOS is the reference implementation for everything reused. Where a row says
"MOS ref A*n*", that is the row in `MOS/docs/onshape-api-calls.xlsx`.

---

## 1. Requirement 1 — Onshape connects to PLM with OAuth

This is a real, documented Onshape capability called **External OAuth**, and it
inverts the direction MOS uses. Onshape's own words: these extensions "rely on
External OAuth information to authenticate and make a call where **Onshape acts as
a client, and the application acts as a server**." **[confirmed]**

So PLM needs *both* halves:

| Direction | Role | Purpose | Status |
|---|---|---|---|
| PLM → Onshape | PLM is the OAuth **client** | PLM's own reads/writes: metadata, release packages, drawing PDFs, transitions | Reuse MOS `lib/onshape/oauth.ts` unchanged |
| Onshape → PLM | PLM is the OAuth **authorization server** | Onshape authenticates itself when calling PLM's extension action URLs | New |

### The part number generator is a batch endpoint

Onshape POSTs a JSON **array** to the Part number generator action URL and
expects an array back, one answer per element:

```
→ [ { id, documentId, elementId, workspaceId, elementType, partId }, … ]
← [ { …the same fields, partNumber: "PN-00042" }, … ]
```

**[confirmed]** — from Onshape's own reference implementation,
`onshape-public/inventory-oauth2-app`, whose `controllers/generator.js` assigns
`req.body` straight to a variable and reduces over it, pushing
`{ id, documentId, elementId, workspaceId, elementType, partId, partNumber }`
per element and answering `res.status(200).json(results)`.

Two consequences that are easy to get wrong:

- **A single object is not enough.** An earlier version of this route read the
  body as one object and answered with one object. Onshape's array then
  presented as a request carrying no fields at all — `elementType=-` with a
  perfectly valid bearer token — which reads as an authentication or
  configuration fault rather than a shape mismatch.
- **The batch is why validation happens before allocation.** A Release candidate
  dialog can ask for several numbers at once. Since a number is never reused,
  allocating for the readable items and then failing on a later one would burn
  numbers on a request that produced no answer, so the whole batch is classified
  first.

Unlike the context-menu extensions, this location offers **no choice of method
and no Action Body** in the Developer Portal. Onshape decides the payload, so
there is nothing to configure — and nothing to blame when it does not work.

### `elementType` arrives as an integer, and the mapping is undocumented

The live part-number payload sends `elementType: 0`, not the string
`"PARTSTUDIO"` that Onshape's reference sample implies. `resourceType` is also
an integer, and `mimeType` is `null` — so neither is a usable fallback.

I could not find the numeric mapping in Onshape's API documentation, its
samples, or its forum.

| Code | Meaning | Basis |
|---|---|---|
| `0` | Part Studio | **[confirmed]** — observed live, arriving with `partId: "JMD"`, and only a part carries a part id |
| `1` | Assembly | **[likely]** — PARTSTUDIO, ASSEMBLY, DRAWING is the order Onshape lists its string element types in throughout its docs |
| `2` | Drawing | **[likely]** — same reasoning |

Because 1 and 2 are inferences, `lib/onshape/element-type.ts` does not lean on
them. It prefers the **structure** of the request: a non-empty `partId`
identifies a part whatever the code claims, which is what made the live request
classifiable at all. The numeric table is the last resort, and its non-zero
entries are flagged as unconfident so the log says when a guess was made.

The full live payload, for reference:

```json
{ "id": "…", "elementType": 0, "workSpaceId": "…", "configuration": "default",
  "documentId": "…", "elementId": "…", "partNumber": "", "versionId": null,
  "partId": "JMD", "mimeType": null, "companyId": "…", "resourceType": 0,
  "categories": [] }
```

Note `workSpaceId` — **capital S** — where the sample uses `workspaceId`. Both
spellings are echoed back.

**To confirm 1 and 2:** request a number from an assembly and from a drawing, and
read the logged `elementType`. The log names the signal each classification came
from, so a wrong prefix says why.

### Onshape's own token endpoint refuses HTTP Basic

Worth stating because it contradicts the standard. RFC 6749 says an
authorization server **MUST** support HTTP Basic for client authentication and
that clients **SHOULD** prefer it, with form parameters as the fallback.
Onshape's `POST /oauth/token` does the opposite:

| Credentials sent as | Onshape answers |
|---|---|
| Form parameters (`client_id`, `client_secret` in the body) | **Accepted** |
| HTTP Basic | `401 unauthorized_client` |
| Both at once | `401 unauthorized_client` |

**[confirmed]** — established against the live endpoint with real credentials, by
sending a deliberately invalid authorization code and comparing which half
Onshape objected to. `invalid_grant` for the form-parameter form proves the
client authenticated; `unauthorized_client` for the other two proves it did not.
`scripts/check-onshape-oauth.mjs` re-runs that comparison on demand.

So `tokenRequest()` in `lib/onshape/oauth.ts` sends credentials in the body
deliberately, not as the lazier of two options — and sending Basic *as well*
makes it fail, so a well-meant "be standards-compliant" change here would break
the connection.

### The authorization-server contract

Taken from the sample app's `controllers/oauth2.js`, `models/code.js`, and
`server.js`. It is a plain OAuth2 server (the sample uses `oauth2orize`), with:

- **Grants: authorization code + refresh token.** Not client credentials — the
  sample has a `code` model and calls `oauth2orize.grant.code(...)` and
  `oauth2orize.exchange.refreshToken(...)`. **[confirmed]**
- **Endpoints PLM must expose** (paths are ours to choose; the sample's are shown
  for shape):
  - `GET /api/oauth2/authorize` — renders a consent dialog to the signed-in PLM user
  - `POST /api/oauth2/authorize` — records the consent decision
  - `POST /api/oauth2/token` — code and refresh exchange, client authenticated by
    its id/secret
- **Client registration.** PLM stores a client id + secret for Onshape. The sample
  does this via `POST /api/applications` with `{ name, clientId, clientSecret }`
  and notes "This keys will be used for oauth from onshape." **[confirmed]**
- **Validation on redemption**: client id must match the code's application, and
  the redirect URI must match the one the code was issued against. **[confirmed]**
- **Inbound guard**: Onshape then calls PLM's action URLs with
  `Authorization: Bearer <token>`. PLM resolves the token to the consenting user
  and their enterprise. **[confirmed by pattern]**
- Onshape surfaces this to the user as a second button, **"External access"**,
  when they enable the extension application. **[confirmed]**

**This replaces MOS's shared-secret-in-the-query-string for extension calls** — the
`ONSHAPE_NUMBERING_SECRET` hack in `MOS/src/app/api/numbering/onshape-extension/route.ts`.

### One place the secret-in-URL has to stay

**Webhooks cannot carry a bearer token.** Onshape's webhook registration accepts no
custom headers and offers no signature scheme, which is why MOS puts the token in
the callback URL. External OAuth applies to *extension action URLs*, not webhook
callbacks. PLM keeps the MOS approach for `/api/webhooks/onshape`, including the
`?ent=` tenant hint. **[confirmed for MOS; no evidence Onshape has changed it]**

---

## 2. Requirement 2 — PLM takes over the release

### What Onshape does and does not allow

Onshape Enterprise release workflows are defined by an **uploaded JSON workflow**
with `options` (including the revision scheme — alphabetical, numeric, or custom),
`properties`, `states`, and `transitions`. Actions available to a transition are
`markItemsPending`, `releaseItems`, and `obsoleteItems`. **[confirmed]**

Permissions inside that workflow: **submit** transitions are limited to the release
creator; **approve** and **reject** transitions are limited to designated approvers
or administrators. An `APPROVE`-type transition requires its source state to carry
an `approverSourceProperty`, and there may be at most one `APPROVE` transition out
of any source state. **[confirmed]**

The workflow engine itself has no notion of an external approver — Onshape's custom
workflow docs describe only internal users, teams, and roles. **[confirmed]**

**Therefore PLM cannot register itself as a workflow step.** It takes over by acting
*as an approver account* over the API — specifically, as an **Onshape service user**
that the enterprise nominates and names as a designated approver in its release
workflow JSON. That decision has been taken (it was formerly unknown U3), and it
shapes two things:

- **PLM's local accounts stay.** The person who approves is recorded in PLM and
  needs no Onshape seat; only the service user touches Onshape. A governance
  reviewer with no CAD licence is the normal case, not an edge case.
- **Setup gains a prerequisite.** If the service user is not a designated
  approver on the workflow, the transition is refused — and PLM reports exactly
  that, rather than a bare Onshape error.

### Proposed flow

```
Onshape                                    PLM
───────                                    ───
User opens Release candidate dialog
  │
  ├─ part number requested ──────────────▶ Part number generator extension
  │                                        (PLM is number master) ──┐
  │  ◀──────────────────────────────────────────────────────────────┘
  │
Release package created, state PENDING
  │
  ├─ webhook onshape.workflow.transition ─▶ /api/webhooks/onshape
  │                                          │
  │  ◀── GET /releasepackages/{rpid} ────────┤ read items, properties,
  │                                          │ revisionIds, available actions
  │                                          │
  │  ◀── POST /drawings/.../translations ────┤ pull as-submitted drawing PDFs
  │                                          │
  │                                          ├─ create/attach PLM objects,
  │                                          │  validate release-required
  │                                          │  attributes, open PLM release
  │                                          │
  │                                          ├─ PLM approval process runs here
  │                                          │  (PLM approvers, PLM states)
  │                                          │
  │  ◀── POST /releasepackages/{rpid} ───────┤ APPROVE (or REJECT) transition
  │                                          │
Revisions created, drawings watermarked      │
  │                                          │
  ├─ webhook onshape.revision.created ─────▶ │ re-pull drawing PDFs at the
  │                                          │ released revision, supersede
  │                                          │ the as-submitted copies
  │                                          │
  └─ PLM writes released state/rev back ◀────┘ POST /metadata/... (MOS ref A9)
```

### Endpoints this needs

| # | Method | Endpoint | Purpose | Confidence |
|---|---|---|---|---|
| R1 | GET | `/companies/{companyId}/policies` | Find the company's release workflow id (`wfid`) | **[likely]** — forum |
| R2 | GET | `/workflow/active` | Active workflows; carries `hasInactiveCustomWorkflows` | **[confirmed]** — changelog rel-1.178 |
| R3 | POST | `/releasepackages/release/{wfid}` | Create a release package. Body: `wfid`, `changeOrderId`, `items[]` (each with `id`, and `revisionId` since rel-1.192), `properties` | **[likely]** — forum + changelog rel-1.192 |
| R4 | GET | `/releasepackages/{rpid}` | Read the package: items, properties, available workflow actions, and `syncedWithPLM` | **[confirmed]** — changelog rel-1.168 |
| T1 | GET | `/tasks` | `getActionItems` — tasks assigned to a user. **Only a company admin can see tasks they neither created nor were assigned**, which decides what PLM can mirror. `status` is an undocumented integer (Onshape default 2); PLM omits it rather than guess. **`limit` is capped at 100 and enforced** — 200 earns a 400 naming `BTRestTask.getActionItems.limit`, so PLM pages with `offset` rather than asking for more. | **[confirmed]** from OpenAPI |
| T2 | GET | `/tasks/{tid}` | One task. Carries `comments[]`, `taskItems[]`, `users[]`, and a **`workflowInfo.workflow`** that is the *same* `BTWorkflowSnapshotInfo` a release package has — same `state` object, same `actions[]` with `{type, action, label}`. | **[confirmed]** from OpenAPI |
| T3 | POST | `/tasks/{tid}/{transition}` | Transition. The value is an action's **`action`** field from that snapshot, in the PATH — the same id-versus-type distinction that made the release transition fail silently. | **[confirmed]** endpoint and shape |
| T4 | POST | `/tasks/{tid}` | Update. `BTUpdateTaskParams` names the fields **`nameParamValue`** and **`descriptionParamValue`** — not `name`/`description`. The obvious pair would be accepted and ignored. | **[confirmed]** from OpenAPI |
| ~~T5~~ | POST | `/tasks/{tid}` | **Settled: a comment on a task is a WORKFLOW PROPERTY WRITE, not a `/comments` POST.** Onshape's own UI sends `POST /tasks/{tid}` with `propertyValues: [{propertyId: <Comment>, value: "<text>"}]`, and the task returns with the message appended to its `comments`. The Comment property lives in **`workflowInfo.properties`** — not the top-level `properties` — which is why three attempts at `/comments` failed (500, then 404, then 400 for every objectType) and why a probe of the top-level properties reported no comment field. Its id is the tenant's published task workflow's (`594964df040fc85d2b418145` on one tenant) so PLM matches it by name. Onshape clears the property after appending. Incidentally: the comment Onshape creates carries **`objectType: 10`**, not 14 — so `BTMetadataObjectType`'s ordinals are definitively **not** the comment API's codes. | Read off live network traffic |
| T7 | DELETE | `/tasks/{tid}` | `deleteTask` — "Delete a task by id." `tid` in the path, no body. Irreversible. **Absent from the anonymous OpenAPI definition and present in the authenticated one**, which is why it reads as unpublished; `BTTaskInfo.deletable` says per task whether it will work, and a live task came back `deletable: false` with `canBeDiscarded: true` — for those the way out is the workflow's `OS_DISCARD` transition, not this. | **[confirmed]** from Glassworks |
| T7b | — | Deletability, measured | **`DELETE /tasks/{tid}` is close to unusable on a real tenant.** Across the 18 tasks one tenant's PLM held, Onshape reported **`deletable: false` for every single one**, and `canBeDiscarded` for none. 6 of the 18 would not even answer a read (500). Of the 12 readable, only the 2 still open offered any action at all — `OS_DISCARD` (type `DELETE`) — and the 10 closed ones offered nothing. So the way to clear a task is the **workflow's DELETE-type transition**, not the delete endpoint; PLM tries the endpoint where `deletable` is true and falls back to that transition otherwise. A discarded task still exists in Onshape, which is why PLM counts discards separately from deletions. Note also that a discarded task lands in a state named for it, and `columnFor` matched nothing on it and defaulted to "Open" — so a task PLM had just discarded came straight back onto the board as outstanding work. | **[confirmed]** live, 18 of 18 |
| — | — | The orphan trap | A task that fails to hydrate must be **skipped, not stored from its list summary**. PLM used to fall back on "the summary is better than nothing", and that is what filled the tenant with junk: the stored row had no name, no workflow state (a raw `TASK_OPEN` instead) and no transitions, so it could not be acted on — and since Onshape would not delete it either, it could not be got rid of. Those rows are why the delete appeared broken. |  **[confirmed]** live |
| T8 | POST | `/tasks/find` | `findTasks` — **the answer to `getActionItems` showing only your own tasks.** On the tenant PLM was built against `getActionItems` returned **8** tasks and this returned **174**. Marked `x-BTVisibility: INTERNAL`, so it is in the authenticated definition only. Three things about it are not guessable and each cost a round to find: (1) **paging is in the BODY** (`from`, `size`) — Onshape's own `next` URL carries `offset`/`limit` and **both are ignored**, so `limit=5` returns 40 rows and `offset=5` returns the same rows as `offset=0`; following that URL silently re-reads page one for ever. (2) The rows are a **search projection, not `BTTaskInfo`**: `taskItems` in place of `items`, `state` as a display string, `properties: null`, and **no `workflowInfo` at all** — so a board built from them would offer transitions the task does not have. PLM takes the ids and hydrates each with T2, keeping one parser. (3) `BTTaskSearchRequestParams.query` is **self-referential in the definition** (`{empty, field, querySupplier: Query}`) and cannot be constructed from it — PLM sends no query at all, and an empty body returns everything. A browser session also needs the CSRF header `X-XSRF-TOKEN-<userId>` matching the same-named cookie (a bare POST is a **401 with an empty body**, which reads exactly like the endpoint refusing internal access — it is not); OAuth callers need nothing extra. | **[confirmed]** live, 174 rows |
| — | — | What `find` drags in | Of those 174: **143 were `taskType: RELEASE`** — release-package workflows PLM already mirrors as releases with their own page and numbering. Listing them on a task board would bury the 31 real tasks and show one record under two names, so PLM syncs `GENERAL` and `TODO` only (`TASK_TYPES_PULLED`, overridable with `ONSHAPE_TASK_TYPES`). And **7 of the 31 real tasks are orphaned records** — a null name, a null state, and `GET /tasks/{tid}` answers **500** — so anything that trusts the search and then hydrates has to survive them rather than store a nameless, actionless card. | **[confirmed]** live |
| — | — | How a task points at CAD | **Not through its own `documentId`/`elementId`** — across the 31 real tasks only 4 had a `documentId` and **none** had an `elementId`. The link is in **`taskItems[]`**, each carrying `documentId`, `elementId` and `partId` (Onshape's short part id, e.g. `JiD`); 16 of 31 had items and 14 of those a real `partId`. So "the tasks against this part" is a join on the item triple, and document-and-element alone is not enough: it would attach a task about one part in a Part Studio to every part in it. | **[confirmed]** live |
| — | — | Other unpublished task endpoints | The authenticated definition also carries **`POST /tasks/{tid}/close`** (`closeTask`, `description` in the query, described as for Onshape Admin use) and **`GET /tasks/object/{id}`** (`getTasksByObjectId` — tasks against a given object). Neither is used: PLM answers "tasks about this part" from its own mirror, since the links arrive resolved with the task and a part page should not wait on a network call to render. | **[confirmed]** present, unused |
| T6 | POST | `/tasks/{tid}` | **A task's properties live in TWO places and must both be read.** `properties` holds the metadata schema's (Name, Description, Category, State, Due date, Completed date, Priority); **`workflowInfo.properties`** holds the workflow's (Name, Description, **Comment**, **Assigned to** as `TASK_APPROVERS`, valueType `USER`). PLM merges them by id, workflow last. A task's due date, priority and task state are PROPERTIES, not fields — A live task carries 8: Name, Description, Category, State (read-only ENUM), Due date, Completed date (read-only), Priority, Task State. Each has a `propertyId`, a `valueType`, `enumValues` where it is an enum, and its own `editable` flag — `State` is the workflow's and Onshape owns it. Written back through `BTUpdateTaskParams.propertyValues` as `[{propertyId, value}]`. This is why PLM's first task UI had no due date at all. | **[confirmed]** from a live task |
| T9 | — | A task has TWO notions of progress | **Onshape's stock task workflow has no in-progress state and no transition that starts work.** An open task offers exactly `COMPLETE(APPROVE)` and `OS_DISCARD(DELETE)`; the states are `OPEN` and `COMPLETE`. Progress lives in the **"Task State" property** instead — an editable ENUM whose live options are `0=New, 1=Assigned, 2=In Work, 3=Completed, 5=Closed, 6=Canceled` (note the **gap at 4**: a published list, not a dense range). So a board's "In Progress" column is a **property write**, not a transition, and a column read from the workflow state alone can never show it. PLM asked for a "start" transition and reported, accurately and uselessly, that the task offered none. Two consequences: the column must be derived from **both** (workflow decides finished/not, the property promotes an unfinished task to In Progress) or a moved card springs back to Open on the next refresh; and the enum must be matched **by label in preference order**, because a single alternation tests the tenant's options in *their* order — asking for "assigned" against `(New, Assigned, …)` returns **New**, silently un-assigning the task. | **[confirmed]** from a live task |
| R5 | POST | `/releasepackages/{rpid}` | Transition the package: the workflow action is the **`wfaction` query parameter** — `RELEASE` to approve, `REJECT` to reject; also `SUBMIT`, `OBSOLETE`, `DISCARD`, `CREATE_AND_RELEASE`, `CREATE_AND_OBSOLETE`, and workflow-defined values for a custom workflow. The separate **`action`** query parameter means something else entirely (`UPDATE \| ADD_ITEMS \| REMOVE_ITEMS \| SAVE_DRAFT`, default `UPDATE`), and sending the workflow action there earns a 200 and an empty update. Body is required and is `BTUpdateReleasePackageParams`: `itemIds`, `items`, `properties` (an array of `{propertyId, value}`) — **no comment field**. | **[confirmed]** from Onshape's published OpenAPI (`cad.onshape.com/api/openapi`, `updateReleasePackage`) |
| R6 | GET | `/workflow/obj/{objectId}` | Lightweight state check — "a lightweight alternative to get status on a release package" | **[confirmed]** — changelog rel-1.200 |
| R7 | GET | `/revisions/...` | Revision history for an item | **[confirmed]** |

Note on R5: because rel-1.193 made the server add active drawings to a release
package automatically, **the drawings arrive in the package without PLM asking** —
which is what makes requirement 5 tractable.

### Webhook events

| Event | Meaning | Use |
|---|---|---|
| `onshape.workflow.transition` | "Occurs when a revision **or release package** transitions through workflow states" **[confirmed]** | Primary trigger for the release takeover |
| `onshape.revision.created` | "Occurs when a revision is created" **[confirmed]** | Trigger for the post-release drawing refresh |
| `onshape.model.lifecycle.metadata` | "Occurs when part or element metadata is modified" **[confirmed]** | Property sync, as MOS |
| `onshape.model.lifecycle.createversion` | New document version **[confirmed]** | Optional: pre-release sync trigger |

---

## 3. Requirement 5 — drawing PDFs, before and after release

Drawing export is the translation API, asynchronous, exactly like MOS's STEP/IGES
export (MOS refs A13–A15) — so the polling machinery already exists and is reusable.

| # | Method | Endpoint | Purpose | Confidence |
|---|---|---|---|---|
| D1 | POST | `/drawings/d/{did}/{w\|v}/{wvid}/e/{eid}/translations` | Submit a drawing → PDF job. Body: `formatName: "PDF"`, `storeInDocument: false`, optional `destinationName` | **[confirmed]** |
| D2 | GET | `/translations/{translationId}` | Poll `requestState` | **[confirmed]** — MOS ref A14 |
| D3 | GET | `/documents/d/{did}/externaldata/{externalId}` | Download the produced PDF | **[confirmed]** — MOS ref A15 |
| D4 | GET | `/translationFormats` | Confirm PDF is available for this tenant | **[confirmed]** |

**Why two passes.** Your point 5 is right and it falls out of the API cleanly: the
first export is taken at the workspace or the release-candidate version, so it has
no released revision, no watermark, and unfilled title-block fields. After the
release completes, the drawing exists at a new version with the revision applied, so
the same three calls against `v/{versionId}` produce the real released PDF. The
`onshape.revision.created` webhook is the trigger to do it — PLM does not have to
poll.

---

## 4. Requirement 6 — app extensions

Every location below is confirmed present in Onshape's extension documentation, with
its type and its placeholder tokens. **[confirmed]**

| Location | Type | Tokens available | PLM use |
|---|---|---|---|
| Element right panel | iFrame | `documentId`, `workspaceOrVersion`, `workspaceOrVersionId`, `elementId`, `partId`, `configuration`, `nodeId`, `occurrencePath`, `featureId` | Part panel — sync to PLM, show PLM attributes/state/revision. Direct port of MOS `/panel` |
| Element right panel (Assembly) | iFrame | same | BOM sync panel. Direct port of MOS `/panel/assembly` |
| Part number generator | Action URL | JSON body: `partNumberId`, `documentId`, `elementId`, `workspaceId`, `elementType`, `partId`, `companyId`, `partNumber`, `configuration`, `categories` | PLM is number master. Available "from all the places where we set part numbers, **including the Release candidate dialog**" — which is how a PLM number lands on a part at release time. One per application |
| Element context menu | Action URL | `documentId`, `workspaceOrVersion`, `workspaceOrVersionId`, `elementId`, `partNumber`, `mimeType`, `configuration` | "Send to PLM" on a tab |
| Tree context menu | Action URL | `+ featureId`, `nodeId`, `occurrencePath`, `partId` | "Send to PLM" on a part or instance |
| Document list context menu | Action URL | `documentId`, `elementId`, `partId`, `partNumber`, `revision`, `configuration` | "Send to PLM" / "Open in PLM" from the document list |
| Document list info panel | iFrame | `documentId`, `elementId`, `partId` | PLM status beside the document list |
| Element tab | iFrame | `documentId`, `workspaceId`, `versionId`, `elementId` as plain query params, **no token substitution** | Full PLM browser inside a document. One per application |

Two carry-overs from MOS that matter here:

- **Unsubstituted tokens must be stripped.** Onshape does not fill every `{$token}`
  in every context — an element with no configurations leaves `{$configuration}`
  verbatim, and passing that on makes the follow-up metadata call fail with a 400.
  MOS handles this in `panel/page.tsx`; PLM must too.
- **`APP_BASE_URL` must be public HTTPS**, or the panel iframe cannot hold a session
  (cookies need `SameSite=None`).

---

## 5. Reused from MOS without material change

| Piece | File | Note |
|---|---|---|
| Onshape client interface + mock/live split | `lib/onshape/{types,factory,live-client,mock-client}.ts` | The reason a demo can run with no live tenant. Extend the interface with release-package and drawing-PDF methods |
| Outbound OAuth + token refresh | `lib/onshape/oauth.ts` | Unchanged |
| Webhook receiver, tenant resolution, echo suppression | `api/webhooks/onshape/route.ts`, `SelfWrite` | Always-200 discipline, `?ent=` tenant hint, self-write fingerprints |
| Name-based property discovery | `lib/onshape/{properties,standard-properties}.ts` | Including the enum-label resolution that stops a released part reading as obsolete |
| BOM read and import | `lib/onshape/bom.ts`, `lib/bom-import.ts` | Feeds requirement 4 |
| Thumbnails, mass properties, part export | as named | Unchanged |
| Translation job polling | inside `live-client.ts` `exportPart` | Reused verbatim for drawing PDFs |
| Cursor pagination, session/auth, UI kit | `lib/pagination.ts`, `lib/auth/*`, `components/ui.tsx` | Unchanged |

---

## 6. Unknowns — these need a live tenant or your input

| # | Unknown | Why it matters | How to settle it |
|---|---|---|---|
| **U1** | The discriminator in an `onshape.workflow.transition` payload that says *release package* rather than *revision*. Onshape's webhook docs show no example payload for this event and document no discriminating field. | PLM routes the whole release takeover off this event. **A hypothesis that this had caused a live failure was tested and disproved:** the id PLM stored (`5643bba910b9535588b6772b`) is a genuine, fully populated release package, so `releasePackageIdFrom`'s fallback to `objectId` had not misfired. U1 remains open but is not known to have broken anything. | Log one real transition. `dump-release-package.mjs` cross-checks a stored id against `/workflow/obj/{id}`, which answers only for a workflow object |
| ~~U2~~ | ~~The action enum values on `POST /releasepackages/{rpid}` for approve and reject, and which field of the GET response carries them~~ | **Settled** from a live enterprise package, 2026-09-10. | **The actions are at `workflow.actions`** — not `actions`, `workflowActions` or `availableActions`, which is why PLM read none and refused a release. Each action carries a `type` **and a separate `action` id, and they differ**: approve is `{type: "APPROVE", action: "RELEASE", label: "Release"}`, reject is `{type: "REJECT", action: "REJECT"}`, and a live package also offers `{type: "DELETE", action: "DELETE", alwaysAllow: true}`. **So the value to POST for an approval is `RELEASE`.** Also confirmed on the same payload: `workflow.state` is an **object** (`{name: "PENDING", displayName: "Pending", approverSourceProperty}`) — reading it as a string is what produced state `\"\"`; `workflowId` is an **object** `{companyId, workflowId, versionId}`, so `String()` of it yields `"[object Object]"`; `properties` is an **array** of `{propertyId, value, name, valueType}`, not a record; and `syncedWithPLM` is a per-**item** field, with `workflow.usesExternalPlm` the package-level equivalent. Pinned as a fixture in `scripts/test-release-package-parse.ts` |
| ~~U3~~ | ~~Whether a non-human integration account can perform an `APPROVE` transition~~ | **Settled.** An Onshape **service user** performs the approval. | **Resolved by decision, not investigation.** The enterprise nominates an Onshape service user, and that user is named as an approver in the release workflow JSON. `decideRelease` records the decision against the PLM person who made it and performs the Onshape transition as the service account — see the two-actor note in `lib/release.ts`. **Setup requirement:** the service user must be a designated approver on the workflow, or the transition is refused. PLM reports this as the *likely* cause only when the package reports a state and offers no transitions — a package reporting no state at all was not read properly, and saying "configure an approver" there sent a user to reconfigure a workflow that may have been correct. See `explainMissingTransition`. |
| **U4** | Whether `syncedWithPLM` is writable by a third-party app or reserved for the Arena connection. **Partly answered:** it is not a package-level field at all — it sits on each *item* (`false` on a live package), and the package-level marker is `workflow.usesExternalPlm` (also `false`). Reading the top level, as PLM did, could only ever yield false. | If writable, it is the correct way to mark packages PLM owns. | Attempt a write on a live package item; the read shape is now [confirmed] |
| **U5** | Whether the released drawing must be exported against the new `versionId` or whether the revision id is addressable directly. | Determines the post-release PDF re-pull. | `GET /revisions/...` on a released drawing |
| **U6** | Exact request body of `POST /releasepackages/release/{wfid}` beyond `wfid`, `changeOrderId`, `items[]`, `properties`. Onshape's own forum answer says "This section of the API does not seem well documented." | Only needed if PLM ever *originates* a release rather than reacting to one. | Mirror the shape of a package created through the UI |

### Tasks

**There is no task-specific webhook event.** Onshape's published event list has
no `onshape.task.*` at all. A task is a workflowable object, so its transitions
arrive on **`onshape.workflow.transition`** — the same event as a release
package and a revision, with the same missing discriminator (U1). PLM's
receiver therefore tries the id as a release package, then asks Onshape whether
it is a task, rather than assuming which it holds.

Comments written in Onshape arrive on **`onshape.comment.create`** /
`.update`, which fire for comments on anything. The receiver checks whether the
commented object is a task PLM mirrors and ignores the rest without logging one
line per comment in the tenant.

Because the task's workflow snapshot is byte-identical to a release package's,
the parsing lives in one place — `lib/onshape/workflow-snapshot.ts`. The
release-package version of that took four wrong hypotheses and a read of the
OpenAPI definition to get right; a second copy for tasks would have been a
second chance to get it wrong differently.

### Gateway errors are not API errors

`502`, `503` and `504` with an HTML body come from a proxy in front of Onshape,
not from its API. Nothing about the request produces them and the same call
usually succeeds seconds later. This cost two rounds of changes to a request
body that was already correct, because the failing call was the only one being
watched — the giveaway was an unrelated `GET /releasepackages/...` returning the
same 502 HTML in the same minute.

PLM retries a **GET** through a gateway error (400ms, 1.2s, 3s) and does **not**
retry anything else: a POST that may already have taken effect must not be
repeated, since a duplicated comment or a double-applied transition is worse
than an error. The message names it a gateway and drops the HTML rather than
pasting markup into something a person reads. A 200 carrying an HTML body is
treated the same way, instead of surfacing as "unexpected token <".

### The authenticated OpenAPI definition carries more than the anonymous one

`https://<tenant>.onshape.com/api/openapi` returns **more paths when fetched
with a session** than anonymously. Anonymously the Task section has three
endpoints; authenticated it has nine — including the delete, the search and the
per-object listing above. Anything that looks unpublished is worth re-checking
from an authenticated context before being treated as absent, and Glassworks
(`/glassworks/explorer`) renders exactly that authenticated set.

### Onshape publishes its OpenAPI definition

`https://cad.onshape.com/api/openapi` returns the full API definition (~1.9MB
JSON), unauthenticated. It is the authority for parameter names, request
schemas and enum values, and it settled in one read what four hypotheses had
failed to: the transition action is a query parameter, not a body field.

It should be consulted **before** reasoning about a thin-looking endpoint. Three
things it corrected here, each of which had produced a silent failure rather
than an error:

- **`wfaction` vs `action`** — see R5 above. A workflow action in the body is
  accepted and ignored.
- **`changeOrderId` is read-only.** It appears on `BTReleasePackageInfo` but not
  on `BTReleasePackageParams`, so PLM's release number never reached Onshape.
  The comment claiming a package "can be traced back here" by it described a
  mechanism that did not exist; the package id always did that work.
- **`addAllDrawingsActive` is read-only too**, and the create request accepts
  nothing but `items`. Onshape adds active drawings to a candidate raised
  through its own dialog, but *not* to one created through the API — so a
  release raised from PLM contained no drawing, and the missing drawing
  association on the part page was the visible symptom.

It also confirms `elementType` is an `integer` on
`BTReleasePackageItemInfo`/`Params`, `BTNextPartNumberParam`, `BTRevisionInfo`
and others — but documents **no enum values** for it anywhere. Codes 1 and 2
therefore remain inferred, and `classify` is right to mark them unconfident.

U1, U2 and U3 are settled — U1 from a live webhook payload, U2 from a live
package and the OpenAPI definition, U3 by
decision. None of the rest block progress: the mock client
implements the flow end to end, and each remaining unknown is one live call away
from being pinned down.

---

## Sources

- Extensions: https://onshape-public.github.io/docs/app-dev/extensions/
- Webhooks: https://onshape-public.github.io/docs/app-dev/webhook/
- Changelog: https://onshape-public.github.io/docs/changelog/
- OAuth2: https://onshape-public.github.io/docs/auth/oauth/
- Translation: https://onshape-public.github.io/docs/api-adv/translation/
- Drawings: https://onshape-public.github.io/docs/api-adv/drawings/
- External OAuth sample: https://github.com/onshape-public/inventory-oauth2-app
- Custom release workflow: https://cad.onshape.com/help/Content/custom_workflow.htm
- Designing release processes: https://cad.onshape.com/help/Content/relmgmt_custom.htm
- Release packages in the API (forum): https://forum.onshape.com/discussion/22064/
