# PLM — Work Log and Handoff

A summary of the work on the PLM project, for importing into another Claude Code account. It covers the project's shape, how to build, test and deploy it, the conventions followed, and the changes from the most recent working sessions (Oct 2026), with earlier history summarised from the git log.

Repo: `https://github.com/gid4564/plm` (branch `main`). Local path: `/Users/Gideon/sites/PLM`.
Latest commit at the time of writing: `ecacabc`.

---

## 1. What PLM is

A product lifecycle management app built around Onshape (cloud CAD). It forked from an earlier project called MOS and is a demo-grade PLM:

- **Stack:** Next.js (App Router, standalone output), React 19, TypeScript, MongoDB via Mongoose, three.js for the 3D viewer.
- **PLM is the master for part numbers.** Onshape's number-generator extension asks PLM for numbers (`/api/numbering/onshape-extension`).
- **Parts and assemblies** sync from Onshape; PLM stores attributes, iterations, revisions, lifecycle state, BOM links (with effectivity and variants), tasks, releases, drawings, products, favorites, glTF snapshots of released parts.
- **Releases** are taken over from Onshape release packages and decided in PLM; **star releases** are PLM-side releases that don't bump a revision (and can swap a component).
- **Mock mode** (`ONSHAPE_MODE=mock`) runs the whole app against a simulated Onshape, for development and tests. Live mode uses `LiveOnshapeClient` (`src/lib/onshape/live-client.ts`).

Key docs already in the repo: `docs/DEPLOYMENT.md`, `docs/MANUAL.md`, `docs/ONSHAPE-INTEGRATION-SPEC.md`, `README.md`.

## 2. Build, test, run

```bash
npm run dev -- -p 3011            # dev server (launch config name: plm-dev)
npx tsc --noEmit                  # typecheck
npm test                          # full suite (many scripts/test-*.ts via tsx)
npm run test:apilog               # one suite, e.g. the API-call log
```

- Tests use Mongo at `mongodb://127.0.0.1:27017`, database `plm_test`. Dev uses database `plm` (`.env.local`: `MONGODB_URI`, `MONGODB_DB`, `ONSHAPE_MODE`).
- A dev server on port 3011 must be stopped before packaging a release.
- Delete `.next` if `tsc` complains about stale `.next/types` after removing a route or page.

## 3. Releasing to the server

The server has too little RAM to build, so the build happens locally and a tarball is shipped.

```bash
./scripts/package-release.sh      # typechecks, builds, writes dist/plm-release.tar.gz
scp sites/PLM/dist/plm-release.tar.gz ubuntu@208.113.215.104:/tmp/
# on the server:
tar -xzf /tmp/plm-release.tar.gz -C /tmp
/tmp/plm/deploy.sh                # dry run
/tmp/plm/deploy.sh --apply
```

- **Tarball location convention:** the file is named `plm-release.tar.gz` and lives in `PLM/dist` (the package script does this).
- **Server:** a new server, user `ubuntu`, deploy path `/home/ubuntu/apps/plm` (now the default in `scripts/deploy.sh`). `deploy.sh` keeps `.env.local` and `.pm2`, rsyncs with `--delete`, restarts pm2, and checks that the build answering on port 3005 is the one just deployed.
- **First deploy on a server only:** copy `env.example` to `.env.local`, set `APP_BASE_URL`, then `pm2 start ecosystem.config.cjs && pm2 save`.
- An older server deploy of `deploy.sh` still defaults to `/home/gid/apps/plm`; the first deploy after the default change needs `PLM_DEST=/home/ubuntu/apps/plm`, after which the new script is in place.
- Typical flow in this project: make a change, `commit`, `push`, rebuild the tarball.

## 4. Conventions followed

