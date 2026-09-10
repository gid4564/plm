# PLM — deployment and Onshape setup

Two halves: standing the app up, and registering it with Onshape. The second is
the fiddly one, because PLM needs Onshape configured in **three** places that
are easy to confuse.

---

## What you need

- Node 20+ and MongoDB 6+ (Atlas is fine)
- A public **HTTPS** hostname Onshape can reach
- An Onshape **Enterprise** plan, for the release workflow and custom properties
- An Onshape Developer Portal application

---

## 1. The app

```bash
npm install
npm run build      # emits .next/standalone — a self-contained server
npm start          # or run .next/standalone/server.js under a supervisor
```

Copy `.env.example` to `.env.local` and fill it in. Two settings matter more than
the rest:

**`APP_BASE_URL`** is the one most often got wrong. It must be the public HTTPS
URL — not localhost, not the internal port. It determines the OAuth redirect URI,
the webhook callback given to Onshape, the extension action URLs, and whether
session cookies are issued `SameSite=None`. If it is not `https://`, the Onshape
panel cannot hold a session and appears permanently signed out.

**`SESSION_SECRET`** must be at least 16 characters and stable across restarts.
Changing it signs everyone out.

The build is portable: `output: "standalone"` traces only the modules actually
needed, and `sharp` is excluded so a macOS build runs unchanged on Linux.

---

## 2. Onshape → PLM: the three things to configure

This is where the two directions of OAuth get confused, so they are separated
here explicitly.

### (a) PLM calling Onshape — an OAuth *client*

PLM reads metadata, exports drawings and transitions release packages. It does
that as an ordinary OAuth client of Onshape.

In the Developer Portal, create an OAuth application and set:

| Field | Value |
|---|---|
| Redirect URL | `https://YOUR-HOST/api/onshape/oauth/callback` |
| Scopes | `OAuth2Read`, `OAuth2Write`, `OAuth2ReadPII` |

Put the client id and secret in `ONSHAPE_CLIENT_ID` / `ONSHAPE_CLIENT_SECRET`.
Then each user presses **Connect Onshape** in PLM's Settings.

### (b) Onshape calling PLM — an OAuth *server*

Onshape's extension action URLs use **External OAuth**: Onshape is the client and
PLM is the authorization server. PLM issues Onshape a client id and secret.

1. In PLM: **Settings → How Onshape authenticates to PLM → Register**. Copy the
   client id and secret — the secret is shown once and stored only as a hash.
2. In the Developer Portal, on the same application, fill in the External OAuth
   settings with that id and secret plus:

| Field | Value |
|---|---|
| Authorization URL | `https://YOUR-HOST/api/oauth/authorize` |
| Token URL | `https://YOUR-HOST/api/oauth/token` |

Onshape shows users an **External access** button when they enable the
application; approving it sends them through PLM's consent screen once.

### (c) The webhook — a shared secret, not a token

Webhooks are the exception. Onshape's webhook registration accepts no custom
headers and offers no signature scheme, so there is nowhere to put a bearer
token. The secret rides in the registered callback URL instead.

Set `ONSHAPE_WEBHOOK_SECRET` to a random string, then press **Register** under
Settings → Webhook. PLM builds the callback URL itself, including the secret and
the enterprise id — that id is how a delivery is attributed, because Onshape does
not reliably send `companyId`.

PLM subscribes to three events:

| Event | What PLM does |
|---|---|
| `onshape.workflow.transition` | Takes over a release package |
| `onshape.revision.created` | Collects the released drawing sheets |
| `onshape.model.lifecycle.metadata` | Keeps mirrored attributes current |

If releases are not reaching PLM, look in the activity log: the receiver records
every unhandled event with its payload keys, which is usually enough to identify
what your workflow actually emits.

---

## 3. App extensions

Register these in the Developer Portal against the same application. Settings
shows the exact URLs for your host, ready to copy.

