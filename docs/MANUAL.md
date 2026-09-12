# PLM — user guide

A demo product lifecycle system that works alongside Onshape. It holds the
governed record of your parts, assemblies and drawings: their attributes, their
structure, their revisions, and the release decisions taken against them.

---

## What it does

Onshape is where parts are designed. PLM is where they are governed. The two
stay in step automatically:

- **Attributes** flow between the systems according to rules an admin sets — some
  read from CAD, some written to it, some PLM's own.
- **Structure** comes from an assembly's bill of materials, so PLM can answer
  both "what is in this" and "where is this used".
- **Releases** start in Onshape and are decided in PLM. PLM then performs the
  release in Onshape.
- **Drawings** are captured as PDFs at release, twice, and both are kept.

### Finding things

Two menus carry the day-to-day work — **Parts** and **Releases** — and
everything else lives under **Configuration**:

- *Attributes*, *Numbering*, *Settings* — viewable by anyone, changeable by an
  admin.
- *Tools* — **admin only**: *Import from Assembly* and the *Onshape Simulator*.
  Neither is part of the normal flow. Parts arrive from Onshape, so importing
  an assembly by hand is a fallback, and the simulator exists to demonstrate
  PLM without an Onshape tenant at all.

Hiding an item only removes it from the menu; it does not protect the page. The
pages and their APIs check for themselves, because a route is reachable by
anyone who types it.

### Who sees what

Everyone in an enterprise sees the same parts and releases. Three roles differ:

| Role | Can |
|---|---|
| **user** | Sync parts, edit attributes, import assemblies, raise releases |
| **approver** | All of the above, plus approve or reject a release |
| **admin** | All of the above, plus the attribute schema, the Onshape connection, and obsoleting released parts |

An approver needs **no Onshape licence**. That is deliberate: reviewing a release
is exactly the job someone without a CAD seat is likely to hold, so PLM keeps its
own accounts and only its service account touches Onshape.

---

## Getting started

### Joining an enterprise that already uses PLM

Register with your work email and your enterprise's Onshape company id — an
admin can tell you it, or read it from Settings. You will join as a **user**;
ask an admin to make you an approver if you need to decide releases.

Then press **Connect Onshape** in Settings so PLM can read and write CAD as you.

### Setting up a new enterprise

The first account registered against an Onshape company id becomes its admin.
After that, in order:

1. **Connect Onshape** (Settings) — PLM needs an account to read the tenant with.
2. **Add the starting schema** (Attributes) — a working set of part and drawing
   attributes. Change them freely; they are ordinary definitions that happen to
   be present from the start.
3. **Run discovery** (Settings) — resolves each attribute's named Onshape
   property to the id this tenant actually uses. Matching is by name because
   Onshape's property ids are per-tenant.
4. **Nominate the service account** (Settings) — the Onshape user PLM acts as
   when it transitions a release package. **This user must be a designated
   approver on your Onshape release workflow**, or every approval will be
   refused. PLM says exactly that if it happens.
5. **Discover the release workflow** (Settings).
6. **Register the webhook** (Settings) — how Onshape tells PLM things happened.
7. **Turn on "Take over releases raised in Onshape"** (Settings) — see below.

### Release takeover is off by default

Switched on, PLM starts approving and rejecting real release packages across the
whole Onshape tenant. On a shared enterprise most releases may have nothing to do
with PLM, so somebody has to decide this is wanted. Until it is on, release
packages are acknowledged and ignored, and Settings shows how many — so the cost
of enabling it is visible before you enable it.

---

## Parts and assemblies

### How they get into PLM

Four routes, all deliberate:

- **The Onshape panel** — select a part, press *Sync to PLM*.
- **A context menu in Onshape** — right-click a part or a tab, *Send to PLM*.
- **Import from Assembly** — brings in the assembly and everything under it,
  **with its structure**. Admin-only and tucked under *Configuration → Tools*:
  parts normally arrive from Onshape, so this is a fallback rather than the
  usual way in.

  Onshape returns a multi-level BOM as a flat list whose order carries the
  tree — each row's parent is the nearest row above it one level shallower —
  and PLM rebuilds that, so a subassembly comes in as a PLM assembly with its
  own children under it rather than everything being attached to the top.

  **Re-import to bring a BOM up to date.** Parts and subassemblies added in
  Onshape appear; quantities update if you ask them to; and components removed
  in Onshape have their place in that assembly removed too. The rule is that an
  assembly's own bill of materials is the only source of truth for what *it*
  contains, so each parent in the import is reconciled against what was read
  and no other parent is touched.

  Removing a component removes its **place in that assembly**, never the part.
  The part may be used elsewhere, and may be released — a BOM import is not the
  right event to destroy a record on.

  Reconciliation applies only when you import the whole assembly. A partial
  selection says nothing about the rows you left unticked, so nothing is
  deleted on the strength of a checkbox.

  **Everything under one assembly goes into one product.** The product is taken
  from the assembly when PLM already has it, and only otherwise from the product
  you are working in. That ordering matters: adding a subassembly months later
  and re-importing would otherwise file the new parts into whatever product
  happened to be selected at the time, splitting one product structure across
  two. The import says which product it used and why.

  A part you have deliberately moved to another product is **named, not dragged
  back** — an import is the wrong moment to override that decision. Select it on
  the BOM page if you want it moved.
