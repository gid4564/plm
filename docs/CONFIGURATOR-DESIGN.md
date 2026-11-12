# Configurator — design

A page in PLM where someone picks the options of a configured Onshape assembly,
sees the result, and gets a bill of materials for exactly that configuration.
Each configuration is generated in Onshape once, kept in PLM, and served from
PLM afterwards; every configuration generated adds its parts to PLM's BOM.

Status: **all four phases built** (configure, key, generate and cache the
picture; read and keep each configuration's BOM as a snapshot; grow PLM's BOM
from it, numbering in PLM only; a 3D model per configuration, composed from
part exports — §13), plus an admin **Reset** for demos (§12) and **names** for
configurations. `src/lib/configurator*.ts`, `src/lib/gltf-compose.ts`,
`/configurator`. Building phase 2 found that PLM's BOM
parser read the indent from the row, while the live `bomTable.items` shape
carries it on `itemSource` — every indented BOM had come back flat; fixed in
`lib/onshape/bom.ts` for the BOM import too. Grounded in a probe of a real configured
assembly (*Flight Case → Case Assembly*, gjp.onshape.com, 9 Nov 2026) using
`scripts/probe-configuration.mjs`. Where this document says "measured", that is
where the number comes from.

---

## 1. What the probe established

| Question | Answer | Evidence |
|---|---|---|
| Can PLM read the inputs? | Yes — lists, yes/no, and numbers with range and units. | 10 inputs read from `GET /elements/…/configuration` |
| Are visibility rules exposed? | **Yes, fully.** Every input carries `visibilityCondition`, a tree of `BTParameterVisibilityLogical` (AND/OR) over `BTParameterVisibilityOnEqual` tests. Lists also carry `enumOptionVisibilityConditions` (per-option; empty on this model). | e.g. *Slots is shown only when Add cutouts = true AND Cutout type = Slots* |
| Is there a stable key for a configuration? | Yes: `POST /elements/…/configurationencodings` returns Onshape's own configuration string. | ~100 ms per call |
| …but | It includes **hidden inputs too**. Length/Depth/Height are encoded even when Size is a fixed size, so two requests for the same case can produce different keys. | §4.2 handles this |
| Can a configuration be rendered? | Yes, `shadedviews?configuration=…`. | **61 s** first (cold), **1.5 s** warm, **11 s** for a configuration Onshape had not evaluated |
| Does the BOM follow the configuration? | Yes, `bom?configuration=…` returns the parts that configuration uses, each with its own `fullConfiguration`. | 15 rows each for two configurations |
| What changes between configurations? | Quantities (Hinge Pin 2 → 4, Latch Assembly 3 → 5), and which configuration of each sized part is used (Base, Lid, Seal, Foam Base, Foam Lid). Latches and handles are shared. | probe §5 |
| Part numbers per configuration? | Onshape's Part number is configured on these parts: Base is PRT012175 in one, P/O-016517 in the other. Several sized parts have **no number** in the new configuration. | probe §2B |
| Anything unusual in the BOM? | A non-geometric item (`nonGeometricItemId`, "N/A × 1000") under the latch assembly. | bom-A.json |

Not yet verified: writing a Part number to one *specific configuration* of a
part (`/metadata/…?configuration=…` is how PLM already addresses
configurations; whether a configured property accepts it is the open point —
§9).

---

## 2. What someone does

1. Opens **Configure** for a model — a configured assembly an admin has made
   available (§3).
2. Sees a form built from the assembly's own inputs. Inputs appear and
   disappear exactly as in Onshape's configuration panel: choose *Custom* and
   Length/Depth/Height appear; switch *Add cutouts* off and everything about
   cutouts goes.
3. Presses **Generate**.
   - Seen before: the picture, 3D model and BOM appear immediately.
   - New: the page says it is generating (seconds, occasionally a minute),
     and fills in as each part arrives — picture first, then the BOM, then
     the 3D model.
4. Gets a **configured item**: a PLM number for this exact configuration, its
   picture, a 3D view, and a BOM whose lines are real PLM parts — opened, numbered
   and released like any other.

