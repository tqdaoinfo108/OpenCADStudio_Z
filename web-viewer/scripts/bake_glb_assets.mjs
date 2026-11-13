/**
 * bake_glb_assets.mjs
 * OpenCADStudio_Z / Nếp Nhà - Hồ sơ kiến trúc
 *
 * Self-contained Node.js glTF 2.0 Binary (.glb) Procedural Asset Library Baker.
 * Constructs 35 high-detail architectural & interior 3D assets with:
 * - Embedded procedural PNG textures (pure JS zlib/CRC32 PNG encoder)
 * - PBR Metallic-Roughness materials (wood, marble, fabric, metals, glass, ceramic, emissives)
 * - Beveled/rounded geometries & realistic accessories
 * - Baked ContactShadowPlane at Y = 0.001m with soft alpha-gradient PNG texture
 * - Exact bottom-center pivot (0, 0, 0) resting on Y = 0, back facing -Z, front facing +Z
 * - Verified via THREE.GLTFLoader.parse(arrayBuffer, '')
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../public/assets/models');

// ============================================================================
// 1. PURE NODE.JS PNG ENCODER (ZLIB + CRC32) & PROCEDURAL TEXTURE GENERATOR
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

/**
 * Encodes raw RGBA Uint8Array (width * height * 4) into a valid PNG Buffer.
 */
function encodeRgbaToPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const rawScanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    rawScanlines[rowStart] = 0; // filter type 0 (None)
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

function hash2D(x, y, seed = 1) {
  const v = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function createProceduralTextureBuffers() {
  const textures = {};

  // 1. Warm Natural Oak Wood Grain (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wave = Math.sin((y / h) * Math.PI * 14 + Math.sin((x / w) * Math.PI * 4) * 1.4);
        const fine = (hash2D(x, y * 4, 1) - 0.5) * 12;
        const grain = wave * 11 + fine;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(206 + grain);
        rgba[idx + 1] = clampByte(168 + grain * 0.85);
        rgba[idx + 2] = clampByte(122 + grain * 0.7);
        rgba[idx + 3] = 255;
      }
    }
    textures.wood_oak = encodeRgbaToPng(w, h, rgba);
  }

  // 2. Rich Dark Walnut Wood Grain (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wave = Math.sin((y / h) * Math.PI * 16 + Math.cos((x / w) * Math.PI * 3) * 1.8);
        const fine = (hash2D(x, y * 3, 2) - 0.5) * 10;
        const grain = wave * 12 + fine;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(104 + grain);
        rgba[idx + 1] = clampByte(68 + grain * 0.8);
        rgba[idx + 2] = clampByte(46 + grain * 0.65);
        rgba[idx + 3] = 255;
      }
    }
    textures.wood_walnut = encodeRgbaToPng(w, h, rgba);
  }

  // 3. Traditional Mahogany / Rosewood Grain (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wave = Math.sin((y / h) * Math.PI * 14 + Math.sin((x / w) * Math.PI * 5) * 1.2);
        const fine = (hash2D(x, y * 2, 3) - 0.5) * 9;
        const grain = wave * 10 + fine;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(112 + grain);
        rgba[idx + 1] = clampByte(38 + grain * 0.6);
        rgba[idx + 2] = clampByte(22 + grain * 0.5);
        rgba[idx + 3] = 255;
      }
    }
    textures.wood_mahogany = encodeRgbaToPng(w, h, rgba);
  }

  // 4. White Carrara Marble with Gray & Warm Gold Veins (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x / w;
        const ny = y / h;
        const v1 = Math.abs(Math.sin((nx * 2.5 + ny * 1.8 + Math.sin(ny * 9) * 0.12) * Math.PI * 2));
        const v2 = Math.abs(Math.cos((nx * 1.4 - ny * 2.3 + Math.cos(nx * 8) * 0.1) * Math.PI * 2));
        const vein = Math.pow(1.0 - Math.min(v1, v2), 8);
        const cloud = (hash2D(Math.floor(x / 4), Math.floor(y / 4), 4) - 0.5) * 6;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(247 - vein * 48 + cloud);
        rgba[idx + 1] = clampByte(245 - vein * 46 + cloud);
        rgba[idx + 2] = clampByte(240 - vein * 42 + cloud);
        rgba[idx + 3] = 255;
      }
    }
    textures.marble_carrara = encodeRgbaToPng(w, h, rgba);
  }

  // 5. Woven Linen Fabric (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const weave = ((x + y) % 2 === 0 ? 4 : -4) + ((x % 4 === 0 || y % 4 === 0) ? -3 : 2);
        const noise = (hash2D(x, y, 5) - 0.5) * 6;
        const d = weave + noise;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(222 + d);
        rgba[idx + 1] = clampByte(210 + d);
        rgba[idx + 2] = clampByte(192 + d);
        rgba[idx + 3] = 255;
      }
    }
    textures.fabric_linen = encodeRgbaToPng(w, h, rgba);
  }

  // 6. Soft Brushed Velvet Fabric (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sheen = Math.sin((x / w) * Math.PI * 2) * 6 + Math.cos((y / h) * Math.PI * 2) * 5;
        const fine = (hash2D(x, y, 6) - 0.5) * 7;
        const d = sheen + fine;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(146 + d);
        rgba[idx + 1] = clampByte(134 + d);
        rgba[idx + 2] = clampByte(122 + d);
        rgba[idx + 3] = 255;
      }
    }
    textures.fabric_velvet = encodeRgbaToPng(w, h, rgba);
  }

  // 7. Textured Area Rug with Subtle Border (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bx = Math.min(x, w - 1 - x) / w;
        const by = Math.min(y, h - 1 - y) / h;
        const borderDist = Math.min(bx, by);
        const isBorder = borderDist > 0.04 && borderDist < 0.085;
        const weave = ((x % 3 === 0) ? 5 : -3) + ((y % 2 === 0) ? 3 : -2);
        const baseR = isBorder ? 176 : 228;
        const baseG = isBorder ? 154 : 219;
        const baseB = isBorder ? 128 : 205;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(baseR + weave);
        rgba[idx + 1] = clampByte(baseG + weave);
        rgba[idx + 2] = clampByte(baseB + weave);
        rgba[idx + 3] = 255;
      }
    }
    textures.fabric_rug = encodeRgbaToPng(w, h, rgba);
  }

  // 8. Golden Trúc Chỉ Lotus Mandala (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    const cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / (w / 2);
        const dy = (y - cy) / (h / 2);
        const r = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        const petals = Math.cos(angle * 12) * 0.5 + 0.5;
        const rings = Math.cos(r * Math.PI * 6) * 0.5 + 0.5;
        const glow = Math.max(0, 1.0 - r * 0.85) * (0.65 + 0.35 * petals * rings);
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(185 + glow * 70);
        rgba[idx + 1] = clampByte(115 + glow * 105);
        rgba[idx + 2] = clampByte(28 + glow * 65);
        rgba[idx + 3] = 255;
      }
    }
    textures.truc_chi_mandala = encodeRgbaToPng(w, h, rgba);
  }

  // 9. Botanical Leaf Texture (128x128)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const vein = Math.sin((x / w) * Math.PI * 8) * Math.cos((y / h) * Math.PI * 8) * 12;
        const idx = (y * w + x) * 4;
        rgba[idx] = clampByte(72 + vein);
        rgba[idx + 1] = clampByte(122 + vein * 1.2);
        rgba[idx + 2] = clampByte(62 + vein * 0.8);
        rgba[idx + 3] = 255;
      }
    }
    textures.foliage_leaf = encodeRgbaToPng(w, h, rgba);
  }

  // 10. Soft Ambient Occlusion ContactShadowPlane Alpha Gradient (128x128 RGBA)
  {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Normalized [-1, 1] coordinates
        const nx = (x / (w - 1)) * 2 - 1;
        const ny = (y / (h - 1)) * 2 - 1;
        // Rounded-box signed distance falloff so rectangular & round furniture get soft shadow edges
        const qx = Math.max(0, Math.abs(nx) - 0.52) / 0.48;
        const qy = Math.max(0, Math.abs(ny) - 0.52) / 0.48;
        const dist = Math.min(1, Math.hypot(qx, qy));
        const smooth = 1 - (dist * dist * (3 - 2 * dist));
        const alpha = clampByte(smooth * 135);
        const idx = (y * w + x) * 4;
        rgba[idx] = 18;
        rgba[idx + 1] = 15;
        rgba[idx + 2] = 12;
        rgba[idx + 3] = alpha;
      }
    }
    textures.contact_shadow = encodeRgbaToPng(w, h, rgba);
  }

  const granite = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const grain = hash2D(x, y, 41);
    const value = grain > 0.94 ? 113 : 30 + Math.round(grain * 28);
    granite.set([value, value + 2, value + 4, 255], (y * 64 + x) * 4);
  }
  textures.black_granite = encodeRgbaToPng(64, 64, granite);
  return textures;
}

const PNG_BUFFERS = createProceduralTextureBuffers();

// ============================================================================
// 2. PBR MATERIAL CATALOG DEFINITIONS FOR GLB SERIALIZATION
// ============================================================================

const MATERIAL_DEFS = {
  woodOak: {
    name: 'WoodOak',
    baseColorFactor: [0.92, 0.82, 0.70, 1.0],
    roughnessFactor: 0.42,
    metallicFactor: 0.04,
    textureKey: 'wood_oak'
  },
  woodWalnut: {
    name: 'WoodWalnut',
    baseColorFactor: [0.76, 0.58, 0.45, 1.0],
    roughnessFactor: 0.36,
    metallicFactor: 0.05,
    textureKey: 'wood_walnut'
  },
  woodMahogany: {
    name: 'WoodMahogany',
    baseColorFactor: [0.78, 0.42, 0.30, 1.0],
    roughnessFactor: 0.28,
    metallicFactor: 0.06,
    textureKey: 'wood_mahogany'
  },
  marbleCarrara: {
    name: 'MarbleCarrara',
    baseColorFactor: [0.99, 0.98, 0.96, 1.0],
    roughnessFactor: 0.16,
    metallicFactor: 0.02,
    textureKey: 'marble_carrara'
  },
  fabricLinen: {
    name: 'FabricLinen',
    baseColorFactor: [0.95, 0.91, 0.85, 1.0],
    roughnessFactor: 0.86,
    metallicFactor: 0.0,
    textureKey: 'fabric_linen'
  },
  fabricVelvet: {
    name: 'FabricVelvet',
    baseColorFactor: [0.72, 0.67, 0.61, 1.0],
    roughnessFactor: 0.76,
    metallicFactor: 0.02,
    textureKey: 'fabric_velvet'
  },
  fabricCharcoal: {
    name: 'FabricCharcoal',
    baseColorFactor: [0.32, 0.34, 0.37, 1.0],
    roughnessFactor: 0.80,
    metallicFactor: 0.02,
    textureKey: 'fabric_velvet'
  },
  rugWoven: {
    name: 'RugWoven',
    baseColorFactor: [0.95, 0.92, 0.87, 1.0],
    roughnessFactor: 0.92,
    metallicFactor: 0.0,
    textureKey: 'fabric_rug'
  },
  pillowTerra: {
    name: 'PillowTerracotta',
    baseColorFactor: [0.78, 0.43, 0.32, 1.0],
    roughnessFactor: 0.84,
    metallicFactor: 0.0,
    textureKey: 'fabric_linen'
  },
  pillowSage: {
    name: 'PillowSage',
    baseColorFactor: [0.46, 0.54, 0.43, 1.0],
    roughnessFactor: 0.84,
    metallicFactor: 0.0,
    textureKey: 'fabric_linen'
  },
  pillowMustard: {
    name: 'PillowMustard',
    baseColorFactor: [0.83, 0.62, 0.30, 1.0],
    roughnessFactor: 0.80,
    metallicFactor: 0.0,
    textureKey: 'fabric_linen'
  },
  pillowNavy: {
    name: 'PillowNavy',
    baseColorFactor: [0.24, 0.34, 0.48, 1.0],
    roughnessFactor: 0.82,
    metallicFactor: 0.0,
    textureKey: 'fabric_linen'
  },
  beddingWhite: {
    name: 'BeddingWhite',
    baseColorFactor: [0.97, 0.96, 0.94, 1.0],
    roughnessFactor: 0.84,
    metallicFactor: 0.0,
    textureKey: 'fabric_linen'
  },
  beddingDuvet: {
    name: 'BeddingDuvet',
    baseColorFactor: [0.85, 0.80, 0.73, 1.0],
    roughnessFactor: 0.86,
    metallicFactor: 0.0,
    textureKey: 'fabric_linen'
  },
  metalBrass: {
    name: 'MetalBrass',
    baseColorFactor: [0.83, 0.69, 0.22, 1.0],
    roughnessFactor: 0.24,
    metallicFactor: 0.90
  },
  metalBlack: {
    name: 'MetalBlack',
    baseColorFactor: [0.14, 0.15, 0.17, 1.0],
    roughnessFactor: 0.35,
    metallicFactor: 0.82
  },
  metalChrome: {
    name: 'MetalChrome',
    baseColorFactor: [0.95, 0.96, 0.98, 1.0],
    roughnessFactor: 0.10,
    metallicFactor: 0.95
  },
  stainlessSteel: {
    name: 'StainlessSteel',
    baseColorFactor: [0.83, 0.85, 0.87, 1.0],
    roughnessFactor: 0.22,
    metallicFactor: 0.88
  },
  kitchenCabinet: {
    name: 'KitchenCabinetSlate',
    baseColorFactor: [0.20, 0.24, 0.27, 1.0],
    roughnessFactor: 0.32,
    metallicFactor: 0.14
  },
  ceramicWhite: {
    name: 'CeramicSanitaryWhite',
    baseColorFactor: [0.98, 0.98, 0.97, 1.0],
    roughnessFactor: 0.12,
    metallicFactor: 0.02
  },
  ceramicVase: {
    name: 'CeramicVaseCream',
    baseColorFactor: [0.91, 0.88, 0.82, 1.0],
    roughnessFactor: 0.24,
    metallicFactor: 0.02
  },
  terracottaPot: {
    name: 'TerracottaPot',
    baseColorFactor: [0.72, 0.42, 0.29, 1.0],
    roughnessFactor: 0.74,
    metallicFactor: 0.02
  },
  blackGranite: {
    name: 'BlackGranite',
    baseColorFactor: [0.85, 0.85, 0.85, 1.0],
    roughnessFactor: 0.32,
    metallicFactor: 0,
    textureKey: 'black_granite'
  },
  soilDark: {
    name: 'SoilDark',
    baseColorFactor: [0.24, 0.18, 0.14, 1.0],
    roughnessFactor: 0.92,
    metallicFactor: 0.0
  },
  foliageDark: {
    name: 'FoliageDark',
    baseColorFactor: [0.32, 0.52, 0.28, 1.0],
    roughnessFactor: 0.78,
    metallicFactor: 0.0,
    textureKey: 'foliage_leaf'
  },
  foliageLight: {
    name: 'FoliageLight',
    baseColorFactor: [0.44, 0.66, 0.36, 1.0],
    roughnessFactor: 0.74,
    metallicFactor: 0.0,
    textureKey: 'foliage_leaf'
  },
  tvScreen: {
    name: 'OLEDGlassScreen',
    baseColorFactor: [0.05, 0.06, 0.08, 1.0],
    roughnessFactor: 0.06,
    metallicFactor: 0.25
  },
  cooktopGlass: {
    name: 'CooktopCeramicGlass',
    baseColorFactor: [0.07, 0.08, 0.09, 1.0],
    roughnessFactor: 0.08,
    metallicFactor: 0.15
  },
  mirrorSurface: {
    name: 'MirrorReflective',
    baseColorFactor: [0.95, 0.97, 0.99, 1.0],
    roughnessFactor: 0.04,
    metallicFactor: 0.96
  },
  glassClear: {
    name: 'GlassClear',
    baseColorFactor: [0.84, 0.93, 0.96, 0.36],
    roughnessFactor: 0.08,
    metallicFactor: 0.05,
    alphaMode: 'BLEND',
    doubleSided: true
  },
  glassFluted: {
    name: 'GlassFlutedTinted',
    baseColorFactor: [0.76, 0.82, 0.85, 0.54],
    roughnessFactor: 0.32,
    metallicFactor: 0.08,
    alphaMode: 'BLEND',
    doubleSided: true
  },
  waterBlue: {
    name: 'WaterClean',
    baseColorFactor: [0.24, 0.58, 0.68, 0.72],
    roughnessFactor: 0.10,
    metallicFactor: 0.02,
    alphaMode: 'BLEND'
  },
  emissiveWarm: {
    name: 'WarmLED3000K',
    baseColorFactor: [1.0, 0.95, 0.84, 1.0],
    emissiveFactor: [1.0, 0.72, 0.32],
    roughnessFactor: 0.22,
    metallicFactor: 0.0
  },
  emissiveGoldMandala: {
    name: 'TrucChiMandalaGold',
    baseColorFactor: [1.0, 0.90, 0.66, 1.0],
    emissiveFactor: [0.92, 0.62, 0.18],
    roughnessFactor: 0.28,
    metallicFactor: 0.08,
    textureKey: 'truc_chi_mandala'
  },
  stairRiserWhite: {
    name: 'StairRiserWhite',
    baseColorFactor: [0.97, 0.96, 0.94, 1.0],
    roughnessFactor: 0.52,
    metallicFactor: 0.02
  },
  concreteStructural: {
    name: 'ConcreteStructural',
    baseColorFactor: [0.86, 0.84, 0.80, 1.0],
    roughnessFactor: 0.74,
    metallicFactor: 0.04
  },
  contactShadow: {
    name: 'ContactShadowAO',
    baseColorFactor: [1.0, 1.0, 1.0, 1.0],
    roughnessFactor: 1.0,
    metallicFactor: 0.0,
    textureKey: 'contact_shadow',
    alphaMode: 'BLEND',
    doubleSided: false
  }
};

