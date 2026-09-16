/**
 * Repacking Onshape's zipped assembly export into one GLB.
 *
 * An assembly's glTF export is a translation job, and when Onshape cannot
 * produce a single binary file it falls back to the loose form — a .gltf
 * JSON, a separate .bin, loose texture files — zipped together because a
 * translation's result can only be one download. This is what turns that
 * back into the single self-contained file PartGeometry stores.
 *
 * No live Onshape zip to test against here, so the fixtures below are built
 * by hand from the documented BTBGltfExportParams / glTF 2.0 shape: a mesh
 * accessor pair backed by an external .bin, and a texture backed by an
 * external image, laid out the way a real export would be. The rules worth
 * testing are the ones a naive concatenation gets wrong: bufferView offsets
 * have to move with their data, everything has to land 4-byte aligned, and a
 * texture's bytes have to end up describable by a bufferView instead of a
 * uri that no longer resolves once there is no folder around the file.
 */
import JSZip from "jszip";
import { looksLikeZip, unpackGltfZip } from "../src/lib/onshape/gltf-package";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** Walks a GLB exactly the way a real loader would, for the assertions below. */
function parseGlb(b: Buffer) {
  const magic = b.subarray(0, 4).toString("ascii");
  const version = b.readUInt32LE(4);
  const declaredLength = b.readUInt32LE(8);

  let off = 12;
  const chunks: { type: string; data: Buffer }[] = [];
  while (off < b.length) {
    const len = b.readUInt32LE(off);
    const type = b.subarray(off + 4, off + 8).toString("ascii").replace(/\0/g, "") || "BIN";
    chunks.push({ type, data: b.subarray(off + 8, off + 8 + len) });
    off += 8 + len;
  }

  return { magic, version, declaredLength, actualLength: b.length, endOffset: off, chunks };
}

