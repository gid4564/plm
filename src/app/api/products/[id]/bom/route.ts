import { requireSession } from "@/lib/auth/session";
import { buildProductBom, parseAsOf } from "@/lib/product-bom";
import { handler, ok } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A product's bill of materials.
 *
 * Both shapes come back in one response rather than one per view. They are the
 * same walk collapsed differently, the payload is small, and switching view is
 * the most likely next click — fetching again would make a toggle feel like a
 * page load, and risks the two views disagreeing about quantities if the data
 * changes between requests.
 *
 * `?asOf=` filters by effectivity: a date, `today`, or `all` (the default).
 * `?format=csv` returns the flattened rows as a file.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const url = new URL(req.url);

  const asOf = parseAsOf(url.searchParams.get("asOf"));
  const bom = await buildProductBom(s.enterpriseId, id, { asOf });

  if (url.searchParams.get("format") === "csv") {
    /*
     * The flattened view, because that is the one people take elsewhere — a
     * purchasing or planning sheet wants one row per part with a total, not an
     * indented tree that loses its meaning in a spreadsheet.
     */
    const header = [
      "Level", "Part number", "Name", "Description", "Material", "State", "Revision",
      "Quantity", "Used in", "Mass (kg)", "Effective from", "Effective to", "Product",
    ];
    const rows = bom.flat.map((r) => [
      r.level + 1, r.number ?? "", r.name, r.description, r.material, r.lifecycleState,
      r.revision, r.totalQuantity, r.usedIn, r.massKg ?? "",
      r.effectiveFrom?.slice(0, 10) ?? "", r.effectiveTo?.slice(0, 10) ?? "", r.productName,
    ]);

    const csv = [header, ...rows]
      .map((line) => line.map(csvCell).join(","))
      .join("\r\n");

    const name = `${(bom.product?.name ?? "product").replace(/[^A-Za-z0-9._-]+/g, "-")}-bom` +
      `${bom.asOf ? `-as-of-${bom.asOf.slice(0, 10)}` : ""}.csv`;

    return new Response(`﻿${csv}`, {
      headers: {
        // The BOM is a moving target; a cached copy is worse than a fresh fetch.
        "Cache-Control": "no-store",
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  }

  return ok(bom);
});

/**
 * One CSV cell.
 *
 * Quoted whenever it contains a delimiter, a quote or a newline — a part
 * description with a comma in it would otherwise shift every column after it.
 * A leading =, +, - or @ is prefixed with a quote so a spreadsheet does not
 * read a part name as a formula.
 */
function csvCell(v: unknown): string {
  const s = String(v ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