// Create lightweight Three.js placeholder materials tagged with matKey
const MAT_INSTANCES = {};
for (const [key, def] of Object.entries(MATERIAL_DEFS)) {
  const mat = new THREE.MeshStandardMaterial({
    name: def.name,
    color: new THREE.Color(def.baseColorFactor[0], def.baseColorFactor[1], def.baseColorFactor[2]),
    roughness: def.roughnessFactor,
    metalness: def.metallicFactor,
    transparent: def.alphaMode === 'BLEND',
    opacity: def.baseColorFactor[3],
    side: def.doubleSided ? THREE.DoubleSide : THREE.FrontSide
  });
  mat.userData = { matKey: key };
  MAT_INSTANCES[key] = mat;
}

// ============================================================================
// 3. GEOMETRY HELPERS & PIVOT NORMALIZATION
// ============================================================================

const GEO_CACHE = new Map();

function createRoundedBoxGeometry(width, height, depth, radius = 0.02, segments = 1) {
  const w = Math.max(0.012, width);
  const h = Math.max(0.008, height);
  const d = Math.max(0.012, depth);
  const r = Math.min(radius, w * 0.35, h * 0.35, d * 0.35);

  const seg = Math.min(segments, 1);
  const key = `${w.toFixed(3)}_${h.toFixed(3)}_${d.toFixed(3)}_${r.toFixed(3)}_${seg}`;
  if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);

  const innerW = Math.max(0.004, w - r * 2);
  const innerD = Math.max(0.004, d - r * 2);
  const hw = innerW / 2;
  const hd = innerD / 2;

  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hd - r);
  shape.lineTo(hw, -hd - r);
  shape.quadraticCurveTo(hw + r, -hd - r, hw + r, -hd);
  shape.lineTo(hw + r, hd);
  shape.quadraticCurveTo(hw + r, hd + r, hw, hd + r);
  shape.lineTo(-hw, hd + r);
  shape.quadraticCurveTo(-hw - r, hd + r, -hw - r, hd);
  shape.lineTo(-hw - r, -hd);
  shape.quadraticCurveTo(-hw - r, -hd - r, -hw, -hd - r);

  const extrudeDepth = Math.max(0.003, h - r * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: extrudeDepth,
    bevelEnabled: true,
    bevelSegments: seg,
    steps: 1,
    bevelSize: r,
    bevelThickness: r,
    curveSegments: Math.max(2, seg * 2)
  });

  geo.rotateX(Math.PI / 2);
  geo.center();
  geo.computeVertexNormals();

  // Normalize UVs to clean metric scale so procedural wood/marble/fabric tiles naturally
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const nx = Math.abs(norm.getX(i)), ny = Math.abs(norm.getY(i)), nz = Math.abs(norm.getZ(i));
    if (ny >= nx && ny >= nz) {
      uv[i * 2] = (px / w) + 0.5;
      uv[i * 2 + 1] = (pz / d) + 0.5;
    } else if (nx >= nz) {
      uv[i * 2] = (pz / d) + 0.5;
      uv[i * 2 + 1] = (py / h) + 0.5;
    } else {
      uv[i * 2] = (px / w) + 0.5;
      uv[i * 2 + 1] = (py / h) + 0.5;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  GEO_CACHE.set(key, geo);
  return geo;
}

function addRBox(parent, w, h, d, matKey, x = 0, y = 0, z = 0, r = 0.02, rx = 0, ry = 0, rz = 0, name = '') {
  const geo = createRoundedBoxGeometry(w, h, d, r, 1);
  const mesh = new THREE.Mesh(geo, MAT_INSTANCES[matKey] || MAT_INSTANCES.woodOak);
  mesh.position.set(x, y, z);
  if (rx || ry || rz) mesh.rotation.set(rx, ry, rz);
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function addBox(parent, w, h, d, matKey, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, name = '') {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, MAT_INSTANCES[matKey] || MAT_INSTANCES.woodOak);
  mesh.position.set(x, y, z);
  if (rx || ry || rz) mesh.rotation.set(rx, ry, rz);
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function addCyl(parent, rt, rb, h, matKey, x = 0, y = 0, z = 0, segs = 8, rx = 0, ry = 0, rz = 0, name = '') {
  const radialSegs = Math.min(segs || 8, 8);
  const geo = new THREE.CylinderGeometry(rt, rb, h, radialSegs, 1);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, MAT_INSTANCES[matKey] || MAT_INSTANCES.metalBrass);
  mesh.position.set(x, y, z);
  if (rx || ry || rz) mesh.rotation.set(rx, ry, rz);
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function addSphere(parent, r, matKey, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, name = '') {
  const geo = new THREE.SphereGeometry(r, 8, 8);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, MAT_INSTANCES[matKey] || MAT_INSTANCES.foliageDark);
  mesh.position.set(x, y, z);
  if (sx !== 1 || sy !== 1 || sz !== 1) mesh.scale.set(sx, sy, sz);
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

/**
 * Normalizes a built asset group so its exact bottom-center rests at (0, 0, 0) (Y = 0)
 * and appends a baked ContactShadowPlane at Y = 0.001m matching the footprint.
 */
function finalizeAssetGroup(group, targetW, targetD, normalized = false) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (!normalized && !box.isEmpty()) {
    const centerX = (box.min.x + box.max.x) * 0.5;
    const centerZ = (box.min.z + box.max.z) * 0.5;
    const minY = box.min.y;
    for (const child of group.children) {
      child.position.x -= centerX;
      child.position.y -= minY;
      child.position.z -= centerZ;
    }
  }

  // Add ContactShadowPlane at Y = 0.001m
  const shadowGeo = new THREE.PlaneGeometry(targetW * 1.04, targetD * 1.04);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMesh = new THREE.Mesh(shadowGeo, MAT_INSTANCES.contactShadow);
  shadowMesh.name = 'ContactShadowPlane';
  shadowMesh.position.set(0, 0.001, 0);
  shadowMesh.userData = { isContactShadow: true };
  group.add(shadowMesh);

  group.updateMatrixWorld(true);
  return group;
}

// ============================================================================
// 3.5. MESH MERGING BY MATERIAL (REDUCE DRAW CALLS & TRIANGLE OVERHEAD)
// ============================================================================

const CANONICAL_MATERIAL_CATEGORIES = {
  wood: ['woodOak', 'woodWalnut', 'woodMahogany', 'kitchenCabinet', 'stairRiserWhite', 'concreteStructural'],
  fabric: ['fabricLinen', 'fabricVelvet', 'fabricCharcoal', 'rugWoven', 'pillowTerra', 'pillowSage', 'pillowMustard', 'pillowNavy', 'beddingWhite', 'beddingDuvet'],
  metal: ['metalBrass', 'metalBlack', 'metalChrome', 'stainlessSteel'],
  stone: ['marbleCarrara', 'ceramicWhite', 'ceramicVase', 'terracottaPot', 'soilDark'],
  glass_emissive: ['tvScreen', 'cooktopGlass', 'mirrorSurface', 'glassClear', 'glassFluted', 'waterBlue', 'emissiveWarm', 'emissiveGoldMandala'],
  foliage: ['foliageDark', 'foliageLight']
};

function getMaterialCategory(matKey) {
  for (const [cat, list] of Object.entries(CANONICAL_MATERIAL_CATEGORIES)) {
    if (list.includes(matKey)) return cat;
  }
  return 'wood';
}

function ensureIndexed(geo) {
  if (geo.index && geo.index.count > 0) return geo;
  const count = geo.attributes.position.count;
  const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    indices[i] = i;
  }
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

function manualMergeGeometries(geometries) {
  if (geometries.length === 1) {
    return ensureIndexed(geometries[0]);
  }

  let totalVertexCount = 0;
  let totalIndexCount = 0;

  for (const geo of geometries) {
    ensureIndexed(geo);
    totalVertexCount += geo.attributes.position.count;
    totalIndexCount += geo.index.count;
  }

  const mergedPos = new Float32Array(totalVertexCount * 3);
  const mergedNorm = new Float32Array(totalVertexCount * 3);
  const mergedUV = new Float32Array(totalVertexCount * 2);
  const useU32 = totalVertexCount > 65535;
  const mergedIdx = useU32 ? new Uint32Array(totalIndexCount) : new Uint16Array(totalIndexCount);

  let vertexOffset = 0;
  let indexOffset = 0;

  for (const geo of geometries) {
    const posAttr = geo.attributes.position;
    const normAttr = geo.attributes.normal;
    const uvAttr = geo.attributes.uv;
    const idxAttr = geo.index;
    const vCount = posAttr.count;
    const iCount = idxAttr.count;

    mergedPos.set(posAttr.array.subarray(0, vCount * 3), vertexOffset * 3);

    if (normAttr) {
      mergedNorm.set(normAttr.array.subarray(0, vCount * 3), vertexOffset * 3);
    }

    if (uvAttr) {
      mergedUV.set(uvAttr.array.subarray(0, vCount * 2), vertexOffset * 2);
    } else {
      for (let i = 0; i < vCount; i++) {
        mergedUV[(vertexOffset + i) * 2] = posAttr.getX(i) * 0.5 + 0.5;
        mergedUV[(vertexOffset + i) * 2 + 1] = posAttr.getZ(i) * 0.5 + 0.5;
      }
    }

    const idxArray = idxAttr.array;
    for (let i = 0; i < iCount; i++) {
      mergedIdx[indexOffset + i] = idxArray[i] + vertexOffset;
    }

    vertexOffset += vCount;
    indexOffset += iCount;
  }

  const mergedGeo = new THREE.BufferGeometry();
  mergedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  mergedGeo.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
  mergedGeo.setAttribute('uv', new THREE.BufferAttribute(mergedUV, 2));
  mergedGeo.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
  return mergedGeo;
}

function mergeMeshesByMaterial(rootGroup, assetId) {
  rootGroup.updateMatrixWorld(true);

  const rawMeshesByMat = new Map();
  let contactShadowMesh = null;

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    if (obj.name === 'ContactShadowPlane' || obj.userData?.isContactShadow) {
      contactShadowMesh = obj;
      return;
    }

    const matKey = obj.material?.userData?.matKey || 'woodOak';
    if (!rawMeshesByMat.has(matKey)) {
      rawMeshesByMat.set(matKey, []);
    }
    rawMeshesByMat.get(matKey).push(obj);
  });

  const optimizedGroup = new THREE.Group();
  optimizedGroup.name = assetId;

  for (const [matKey, meshList] of rawMeshesByMat.entries()) {
    if (meshList.length === 0) continue;

    const geosToMerge = [];
    for (const mesh of meshList) {
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      if (!geo.attributes.normal) {
        geo.computeVertexNormals();
      }
      ensureIndexed(geo);
      geosToMerge.push(geo);
    }

    const mergedGeo = mergeGeometries(geosToMerge) || manualMergeGeometries(geosToMerge);

    const mergedMesh = new THREE.Mesh(mergedGeo, MAT_INSTANCES[matKey] || MAT_INSTANCES.woodOak);
    mergedMesh.name = `${assetId}_${matKey}`;
    mergedMesh.userData = { matKey, isMergedMesh: true };
    optimizedGroup.add(mergedMesh);
  }

  // Preserve ContactShadowPlane as a separate mesh
  if (contactShadowMesh) {
    contactShadowMesh.updateWorldMatrix(true, false);
    const shadowGeo = contactShadowMesh.geometry.clone();
    shadowGeo.applyMatrix4(contactShadowMesh.matrixWorld);
    const shadowMesh = new THREE.Mesh(shadowGeo, contactShadowMesh.material);
    shadowMesh.name = 'ContactShadowPlane';
    shadowMesh.userData = { isContactShadow: true };
    optimizedGroup.add(shadowMesh);
  }

  optimizedGroup.updateMatrixWorld(true);
  return optimizedGroup;
}

// ============================================================================
// 4. SPEC-COMPLIANT NODE.JS GLTF 2.0 BINARY (.GLB) SERIALIZER
// ============================================================================

function padBuffer4(buf, padByte = 0x00) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  const pad = Buffer.alloc(4 - rem, padByte);
  return Buffer.concat([buf, pad]);
}

