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
- **Import from Assembly** — brings in the assembly and everything under it.
- **A release** — every item in a release package is brought in automatically.

Editing a property in Onshape does **not** bring a part in. If it did, every
property a designer touched would allocate a PLM number nobody asked for. It does
keep an existing part current.

### Numbers

PLM issues them, and writes them onto the Onshape part. This also works from
inside Onshape: the *Part number generator* extension means opening the Release
candidate dialog gets a PLM number applied then and there, rather than after the
fact.

Numbers are never reused, even if the write to Onshape fails afterwards. A number
that might already be in a quote or a drawing is worse to reissue than to leave
looking unused.

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

### Structure

Importing an assembly's BOM brings in the assembly as its own PLM object and
records each row beneath it with the quantity the model reports. Quantities live
on the link, not on the part — a part used four times in one assembly and twice in
another has two quantities, and neither is a property of the part.

Every part page shows both directions: what it contains, and what it is used in.

---

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
