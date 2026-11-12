/**
 * procedural_textures.js
 * OpenCADStudio_Z / Nếp Nhà - Hồ sơ kiến trúc
 *
 * Production-grade Procedural PBR Texture & Material Library + Synthetic Studio PMREM Environment.
 * Creates and caches procedural THREE.CanvasTexture maps (RepeatWrapping, anisotropy = 4, SRGBColorSpace)
 * and MeshStandardMaterial instances as a singleton so they are NEVER
 * recreated across floor or project switches.
 */

import * as THREE from 'three';

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

export class ProceduralTextureManager {
  static _instance = null;
  static _textures = new Map();
  static _materials = null;
  static _envMap = null;
  static _renderer = null;

  constructor() {
    if (ProceduralTextureManager._instance) {
      return ProceduralTextureManager._instance;
    }
    ProceduralTextureManager._instance = this;
  }

  static setRenderer(renderer) {
    if (renderer) {
      this._renderer = renderer;
    }
  }

  static getInstance() {
    if (!ProceduralTextureManager._instance) {
      ProceduralTextureManager._instance = new ProceduralTextureManager();
    }
    return ProceduralTextureManager._instance;
  }

  /**
   * Check whether a material or texture belongs to the shared singleton cache
   * (so scene disposal routines never dispose cached PBR assets).
   */
  static isSharedMaterial(mat) {
    return Boolean(mat && mat.userData && mat.userData.isSharedPBR);
  }

  static isSharedTexture(tex) {
    return Boolean(tex && tex.userData && tex.userData.isSharedPBR);
  }

  /**
   * Create or retrieve a cached CanvasTexture (or fallback DataTexture in headless Node).
   * @param {string} key
   * @param {number} width
   * @param {number} height
   * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} drawFn
   * @param {Object} options
   * @returns {THREE.Texture}
   */
  static _getOrCreateCanvasTexture(key, width, height, drawFn, options = {}) {
    if (this._textures.has(key)) {
      return this._textures.get(key);
    }

    const maxDim = 512;
    const clampedW = Math.min(width, maxDim);
    const clampedH = Math.min(height, maxDim);

    const repeatX = options.repeatX ?? 2;
    const repeatY = options.repeatY ?? 2;
    const isLinear = options.linear ?? false;

    let texture;
    if (HAS_DOM) {
      const canvas = document.createElement('canvas');
      canvas.width = clampedW;
      canvas.height = clampedH;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        drawFn(ctx, clampedW, clampedH);
      }
      texture = new THREE.CanvasTexture(canvas);
    } else {
      // Fallback 2x2 DataTexture for headless Node.js syntax/unit verification
      const data = new Uint8Array([
        210, 190, 165, 255,
        200, 180, 155, 255,
        200, 180, 155, 255,
        210, 190, 165, 255
      ]);
      texture = new THREE.DataTexture(data, 2, 2);
    }

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    const renderer = options.renderer || this._renderer;
    const maxAnisotropy = renderer?.capabilities?.getMaxAnisotropy
      ? Math.min(renderer.capabilities.getMaxAnisotropy() || 4, 4)
      : 4;
    texture.anisotropy = maxAnisotropy;
    texture.generateMipmaps = true;
    texture.colorSpace = isLinear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    texture.userData = { isSharedPBR: true, textureKey: key };
    // Guard cached singleton texture from accidental disposal during scene clears
    texture._realDispose = texture.dispose.bind(texture);
    texture.dispose = () => {};