function serializeGroupToGlbBuffer(inputGroup, assetId) {
  const rootGroup = mergeMeshesByMaterial(inputGroup, assetId);
  rootGroup.updateMatrixWorld(true);

  const binChunks = [];
  let byteOffset = 0;

  const bufferViews = [];
  const accessors = [];
  const images = [];
  const samplers = [
    {
      magFilter: 9729, // LINEAR
      minFilter: 9987, // LINEAR_MIPMAP_LINEAR
      wrapS: 10497,    // REPEAT
      wrapT: 10497     // REPEAT
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

  // Texture deduplication map: textureKey -> glTF texture index
  const texIndexByKey = new Map();
  const getOrAddTexture = (texKey) => {
    if (texIndexByKey.has(texKey)) return texIndexByKey.get(texKey);
    const pngBuf = PNG_BUFFERS[texKey];
    if (!pngBuf) return undefined;
    const bvIdx = appendToBin(pngBuf, undefined);
    const imgIdx = images.length;
    images.push({
      name: texKey,
      bufferView: bvIdx,
      mimeType: 'image/png'
    });
    const texIdx = textures.length;
    textures.push({
      name: `${texKey}_tex`,
      sampler: 0,
      source: imgIdx
    });
    texIndexByKey.set(texKey, texIdx);
    return texIdx;
  };

  // Material deduplication map: matKey -> glTF material index
  const matIndexByKey = new Map();
  const getOrAddMaterial = (matKey) => {
    const key = MATERIAL_DEFS[matKey] ? matKey : 'woodOak';
    if (matIndexByKey.has(key)) return matIndexByKey.get(key);
    const def = MATERIAL_DEFS[key];
    const pbr = {
      baseColorFactor: def.baseColorFactor,
      metallicFactor: def.metallicFactor,
      roughnessFactor: def.roughnessFactor
    };
    if (def.textureKey) {
      const tIdx = getOrAddTexture(def.textureKey);
      if (tIdx !== undefined) {
        pbr.baseColorTexture = { index: tIdx };
      }
    }
    const gltfMat = {
      name: def.name,
      pbrMetallicRoughness: pbr,
      doubleSided: Boolean(def.doubleSided)
    };
    if (def.emissiveFactor) {
      gltfMat.emissiveFactor = def.emissiveFactor;
      if (def.textureKey === 'truc_chi_mandala') {
        const tIdx = getOrAddTexture(def.textureKey);
        if (tIdx !== undefined) {
          gltfMat.emissiveTexture = { index: tIdx };
        }
      }
    }
    if (def.alphaMode) {
      gltfMat.alphaMode = def.alphaMode;
    }
    const mIdx = materials.length;
    materials.push(gltfMat);
    matIndexByKey.set(key, mIdx);
    return mIdx;
  };

  // Traverse all meshes and bake relative transforms into child nodes under root scene node
  const childNodeIndices = [];
  let meshCounter = 0;

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    // Clone geometry and apply the mesh's world matrix (since rootGroup is at origin)
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);
    if (!geo.attributes.normal) {
      geo.computeVertexNormals();
    }

    const posAttr = geo.attributes.position;
    const normAttr = geo.attributes.normal;
    const uvAttr = geo.attributes.uv;
    if (!posAttr || posAttr.count === 0) return;

    const vertexCount = posAttr.count;

    // Positions Float32Array + min/max required by glTF 2.0 spec
    const posArray = new Float32Array(vertexCount * 3);
    const minPos = [Infinity, Infinity, Infinity];
    const maxPos = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);
      const vz = posAttr.getZ(i);
      posArray[i * 3] = vx;
      posArray[i * 3 + 1] = vy;
      posArray[i * 3 + 2] = vz;
      if (vx < minPos[0]) minPos[0] = vx;
      if (vy < minPos[1]) minPos[1] = vy;
      if (vz < minPos[2]) minPos[2] = vz;
      if (vx > maxPos[0]) maxPos[0] = vx;
      if (vy > maxPos[1]) maxPos[1] = vy;
      if (vz > maxPos[2]) maxPos[2] = vz;
    }
    const posBvIdx = appendToBin(Buffer.from(posArray.buffer), 34962); // ARRAY_BUFFER
    const posAccIdx = accessors.length;
    accessors.push({
      bufferView: posBvIdx,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: vertexCount,
      type: 'VEC3',
      min: minPos,
      max: maxPos
    });

    // Normals Float32Array (normalized)
    const normArray = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      let nx = normAttr.getX(i);
      let ny = normAttr.getY(i);
      let nz = normAttr.getZ(i);
      const len = Math.hypot(nx, ny, nz) || 1;
      normArray[i * 3] = nx / len;
      normArray[i * 3 + 1] = ny / len;
      normArray[i * 3 + 2] = nz / len;
    }
    const normBvIdx = appendToBin(Buffer.from(normArray.buffer), 34962);
    const normAccIdx = accessors.length;
    accessors.push({
      bufferView: normBvIdx,
      byteOffset: 0,
      componentType: 5126,
      count: vertexCount,
      type: 'VEC3'
    });

    // UVs Float32Array
    const uvArray = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      if (uvAttr) {
        uvArray[i * 2] = uvAttr.getX(i);
        uvArray[i * 2 + 1] = uvAttr.getY(i);
      } else {
        uvArray[i * 2] = (posArray[i * 3] * 0.5) + 0.5;
        uvArray[i * 2 + 1] = (posArray[i * 3 + 2] * 0.5) + 0.5;
      }
    }
    const uvBvIdx = appendToBin(Buffer.from(uvArray.buffer), 34962);
    const uvAccIdx = accessors.length;
    accessors.push({
      bufferView: uvBvIdx,
      byteOffset: 0,
      componentType: 5126,
      count: vertexCount,
      type: 'VEC2'
    });

    const attributes = {
      POSITION: posAccIdx,
      NORMAL: normAccIdx,
      TEXCOORD_0: uvAccIdx
    };

    const matKey = obj.material?.userData?.matKey || 'woodOak';
    const matIdx = getOrAddMaterial(matKey);

    const primitive = {
      attributes,
      material: matIdx,
      mode: 4 // TRIANGLES
    };

    // Indices
    if (geo.index && geo.index.count > 0) {
      const idxCount = geo.index.count;
      const useU32 = vertexCount > 65535;
      const idxArray = useU32 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
      for (let i = 0; i < idxCount; i++) {
        idxArray[i] = geo.index.getX(i);
      }
      const idxBvIdx = appendToBin(Buffer.from(idxArray.buffer), 34963); // ELEMENT_ARRAY_BUFFER
      const idxAccIdx = accessors.length;
      accessors.push({
        bufferView: idxBvIdx,
        byteOffset: 0,
        componentType: useU32 ? 5125 : 5123, // UNSIGNED_INT : UNSIGNED_SHORT
        count: idxCount,
        type: 'SCALAR'
      });
      primitive.indices = idxAccIdx;
    }

    const meshName = obj.name || `${assetId}_part_${++meshCounter}`;
    const meshIdx = meshes.length;
    meshes.push({
      name: meshName,
      primitives: [primitive]
    });

    const nodeIdx = nodes.length;
    const nodeDef = {
      name: meshName,
      mesh: meshIdx
    };
    if (obj.name === 'ContactShadowPlane' || obj.userData?.isContactShadow) {
      nodeDef.extras = { isContactShadow: true };
    }
    nodes.push(nodeDef);
    childNodeIndices.push(nodeIdx);
  });

  // Root node holding all child mesh nodes
  const rootNodeIdx = nodes.length;
  nodes.push({
    name: assetId,
    children: childNodeIndices
  });

  const binBuffer = padBuffer4(Buffer.concat(binChunks), 0x00);

  const gltfJson = {
    asset: {
      version: '2.0',
      generator: 'OpenCADStudio_Z Nếp Nhà Asset Baker v2.0'
    },
    scene: 0,
    scenes: [
      {
        name: `${assetId}_scene`,
        nodes: [rootNodeIdx]
      }
    ],
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
        byteLength: binBuffer.length
      }
    ]
  };

  const jsonBytes = Buffer.from(JSON.stringify(gltfJson), 'utf8');
  const paddedJsonBytes = padBuffer4(jsonBytes, 0x20); // Pad JSON with ASCII spaces (0x20)

  const totalByteLength = 12 + 8 + paddedJsonBytes.length + 8 + binBuffer.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0); // 'glTF' magic
  header.writeUInt32LE(2, 4);          // version 2
  header.writeUInt32LE(totalByteLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(paddedJsonBytes.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binBuffer.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942, 4);  // 'BIN\0'

  return Buffer.concat([header, jsonChunkHeader, paddedJsonBytes, binChunkHeader, binBuffer]);
}

// ============================================================================
// 5. HIGH-DETAIL PROCEDURAL 3D ASSET BUILDERS (35 MODELS)
// ============================================================================

function buildLivingRoomAssets() {
  return {
    // 1. sofa_l_modern
    sofa_l_modern() {
      const g = new THREE.Group();
      const w = 2.65, d = 1.65, mainD = 0.94, chaiseW = 0.92;
      const legH = 0.10, baseH = 0.07;

      // Tapered walnut legs + brass feet
      const legCoords = [
        [-w / 2 + 0.08, -d / 2 + 0.08], [w / 2 - 0.08, -d / 2 + 0.08],
        [-w / 2 + 0.08, -d / 2 + mainD - 0.08],
        [w / 2 - chaiseW + 0.06, d / 2 - 0.08], [w / 2 - 0.08, d / 2 - 0.08]
      ];
      for (const [lx, lz] of legCoords) {
        addCyl(g, 0.022, 0.014, legH, 'woodWalnut', lx, legH / 2, lz, 6);
        addCyl(g, 0.015, 0.014, 0.028, 'metalBrass', lx, 0.014, lz, 6);
      }

      // Walnut base frames (main + chaise extension)
      addBox(g, w - chaiseW, baseH, mainD, 'woodWalnut', -chaiseW / 2, legH + baseH / 2, -d / 2 + mainD / 2);
      addBox(g, chaiseW, baseH, d, 'woodWalnut', w / 2 - chaiseW / 2, legH + baseH / 2, 0);

      // Backrest frame along -Z
      const backH = 0.68, backD = 0.14;
      addRBox(g, w, backH, backD, 'fabricVelvet', 0, legH + baseH + backH / 2, -d / 2 + backD / 2, 0.03);

      // Left & Right padded armrests
      const armW = 0.18, armH = 0.44;
      addRBox(g, armW, armH, mainD - 0.02, 'fabricVelvet', -w / 2 + armW / 2, legH + baseH + armH / 2, -d / 2 + mainD / 2, 0.035);
      addRBox(g, armW, armH, d * 0.72, 'fabricVelvet', w / 2 - armW / 2, legH + baseH + armH / 2, -d / 2 + (d * 0.72) / 2, 0.035);

      // 2 Main seat cushions + 1 Long chaise lounge cushion
      const seatH = 0.18, seatY = legH + baseH + seatH / 2;
      const leftInnerW = w - chaiseW - armW;
      const cW = leftInnerW / 2 - 0.01;
      for (let i = 0; i < 2; i++) {
        const cx = -w / 2 + armW + (i + 0.5) * (leftInnerW / 2);
        addRBox(g, cW, seatH, mainD - backD + 0.02, 'fabricLinen', cx, seatY, -d / 2 + backD + (mainD - backD) / 2, 0.035);
        addRBox(g, cW - 0.02, 0.38, 0.16, 'fabricLinen', cx, seatY + 0.25, -d / 2 + backD + 0.07, 0.035, -0.15, 0, 0);
      }

      // Chaise cushion
      const chInnerW = chaiseW - armW;
      const chCx = w / 2 - armW - chInnerW / 2;
      addRBox(g, chInnerW - 0.01, seatH, d - backD - 0.02, 'fabricLinen', chCx, seatY, -d / 2 + backD + (d - backD) / 2, 0.035);
      addRBox(g, chInnerW - 0.02, 0.38, 0.16, 'fabricLinen', chCx, seatY + 0.25, -d / 2 + backD + 0.07, 0.035, -0.15, 0, 0);

      // Multicolor accent throw pillows
      addRBox(g, 0.34, 0.32, 0.11, 'pillowTerra', -w / 2 + armW + 0.22, seatY + 0.21, -d / 2 + backD + 0.18, 0.035, -0.18, 0.35, -0.12);
      addRBox(g, 0.30, 0.28, 0.10, 'pillowMustard', -w / 2 + armW + 0.42, seatY + 0.19, -d / 2 + backD + 0.22, 0.035, -0.14, 0.18, -0.06);
      addRBox(g, 0.34, 0.32, 0.11, 'pillowSage', chCx + 0.08, seatY + 0.21, -d / 2 + backD + 0.18, 0.035, -0.16, -0.28, 0.10);

      return finalizeAssetGroup(g, w, d);
    },

    // 2. sofa_straight_3seat
    sofa_straight_3seat() {
      const g = new THREE.Group();
      const w = 2.20, d = 0.92, legH = 0.11, baseH = 0.07;

      for (const lx of [-w / 2 + 0.09, 0, w / 2 - 0.09]) {
        for (const lz of [-d / 2 + 0.09, d / 2 - 0.09]) {
          addCyl(g, 0.022, 0.014, legH, 'woodWalnut', lx, legH / 2, lz, 10);
          addCyl(g, 0.015, 0.014, 0.025, 'metalBrass', lx, 0.013, lz, 10);
        }
      }
      addBox(g, w - 0.02, baseH, d - 0.02, 'woodWalnut', 0, legH + baseH / 2, 0);
      const backH = 0.66, backD = 0.14, armW = 0.17, armH = 0.44;
      addRBox(g, w, backH, backD, 'fabricVelvet', 0, legH + baseH + backH / 2, -d / 2 + backD / 2, 0.03);
      addRBox(g, armW, armH, d - 0.02, 'fabricVelvet', -w / 2 + armW / 2, legH + baseH + armH / 2, 0, 0.035);
      addRBox(g, armW, armH, d - 0.02, 'fabricVelvet', w / 2 - armW / 2, legH + baseH + armH / 2, 0, 0.035);

      const innerW = w - armW * 2;
      const cW = innerW / 3 - 0.01;
      const seatH = 0.18, seatY = legH + baseH + seatH / 2;
      for (let i = 0; i < 3; i++) {
        const cx = -innerW / 2 + (i + 0.5) * (innerW / 3);
        addRBox(g, cW, seatH, d - backD, 'fabricLinen', cx, seatY, backD / 2, 0.035);
        addRBox(g, cW - 0.015, 0.38, 0.15, 'fabricLinen', cx, seatY + 0.24, -d / 2 + backD + 0.07, 0.035, -0.15, 0, 0);
      }
      addRBox(g, 0.32, 0.30, 0.10, 'pillowTerra', -innerW / 2 + 0.20, seatY + 0.20, -d / 2 + backD + 0.17, 0.035, -0.14, 0.32, -0.1);
      addRBox(g, 0.32, 0.30, 0.10, 'pillowMustard', innerW / 2 - 0.20, seatY + 0.20, -d / 2 + backD + 0.17, 0.035, -0.14, -0.32, 0.1);

      return finalizeAssetGroup(g, w, d);
    },

    // 3. armchair_lounge
    armchair_lounge() {
      const g = new THREE.Group();
      const w = 0.84, d = 0.82, legH = 0.22;
      for (const [lx, lz] of [[-0.32, -0.30], [0.32, -0.30], [-0.32, 0.30], [0.32, 0.30]]) {
        addCyl(g, 0.022, 0.014, legH, 'woodWalnut', lx, legH / 2, lz, 10, lz * 0.25, 0, -lx * 0.25);
        addCyl(g, 0.015, 0.014, 0.03, 'metalBrass', lx * 1.05, 0.015, lz * 1.05, 10);
      }
      addRBox(g, 0.74, 0.07, 0.72, 'woodWalnut', 0, legH + 0.035, 0, 0.02);
      addRBox(g, 0.64, 0.15, 0.64, 'fabricLinen', 0, legH + 0.13, 0.03, 0.035);
      addRBox(g, 0.76, 0.50, 0.14, 'fabricVelvet', 0, legH + 0.38, -0.29, 0.04, -0.18, 0, 0);
      addRBox(g, 0.11, 0.32, 0.66, 'fabricVelvet', -0.35, legH + 0.26, 0, 0.03);
      addRBox(g, 0.11, 0.32, 0.66, 'fabricVelvet', 0.35, legH + 0.26, 0, 0.03);
      addRBox(g, 0.34, 0.26, 0.09, 'pillowMustard', 0, legH + 0.28, -0.15, 0.03, -0.22, 0, 0);
      return finalizeAssetGroup(g, w, d);
    },

    // 4. coffee_table_set
    coffee_table_set() {
      const g = new THREE.Group();
      const w = 1.28, d = 0.72, h = 0.42;
      // Main rounded Carrara marble table
      addRBox(g, 0.96, 0.035, 0.66, 'marbleCarrara', -0.12, h - 0.017, 0, 0.18);
      addRBox(g, 0.92, 0.016, 0.62, 'metalBrass', -0.12, h - 0.04, 0, 0.16);
      for (const [lx, lz] of [[-0.44, -0.22], [0.20, -0.22], [-0.44, 0.22], [0.20, 0.22]]) {
        addCyl(g, 0.02, 0.014, h - 0.04, 'woodWalnut', lx, (h - 0.04) / 2, lz, 10);
      }
      addRBox(g, 0.68, 0.02, 0.44, 'woodWalnut', -0.12, 0.14, 0, 0.08);

      // Nesting round walnut & brass side table on right
      const nh = 0.48;
      addCyl(g, 0.26, 0.26, 0.028, 'woodWalnut', 0.36, nh - 0.014, 0.06, 24);
      addCyl(g, 0.014, 0.014, nh - 0.02, 'metalBrass', 0.22, (nh - 0.02) / 2, -0.06, 8);
      addCyl(g, 0.014, 0.014, nh - 0.02, 'metalBrass', 0.50, (nh - 0.02) / 2, -0.06, 8);
      addCyl(g, 0.014, 0.014, nh - 0.02, 'metalBrass', 0.36, (nh - 0.02) / 2, 0.22, 8);

      // Accessories: walnut tray, ceramic vase with greenery, stacked books
      addRBox(g, 0.34, 0.02, 0.26, 'woodWalnut', -0.26, h + 0.01, -0.02, 0.02);
      addCyl(g, 0.042, 0.058, 0.16, 'ceramicVase', -0.28, h + 0.09, -0.02, 14);
      addSphere(g, 0.065, 'foliageDark', -0.28, h + 0.20, -0.02, 1.2, 0.8, 1.1);
      addSphere(g, 0.055, 'foliageLight', -0.23, h + 0.22, 0.02, 1.1, 0.7, 1.0);
      addRBox(g, 0.24, 0.032, 0.18, 'pillowTerra', 0.06, h + 0.016, 0.04, 0.006, 0, 0.18, 0);
      addRBox(g, 0.21, 0.026, 0.15, 'beddingWhite', 0.06, h + 0.045, 0.04, 0.005, 0, -0.08, 0);

      return finalizeAssetGroup(g, w, d);
    },

    // 5. tv_cabinet_wall_unit
    tv_cabinet_wall_unit() {
      const g = new THREE.Group();
      const w = 2.20, d = 0.46, consoleH = 0.48, legH = 0.11, bodyH = consoleH - legH;

      for (const lx of [-w * 0.42, 0, w * 0.42]) {
        for (const lz of [-d * 0.35, d * 0.35]) {
          addCyl(g, 0.018, 0.012, legH, 'metalBrass', lx, legH / 2, lz, 8);
        }
      }
      addRBox(g, w, bodyH, d, 'woodWalnut', 0, legH + bodyH / 2, 0, 0.018);
      addRBox(g, w - 0.02, 0.022, d - 0.02, 'marbleCarrara', 0, consoleH + 0.011, 0, 0.01);

      // Slatted oak doors across front (+Z)
      const numSlats = 24;
      for (let i = 0; i < numSlats; i++) {
        const sx = -w / 2 + 0.06 + (i / (numSlats - 1)) * (w - 0.12);
        addBox(g, 0.018, bodyH - 0.05, 0.012, 'woodOak', sx, legH + bodyH / 2, d / 2 + 0.006);
      }

      // Wall-mounted slatted wood backdrop panel at -Z
      const panelH = 1.62, panelW = w * 0.96;
      addBox(g, panelW, panelH, 0.02, 'woodWalnut', 0, consoleH + panelH / 2, -d / 2 + 0.01);
      const wallSlats = 26;
      for (let i = 0; i < wallSlats; i++) {
        const sx = -panelW / 2 + 0.035 + (i / (wallSlats - 1)) * (panelW - 0.07);
        addBox(g, 0.028, panelH, 0.02, 'woodOak', sx, consoleH + panelH / 2, -d / 2 + 0.025);
      }
      addBox(g, 0.022, panelH - 0.08, 0.026, 'emissiveWarm', panelW / 2 - 0.02, consoleH + panelH / 2, -d / 2 + 0.026);

      // 75" flat OLED TV + soundbar + ceramic planter
      const tvW = 1.54, tvH = 0.88, tvY = consoleH + 0.24 + tvH / 2;
      addBox(g, tvW + 0.024, tvH + 0.024, 0.022, 'metalBlack', 0, tvY, -d / 2 + 0.065);
      addBox(g, tvW, tvH, 0.008, 'tvScreen', 0, tvY, -d / 2 + 0.078);
      addRBox(g, 0.92, 0.055, 0.09, 'metalBlack', 0, consoleH + 0.048, 0.05, 0.014);

      addCyl(g, 0.11, 0.085, 0.22, 'ceramicVase', -w * 0.39, consoleH + 0.12, 0.04, 14);
      addSphere(g, 0.15, 'foliageDark', -w * 0.39, consoleH + 0.31, 0.04, 1.0, 1.15, 1.0);

      return finalizeAssetGroup(g, w, d);
    },

    // 6. entrance_shoe_cabinet
    entrance_shoe_cabinet() {
      const g = new THREE.Group();
      const w = 1.40, d = 0.38, cabW = 0.90, benchW = 0.50, cabH = 1.12, benchH = 0.46;
      // Left shoe cabinet with marble counter & slatted doors
      addRBox(g, cabW, cabH - 0.08, d, 'woodWalnut', -benchW / 2, 0.08 + (cabH - 0.08) / 2, 0, 0.015);
      addRBox(g, cabW + 0.01, 0.024, d + 0.01, 'marbleCarrara', -benchW / 2, cabH + 0.012, 0, 0.008);
      for (const side of [-1, 1]) {
        const dx = -benchW / 2 + side * (cabW * 0.24);
        addBox(g, cabW * 0.46, cabH - 0.16, 0.014, 'woodOak', dx, 0.08 + (cabH - 0.08) / 2, d / 2 + 0.005);
        addBox(g, 0.014, 0.22, 0.024, 'metalBrass', -benchW / 2 + side * 0.04, cabH * 0.62, d / 2 + 0.016);
      }
      // Key tray & handbag on top
      addRBox(g, 0.24, 0.018, 0.16, 'metalBrass', -benchW / 2 - 0.16, cabH + 0.03, 0, 0.01);
      addRBox(g, 0.26, 0.18, 0.11, 'pillowTerra', -benchW / 2 + 0.16, cabH + 0.11, 0, 0.025);

      // Right cushioned seating bench
      addRBox(g, benchW, benchH - 0.08, d, 'woodWalnut', cabW / 2, 0.08 + (benchH - 0.08) / 2, 0, 0.015);
      addRBox(g, benchW - 0.02, 0.07, d - 0.02, 'fabricLinen', cabW / 2, benchH + 0.035, 0, 0.025);

      for (const lx of [-w / 2 + 0.08, 0, w / 2 - 0.08]) {
        for (const lz of [-d / 2 + 0.06, d / 2 - 0.06]) {
          addCyl(g, 0.016, 0.012, 0.08, 'metalBrass', lx, 0.04, lz, 8);
        }
      }
      return finalizeAssetGroup(g, w, d);
    },

    // 7. floor_rug_textured
    floor_rug_textured() {
      const g = new THREE.Group();
      const w = 2.60, d = 1.80, h = 0.008;
      addRBox(g, w, h, d, 'rugWoven', 0, h / 2, 0, 0.003);
      addBox(g, w + 0.04, 0.004, d - 0.06, 'fabricLinen', 0, 0.002, 0);
      return finalizeAssetGroup(g, w, d);
    }
  };
}