Nothing in Onshape is created or changed to do this. Onshape computes any valid
configuration on request; "generating" means asking once and keeping the answer.

---

## 3. Making a model configurable

An admin registers an assembly as a **configurable model**:

- the Onshape assembly (document, element), and **a version**, not the
  workspace — see §6;
- a name and product, for where configured items are filed;
- optional overrides per input: a friendlier label, hide an input entirely, fix
  a value, narrow a number's range (e.g. Slots 2–20 → 4–12 for this catalogue).

Registering reads the configuration definition once and stores it. A new
Onshape version is a new registration revision (§6).

---

## 4. How it works

### 4.1 The form

Built from the stored definition. Per input:

| Onshape type | Form control | Validation |
|---|---|---|
| `BTMConfigurationParameterEnum` | select, options in Onshape's order, labels from `optionName` | value must be a current option; per-option visibility applied |
| `BTMConfigurationParameterBoolean` | checkbox | — |
| `BTMConfigurationParameterQuantity` | number + unit | `rangeAndDefault.minValue…maxValue`; integer when the input is unitless (Slots) |
| `BTMConfigurationParameterString` | text | none from Onshape |

Visibility is evaluated in the browser and again on the server from the same
small evaluator (AND/OR over equals tests — the only shapes seen; any other node
type is treated as *shown*, and logged, so a new rule type fails open rather
than hiding an input the model needs).

Payloads arrive in Onshape's wrapped form (`{type, typeName, message}`); the
reader unwraps it, as the probe does.

### 4.2 The key

1. Start from the person's values.
2. **Every input that is hidden** under those values is reset to its default.
   This is what makes *700 × 400 × 300 with Length 500* and *… with Length 600*
   the same configuration, which they are.
3. Numbers are sent with their unit (`900 millimeter`).
4. Encode with `configurationencodings`; the returned string, passed through
   PLM's existing `canonicalConfiguration` (decoded, sorted), is the key.

The key is per **model revision**: the same values against a later version are a
different configured item, because they may be different geometry.

### 4.3 Generating

A background job per key — the pattern Create in Onshape already uses (state on
a record, steps, resumable, a stale-run timeout).

```
queued → picture → bom → parts → model3d → ready
                                      ↘ failed (step, reason)
```

- **One job per key.** A second request for a key already generating joins it
  rather than starting another — two people choosing the same case should cost
  one generation.
- **Limited concurrency** (2 at a time per enterprise): Onshape's evaluation of a
  new configuration is the slow part, and a queue of ten would otherwise all
  wait on each other anyway, while spending a shared rate limit.
- **Picture first.** It is the thing a person waits for; the 3D model, a
  translation job, comes last.
- **An invalid combination** — Onshape fails to regenerate — ends in `failed`
  with Onshape's message, and is remembered for that key so it is not retried
  on every request.

### 4.4 The BOM — how PLM's BOM grows

A configured item is a PLM **assembly part** whose identity is
`(document, element, partId "", configuration = key)`. PLM's identity key
already includes configuration; this is that key used deliberately.

For each BOM row (multi-level, indented):

- A **part** is looked up by `(document, element, partId, canonical(fullConfiguration))`.
  Found: reused — the latch parts are the same in every configuration, and stay
  one PLM part each. Not found: created, exactly as a sync creates one.
- A **subassembly** is the same, recursively; it is linked under its parent.
- **Edges** are written under the configured item with this configuration's
  quantities. Because each configured item is its own parent, *Hinge Pin × 2* in
  one and *× 4* in another are two edges, not one edge with two quantities —
  which `BomLink`'s one-edge-per-(parent, child) rule could not express.
- **Non-geometric items** are kept as BOM lines (description, quantity) but not
  as parts — they have no Onshape part to track. They are stored on the
  configured item (`nonPartLines`, §5) and shown in its BOM. Today's BOM import
  skips them, since `assessLine` refuses a row with no source.

So the BOM grows by one configured assembly per configuration, plus only the
parts that configuration introduces. The ten-thousandth configuration of a
model whose sizes have all been seen adds one assembly and no parts.