- Match the surrounding code's comment density and style. Comments in this codebase explain *why* (often a real failure that motivated the rule).
- Commit trailer: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- Admin-only behaviour is enforced in the API routes (`s.role !== "admin"`), not only in the UI. Navigation `adminOnly` is a convenience.
- Every API route is wrapped in `handler()` from `src/lib/api.ts`.
- Edits that change data semantics get a test in `scripts/test-*.ts` and a `test:*` entry in `package.json` (and are added to the `test` chain).

## 5. Work done (Oct 2026 sessions, newest first)

### 5.1 API usage page — `ecacabc` (Oct 8)
An admin page showing where the Onshape API budget goes.

- **Recording:** `src/lib/api-log.ts`. Every HTTP request from `LiveOnshapeClient` (via a new private `send()` used by both `req()` and `reqBinary()`) is recorded as an `ApiCall` document: method, path, normalised endpoint (ids collapsed to `:id`), status, ms, bytes, attempt number, error. Retries and no-reply failures (status 0) are separate calls. Recording is buffered (flush every 1s or 100 rows), fire-and-forget, never throws.
- **Attribution:** an `AsyncLocalStorage` frame carries `process` (outermost: the route name, e.g. "Bulk re-sync", "BOM import", "Webhook", "Thumbnail"), `step` (innermost named step, e.g. "Part sync"), `subject` (e.g. a part number) and a `runId`. `handler()` starts a run per request (`withApiRequest`). Library entry points are wrapped with `withApiProcess`: Part sync, Part write-back, Part delete, BOM read, BOM import, 3D capture (+release), Drawing PDF, Task pull/comment/transition/edit/move/remove/refresh, Release takeover/decision/submit, Drawing refresh (`newRun: true`, since it fires from a timer).
- **Model:** `ApiCall` in `src/lib/models/index.ts`, TTL index (default 35 days, `API_LOG_RETENTION_DAYS`). `LiveOnshapeClient` gained an optional `enterpriseId` constructor argument (set by the factory).
- **Data:** `src/lib/api-usage.ts` (`queryApiUsage`) holds the aggregations (overview, runs, calls); `/api/admin/api-usage` is the admin-gated door.
- **UI:** `/api-usage` (`ApiUsageClient.tsx`), under Configuration → Tools. KPI tiles, calls-over-time chart, filters (process, step, result incl. 429/4xx/5xx/retry/slow, method, search, range 15 min–30 days), tabs: By process, Runs (expandable to each call), Live calls (4s polling, pausable), Endpoints. Click-through filtering throughout.
- **Tests:** `npm run test:apilog` (16 checks).
- **Known gaps:** OAuth token-refresh requests are not counted; mock-mode calls are not counted; the page was verified at the query layer and by type-check/build, but not visually (needed a login).

### 5.2 three.js 3D viewer — `c55ab7e` (Oct 6)
Replaced Google `<model-viewer>` with a three.js viewer in `src/components/ModelViewer.tsx`: feature-edge outlines (30° crease, auto-off above 600k triangles), a camera-following headlight plus fill and environment lighting, orbit/pan/zoom-to-cursor, standard view buttons (Iso/Front/Back/Left/Right/Top/Bottom/Fit), Ortho and Wireframe toggles, centre-of-mass hotspot projected each frame, thumbnail poster while loading. AR dropped; `@google/model-viewer` removed, `three` added.

Lesson recorded in the code: the scene effect must be keyed on a boolean `active`, not on `status`, or it tears itself down the moment loading finishes.

### 5.3 Part number: Onshape wins — `acc451b` (Oct 6)
`src/lib/sync.ts`: on re-sync of an existing part, a non-empty Part number in Onshape that differs from PLM's is adopted (previously PLM pushed its stored number back over it, undoing a number pulled from the generator). An empty Onshape number still gets PLM's pushed. `scripts/test-number-adoption.ts` was rewritten to match.