function createDiningChair(parent, x, z, rotY) {
  const cg = new THREE.Group();
  cg.position.set(x, 0, z);
  cg.rotation.y = rotY;
  const seatH = 0.45, seatW = 0.44, seatD = 0.43;
  for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
    addCyl(cg, 0.016, 0.011, seatH, 'woodWalnut', lx, seatH / 2, lz, 6);
  }
  addBox(cg, seatW, 0.055, seatD, 'fabricLinen', 0, seatH, 0);
  addBox(cg, seatW, 0.36, 0.05, 'fabricVelvet', 0, seatH + 0.21, -seatD / 2 + 0.03, -0.12, 0, 0);
  parent.add(cg);
}

function buildKitchenAndDiningAssets() {
  return {
    // 8. kitchen_system_i
    kitchen_system_i() {
      const g = new THREE.Group();
      const w = 2.80, d = 0.65, counterH = 0.88, toeH = 0.09, lowerH = counterH - toeH - 0.035;
      addBox(g, w - 0.04, toeH, d - 0.08, 'metalBlack', 0, toeH / 2, -0.02);
      addRBox(g, w, lowerH, d - 0.02, 'kitchenCabinet', 0, toeH + lowerH / 2, 0, 0.012);

      const numDoors = 5;
      const doorW = (w - 0.04) / numDoors;
      for (let i = 0; i < numDoors; i++) {
        const dx = -w / 2 + 0.02 + (i + 0.5) * doorW;
        addBox(g, doorW - 0.016, lowerH - 0.04, 0.015, 'kitchenCabinet', dx, toeH + lowerH / 2, d / 2 - 0.004);
        addBox(g, doorW * 0.44, 0.014, 0.024, 'metalBrass', dx, counterH - 0.10, d / 2 + 0.012);
      }

      // Carrara marble countertop & backsplash
      addRBox(g, w + 0.03, 0.035, d + 0.03, 'marbleCarrara', 0, counterH - 0.017, 0.01, 0.01);
      const splashH = 0.58;
      addBox(g, w, splashH, 0.02, 'marbleCarrara', 0, counterH + splashH / 2, -d / 2 + 0.012);

      // Double stainless steel sink + chrome gooseneck faucet on left
      const sinkX = -w * 0.25;
      addBox(g, 0.68, 0.012, 0.44, 'stainlessSteel', sinkX, counterH + 0.005, 0.02);
      addBox(g, 0.30, 0.015, 0.38, 'metalBlack', sinkX - 0.16, counterH + 0.007, 0.02);
      addBox(g, 0.30, 0.015, 0.38, 'metalBlack', sinkX + 0.16, counterH + 0.007, 0.02);
      addCyl(g, 0.014, 0.018, 0.24, 'metalChrome', sinkX, counterH + 0.12, -0.18, 10);
      addBox(g, 0.018, 0.018, 0.16, 'metalChrome', sinkX, counterH + 0.23, -0.11);

      // 4-zone induction cooktop + range hood on right
      const cookX = w * 0.24;
      addBox(g, 0.64, 0.012, 0.44, 'cooktopGlass', cookX, counterH + 0.005, 0.02);
      for (const [rx, rz] of [[-0.15, -0.09], [0.15, -0.09], [-0.15, 0.10], [0.15, 0.10]]) {
        addCyl(g, 0.065, 0.065, 0.004, 'emissiveWarm', cookX + rx, counterH + 0.012, 0.02 + rz, 16);
      }

      // Upper oak wall cabinets + warm LED strip + stainless range hood
      const upperH = 0.66, upperD = 0.36, upperY = counterH + splashH + upperH / 2;
      addRBox(g, w * 0.62, upperH, upperD, 'woodOak', -w * 0.19, upperY, -d / 2 + upperD / 2, 0.012);
      addBox(g, w * 0.60, 0.014, 0.028, 'emissiveWarm', -w * 0.19, counterH + splashH - 0.008, -d / 2 + upperD * 0.7);
      addRBox(g, 0.70, 0.08, 0.48, 'stainlessSteel', cookX, counterH + splashH + 0.04, -d / 2 + 0.24, 0.01);
      addBox(g, 0.28, 0.58, 0.26, 'stainlessSteel', cookX, counterH + splashH + 0.36, -d / 2 + 0.14);

      return finalizeAssetGroup(g, w, d);
    },

    // 9. kitchen_system_l
    kitchen_system_l() {
      const g = new THREE.Group();
      const w = 2.60, d = 1.85, legD = 0.62, counterH = 0.88, toeH = 0.09, lowerH = counterH - toeH - 0.035;
      // Back main run along -Z
      addRBox(g, w, lowerH, legD, 'kitchenCabinet', 0, toeH + lowerH / 2, -d / 2 + legD / 2, 0.012);
      addRBox(g, w + 0.02, 0.035, legD + 0.02, 'marbleCarrara', 0, counterH - 0.017, -d / 2 + legD / 2, 0.01);
      // Left L-wing along -X
      const wingLen = d - legD;
      const wingX = -w / 2 + legD / 2;
      const wingZ = -d / 2 + legD + wingLen / 2;
      addRBox(g, legD, lowerH, wingLen, 'kitchenCabinet', wingX, toeH + lowerH / 2, wingZ, 0.012);
      addRBox(g, legD + 0.02, 0.035, wingLen + 0.02, 'marbleCarrara', wingX, counterH - 0.017, wingZ, 0.01);

      // Backsplash + upper wall cabinets along -Z
      const splashH = 0.58, upperH = 0.64, upperD = 0.35;
      addBox(g, w, splashH, 0.02, 'marbleCarrara', 0, counterH + splashH / 2, -d / 2 + 0.012);
      addRBox(g, w, upperH, upperD, 'woodOak', 0, counterH + splashH + upperH / 2, -d / 2 + upperD / 2, 0.012);
      addBox(g, w - 0.1, 0.014, 0.028, 'emissiveWarm', 0, counterH + splashH - 0.008, -d / 2 + upperD * 0.72);

      // Sink on left wing + Cooktop on back counter
      addBox(g, 0.42, 0.012, 0.58, 'stainlessSteel', wingX, counterH + 0.005, wingZ);
      addBox(g, 0.34, 0.015, 0.48, 'metalBlack', wingX, counterH + 0.007, wingZ);
      addCyl(g, 0.014, 0.018, 0.22, 'metalChrome', wingX - 0.18, counterH + 0.11, wingZ, 10);

      const cookX = 0.38, cookZ = -d / 2 + legD / 2;
      addBox(g, 0.62, 0.012, 0.44, 'cooktopGlass', cookX, counterH + 0.005, cookZ);
      for (const [rx, rz] of [[-0.14, -0.09], [0.14, -0.09], [-0.14, 0.09], [0.14, 0.09]]) {
        addCyl(g, 0.06, 0.06, 0.004, 'emissiveWarm', cookX + rx, counterH + 0.012, cookZ + rz, 14);
      }

      return finalizeAssetGroup(g, w, d);
    },

    // 10. kitchen_island_bar
    kitchen_island_bar() {
      const g = new THREE.Group();
      const w = 1.85, d = 0.96, h = 0.90, cabD = 0.66;
      // Walnut island cabinet + Waterfall Carrara marble top & sides
      addRBox(g, w - 0.08, h - 0.04, cabD, 'woodWalnut', 0, (h - 0.04) / 2, -0.10, 0.012);
      addRBox(g, w, 0.04, d - 0.06, 'marbleCarrara', 0, h - 0.02, 0, 0.012);
      addRBox(g, 0.04, h, d - 0.06, 'marbleCarrara', -w / 2 + 0.02, h / 2, 0, 0.01);
      addRBox(g, 0.04, h, d - 0.06, 'marbleCarrara', w / 2 - 0.02, h / 2, 0, 0.01);

      // Decorative fruit bowl & wine glasses on island
      addCyl(g, 0.16, 0.09, 0.065, 'ceramicVase', -0.25, h + 0.032, -0.06, 16);

      // 3 High barstools along front overhang (+Z)
      for (const sx of [-0.54, 0, 0.54]) {
        const sz = d / 2 - 0.16;
        const stoolH = 0.64;
        for (const [lx, lz] of [[-0.14, -0.14], [0.14, -0.14], [-0.14, 0.14], [0.14, 0.14]]) {
          addCyl(g, 0.013, 0.010, stoolH, 'metalBlack', sx + lx, stoolH / 2, sz + lz, 8);
        }
        addBox(g, 0.28, 0.014, 0.28, 'metalBrass', sx, 0.22, sz);
        addRBox(g, 0.36, 0.06, 0.34, 'fabricVelvet', sx, stoolH + 0.03, sz, 0.025);
        addRBox(g, 0.34, 0.16, 0.045, 'fabricVelvet', sx, stoolH + 0.13, sz + 0.14, 0.02);
      }

      return finalizeAssetGroup(g, w, d);
    },

    // 11. fridge_double_door
    fridge_double_door() {
      const g = new THREE.Group();
      const w = 0.92, d = 0.76, h = 1.88;
      // Carcass
      addRBox(g, w, h, d - 0.06, 'metalBlack', 0, h / 2, -0.03, 0.02);
      // Left freezer door & Right fresh-food door in brushed stainless steel
      const doorW = (w - 0.03) / 2;
      addRBox(g, doorW, h - 0.04, 0.06, 'stainlessSteel', -doorW / 2 - 0.006, h / 2, d / 2 - 0.03, 0.015);
      addRBox(g, doorW, h - 0.04, 0.06, 'stainlessSteel', doorW / 2 + 0.006, h / 2, d / 2 - 0.03, 0.015);
      // Long vertical chrome bar handles
      addCyl(g, 0.011, 0.011, 0.72, 'metalChrome', -0.045, h * 0.56, d / 2 + 0.018, 10);
      addCyl(g, 0.011, 0.011, 0.72, 'metalChrome', 0.045, h * 0.56, d / 2 + 0.018, 10);
      // Water & ice dispenser recess on left door
      addBox(g, 0.18, 0.28, 0.02, 'tvScreen', -doorW / 2, h * 0.62, d / 2 + 0.002);

      return finalizeAssetGroup(g, w, d);
    },

    // 12. dining_table_6chairs
    dining_table_6chairs() {
      const g = new THREE.Group();
      const w = 1.95, d = 1.38, tableW = 1.75, tableD = 0.90, tableH = 0.76;
      addRBox(g, tableW, 0.035, tableD, 'woodOak', 0, tableH - 0.025, 0, 0.04);
      addRBox(g, tableW - 0.08, 0.018, tableD - 0.08, 'marbleCarrara', 0, tableH - 0.005, 0, 0.03);

      const legH = tableH - 0.03;
      for (const [lx, lz] of [[-tableW / 2 + 0.16, -tableD / 2 + 0.14], [tableW / 2 - 0.16, -tableD / 2 + 0.14], [-tableW / 2 + 0.16, tableD / 2 - 0.14], [tableW / 2 - 0.16, tableD / 2 - 0.14]]) {
        addCyl(g, 0.03, 0.02, legH, 'woodWalnut', lx, legH / 2, lz, 10, 0, 0, lx > 0 ? -0.06 : 0.06);
      }

      // Table runner, plates, centerpiece vase
      addBox(g, tableW * 0.72, 0.006, 0.28, 'pillowTerra', 0, tableH + 0.004, 0);
      addCyl(g, 0.045, 0.065, 0.18, 'metalBrass', 0, tableH + 0.09, 0, 14);
      addSphere(g, 0.085, 'foliageLight', 0, tableH + 0.22, 0);

      for (const cx of [-0.54, 0, 0.54]) {
        addCyl(g, 0.12, 0.09, 0.016, 'ceramicWhite', cx, tableH + 0.01, -0.26, 16);
        addCyl(g, 0.12, 0.09, 0.016, 'ceramicWhite', cx, tableH + 0.01, 0.26, 16);
        createDiningChair(g, cx, -tableD / 2 - 0.15, 0);
        createDiningChair(g, cx, tableD / 2 + 0.15, Math.PI);
      }

      return finalizeAssetGroup(g, w, d);
    },

    // 13. dining_table_4chairs
    dining_table_4chairs() {
      const g = new THREE.Group();
      const w = 1.45, d = 1.32, tableW = 1.32, tableD = 0.84, tableH = 0.76;
      addRBox(g, tableW, 0.035, tableD, 'woodOak', 0, tableH - 0.025, 0, 0.04);
      addRBox(g, tableW - 0.08, 0.018, tableD - 0.08, 'marbleCarrara', 0, tableH - 0.005, 0, 0.03);

      const legH = tableH - 0.03;
      for (const [lx, lz] of [[-tableW / 2 + 0.14, -tableD / 2 + 0.12], [tableW / 2 - 0.14, -tableD / 2 + 0.12], [-tableW / 2 + 0.14, tableD / 2 - 0.12], [tableW / 2 - 0.14, tableD / 2 - 0.12]]) {
        addCyl(g, 0.028, 0.018, legH, 'woodWalnut', lx, legH / 2, lz, 10, 0, 0, lx > 0 ? -0.06 : 0.06);
      }
      addCyl(g, 0.15, 0.09, 0.065, 'ceramicVase', 0, tableH + 0.035, 0, 16);

      for (const cx of [-0.34, 0.34]) {
        createDiningChair(g, cx, -tableD / 2 - 0.14, 0);
        createDiningChair(g, cx, tableD / 2 + 0.14, Math.PI);
      }

      return finalizeAssetGroup(g, w, d);
    }
  };
}

