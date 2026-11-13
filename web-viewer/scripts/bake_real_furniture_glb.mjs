/**
 * bake_real_furniture_glb.mjs
 * OpenCADStudio_Z / Nếp Nhà - Hồ sơ kiến trúc
 *
 * Generates photorealistic Impostor .glb models from transparent cutout PNGs.
 * Each asset features:
 * - A vertical textured quad billboard standing on Y = 0 (pivot bottom-center).
 * - Exact real-world physical dimensions (height * aspect ratio).
 * - Embedded PNG cutout texture with KHR_materials_unlit for pure photorealistic colors.
 * - Baked soft ContactShadowPlane at Y = 0.001m for natural ground contact.
 * - Validation with Three.js GLTFLoader.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MANIFEST_PATH = path.resolve(__dirname, '../public/assets/real_furniture/real_furniture_manifest.json');
const CUTOUT_DIR = path.resolve(__dirname, '../public/assets/real_furniture/cutout');
const OUTPUT_DIR = path.resolve(__dirname, '../public/assets/models/real');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ============================================================================
// 1. PURE NODE.JS PNG ENCODER (FOR SOFT CONTACT SHADOW)
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(typeStr, dataBuf) {
  const len = dataBuf.length;
  const out = Buffer.alloc(len + 12);
  out.writeUInt32BE(len, 0);
  out.write(typeStr, 4, 4, 'ascii');
  if (len > 0) dataBuf.copy(out, 8);
  const crcVal = crc32(out.subarray(4, 8 + len));
  out.writeUInt32BE(crcVal, 8 + len);
  return out;
}

function encodeRgbaToPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const rawScanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    rawScanlines[rowStart] = 0;
    const srcStart = y * stride;
    for (let i = 0; i < stride; i++) {
      rawScanlines[rowStart + 1 + i] = rgba[srcStart + i];
    }
  }

  const compressed = zlib.deflateSync(rawScanlines, { level: 6 });
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

function createContactShadowPng() {
  const w = 128, h = 128;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ny = (y / (h - 1)) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const nx = (x / (w - 1)) * 2 - 1;
      const d = Math.hypot(nx * 0.95, ny * 0.95);
      const alpha = Math.max(0, Math.min(1, Math.pow(Math.max(0, 1 - d), 1.8)));
      const idx = (y * w + x) * 4;
      rgba[idx] = 12;
      rgba[idx + 1] = 14;
      rgba[idx + 2] = 18;
      rgba[idx + 3] = Math.round(alpha * 190);
    }
  }
  return encodeRgbaToPng(w, h, rgba);
}

const CONTACT_SHADOW_PNG = createContactShadowPng();

// ============================================================================
// 2. GLB BUILDER & SERIALIZER
// ============================================================================

function padBuffer4(buf, padByte = 0x00) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  const pad = Buffer.alloc(4 - rem, padByte);
  return Buffer.concat([buf, pad]);
}

function serializeImpostorGlb(item, cutoutPngBuffer) {
  const { dimensions, aspect_ratio } = item;
  const realH = dimensions.height;
  // Billboard width preserves aspect ratio of photo
  const billboardW = realH * aspect_ratio;
  const footprintW = dimensions.width;
  const footprintD = dimensions.depth;

  const binChunks = [];
  let byteOffset = 0;

  const bufferViews = [];
  const accessors = [];
  const images = [];
  const samplers = [
    {
      magFilter: 9729, // LINEAR
      minFilter: 9987, // LINEAR_MIPMAP_LINEAR
      wrapS: 33071,    // CLAMP_TO_EDGE
      wrapT: 33071     // CLAMP_TO_EDGE
    }
  ];
  const textures = [];
  const materials = [];
  const meshes = [];
  const nodes = [];

  const appendToBin = (buf, target) => {
    const start = byteOffset;
    const len = buf.length;
    const padded = padBuffer4(buf, 0x00);
    binChunks.push(padded);
    byteOffset += padded.length;
    const bv = {
      buffer: 0,
      byteOffset: start,
      byteLength: len
    };
    if (target !== undefined) bv.target = target;
    const bvIdx = bufferViews.length;
    bufferViews.push(bv);
    return bvIdx;
  };

  // 1. Add Cutout Image & Texture
  const cutoutBv = appendToBin(cutoutPngBuffer, undefined);
  const cutoutImgIdx = images.length;
  images.push({
    name: `${item.asset_id}_photo`,
    bufferView: cutoutBv,
    mimeType: 'image/png'
  });
  const cutoutTexIdx = textures.length;
  textures.push({
    name: `${item.asset_id}_tex`,
    sampler: 0,
    source: cutoutImgIdx
  });

  // 2. Add Shadow Image & Texture
  const shadowBv = appendToBin(CONTACT_SHADOW_PNG, undefined);
  const shadowImgIdx = images.length;
  images.push({
    name: 'contact_shadow',
    bufferView: shadowBv,
    mimeType: 'image/png'
  });
  const shadowTexIdx = textures.length;
  textures.push({
    name: 'contact_shadow_tex',
    sampler: 0,
    source: shadowImgIdx
  });

  // 3. Materials
  // Material 0: Photorealistic Unlit Billboard
  materials.push({
    name: `${item.asset_id}_unlit_mat`,
    pbrMetallicRoughness: {
      baseColorFactor: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: { index: cutoutTexIdx },
      metallicFactor: 0.0,
      roughnessFactor: 0.9
    },
    alphaMode: 'BLEND',
    doubleSided: true,
    extensions: {
      KHR_materials_unlit: {}
    }
  });

  // Material 1: Soft Contact Shadow
  materials.push({
    name: 'ContactShadow_mat',
    pbrMetallicRoughness: {
      baseColorFactor: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: { index: shadowTexIdx },
      metallicFactor: 0.0,
      roughnessFactor: 1.0
    },
    alphaMode: 'BLEND',
    doubleSided: false
  });

  // Helper to append geometry attributes
  function addGeometryToGlb(positions, normals, uvs, indices) {
    const vCount = positions.length / 3;
    const minPos = [Infinity, Infinity, Infinity];
    const maxPos = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vCount; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minPos[0]) minPos[0] = x;
      if (y < minPos[1]) minPos[1] = y;
      if (z < minPos[2]) minPos[2] = z;
      if (x > maxPos[0]) maxPos[0] = x;
      if (y > maxPos[1]) maxPos[1] = y;
      if (z > maxPos[2]) maxPos[2] = z;
    }

    const posBv = appendToBin(Buffer.from(positions.buffer), 34962);
    const posAcc = accessors.length;
    accessors.push({
      bufferView: posBv,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: vCount,
      type: 'VEC3',
      min: minPos,
      max: maxPos
    });

    const normBv = appendToBin(Buffer.from(normals.buffer), 34962);
    const normAcc = accessors.length;
    accessors.push({
      bufferView: normBv,
      byteOffset: 0,
      componentType: 5126,
      count: vCount,
      type: 'VEC3'
    });

    const uvBv = appendToBin(Buffer.from(uvs.buffer), 34962);
    const uvAcc = accessors.length;
    accessors.push({
      bufferView: uvBv,
      byteOffset: 0,
      componentType: 5126,
      count: vCount,
      type: 'VEC2'
    });

    const idxBv = appendToBin(Buffer.from(indices.buffer), 34963); // ELEMENT_ARRAY_BUFFER
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: idxBv,
      byteOffset: 0,
      componentType: 5123, // UNSIGNED_SHORT
      count: indices.length,
      type: 'SCALAR'
    });

    return { posAcc, normAcc, uvAcc, idxAcc };
  }

  // 4. Build Mesh 0: Vertical Billboard Quad
  // Bottom center at (0, 0, 0), facing +Z
  const hw = billboardW / 2;
  const bbPositions = new Float32Array([
    -hw, 0.0, 0.0,      // 0: bottom-left
     hw, 0.0, 0.0,      // 1: bottom-right
     hw, realH, 0.0,    // 2: top-right
    -hw, realH, 0.0     // 3: top-left
  ]);
  const bbNormals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1
  ]);
  const bbUvs = new Float32Array([
    0, 1,   // bottom-left (Three.js UV flip)
    1, 1,   // bottom-right
    1, 0,   // top-right
    0, 0    // top-left
  ]);
  const bbIndices = new Uint16Array([
    0, 1, 2,
    0, 2, 3
  ]);
  const bbAttrs = addGeometryToGlb(bbPositions, bbNormals, bbUvs, bbIndices);

  const bbMeshIdx = meshes.length;
  meshes.push({
    name: 'RealFurnitureBillboard',
    primitives: [
      {
        attributes: {
          POSITION: bbAttrs.posAcc,
          NORMAL: bbAttrs.normAcc,
          TEXCOORD_0: bbAttrs.uvAcc
        },
        indices: bbAttrs.idxAcc,
        material: 0,
        mode: 4 // TRIANGLES
      }
    ]
  });

  // 5. Build Mesh 1: Ground Contact Shadow Plane
  // Centered on (0, 0.001, 0) in XZ plane
  const shw = (footprintW * 1.05) / 2;
  const shd = (footprintD * 1.05) / 2;
  const shPositions = new Float32Array([
    -shw, 0.001, -shd,
     shw, 0.001, -shd,
     shw, 0.001,  shd,
    -shw, 0.001,  shd
  ]);
  const shNormals = new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0
  ]);
  const shUvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1
  ]);
  const shIndices = new Uint16Array([
    0, 2, 1,
    0, 3, 2
  ]);
  const shAttrs = addGeometryToGlb(shPositions, shNormals, shUvs, shIndices);

  const shMeshIdx = meshes.length;
  meshes.push({
    name: 'ContactShadowPlane',
    primitives: [
      {
        attributes: {
          POSITION: shAttrs.posAcc,
          NORMAL: shAttrs.normAcc,
          TEXCOORD_0: shAttrs.uvAcc
        },
        indices: shAttrs.idxAcc,
        material: 1,
        mode: 4
      }
    ]
  });

  // 6. Nodes & Scene Graph
  const bbNodeIdx = nodes.length;
  nodes.push({
    name: 'RealFurnitureBillboard',
    mesh: bbMeshIdx,
    extras: {
      isRealBillboard: true,
      assetId: item.asset_id,
      aspectRatio: aspect_ratio,
      realWidth: footprintW,
      realDepth: footprintD,
      realHeight: realH
    }
  });

  const shNodeIdx = nodes.length;
  nodes.push({
    name: 'ContactShadowPlane',
    mesh: shMeshIdx,
    extras: {
      isContactShadow: true
    }
  });

  const rootNodeIdx = nodes.length;
  nodes.push({
    name: item.asset_id,
    children: [bbNodeIdx, shNodeIdx]
  });

  const scenes = [
    {
      name: 'Scene',
      nodes: [rootNodeIdx]
    }
  ];

  // 7. Assemble Binary Buffer
  const totalBinLength = byteOffset;
  const binBody = Buffer.concat(binChunks);

  const gltfJson = {
    asset: {
      version: '2.0',
      generator: 'OpenCADStudio_Z Real Furniture Impostor Baker'
    },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes,
    nodes,
    meshes,
    materials,
    textures,
    images,
    samplers,
    accessors,
    bufferViews,
    buffers: [
      {
        byteLength: totalBinLength
      }
    ]
  };

  const jsonStr = JSON.stringify(gltfJson);
  const jsonBuf = padBuffer4(Buffer.from(jsonStr, 'utf8'), 0x20); // space padded per spec

  const glbLength = 12 + (8 + jsonBuf.length) + (8 + binBody.length);
  const glbHeader = Buffer.alloc(12);
  glbHeader.writeUInt32LE(0x46546C67, 0); // "glTF"
  glbHeader.writeUInt32LE(2, 4);          // version 2
  glbHeader.writeUInt32LE(glbLength, 8);  // total byte length

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // "JSON"

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binBody.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942, 4); // "BIN\0"

  return Buffer.concat([
    glbHeader,
    jsonChunkHeader,
    jsonBuf,
    binChunkHeader,
    binBody
  ]);
}

// ============================================================================
// 3. MAIN RUNNER & THREE.JS VALIDATION
// ============================================================================

function setupNodeGltfLoaderPolyfill() {
  if (typeof globalThis.self === 'undefined') {
    globalThis.self = globalThis;
  }
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => 'blob:node-gltf-texture';
  }
  if (!globalThis.URL.revokeObjectURL) {
    globalThis.URL.revokeObjectURL = () => {};
  }
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const tex = new THREE.Texture();
    tex.name = url;
    if (onLoad) {
      queueMicrotask(() => onLoad(tex));
    }
    return tex;
  };
}

async function main() {
  setupNodeGltfLoaderPolyfill();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  console.log(`[Real GLB Baker] Generating ${manifest.assets.length} photorealistic GLB impostors...`);

  let totalBytes = 0;

  for (const item of manifest.assets) {
    const cutoutPath = path.resolve(CUTOUT_DIR, `${item.asset_id}.png`);
    if (!fs.existsSync(cutoutPath)) {
      throw new Error(`Cutout PNG not found: ${cutoutPath}`);
    }
    const cutoutPng = fs.readFileSync(cutoutPath);

    const glbBuffer = serializeImpostorGlb(item, cutoutPng);
    const outPath = path.resolve(OUTPUT_DIR, `${item.asset_id}.glb`);
    fs.writeFileSync(outPath, glbBuffer);
    totalBytes += glbBuffer.length;

    // Validate with GLTFLoader
    const loader = new GLTFLoader();
    const arrayBuffer = glbBuffer.buffer.slice(
      glbBuffer.byteOffset,
      glbBuffer.byteOffset + glbBuffer.byteLength
    );

    await new Promise((resolve, reject) => {
      loader.parse(
        arrayBuffer,
        '',
        (gltf) => {
          const scene = gltf.scene;
          const meshesFound = [];
          scene.traverse((obj) => {
            if (obj.isMesh) meshesFound.push(obj.name);
          });
          const bbW = (item.dimensions.height * item.aspect_ratio).toFixed(2);
          const bbH = item.dimensions.height.toFixed(2);
          console.log(`  ✓ ${item.asset_id.padEnd(26)} | ${(glbBuffer.length / 1024).toFixed(1).padStart(7)} KB | Billboard: ${bbW}×${bbH}m | Meshes: [${meshesFound.join(', ')}]`);
          resolve();
        },
        (err) => reject(new Error(`Validation failed for ${item.asset_id}: ${err.message}`))
      );
    });
  }

  console.log(`\n[Real GLB Baker] Successfully baked & validated ${manifest.assets.length} photorealistic impostor GLBs (${(totalBytes / 1024 / 1024).toFixed(2)} MB total) in public/assets/models/real/`);
}

main().catch((err) => {
  console.error('[Real GLB Baker] Fatal error:', err);
  process.exit(1);
});