- **A release** — every item in a release package is brought in automatically.

Editing a property in Onshape does **not** bring a part in. If it did, every
property a designer touched would allocate a PLM number nobody asked for. It does
keep an existing part current.

### Products

Every part and assembly belongs to a **product** — the thing being built, as
people talk about it: "the pump", "the Mk2 chassis". It is PLM's own grouping,
not Onshape's: Onshape organises by document, which is a container for CAD
rather than a statement about what a part is part of, and a part can move
between products without its CAD moving anywhere.

The product list sits down the left of the parts dashboard with a count and a
breakdown on each row. Clicking one filters the page to it; the heading changes
to the product's name so it is clear you are looking at a subset.

**The product you are working in is remembered.** It is stored against your
account rather than in the browser, because it is not only a view preference —
a part you sync from the Onshape panel is *filed into it*. That means the same
answer follows you to another machine, and the server can read it when it files
something.

Where a product gets chosen:

| Where | What the picker means |
|---|---|
| Parts dashboard | Which product to look at, and the one new work is filed into |
| Part page | Move this part to another product |
| Onshape panel, before syncing | Where the part will be filed |
| Onshape panel, once tracked | Move this part |
| Assembly import | Where everything in this import goes, the assembly included |

Anything arriving automatically — a webhook, a release raised in Onshape — goes
to **Unassigned**. An automatic path has nobody to ask, and a part quietly
belonging to whichever product the integration account last had selected would
be worse than one visibly belonging to none.

"Unassigned" is an ordinary product, created the first time it is needed, and it
cannot be deleted — something has to be the place things go when nothing else
has claimed them. Parts that predate products show as **Not yet filed**, kept
separate on purpose: an unassigned part was filed there, an unfiled one was
never asked. There is a button to file them all.

Deleting a product never deletes what is in it. Its contents move to
Unassigned. A product is a grouping, and removing a grouping says nothing about
the parts that were in it.

### Numbers

PLM issues them, and writes them onto the Onshape part. This also works from
inside Onshape: the *Part number generator* extension means opening the Release
candidate dialog gets a PLM number applied then and there, rather than after the
fact — and because it is a batch request, a candidate covering several unnumbered
parts numbers them all in one go.

Numbers are never reused, even if the write to Onshape fails afterwards. A number
that might already be in a quote or a drawing is worse to reissue than to leave
looking unused.

**Setting the schemes** is on the **Numbering** page. There are four, one per
kind of thing PLM numbers, each with a prefix, an optional suffix, and how many
digits the counter is padded to:

| Scheme | Numbers | Default |
|---|---|---|
| Part | Parts, and what the Release candidate dialog asks for | `PN-00001` |
| Assembly | Assemblies, which PLM holds as objects in their own right | `AS-00001` |
| Drawing | Drawing documents, issued when one arrives with a release | `DWG-00001` |
| Release | Releases. Travels to Onshape as the package's change order id | `REL-00001` |

Admins can change any of them. Changing a scheme affects only numbers issued
afterwards — nothing already issued is renumbered, because a number that has been
written onto a part, a drawing or a quote is not PLM's to take back. The page
also lists the last 25 numbers issued and where each went, which is how you
answer "what got this number, and why".

### Versions: revision and iteration

A part shows its version as one token — **A.3**, or **–.2** before it has ever
been released.

- The **revision** (A, B, C) belongs to Onshape. Onshape's release workflow
  decides the scheme and assigns the letter; PLM records what it was told. Two
  systems inventing revision identifiers independently is how they come to
  disagree.
- The **iteration** (.1, .2, .3) belongs to PLM. It increments whenever a real
  change lands — a sync that changed something, or an edit made here — and each
  one keeps a snapshot. That is the pre-release history Onshape does not keep in
  a form a reviewer can read.

A dash instead of a letter is not a missing value. It means this part has genuinely
never been released.

### What a second release keeps