function buildBedroomAssets() {
  return {
    // 14. bed_master_king
    bed_master_king() {
      const g = new THREE.Group();
      const bedW = 1.90, d = 2.15, fullW = 2.65;
      const plinthH = 0.08, frameH = 0.18, hbH = 1.18, hbD = 0.13;

      addBox(g, bedW - 0.16, plinthH, d - 0.16, 'metalBlack', 0, plinthH / 2, 0.04);
      addBox(g, bedW - 0.10, 0.016, d - 0.12, 'emissiveWarm', 0, plinthH - 0.008, 0.04);
      addRBox(g, bedW, frameH, d - 0.08, 'woodWalnut', 0, plinthH + frameH / 2, 0.04, 0.025);

      // Wide channeled headboard at -Z
      addRBox(g, fullW, hbH, hbD, 'woodWalnut', 0, hbH / 2, -d / 2 + hbD / 2, 0.02);
      const numChan = 6, chanW = (bedW + 0.08) / numChan;
      for (let i = 0; i < numChan; i++) {
        const cx = -(bedW + 0.08) / 2 + (i + 0.5) * chanW;
        addBox(g, chanW - 0.014, hbH - 0.14, 0.065, 'fabricVelvet', cx, hbH / 2 + 0.02, -d / 2 + hbD + 0.02);
      }

      // Rounded orthopedic mattress + quilted duvet + foot runner
      const matW = bedW - 0.08, matD = d - hbD - 0.06, matH = 0.26;
      const matY = plinthH + frameH + matH / 2 - 0.03;
      addRBox(g, matW, matH, matD, 'beddingWhite', 0, matY, hbD / 2, 0.045);
      const duvetD = matD * 0.66;
      addRBox(g, matW + 0.04, matH + 0.035, duvetD, 'beddingDuvet', 0, matY + 0.015, hbD / 2 + (matD - duvetD) / 2 + 0.01, 0.045);
      addRBox(g, matW + 0.06, matH + 0.05, matD * 0.22, 'pillowTerra', 0, matY + 0.02, d / 2 - matD * 0.13, 0.03);

      // 4 Plump beveled pillows
      const topY = matY + matH / 2;
      for (const side of [-1, 1]) {
        const px = side * (matW * 0.24);
        addRBox(g, matW * 0.41, 0.14, 0.32, 'beddingWhite', px, topY + 0.09, -d / 2 + hbD + 0.18, 0.04, 0.34, 0, 0);
        addRBox(g, matW * 0.35, 0.12, 0.26, 'pillowSage', px, topY + 0.07, -d / 2 + hbD + 0.36, 0.035, 0.22, 0, 0);
      }

      // 2 Flanking nightstands + glowing warm table lamps
      const nsW = 0.36, nsD = 0.34, nsH = 0.44;
      for (const side of [-1, 1]) {
        const nx = side * (bedW / 2 + nsW / 2 + 0.01);
        const nz = -d / 2 + hbD + nsD / 2 + 0.02;
        addRBox(g, nsW, 0.22, nsD, 'woodWalnut', nx, nsH - 0.11, nz, 0.015);
        addRBox(g, nsW - 0.02, 0.018, nsD - 0.02, 'marbleCarrara', nx, nsH + 0.008, nz, 0.008);
        addCyl(g, 0.04, 0.055, 0.11, 'metalBrass', nx, nsH + 0.065, nz, 12);
        addCyl(g, 0.075, 0.10, 0.16, 'emissiveWarm', nx, nsH + 0.19, nz, 14);
      }

      return finalizeAssetGroup(g, fullW, d);
    },

    // 15. bed_queen_modern
    bed_queen_modern() {
      const g = new THREE.Group();
      const bedW = 1.62, d = 2.05, fullW = 2.04, frameH = 0.24, hbH = 1.05, hbD = 0.11;
      addRBox(g, bedW, frameH, d - 0.06, 'woodOak', -0.18, frameH / 2, 0.03, 0.02);
      addRBox(g, bedW + 0.06, hbH, hbD, 'woodOak', -0.18, hbH / 2, -d / 2 + hbD / 2, 0.02);
      addRBox(g, bedW - 0.08, hbH - 0.22, 0.055, 'fabricLinen', -0.18, hbH / 2 + 0.04, -d / 2 + hbD + 0.015, 0.025);

      const matW = bedW - 0.08, matD = d - hbD - 0.06, matH = 0.24, matY = frameH + matH / 2 - 0.02;
      addRBox(g, matW, matH, matD, 'beddingWhite', -0.18, matY, hbD / 2, 0.04);
      addRBox(g, matW + 0.03, matH + 0.03, matD * 0.64, 'beddingDuvet', -0.18, matY + 0.015, hbD / 2 + matD * 0.18, 0.04);
      addRBox(g, matW + 0.04, matH + 0.04, matD * 0.20, 'pillowMustard', -0.18, matY + 0.02, d / 2 - matD * 0.12, 0.025);

      for (const side of [-1, 1]) {
        const px = -0.18 + side * (matW * 0.24);
        addRBox(g, matW * 0.38, 0.13, 0.30, 'beddingWhite', px, matY + matH / 2 + 0.08, -d / 2 + hbD + 0.18, 0.035, 0.30, 0, 0);
      }

      // 1 Nightstand with lamp on right side (+X)
      const nx = -0.18 + bedW / 2 + 0.21, nz = -d / 2 + hbD + 0.19;
      addRBox(g, 0.36, 0.42, 0.34, 'woodOak', nx, 0.21, nz, 0.015);
      addCyl(g, 0.038, 0.05, 0.10, 'metalBrass', nx, 0.47, nz, 12);
      addCyl(g, 0.07, 0.095, 0.15, 'emissiveWarm', nx, 0.58, nz, 14);

      return finalizeAssetGroup(g, fullW, d);
    },

    // 16. bed_bunk_kids
    bed_bunk_kids() {
      const g = new THREE.Group();
      const bedW = 1.15, stairW = 0.44, fullW = bedW + stairW, d = 2.05, totalH = 1.72;
      const bx = -stairW / 2;

      // 4 Corner oak structural posts
      for (const [px, pz] of [[-bedW / 2 + 0.04, -d / 2 + 0.04], [bedW / 2 - 0.04, -d / 2 + 0.04], [-bedW / 2 + 0.04, d / 2 - 0.04], [bedW / 2 - 0.04, d / 2 - 0.04]]) {
        addBox(g, 0.065, totalH, 0.065, 'woodOak', bx + px, totalH / 2, pz);
      }

      // Lower & Upper bunks (Y = 0.28 and Y = 1.18)
      for (const [tierIdx, tierY] of [[0, 0.28], [1, 1.18]]) {
        addBox(g, bedW, 0.12, d, 'woodOak', bx, tierY, 0);
        addRBox(g, bedW - 0.08, 0.16, d - 0.10, 'beddingWhite', bx, tierY + 0.11, 0, 0.03);
        const duvetMat = tierIdx === 0 ? 'pillowNavy' : 'pillowSage';
        addRBox(g, bedW - 0.06, 0.17, d * 0.62, duvetMat, bx, tierY + 0.12, d * 0.16, 0.03);
        addRBox(g, 0.52, 0.11, 0.28, 'pillowMustard', bx, tierY + 0.22, -d / 2 + 0.24, 0.03, 0.25, 0, 0);
      }

      // Upper safety guardrail along front (+Z) & back (-Z)
      addBox(g, bedW - 0.04, 0.28, 0.03, 'woodOak', bx, 1.44, d / 2 - 0.03);
      addBox(g, bedW - 0.04, 0.28, 0.03, 'woodOak', bx, 1.44, -d / 2 + 0.03);

      // Integrated storage staircase boxes on right side (+X)
      const sx = bedW / 2 + stairW / 2 - 0.02;
      const steps = 4;
      const stepD = (d * 0.76) / steps;
      const stepH = 1.18 / steps;
      for (let i = 0; i < steps; i++) {
        const hBox = (i + 1) * stepH;
        const zBox = d / 2 - (i + 0.5) * stepD;
        addBox(g, stairW, hBox, stepD - 0.008, 'woodOak', sx, hBox / 2, zBox);
        addBox(g, stairW - 0.06, stepH - 0.05, 0.015, 'beddingWhite', sx, hBox - stepH / 2, zBox + stepD / 2 + 0.004);
      }

      return finalizeAssetGroup(g, fullW, d);
    },

    // 17. wardrobe_tall_glass
    wardrobe_tall_glass() {
      const g = new THREE.Group();
      const w = 1.85, d = 0.60, h = 2.30;
      addRBox(g, w, h, d - 0.03, 'woodWalnut', 0, h / 2, -0.015, 0.015);
      // Warm interior LED light bar & shelves visible through fluted glass
      addBox(g, w - 0.12, 0.025, d * 0.5, 'emissiveWarm', 0, h - 0.10, 0);
      for (const sy of [0.65, 1.18, 1.72]) {
        addBox(g, w - 0.08, 0.025, d - 0.10, 'woodOak', 0, sy, -0.02);
      }
      // 4 Framed tinted fluted-glass doors + long matte-black handles
      const numDoors = 4, doorW = (w - 0.04) / numDoors, doorH = h - 0.10;
      for (let i = 0; i < numDoors; i++) {
        const dx = -w / 2 + 0.02 + (i + 0.5) * doorW;
        addBox(g, doorW - 0.012, doorH, 0.022, 'metalBlack', dx, h / 2, d / 2 - 0.01);
        addBox(g, doorW - 0.06, doorH - 0.08, 0.026, 'glassFluted', dx, h / 2, d / 2 - 0.008);
        const hOff = (i % 2 === 0) ? doorW * 0.36 : -doorW * 0.36;
        addBox(g, 0.016, doorH * 0.46, 0.03, 'metalBrass', dx + hOff, h * 0.5, d / 2 + 0.012);
      }

      return finalizeAssetGroup(g, w, d);
    },

    // 18. work_desk_computer
    work_desk_computer() {
      const g = new THREE.Group();
      const w = 1.40, d = 1.10, deskD = 0.66, deskH = 0.75, deskZ = -0.18;
      // Oak tabletop + left metal frame + right 3-drawer walnut pedestal
      addRBox(g, w, 0.035, deskD, 'woodOak', 0, deskH - 0.017, deskZ, 0.015);
      addBox(g, 0.04, deskH - 0.035, deskD - 0.06, 'metalBlack', -w / 2 + 0.05, (deskH - 0.035) / 2, deskZ);
      const pedW = 0.40;
      addRBox(g, pedW, deskH - 0.035, deskD - 0.04, 'woodWalnut', w / 2 - pedW / 2 - 0.03, (deskH - 0.035) / 2, deskZ, 0.012);

      // Widescreen computer monitor + keyboard + books + desk lamp
      addCyl(g, 0.018, 0.065, 0.12, 'metalChrome', -0.12, deskH + 0.06, deskZ - 0.16, 10);
      addBox(g, 0.58, 0.34, 0.018, 'metalBlack', -0.12, deskH + 0.27, deskZ - 0.14);
      addBox(g, 0.55, 0.31, 0.008, 'tvScreen', -0.12, deskH + 0.27, deskZ - 0.128);
      addRBox(g, 0.32, 0.012, 0.11, 'metalBlack', -0.12, deskH + 0.006, deskZ + 0.08, 0.004);

      addCyl(g, 0.055, 0.065, 0.02, 'metalBrass', 0.42, deskH + 0.01, deskZ - 0.14, 12);
      addCyl(g, 0.008, 0.008, 0.34, 'metalBrass', 0.42, deskH + 0.17, deskZ - 0.10, 8, 0.25, 0, 0);
      addCyl(g, 0.03, 0.06, 0.10, 'emissiveWarm', 0.42, deskH + 0.32, deskZ - 0.04, 12);

      // Overhead wall shelf at -Z
      addRBox(g, w * 0.86, 0.03, 0.24, 'woodOak', 0, 1.48, -d / 2 + 0.12, 0.008);
      addRBox(g, 0.16, 0.20, 0.16, 'pillowTerra', -0.32, 1.59, -d / 2 + 0.12, 0.006);

      // Ergonomic 5-star swivel chair in front (+Z) facing desk (-Z)
      const cx = -0.12, cz = 0.26;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        addBox(g, 0.025, 0.02, 0.26, 'metalBlack', cx + Math.sin(a) * 0.12, 0.03, cz + Math.cos(a) * 0.12, 0, a, 0);
      }
      addCyl(g, 0.022, 0.022, 0.40, 'metalBlack', cx, 0.22, cz, 8);
      addRBox(g, 0.46, 0.06, 0.44, 'fabricCharcoal', cx, 0.44, cz, 0.02);
      addRBox(g, 0.44, 0.48, 0.045, 'fabricCharcoal', cx, 0.70, cz + 0.20, 0.02, 0.12, 0, 0);

      return finalizeAssetGroup(g, w, d);
    },

    // 19. dressing_table_mirror
    dressing_table_mirror() {
      const g = new THREE.Group();
      const w = 1.10, d = 0.82, tabD = 0.46, tabH = 0.76, tabZ = -0.16;
      // Vanity dressing console with drawers + tapered brass legs
      addRBox(g, w, 0.14, tabD, 'woodOak', 0, tabH - 0.07, tabZ, 0.015);
      addRBox(g, w - 0.02, 0.02, tabD - 0.02, 'marbleCarrara', 0, tabH + 0.01, tabZ, 0.01);
      for (const [lx, lz] of [[-w / 2 + 0.07, tabZ - tabD / 2 + 0.06], [w / 2 - 0.07, tabZ - tabD / 2 + 0.06], [-w / 2 + 0.07, tabZ + tabD / 2 - 0.06], [w / 2 - 0.07, tabZ + tabD / 2 - 0.06]]) {
        addCyl(g, 0.018, 0.011, tabH - 0.14, 'metalBrass', lx, (tabH - 0.14) / 2, lz, 10);
      }

      // Round LED backlit mirror
      const mirR = 0.34, mirY = tabH + 0.08 + mirR;
      addCyl(g, mirR + 0.028, mirR + 0.028, 0.018, 'emissiveWarm', 0, mirY, tabZ - tabD / 2 + 0.04, 28, Math.PI / 2, 0, 0);
      addCyl(g, mirR, mirR, 0.024, 'mirrorSurface', 0, mirY, tabZ - tabD / 2 + 0.048, 28, Math.PI / 2, 0, 0);

      // Cosmetics organizer bottles
      addCyl(g, 0.022, 0.022, 0.09, 'metalBrass', 0.28, tabH + 0.065, tabZ - 0.06, 10);
      addCyl(g, 0.018, 0.024, 0.07, 'ceramicVase', 0.34, tabH + 0.055, tabZ - 0.04, 10);

      // Upholstered round pouf stool
      addCyl(g, 0.21, 0.19, 0.42, 'fabricVelvet', 0, 0.21, 0.20, 20);
      addCyl(g, 0.195, 0.195, 0.04, 'metalBrass', 0, 0.02, 0.20, 20);

      return finalizeAssetGroup(g, w, d);
    }
  };
}

