import JSZip from "jszip";

/**
 * Repacking Onshape's zipped assembly export into one self-contained GLB.
 *
 * The single-part glTF export is a synchronous GET that returns GLB bytes
 * directly (see live-client's exportGltf). An assembly goes through a
 * translation job instead, and for a translation Onshape sometimes cannot
 * produce a single binary file — its own exporter falls back to the loose
 * glTF form (a `.gltf` JSON file, a `.bin` for the mesh data, and separate
 * image files for any texture), and since a translation's result can only be
 * one download, that whole folder arrives zipped.
 *
 * PLM stores one Buffer per part per revision — see PartGeometry — so a
 * multi-file result has to become one file before it can be kept at all. This
 * does that: unzip, read every buffer and texture the glTF JSON references,
 * concatenate them into a single binary blob, rewrite the JSON's own
 * references to point into it, and wrap the result in a GLB container. What
 * comes out is exactly what the direct single-part export already produces,
 * so everything downstream — detectGltfFormat, the size limit, the viewer —
 * needs no idea any of this happened.
 */

/** True for the bytes a zip file starts with — the standard local-file-header signature. */
export function looksLikeZip(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

/**
 * Unzip Onshape's export and return one packed GLB.
 *
 * An assembly's zip can hold more than one model file — Onshape's exporter
 * appears to reuse the same per-part export machinery for each member and
 * bundle the results, rather than always writing one combined scene. Taking
 * only the first file — an earlier version of this function did exactly that,
 * via `.find()` — silently discarded every other part: the capture "worked"
 * (a valid, well-formed GLB came out) and stored exactly one member of the
 * assembly, which reads as correct until someone notices the model in the
 * viewer is missing everything but one part. So every `.gltf`/`.glb` file
 * found is read and folded into one scene — see combineDocuments — and the
 * single-file case (by far the common one, still true for every part export)
 * is handled as its own path so it costs nothing extra.
 *
 * Throws rather than returning null: every failure here has a specific,
 * actionable reason (no glTF inside, a buffer the JSON names but the zip does
 * not contain), and the caller's `fail()` already turns a thrown message into
 * a stored failure reason. Collapsing those into a generic "not a glTF" would
 * throw away exactly the detail worth keeping.
 */
export async function unpackGltfZip(zipBytes: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(zipBytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const modelNames = names.filter((n) => /\.(gltf|glb)$/i.test(n)).sort();

  if (!modelNames.length) {
    throw new Error(
      `The zip Onshape returned has no .gltf or .glb file inside ` +
      `(it contains: ${names.join(", ") || "nothing"}).`
    );
  }

  // The common case: one file, already a GLB. Onshape has been seen to zip a
  // single binary file too, not only the loose form — passed through
  // byte-for-byte, since there is nothing here to merge.
  if (modelNames.length === 1 && /\.glb$/i.test(modelNames[0])) {
    return Buffer.from(await zip.files[modelNames[0]].async("nodebuffer"));
  }

  const parts: { doc: any; bin: Buffer }[] = [];
  for (const name of modelNames) {
    if (/\.glb$/i.test(name)) {
      parts.push(unpackGlb(Buffer.from(await zip.files[name].async("nodebuffer"))));
      continue;
    }
    const doc = JSON.parse(await zip.files[name].async("string"));
    const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    const bin = await mergeExternalResources(doc, zip, dir);
    parts.push({ doc, bin });
  }

  const { doc, bin } = combineDocuments(parts);
  return packGlb(doc, bin);
}

/** A uri pointing outside the JSON: a data: URI decoded in place, anything else read from the zip. */
async function resolveUri(uri: string | undefined, zip: JSZip, dir: string): Promise<Buffer> {
  if (!uri) throw new Error("The glTF JSON names a buffer or image with no uri.");
  if (uri.startsWith("data:")) {
    return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  }
  const decoded = decodeURIComponent(uri);
  const path = dir ? `${dir}/${decoded}` : decoded;
  const entry = zip.file(path) ?? zip.file(decoded);
  if (!entry) {
    throw new Error(`The glTF JSON references "${uri}", which is not in the zip.`);
  }
  return Buffer.from(await entry.async("nodebuffer"));
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
};

/** Pad to a 4-byte boundary — every segment of a GLB's binary chunk must land on one. */
function align(chunks: Buffer[], offset: number): number {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) chunks.push(Buffer.alloc(pad));
  return offset + pad;
}

/**
 * Fold every buffer and loose-file texture the document references into one
 * blob, and rewrite the document in place to describe that single blob.
 *
 * A GLB has exactly one binary chunk — that is what "self-contained" means —
 * so this is the whole of what turning the loose form into a GLB requires.
 */
async function mergeExternalResources(doc: any, zip: JSZip, dir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;

  const bufferOffsets: number[] = [];
  for (const buf of doc.buffers ?? []) {
    const bytes = await resolveUri(buf.uri, zip, dir);
    offset = align(chunks, offset);
    bufferOffsets.push(offset);
    chunks.push(bytes);
    offset += bytes.length;
  }

  // Every bufferView pointed at one of the original buffers by index and an
  // offset within it; now there is only buffer 0, so both are rewritten.
  for (const bv of doc.bufferViews ?? []) {
    bv.byteOffset = (bv.byteOffset ?? 0) + bufferOffsets[bv.buffer ?? 0];
    bv.buffer = 0;
  }

  doc.bufferViews = doc.bufferViews ?? [];
  for (const img of doc.images ?? []) {
    // Already a bufferView reference, or an inline data: URI — nothing to fold in.
    if (img.bufferView != null || !img.uri || img.uri.startsWith("data:")) continue;

    const bytes = await resolveUri(img.uri, zip, dir);
    offset = align(chunks, offset);
    doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    img.bufferView = doc.bufferViews.length - 1;
    img.mimeType = img.mimeType ?? MIME_BY_EXTENSION[img.uri.split(".").pop()?.toLowerCase() ?? ""];
    delete img.uri;
    chunks.push(bytes);
    offset += bytes.length;
  }

  const merged = Buffer.concat(chunks);
  doc.buffers = [{ byteLength: merged.length }];
  return merged;
}

/** The inverse of packGlb — read an already-packed GLB back into {doc, bin}. */
function unpackGlb(glb: Buffer): { doc: any; bin: Buffer } {
  const jsonLength = glb.readUInt32LE(12);
  const doc = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));

  const binHeaderOffset = 20 + jsonLength;
  let bin: Buffer = Buffer.alloc(0);
  if (binHeaderOffset < glb.length) {
    const binLength = glb.readUInt32LE(binHeaderOffset);
    bin = Buffer.from(glb.subarray(binHeaderOffset + 8, binHeaderOffset + 8 + binLength));
  }
  return { doc, bin };
}

