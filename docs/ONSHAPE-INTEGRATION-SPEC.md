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
| R5 | POST | `/releasepackages/{rpid}` | Update / transition the package. Action enum includes `REASSIGN_TASK`; `addAllDrawingsActive` was deprecated at rel-1.193 because the server now adds drawings itself | **[confirmed] endpoint, [unknown] approve/reject enum values** |
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
| **U1** | The discriminator in an `onshape.workflow.transition` payload that says *release package* rather than *revision*. Onshape's webhook docs show no example payload for this event and document no discriminating field. | PLM routes the whole release takeover off this event. | Log one real transition. MOS already logs every payload's keys before routing for exactly this reason |
| **U2** | The action enum values on `POST /releasepackages/{rpid}` for approve and reject. Only `REASSIGN_TASK` is confirmed, from changelog rel-1.169. | This is the call that completes the release. | `GET /releasepackages/{rpid}` returns the available workflow actions — read them off a live package |
| ~~U3~~ | ~~Whether a non-human integration account can perform an `APPROVE` transition~~ | **Settled.** An Onshape **service user** performs the approval. | **Resolved by decision, not investigation.** The enterprise nominates an Onshape service user, and that user is named as an approver in the release workflow JSON. `decideRelease` records the decision against the PLM person who made it and performs the Onshape transition as the service account — see the two-actor note in `lib/release.ts`. **Setup requirement:** the service user must be a designated approver on the workflow, or the transition is refused with a message saying so. |
| **U4** | Whether `syncedWithPLM` on a release package is writable by a third-party app or reserved for the Arena connection. | If writable, it is the correct way to mark packages PLM owns. | Inspect and attempt a write on a live package |
| **U5** | Whether the released drawing must be exported against the new `versionId` or whether the revision id is addressable directly. | Determines the post-release PDF re-pull. | `GET /revisions/...` on a released drawing |
| **U6** | Exact request body of `POST /releasepackages/release/{wfid}` beyond `wfid`, `changeOrderId`, `items[]`, `properties`. Onshape's own forum answer says "This section of the API does not seem well documented." | Only needed if PLM ever *originates* a release rather than reacting to one. | Mirror the shape of a package created through the UI |

U3 is settled by decision. None of the rest block progress: the mock client
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
