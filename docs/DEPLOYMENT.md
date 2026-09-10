# PLM — deployment and Onshape setup

Two halves: standing the app up, and registering it with Onshape. The second is
the fiddly one, because PLM needs Onshape configured in **three** places that
are easy to confuse.

---

## What you need

**On the machine you build on** — Node 20+, and enough RAM for `next build`
(roughly 2GB free).

**On the server** — Node 20+ and pm2. No npm install, no build toolchain, and
about 60MB of disk. MongoDB 6+ somewhere it can reach; Atlas is fine, but
whitelist *the server's* IP, not your laptop's.

**From Onshape** — a public **HTTPS** hostname Onshape can reach, an
**Enterprise** plan (for the release workflow and custom properties), and a
Developer Portal application.

---

## 1. The app: build here, ship a tarball

**Do not build on the server.** `next build` needs well over a gigabyte of RAM
to compile, which the server does not have. The traced output runs in a fraction
of that, so the build happens on a workstation and the server receives finished
JavaScript — no npm install, no devDependencies, no build step, ~52MB on disk.

```bash
./scripts/package-release.sh
```

That typechecks, builds, assembles `dist/plm/`, and packs
`dist/plm-release.tar.gz` (~10MB). It refuses to ship rather than produce a
bundle that will fail on the server:

| Refuses when | Because |
|---|---|
| A dev server is listening on 3011 | It writes into `.next` mid-build, mixing development chunks into the bundle |
| `.next/static/development` or hot-update chunks are present | Same contamination, caught after the fact as well as before |
| `tsc --noEmit` fails | A type error would otherwise surface on the server, where there is no toolchain to diagnose it |
| Any `.node`, `.dylib` or `.so` was traced in | A host-specific binary would not survive the trip from macOS to Linux |
| `server.js` is missing | The only failure that would otherwise appear as a pm2 crash loop |

The bundle is portable because `next.config.ts` sets `output: "standalone"` and
excludes `sharp` — nothing in it is compiled for the build host.

### Deploying it

The bundle carries its own installer, so this is two commands on the server:

```bash
scp dist/plm-release.tar.gz user@server:/tmp/
```

```bash
ssh user@server
tar -xzf /tmp/plm-release.tar.gz -C /tmp
/tmp/plm/deploy.sh              # shows what would change, changes nothing
/tmp/plm/deploy.sh --apply
```

It installs into **`/home/gid/apps/plm`** (override with `PLM_DEST`), restarts
pm2, and then confirms that the build answering on port 3005 is the one just
deployed.

**First deploy only** — it will tell you `.env.local` is missing and stop:

```bash
cd /home/gid/apps/plm
cp env.example .env.local && $EDITOR .env.local
pm2 start ecosystem.config.cjs && pm2 save
```

#### Why a script rather than the rsync by hand

`deploy.sh` wraps this:

```bash
rsync -a --delete --exclude .env.local --exclude .pm2 /tmp/plm/ /home/gid/apps/plm/
```

`--delete` rather than extracting over the top, so a file removed in this release
is removed on the server too — extracting in place leaves orphans that can shadow
the new build. The two excludes are what must survive a deploy: the environment
file, and pm2's logs.

But `--delete` is also why typing it by hand is a poor idea. **The destination
must be absolute.** A relative path resolves against the working directory, and
since these steps used to `cd` into the target first, `home/gid/apps/plm/` became
`/home/gid/apps/plm/home/gid/apps/plm` — which is how this has actually gone
wrong. That attempt failed harmlessly because the path did not exist; the same
slip onto a path that *does* exist would have emptied it.

So the script refuses to run when:

| Refuses when | Because |
|---|---|
| `PLM_DEST` is not absolute | The failure above, caught before rsync sees it |
| The destination's parent does not exist | A typo would otherwise create a plausible tree and deploy into it |
| The source has no `server.js` | Rsyncing a non-bundle would leave a broken deployment |
| The destination is non-empty and has no `server.js` | It belongs to something other than PLM, and `--delete` would empty it |
| `pm2` is not on PATH | Reported as recoverable — the code is already in place |
| The running build ≠ the deployed build | The deploy did not take effect: pm2 is still holding the old process. Worth telling apart from a bug in the code |

The last one is the useful one day to day. `/api/version` reports the `buildId`
that `package-release.sh` printed, so "is my fix actually deployed?" is answerable
in one command rather than inferred from behaviour.

### What is in the bundle

| | |
|---|---|
| `server.js`, `.next/`, `node_modules/` | The traced standalone app |
| `ecosystem.config.cjs` | pm2 definition — **port 3005**, app name `plm` |
| `env.example` | Template. The real `.env.local` is never packaged; it holds secrets and stays on the server |
| `docs/` | MANUAL.md, DEPLOYMENT.md, ONSHAPE-INTEGRATION-SPEC.md |
| `build-info.json` | The build stamp `/api/version` reports |
| `deploy.sh` | The installer above — rsyncs into place, restarts pm2, verifies the build |
| `find-duplicates.mjs` | Admin tool, below |

The manual is read from disk at request time rather than compiled in, so it can
be corrected on the server without a rebuild.

### Ports

PLM listens on **3005**, set in `ecosystem.config.cjs` rather than `.env.local`
— it is a property of how the box is wired up, not of the application's
configuration, and pm2 is where someone looks for it. `APP_BASE_URL` is the
opposite: it belongs in `.env.local`, because it is the public HTTPS URL Onshape
must reach, not the local port.