**Why not PLM's existing variants.** Variants tag the edges of *one* assembly's
BOM. That works while every model uses the same quantities; this model does
not, and a catalogue of Custom sizes would mean thousands of variants on one
assembly. A configured item per configuration is the simpler and the correct
shape here. Variants stay what they are for hand-defined models.

### 4.5 Numbers

For every configured part (and the configured item itself):

1. **Onshape has a number for this configuration** → PLM adopts it (the rule
   since `acc451b`: a number already in Onshape wins).
2. **It has none** → PLM issues the next number and writes it to *that
   configuration* of the part in Onshape (§9 — to verify).
3. The configured item gets a number from a scheme of its own — a new
   `CONFIGURATION` numbering type, `CFG-00001` by default (decided, §11) — so a
   quote or an order can name a configuration by one identifier.

The number generator already returns the existing number for a part PLM tracks
(`knownNumberFor`); it must match on configuration for configured parts, which it
does when the stored configuration is the canonical one.

### 4.6 What is cached

Per configured item:

| What | Where | Size |
|---|---|---|
| values chosen, key, summary line ("700 × 400 × 300, foam, 10 slots") | the configured-item record | small |
| picture (800×600 PNG) | `PartThumbnail` (existing) | ~190 KB measured |
| 3D model (glTF) | `PartGeometry` (existing; GridFS above 15 MB) | depends on model |
| BOM | `BomLink` edges (existing) + a snapshot of the raw rows for audit | small |

A cached item is served without any Onshape call. Picture and 3D model are the
same records the part page and viewer already read, so a configured item's page
is an ordinary part page.

---

## 5. Data model

**New: `ConfigurableModel`**
`enterpriseId, name, productId, documentId, elementId, versionId, revision,
definition (stored configuration payload), inputOverrides, enabled,
createdBy, createdAt`.

**New: `ConfiguredItem`**
`enterpriseId, modelId, modelRevision, key, values, summary, state, step, error,
partId (the configured assembly's Part), nonPartLines (name, description,
quantity, parent row), bomSnapshot, requestedBy, requestCount,
firstRequestedAt, lastRequestedAt, generatedAt`. Unique on
`(enterpriseId, modelId, modelRevision, key)`.

**Changed: `Part`** — `configuredFrom: { modelId, configuredItemId } | null` on
the configured assembly, so its page can link back to the configurator and say
which choices made it.

**Changed: configuration identity** — see §6.

---

## 6. Two things that have to change

### Configurations as separate parts

`Enterprise.ignoreConfigurations` (on by default) collapses every configuration
of a part into one PLM part. It exists because Onshape reports configurations
inconsistently across entry points, which made duplicates. A configurator needs
the opposite — the 700 mm Base and the 1000 mm Base are different parts with
different numbers.

Decided (§11): keep the enterprise default, and add **documents whose
configurations are distinct** — set automatically: on registering a model for
its own document, and on generating for every document its BOM reaches, before
any part from them is keyed. `configurationNormalizer` honours it, so a panel
sync, a webhook and the configurator all key those parts the same way. Elsewhere
nothing changes.

Risk to watch: Onshape's `fullConfiguration` for a child carries floats such as
`Depth=0.35000000000000003+meter`. If two equivalent configurations ever arrive
with different float spellings, they would key as two parts. Mitigation: round
numeric values with units to a fixed precision (1 µm) inside
`canonicalConfiguration` for these documents.

### Workspace → version

A cached configuration read from a workspace is a promise the workspace does not
keep: someone edits the assembly and every cached picture and BOM is quietly
wrong. Registering against a **version** makes each cached item permanent and
correct for that version. Moving the model to a newer version is a deliberate
admin act that starts a new revision; items of the old revision stay, marked as
generated from it.

---

## 7. Cost and time

Per **new** configuration, measured or estimated:

| Step | Onshape calls | Time |
|---|---|---|
| encode | 1 | ~0.1 s |
| picture | 1 | 1.5–11 s; up to ~60 s cold |
| BOM | 1 | ~1 s |
| new parts | ~1 per part not yet in PLM (metadata), + 1 write per number issued | ~0.3 s each |
| 3D model | translation job: submit + polls + download, ~4–8 | 5–60 s |

