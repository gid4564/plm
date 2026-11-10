/**
 * One GLB for a whole configured assembly, built from its parts.
 *
 * Why not Onshape's assembly export: probed on the live Flight Case (10 Nov
 * 2026), `POST /assemblies/…/export/gltf` ignores the configuration — two
 * different cases came back byte-identical, as the default — and returned a
 * 159 MB zip of loose per-occurrence glTF files after ~86 s. The part export
 * (`GET /parts/…/gltf?configuration=`) does honour the configuration and is
 * about 1 MB a part, and the assembly definition gives every occurrence's
 * placement for the same configuration. So each distinct part is exported
 * once and placed wherever the assembly uses it — the latch, used three
 * times, is one mesh drawn three times.
 *
 * Pure: bytes in, bytes out. No Onshape, no database.
 */

export type GlbParts = { json: any; bin: Buffer };

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Read a GLB, or a glTF JSON with its buffers inline as data URIs. */
export function parseGltf(bytes: Buffer): GlbParts {
  if (bytes.length >= 12 && bytes.readUInt32LE(0) === GLB_MAGIC) {
    let off = 12;
    let json: any = null;
    let bin = Buffer.alloc(0);
    while (off + 8 <= bytes.length) {
      const len = bytes.readUInt32LE(off);
      const type = bytes.readUInt32LE(off + 4);
      const body = bytes.subarray(off + 8, off + 8 + len);
      if (type === CHUNK_JSON) json = JSON.parse(body.toString("utf8"));
      else if (type === CHUNK_BIN) bin = Buffer.from(body);
      off += 8 + len;
    }
    if (!json) throw new Error("A GLB with no JSON chunk.");
    return { json, bin };
  }
  // glTF JSON: fold every data-URI buffer into one binary, in order.
  const json = JSON.parse(bytes.toString("utf8"));
  const pieces: Buffer[] = [];
  const starts: number[] = [];
  let total = 0;
  for (const b of json.buffers ?? []) {
    const m = /^data:[^;]*;base64,(.*)$/.exec(b.uri ?? "");
    if (!m) throw new Error("A glTF buffer that is not inline cannot be read here.");
    const data = Buffer.from(m[1], "base64");
    starts.push(total);
    pieces.push(data, Buffer.alloc((4 - (data.length % 4)) % 4));
    total += data.length + ((4 - (data.length % 4)) % 4);
  }
  for (const v of json.bufferViews ?? []) {
    v.byteOffset = (v.byteOffset ?? 0) + starts[v.buffer ?? 0];
    v.buffer = 0;
  }
  json.buffers = [{ byteLength: total }];
  return { json, bin: Buffer.concat(pieces) };
}

/** Wrap JSON and a binary blob as a GLB. */
export function writeGlb(json: any, bin: Buffer): Buffer {
  const pad = (b: Buffer, fill: number) => {
    const extra = (4 - (b.length % 4)) % 4;
    return extra ? Buffer.concat([b, Buffer.alloc(extra, fill)]) : b;
  };
  const j = pad(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const b = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + (b.length ? 8 + b.length : 0), 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(CHUNK_JSON, 4);
  const parts = [header, jh, j];
  if (b.length) {
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(b.length, 0);
    bh.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(bh, b);
  }
  return Buffer.concat(parts);
}

/** Onshape's 4×4 transform is row-major; glTF's node matrix is column-major. */
export function toColumnMajor(m: number[]): number[] {
  return [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => m[r * 4 + c]));
}

export type Placement = { key: string; name: string; transform: number[] };

/**
 * Merge part models into one scene.
 *
 * `parts` maps a key (one distinct part in one configuration) to its glTF;
 * each placement draws that part's whole scene once, under a node carrying
 * the placement's transform. Meshes, materials and textures are copied once
 * per part and shared by every placement of it. A placement whose part is
 * missing is skipped — the caller reports it.
 */