Releasing the same part again does not overwrite what came before. Three
separate records are involved, and only the first is meant to change:

| Record | On a second release |
|---|---|
| The part | Updated. One row, always the current state — revision B, the latest attributes. |
| Its version history | **Added to.** Each iteration is a snapshot of the attributes, revision, state and Onshape version as they stood. Nothing is rewritten, so the revision A row still reads as revision A. |
| The release | **A new one.** The first release stays exactly as it was, with the items and revisions it produced. |
| Drawing sheets | **Both kept.** Every release keeps its own as-submitted and as-released PDF, so you can still open the sheet that was approved for revision A. |

So the part page shows revision B, and its version history shows the release
that produced A alongside the one that produced B — each linking to its release.

One thing to know: **iteration numbers do not restart at each revision.** They
are a single running count of changes to the part, so revision B continues from
where A left off (A.4 → B.5) rather than beginning again at B.1. Some PLM
systems restart; this one does not.

### Attributes

Each attribute is shown with what it is and how it behaves:

| Badge | Meaning |
|---|---|
| **release** | Must hold a value before this object can be released |
| **PLM** | PLM's own data; Onshape has no equivalent |
| **← CAD** | Mirrored from Onshape |
| **→ CAD** | Written to Onshape |
| **⇄ CAD** | Both ways; hover to see which side wins on conflict |
| **unmapped** | Names an Onshape property this tenant does not have — tell an admin |

An attribute you cannot edit is shown as a value with the reason underneath,
rather than a greyed-out box. Reasons are always one of two things: it can only
be edited in certain lifecycle states, or it froze when the part was released. A
frozen attribute needs a new revision to change, which is the point of freezing it.

### Mass

**Mass** is filled in from Onshape rather than typed. Open a part and press
*Measure* in the Mass properties panel: PLM reads the mass, volume, surface
area and centroid from Onshape and records the mass on the part's Mass
attribute, in kilograms.

It is read on request rather than on every sync, because mass properties are
only interesting when somebody looks, and reading them on every webhook would
spend Onshape calls on something most views never open.

If Onshape reports no mass — almost always because no material is assigned —
nothing is recorded. That is deliberate: "could not compute" is not the same as
"weighs nothing", and a zero in that field is a number somebody might quote.

### Structure

Importing an assembly's BOM brings in the assembly as its own PLM object and
records each row beneath it with the quantity the model reports. Quantities live
on the link, not on the part — a part used four times in one assembly and twice in
another has two quantities, and neither is a property of the part.

Every part page shows both directions: what it contains, and what it is used in.

---

## The BOM page

Pick a product and read what it is built from, in two views of the same walk:

- **Structured** — the tree, as Onshape shows it. Expand and collapse; each row
  shows the quantity within its parent and the total the product needs.
- **Flattened** — one row per distinct part, with quantities summed across
  every place it appears, and how many places that is.

Both come from a single traversal, so the two can never disagree about a
quantity. Columns are the thumbnail, part number, name, description, material
and state, with revision beside the number. Clicking a part number opens a
panel over the BOM rather than navigating away — reading a BOM is a scanning
task, and checking one part should not cost you your place in a tree you spent
several clicks expanding.

**Date effectivity, at two levels.** The filter resolves the BOM at a date —
*All dates* (the default), *Today*, or a date you pick — and two separate
windows decide what it shows.

*The part's own window*, on its attributes: **Effective from** and **Effective
to**, both optional. Empty *from* means it always has been valid, empty *to*
means it still is. This says whether the part exists as something to build at
all. A part that is not effective takes everything beneath it out too — an
assembly that is not valid to build is not a route to its components on that
date.

*The component's window*, on the position in the structure — the **In this
assembly** column, editable in place on the structured view. This says whether
*this assembly uses this component* between those dates, which is a different
claim entirely.

The difference is what makes a **substitution** expressible. Suppose the pump
used one bolt until March and a longer one from April:

| | Set the part's window | Set the component's window |
|---|---|---|
| The pump's BOM after April | correct | correct |
| The old bolt elsewhere | **gone from every other assembly** | still there |
| The old bolt as a stocked part | retired | still current |

Retiring the part would remove it from every BOM in the system. Ending the
component position removes it from *this* assembly and leaves the part alone.
So: use the part's window to retire a part, and the component's window to change
what an assembly uses.

The page reports the two separately for the same reason. "Not in use on this
date" names a component position and the assembly it left; "hidden by the date
filter" names a part that is not current anywhere. Reading one as the other
would make a routine substitution look like a retired part.

A component's window is PLM's own — a CAD BOM has no notion of a date — so
re-importing the assembly from Onshape leaves it untouched.