function buildWorshipAndRooftopAssets() {
  return {
    // 20. vietnamese_worship_altar
    vietnamese_worship_altar() {
      const g = new THREE.Group();
      const w = 1.75, d = 0.92, altarH = 1.27;
      // 4 Carved mahogany posts (Chân quỳ dạ cá) + brass lotus feet
      const lx = w / 2 - 0.09, lz = d / 2 - 0.09;
      for (const [ox, oz] of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]]) {
        addCyl(g, 0.052, 0.046, altarH, 'woodMahogany', ox, altarH / 2, oz, 12);
        addCyl(g, 0.060, 0.068, 0.06, 'metalBrass', ox, 0.03, oz, 12);
      }

      // Altar tabletop with upturned ceremonial scroll ends (Tai cuốn) & carved apron (Dạ cá)
      addRBox(g, w + 0.06, 0.055, d + 0.04, 'woodMahogany', 0, altarH - 0.025, 0, 0.015);
      for (const side of [-1, 1]) {
        addCyl(g, 0.035, 0.035, d + 0.04, 'woodMahogany', side * (w / 2 + 0.04), altarH + 0.01, 0, 12, Math.PI / 2, 0, 0);
      }
      addRBox(g, w - 0.14, 0.24, 0.04, 'woodMahogany', 0, altarH - 0.18, d / 2 - 0.07, 0.01);
      addBox(g, w * 0.56, 0.09, 0.048, 'metalBrass', 0, altarH - 0.18, d / 2 - 0.07);

      // Lower companion offering table (Bàn cơm) underneath
      const subH = 0.56;
      addRBox(g, w * 0.56, 0.035, d * 0.66, 'woodMahogany', 0, subH, 0.05, 0.01);
      for (const [sx, sz] of [[-w * 0.24, -d * 0.24], [w * 0.24, -d * 0.24], [-w * 0.24, d * 0.34], [w * 0.24, d * 0.34]]) {
        addBox(g, 0.035, subH, 0.035, 'woodMahogany', sx, subH / 2, sz);
      }

      // Stepped upper offering shelf (Nhị cấp) + Brass incense burner + 2 candlesticks + 2 lotus vases
      const stepH = 0.14;
      addRBox(g, w * 0.82, stepH, d * 0.38, 'woodMahogany', 0, altarH + stepH / 2, -d * 0.24, 0.012);
      addCyl(g, 0.085, 0.07, 0.13, 'metalBrass', 0, altarH + 0.065, 0.08, 16);
      addCyl(g, 0.15, 0.09, 0.05, 'ceramicVase', 0, altarH + 0.025, 0.26, 16);

      for (const side of [-1, 1]) {
        addCyl(g, 0.018, 0.055, 0.28, 'metalBrass', side * (w * 0.22), altarH + 0.14, 0.06, 12);
        addSphere(g, 0.022, 'emissiveWarm', side * (w * 0.22), altarH + 0.30, 0.06);
        addCyl(g, 0.05, 0.075, 0.32, 'ceramicVase', side * (w * 0.32), altarH + stepH + 0.16, -d * 0.24, 14);
        addSphere(g, 0.065, 'pillowTerra', side * (w * 0.32), altarH + stepH + 0.35, -d * 0.24, 0.9, 1.3, 0.9);
      }

      // Glowing golden Trúc Chỉ mandala medallion on back panel (-Z)
      const medR = 0.48, medY = altarH + stepH + medR + 0.10;
      addCyl(g, medR + 0.04, medR + 0.04, 0.024, 'woodMahogany', 0, medY, -d / 2 + 0.015, 32, Math.PI / 2, 0, 0);
      addCyl(g, medR, medR, 0.032, 'emissiveGoldMandala', 0, medY, -d / 2 + 0.022, 32, Math.PI / 2, 0, 0);

      return finalizeAssetGroup(g, w, d);
    },

    // 21. outdoor_bbq_station
    outdoor_bbq_station() {
      const g = new THREE.Group();
      const w = 1.85, d = 0.68, cabH = 0.88;
      addRBox(g, w, cabH, d, 'metalBlack', 0, cabH / 2, 0, 0.015);
      addRBox(g, w + 0.03, 0.035, d + 0.03, 'marbleCarrara', 0, cabH + 0.017, 0, 0.01);

      // Stainless steel BBQ grill hood in center + prep sink on left
      addRBox(g, 0.82, 0.30, d * 0.78, 'stainlessSteel', 0.24, cabH + 0.17, -0.02, 0.035);
      addCyl(g, 0.012, 0.012, 0.66, 'metalChrome', 0.24, cabH + 0.16, d * 0.39, 10, 0, 0, Math.PI / 2);
      addBox(g, 0.44, 0.014, 0.38, 'stainlessSteel', -0.52, cabH + 0.038, 0);
      addCyl(g, 0.012, 0.015, 0.20, 'metalChrome', -0.52, cabH + 0.14, -0.16, 10);

      // Storage doors + handles
      for (const dx of [-0.58, 0, 0.58]) {
        addBox(g, 0.52, cabH - 0.14, 0.016, 'stainlessSteel', dx, cabH / 2, d / 2 + 0.005);
        addBox(g, 0.22, 0.014, 0.025, 'metalChrome', dx, cabH - 0.14, d / 2 + 0.018);
      }

      return finalizeAssetGroup(g, w, d);
    },

    // 22. outdoor_patio_set
    outdoor_patio_set() {
      const g = new THREE.Group();
      const w = 1.95, d = 1.95, tabH = 0.74;
      // Round outdoor table + central sun umbrella
      addCyl(g, 0.56, 0.56, 0.032, 'woodOak', 0, tabH, 0, 24);
      addCyl(g, 0.04, 0.05, tabH, 'metalBlack', 0, tabH / 2, 0, 12);
      addCyl(g, 0.32, 0.34, 0.025, 'metalBlack', 0, 0.013, 0, 20);

      // Sun umbrella pole & canopy
      addCyl(g, 0.022, 0.022, 2.25, 'metalBlack', 0, 1.125, 0, 10);
      addCyl(g, 0.04, 1.05, 0.38, 'fabricLinen', 0, 2.15, 0, 16);

      // 4 Woven patio chairs around table
      for (const [cx, cz, ry] of [[0, -0.74, 0], [0, 0.74, Math.PI], [-0.74, 0, Math.PI / 2], [0.74, 0, -Math.PI / 2]]) {
        createDiningChair(g, cx, cz, ry);
      }

      return finalizeAssetGroup(g, w, d);
    }
  };
}

function buildBathroomAndLaundryAssets() {
  return {
    // 23. toilet_onepiece
    toilet_onepiece() {
      const g = new THREE.Group();
      const w = 0.42, d = 0.68;
      // Curved pedestal & bowl
      const ped = addCyl(g, w * 0.42, w * 0.36, 0.24, 'ceramicWhite', 0, 0.12, d * 0.06, 18);
      ped.scale.set(1, 1, 1.35);
      const bowl = addSphere(g, w * 0.48, 'ceramicWhite', 0, 0.36, d * 0.10, 1, 0.85, 1.35);
      const lid = addCyl(g, w * 0.47, w * 0.47, 0.032, 'ceramicWhite', 0, 0.41, d * 0.10, 18);
      lid.scale.set(1, 1, 1.35);
      // Rear cistern tank at -Z + dual-flush chrome button
      const tankH = 0.38;
      addRBox(g, w * 0.96, tankH, d * 0.34, 'ceramicWhite', 0, 0.38 + tankH / 2, -d * 0.32, 0.035);
      addCyl(g, 0.028, 0.028, 0.015, 'metalChrome', 0, 0.38 + tankH + 0.006, -d * 0.32, 12);

      return finalizeAssetGroup(g, w, d);
    },

    // 24. lavabo_vanity_led_mirror
    lavabo_vanity_led_mirror() {
      const g = new THREE.Group();
      const w = 0.96, d = 0.54, vanH = 0.85, cabH = 0.50;
      const cabY = vanH - 0.03 - cabH / 2;
      addRBox(g, w, cabH, d, 'woodWalnut', 0, cabY, 0, 0.015);
      addBox(g, w * 0.46, 0.015, 0.025, 'metalBrass', 0, cabY + 0.12, d / 2 + 0.012);
      // Towel bar on front
      addCyl(g, 0.008, 0.008, w * 0.62, 'metalChrome', 0, cabY - 0.12, d / 2 + 0.035, 10, 0, 0, Math.PI / 2);

      // Carrara marble counter + oval ceramic vessel basin + chrome mixer tap
      addRBox(g, w + 0.02, 0.035, d + 0.02, 'marbleCarrara', 0, vanH - 0.017, 0, 0.01);
      const vessel = addCyl(g, 0.21, 0.16, 0.13, 'ceramicWhite', 0, vanH + 0.06, 0.02, 20);
      vessel.scale.set(1.25, 1, 0.9);
      addCyl(g, 0.014, 0.018, 0.21, 'metalChrome', 0, vanH + 0.10, -d * 0.30, 10);
      addBox(g, 0.018, 0.016, 0.12, 'metalChrome', 0, vanH + 0.19, -d * 0.24);

      // LED backlit wall mirror at -Z
      const mirW = w * 0.82, mirH = 0.88, mirY = vanH + 0.26 + mirH / 2;
      addRBox(g, mirW + 0.05, mirH + 0.05, 0.015, 'emissiveWarm', 0, mirY, -d / 2 + 0.012, 0.08);
      addRBox(g, mirW, mirH, 0.018, 'mirrorSurface', 0, mirY, -d / 2 + 0.024, 0.07);

      return finalizeAssetGroup(g, w, d);
    },

    // 25. shower_glass_enclosure
    shower_glass_enclosure() {
      const g = new THREE.Group();
      const w = 1.05, d = 1.05, h = 2.05;
      // Non-slip stone shower tray + chrome drain
      addRBox(g, w, 0.06, d, 'marbleCarrara', 0, 0.03, 0, 0.01);
      addBox(g, 0.14, 0.008, 0.14, 'metalChrome', 0, 0.062, 0);

      // Black aluminum profile frame + tempered glass partition panels
      addBox(g, w, 0.03, 0.03, 'metalBlack', 0, h - 0.015, d / 2 - 0.015);
      addBox(g, 0.03, h, 0.03, 'metalBlack', -w / 2 + 0.015, h / 2, d / 2 - 0.015);
      addBox(g, 0.03, h, 0.03, 'metalBlack', w / 2 - 0.015, h / 2, d / 2 - 0.015);
      addBox(g, w - 0.04, h - 0.08, 0.014, 'glassClear', 0, h / 2 + 0.02, d / 2 - 0.015);
      addCyl(g, 0.01, 0.01, 0.42, 'metalBlack', 0.18, 1.05, d / 2 + 0.015, 8);

      // Chrome rainfall shower column & handheld mixer at back wall (-Z)
      addCyl(g, 0.012, 0.012, 1.15, 'metalChrome', 0, 1.35, -d / 2 + 0.06, 10);
      addBox(g, 0.24, 0.04, 0.08, 'metalChrome', 0, 1.05, -d / 2 + 0.08);
      addBox(g, 0.025, 0.025, 0.34, 'metalChrome', 0, 1.92, -d / 2 + 0.22);
      addCyl(g, 0.13, 0.13, 0.018, 'metalChrome', 0, 1.89, -d / 2 + 0.36, 18);

      return finalizeAssetGroup(g, w, d);
    },

    // 26. bathtub_modern
    bathtub_modern() {
      const g = new THREE.Group();
      const w = 1.70, d = 0.80, tubH = 0.58;
      const rx = w / 2 - 0.02, rz = d / 2 - 0.02;

      const outerTub = addCyl(g, 1.0, 0.86, tubH, 'ceramicWhite', 0, tubH / 2, 0, 28);
      outerTub.scale.set(rx, 1, rz);
      const water = addCyl(g, 0.88, 0.82, 0.04, 'waterBlue', 0, tubH * 0.70, 0, 24);
      water.scale.set(rx, 1, rz);

      // Oak bath caddy across tub
      addRBox(g, 0.24, 0.024, d * 0.96, 'woodOak', 0.14, tubH + 0.012, 0, 0.006);
      // Floor-mounted chrome filler tap at back (-Z)
      addCyl(g, 0.018, 0.024, tubH + 0.24, 'metalChrome', 0, (tubH + 0.24) / 2, -d / 2 + 0.06, 12);
      addBox(g, 0.022, 0.02, 0.16, 'metalChrome', 0, tubH + 0.22, -d / 2 + 0.13);

      return finalizeAssetGroup(g, w, d);
    },

    // 27. washer_dryer_tower
    washer_dryer_tower() {
      const g = new THREE.Group();
      const w = 0.66, d = 0.68, unitH = 0.86;
      // Lower washing machine + Upper heat-pump dryer
      for (const [idx, yBase] of [[0, 0], [1, unitH + 0.02]]) {
        const cy = yBase + unitH / 2;
        addRBox(g, w, unitH, d - 0.04, 'ceramicWhite', 0, cy, -0.02, 0.02);
        // Control panel strip & rotary dial
        addBox(g, w - 0.04, 0.11, 0.02, 'stainlessSteel', 0, yBase + unitH - 0.08, d / 2 - 0.03);
        addCyl(g, 0.028, 0.028, 0.025, 'metalChrome', 0, yBase + unitH - 0.08, d / 2 - 0.015, 14, Math.PI / 2, 0, 0);
        addBox(g, 0.14, 0.045, 0.022, 'tvScreen', 0.14, yBase + unitH - 0.08, d / 2 - 0.018);

        // Front glass porthole drum door
        const drumY = yBase + unitH * 0.44;
        addCyl(g, 0.23, 0.23, 0.035, 'metalBlack', 0, drumY, d / 2 - 0.02, 24, Math.PI / 2, 0, 0);
        addCyl(g, 0.18, 0.18, 0.042, 'glassClear', 0, drumY, d / 2 - 0.018, 24, Math.PI / 2, 0, 0);
        if (idx === 0) {
          addBox(g, w, 0.02, d - 0.02, 'stainlessSteel', 0, unitH + 0.01, -0.01);
        }
      }

      return finalizeAssetGroup(g, w, d);
    }
  };
}