For this deployment: `plm.gidpaull.com` terminates TLS at the reverse proxy and
forwards to `127.0.0.1:3005`, with the app served from `/home/gid/apps/plm`.

The app name and port are both distinct from MOS, so the two can run on the same
box.

### Finding duplicate parts

Configuration is part of a part's identity, and Onshape reports the
configuration string inconsistently across entry points — so a part could
historically be filed twice, under `"default"` and under the literal
`"{$configuration}"`. `ignoreConfigurations` (on by default) prevents new ones.

```bash
cd /home/gid/apps/plm
node find-duplicates.mjs            # dry run — reports, changes nothing
node find-duplicates.mjs --merge    # apply
```

It runs with plain `node` against the MongoDB driver already in the bundle. A
merge repoints structure edges and drawing references onto the row it keeps
rather than deleting them, and **refuses any group where more than one row is
released** — picking one of two release records to destroy is not a cleanup
decision.

---

## 2. Configuration

Copy `env.example` to `.env.local` and fill it in. Two settings matter more than
the rest:

**`APP_BASE_URL`** is the one most often got wrong. For this deployment it is:

```
APP_BASE_URL=https://plm.gidpaull.com
```

Not localhost, and not `:3005` — that is the port the reverse proxy forwards to,
not the address Onshape resolves. This one setting determines the OAuth redirect
URI, the webhook callback given to Onshape, the extension action URLs, and
whether session cookies are issued `SameSite=None`. If it is not `https://`, the
Onshape panel cannot hold a session and appears permanently signed out.

**`SESSION_SECRET`** must be at least 16 characters and stable across restarts.
Changing it signs everyone out.

---

## 3. Onshape → PLM: the three things to configure

This is where the two directions of OAuth get confused, so they are separated
here explicitly.

### (a) PLM calling Onshape — an OAuth *client*

PLM reads metadata, exports drawings and transitions release packages. It does
that as an ordinary OAuth client of Onshape.

In the Developer Portal, create an OAuth application and set:

| Field | Value |
|---|---|
| Redirect URLs | `https://plm.gidpaull.com/api/onshape/oauth/callback` |
| OAuth URL | `https://plm.gidpaull.com/api/onshape/oauth/start` |
| Type | Integrated Cloud App |
| Permissions | `OAuth2Read`, `OAuth2Write`, `OAuth2ReadPII` |

Put the client id and secret in `ONSHAPE_CLIENT_ID` / `ONSHAPE_CLIENT_SECRET`.
Then each user presses **Connect Onshape** in PLM's Settings.

Why each is that:

- **Redirect URL must match character for character.** PLM sends `redirect_uri`
  on the authorize request and again on the token exchange, built as
  `APP_BASE_URL + /api/onshape/oauth/callback`. A trailing slash, `http://`, or
  the bare port in `APP_BASE_URL` produces a redirect-URI mismatch at the token
  step — the likeliest cause of "Connect Onshape" failing.
- **OAuth URL** is the cold-start entry point Onshape uses from its Applications
  page. `/api/onshape/oauth/start` is written for that: a user arriving with no
  PLM session is sent to sign in and resumed afterwards rather than handed a JSON
  401, and Onshape's `redirectOnshapeUri` is honoured — validated to
  `*.onshape.com` over HTTPS, so it cannot be turned into an open redirect.
- **Integrated Cloud App** because the application also carries right-panel
  iframes and action-URL extensions (section 4).
- The three permissions are exactly what `authorizeUrl()` requests, so a missing
  one fails visibly at consent rather than later: read for metadata, BOMs,
  thumbnails, mass properties and release packages; write for part numbers and
  release transitions; PII to identify the signing-in user's company, which is
  how PLM binds an account to the right enterprise.

### (b) Onshape calling PLM — an OAuth *server*

Onshape's extension action URLs use **External OAuth**: Onshape is the client and
PLM is the authorization server. PLM issues Onshape a client id and secret.

1. In PLM: **Settings → How Onshape authenticates to PLM → Register**. Copy the
   client id and secret — the secret is shown once and stored only as a hash.
2. In the Developer Portal, on the same application, fill in the External OAuth
   settings with that id and secret plus:

| Field | Value |
|---|---|
| Authorization URL | `https://plm.gidpaull.com/api/oauth/authorize` |
| Token URL | `https://plm.gidpaull.com/api/oauth/token` |

Onshape shows users an **External access** button when they enable the
application; approving it sends them through PLM's consent screen once.

**Scopes: leave blank.** PLM defines none and enforces none. If a scope arrives
on the authorize request it is shown on the consent screen and recorded on the
token, but nothing checks it — `authenticateBearer` returns it and neither
inbound endpoint inspects it. So a token is all-or-nothing: it can call both the
part number generator and Send to PLM.

Do not reuse the `OAuth2*` permissions from (a) here. Those are Onshape's
vocabulary for PLM's access *to* Onshape; this direction is PLM's own
authorization server, and its vocabulary is currently empty.

Two consequences worth knowing:

- The consent screen displays a scope it will not honour, which is mildly
  misleading. If that matters for a demo, the fix is to define real scopes — one
  for numbering, one for creating parts — and require them in the two routes.
- Adding such a requirement later invalidates existing grants until each user
  re-consents, so it is better decided before the application is handed out than
  after.

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

## 4. App extensions

Register these in the Developer Portal against the same application. Settings
shows the exact URLs for your host, ready to copy — for this deployment they are
all rooted at `https://plm.gidpaull.com`.

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

## 5. Release workflow prerequisites

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

## 6. Checking it works

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