### Filling in attributes from the BOM

A product's worth of parts each missing two or three release-required
attributes is the ordinary situation, and the BOM page is built to work through
it rather than make you open each part in turn.

**Find the gaps.** A row missing anything shows a **needs *n*** badge, and the
*Release readiness* button filters the view to just those parts.

**Edit in the panel.** Clicking a part number opens the panel, which lists the
editable attributes — defaulting to *only what's missing*, since that is the
task. Fill them, then:

- **Save** keeps you on the part.
- **Save and next** saves and moves straight to the next part in the view.
- **↑ / ↓** (or `k` / `j`) step through parts without closing the panel, in the
  order they appear on screen — filtered and searched, so ↓ follows what you
  can see. Stepping is blocked while there are unsaved changes, and Escape will
  not discard typing.

A field locked by the part's state is shown as a value with the reason, not as
a greyed-out box. Whether something may be edited is decided on the server from
the metamodel, so the panel cannot offer an edit that would be refused.

**Set one attribute across many parts.** Tick the rows — in either view — and a
bar appears: choose an attribute, give it a value, and apply. Release-required
attributes are listed first and marked.

Each part is still checked on its own terms. A field locked by one part's state
is refused *for that part*, and the rest of the batch still saves —
deliberately not all-or-nothing, because one Released part in a selection would
otherwise block the other eleven, and "eleven saved, one refused because it is
Released" is the useful outcome. The response names what was refused and why.

Two details worth knowing: attributes Onshape owns are not offered in bulk, since
the next sync would undo the work; and a part that already holds the value is
skipped rather than rewritten, so a bulk fill does not add an iteration to every
part's history recording no change.

**Also on the page:**

- **Rolled-up mass**, summed from the leaf parts and their quantities. Assemblies
  are skipped because their own recorded mass is already a rollup of their
  children. If any leaf has no mass the total reads "—" rather than a number
  that would understate it, and the page says how many are missing.
- **Export CSV** of the flattened view — the shape a purchasing or planning
  sheet wants.
- **Find** across number, name, description and material. In the structured view
  a match keeps its parents, so a search for one screw still shows which
  assembly it is in.
- **Shared** marks a part appearing in more than one place in the BOM.
- **Top level** marks a part nothing in the product contains — usually because
  the assembly holding it is filed under a different product.
- **Cycle** marks a part that contains itself. The walk stops there rather than
  looping, and says so: it is a structure fault, not a deep assembly.

A part filed under another product still appears if something in this product
contains it, with its own product named on the row. Dropping it would understate
what the product is built from.

## Tasks

Onshape has tasks; PLM mirrors them and gives you somewhere to work on them.

**Onshape owns the task.** It is created there, its workflow is defined there,
and its state is whatever Onshape says it is. PLM keeps no second status field
to disagree with — two systems each holding a status is how they come to differ
with nothing to arbitrate between them.

What PLM adds is the working surface:

- A **board** grouped into Open, In Progress, Resolved and Rejected, with the
  real Onshape state on every card. A tenant can name its states anything, so
  the grouping is by meaning and anything unrecognised shows under Open rather
  than disappearing.
- A **list** view for when the question is "what changed" rather than "what is
  where", and an *Assigned to me* filter.
- **The parts a task is about**, resolved to real PLM parts with their number,
  revision and state — so you can open the part from the task. An item PLM does
  not track is still named rather than shown blank.
- **The task's own details** — due date, priority and task state, edited in PLM
  and written back to Onshape. These are metadata *properties* rather than
  fields, each with its own editability: `State` is the workflow's and Onshape
  owns it, so it is shown as a value rather than offered as an edit.
- **A thread.** ⌘/Ctrl + Enter sends.

  A comment written in PLM is appended to the task in Onshape, and one written
  in Onshape appears here. Onshape records a task comment by writing its
  workflow's **Comment** property, which is what PLM does — so a task whose
  workflow has no such property has nowhere to put one. For those, PLM keeps
  the thread itself and marks each comment *PLM only*; the comment box says so
  before you type rather than failing after you press send.
- **The transitions the task itself offers** — Onshape's workflow decides them
  and PLM shows what it is given, rather than fixed buttons that might not
  apply. Completing a task transitions it in Onshape and reads the result back.
- **Drag a card between columns** to move it. The card moves as you drop it and
  Onshape is told; if its workflow has no transition that leads there, the card
  goes back and the reason names the transitions that *are* available. The
  panel's buttons do the same thing, and remain — dragging is a shortcut, and
  it is no use from a keyboard.