function buildGreeneryAndArchitecturalAssets() {
  return {
    // 28. balcony_planter_greenery
    balcony_planter_greenery() {
      const g = new THREE.Group();
      const w = 1.20, d = 0.36, potH = 0.36;
      addRBox(g, w, potH, d, 'terracottaPot', 0, potH / 2, 0, 0.02);
      addBox(g, w - 0.06, 0.04, d - 0.06, 'soilDark', 0, potH - 0.01, 0);

      // Multi-layered lush bushes & trailing foliage clusters
      const clusters = [
        [-0.42, potH + 0.18, 0, 0.19, 'foliageDark'],
        [-0.18, potH + 0.24, 0.03, 0.22, 'foliageLight'],
        [0.08, potH + 0.21, -0.02, 0.21, 'foliageDark'],
        [0.36, potH + 0.23, 0.02, 0.20, 'foliageLight'],
        [-0.30, potH + 0.08, 0.14, 0.13, 'foliageLight'],
        [0.22, potH + 0.07, 0.15, 0.14, 'foliageDark']
      ];
      for (const [cx, cy, cz, r, mat] of clusters) {
        addSphere(g, r, mat, cx, cy, cz, 1.15, 0.95, 1.0);
      }

      return finalizeAssetGroup(g, w, d);
    },

    // 29. indoor_potted_ficus
    indoor_potted_ficus() {
      const g = new THREE.Group();
      const w = 0.65, d = 0.65, potH = 0.42;
      addCyl(g, 0.21, 0.16, potH, 'ceramicVase', 0, potH / 2, 0, 18);
      addCyl(g, 0.19, 0.19, 0.02, 'soilDark', 0, potH - 0.01, 0, 16);

      // Multi-branched wooden trunk + layered Ficus canopy
      addCyl(g, 0.028, 0.045, 0.78, 'woodWalnut', 0, potH + 0.36, 0, 10);
      addCyl(g, 0.018, 0.026, 0.38, 'woodWalnut', -0.10, potH + 0.62, 0.04, 8, 0.2, 0, 0.45);
      addCyl(g, 0.018, 0.026, 0.38, 'woodWalnut', 0.11, potH + 0.66, -0.04, 8, -0.2, 0, -0.42);

      addSphere(g, 0.24, 'foliageDark', 0, potH + 0.88, 0, 1.1, 0.85, 1.1);
      addSphere(g, 0.19, 'foliageLight', -0.16, potH + 0.74, 0.08, 1.1, 0.8, 1.0);
      addSphere(g, 0.20, 'foliageDark', 0.17, potH + 0.78, -0.06, 1.05, 0.85, 1.05);
      addSphere(g, 0.16, 'foliageLight', 0.04, potH + 1.06, 0.04, 1.0, 0.85, 1.0);

      return finalizeAssetGroup(g, w, d);
    },

    // 30. railing_iron_baluster
    railing_iron_baluster() {
      const g = new THREE.Group();
      const w = 1.00, d = 0.08, h = 1.05;
      addRBox(g, w, 0.045, 0.065, 'woodWalnut', 0, h - 0.022, 0, 0.012);
      addBox(g, w, 0.035, 0.045, 'metalBlack', 0, 0.07, 0);
      addBox(g, 0.045, h, 0.045, 'metalBlack', -w / 2 + 0.022, h / 2, 0);
      addBox(g, 0.045, h, 0.045, 'metalBlack', w / 2 - 0.022, h / 2, 0);

      // Vertical iron balusters spaced every 0.10m
      for (let i = 1; i < 10; i++) {
        const bx = -w / 2 + i * 0.10;
        addCyl(g, 0.008, 0.008, h - 0.11, 'metalBlack', bx, h / 2 + 0.01, 0, 8);
      }

      return finalizeAssetGroup(g, w, d);
    },

    // 31. door_interior_wood
    door_interior_wood() {
      const g = new THREE.Group();
      const w = 0.92, d = 0.22, h = 2.20, jambW = 0.055;
      addBox(g, jambW, h, d, 'woodWalnut', -w / 2 + jambW / 2, h / 2, 0);
      addBox(g, jambW, h, d, 'woodWalnut', w / 2 - jambW / 2, h / 2, 0);
      addBox(g, w + 0.04, jambW * 1.2, d + 0.01, 'woodWalnut', 0, h - jambW * 0.4, 0);

      // Recessed-panel oak door leaf + brass lever handles on both sides
      const leafW = w - jambW * 2, leafH = h - jambW - 0.01, leafT = 0.045;
      addRBox(g, leafW, leafH, leafT, 'woodOak', 0, leafH / 2 + 0.005, 0, 0.008);
      addBox(g, leafW - 0.16, leafH * 0.46, leafT + 0.012, 'woodWalnut', 0, leafH * 0.68, 0);
      addBox(g, leafW - 0.16, leafH * 0.28, leafT + 0.012, 'woodWalnut', 0, leafH * 0.24, 0);

      const hx = leafW / 2 - 0.08, hy = 1.02;
      addBox(g, 0.035, 0.14, leafT + 0.03, 'metalBrass', hx, hy, 0);
      addBox(g, 0.11, 0.018, 0.02, 'metalBrass', hx - 0.035, hy, leafT / 2 + 0.025);
      addBox(g, 0.11, 0.018, 0.02, 'metalBrass', hx - 0.035, hy, -leafT / 2 - 0.025);

      return finalizeAssetGroup(g, w, d);
    },

    // 32. door_balcony_glass
    door_balcony_glass() {
      const g = new THREE.Group();
      const w = 1.60, d = 0.22, h = 2.25, barT = 0.055;
      addBox(g, w, barT, d, 'metalBlack', 0, h - barT / 2, 0);
      addBox(g, w, barT, d, 'metalBlack', 0, barT / 2, 0);
      addBox(g, barT, h, d, 'metalBlack', -w / 2 + barT / 2, h / 2, 0);
      addBox(g, barT, h, d, 'metalBlack', w / 2 - barT / 2, h / 2, 0);
      // Central sliding stile & clear reflective glass panes
      addBox(g, 0.05, h - barT * 2, d * 0.65, 'metalBlack', 0, h / 2, 0);
      addBox(g, w - barT * 2, h - barT * 2, 0.024, 'glassClear', 0, h / 2, 0);
      addBox(g, 0.02, 0.28, d * 0.85, 'metalChrome', 0.06, 1.05, 0);

      return finalizeAssetGroup(g, w, d);
    },

    // 33. window_casement_glass
    window_casement_glass() {
      const g = new THREE.Group();
      const w = 1.40, d = 0.22, h = 1.50, barT = 0.055;
      // Projecting Carrara marble sill at bottom
      addRBox(g, w + 0.08, 0.04, d + 0.06, 'marbleCarrara', 0, 0.02, 0, 0.008);
      addBox(g, w, barT, d, 'metalBlack', 0, h - barT / 2, 0);
      addBox(g, w, barT, d, 'metalBlack', 0, 0.04 + barT / 2, 0);
      addBox(g, barT, h - 0.04, d, 'metalBlack', -w / 2 + barT / 2, 0.02 + h / 2, 0);
      addBox(g, barT, h - 0.04, d, 'metalBlack', w / 2 - barT / 2, 0.02 + h / 2, 0);
      // Center vertical mullion + upper transom + reflective glass
      addBox(g, 0.038, h - barT * 2 - 0.04, d * 0.72, 'metalBlack', 0, 0.02 + h / 2, 0);
      addBox(g, w - barT * 2, 0.032, d * 0.70, 'metalBlack', 0, h * 0.72, 0);
      addBox(g, w - barT * 2, h - barT * 2 - 0.04, 0.024, 'glassClear', 0, 0.02 + h / 2, 0);

      return finalizeAssetGroup(g, w, d);
    },

    // 34. stair_flight_straight
    stair_flight_straight() {
      const g = new THREE.Group();
      const w = 1.05, d = 2.80, rise = 3.20, steps = 16;
      const stepH = rise / steps, stepD = d / steps, treadT = 0.038;

      for (let i = 0; i < steps; i++) {
        const y = (i + 1) * stepH;
        const z = -d / 2 + (i + 0.5) * stepD;
        addBox(g, w, treadT, stepD + 0.02, 'woodOak', 0, y - treadT / 2, z);
        addBox(g, w - 0.02, stepH, 0.018, 'stairRiserWhite', 0, y - stepH / 2, z - stepD / 2);
        // Iron balusters on right edge every step
        addCyl(g, 0.008, 0.008, 0.90, 'metalBlack', w / 2 - 0.03, y + 0.45, z, 6);
      }

      // Angled structural stringer beam underneath + continuous sloped handrail
      const len = Math.hypot(d, rise);
      const ang = Math.atan2(rise, d);
      addBox(g, 0.10, 0.18, len, 'concreteStructural', 0, rise / 2 - 0.09, 0, -ang, 0, 0);
      addBox(g, 0.045, 0.045, len + 0.10, 'woodWalnut', w / 2 - 0.03, rise / 2 + 0.90, 0, -ang, 0, 0);

      return finalizeAssetGroup(g, w, d);
    },

    // 35. stair_flight_u_turn
    stair_flight_u_turn() {
      const g = new THREE.Group();
      const w = 2.20, d = 2.80, rise = 3.60, totalSteps = 20, halfSteps = 10;
      const landingD = 0.92, flightRun = d - landingD;
      const stepH = rise / totalSteps, stepD = flightRun / halfSteps;
      const flightW = (w - 0.14) / 2, treadT = 0.038;
      const f1X = -w / 4 - 0.02, f2X = w / 4 + 0.02;
      const startZ = -d / 2, midY = halfSteps * stepH;

      for (let i = 0; i < halfSteps; i++) {
        const y1 = (i + 1) * stepH;
        const z1 = startZ + (i + 0.5) * stepD;
        addBox(g, flightW, treadT, stepD + 0.02, 'woodOak', f1X, y1 - treadT / 2, z1);
        addBox(g, flightW - 0.01, stepH, 0.018, 'stairRiserWhite', f1X, y1 - stepH / 2, z1 - stepD / 2);
        addCyl(g, 0.008, 0.008, 0.90, 'metalBlack', f1X + flightW / 2 - 0.03, y1 + 0.45, z1, 6);

        const y2 = midY + (i + 1) * stepH;
        const z2 = (d / 2 - landingD) - (i + 0.5) * stepD;
        addBox(g, flightW, treadT, stepD + 0.02, 'woodOak', f2X, y2 - treadT / 2, z2);
        addBox(g, flightW - 0.01, stepH, 0.018, 'stairRiserWhite', f2X, y2 - stepH / 2, z2 + stepD / 2);
        addCyl(g, 0.008, 0.008, 0.90, 'metalBlack', f2X - flightW / 2 + 0.03, y2 + 0.45, z2, 6);
      }

      const fLen = Math.hypot(flightRun, midY);
      const fAng = Math.atan2(midY, flightRun);
      addBox(g, 0.08, 0.18, fLen, 'concreteStructural', f1X, midY / 2 - 0.09, startZ + flightRun / 2, -fAng, 0, 0);
      addBox(g, 0.08, 0.18, fLen, 'concreteStructural', f2X, midY * 1.5 - 0.09, startZ + flightRun / 2, fAng, 0, 0);

      // Mid-landing platform
      const landZ = d / 2 - landingD / 2;
      addBox(g, w, 0.16, landingD, 'concreteStructural', 0, midY - 0.08, landZ);
      addBox(g, w, treadT, landingD, 'woodOak', 0, midY - treadT / 2, landZ);

      // Sloped handrails
      addBox(g, 0.042, 0.042, fLen + 0.12, 'woodWalnut', f1X + flightW / 2 - 0.03, midY / 2 + 0.90, startZ + flightRun / 2, -fAng, 0, 0);
      addBox(g, 0.042, 0.042, fLen + 0.12, 'woodWalnut', f2X - flightW / 2 + 0.03, midY * 1.5 + 0.90, startZ + flightRun / 2, fAng, 0, 0);

      return finalizeAssetGroup(g, w, d);
    }
  };
}

// ============================================================================
// 6. CATALOG DEFINITIONS, EXPORT & GLTFLOADER.PARSE VERIFICATION
// ============================================================================

const ASSET_CATALOG_SPECS = [
  // 1. Living Room (7)
  { id: 'sofa_l_modern', category: 'living_room', name: 'Sofa góc chữ L hiện đại', legacyTypes: ['sofa_sectional', 'sofa'], width: 2.65, depth: 1.65, height: 0.85 },
  { id: 'sofa_straight_3seat', category: 'living_room', name: 'Sofa văng 3 chỗ', legacyTypes: ['sofa_3seat'], width: 2.20, depth: 0.92, height: 0.84 },
  { id: 'armchair_lounge', category: 'living_room', name: 'Ghế bành thư giãn', legacyTypes: ['armchair', 'chair'], width: 0.84, depth: 0.82, height: 0.78 },
  { id: 'coffee_table_set', category: 'living_room', name: 'Bàn trà đôi mặt đá Carrara', legacyTypes: ['coffee_table'], width: 1.28, depth: 0.72, height: 0.48 },
  { id: 'tv_cabinet_wall_unit', category: 'living_room', name: 'Kệ TV & vách lam gỗ OLED 75"', legacyTypes: ['tv_console'], width: 2.20, depth: 0.46, height: 2.10 },
  { id: 'entrance_shoe_cabinet', category: 'living_room', name: 'Tủ giày sảnh & ghế đôn thay giày', legacyTypes: ['shoe_cabinet'], width: 1.40, depth: 0.38, height: 1.15 },
  { id: 'floor_rug_textured', category: 'living_room', name: 'Thảm dệt trang trí phòng khách', legacyTypes: ['rug'], width: 2.60, depth: 1.80, height: 0.008 },

  // 2. Kitchen & Dining (6)
  { id: 'kitchen_system_i', category: 'kitchen_dining', name: 'Hệ tủ bếp chữ I mặt đá Carrara', legacyTypes: ['kitchen_i'], width: 2.80, depth: 0.65, height: 2.12 },
  { id: 'kitchen_system_l', category: 'kitchen_dining', name: 'Hệ tủ bếp góc chữ L cao cấp', legacyTypes: ['kitchen_cabinet', 'kitchen_l'], width: 2.60, depth: 1.85, height: 2.10 },
  { id: 'kitchen_island_bar', category: 'kitchen_dining', name: 'Bàn đảo bếp đá cẩm thạch & 3 ghế bar', legacyTypes: ['kitchen_island'], width: 1.85, depth: 0.96, height: 0.90 },
  { id: 'fridge_double_door', category: 'kitchen_dining', name: 'Tủ lạnh Side-by-Side 2 cánh Inox', legacyTypes: ['fridge'], width: 0.92, depth: 0.76, height: 1.88 },
  { id: 'dining_table_6chairs', category: 'kitchen_dining', name: 'Bộ bàn ăn 6 ghế bọc nệm', legacyTypes: ['dining_table'], width: 1.95, depth: 1.38, height: 0.82 },
  { id: 'dining_table_4chairs', category: 'kitchen_dining', name: 'Bộ bàn ăn 4 ghế hiện đại', legacyTypes: ['dining_table_small'], width: 1.45, depth: 1.32, height: 0.82 },

  // 3. Bedrooms (6)
  { id: 'bed_master_king', category: 'bedroom', name: 'Giường ngủ Master King & 2 Tab đầu giường', legacyTypes: ['bed_master', 'bed'], width: 2.65, depth: 2.15, height: 1.18 },
  { id: 'bed_queen_modern', category: 'bedroom', name: 'Giường ngủ Queen gỗ sồi hiện đại', legacyTypes: ['bed_queen'], width: 2.04, depth: 2.05, height: 1.05 },
  { id: 'bed_bunk_kids', category: 'bedroom', name: 'Giường tầng trẻ em có bậc cầu thang hộp', legacyTypes: ['bed_bunk'], width: 1.59, depth: 2.05, height: 1.72 },
  { id: 'wardrobe_tall_glass', category: 'bedroom', name: 'Tủ quần áo kịch trần cánh kính sọc', legacyTypes: ['wardrobe'], width: 1.85, depth: 0.60, height: 2.30 },
  { id: 'work_desk_computer', category: 'bedroom', name: 'Bàn làm việc, màn hình máy tính & ghế xoay', legacyTypes: ['desk'], width: 1.40, depth: 1.10, height: 1.68 },
  { id: 'dressing_table_mirror', category: 'bedroom', name: 'Bàn trang điểm gương tròn LED & ghế đôn', legacyTypes: ['dressing_table', 'nightstand', 'chair_or_nightstand'], width: 1.10, depth: 0.82, height: 1.52 },

  // 4. Worship & Rooftop (3)
  { id: 'vietnamese_worship_altar', category: 'worship_rooftop', name: 'Án gian thờ gỗ gụ, bàn cơm & Trúc chỉ', legacyTypes: ['altar_table'], width: 1.75, depth: 0.92, height: 1.98 },
  { id: 'outdoor_bbq_station', category: 'worship_rooftop', name: 'Quầy nướng BBQ sân thượng Inox & mặt đá', legacyTypes: ['bbq'], width: 1.85, depth: 0.68, height: 1.18 },
  { id: 'outdoor_patio_set', category: 'worship_rooftop', name: 'Bộ bàn trà sân thượng 4 ghế & dù che nắng', legacyTypes: ['patio_set', 'gym_machine'], width: 1.95, depth: 1.95, height: 2.34 },

  // 5. Bathroom & Laundry (5)
  { id: 'toilet_onepiece', category: 'bathroom_laundry', name: 'Bồn cầu liền khối men sứ trắng', legacyTypes: ['toilet'], width: 0.42, depth: 0.68, height: 0.76 },
  { id: 'lavabo_vanity_led_mirror', category: 'bathroom_laundry', name: 'Tủ Lavabo treo tường mặt đá & gương LED', legacyTypes: ['vanity'], width: 0.96, depth: 0.54, height: 1.99 },
  { id: 'shower_glass_enclosure', category: 'bathroom_laundry', name: 'Vách kính tắm đứng & sen cây tắm mưa', legacyTypes: ['shower'], width: 1.05, depth: 1.05, height: 2.05 },
  { id: 'bathtub_modern', category: 'bathroom_laundry', name: 'Bồn tắm nằm độc lập & vòi sàn Chrome', legacyTypes: ['bathtub'], width: 1.70, depth: 0.80, height: 0.82 },
  { id: 'washer_dryer_tower', category: 'bathroom_laundry', name: 'Tháp máy giặt & máy sấy cửa trước', legacyTypes: ['washer_dryer'], width: 0.66, depth: 0.68, height: 1.74 },

  // 6. Greenery, Balcony & Architectural (8)
  { id: 'balcony_planter_greenery', category: 'greenery_architectural', name: 'Bồn cây xanh ban công đa tầng', legacyTypes: ['planter'], width: 1.20, depth: 0.36, height: 0.62 },
  { id: 'indoor_potted_ficus', category: 'greenery_architectural', name: 'Chậu cây bàng Singapore / Ficus nội thất', legacyTypes: ['plants'], width: 0.65, depth: 0.65, height: 1.48 },
  { id: 'railing_iron_baluster', category: 'greenery_architectural', name: 'Lan can sắt mỹ thuật sơn tĩnh điện (mô-đun 1m)', legacyTypes: ['railing'], width: 1.00, depth: 0.08, height: 1.05 },
  { id: 'door_interior_wood', category: 'greenery_architectural', name: 'Cửa đi gỗ sồi pano & tay nắm đồng', legacyTypes: ['door_wood', 'door'], width: 0.92, depth: 0.22, height: 2.20 },
  { id: 'door_balcony_glass', category: 'greenery_architectural', name: 'Cửa lùa nhôm kính ban công 2 cánh', legacyTypes: ['door_glass'], width: 1.60, depth: 0.22, height: 2.25 },
  { id: 'window_casement_glass', category: 'greenery_architectural', name: 'Cửa sổ nhôm kính & bệ đá Carrara', legacyTypes: ['window'], width: 1.40, depth: 0.22, height: 1.50 },
  { id: 'stair_flight_straight', category: 'greenery_architectural', name: 'Cầu thang thẳng 1 vế bậc gỗ sồi & lan can sắt', legacyTypes: ['stair_straight'], width: 1.05, depth: 2.80, height: 3.20 },
  { id: 'stair_flight_u_turn', category: 'greenery_architectural', name: 'Cầu thang đổi chiều chữ U có chiếu nghỉ', legacyTypes: ['stair_u', 'stair'], width: 2.20, depth: 2.80, height: 3.60 }
];