/**
 * Fold several independent glTF documents — one per part — into one scene.
 *
 * Each has already been through mergeExternalResources (or was a GLB to
 * begin with), so each arrives as a self-contained {doc, bin} pair: its own
 * single buffer, its own accessors, meshes, materials, nodes. None of those
 * indices mean anything once several documents share one buffer and one
 * array of each — a `mesh: 0` from the second document would otherwise
 * collide with the first document's own mesh 0 — so every index a document's
 * arrays are referenced by is shifted by how much of that array the
 * documents before it already contributed, the same idea `mergeExternalResources`
 * already applies to bufferViews.
 *
 * A single document is returned untouched: the common case (one part, or an
 * assembly export that already came back as one file) pays nothing for a
 * merge it does not need.
 */
function combineDocuments(parts: { doc: any; bin: Buffer }[]): { doc: any; bin: Buffer } {
  if (parts.length === 1) return parts[0];

  const chunks: Buffer[] = [];
  let offset = 0;

  const combined: any = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [] as number[] }],
    nodes: [] as any[],
    meshes: [] as any[],
    materials: [] as any[],
    textures: [] as any[],
    images: [] as any[],
    samplers: [] as any[],
    accessors: [] as any[],
    bufferViews: [] as any[],
    buffers: [] as any[],
  };

  const shiftTextureRef = (ref: any, textureOffset: number) => {
    if (ref && typeof ref.index === "number") ref.index += textureOffset;
  };

  for (const { doc, bin } of parts) {
    const bufferViewOffset = combined.bufferViews.length;
    const accessorOffset = combined.accessors.length;
    const imageOffset = combined.images.length;
    const samplerOffset = combined.samplers.length;
    const textureOffset = combined.textures.length;
    const materialOffset = combined.materials.length;
    const meshOffset = combined.meshes.length;
    const nodeOffset = combined.nodes.length;

    offset = align(chunks, offset);
    const partOffset = offset;
    chunks.push(bin);
    offset += bin.length;

    for (const bv of doc.bufferViews ?? []) {
      combined.bufferViews.push({ ...bv, buffer: 0, byteOffset: (bv.byteOffset ?? 0) + partOffset });
    }
    for (const a of doc.accessors ?? []) {
      combined.accessors.push({
        ...a, bufferView: a.bufferView != null ? a.bufferView + bufferViewOffset : undefined,
      });
    }
    for (const s of doc.samplers ?? []) combined.samplers.push({ ...s });
    for (const img of doc.images ?? []) {
      combined.images.push({
        ...img, bufferView: img.bufferView != null ? img.bufferView + bufferViewOffset : undefined,
      });
    }
    for (const tex of doc.textures ?? []) {
      combined.textures.push({
        ...tex,
        source: tex.source != null ? tex.source + imageOffset : undefined,
        sampler: tex.sampler != null ? tex.sampler + samplerOffset : undefined,
      });
    }
    for (const mat of doc.materials ?? []) {
      const m = JSON.parse(JSON.stringify(mat));
      if (m.pbrMetallicRoughness?.baseColorTexture) {
        shiftTextureRef(m.pbrMetallicRoughness.baseColorTexture, textureOffset);
      }
      if (m.pbrMetallicRoughness?.metallicRoughnessTexture) {
        shiftTextureRef(m.pbrMetallicRoughness.metallicRoughnessTexture, textureOffset);
      }
      shiftTextureRef(m.normalTexture, textureOffset);
      shiftTextureRef(m.occlusionTexture, textureOffset);
      shiftTextureRef(m.emissiveTexture, textureOffset);
      combined.materials.push(m);
    }
    for (const mesh of doc.meshes ?? []) {
      const mm = JSON.parse(JSON.stringify(mesh));
      for (const prim of mm.primitives ?? []) {
        if (prim.indices != null) prim.indices += accessorOffset;
        if (prim.material != null) prim.material += materialOffset;
        for (const key of Object.keys(prim.attributes ?? {})) prim.attributes[key] += accessorOffset;
      }
      combined.meshes.push(mm);
    }
    for (const node of doc.nodes ?? []) {
      const n = { ...node };
      if (n.mesh != null) n.mesh += meshOffset;
      if (Array.isArray(n.children)) n.children = n.children.map((c: number) => c + nodeOffset);
      combined.nodes.push(n);
    }

    const sceneIndex = doc.scene ?? 0;
    const sceneNodes: number[] = doc.scenes?.[sceneIndex]?.nodes ?? [];
    for (const idx of sceneNodes) combined.scenes[0].nodes.push(idx + nodeOffset);
  }

  const merged = Buffer.concat(chunks);
  combined.buffers = [{ byteLength: merged.length }];

  // Declaring an array that stayed empty is more likely to confuse a strict
  // loader than help one — most of these will be empty on any part with no
  // texture at all.
  for (const key of ["samplers", "textures", "images", "materials"] as const) {
    if (combined[key].length === 0) delete combined[key];
  }

  return { doc: combined, bin: merged };
}

/** The same GLB container MockOnshapeClient builds for its simulated cube. */
function packGlb(doc: any, bin: Buffer): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(doc), "utf8");
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad)]);

  const chunkHeader = (length: number, type: string) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.write(type, 4, "ascii");
    return h;
  };

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);

  return Buffer.concat([
    header,
    chunkHeader(jsonChunk.length, "JSON"), jsonChunk,
    chunkHeader(binChunk.length, "BIN "), binChunk,
  ]);
}