A cached configuration costs nothing. The API usage page records all of it under
a "Configurator" process so the real spend is visible after launch.

---

## 8. Edge cases

- **Custom sizes** make the space effectively infinite. Caching still works per
  key; it just will not "fill up". Admin range overrides (§3) can narrow it.
- **Two people, same new configuration** — one job (§4.3).
- **Onshape rejects a combination** — `failed`, message shown, remembered.
- **Standard content in the BOM** (library fasteners) — tracked as parts, marked
  read-only exactly as today (`writeBackBlocked`); never numbered into Onshape.
- **A part PLM already has under the collapsed "default" identity** from before
  its document was marked distinct — matched once by document/element/part and
  re-keyed, rather than duplicated.
- **Release** — a configured item and its parts follow the normal lifecycle. A
  released configured item is frozen; regenerating its key returns it as-is.
- **Deleting a model** hides it from the configurator; configured items and their
  parts remain, because quotes and orders may name them.

---

## 9. To verify before building

1. **Writing a number to one configuration.** `POST /metadata/…/p/{pid}?configuration=…`
   on a part whose Part number is configured — does it set that configuration's
   value only? A five-minute probe against the Flight Case Base.
2. **Float stability** of child `fullConfiguration` across calls and entry points
   (§6).
3. **glTF export per configuration** time on this model (the probe measured the
   picture and BOM, not the 3D export).
4. **Per-option visibility** — this model has none (`type: 0`); the shape of a
   real one is unknown until a model uses it.

---

## 10. Phases

1. **Configure and see** — model registration, the form with visibility, keying,
   picture generation and cache. Proves the experience end to end on the Flight
   Case. No BOM yet.
2. **BOM view** — fetch and show the configuration's BOM (from Onshape, cached as
   a snapshot), still without creating PLM parts.
3. **Grow the BOM** — configured items and parts in PLM, per-document
   configuration identity, numbering with write-back. The phase with real data
   consequences, so it comes after the two read-only ones.
4. **3D and polish** — glTF per configuration in the viewer, summaries, search
   by chosen values, admin overrides, usage reporting.

Phases 1–2 are read-only towards Onshape and towards PLM's part data, so they
can be demonstrated before anything is numbered or written back.

---

## 11. Decisions (9 Nov 2026)

| Question | Decision | Consequence in this design |
|---|---|---|
| Configured item numbering | **Its own scheme** | A fifth numbering type, `CONFIGURATION` (default `CFG-00001`), beside Part, Assembly, Drawing and Release — set on the Numbering page like the others (§4.5). |
| Who may generate | **Anyone signed in** — this is a demo | No role check on Generate. The concurrency limit (§4.3) and the API usage page (§7) are the guard on spend. |
| Internal or customer-facing | **Internal** | PLM's existing sign-in is enough; no public pages, no customer accounts. |
| Distinct-configuration documents | **Automatic** | Registering a model marks its document; generating marks every document its BOM reaches, before any of those parts are keyed (§6). |

## 11a. Decisions (10 Nov 2026)

| Question | Decision | Consequence in this design |
|---|---|---|
| Write numbers back to Onshape (§4.5 step 2) | **PLM only for now** | A configurator part's number lives in PLM. Every part the configurator makes carries `writeBackBlocked`, so no write-back path (sync, edit, delete) touches Onshape. Onshape's own number is still adopted where it has one. §9.1 stays open until write-back is wanted. |
| Demo reset | **Everything it made** | §12. |
| Who may reset | **Admins** | Reset sits beside Switch off on the Configurator page, behind a confirmation that says what goes. |

## 12. Reset (built 10 Nov 2026)

For demos: start a model again from nothing. An admin's **Reset** removes

- every configuration of the model — picture, BOM snapshot, number;
- the PLM assemblies made for them (CFG numbers) and the PLM parts the
  configurator created for their BOM lines (`Part.configuredFrom.modelId`),
  with their edges, iterations and thumbnails;