    this._textures.set(key, texture);
    return texture;
  }

  /**
   * Deterministic pseudo-random helper for organic wood grain, marble veins, and fabric weaves
   */
  static _hash(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  /**
   * Retrieve a named procedural texture from cache (creating it on first access).
   * @param {string} name
   * @returns {THREE.Texture}
   */
  static getTexture(name) {
    if (this._textures.has(name)) {
      return this._textures.get(name);
    }
    this._ensureTexturesInitialized();
    return this._textures.get(name) || null;
  }

  static _ensureTexturesInitialized() {
    if (this._textures.size > 0) return;

    // 1. Herringbone / Warm Oak Wood Floor Texture (woodOakFloor)
    this._getOrCreateCanvasTexture('woodOakFloor', 512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#C9A276';
      ctx.fillRect(0, 0, w, h);

      const cols = 4;
      const rows = 8;
      const pw = w / cols;
      const ph = h / rows;

      const oakTones = ['#C89F72', '#BF9568', '#D1AA7E', '#B88D5F', '#C49B6E', '#CCA579'];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = (r * cols + c);
          const x = c * pw;
          const y = r * ph;
          ctx.fillStyle = oakTones[idx % oakTones.length];
          ctx.fillRect(x, y, pw, ph);

          // Subtle wood grain fibers along plank
          ctx.strokeStyle = 'rgba(110, 72, 38, 0.16)';
          ctx.lineWidth = 1;
          for (let g = 0; g < 14; g++) {
            const gy = y + ((g + 0.5) / 14) * ph;
            ctx.beginPath();
            ctx.moveTo(x, gy);
            ctx.bezierCurveTo(
              x + pw * 0.33, gy + (this._hash(idx * 20 + g) - 0.5) * 4,
              x + pw * 0.66, gy + (this._hash(idx * 30 + g) - 0.5) * 4,
              x + pw, gy
            );
            ctx.stroke();
          }

          // Plank bevel seam
          ctx.strokeStyle = 'rgba(75, 48, 24, 0.38)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.75, y + 0.75, pw - 1.5, ph - 1.5);
        }
      }
    }, { repeatX: 3, repeatY: 3 });

    // 1b. Oak Floor Bump Map
    this._getOrCreateCanvasTexture('woodOakFloorBump', 512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, w, h);
      const cols = 4;
      const rows = 8;
      const pw = w / cols;
      const ph = h / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * pw;
          const y = r * ph;
          ctx.strokeStyle = '#303030';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, pw, ph);
          ctx.strokeStyle = 'rgba(100,100,100,0.35)';
          ctx.lineWidth = 1;
          for (let g = 0; g < 10; g++) {
            const gy = y + (g / 10) * ph;
            ctx.beginPath();
            ctx.moveTo(x, gy);
            ctx.lineTo(x + pw, gy);
            ctx.stroke();
          }
        }
      }
    }, { repeatX: 3, repeatY: 3, linear: true });

    // 2. Warm Natural Oak Furniture Grain (woodOak)
    this._getOrCreateCanvasTexture('woodOak', 512, 512, (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#C79F74');
      grad.addColorStop(0.5, '#D2AC82');
      grad.addColorStop(1, '#C2986B');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      for (let i = 0; i < 90; i++) {
        const y = (i / 90) * h;
        ctx.strokeStyle = i % 5 === 0 ? 'rgba(115, 76, 40, 0.20)' : 'rgba(140, 96, 54, 0.12)';
        ctx.lineWidth = 1 + (i % 3) * 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(
          w * 0.3, y + Math.sin(i * 0.4) * 6,
          w * 0.7, y - Math.cos(i * 0.3) * 6,
          w, y
        );
        ctx.stroke();
      }
    }, { repeatX: 2, repeatY: 2 });

    // 3. Rich Dark Walnut Wood Grain Texture (woodWalnut)
    this._getOrCreateCanvasTexture('woodWalnut', 512, 512, (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#4E3021');
      grad.addColorStop(0.5, '#5D3A28');
      grad.addColorStop(1, '#462A1C');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      for (let i = 0; i < 110; i++) {
        const y = (i / 110) * h;
        const alpha = 0.14 + (i % 4) * 0.05;
        ctx.strokeStyle = i % 3 === 0 ? `rgba(32, 16, 8, ${alpha})` : `rgba(112, 72, 48, ${alpha * 0.7})`;
        ctx.lineWidth = 1 + (i % 3);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(
          w * 0.25, y + Math.sin(i * 0.25) * 10,
          w * 0.75, y - Math.sin(i * 0.25) * 10,
          w, y
        );
        ctx.stroke();
      }
    }, { repeatX: 2, repeatY: 2 });

    // 4. Mahogany / Rosewood Traditional Altar Wood (woodMahogany)
    this._getOrCreateCanvasTexture('woodMahogany', 512, 512, (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#4F1B0E');
      grad.addColorStop(0.5, '#632313');
      grad.addColorStop(1, '#45160B');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      for (let i = 0; i < 100; i++) {
        const y = (i / 100) * h;
        ctx.strokeStyle = i % 4 === 0 ? 'rgba(28, 6, 2, 0.28)' : 'rgba(135, 52, 28, 0.15)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(
          w * 0.35, y + Math.sin(i * 0.35) * 7,
          w * 0.65, y + Math.cos(i * 0.35) * 7,
          w, y
        );
        ctx.stroke();
      }
    }, { repeatX: 2, repeatY: 2 });

    // 5. White Carrara Marble with Subtle Gray & Warm Gold Veining (marbleCarrara)
    this._getOrCreateCanvasTexture('marbleCarrara', 512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#F7F5F0';
      ctx.fillRect(0, 0, w, h);

      // Soft mineral clouds
      for (let c = 0; c < 12; c++) {
        const cx = this._hash(c * 11) * w;
        const cy = this._hash(c * 17) * h;
        const rad = 60 + this._hash(c * 23) * 120;
        const rGrad = ctx.createRadialGradient(cx, cy, 5, cx, cy, rad);
        rGrad.addColorStop(0, 'rgba(220, 218, 212, 0.35)');
        rGrad.addColorStop(1, 'rgba(247, 245, 240, 0)');
        ctx.fillStyle = rGrad;
        ctx.fillRect(0, 0, w, h);
      }

      // Feathery gray primary veins
      for (let v = 0; v < 14; v++) {
        ctx.strokeStyle = v % 4 === 0 ? 'rgba(196, 164, 116, 0.25)' : 'rgba(155, 160, 168, 0.32)';
        ctx.lineWidth = v % 3 === 0 ? 2.2 : 1.1;
        ctx.beginPath();
        let x = this._hash(v * 7) * w * 0.3;
        let y = this._hash(v * 13) * h;
        ctx.moveTo(x, y);
        for (let s = 1; s <= 6; s++) {
          x += (w / 6) + (this._hash(v * 31 + s) - 0.4) * 35;
          y += (this._hash(v * 43 + s) - 0.45) * 65;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }, { repeatX: 2, repeatY: 2 });

    // 6. Large-Format Architectural Porcelain Floor Tile (porcelainTile)
    this._getOrCreateCanvasTexture('porcelainTile', 512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#EAE6DF';
      ctx.fillRect(0, 0, w, h);

      const grid = 2; // 2x2 tiles per texture repeat
      const tw = w / grid;
      const th = h / grid;

      for (let r = 0; r < grid; r++) {
        for (let c = 0; c < grid; c++) {
          const x = c * tw;
          const y = r * th;
          ctx.fillStyle = (r + c) % 2 === 0 ? '#ECE8E1' : '#E7E3DC';
          ctx.fillRect(x + 2, y + 2, tw - 4, th - 4);

          // Subtle stone speckle/vein
          ctx.strokeStyle = 'rgba(180, 174, 164, 0.22)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x + 16, y + th * 0.3);
          ctx.bezierCurveTo(x + tw * 0.5, y + th * 0.45, x + tw * 0.7, y + th * 0.25, x + tw - 16, y + th * 0.65);
          ctx.stroke();

          // Crisp architectural grout line
          ctx.strokeStyle = '#C9C4BA';
          ctx.lineWidth = 3;
          ctx.strokeRect(x + 1.5, y + 1.5, tw - 3, th - 3);
        }
      }
    }, { repeatX: 4, repeatY: 4 });

    // 7. Woven Linen / Bouclé Upholstery Fabric (fabricLinen)
    this._getOrCreateCanvasTexture('fabricLinen', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#C8B9A6';
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = 'rgba(255, 250, 242, 0.18)';
      for (let y = 0; y < h; y += 4) {
        ctx.fillRect(0, y, w, 1.5);
      }
      ctx.fillStyle = 'rgba(120, 102, 84, 0.16)';
      for (let x = 0; x < w; x += 4) {
        ctx.fillRect(x, 0, 1.5, h);
      }
    }, { repeatX: 6, repeatY: 6 });

    // 8. Soft Velvet / Chenille Upholstery (fabricVelvet)
    this._getOrCreateCanvasTexture('fabricVelvet', 256, 256, (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#786D63');
      grad.addColorStop(0.5, '#877B70');
      grad.addColorStop(1, '#6E6359');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1;
      for (let y = 0; y < h; y += 3) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }, { repeatX: 5, repeatY: 5 });

    // 9. Artisanal Woven Area Rug with Border Pattern (rugWoven)
    this._getOrCreateCanvasTexture('rugWoven', 512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#DFD6C7';
      ctx.fillRect(0, 0, w, h);

      // Woven crosshatch base
      ctx.strokeStyle = 'rgba(165, 148, 126, 0.25)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < w; i += 6) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(w, i);
        ctx.stroke();
      }

      // Outer & inner decorative architectural border
      ctx.strokeStyle = '#9E7B56';
      ctx.lineWidth = 14;
      ctx.strokeRect(28, 28, w - 56, h - 56);

      ctx.strokeStyle = '#6E5A46';
      ctx.lineWidth = 4;
      ctx.strokeRect(48, 48, w - 96, h - 96);

      // Subtle geometric diamond medallion in center
      ctx.strokeStyle = 'rgba(158, 123, 86, 0.45)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w / 2, 110);
      ctx.lineTo(w - 110, h / 2);
      ctx.lineTo(w / 2, h - 110);
      ctx.lineTo(110, h / 2);
      ctx.closePath();
      ctx.stroke();
    }, { repeatX: 1, repeatY: 1 });

    // 10. Fluted Glass Ribbed Bump Map (flutedGlass)
    this._getOrCreateCanvasTexture('flutedGlass', 256, 256, (ctx, w, h) => {
      for (let x = 0; x < w; x += 8) {
        const g = ctx.createLinearGradient(x, 0, x + 8, 0);
        g.addColorStop(0, '#404040');
        g.addColorStop(0.5, '#EAEAEA');
        g.addColorStop(1, '#404040');
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, 8, h);
      }
    }, { repeatX: 4, repeatY: 1, linear: true });

    // 11. Trúc Chỉ Lotus Mandala Altar Medallion (trucChiMandala)
    this._getOrCreateCanvasTexture('trucChiMandala', 512, 512, (ctx, w, h) => {
      const cx = w / 2;
      const cy = h / 2;
      const rGrad = ctx.createRadialGradient(cx, cy, 10, cx, cy, w * 0.48);
      rGrad.addColorStop(0, '#FFF6D6');
      rGrad.addColorStop(0.55, '#F5B841');
      rGrad.addColorStop(0.85, '#C87619');
      rGrad.addColorStop(1, '#7A3E08');
      ctx.fillStyle = rGrad;
      ctx.fillRect(0, 0, w, h);

      // Concentric mandala rings & lotus petals
      ctx.strokeStyle = 'rgba(255, 248, 220, 0.65)';
      for (const rad of [45, 90, 140, 185, 220]) {
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 16 Lotus petals
      ctx.strokeStyle = 'rgba(255, 245, 200, 0.7)';
      ctx.lineWidth = 2;
      for (let p = 0; p < 16; p++) {
        const a = (p / 16) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * 45, cy + Math.sin(a) * 45);
        ctx.quadraticCurveTo(
          cx + Math.cos(a + 0.18) * 135,
          cy + Math.sin(a + 0.18) * 135,
          cx + Math.cos(a) * 185,
          cy + Math.sin(a) * 185
        );
        ctx.quadraticCurveTo(
          cx + Math.cos(a - 0.18) * 135,
          cy + Math.sin(a - 0.18) * 135,
          cx + Math.cos(a) * 45,
          cy + Math.sin(a) * 45
        );
        ctx.stroke();
      }
    }, { repeatX: 1, repeatY: 1 });
  }

  /**
   * Returns the complete singleton dictionary of cached PBR materials.
   * Safe to call repeatedly; never recreates materials.
   */
  static getMaterials() {
    if (this._materials) {
      return this._materials;
    }

    this._ensureTexturesInitialized();
    const tex = (name) => this._textures.get(name);

    const markShared = (dict) => {
      for (const [k, m] of Object.entries(dict)) {
        if (m && typeof m === 'object') {
          m.userData = { ...(m.userData || {}), isSharedPBR: true, materialKey: k };
          if (typeof m.dispose === 'function' && !m._realDispose) {
            m._realDispose = m.dispose.bind(m);
            m.dispose = () => {};
          }
        }
      }
      return dict;
    };

    const woodOakFloor = new THREE.MeshStandardMaterial({
      color: 0xE6D2B8,
      map: tex('woodOakFloor'),
      bumpMap: tex('woodOakFloorBump'),
      bumpScale: 0.004,
      roughness: 0.38,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });

    const woodOak = new THREE.MeshStandardMaterial({
      color: 0xDFC4A4,
      map: tex('woodOak'),
      bumpMap: tex('woodOak'),
      bumpScale: 0.003,
      roughness: 0.42,
      metalness: 0.04
    });

    const woodWalnut = new THREE.MeshStandardMaterial({
      color: 0x8A624A,
      map: tex('woodWalnut'),
      bumpMap: tex('woodWalnut'),
      bumpScale: 0.003,
      roughness: 0.35,
      metalness: 0.05
    });

    const woodMahogany = new THREE.MeshStandardMaterial({
      color: 0x7A3320,
      map: tex('woodMahogany'),
      bumpMap: tex('woodMahogany'),
      bumpScale: 0.003,
      roughness: 0.28,
      metalness: 0.06
    });

    const marbleCarrara = new THREE.MeshStandardMaterial({
      color: 0xFFFFFF,
      map: tex('marbleCarrara'),
      bumpMap: tex('marbleCarrara'),
      bumpScale: 0.0015,
      roughness: 0.14,
      metalness: 0.02,
      envMapIntensity: 0.75
    });

    const porcelainTile = new THREE.MeshStandardMaterial({
      color: 0xF5F2EC,
      map: tex('porcelainTile'),
      bumpMap: tex('porcelainTile'),
      bumpScale: 0.002,
      roughness: 0.22,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });

    const fabricLinen = new THREE.MeshStandardMaterial({
      color: 0xD8CBB8,
      map: tex('fabricLinen'),
      bumpMap: tex('fabricLinen'),
      bumpScale: 0.005,
      roughness: 0.88,
      metalness: 0.0
    });

    const fabricVelvet = new THREE.MeshStandardMaterial({
      color: 0x8C8074,
      map: tex('fabricVelvet'),
      bumpMap: tex('fabricVelvet'),
      bumpScale: 0.004,
      roughness: 0.76,
      metalness: 0.02
    });

    const rugWoven = new THREE.MeshStandardMaterial({
      color: 0xEAE2D6,
      map: tex('rugWoven'),
      bumpMap: tex('rugWoven'),
      bumpScale: 0.006,
      roughness: 0.92,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    const metalBrass = new THREE.MeshStandardMaterial({
      color: 0xD4AF37,
      roughness: 0.24,
      metalness: 0.92
    });

    const metalBlack = new THREE.MeshStandardMaterial({
      color: 0x222428,
      roughness: 0.36,
      metalness: 0.84
    });

    const metalChrome = new THREE.MeshStandardMaterial({
      color: 0xF2F5F8,
      roughness: 0.08,
      metalness: 0.96
    });

    const glassClear = new THREE.MeshStandardMaterial({
      color: 0xDFF2FF,
      transparent: true,
      opacity: 0.28,
      roughness: 0.1,
      metalness: 0.2,
      envMapIntensity: 0.6,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    const glassFrosted = new THREE.MeshStandardMaterial({
      color: 0xE6F1F5,
      transparent: true,
      opacity: 0.45,
      roughness: 0.38,
      metalness: 0.05,
      envMapIntensity: 0.5,
      bumpMap: tex('flutedGlass'),
      bumpScale: 0.004,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    const emissiveWarm = new THREE.MeshStandardMaterial({
      color: 0xFFF6E5,
      emissive: 0xFFAE42,
      emissiveIntensity: 2.2,
      roughness: 0.2,
      metalness: 0.0
    });

    const emissiveGold = new THREE.MeshStandardMaterial({
      color: 0xFFE8B0,
      map: tex('trucChiMandala'),
      emissive: 0xE59A28,
      emissiveMap: tex('trucChiMandala'),
      emissiveIntensity: 1.75,
      roughness: 0.28,
      metalness: 0.1
    });

    const cutawayCapMat = new THREE.MeshStandardMaterial({
      color: 0x4A4A4A,
      roughness: 0.65,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    const ceramicSanitary = new THREE.MeshStandardMaterial({
      color: 0xFFFFFF,
      roughness: 0.1,
      metalness: 0.02,
      envMapIntensity: 0.85
    });

    this._materials = markShared({
      // Core PBR Materials required by spec
      woodOakFloor,
      woodOak,
      woodWalnut,
      woodMahogany,
      marbleCarrara,
      porcelainTile,
      fabricLinen,
      fabricVelvet,
      rugWoven,
      metalBrass,
      metalBlack,
      metalChrome,
      glassClear,
      glassFrosted,
      emissiveWarm,
      emissiveGold,
      cutawayCapMat,

      // Architectural & Structural Materials
      concreteSlab: new THREE.MeshStandardMaterial({
        color: 0xE8E5DE,
        roughness: 0.78,
        metalness: 0.04
      }),
      exteriorWall: new THREE.MeshStandardMaterial({
        color: 0xF0EDE6,
        roughness: 0.62,
        metalness: 0.05
      }),
      exteriorAccentWall: new THREE.MeshStandardMaterial({
        color: 0x3A3835,
        roughness: 0.5,
        metalness: 0.18
      }),
      interiorPlaster: new THREE.MeshStandardMaterial({
        color: 0xFCFBF7,
        roughness: 0.82,
        metalness: 0.02
      }),
      baseboardMat: new THREE.MeshStandardMaterial({
        color: 0xE5DFD3,
        roughness: 0.5,
        metalness: 0.04
      }),
      columnConcrete: new THREE.MeshStandardMaterial({
        color: 0xD6D2C8,
        roughness: 0.68,
        metalness: 0.08
      }),
      stairRiser: new THREE.MeshStandardMaterial({
        color: 0xFAF8F5,
        roughness: 0.55,
        metalness: 0.02
      }),

      // Furniture Accent Materials
      pillowAccentTerra: new THREE.MeshStandardMaterial({
        color: 0xC86D51,
        bumpMap: tex('fabricLinen'),
        bumpScale: 0.004,
        roughness: 0.85,
        metalness: 0.0
      }),
      pillowAccentSage: new THREE.MeshStandardMaterial({
        color: 0x6E7F68,
        bumpMap: tex('fabricLinen'),
        bumpScale: 0.004,
        roughness: 0.85,
        metalness: 0.0
      }),
      pillowAccentMustard: new THREE.MeshStandardMaterial({
        color: 0xD49B4B,
        bumpMap: tex('fabricVelvet'),
        bumpScale: 0.004,
        roughness: 0.8,
        metalness: 0.0
      }),
      beddingFabric: new THREE.MeshStandardMaterial({
        color: 0xF7F5F0,
        bumpMap: tex('fabricLinen'),
        bumpScale: 0.003,
        roughness: 0.86,
        metalness: 0.0
      }),
      beddingDuvet: new THREE.MeshStandardMaterial({
        color: 0xCFC4B4,
        map: tex('fabricLinen'),
        bumpMap: tex('fabricLinen'),
        bumpScale: 0.005,
        roughness: 0.88,
        metalness: 0.0
      }),
      kitchenCabinet: new THREE.MeshStandardMaterial({
        color: 0x2C353B,
        roughness: 0.32,
        metalness: 0.16
      }),
      stainlessSteel: new THREE.MeshStandardMaterial({
        color: 0xD4D8DC,
        roughness: 0.22,
        metalness: 0.9
      }),
      cooktopGlass: new THREE.MeshStandardMaterial({
        color: 0x111214,
        roughness: 0.08,
        metalness: 0.1,
        envMapIntensity: 0.9
      }),
      tvScreen: new THREE.MeshStandardMaterial({
        color: 0x0A0B0E,
        roughness: 0.06,
        metalness: 0.25,
        envMapIntensity: 0.95
      }),
      mirrorSurface: new THREE.MeshStandardMaterial({
        color: 0xF5F8FA,
        roughness: 0.03,
        metalness: 0.98
      }),
      terracottaPot: new THREE.MeshStandardMaterial({
        color: 0xB86B4B,
        roughness: 0.76,
        metalness: 0.02
      }),
      ceramicVase: new THREE.MeshStandardMaterial({
        color: 0xEAE4D7,
        roughness: 0.22,
        metalness: 0.02,
        envMapIntensity: 0.55
      }),
      ceramicSanitary,

      // Landscaping & Site Materials
      grassGround: new THREE.MeshStandardMaterial({
        color: 0x587848,
        roughness: 0.9,
        metalness: 0.0
      }),
      waterSurface: new THREE.MeshStandardMaterial({
        color: 0x2B6B7F,
        transparent: true,
        opacity: 0.68,
        roughness: 0.12,
        metalness: 0.1,
        envMapIntensity: 0.8,
        depthWrite: false
      }),
      treeFoliage: new THREE.MeshStandardMaterial({
        color: 0x3E6838,
        roughness: 0.84,
        metalness: 0.0
      }),
      plantFoliageLight: new THREE.MeshStandardMaterial({
        color: 0x528246,
        roughness: 0.76,
        metalness: 0.0
      }),

      // Legacy aliases for Viewer3D compatibility
      woodFloor: woodOakFloor,
      glassWindow: glassClear,
      metalFrame: metalBlack,
      stairStep: woodOak,
      railingMetal: metalBlack,
      sofaFabric: fabricLinen,
      altarWood: woodMahogany,
      highlightOverlay: new THREE.MeshBasicMaterial({
        color: 0xF59E0B,
        wireframe: true
      })
    });

    return this._materials;
  }

  /**
   * Generate and cache a synthetic warm architectural studio environment map
   * using THREE.PMREMGenerator so PBR materials (glass, chrome, brass, marble, oak)
   * exhibit realistic reflections without external HDR files.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @returns {THREE.Texture|null}
   */
  static createStudioEnvMap(renderer) {
    if (renderer) {
      this._renderer = renderer;
    }
    if (this._envMap) {
      return this._envMap;
    }
    if (!renderer || typeof THREE.PMREMGenerator !== 'function') {
      return null;
    }

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileCubemapShader();

    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0xE8E4DC);

    const tempGeos = [];
    const tempMats = [];

    const addLightPanel = (w, h, colorHex, intensity, pos, lookAt) => {
      const geo = new THREE.PlaneGeometry(w, h);
      const col = new THREE.Color(colorHex).multiplyScalar(intensity);
      const mat = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.lookAt(lookAt);
      envScene.add(mesh);
      tempGeos.push(geo);
      tempMats.push(mat);
    };

    const origin = new THREE.Vector3(0, 0, 0);
    // Warm ceiling softbox
    addLightPanel(18, 18, 0xFFF8EB, 2.2, new THREE.Vector3(0, 10, 0), origin);
    // Key warm architectural window softbox
    addLightPanel(14, 10, 0xFFEAD2, 1.8, new THREE.Vector3(12, 4, 10), origin);
    // Cool daylight fill softbox
    addLightPanel(14, 10, 0xDFEEF8, 1.35, new THREE.Vector3(-12, 5, -8), origin);
    // Warm oak floor bounce plane
    addLightPanel(24, 24, 0xC9B396, 0.75, new THREE.Vector3(0, -8, 0), origin);

    const renderTarget = pmremGenerator.fromScene(envScene, 0.04);
    this._envMap = renderTarget.texture;
    this._envMap.userData = { isSharedPBR: true, textureKey: 'studioEnvMap' };

    for (const g of tempGeos) g.dispose();
    for (const m of tempMats) m.dispose();
    pmremGenerator.dispose();

    return this._envMap;
  }

  // Instance method delegates for convenience
  getMaterials() {
    return ProceduralTextureManager.getMaterials();
  }

  getTexture(name) {
    return ProceduralTextureManager.getTexture(name);
  }

  createStudioEnvMap(renderer) {
    return ProceduralTextureManager.createStudioEnvMap(renderer);
  }
}

export function createStudioEnvMap(renderer) {
  return ProceduralTextureManager.createStudioEnvMap(renderer);
}

export const proceduralTextures = ProceduralTextureManager.getInstance();
export default ProceduralTextureManager;