// Install lightweight Node.js shims for GLTFLoader.parse verification of embedded PNG blobs
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
  // Override TextureLoader.prototype.load in Node.js so embedded PNG blobs resolve cleanly to THREE.Texture
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const tex = new THREE.Texture();
    tex.name = url;
    if (onLoad) {
      queueMicrotask(() => onLoad(tex));
    }
    return tex;
  };
}

function parseGlbWithGLTFLoader(glbBuffer) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const arrayBuffer = glbBuffer.buffer.slice(
      glbBuffer.byteOffset,
      glbBuffer.byteOffset + glbBuffer.byteLength
    );
    loader.parse(
      arrayBuffer,
      '',
      (gltf) => resolve(gltf),
      (err) => reject(err)
    );
  });
}

export const BLUEPRINT_MATERIALS = {
  natural_oak: 'woodOak', dark_walnut: 'woodWalnut', mahogany_worship: 'woodMahogany',
  carrara_marble: 'marbleCarrara', black_granite: 'blackGranite', boucle_cream: 'fabricLinen',
  velvet_slate: 'fabricVelvet', matte_black_steel: 'metalBlack', brushed_brass: 'metalBrass',
  vitreous_china: 'ceramicWhite', architectural_glass: 'glassClear',
  foliage_green: 'foliageDark'
};

const vector = (value, length, min = -12, max = 12) =>
  Array.isArray(value) && value.length === length && value.every(n => Number.isFinite(n) && n >= min && n <= max);

function normalizeGeometry(group, size) {
  group.getObjectByName('ContactShadowPlane')?.removeFromParent();
  const box = new THREE.Box3().setFromObject(group, true);
  const current = box.getSize(new THREE.Vector3());
  if (![current.x, current.y, current.z].every(n => Number.isFinite(n) && n > 1e-5)) throw new Error('Hình học rỗng hoặc suy biến.');
  group.scale.set(size[0] / current.x, size[1] / current.y, size[2] / current.z);
  const parent = new THREE.Group();
  parent.add(group);
  // Center the nested group at the base while keeping the contact shadow unscaled.
  const center = box.getCenter(new THREE.Vector3());
  group.position.set(-center.x * group.scale.x, -box.min.y * group.scale.y, -center.z * group.scale.z);
  return finalizeAssetGroup(parent, size[0] / 1.04, size[2] / 1.04, true);
}

function buildBlueprint(blueprint) {
  if (!blueprint || !vector(blueprint.size, 3, 0.005, 12) ||
      !Array.isArray(blueprint.parts) || !blueprint.parts.length || blueprint.parts.length > 80) {
    throw new Error('Blueprint cần kích thước [X,Y,Z] và 1–80 bộ phận hợp lệ.');
  }
  const group = new THREE.Group();
  for (const part of blueprint.parts) {
    const material = Object.hasOwn(BLUEPRINT_MATERIALS, part.material) && MAT_INSTANCES[BLUEPRINT_MATERIALS[part.material]];
    const position = part.position ?? [0,0,0];
    const rotation = part.rotation ?? [0,0,0];
    if (!material || !vector(position, 3) || !vector(rotation, 3)) throw new Error('Vật liệu hoặc phép biến đổi không hợp lệ.');
    let geometry;
    if (part.type === 'rounded_box' && vector(part.size, 3, 0.003)) {
      const [x,y,z] = part.size;
      geometry = createRoundedBoxGeometry(x, y, z, Math.min(x,y,z) * 0.14, 2);
    } else if (['tapered_cylinder','angled_leg'].includes(part.type) && vector(part.size, 3, 0.003)) {
      const [top, height, bottom] = part.size;
      geometry = new THREE.CylinderGeometry(top, bottom, height, 16);
    } else if (part.type === 'lathe_profile' && Array.isArray(part.points) && part.points.length >= 3 &&
               part.points.length <= 32 && part.points.every(point => vector(point, 2, 0))) {
      geometry = new THREE.LatheGeometry(part.points.map(point => new THREE.Vector2(...point)), 24);
    } else if (['curved_tube','arch_frame'].includes(part.type) && Array.isArray(part.points) &&
               part.points.length >= 3 && part.points.length <= 24 && part.points.every(point => vector(point, 3)) &&
               Number.isFinite(part.radius) && part.radius >= 0.002 && part.radius <= 0.3) {
      const curve = new THREE.CatmullRomCurve3(part.points.map(point => new THREE.Vector3(...point)));
      geometry = new THREE.TubeGeometry(curve, 28, part.radius, 8);
    } else if (part.type === 'foliage_cluster' && vector(part.size, 3, 0.02)) {
      const [x,y,z] = part.size;
      const leaves = new THREE.Group();
      for (let i = 0; i < 16; i++) {
        const angle = i * 2.39996;
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), material);
        leaf.scale.set(x * 0.5, y * 0.27, z * 0.42);
        leaf.position.set(Math.cos(angle) * x * 0.26, (i / 15 - 0.5) * y * 0.68, Math.sin(angle) * z * 0.25);
        leaf.rotation.z = Math.sin(angle) * 0.6;
        leaves.add(leaf);
      }
      leaves.position.set(...position);
      leaves.rotation.set(...rotation);
      group.add(leaves);
      continue;
    } else {
      throw new Error('Bộ phận không hợp lệ: ' + String(part.type));
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    group.add(mesh);
  }
  return normalizeGeometry(group, blueprint.size);
}

export function compileFurnitureGlb(blueprint, id) {
  return serializeGroupToGlbBuffer(buildBlueprint(blueprint), id);
}

function furnitureExtras() {
  const box = (size, position, material = 'natural_oak') => ({ type: 'rounded_box', size, position, material });
  const cylinder = (size, position, material = 'matte_black_steel') => ({ type: 'tapered_cylinder', size, position, material });
  const table = (x,y,z,material) => [
    box([x,0.04,z],[0,y-0.02,0],material),
    ...[-1,1].flatMap(a => [-1,1].map(b => cylinder([0.027,y-0.04,0.018],[a*x*0.38,(y-0.04)/2,b*z*0.36])))
  ];
  const vase = { type:'lathe_profile', material:'vitreous_china', position:[0,0,0],
    points:[[0,0],[0.11,0],[0.15,0.09],[0.13,0.23],[0.055,0.32],[0.043,0.32],[0.043,0.29]] };
  return [
    ['nightstand_oak','Tab đầu giường gỗ sồi','bedroom',[0.46,0.52,0.42], [
      box([0.46,0.42,0.42],[0,0.29,0]), box([0.41,0.14,0.03],[0,0.32,0.22],'dark_walnut'),
      box([0.13,0.019,0.03],[0,0.32,0.245],'brushed_brass'), ...table(0.43,0.12,0.38)]],
    ['console_walnut','Bàn console gỗ óc chó','living_room',[1.15,0.78,0.35],table(1.15,0.78,0.35,'dark_walnut')],
    ['side_table_granite','Bàn phụ mặt granite','living_room',[0.43,0.49,0.43],[
      cylinder([0.215,0.045,0.215],[0,0.46,0],'black_granite'),
      cylinder([0.045,0.44,0.13],[0,0.22,0],'brushed_brass')]],
    ['bar_stool_oak','Ghế bar lưng cong','kitchen_dining',[0.44,0.97,0.43],[
      ...table(0.42,0.69,0.41,'natural_oak'), box([0.41,0.06,0.4],[0,0.72,0],'boucle_cream'),
      {type:'arch_frame', material:'natural_oak',radius:0.024,points:[[-0.17,0.7,-0.18],[-0.17,0.91,-0.18],[0,0.96,-0.2],[0.17,0.91,-0.18],[0.17,0.7,-0.18]]}]],
    ['ceramic_vase','Bình gốm trang trí','worship_rooftop',[0.3,0.32,0.3],[vase]],
    ['floor_lamp_brass','Đèn đứng chụp vải','living_room',[0.42,1.57,0.42],[
      cylinder([0.16,0.04,0.16],[0,0.02,0]),cylinder([0.017,1.33,0.017],[0,0.68,0],'brushed_brass'),
      cylinder([0.14,0.28,0.21],[0,1.43,0],'boucle_cream')]],
    ['bench_velvet','Ghế băng nhung xanh','bedroom',[1.12,0.49,0.43],[
      ...table(1.08,0.39,0.4,'dark_walnut'),box([1.12,0.1,0.43],[0,0.44,0],'velvet_slate')]],
    ['arch_mirror_brass','Gương vòm viền đồng','bathroom_laundry',[0.65,1.12,0.055],[
      box([0.6,0.94,0.025],[0,0.48,0],'architectural_glass'),
      {type:'arch_frame',material:'brushed_brass',radius:0.018,points:[[-0.31,0.02,0],[-0.31,0.76,0],[-0.2,1,0],[0,1.1,0],[0.2,1,0],[0.31,0.76,0],[0.31,0.02,0],[-0.31,0.02,0]]}]],
    ['oak_bookcase','Kệ sách gỗ sồi năm tầng','bedroom',[0.86,1.7,0.34],[
      ...[-0.41,0.41].map(x=>box([0.04,1.7,0.34],[x,0.85,0])),
      ...[0.12,0.5,0.88,1.26,1.68].map(y=>box([0.82,0.04,0.34],[0,y,0])),
      ...[0.08,0.13,0.18,0.24].map((x,i)=>box([0.04,0.24-i*0.025,0.19],[x,0.645-i*0.0125,0],'velvet_slate'))]],
    ['pedestal_dining_oak','Bàn ăn tròn chân trụ gỗ sồi','kitchen_dining',[1.08,0.76,1.08],[
      cylinder([0.54,0.055,0.54],[0,0.7325,0],'natural_oak'),
      cylinder([0.095,0.69,0.18],[0,0.37,0],'dark_walnut'),
      cylinder([0.23,0.045,0.23],[0,0.0225,0],'matte_black_steel')]],
    ['outdoor_planter_low','Chậu cây thấp sân thượng','greenery_architectural',[0.68,0.58,0.52],[
      box([0.68,0.27,0.52],[0,0.135,0],'black_granite'),
      {type:'foliage_cluster',material:'foliage_green',size:[0.65,0.43,0.49],position:[0,0.37,0]}]],
    ['worship_screen_oak','Vách lam trang trí phòng thờ','worship_rooftop',[0.92,1.54,0.22],[
      box([0.92,0.06,0.22],[0,0.03,0],'dark_walnut'),box([0.92,0.055,0.08],[0,1.51,0],'mahogany_worship'),
      ...Array.from({length:11},(_,i)=>box([0.04,1.47,0.04],[0.085*(i-5),0.78,0],'mahogany_worship'))]],
    ['ceramic_planter_leaf','Chậu gốm tán lá nhiều tầng','greenery_architectural',[0.55,0.85,0.55],[
      vase,cylinder([0.025,0.55,0.03],[0,0.4,0],'dark_walnut'),
      {type:'foliage_cluster',material:'foliage_green',size:[0.55,0.52,0.55],position:[0,0.64,0]}]]
  ].map(([id,name,category,size,parts]) => ({id,name,category,size,parts}));
}

async function main() {
  setupNodeGltfLoaderPolyfill();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const builders = {
    ...buildLivingRoomAssets(),
    ...buildKitchenAndDiningAssets(),
    ...buildBedroomAssets(),
    ...buildWorshipAndRooftopAssets(),
    ...buildBathroomAndLaundryAssets(),
    ...buildGreeneryAndArchitecturalAssets()
  };

  const catalogAssets = [];
  let totalBytes = 0;

  console.log(`[GLB Baker] Generating built-in binary glTF 2.0 (.glb) models into ${OUTPUT_DIR}...`);

  const extras = furnitureExtras();
  const specs = [...ASSET_CATALOG_SPECS, ...extras.map(extra => ({
    ...extra, width: extra.size[0], height: extra.size[1], depth: extra.size[2], legacyTypes: []
  }))];
  for (const spec of specs) {
    const buildFn = builders[spec.id];
    if (!spec.parts && typeof buildFn !== 'function') {
      throw new Error(`Missing builder function for asset ID: ${spec.id}`);
    }

    const group = spec.parts ? buildBlueprint(spec) : normalizeGeometry(buildFn(), [spec.width, spec.height, spec.depth]);
    const glbBuffer = serializeGroupToGlbBuffer(group, spec.id);

    // Verify magic header & version
    const magic = glbBuffer.toString('ascii', 0, 4);
    const version = glbBuffer.readUInt32LE(4);
    const declaredLength = glbBuffer.readUInt32LE(8);
    if (magic !== 'glTF' || version !== 2 || declaredLength !== glbBuffer.length) {
      throw new Error(`Invalid GLB header for ${spec.id}: magic=${magic}, version=${version}`);
    }

    // Verify with THREE.GLTFLoader.parse(arrayBuffer, '')
    const parsedGltf = await parseGlbWithGLTFLoader(glbBuffer);
    let meshCount = 0;
    let hasContactShadow = false;
    parsedGltf.scene.traverse((child) => {
      if (child.isMesh) {
        meshCount++;
        if (child.name === 'ContactShadowPlane' || child.userData?.isContactShadow) {
          hasContactShadow = true;
        }
      }
    });

    if (meshCount < 2 || !hasContactShadow) {
      throw new Error(`Verification failed for ${spec.id}: meshCount=${meshCount}, hasContactShadow=${hasContactShadow}`);
    }

    const outPath = path.join(OUTPUT_DIR, `${spec.id}.glb`);
    fs.writeFileSync(outPath, glbBuffer);
    totalBytes += glbBuffer.length;

    const bbox = new THREE.Box3();
    parsedGltf.scene.traverse(child => {
      if (child.isMesh && !child.userData.isContactShadow && child.name !== 'ContactShadowPlane') bbox.expandByObject(child, true);
    });
    const actual = bbox.getSize(new THREE.Vector3());
    if (actual.distanceTo(new THREE.Vector3(spec.width,spec.height,spec.depth)) > 0.001 ||
        Math.abs(bbox.min.y) > 0.001) throw new Error('Sai kích thước GLB: ' + spec.id + ' ' + actual.toArray() + ' y=' + bbox.min.y);
    const nativeW = Number((bbox.max.x - bbox.min.x).toFixed(3));
    const nativeH = Number((bbox.max.y - bbox.min.y).toFixed(3));
    const nativeD = Number((bbox.max.z - bbox.min.z).toFixed(3));

    catalogAssets.push({
      id: spec.id,
      asset_id: spec.id,
      name: spec.name,
      category: spec.category,
      url: `/assets/models/${spec.id}.glb?v=${createHash('sha256').update(glbBuffer).digest('hex').slice(0,12)}`,
      file: `${spec.id}.glb`,
      legacyTypes: spec.legacyTypes,
      dimensions: {
        width: spec.width,
        depth: spec.depth,
        height: spec.height,
        nativeWidth: nativeW,
        nativeDepth: nativeD,
        nativeHeight: nativeH
      },
      size_x: spec.width, size_y: spec.height, size_z: spec.depth,
      meshCount,
      byteLength: glbBuffer.length,
      hasContactShadow: true
    });

    console.log(
      `  ✓ ${spec.id.padEnd(28)} | ${(glbBuffer.length / 1024).toFixed(1).padStart(6)} KB | ${String(meshCount).padStart(2)} meshes | (${nativeW}×${nativeD}×${nativeH}m)`
    );
  }

  // Build legacy type mapping dictionary for instant lookup in AssetLibraryManager & Backend
  const legacyTypeMap = {};
  for (const item of catalogAssets) {
    for (const lt of item.legacyTypes || []) {
      if (!legacyTypeMap[lt]) {
        legacyTypeMap[lt] = item.id;
      }
    }
  }

  const catalogJson = {
    version: '2.0.0',
    generator: 'OpenCADStudio_Z Nếp Nhà Asset Baker',
    generatedAt: new Date().toISOString(),
    totalAssets: catalogAssets.length,
    totalByteLength: totalBytes,
    legacyTypeMap,
    assets: catalogAssets
  };

  const catalogPath = path.join(OUTPUT_DIR, 'asset_catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalogJson, null, 2), 'utf8');

  console.log(`\n[GLB Baker] Successfully baked ${catalogAssets.length} .glb models (${(totalBytes / 1024 / 1024).toFixed(2)} MB total) + asset_catalog.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => {
  console.error('[GLB Baker] FATAL ERROR:', err);
  process.exit(1);
});