export function composeGlb(parts: Map<string, Buffer>, placements: Placement[], name = "Assembly"): Buffer {
  // One root for the whole assembly, turning Onshape's Z-up into glTF's Y-up
  // (−90° about X): Onshape's part exports and placements are Z-up (the
  // Flight Case Base's height runs along z), and a viewer stands a Y-up scene
  // on its feet.
  const out: any = {
    asset: { version: "2.0", generator: "PLM configurator" },
    scene: 0, scenes: [{ name, nodes: [0] }],
    nodes: [{ name, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [] as number[] }],
    meshes: [], accessors: [], bufferViews: [], materials: [],
    textures: [], images: [], samplers: [], buffers: [],
  };
  const used = new Set<string>();
  const required = new Set<string>();
  const bins: Buffer[] = [];
  let binLength = 0;

  // Per part: its meshes copied once, and the node tree to repeat per placement.
  const imported = new Map<string, { roots: number[]; json: any; meshBase: number }>();
  for (const [key, bytes] of parts) {
    const { json, bin } = parseGltf(bytes);
    for (const e of json.extensionsUsed ?? []) used.add(e);
    for (const e of json.extensionsRequired ?? []) required.add(e);
    const base = {
      bufferView: out.bufferViews.length, accessor: out.accessors.length, mesh: out.meshes.length,
      material: out.materials.length, texture: out.textures.length, image: out.images.length, sampler: out.samplers.length,
    };
    const offset = binLength;
    bins.push(bin, Buffer.alloc((4 - (bin.length % 4)) % 4));
    binLength += bin.length + ((4 - (bin.length % 4)) % 4);

    for (const v of json.bufferViews ?? []) out.bufferViews.push({ ...v, buffer: 0, byteOffset: (v.byteOffset ?? 0) + offset });
    for (const a of json.accessors ?? []) {
      const c = { ...a };
      if (c.bufferView != null) c.bufferView += base.bufferView;
      if (c.sparse) c.sparse = {
        ...c.sparse,
        indices: { ...c.sparse.indices, bufferView: c.sparse.indices.bufferView + base.bufferView },
        values: { ...c.sparse.values, bufferView: c.sparse.values.bufferView + base.bufferView },
      };
      out.accessors.push(c);
    }
    for (const im of json.images ?? []) out.images.push(im.bufferView != null ? { ...im, bufferView: im.bufferView + base.bufferView } : im);
    for (const s of json.samplers ?? []) out.samplers.push(s);
    for (const t of json.textures ?? []) out.textures.push({
      ...t,
      ...(t.source != null ? { source: t.source + base.image } : {}),
      ...(t.sampler != null ? { sampler: t.sampler + base.sampler } : {}),
    });
    const tex = (ref: any) => (ref && ref.index != null ? { ...ref, index: ref.index + base.texture } : ref);
    for (const m of json.materials ?? []) {
      const c = JSON.parse(JSON.stringify(m));
      if (c.pbrMetallicRoughness) {
        c.pbrMetallicRoughness.baseColorTexture = tex(c.pbrMetallicRoughness.baseColorTexture);
        c.pbrMetallicRoughness.metallicRoughnessTexture = tex(c.pbrMetallicRoughness.metallicRoughnessTexture);
      }
      for (const k of ["normalTexture", "occlusionTexture", "emissiveTexture"]) if (c[k]) c[k] = tex(c[k]);
      out.materials.push(c);
    }
    for (const m of json.meshes ?? []) out.meshes.push({
      ...m,
      primitives: m.primitives.map((p: any) => {
        const attributes: Record<string, number> = {};
        for (const [k, v] of Object.entries(p.attributes ?? {})) attributes[k] = (v as number) + base.accessor;
        return {
          ...p, attributes,
          ...(p.indices != null ? { indices: p.indices + base.accessor } : {}),
          ...(p.material != null ? { material: p.material + base.material } : {}),
          ...(p.targets ? { targets: p.targets.map((t: any) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, (v as number) + base.accessor]))) } : {}),
        };
      }),
    });
    const scene = json.scenes?.[json.scene ?? 0];
    const roots: number[] = scene?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i)
      .filter((i: number) => !(json.nodes ?? []).some((n: any) => (n.children ?? []).includes(i)));
    imported.set(key, { roots, json, meshBase: base.mesh });
  }

  // A node may have one parent only, so each placement gets its own copy of
  // the part's node tree — pointing at the shared meshes.
  const copyNode = (json: any, meshBase: number, i: number): number => {
    const n = json.nodes[i];
    const { children, mesh, extensions, camera, skin, ...rest } = n;
    const idx = out.nodes.length;
    out.nodes.push({ ...rest, ...(mesh != null ? { mesh: mesh + meshBase } : {}) });
    const kids = (children ?? []).map((c: number) => copyNode(json, meshBase, c));
    if (kids.length) out.nodes[idx].children = kids;
    return idx;
  };
  for (const p of placements) {
    const part = imported.get(p.key);
    if (!part) continue;
    const idx = out.nodes.length;
    out.nodes.push({ name: p.name, matrix: toColumnMajor(p.transform) });
    const kids = part.roots.map((r) => copyNode(part.json, part.meshBase, r));
    if (kids.length) out.nodes[idx].children = kids;
    out.nodes[0].children.push(idx);
  }

  // Onshape's own metadata extension describes per-part ids that mean nothing
  // once merged; it is dropped from the nodes above, and so from this list.
  used.delete("PTC_onshape_metadata");
  if (used.size) out.extensionsUsed = [...used];
  if (required.size) out.extensionsRequired = [...required];
  for (const k of ["textures", "images", "samplers", "materials"]) if (!out[k].length) delete out[k];
  const bin = Buffer.concat(bins);
  out.buffers = bin.length ? [{ byteLength: bin.length }] : [];
  if (!bin.length) delete out.buffers;
  return writeGlb(out, bin);
}

