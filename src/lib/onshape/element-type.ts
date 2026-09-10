import type { NumberingType } from "@/lib/numbering";

/**
 * Working out what kind of Onshape element a request is about.
 *
 * Lives here rather than in the route because a route module may export only
 * its HTTP handlers — and because this is the piece most worth testing on its
 * own: it is where an undocumented enum meets a decision that has to be made
 * anyway.
 */

/*
 * How Onshape names an element type — in words, when it uses words.
 *
 * Keys are compared with spacing and punctuation stripped, so "Part Studio",
 * "PART_STUDIO" and "partstudio" all land on the same entry.
 */
const ELEMENT_TYPE_WORDS: Record<string, NumberingType> = {
  PARTSTUDIO: "PART",
  PART: "PART",
  PARTS: "PART",
  ASSEMBLY: "ASSEMBLY",
  ASSEMBLIES: "ASSEMBLY",
  SUBASSEMBLY: "ASSEMBLY",
  DRAWING: "DRAWING",
  DRAWINGS: "DRAWING",
};

/*
 * And in numbers, which is what it actually sends here.
 *
 * The live payload carries `elementType: 0` — an integer, not the string the
 * reference sample implied. This mapping is **not** documented publicly; I
 * could not find it in Onshape's API docs or its samples. So:
 *
 *   0  observed. It arrived alongside partId="JMD", and only a part carries a
 *      part id, so this request was for a part in a Part Studio.
 *   1  inferred. PARTSTUDIO, ASSEMBLY, DRAWING is the order Onshape lists its
 *      string element types in throughout its documentation.
 *   2  inferred, same reasoning.
 *
 * Because 1 and 2 are inferences, they are not what the classifier leans on —
 * see classify(), which prefers the structure of the request over this table.
 * Confirm them by requesting a number from an assembly and from a drawing and
 * reading the logged elementType; then this comment can lose its hedge.
 */
const ELEMENT_TYPE_CODES: Record<number, NumberingType> = {
  0: "PART",
  1: "ASSEMBLY",
  2: "DRAWING",
};

export type Classification = { type: NumberingType; from: string; confident: boolean };

/**
 * Decide which numbering scheme an item belongs to.
 *
 * Ordered by how much each signal can be trusted, not by how convenient it is:
 *
 *  1. A word in elementType, which is unambiguous when present.
 *  2. A non-empty partId. This is structural rather than declarative — only a
 *     part has one, so it identifies a part whatever the type code says, and it
 *     is the signal that made the live request classifiable at all.
 *  3. mimeType, then a word in resourceType.
 *  4. The numeric code table above, whose non-zero entries are inferred.
 *
 * It never returns null. The request is someone pressing a button to get a
 * number, and the scheme only decides a prefix — so guessing PART and saying so
 * in the log is better than refusing, which leaves the Release candidate dialog
 * unable to number anything. `confident` is false when it came to that, so the
 * caller can log it as a guess rather than a fact.
 */
export function classify(item: Record<string, unknown>): Classification {
  const norm = (v: unknown) => String(v ?? "").toUpperCase().replace(/[\s_\-.]+/g, "");

  const word = ELEMENT_TYPE_WORDS[norm(item.elementType)];
  if (word) return { type: word, from: "elementType word", confident: true };

  const partId = String(item.partId ?? "").trim();
  if (partId && !/^\{\$.*\}$/.test(partId)) {
    return { type: "PART", from: `partId "${partId}"`, confident: true };
  }

  // Mime types read like application/vnd.onshape.ins-assembly, so a substring
  // match identifies them rather than an exact table.
  const mime = norm(item.mimeType);
  if (mime) {
    for (const [key, type] of Object.entries(ELEMENT_TYPE_WORDS)) {
      if (mime.includes(key)) return { type, from: "mimeType", confident: true };
    }
  }

  const resource = ELEMENT_TYPE_WORDS[norm(item.resourceType)];
  if (resource) return { type: resource, from: "resourceType word", confident: true };

  const code = Number(item.elementType);
  if (Number.isInteger(code) && code in ELEMENT_TYPE_CODES) {
    const type = ELEMENT_TYPE_CODES[code];
    return {
      type,
      from: `elementType code ${code}`,
      // Only 0 is observed; the rest are inferred from the documented ordering.
      confident: code === 0,
    };
  }

  return {
    type: "PART",
    from: `nothing identifiable (elementType=${JSON.stringify(item.elementType ?? null)})`,
    confident: false,
  };
}