async function main() {
  console.log("\nlooksLikeZip");
  {
    check("a real zip's local-file-header signature", looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])));
    check("an empty zip's end-of-central-directory signature", looksLikeZip(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0])));
    check("a GLB is not a zip", !looksLikeZip(Buffer.from("glTF\x02\x00\x00\x00")));
    check("plain text is not a zip", !looksLikeZip(Buffer.from("not a zip at all")));
    check("too short to tell is not a zip", !looksLikeZip(Buffer.from([0x50, 0x4b])));
  }

  console.log("\nThe loose form — a .gltf, a .bin, and a texture — packs into one valid GLB");
  {
    // 4 vertices, 6 indices (two triangles) — enough to exercise two real
    // bufferViews with different component types, the way an actual export
    // would, rather than one contrived blob.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const posBytes = Buffer.from(positions.buffer);
    // Deliberately NOT 4-byte aligned (6 * 2 = 12 bytes — it happens to be
    // here, so pad artificially to actually exercise the alignment logic).
    const idxBytes = Buffer.concat([Buffer.from(indices.buffer), Buffer.alloc(1)]);
    // A texture that is not a multiple of 4 bytes either, so it also forces
    // the packer to pad before appending it.
    const texture = Buffer.from("this stands in for a JPEG, size does not matter here---");

    const doc = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      }],
      textures: [{ source: 0 }],
      images: [{ uri: "textures/base.jpg" }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
        { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length },
      ],
      buffers: [{ uri: "scene.bin", byteLength: posBytes.length + idxBytes.length }],
    };

    const zip = new JSZip();
    zip.file("scene.gltf", JSON.stringify(doc));
    zip.file("scene.bin", Buffer.concat([posBytes, idxBytes]));
    zip.file("textures/base.jpg", texture);
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    check("the fixture itself is recognised as a zip", looksLikeZip(zipped));

    const glb = await unpackGltfZip(zipped);
    const parsed = parseGlb(glb);

    check("the magic is glTF", parsed.magic === "glTF");
    check("it declares glTF 2.0", parsed.version === 2, String(parsed.version));
    check("the declared length is the real length", parsed.declaredLength === parsed.actualLength,
      `${parsed.declaredLength} vs ${parsed.actualLength}`);
    check("the chunks account for every byte", parsed.endOffset === parsed.actualLength,
      `${parsed.endOffset} vs ${parsed.actualLength}`);
    check("a JSON chunk first", parsed.chunks[0]?.type === "JSON");
    check("a binary chunk after it", parsed.chunks[1]?.type === "BIN");
    check("exactly two chunks — one binary blob, not three loose files",
      parsed.chunks.length === 2, String(parsed.chunks.length));
    check("every chunk lands 4-byte aligned",
      parsed.chunks.every((c) => c.data.length % 4 === 0), JSON.stringify(parsed.chunks.map((c) => c.data.length)));

    const packed = JSON.parse(parsed.chunks[0].data.toString("utf8"));
    const bin = parsed.chunks[1].data;

    check("there is exactly one buffer now", packed.buffers.length === 1, String(packed.buffers.length));
    check("with no uri — it IS the binary chunk", packed.buffers[0].uri === undefined);
    /*
     * Not necessarily equal: the GLB container pads the BIN chunk itself out
     * to a 4-byte boundary, which can leave up to 3 trailing bytes the
     * buffer's own byteLength does not claim — that is normal GLB padding,
     * not a miscount, so the check is "at most a pad's worth short", not "==".
     */
    check("its declared length accounts for the binary chunk, up to GLB padding",
      bin.length - packed.buffers[0].byteLength >= 0 && bin.length - packed.buffers[0].byteLength < 4,
      `${packed.buffers[0].byteLength} vs ${bin.length}`);

    check("the position bufferView still starts at 0",
      packed.bufferViews[0].byteOffset === 0, String(packed.bufferViews[0].byteOffset));
    check("the position bufferView is unchanged in size",
      packed.bufferViews[0].byteLength === posBytes.length);

    // The mesh data the accessors actually point at has to be recoverable
    // byte-for-byte — a bufferView with the right offset and the wrong bytes
    // is exactly as broken as one with the wrong offset.
    const positionBytes = bin.subarray(
      packed.bufferViews[0].byteOffset,
      packed.bufferViews[0].byteOffset + packed.bufferViews[0].byteLength
    );
    check("the position data survived byte-for-byte", positionBytes.equals(posBytes));

    const indexBv = packed.bufferViews[1];
    check("the index bufferView moved past the (now-padded) position data",
      indexBv.byteOffset >= posBytes.length, String(indexBv.byteOffset));
    const indexBytes = bin.subarray(indexBv.byteOffset, indexBv.byteOffset + indexBv.byteLength);
    check("the index data survived byte-for-byte", indexBytes.equals(idxBytes));

    check("the texture lost its uri", packed.images[0].uri === undefined);
    check("and gained a bufferView instead",
      typeof packed.images[0].bufferView === "number", JSON.stringify(packed.images[0]));
    check("with the right mime type guessed from the extension",
      packed.images[0].mimeType === "image/jpeg", packed.images[0].mimeType);

    const texBv = packed.bufferViews[packed.images[0].bufferView];
    const texBytes = bin.subarray(texBv.byteOffset, texBv.byteOffset + texBv.byteLength);
    check("the texture bytes survived byte-for-byte", texBytes.equals(texture));
    check("and do not overlap the mesh data",
      texBv.byteOffset >= indexBv.byteOffset + indexBv.byteLength, String(texBv.byteOffset));
  }

  console.log("\nA data: URI buffer needs no file in the zip at all");
  {
    const mesh = Buffer.from("stand-in mesh bytes, short on purpose");
    const doc = {
      asset: { version: "2.0" },
      buffers: [{ uri: `data:application/octet-stream;base64,${mesh.toString("base64")}`, byteLength: mesh.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: mesh.length }],
    };
    const zip = new JSZip();
    zip.file("model.gltf", JSON.stringify(doc));
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const glb = await unpackGltfZip(zipped);
    const parsed = parseGlb(glb);
    check("still a valid GLB", parsed.magic === "glTF" && parsed.declaredLength === parsed.actualLength);
    check("the decoded data: buffer is the binary chunk",
      parsed.chunks[1].data.subarray(0, mesh.length).equals(mesh));
  }

  console.log("\nA zip that already holds a .glb is passed through, not re-packed");
  {
    const jsonChunk = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }));
    const pad = (4 - (jsonChunk.length % 4)) % 4;
    const padded = Buffer.concat([jsonChunk, Buffer.alloc(pad, 0x20)]);
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(padded.length, 0);
    chunkHeader.write("JSON", 4, "ascii");
    const header = Buffer.alloc(12);
    header.write("glTF", 0, "ascii");
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + padded.length, 8);
    const glbBytes = Buffer.concat([header, chunkHeader, padded]);

    const zip = new JSZip();
    zip.file("model.glb", glbBytes);
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const out = await unpackGltfZip(zipped);
    check("the GLB comes back byte-for-byte, not reconstructed", out.equals(glbBytes));
  }

  console.log("\nA zip with neither a .gltf nor a .glb inside is refused with a reason");
  {
    const zip = new JSZip();
    zip.file("readme.txt", "not a model");
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    let message = "";
    try {
      await unpackGltfZip(zipped);
    } catch (e: any) {
      message = String(e?.message ?? e);
    }
    check("it throws", message !== "");
    check("naming what it found instead", /readme\.txt/.test(message), message);
  }

  console.log("\nA glTF JSON naming a buffer the zip does not contain is refused with a reason");
  {
    const doc = {
      asset: { version: "2.0" },
      buffers: [{ uri: "missing.bin", byteLength: 4 }],
    };
    const zip = new JSZip();
    zip.file("model.gltf", JSON.stringify(doc));
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    let message = "";
    try {
      await unpackGltfZip(zipped);
    } catch (e: any) {
      message = String(e?.message ?? e);
    }
    check("it throws", message !== "");
    check("naming the missing file", /missing\.bin/.test(message), message);
  }

  console.log(
    "\nA zip with one .gltf per part — an assembly, not a single part — is fully combined"
  );
  {
    /*
     * The actual bug report: Onshape's assembly export zip held more than
     * one model file, and the earlier version of this code took the first
     * one via `.find()` and quietly discarded the rest. The result was a
     * perfectly valid GLB — nothing here failed, nothing looked wrong from
     * the outside — that happened to contain exactly one of the assembly's
     * parts. This fixture is three self-contained parts, each in its own
     * folder the way per-part exports naturally would be, one of them with
     * its own texture so the material/texture offsetting is exercised too,
     * not just the mesh data.
     */
    const part = (label: string, n: number, withTexture: boolean) => {
      // n distinguishes each part's geometry so the merged bytes can be told
      // apart afterward — not a meaningful shape, just a unique fingerprint.
      const positions = new Float32Array([n, 0, 0,  n, 1, 0,  n, 0, 1]);
      const posBytes = Buffer.from(positions.buffer);
      const texture = withTexture ? Buffer.from(`texture bytes for ${label}`) : null;

      const doc: any = {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: label }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [{
          name: label,
          pbrMetallicRoughness: withTexture
            ? { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1] }
            : { baseColorFactor: [n / 10, 0, 0, 1] },
        }],
        ...(withTexture ? { textures: [{ source: 0 }], images: [{ uri: `${label}.jpg` }] } : {}),
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [n, 0, 0], max: [n, 1, 1] },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBytes.length }],
        buffers: [{ uri: `${label}.bin`, byteLength: posBytes.length }],
      };
      return { label, doc, posBytes, texture };
    };

    const parts = [part("PartA", 1, false), part("PartB", 2, true), part("PartC", 3, false)];

    const zip = new JSZip();
    for (const p of parts) {
      zip.file(`${p.label}/model.gltf`, JSON.stringify(p.doc));
      zip.file(`${p.label}/${p.label}.bin`, p.posBytes);
      if (p.texture) zip.file(`${p.label}/${p.label}.jpg`, p.texture);
    }
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const glb = await unpackGltfZip(zipped);
    const parsed = parseGlb(glb);
    check("still a valid GLB", parsed.magic === "glTF" && parsed.declaredLength === parsed.actualLength);
    check("every chunk lands 4-byte aligned",
      parsed.chunks.every((c) => c.data.length % 4 === 0));

    const packed = JSON.parse(parsed.chunks[0].data.toString("utf8"));
    const bin = parsed.chunks[1].data;

    check("all three parts became nodes", packed.nodes?.length === 3, JSON.stringify(packed.nodes));
    check("the scene references all three", packed.scenes[0].nodes.length === 3,
      JSON.stringify(packed.scenes[0].nodes));
    check("each part kept its own mesh — not collapsed onto one",
      new Set(packed.nodes.map((n: any) => n.mesh)).size === 3,
      JSON.stringify(packed.nodes.map((n: any) => n.mesh)));
    check("three meshes, three materials, three accessors",
      packed.meshes.length === 3 && packed.materials.length === 3 && packed.accessors.length === 3,
      JSON.stringify({ meshes: packed.meshes.length, materials: packed.materials.length, accessors: packed.accessors.length }));

    /* Every part's own vertex data is recoverable, byte-for-byte, from the one shared buffer. */
    for (const p of parts) {
      const nodeIndex = packed.nodes.findIndex((n: any) => n.name === p.label);
      const meshIndex = packed.nodes[nodeIndex].mesh;
      const accessorIndex = packed.meshes[meshIndex].primitives[0].attributes.POSITION;
      const bv = packed.bufferViews[packed.accessors[accessorIndex].bufferView];
      const bytes = bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength);
      check(`${p.label}'s own vertex data survived byte-for-byte`, bytes.equals(p.posBytes));
    }

    /* The one part with a texture kept it, correctly offset and byte-correct. */
    const partB = packed.nodes.find((n: any) => n.name === "PartB");
    const partBMaterial = packed.materials[packed.meshes[partB.mesh].primitives[0].material];
    check("PartB's material still points at a texture",
      partBMaterial.pbrMetallicRoughness.baseColorTexture != null,
      JSON.stringify(partBMaterial));
    const texIndex = partBMaterial.pbrMetallicRoughness.baseColorTexture.index;
    const imgIndex = packed.textures[texIndex].source;
    const imgBv = packed.bufferViews[packed.images[imgIndex].bufferView];
    const imgBytes = bin.subarray(imgBv.byteOffset, imgBv.byteOffset + imgBv.byteLength);
    check("and the texture bytes survived byte-for-byte", imgBytes.equals(parts[1].texture!));

    /* The parts with no texture at all must not have grown one. */
    const partAMaterial = packed.materials[packed.meshes[packed.nodes.find((n: any) => n.name === "PartA").mesh].primitives[0].material];
    check("PartA has no texture reference", partAMaterial.pbrMetallicRoughness.baseColorTexture == null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