/**
 * A plain box, as a GLB — for the simulator, which has no real geometry.
 * Size in metres; centred on the origin in x and y, sitting on z = 0.
 */
export function boxGlb(size: [number, number, number], color: [number, number, number, number] = [0.6, 0.62, 0.66, 1]): Buffer {
  const [x, y, z] = size.map((v) => v / 2);
  const zz = size[2];
  const faces: [number[], number[]][] = [
    [[0, 0, 1], [-x, -y, zz, x, -y, zz, x, y, zz, -x, y, zz]],
    [[0, 0, -1], [-x, y, 0, x, y, 0, x, -y, 0, -x, -y, 0]],
    [[1, 0, 0], [x, -y, 0, x, y, 0, x, y, zz, x, -y, zz]],
    [[-1, 0, 0], [-x, y, 0, -x, -y, 0, -x, -y, zz, -x, y, zz]],
    [[0, 1, 0], [x, y, 0, -x, y, 0, -x, y, zz, x, y, zz]],
    [[0, -1, 0], [-x, -y, 0, x, -y, 0, x, -y, zz, -x, -y, zz]],
  ];
  void z;
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  faces.forEach(([n, q], f) => {
    for (let i = 0; i < 4; i++) { pos.push(q[i * 3], q[i * 3 + 1], q[i * 3 + 2]); nor.push(...n); }
    const b = f * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const P = Buffer.from(new Float32Array(pos).buffer);
  const N = Buffer.from(new Float32Array(nor).buffer);
  const I = Buffer.from(new Uint16Array(idx).buffer);
  const bin = Buffer.concat([P, N, I, Buffer.alloc((4 - (I.length % 4)) % 4)]);
  const min = [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k)));
  return writeGlb({
    asset: { version: "2.0", generator: "PLM simulator" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0.1, roughnessFactor: 0.7 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: P.length },
      { buffer: 0, byteOffset: P.length, byteLength: N.length },
      { buffer: 0, byteOffset: P.length + N.length, byteLength: I.length },
    ],
    buffers: [{ byteLength: bin.length }],
  }, bin);
}
