import { connectDb } from "@/lib/db";
import { NumberingSequence } from "@/lib/models";

/**
 * The number generator. PLM is the number master.
 *
 * Not a demonstration aside: every part, assembly, drawing and release gets its
 * identifier from here, and Onshape's own part number generator extension calls
 * in for one — which is what puts a PLM number on a part at the moment someone
 * opens the Release candidate dialog, rather than after the fact.
 *
 * RELEASE is in the same machinery as the rest so that release numbers get the
 * same never-reused guarantee. A release number appears in approval records and
 * in Onshape's changeOrderId, so reissuing one would make two releases
 * indistinguishable in the audit trail.
 */
export type NumberingType = "PART" | "ASSEMBLY" | "DRAWING" | "RELEASE";
export const NUMBERING_TYPES: NumberingType[] = ["PART", "ASSEMBLY", "DRAWING", "RELEASE"];

const DEFAULT_PREFIX: Record<NumberingType, string> = {
  PART: "PN-",
  ASSEMBLY: "AS-",
  DRAWING: "DWG-",
  RELEASE: "REL-",
};

/**
 * Build the full number from its parts.
 *
 * Pure, so the format — padding width, where the prefix and suffix land — can
 * be pinned down by a test without touching a database. A negative or
 * fractional counter cannot occur through nextNumber, but is still clamped
 * here rather than trusted, since this is also reachable from the admin-set
 * padding value.
 */
export function formatNumber(prefix: string, counter: number, padding: number, suffix: string): string {
  const digits = String(Math.max(0, Math.trunc(counter))).padStart(Math.max(0, Math.trunc(padding)), "0");
  return `${prefix ?? ""}${digits}${suffix ?? ""}`;
}

/** The scheme for one type, created with a sensible starting prefix on first use. */
export async function getOrCreateSequence(enterpriseId: string, type: NumberingType) {
  await connectDb();
  const existing: any = await NumberingSequence.findOne({ enterpriseId, type }).lean();
  if (existing) return existing;

  try {
    const created = await NumberingSequence.create({
      enterpriseId, type, prefix: DEFAULT_PREFIX[type], suffix: "", padding: 5, counter: 0,
    });
    return created.toObject();
  } catch (err: any) {
    // Two requests racing to create the same enterprise+type for the first
    // time — the loser reads what the winner just created.
    if (err?.code === 11000) {
      const winner: any = await NumberingSequence.findOne({ enterpriseId, type }).lean();
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Allocate the next number for a type.
 *
 * $inc inside findOneAndUpdate is atomic, so two requests racing for the same
 * type cannot be handed the same number — which matters most on the path this
 * exists for: two designers raising release candidates at the same moment.
 *
 * Once allocated, a number is never reused, even if writing it into Onshape
 * afterwards fails. It may already have been read, quoted, or written down by
 * whoever requested it; reissuing it to someone else because the write failed
 * would risk two things wearing the same number, which is worse than one
 * number that looks unused.
 */
export async function nextNumber(
  enterpriseId: string,
  type: NumberingType
): Promise<{ number: string; counter: number }> {
  await connectDb();
  await getOrCreateSequence(enterpriseId, type);

  const seq: any = await NumberingSequence.findOneAndUpdate(
    { enterpriseId, type },
    { $inc: { counter: 1 } },
    { new: true }
  );
  if (!seq) throw new Error("Numbering scheme not found");

  return { number: formatNumber(seq.prefix, seq.counter, seq.padding, seq.suffix), counter: seq.counter };
}
