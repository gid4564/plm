# PLM — a demo product lifecycle system that syncs with Onshape

A working demonstration of a PLM system integrated with Onshape CAD. Parts,
assemblies and drawings sync both ways; attributes are governed by a
configurable metamodel; and **PLM takes over the release process that Onshape
starts** — approving or rejecting the Onshape release package itself, then
collecting the released drawing sheets once Onshape has stamped them.

Forked from the MOS (Manufacturing Order System) project, which is where the
Onshape integration detail comes from: the mock/live client split, OAuth token
handling, the webhook receiver's tenant resolution and echo suppression,
name-based property discovery, BOM reading, and the tuned translation-polling
schedule.

---

## What it does

**Both directions of OAuth.** PLM is an OAuth *client* of Onshape for its own
reads and writes. It is also an OAuth *authorization server*, because Onshape's
extension action URLs use what Onshape calls External OAuth — "Onshape acts as a
client, and the application acts as a server". Onshape obtains a bearer token
from PLM and presents it on every extension call.

**PLM owns the release.** A designer raises a release candidate in Onshape.
Onshape creates a release package and adds the active drawings to it. PLM picks
that up from the workflow-transition webhook, brings every item in, captures the
as-submitted drawing PDFs, and opens a release for review. A PLM approver decides
— and PLM then performs the approve or reject transition on the Onshape package,
which is what creates the revisions.

**Attributes behave like PLM attributes.** Each definition declares its data
type, whether it must hold a value before release, which lifecycle states it may
be edited in, whether it freezes once released, and which system authors it —
with a per-attribute Onshape mapping carrying a direction and an authority, so a
bidirectional attribute has defined behaviour on conflict rather than
last-write-wins.

**Structure is real.** Parts and BOMs sync before release. Product structure is
an edge collection, so "where is this used" is as cheap as "what is in this".
Assemblies are first-class objects.

**Drawings are captured twice, and both are kept.** Onshape only applies the
revision, the watermark and the title-block release fields once the release has
completed, so the sheet the approvers reviewed and the controlled document are
genuinely different files.

**PLM is the number master.** Numbers are issued here and written to Onshape,
including through Onshape's own part number generator extension — which fires
from the Release candidate dialog, so a PLM number lands on a part at exactly the
moment a release is raised.

**Revisions stay Onshape's.** PLM tracks its own pre-release iterations with
snapshots, and records the revision letter Onshape assigns. Two systems
generating revision identifiers independently is how they come to disagree.

---

## Running it

```bash
npm install
cp .env.example .env.local     # then set SESSION_SECRET
npm run db:start               # local MongoDB under .localdb/
npm run dev                    # http://localhost:3011
```

Then, in the app:

1. **Register** — the first account for an Onshape company id becomes its admin.
2. **Settings → Connect Onshape** — in mock mode this completes instantly.
3. **Settings → Seed the mock tenant** — parts, drawings and property definitions.
4. **Attributes → Add the starting schema** — 11 part and 5 drawing definitions.
5. **Settings → Run discovery** — binds those definitions to Onshape properties.
6. **Settings → Discover the release workflow**, then **Register** the webhook.
7. **Settings → Take over releases raised in Onshape** — off by default on purpose.
8. **Onshape Simulator → Raise a release candidate** — and watch PLM take it over.

Nothing above needs an Onshape account. `ONSHAPE_MODE=mock` simulates release
packages, workflow transitions, revision creation and drawing PDFs, and the mock
fires real webhooks over HTTP at the registered callback URL — so the receiver is
exercised exactly as Onshape would exercise it.

### Shipping it

The server cannot build this — `next build` needs far more RAM than it has — so
the build happens on a workstation and the server receives finished JavaScript:

```bash
./scripts/package-release.sh
```

That produces `dist/plm-release.tar.gz` (~10MB, ~52MB extracted) and prints the
deploy commands. It refuses to ship a bundle that would fail on the server —
development chunks mixed in by a running dev server, a type error, a native
binary traced in from macOS, or a missing `server.js`. PLM runs on **port 3005**
under pm2 as `plm`, both distinct from MOS so the two coexist on one box. Full
detail in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Tests

```bash
npm test
```

199 assertions. The one worth knowing about is `scripts/test-release-flow.ts`,
which drives the whole release takeover against the mock tenant and asserts the
thing requirement 5 actually claims: that both drawing sheets are kept, that only
the second carries a revision, and that the two PDFs differ.

---

## How it is put together

| Layer | Where | Note |
|---|---|---|
| Onshape client | `src/lib/onshape/` | One interface, two implementations. Nothing above it knows which is in play — which is why the demo runs with no tenant |
| Attribute metamodel | `src/lib/attributes.ts` | Coercion, editability, release validation, and the inbound/outbound mapping |
| Sync engine | `src/lib/sync.ts` | Identity, iterations, echo suppression, and the read-here/write-there rule |
| Release process | `src/lib/release.ts` | Takeover, decision, transition, and the released-drawing collection |
| OAuth server | `src/lib/oauth-server.ts` | Authorization code + rotating refresh tokens |
| Drawings | `src/lib/drawings.ts` | The two-stage PDF capture |
| Product structure | `src/lib/bom-import.ts` | BOM read → assembly object + structure edges |

Three pieces of the design are worth reading the comments for, because they are
counter-intuitive and each one was a bug first:

- **`readCoords` / `preferKnownWorkspace` in `sync.ts`** — why a release event is
  read against the workspace rather than the version it names.
- **`consumeSelfWriteMarker`** — why an echo is annotated rather than dropped.
- **`toBuffer` in `binary.ts`** — why a `.lean()` query on a binary field served
  HTTP 200 with correct headers and an empty body.

## Documentation

- [`docs/ONSHAPE-INTEGRATION-SPEC.md`](docs/ONSHAPE-INTEGRATION-SPEC.md) — the
  Onshape API research this is built on, with every claim marked **confirmed**,
  **likely** or **unknown**, and the remaining unknowns listed with how to settle
  each. Read this before trusting anything against a live tenant.
- [`docs/MANUAL.md`](docs/MANUAL.md) — the user guide.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deploying it, and registering the
  app extensions in Onshape's Developer Portal.