| Location | Type | Path |
|---|---|---|
| Element right panel (Part Studio) | iFrame | `/panel?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}&partId={$partId}&configuration={$configuration}` |
| Element right panel (Assembly) | iFrame | `/panel/assembly?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}` |
| Part number generator | Action | `/api/numbering/onshape-extension` |
| Element context menu | Action | `/api/extensions/send-to-plm?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}` |
| Tree context menu (part) | Action | `/api/extensions/send-to-plm?…&partId={$partId}&configuration={$configuration}` |
| Document list context menu | Action | `/api/extensions/send-to-plm?documentId={$documentId}&elementId={$elementId}&partId={$partId}` |

Notes that save time:

- Onshape leaves a `{$token}` **verbatim** when it has nothing to substitute — an
  element with no configurations sends the literal `{$configuration}`. PLM strips
  anything still shaped like a placeholder; if you write your own caller, do the
  same, because passing one on makes Onshape reject the follow-up call with a 400.
- The part number generator is limited to **one per application**, and it fires
  from every place a part number is set — including the Release candidate dialog,
  which is the useful one.
- The panels are framed from `cad.onshape.com`, so they are a third-party context.
  The CSP for `/panel/*` allows that; everything else stays frame-denied.

---

## 4. Release workflow prerequisites

PLM cannot be a step in an Onshape workflow — Onshape's workflow engine has no
concept of an external approver. It acts on the release package over the API
instead, as a nominated Onshape **service user**.

That user must be a **designated approver** on your release workflow, or every
approval will be refused. Onshape restricts approve transitions to designated
approvers.

1. Nominate the service user: **Settings → Release management → Act as**. It must
   have pressed *Connect Onshape* first.
2. Add that user as an approver in your Onshape release workflow JSON
   (Onshape: Enterprise settings → Release management).
3. **Discover the release workflow** in PLM Settings.
4. Turn on **Take over releases raised in Onshape**.

If step 2 is missed, PLM reports it in plain terms rather than passing through a
bare Onshape error — the release detail page names the transitions the package
actually offered.

---

## 5. Checking it works

In order, and each one tells you something different:

1. **Settings → Run discovery.** Every attribute should be *bound* or *PLM-only*.
   Anything *not found* names a property your tenant does not have.
2. **Open the panel on a part in Onshape.** If it says you are signed out after
   signing in, `APP_BASE_URL` is not HTTPS.
3. **Sync a part.** Its PLM number should appear on the Onshape part within a
   second or two.
4. **Edit a property in Onshape.** The part page should show the change, and its
   iteration should advance.
5. **Raise a release candidate in Onshape.** A release should appear in PLM,
   Under Review, with the drawings attached and an as-submitted PDF captured.
6. **Approve it.** Onshape should create revisions, and PLM should collect the
   as-released sheets within a moment.

Every step is recorded in the activity log with its direction and trigger, so a
step that did nothing can be told apart from one that was never attempted.

---

## Operating notes

**Database.** One collection per object, all scoped by `enterpriseId`. Drawing
PDFs and part thumbnails are stored as document fields, which caps a sheet at
Mongo's 16MB limit — ample for a drawing, and it avoids standing up GridFS. A
sheet over the limit is recorded as a failure with the reason rather than
truncated.

**Rate limits.** Onshape rate-limits per account and the limit is shared with
everyone on the tenant. PLM is careful about this: document and element lookups
are cached for five minutes, thumbnails for seven days, translation polling uses
a fixed schedule rather than a tight loop, and bulk re-sync runs 25 at a time.
`docs/onshape-api-calls.xlsx` in the MOS project documents the call cost of each
operation; the same figures apply here except for the release and drawing paths.

**Multi-tenancy.** One PLM instance serves many Onshape companies. Tenancy is
keyed on `onshapeCompanyId`, and a webhook is attributed by the enterprise id in
its callback URL rather than by the payload.

**Upgrades.** No migrations are needed for additive schema changes. After a
change that affects mapped attributes, run **Re-read everything from Onshape** in
Settings — a newly mapped attribute holds nothing until something re-reads the
parts.
