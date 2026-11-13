/**
 * asset_library_manager.js
 * OpenCADStudio_Z / Nếp Nhà - Hồ sơ kiến trúc
 *
 * Preloaded glTF 2.0 (.glb) Asset Library Manager & GPU-Shared Shallow Cloner.
 * - Preloads all 35 architectural & interior furniture .glb assets in parallel
 * - Protects cached BufferGeometry, Material, and Texture instances from scene disposal
 * - Configures embedded ContactShadowPlane meshes for zero-cost soft ambient occlusion
 * - Instantiates GPU-shared clones scaled and oriented to BIM item dimensions at 60 FPS
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FurnitureGenerator } from './furniture_generator.js';

export const CATALOG_ASSET_IDS = [
  // 1. Living Room (7)
  'sofa_l_modern',
  'sofa_straight_3seat',
  'armchair_lounge',
  'coffee_table_set',
  'tv_cabinet_wall_unit',
  'entrance_shoe_cabinet',
  'floor_rug_textured',
  // 2. Kitchen & Dining (6)
  'kitchen_system_i',
  'kitchen_system_l',
  'kitchen_island_bar',
  'fridge_double_door',
  'dining_table_6chairs',
  'dining_table_4chairs',
  // 3. Bedrooms (6)
  'bed_master_king',
  'bed_queen_modern',
  'bed_bunk_kids',
  'wardrobe_tall_glass',
  'work_desk_computer',
  'dressing_table_mirror',
  // 4. Worship & Rooftop (3)
  'vietnamese_worship_altar',
  'outdoor_bbq_station',
  'outdoor_patio_set',
  // 5. Bathroom & Laundry (5)
  'toilet_onepiece',
  'lavabo_vanity_led_mirror',
  'shower_glass_enclosure',
  'bathtub_modern',
  'washer_dryer_tower',
  // 6. Greenery, Balcony & Architectural (8)
  'balcony_planter_greenery',
  'indoor_potted_ficus',
  'railing_iron_baluster',
  'door_interior_wood',
  'door_balcony_glass',
  'window_casement_glass',
  'stair_flight_straight',
  'stair_flight_u_turn'
];

export const LEGACY_TYPE_TO_ASSET_ID = {
  sofa_sectional: 'sofa_l_modern',
  sofa: 'sofa_straight_3seat',
  armchair: 'armchair_lounge',
  coffee_table: 'coffee_table_set',
  tv_console: 'tv_cabinet_wall_unit',
  shoe_cabinet: 'entrance_shoe_cabinet',
  rug: 'floor_rug_textured',
  floor_rug: 'floor_rug_textured',
  kitchen_cabinet: 'kitchen_system_l',
  kitchen_island: 'kitchen_island_bar',
  fridge: 'fridge_double_door',
  dining_table: 'dining_table_6chairs',
  bed_master: 'bed_master_king',
  bed: 'bed_queen_modern',
  bed_bunk: 'bed_bunk_kids',
  wardrobe: 'wardrobe_tall_glass',
  desk: 'work_desk_computer',
  dressing_table: 'dressing_table_mirror',
  chair_or_nightstand: 'armchair_lounge',
  nightstand: 'armchair_lounge',
  chair: 'armchair_lounge',
  altar_table: 'vietnamese_worship_altar',
  bbq: 'outdoor_bbq_station',
  patio: 'outdoor_patio_set',
  toilet: 'toilet_onepiece',
  vanity: 'lavabo_vanity_led_mirror',
  shower: 'shower_glass_enclosure',
  bathtub: 'bathtub_modern',
  washer: 'washer_dryer_tower',
  laundry: 'washer_dryer_tower',
  plants: 'indoor_potted_ficus',
  planter: 'balcony_planter_greenery',
  balcony_planter: 'balcony_planter_greenery',
  railing: 'railing_iron_baluster',
  door: 'door_interior_wood',
  door_balcony: 'door_balcony_glass',
  window: 'window_casement_glass',
  stair_straight: 'stair_flight_straight',
  stair: 'stair_flight_u_turn',
  gym_machine: 'work_desk_computer'
};

const TEXTURE_KEYS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'bumpMap',
  'alphaMap'
];

export class AssetLibraryManager {
  static _instance = null;

  constructor() {
    if (AssetLibraryManager._instance) {
      return AssetLibraryManager._instance;
    }
    this.loader = new GLTFLoader();
    this.templates = new Map(); // assetId -> { assetId, scene, nativeW, nativeH, nativeD, minY, centerX, centerZ, metadata }
    this.catalog = [];
    this.loadedCount = 0;
    this.failedCount = 0;
    this.totalCount = CATALOG_ASSET_IDS.length;
    this.isLoaded = false;
    this.isLoading = false;
    this._preloadPromise = null;
    this._progressCallbacks = new Set();
    this._readyCallbacks = new Set();
    this._fallbackShadowMat = null;
    this._fallbackShadowGeo = null;

    // Dual-Mode Mapping: 3D Model Asset ID -> Photorealistic Real Impostor Asset ID
    this.variantOfMap = new Map([
      ['sofa_l_modern', 'real_sofa_l_modern'],
      ['sofa_straight_3seat', 'real_sofa_l_modern'],
      ['coffee_table_set', 'real_coffee_table_set'],
      ['tv_cabinet_wall_unit', 'real_tv_cabinet'],
      ['dining_table_6chairs', 'real_dining_table_6chairs'],
      ['dining_table_4chairs', 'real_dining_table_6chairs'],
      ['kitchen_system_l', 'real_kitchen_system_l'],
      ['kitchen_system_i', 'real_kitchen_system_l'],
      ['kitchen_island_bar', 'real_kitchen_system_l'],
      ['bed_master_king', 'real_bed_master_king'],
      ['bed_queen_modern', 'real_bed_master_king'],
      ['bed_bunk_kids', 'real_bed_master_king'],
      ['wardrobe_tall_glass', 'real_wardrobe'],
      ['work_desk_computer', 'real_work_desk'],
      ['dressing_table_mirror', 'real_lavabo_vanity'],
      ['vietnamese_worship_altar', 'real_worship_altar'],
      ['lavabo_vanity_led_mirror', 'real_lavabo_vanity'],
      ['toilet_onepiece', 'real_toilet'],
      ['indoor_potted_ficus', 'real_potted_plant'],
      ['balcony_planter_greenery', 'real_potted_plant']
    ]);
    this.realManifest = [];
    this.furnitureMode = 'model'; // 'model' | 'real'

    AssetLibraryManager._instance = this;
  }

  static getInstance() {
    if (!AssetLibraryManager._instance) {
      AssetLibraryManager._instance = new AssetLibraryManager();
    }
    return AssetLibraryManager._instance;
  }

  // Static property getters for convenience & QA inspection
  static get loadedCount() {
    return this.getInstance().loadedCount;
  }

  static get failedCount() {
    return this.getInstance().failedCount;
  }

  static get totalCount() {
    return this.getInstance().totalCount;
  }

  static get isLoaded() {
    return this.getInstance().isLoaded;
  }

  static get templates() {
    return this.getInstance().templates;
  }

  static get catalog() {
    return this.getInstance().catalog;
  }

  static getStats() {
    return this.getInstance().getStats();
  }

  getStats() {
    return {
      loadedCount: this.loadedCount,
      failedCount: this.failedCount,
      totalCount: this.totalCount,
      isLoaded: this.isLoaded,
      cachedAssetIds: Array.from(this.templates.keys())
    };
  }

  onReady(callback) {
    if (typeof callback !== 'function') return;
    if (this.isLoaded) {
      callback(this.getStats());
    } else {
      this._readyCallbacks.add(callback);
    }
  }

  static onReady(callback) {
    return this.getInstance().onReady(callback);
  }

  /**
   * Create a shared fallback soft contact shadow geometry + material
   * in case any loaded .glb does not already contain a ContactShadowPlane mesh.
   */
  _getFallbackContactShadowResources() {
    if (!this._fallbackShadowGeo) {
      this._fallbackShadowGeo = new THREE.PlaneGeometry(1, 1);
      this._fallbackShadowGeo.rotateX(-Math.PI / 2);
      this._fallbackShadowGeo.userData = { isSharedGeometry: true, isSharedPBR: true };
      this._fallbackShadowGeo._realDispose = this._fallbackShadowGeo.dispose.bind(this._fallbackShadowGeo);
      this._fallbackShadowGeo.dispose = () => {};
    }

    if (!this._fallbackShadowMat) {
      let shadowTex = null;
      if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
          grad.addColorStop(0, 'rgba(18, 16, 14, 0.42)');
          grad.addColorStop(0.65, 'rgba(18, 16, 14, 0.18)');
          grad.addColorStop(1, 'rgba(18, 16, 14, 0.0)');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, 128, 128);
        }
        shadowTex = new THREE.CanvasTexture(canvas);
        shadowTex.userData = { isSharedPBR: true };
        shadowTex._realDispose = shadowTex.dispose.bind(shadowTex);
        shadowTex.dispose = () => {};
      }

      this._fallbackShadowMat = new THREE.MeshBasicMaterial({
        color: 0x141210,
        map: shadowTex,
        transparent: true,
        opacity: shadowTex ? 0.85 : 0.24,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      this._fallbackShadowMat.userData = { isSharedPBR: true };
      this._fallbackShadowMat._realDispose = this._fallbackShadowMat.dispose.bind(this._fallbackShadowMat);
      this._fallbackShadowMat.dispose = () => {};
    }

    return { geo: this._fallbackShadowGeo, mat: this._fallbackShadowMat };
  }

  /**
   * Normalize catalog JSON into a flat list of 35+ { id, url, ... } descriptors
   */
  _normalizeCatalogData(rawCatalog) {
    const mapById = new Map();

    // Seed with the 35 required catalog IDs first
    for (const id of CATALOG_ASSET_IDS) {
      mapById.set(id, {
        id,
        asset_id: id,
        url: `/assets/models/${id}.glb`
      });
    }

    let list = [];
    if (Array.isArray(rawCatalog)) {
      list = rawCatalog;
    } else if (rawCatalog && typeof rawCatalog === 'object') {
      if (Array.isArray(rawCatalog.assets)) {
        list = rawCatalog.assets;
      } else if (Array.isArray(rawCatalog.models)) {
        list = rawCatalog.models;
      } else if (Array.isArray(rawCatalog.items)) {
        list = rawCatalog.items;
      } else {
        list = Object.entries(rawCatalog)
          .filter(([k, v]) => v && typeof v === 'object' && !Array.isArray(v))
          .map(([k, v]) => ({ id: k, ...v }));
      }
    }

    for (const item of list) {
      if (!item) continue;
      const id = typeof item === 'string'
        ? item
        : (item.asset_id || item.id || item.assetId || item.name);
      if (!id) continue;

      let url = item.url || item.path || item.file || item.glb || `/assets/models/${id}.glb`;
      if (!url.startsWith('/') && !url.startsWith('http')) {
        url = `/assets/models/${url.replace(/^\.?\//, '')}`;
      }

      mapById.set(id, {
        ...(typeof item === 'object' ? item : {}),
        id,
        asset_id: id,
        url
      });
    }

    return Array.from(mapById.values());
  }

  /**
   * Fetch /assets/models/asset_catalog.json and preload all .glb files in parallel.
   * @param {(loaded: number, total: number, assetId: string) => void} [onProgress]
   * @returns {Promise<{ loadedCount: number, failedCount: number, totalCount: number }>}
   */
  async preloadAll(onProgress = null) {
    if (typeof onProgress === 'function') {
      this._progressCallbacks.add(onProgress);
    }

    if (this.isLoaded && this.loadedCount >= CATALOG_ASSET_IDS.length && this.failedCount === 0) {
      if (typeof onProgress === 'function') {
        onProgress(this.loadedCount, this.totalCount, 'complete');
      }
      return this.getStats();
    }

    if (this._preloadPromise) {
      return this._preloadPromise;
    }

    this.isLoading = true;

    this._preloadPromise = (async () => {
      let rawCatalog = null;
      try {
        const res = await fetch('/assets/models/asset_catalog.json');
        if (res.ok) {
          rawCatalog = await res.json();
        }
      } catch {
        // Fallback to built-in 35-item catalog descriptor list
      }

      this.catalog = this._normalizeCatalogData(rawCatalog);
      try {
        const response = await fetch('/api/furniture-assets?type=model');
        if (response.ok) {
          const records = (await response.json()).data || [];
          const ids = new Set(this.catalog.map(entry => entry.id));
          this.catalog.push(...records.filter(record => !ids.has(record.asset_id) && record.glb_path)
            .map(record => ({ ...record, id:record.asset_id, url:record.glb_path })));
        }
      } catch {
        // Built-in models remain available on static deployments.
      }

      this.totalCount = this.catalog.length;
      this.loadedCount = 0;
      this.failedCount = 0;

      const loadPromises = this.catalog.map(async (entry) => {
        const assetId = entry.id;
        try {
          if (!this.templates.has(assetId)) {
            const gltf = await this._loadSingleGlb(entry.url);
            this._registerTemplate(assetId, gltf, entry);
          }
          this.loadedCount++;
        } catch (err) {
          this.failedCount++;
          console.warn(`[AssetLibraryManager] Could not load ${entry.url}:`, err?.message || err);
        } finally {
          for (const cb of this._progressCallbacks) {
            try {
              cb(this.loadedCount, this.totalCount, assetId);
            } catch {}
          }
        }
      });

      await Promise.all(loadPromises);

      this.isLoading = false;
      this.isLoaded = this.loadedCount > 0;

      const stats = this.getStats();
      for (const readyCb of this._readyCallbacks) {
        try {
          readyCb(stats);
        } catch {}
      }
      this._readyCallbacks.clear();

      if (this.failedCount > 0) {
        // Allow retry on subsequent preloadAll call if some assets were still baking
        this._preloadPromise = null;
      }

      return stats;
    })();

    return this._preloadPromise;
  }

  static preloadAll(onProgress = null) {
    return this.getInstance().preloadAll(onProgress);
  }

  /**
   * Load a single .glb file via fetch + GLTFLoader.parse (or GLTFLoader.load fallback)
   */
  async loadRegisteredAsset(record) {
    const entry = { ...record, id:record.asset_id, url:record.glb_path };
    const gltf = await this._loadSingleGlb(entry.url);
    this._registerTemplate(entry.id, gltf, entry);
  }

  async _loadSingleGlb(url) {
    if (typeof fetch === 'function') {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return new Promise((resolve, reject) => {
        this.loader.parse(arrayBuffer, '/assets/models/', resolve, reject);
      });
    }

    return new Promise((resolve, reject) => {
      this.loader.load(url, resolve, undefined, reject);
    });
  }

  /**
   * Process a loaded glTF scene:
   * - Protect all geometries, materials, and textures from disposal
   * - Configure ContactShadowPlane mesh
   * - Enable castShadow/receiveShadow and envMapIntensity=0.85 on all body meshes
   * - Compute native bounding box (nativeW, nativeH, nativeD) and bottom offset
   */
  _registerTemplate(assetId, gltf, entry = {}) {
    const templateScene = gltf.scene || (gltf.scenes && gltf.scenes[0]) || new THREE.Group();
    templateScene.name = `glb_template_${assetId}`;

    let hasContactShadow = false;

    templateScene.traverse((child) => {
      if (!child.isMesh) return;

      if (child.geometry) {
        child.geometry.userData = child.geometry.userData || {};
        child.geometry.userData.isSharedGeometry = true;
        child.geometry.userData.isSharedPBR = true;
        if (!child.geometry._realDispose && typeof child.geometry.dispose === 'function') {
          child.geometry._realDispose = child.geometry.dispose.bind(child.geometry);
          child.geometry.dispose = () => {};
        }
      }

      const isContactShadow =
        child.name === 'ContactShadowPlane' ||
        (typeof child.name === 'string' && child.name.toLowerCase().includes('contactshadow')) ||
        Boolean(child.userData?.isContactShadow);

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (!mat) continue;
        mat.userData = mat.userData || {};
        mat.userData.isSharedPBR = true;
        if (!mat._realDispose && typeof mat.dispose === 'function') {
          mat._realDispose = mat.dispose.bind(mat);
          mat.dispose = () => {};
        }

        for (const texKey of TEXTURE_KEYS) {
          const tex = mat[texKey];
          if (tex) {
            tex.userData = tex.userData || {};
            tex.userData.isSharedPBR = true;
            if (!tex._realDispose && typeof tex.dispose === 'function') {
              tex._realDispose = tex.dispose.bind(tex);
              tex.dispose = () => {};
            }
          }
        }

        if (isContactShadow) {
          mat.transparent = true;
          mat.depthWrite = false;
          mat.polygonOffset = true;
          mat.polygonOffsetFactor = -1;
          mat.polygonOffsetUnits = -1;
        } else {
          if ('envMapIntensity' in mat) {
            mat.envMapIntensity = 0.85;
          }
        }
      }

      if (isContactShadow) {
        hasContactShadow = true;
        child.name = 'ContactShadowPlane';
        child.userData = {
          ...(child.userData || {}),
          isContactShadow: true,
          isSharedGeometry: true,
          isSharedPBR: true
        };
        child.castShadow = false;
        child.receiveShadow = false;
      } else {
        // Selective shadow casting: only meshes with bounding box volume > 0.01 m³ cast shadow
        let volume = 0;
        if (child.geometry) {
          if (!child.geometry.boundingBox) {
            child.geometry.computeBoundingBox();
          }
          if (child.geometry.boundingBox) {
            const bb = child.geometry.boundingBox;
            const dx = Math.max(0, bb.max.x - bb.min.x);
            const dy = Math.max(0, bb.max.y - bb.min.y);
            const dz = Math.max(0, bb.max.z - bb.min.z);
            volume = dx * dy * dz;
          }
        }
        child.castShadow = volume > 0.01;
        child.receiveShadow = true;
        child.userData = {
          ...(child.userData || {}),
          isSharedGeometry: true,
          isSharedPBR: true,
          geoVolume: volume
        };
      }
    });

    // Compute native bounding box of the physical 3D model meshes (excluding ContactShadowPlane)
    templateScene.updateMatrixWorld(true);
    const bodyBox = new THREE.Box3();
    let hasBodyMesh = false;

    templateScene.traverse((child) => {
      if (child.isMesh && child.name !== 'ContactShadowPlane' && !child.userData?.isContactShadow) {
        bodyBox.expandByObject(child);
        hasBodyMesh = true;
      }
    });

    if (!hasBodyMesh) {
      bodyBox.setFromObject(templateScene);
    }

    const nativeW = Math.max(0.05, isFinite(bodyBox.max.x - bodyBox.min.x) ? (bodyBox.max.x - bodyBox.min.x) : (entry.dimensions?.width || 1.0));
    const nativeH = Math.max(0.005, isFinite(bodyBox.max.y - bodyBox.min.y) ? (bodyBox.max.y - bodyBox.min.y) : (entry.dimensions?.height || 0.75));
    const nativeD = Math.max(0.05, isFinite(bodyBox.max.z - bodyBox.min.z) ? (bodyBox.max.z - bodyBox.min.z) : (entry.dimensions?.depth || 0.8));
    const minY = isFinite(bodyBox.min.y) ? bodyBox.min.y : 0;
    const centerX = isFinite(bodyBox.min.x) ? (bodyBox.min.x + bodyBox.max.x) * 0.5 : 0;
    const centerZ = isFinite(bodyBox.min.z) ? (bodyBox.min.z + bodyBox.max.z) * 0.5 : 0;

    // Ensure every template has a ContactShadowPlane child
    if (!hasContactShadow) {
      const { geo, mat } = this._getFallbackContactShadowResources();
      const shadowMesh = new THREE.Mesh(geo, mat);
      shadowMesh.name = 'ContactShadowPlane';
      shadowMesh.scale.set(nativeW * 1.04, 1, nativeD * 1.04);
      shadowMesh.position.set(centerX, minY + 0.001, centerZ);
      shadowMesh.castShadow = false;
      shadowMesh.receiveShadow = false;
      shadowMesh.userData = {
        isContactShadow: true,
        isSharedGeometry: true,
        isSharedPBR: true
      };
      templateScene.add(shadowMesh);
    }

    templateScene.userData = {
      ...(templateScene.userData || {}),
      assetId,
      isGlbTemplate: true,
      isSharedGeometry: true,
      isSharedPBR: true,
      nativeDimensions: { width: nativeW, height: nativeH, depth: nativeD }
    };

    this.templates.set(assetId, {
      assetId,
      scene: templateScene,
      nativeW,
      nativeH,
      nativeD,
      minY,
      centerX,
      centerZ,
      metadata: entry
    });
  }

  /**
   * Resolve an explicit assetId or legacy item.type / item.name to one of the 35 catalog assetIds.
   */
  resolveAssetId(assetId, targetItem = {}) {
    const candidate = assetId || targetItem?.asset_id || targetItem?.assetId;
    if (candidate && (this.templates.has(candidate) || CATALOG_ASSET_IDS.includes(candidate))) {
      return candidate;
    }

    const rawType = String(targetItem?.type || candidate || '').toLowerCase().trim();
    const rawName = String(targetItem?.name || '').toLowerCase();
    const w = targetItem?.width || 1.0;
    const d = targetItem?.depth || 0.8;
    const dimMax = Math.max(w, d);

    // Contextual refinements based on Vietnamese item names & dimensions
    if (rawType === 'sofa' || rawType === 'sofa_sectional') {
      if (rawType === 'sofa_sectional' || dimMax >= 2.25 || rawName.includes('góc') || rawName.includes('chữ l')) {
        return 'sofa_l_modern';
      }
      return 'sofa_straight_3seat';
    }

    if (rawType === 'kitchen_cabinet') {
      if (rawName.includes('giặt') || rawName.includes('sấy')) {
        return 'washer_dryer_tower';
      }
      if (rawName.includes('đảo') || rawName.includes('bar')) {
        return 'kitchen_island_bar';
      }
      if (rawName.includes('tủ lạnh') && dimMax < 1.2) {
        return 'fridge_double_door';
      }
      if (Math.min(w, d) >= 1.15 || rawName.includes('chữ l')) {
        return 'kitchen_system_l';
      }
      return 'kitchen_system_l';
    }

    if (rawType === 'dining_table') {
      if (rawName.includes('sân thượng') || rawName.includes('ngoài trời') || rawName.includes('sky')) {
        return 'outdoor_patio_set';
      }
      if (dimMax < 1.55 || rawName.includes('4 ghế')) {
        return 'dining_table_4chairs';
      }
      return 'dining_table_6chairs';
    }

    if (rawType === 'bed' || rawType === 'bed_master') {
      if (rawName.includes('tầng') || rawName.includes('trẻ em') || rawName.includes('bunk')) {
        return 'bed_bunk_kids';
      }
      if (rawType === 'bed_master' || rawName.includes('master') || rawName.includes('king') || dimMax >= 1.95) {
        return 'bed_master_king';
      }
      return 'bed_queen_modern';
    }

    if (rawType === 'desk') {
      if (rawName.includes('trang điểm') || rawName.includes('phấn')) {
        return 'dressing_table_mirror';
      }
      return 'work_desk_computer';
    }

    if (rawType === 'plants' || rawType === 'planter') {
      if (rawType === 'planter' || rawName.includes('ban công') || rawName.includes('luống')) {
        return 'balcony_planter_greenery';
      }
      return 'indoor_potted_ficus';
    }

    if (LEGACY_TYPE_TO_ASSET_ID[rawType]) {
      return LEGACY_TYPE_TO_ASSET_ID[rawType];
    }

    return 'entrance_shoe_cabinet';
  }

  static resolveAssetId(assetId, targetItem = {}) {
    return this.getInstance().resolveAssetId(assetId, targetItem);
  }

  /**
   * Instantiate a GPU-shared shallow clone of a preloaded .glb asset,
   * scaled and rotated to fit targetItem (or fall back to FurnitureGenerator if not yet loaded).
   * Supports dual-mode: 'model' (3D procedural GLB) or 'real' (photorealistic impostor GLB).
   *
   * @param {string} assetId
   * @param {Object} [targetItem]
   * @param {Object} [materials]
   * @param {Object} [options]
   * @param {string} [options.furnitureMode] - 'model' | 'real'
   * @returns {THREE.Group}
   */
  instantiateAsset(assetId, targetItem = {}, materials = null, options = {}) {
    const furnMode = options.furnitureMode || targetItem.furnitureMode || this.furnitureMode || 'model';
    let resolvedId = this.resolveAssetId(assetId, targetItem);

    if (furnMode === 'real') {
      if (this.variantOfMap.has(resolvedId)) {
        const realCandidate = this.variantOfMap.get(resolvedId);
        if (this.templates.has(realCandidate)) {
          resolvedId = realCandidate;
        }
      }
    }

    const tpl = this.templates.get(resolvedId);

    if (!tpl) {
      // Fallback to procedural FurnitureGenerator if .glb is not yet in cache
      const fallback = FurnitureGenerator.createFurnitureMesh(targetItem, materials);
      fallback.userData = {
        ...(fallback.userData || {}),
        assetId: resolvedId,
        asset_id: resolvedId,
        isGlbAsset: false
      };
      return fallback;
    }

    const root = new THREE.Group();
    root.name = `asset_${resolvedId}`;

    const inner = new THREE.Group();
    const clonedScene = tpl.scene.clone(true);

    let billboardMesh = null;

    // Ensure cloned mesh userData preserves shared flags & ContactShadowPlane metadata
    clonedScene.traverse((child) => {
      if (child.isMesh) {
        const isBillboard = child.name === 'RealFurnitureBillboard' || Boolean(child.userData?.isRealBillboard);
        if (isBillboard) {
          billboardMesh = child;
          child.userData = {
            ...(child.userData || {}),
            isRealBillboard: true,
            assetId: resolvedId
          };
        }

        const isShadow = child.name === 'ContactShadowPlane' || Boolean(child.userData?.isContactShadow);
        if (isShadow) {
          child.castShadow = false;
          child.receiveShadow = false;
        } else {
          let volume = child.userData?.geoVolume;
          if (volume === undefined && child.geometry) {
            if (!child.geometry.boundingBox) {
              child.geometry.computeBoundingBox();
            }
            if (child.geometry.boundingBox) {
              const bb = child.geometry.boundingBox;
              const dx = Math.max(0, bb.max.x - bb.min.x);
              const dy = Math.max(0, bb.max.y - bb.min.y);
              const dz = Math.max(0, bb.max.z - bb.min.z);
              volume = dx * dy * dz;
            }
          }
          child.castShadow = (volume || 0) > 0.01;
          child.receiveShadow = true;
        }
        child.userData = {
          ...(child.userData || {}),
          isContactShadow: isShadow,
          isSharedGeometry: true,
          isSharedPBR: true,
          isGlbInstance: true,
          assetId: resolvedId
        };
      }
    });

    const rawW = Math.max(0.15, targetItem.width || tpl.nativeW);
    const rawD = Math.max(0.15, targetItem.depth || tpl.nativeD);
    const rawH = Math.max(0.01, targetItem.height || tpl.nativeH);

    let targetW = rawW;
    let targetD = rawD;
    let autoRotY = 0;

    // If the template is elongated along X (e.g. sofa, wardrobe, tv console, kitchen, railing, planter)
    // and the target 2D box was specified with depth > width, align canonical width with the longer axis
    if (tpl.nativeW > tpl.nativeD * 1.28 && rawD > rawW * 1.22) {
      targetW = rawD;
      targetD = rawW;
      if (targetItem.rotation === undefined || targetItem.rotation === null) {
        autoRotY = Math.PI / 2;
      }
    }

    const rawSx = targetW / Math.max(0.05, tpl.nativeW);
    const rawSz = targetD / Math.max(0.05, tpl.nativeD);
    const rawSy = rawH / Math.max(0.005, tpl.nativeH);

    // Sensible aspect clamping so accessories (lamps, monitors, pillows, vases) never look distorted
    const sx = Math.max(0.35, Math.min(3.5, rawSx));
    const sz = Math.max(0.35, Math.min(3.5, rawSz));
    const avgHoriz = (sx + sz) * 0.5;
    const sy = resolvedId === 'floor_rug_textured'
      ? 1.0
      : Math.max(avgHoriz * 0.65, Math.min(avgHoriz * 1.45, Math.max(0.45, Math.min(2.5, rawSy))));

    clonedScene.scale.set(sx, sy, sz);
    // Center horizontally at (0, 0) and place bottom squarely at Y = 0
    clonedScene.position.set(
      -tpl.centerX * sx,
      -tpl.minY * sy,
      -tpl.centerZ * sz
    );

    inner.add(clonedScene);

    let rot = (targetItem.rotation !== undefined && targetItem.rotation !== null)
      ? targetItem.rotation
      : autoRotY;
    if (Math.abs(rot) > Math.PI * 2 + 0.01) {
      rot = (rot * Math.PI) / 180;
    }
    inner.rotation.y = rot;

    root.add(inner);
    root.userData = {
      assetId: resolvedId,
      asset_id: resolvedId,
      isGlbAsset: true,
      isSharedGeometry: true,
      isSharedPBR: true,
      isRealBillboard: Boolean(billboardMesh),
      billboardMesh: billboardMesh
    };

    return root;
  }

  static instantiateAsset(assetId, targetItem = {}, materials = null, options = {}) {
    return this.getInstance().instantiateAsset(assetId, targetItem, materials, options);
  }
}

if (typeof window !== 'undefined') {
  window.AssetLibraryManager = AssetLibraryManager;
}

export const assetLibraryManager = AssetLibraryManager.getInstance();
export default AssetLibraryManager;