**Getting rid of tasks.** Tick cards (or rows in the list) and two options
appear, which do different things:

- **Remove from PLM** clears them from this board and nothing else. They are
  untouched in Onshape, so the next sync brings them back. Use it to tidy a
  mirror.
- **Delete in Onshape** deletes the task itself. Irreversible, admin-only, and
  it asks first. Onshape says per task whether it will allow this: one it
  refuses is reported by name, and where its workflow offers a *Discard*
  transition instead the message says so. One refusal does not stop the rest.

**Two-way, and honest about it.** Every action is pushed to Onshape and the task
re-read rather than assumed: if Onshape accepts a transition and does not move
the task, the page says so instead of claiming a change that did not happen. A
comment Onshape refuses is **kept and marked unsent** — somebody typed it, and
losing it to an error would be worse than showing it as outstanding.

**What you can see depends on the account.** Onshape only lets a company admin
see tasks they neither created nor were assigned. If there are tasks in Onshape
but none here, the integration account set in Settings is most likely not an
admin — the empty board says so rather than leaving you guessing.

Tasks also arrive by webhook. There is no task-specific Onshape event, so they
come in on the general workflow event alongside releases, and comments on
`onshape.comment.create`.

## Releases

### How a release happens

The normal case starts in Onshape:

1. A designer raises a **release candidate**. Onshape creates a release package
   and adds the document's active drawings to it.
2. PLM picks it up, brings in every item, exports each drawing's PDF as it stands
   now, and opens a release **Under Review**.
3. PLM checks its own release-required attributes and lists anything missing.
4. An **approver** approves or rejects.
5. On approval, PLM performs the approve transition on the Onshape package.
   Onshape creates the revisions. PLM records the letters it assigned.
6. Once Onshape has finished, PLM re-exports each drawing at the released version
   — now with its revision, watermark and title-block fields — and keeps that
   alongside the sheet the approvers reviewed.

You can also raise a release **from PLM**: select parts on the Parts page and
press *Submit for release*. PLM creates the Onshape package for you. This is the
one path where a missing release-required attribute genuinely blocks you — the
release does not exist yet, so there is still something to prevent.

### Missing attributes do not block an Onshape release

PLM finds out about an Onshape-raised release only once the package already
exists, so there is nothing left to stop. Instead the gaps are put in front of
the approver, who can fill them in or reject with a reason. Rejecting sends every
part back to *In Work* in both systems.

### The two drawing sheets

Every released drawing keeps two files:

- **As submitted** — exported when the release was raised. No revision, no
  watermark, title block unfilled. This is what the approvers actually looked at.
- **As released** — exported after the release completed, from the version the
  release produced. This is the controlled document.

Both are downloadable, and their filenames say which is which. If the released
sheet has not arrived, the release says so and offers a button to collect it: PLM
normally does this when Onshape announces the new revisions, so this is for when
that notification was missed.

### When Onshape refuses the transition

PLM records its own decision first, then transitions Onshape. If Onshape refuses,
your decision still stands and the release says plainly that it has not reached
Onshape. Decide it again once the cause is fixed.

The usual cause is the service account not being a designated approver on the
Onshape release workflow. Onshape restricts approve transitions to designated
approvers, and PLM performs that transition as the service account.

---

## The Onshape panels

Two right-panel extensions, in the document beside the model.

The **part panel** shows the PLM record for the selected part: its number,
version, lifecycle state and attributes, all editable subject to the same rules as
the full page. If the part is not in PLM yet, one button adds it.

The **assembly panel** reads the assembly's bill of materials and imports what
you select.

Both panels are the same session as the main app. If a panel says you are signed
out, sign in through the link it offers — browsers do not send cookies to a framed
page until you have, and Safari needs the extra permission the panel asks for.

---

## Common questions

**Why does a part say "read-only" against Onshape?**
PLM cannot write to it. Usually it lives in standard content or in a document your
enterprise cannot write to. Nothing is wrong and nothing will change — it is a
settled state, not a queue.

**Why is a write "pending"?**
PLM tried and Onshape refused. The reason is on the part page. Press *Retry write*
once it is addressed.

**A property I changed in Onshape has not appeared.**
Check that the attribute is mapped, and that it is not frozen — a released part
does not take attribute changes from CAD either, because the released record is a
statement about what was approved.

**Can I delete a released part?**
No. Obsolete it instead — an admin can. A released part may be in products already
built, so the record and its history stay.

**Two configurations of a part became one PLM part.**
That is the default, because Onshape reports the configuration string
inconsistently across entry points and the differences otherwise produce duplicate
parts with separate numbers. An admin can turn it off in Settings.