- and, when no configuration of any model is left, sets the CFG counter back
  so the next one is CFG-00001 again.

**Remove** a model is a reset followed by deleting the model; **Clear
everything** removes every model. A part kept because something else uses it
loses its `configuredFrom` mark, as the model it named is gone.

Registering refuses a document with no version, and a version whose
configuration has no inputs — the preview reads the link's workspace, and a
version made before the configuration was added reads as unconfigured (seen
live, 12 Nov 2026: a "Dumbbells" model registered with no inputs).

Kept: a part PLM had before the configurator used it (it is reused, never
marked); a released part; a part some other assembly uses — and what is inside
that part. Nothing in Onshape changes, because nothing was written there. The
PART and ASSEMBLY counters are not reset: other parts share them.

As built in phase 3 (§4.4): a "default" record PLM held before its document was
marked distinct is re-keyed to the configuration when its number is the one
Onshape reports for that configuration, rather than duplicated. Configuration
strings in distinct documents are keyed with float noise rounded off (12
significant digits — `stableNumbers` in `lib/sync.ts`).

## 13. The 3D model (built 10 Nov 2026)

**Probed first (§9.3), on the live Flight Case.** Onshape's assembly export
(`POST /assemblies/…/export/gltf`, the path PLM uses for released assemblies)
**ignores the configuration**: two different cases exported byte-identical —
all 28 files the default case — as a 159 MB zip of loose per-occurrence glTF
(366 MB unzipped) after about 86 s each. Unusable twice over.

What works instead, and is built:

1. `GET /assemblies/…?configuration=` — the assembly definition for this
   configuration: every occurrence (37 on the Flight Case, subassemblies
   included) with its row-major 4×4 transform from the root, and which part
   in which configuration each one is. 0.2–0.8 s.
2. `GET /parts/…/partid/{pid}/gltf?configuration=` once per distinct part
   (12 here), coarse tessellation (`chordTolerance=0.001`,
   `angleTolerance=0.35`, `maxFacetWidth=0.05`) — ~0.9 MB and ~1 s each,
   versus ~1.2 MB and 2.5–4.5 s at Onshape's default; three at a time. The
   part export honours the configuration (the Base measured 354 × 329 mm in
   one size, 454 × 374 mm in the other).
3. `lib/gltf-compose.ts` merges them into one GLB: each part's meshes once,
   drawn at every placement (the latch, used five times, is one mesh), under
   a root turning Onshape's Z-up into glTF's Y-up.

Kept as the configured assembly's geometry (`PartGeometry`, revision ""), so
the configure page's 3D view and the assembly's part page show the same
model, and a reset removes it with the part. Built last — after the picture,
the BOM and the PLM parts — because it is the slowest step and the one least
waited for. A part that will not export is left out and logged rather than
losing the model. Configurations made before phase 4 get their model the next
time they are opened.

**Composite parts.** The definition is read with `includeNonSolids=true`:
Onshape counts a composite part (a frame or weldment) as a non-solid, and
with `false` it is missing from the definition altogether — the live
WorkStation model lost its Workbench Frame, Leg Structure and Pegboard that
way (10 Nov 2026). Only wire and point bodies are left undrawn. Models built
before this (`modelBuild` < 2) are rebuilt when their configuration is next
opened.

**Each part's own model.** The part exports the assembly model is built from
are kept as each PLM part's geometry too (when it has none) — no further
Onshape call. Configurator parts are `writeBackBlocked`, which elsewhere means
"library part, no 3D"; the part page makes an exception for parts with
`configuredFrom`. Items whose assembly model predates this catch up the next
time they are opened (`partModelsAt`).

**Product.** Configurations and their new parts are filed into the model's
chosen product; with none chosen, into the product the model's own parts are
in (the assembly as synced, else the product most of the document's parts
belong to), else Unassigned. Choosing a product for a model moves everything
the configurator made for it.

**Names.** Any configuration can be named ("Touring case, 1000 mm"); its PLM
assembly takes the name (PLM's own part — nothing goes to Onshape), and an
empty name goes back to the model's.
