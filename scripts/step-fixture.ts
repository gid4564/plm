/**
 * Build STEP text for tests, in the shape real exporters write it.
 *
 * Each product gets the full chain the scanner follows — PRODUCT, formation,
 * definition, definition shape, its own SHAPE_REPRESENTATION, and (when it has
 * solids) an ADVANCED_BREP_SHAPE_REPRESENTATION tied on by a simple
 * SHAPE_REPRESENTATION_RELATIONSHIP. Each use of a child is a
 * NEXT_ASSEMBLY_USAGE_OCCURRENCE plus the complex placement relationship real
 * files carry, which the scanner must not mistake for the part's own shape.
 */
export type FixtureProduct = {
  name: string;
  solids?: number;
  children?: { product: string; count: number }[];
};

export function stepFixture(products: FixtureProduct[]): Buffer {
  const lines: string[] = [];
  let n = 100;
  const next = () => ++n;
  const pd = new Map<string, number>();
  const rep = new Map<string, number>();

  for (const p of products) {
    const prod = next(), form = next(), def = next(), pds = next(), r = next(), sdr = next();
    const quoted = p.name.replace(/'/g, "''");
    lines.push(`#${prod}=PRODUCT('${quoted}','${quoted}','',(#1));`);
    lines.push(`#${form}=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prod},\n  .NOT_KNOWN.);`);
    lines.push(`#${def}=PRODUCT_DEFINITION('design','',#${form},#2);`);
    lines.push(`#${pds}=PRODUCT_DEFINITION_SHAPE('','',#${def});`);
    lines.push(`#${r}=SHAPE_REPRESENTATION('',(#3),#4);`);
    lines.push(`#${sdr}=SHAPE_DEFINITION_REPRESENTATION(#${pds},#${r});`);
    pd.set(p.name, def);
    rep.set(p.name, r);

    if (p.solids) {
      const solids = Array.from({ length: p.solids }, () => next());
      for (const s of solids) lines.push(`#${s}=MANIFOLD_SOLID_BREP('${quoted}',#5);`);
      const brep = next(), srr = next();
      lines.push(`#${brep}=ADVANCED_BREP_SHAPE_REPRESENTATION('',(${solids.map((s) => `#${s}`).join(",")}),#4);`);
      lines.push(`#${srr}=SHAPE_REPRESENTATION_RELATIONSHIP('','',#${r},#${brep});`);
    }
  }

  for (const p of products) {
    for (const c of p.children ?? []) {
      for (let i = 0; i < c.count; i++) {
        const nauo = next(), place = next();
        lines.push(`#${nauo}=NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO${nauo}','${c.product}','',#${pd.get(p.name)},#${pd.get(c.product)},$);`);
        lines.push(
          `#${place}=(REPRESENTATION_RELATIONSHIP('','',#${rep.get(c.product)},#${rep.get(p.name)})` +
          `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#6)SHAPE_REPRESENTATION_RELATIONSHIP());`
        );
      }
    }
  }

  return Buffer.from(
    [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('test; with a semicolon'),'2;1');",
      "FILE_NAME('fixture.step','2026-11-02',(''),(''),'','','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
      "ENDSEC;",
      "DATA;",
      "/* written by the PLM test fixture */",
      ...lines,
      "ENDSEC;",
      "END-ISO-10303-21;",
    ].join("\n"),
    "latin1"
  );
}