### 5.4 Star-release swap fix, permanent delete, deploy path — `6172861` (Oct 6)
- **Duplicate key error** (`E11000 … bomlinks … enterpriseId_parentId_childId`) when swapping in a part that already had an ended link under the assembly. `src/lib/star-release.ts` now reopens the ended link instead of inserting; if the target is already an active component it errors clearly. Trade-off: the earlier effectivity dates of the reused link are overwritten (the unique index allows one link per parent/child).
- **Delete permanently:** admin-only button on Released/Obsolete parts (`PartDetail.tsx`), using the existing `DELETE /api/parts/:id?force=1`. Removes the part, iterations, thumbnail, geometry and BOM links on both sides. Still blocked for a part in a release under review.
- `scripts/deploy.sh` default destination changed to `/home/ubuntu/apps/plm`.

## 6. Earlier history (from the git log)

| Date | Commit | Summary |
|---|---|---|
| 2026-10-01 | `6afe85a` | Fix configuration handling across BOM import, panel, release and sync |
| 2026-09-16 | `4d9746c` | 3D viewer storage, favorites, star releases, part copying, several live-tenant bug fixes |
| 2026-09-12 | `aa2f056` | Capture a part's 3D as glTF at release, behind a settings toggle |
| 2026-09-12 | `f5d24fd` | Fix hydration crash behind the panel's task links; expand tasks in place |
| 2026-09-12 | `9a5afd2` | Products, BOM, tasks and the Onshape findings behind them |
| 2026-09-10 | `cd57dd1` | Retry once on a rejected token; render assembly thumbnails |
| 2026-09-10 | `c258780`…`013d1f9` | Thumbnails, card padding, MOS wording cleanup; part-number extension (batch shape, classification by structure); OAuth diagnostics and redirect-URI handling; nav; packaging and guarded installer; deployment to plm.gidpaull.com (port 3005) |
| 2026-09-09 | `013d1f9`, `c479ddc`, `ac446c2` | Fork of MOS into a demo PLM: data model, attribute metamodel, release takeover; routes and UI; approving releases as an Onshape service user; release's own drawing sheets |

## 7. Useful facts discovered along the way

- **Onshape extension/numbering:** the elementType is an undocumented integer; requests are classified by structure. The extension answers in the batch shape Onshape sends.
- **OAuth token exchange:** Onshape rejects HTTP Basic client auth; credentials must go in the form body. `scripts/check-onshape-oauth.mjs` (shipped in the tarball) diagnoses a failing exchange.
- **Gateway errors:** a 502/503/504 on a GET is retried up to 3 times (400 ms, 1.2 s, 3 s) and counts as 4 API calls. A 401 triggers one token refresh and one retry; refreshes are deduplicated per user in-process. Several concurrent requests with a stale token each 401 once, then share one refresh.
- **Token-expiry open question:** a 401 despite a stored expiry >60 s away (seen after the server migration, on four concurrent thumbnail requests) is probably a one-off from the migration; if it recurs hourly, investigate expiry tracking in `src/lib/onshape/factory.ts`.
- **BomLink uniqueness:** one link per (enterprise, parent, child). Anything that "adds" a child that was previously swapped out must reopen rather than insert.
- **Thumbnails:** cached in Mongo; a failed render is not retried for an hour; the part endpoint needs a partId, the assembly endpoint takes the element only.
- **Mock vs live:** local dev is mock; real Onshape behaviour (and the API-call log) only shows on the live server.

## 8. Open items / ideas

- Confirm the API usage page on the server (not visually checked locally).
- Optionally count OAuth token-refresh calls in the API log.
- Name more processes in the API log (only the heavy ones are wrapped; the rest show under their route name).
- If thumbnail gateway errors are common, lengthen the backoff or retry failed thumbnails sooner.
- Check the release/star-release screens cope with a permanently deleted part (the cleanup deletes the part and links but leaves release and star-release records).
- Check the centre-of-mass marker alignment on a real stored part in the new viewer (coordinate frame assumed unchanged from the old viewer).
