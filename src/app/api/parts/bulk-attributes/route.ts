import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { connectDb } from "@/lib/db";
import { ActivityLog, Part, PartIteration } from "@/lib/models";
import { listDefinitions, validateAttributes } from "@/lib/attributes";
import { plainAttributes } from "@/lib/sync";
import { handler, ok, fail } from "@/lib/api";

const Body = z.object({
  partIds: z.array(z.string().min(1)).min(1).max(200),
  /** Attribute key -> value. A null clears the value. */
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Set the same attributes on many parts at once.
 *
 * Filling the release-required fields one part at a time is the tedium this
 * exists to remove: a dozen parts each needing a Make/Buy, a unit of measure
 * and a responsible engineer is thirty-six identical edits, and the values are
 * usually the same across the set.
 *
 * Each part is validated and saved on its own terms, and the response says what
 * happened to each. Deliberately not all-or-nothing: one released part in the
 * selection would otherwise block the other eleven, and the useful outcome is
 * "eleven saved, one refused because it is Released" rather than nothing at all.
 * The governance rules are the same ones the single-part edit applies — this is
 * a faster path to them, not a way around them.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Bad request", 400);
  const { partIds, attributes } = parsed.data;

  if (Object.keys(attributes).length === 0) {
    return fail("No attributes were given to set.", 400);
  }

  await connectDb();
  const defs = await listDefinitions(s.enterpriseId, "PART");

  const unknown = Object.keys(attributes).filter((k) => !defs.some((d) => d.key === k));
  if (unknown.length) {
    return fail(`There is no attribute "${unknown[0]}" defined for a part.`, 400);
  }

  const parts: any[] = await Part.find({ enterpriseId: s.enterpriseId, _id: { $in: partIds } });

  const results: {
    partId: string;
    number: string | null;
    ok: boolean;
    changed: string[];
    errors: Record<string, string>;
    reason?: string;
  }[] = [];

  for (const part of parts) {
    const current = plainAttributes(part.attributes);
    const state = String(part.lifecycleState);

    /*
     * Only the keys this part actually needs changing.
     *
     * Sending a value a part already holds would otherwise count as an edit —
     * and since a PLM-side edit earns an iteration, a bulk fill over fifty
     * parts would add fifty iterations recording no change at all.
     */
    const wanted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attributes)) {
      const from = current[k];
      const same =
        from === v ||
        (from == null && (v == null || v === "")) ||
        String(from ?? "") === String(v ?? "");
      if (!same) wanted[k] = v;
    }

    if (Object.keys(wanted).length === 0) {
      results.push({
        partId: String(part._id), number: part.number ?? null, ok: true,
        changed: [], errors: {}, reason: "already set",
      });
      continue;
    }

    const validated = validateAttributes(defs, wanted, current, state);
    if (!validated.ok) {
      results.push({
        partId: String(part._id), number: part.number ?? null, ok: false,
        changed: [], errors: validated.errors,
      });
      continue;
    }

    const changed = Object.keys(wanted);
    part.attributes = validated.values;
    part.markModified("attributes");
    part.iteration = (part.iteration ?? 1) + 1;
    await part.save();

    /*
     * One iteration per part, as a single-part edit produces. The history is
     * per part, so a bulk edit is simply several of them — recording it as one
     * event would leave each part's own history with a gap.
     */
    await PartIteration.create({
      enterpriseId: part.enterpriseId,
      partId: part._id,
      iteration: part.iteration,
      revision: part.revision ?? "",
      lifecycleState: part.lifecycleState,
      attributes: plainAttributes(part.attributes),
      onshapeVersionId: part.versionId ?? null,
      cause: "edit",
      changedKeys: changed,
      createdByEmail: s.email,
    }).catch(() => {});

    results.push({
      partId: String(part._id), number: part.number ?? null, ok: true, changed, errors: {},
    });
  }

  const missing = partIds.filter((id) => !parts.some((p) => String(p._id) === id));
  for (const id of missing) {
    results.push({
      partId: id, number: null, ok: false, changed: [], errors: {},
      reason: "not found in this enterprise",
    });
  }

  const saved = results.filter((r) => r.ok && r.changed.length).length;
  const untouched = results.filter((r) => r.ok && !r.changed.length).length;
  const refused = results.filter((r) => !r.ok);

  await ActivityLog.create({
    enterpriseId: s.enterpriseId,
    direction: "plm",
    action: "updated",
    trigger: "bulk-edit",
    ok: refused.length === 0,
    message:
      `${s.email} set ${Object.keys(attributes).join(", ")} on ${saved} part(s)` +
      (untouched ? `; ${untouched} already held the value` : "") +
      (refused.length ? `; ${refused.length} refused` : "") + ".",
  });

  return ok({
    saved,
    untouched,
    refused: refused.length,
    results,
    message:
      refused.length === 0
        ? saved === 0
          ? `Nothing to change — all ${untouched} already held those values.`
          : `Set on ${saved} part(s)` + (untouched ? `, ${untouched} already matched` : "") + "."
        : `Set on ${saved} part(s); ${refused.length} refused. ` +
          refused
            .slice(0, 3)
            .map((r) => `${r.number ?? r.partId}: ${r.reason ?? Object.values(r.errors)[0] ?? "refused"}`)
            .join("; "),
  });
});
