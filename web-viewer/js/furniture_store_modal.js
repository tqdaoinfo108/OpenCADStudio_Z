import { Isometric3DThumbnailRenderer } from './furniture_thumbnail_renderer.js';
/**
 * furniture_store_modal.js
 * OpenCADStudio_Z / Nếp Nhà - Modular 3D Asset Studio & Inspector
 * 
 * Features:
 * - 3-Column Studio Layout:
 *   1. Left Sidebar: Instant search, category filters with model counts, AI mount rule filters with counts.
 *   2. Center Area: Modular furniture cards grid with sharp thumbnails, Vietnamese names, real WxDxH dims,
 *      polycount badges (triangle counts & optimization status), and AI semantic tags.
 *   3. Right Inspector & Calibration Studio: Dedicated Three.js 3D Turntable canvas (360° interactive orbit,
 *      1m x 1m reference grid, Front +Z & Back Wall -Z orientation arrows, bottom-center pivot marker).
 * - 1-Click Asset Normalizer Suite:
 *   * Rotate 90° standard orientation (-Z back wall alignment).
 *   * Snap Bottom-Center Pivot (0,0,0 at bottom face center).
 *   * Auto-measure 3D Bounding Box.
 *   * Capture high-res thumbnail directly from 3D turntable canvas.
 *   * Export and save calibrated .glb.
 * - Direct metadata editing with SQLite persistence (/api/furniture-assets).
 * - Fast drag & drop ingest for new .glb models with auto-dimensioning and thumbnailing.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FurnitureGenerator } from './furniture_generator.js';

export class FurnitureStoreModal {
  constructor(options = {}) {
    this.viewer = options.viewer || null;
    this.onAssetAdded = options.onAssetAdded || null;

    this.assets = [];
    this.filteredAssets = [];
    this.activeType = 'all';
    this.activeCategory = 'all';
    this.placementFilter = 'all';
    this.searchQuery = '';
    this.sortOption = 'default';

    // Inspector State
    this.currentInspectedAsset = null;
    this.currentModelGroup = null;
    this.turntableRenderer = null;
    this.turntableScene = null;
    this.turntableCamera = null;
    this.turntableControls = null;
    this.turntableAnimId = null;
    this.turntableHelpersGroup = null;
    this.turntableBBoxHelper = null;
    this.isTurntableRotating = true;

    // Loaders & Exporters
    this.gltfLoader = new GLTFLoader();
    this.thumbnailRenderer = new Isometric3DThumbnailRenderer(url => this.loadGlbPromise(url));
    this.gltfExporter = new GLTFExporter();

    this.init();
  }

  async init() {
    this.bindEvents();
    this.bindFurnitureGenerator();
    this.initTurntable();
    await this.loadAssets();
  }

  // ================= TURNTABLE 3D VIEWPORT SETUP =================

  initTurntable() {
    const canvas = document.getElementById('turntable-canvas');
    const container = document.getElementById('turntable-container');
    if (!canvas || !container) return;

    const width = container.clientWidth || 380;
    const height = container.clientHeight || 240;

    // 1. Scene
    this.turntableScene = new THREE.Scene();

    // 2. Camera
    this.turntableCamera = new THREE.PerspectiveCamera(42, width / height, 0.05, 50);
    this.turntableCamera.position.set(2.4, 1.8, 2.6);

    // 3. Renderer with preserveDrawingBuffer for canvas.toDataURL()
    this.turntableRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
    this.turntableRenderer.setSize(width, height);
    this.turntableRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.turntableRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.turntableRenderer.shadowMap.enabled = true;
    this.turntableRenderer.shadowMap.type = THREE.PCFShadowMap;

    // 4. OrbitControls
    this.turntableControls = new OrbitControls(this.turntableCamera, canvas);
    this.turntableControls.enableDamping = true;
    this.turntableControls.dampingFactor = 0.08;
    this.turntableControls.autoRotate = true;
    this.turntableControls.autoRotateSpeed = 1.4;
    this.turntableControls.target.set(0, 0.45, 0);
    this.turntableControls.maxPolarAngle = Math.PI / 2 + 0.05; // Prevent viewing below ground
    this.turntableControls.minDistance = 0.4;
    this.turntableControls.maxDistance = 8.0;

    // 5. Lighting
    const hemiLight = new THREE.HemisphereLight(0xF8FAFC, 0x1E293B, 0.65);
    this.turntableScene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xFFFBEB, 1.35);
    sunLight.position.set(2.5, 4.0, 3.0);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.bias = -0.0005;
    this.turntableScene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x94A3B8, 0.55);
    fillLight.position.set(-2.5, 2.0, -2.5);
    this.turntableScene.add(fillLight);

    // 6. Helpers Group (Grid, Orientation Arrows, Pivot Ring)
    this.turntableHelpersGroup = new THREE.Group();
    this.turntableHelpersGroup.name = 'TurntableHelpers';

    // 1m x 1m Grid
    const grid = new THREE.GridHelper(3.0, 6, 0x38BDF8, 0x334155);
    grid.position.y = 0;
    this.turntableHelpersGroup.add(grid);

    // Bottom-Center Pivot Marker (0,0,0) - Gold Target Ring
    const pivotRingGeo = new THREE.RingGeometry(0.035, 0.075, 32);
    pivotRingGeo.rotateX(-Math.PI / 2);
    const pivotRingMat = new THREE.MeshBasicMaterial({
      color: 0xF59E0B,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const pivotRing = new THREE.Mesh(pivotRingGeo, pivotRingMat);
    pivotRing.position.set(0, 0.002, 0);
    this.turntableHelpersGroup.add(pivotRing);

    // Direction Guide: Front (+Z) Arrow (Green / Cyan)
    const arrowFront = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0.004, 0),
      1.15,
      0x10B981,
      0.22,
      0.10
    );
    this.turntableHelpersGroup.add(arrowFront);

    // Direction Guide: Back Wall (-Z) Arrow (Red / Amber)
    const arrowBack = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 0.004, 0),
      1.15,
      0xEF4444,
      0.22,
      0.10
    );
    this.turntableHelpersGroup.add(arrowBack);

    this.turntableScene.add(this.turntableHelpersGroup);

    // 7. Active Model Container Group
    this.currentModelGroup = new THREE.Group();
    this.currentModelGroup.name = 'ActiveInspectedModelGroup';
    this.turntableScene.add(this.currentModelGroup);

    // 8. Bounding Box Helper
    this.turntableBBoxHelper = new THREE.BoxHelper(this.currentModelGroup, 0xF59E0B);
    this.turntableBBoxHelper.visible = false;
    this.turntableScene.add(this.turntableBBoxHelper);

    // 9. Start RAF Loop
    this.startTurntableLoop();

    // 10. View Presets & Controls Event Listeners
    this.bindTurntableControls();
  }

  bindTurntableControls() {
    const btnFront = document.getElementById('btn-view-front');
    const btnBack = document.getElementById('btn-view-back');
    const btnTop = document.getElementById('btn-view-top');
    const btnIso = document.getElementById('btn-view-iso');
    const btnToggle = document.getElementById('btn-toggle-turntable');

    if (btnFront) {
      btnFront.addEventListener('click', () => {
        this.setCameraPreset(new THREE.Vector3(0, 0.85, 2.8), new THREE.Vector3(0, 0.45, 0));
      });
    }

    if (btnBack) {
      btnBack.addEventListener('click', () => {
        this.setCameraPreset(new THREE.Vector3(0, 0.85, -2.8), new THREE.Vector3(0, 0.45, 0));
      });
    }

    if (btnTop) {
      btnTop.addEventListener('click', () => {
        this.setCameraPreset(new THREE.Vector3(0, 3.2, 0.01), new THREE.Vector3(0, 0, 0));
      });
    }

    if (btnIso) {
      btnIso.addEventListener('click', () => {
        this.setCameraPreset(new THREE.Vector3(2.2, 1.8, 2.4), new THREE.Vector3(0, 0.45, 0));
      });
    }

    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        this.isTurntableRotating = !this.isTurntableRotating;
        if (this.turntableControls) {
          this.turntableControls.autoRotate = this.isTurntableRotating;
        }
        btnToggle.classList.toggle('active', this.isTurntableRotating);
        btnToggle.textContent = this.isTurntableRotating ? '🔄 Xoay' : '⏸ Dừng';
      });
    }
  }

  setCameraPreset(pos, target) {
    if (!this.turntableCamera || !this.turntableControls) return;
    this.turntableControls.autoRotate = false;
    const btnToggle = document.getElementById('btn-toggle-turntable');
    if (btnToggle) {
      btnToggle.classList.remove('active');
      btnToggle.textContent = '⏸ Dừng';
      this.isTurntableRotating = false;
    }
    this.turntableCamera.position.copy(pos);
    this.turntableControls.target.copy(target);
    this.turntableControls.update();
  }

  startTurntableLoop() {
    const tick = () => {
      this.turntableAnimId = requestAnimationFrame(tick);
      if (document.getElementById('modal-furniture-store')?.classList.contains('hidden')) return;
      if (this.turntableControls) {
        this.turntableControls.update();
      }
      if (this.turntableRenderer && this.turntableScene && this.turntableCamera) {
        this.turntableRenderer.render(this.turntableScene, this.turntableCamera);
      }
    };
    tick();
  }

  resizeTurntable() {
    const container = document.getElementById('turntable-container');
    if (!container || !this.turntableRenderer || !this.turntableCamera) return;
    const width = container.clientWidth || 380;
    const height = container.clientHeight || 240;
    this.turntableCamera.aspect = width / height;
    this.turntableCamera.updateProjectionMatrix();
    this.turntableRenderer.setSize(width, height);
  }

  // ================= EVENT BINDINGS =================

  bindEvents() {
    const openBtn = document.getElementById('btn-furniture-store');
    const closeBtn = document.getElementById('modal-furniture-close-btn');
    const searchInput = document.getElementById('furniture-store-search');
    const clearSearchBtn = document.getElementById('btn-clear-search');
    const sortSelect = document.getElementById('furniture-store-sort');
    const placementSelect = document.getElementById('furniture-store-placement-filter');

    // Add Modal Elements
    const openAddBtn = document.getElementById('btn-open-add-furniture');
    const closeAddBtn = document.getElementById('modal-add-furniture-close-btn');
    const cancelAddBtn = document.getElementById('btn-cancel-add-furniture');
    const formAdd = document.getElementById('form-add-furniture');

    // Inspector Edit Form & Normalizer Buttons
    const formInspector = document.getElementById('form-inspector-edit');
    const btnNormRotate = document.getElementById('btn-norm-rotate-90');
    const btnNormSnapPivot = document.getElementById('btn-norm-snap-pivot');
    const btnNormMeasure = document.getElementById('btn-norm-measure');
    const btnNormSaveGlb = document.getElementById('btn-norm-save-glb');

    // Dropzone Fast Ingest
    const dropzone = document.getElementById('inspector-dropzone');
    const fileInput = document.getElementById('inspector-file-input');

    if (openBtn) openBtn.addEventListener('click', () => this.open());
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    // Dual-Mode Type Tabs: Tất cả vs Mô hình 3D vs Nội thất thật
    const typeTabs = document.querySelectorAll('.store-type-tab-btn');
    typeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        typeTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeType = tab.getAttribute('data-type') || 'all';
        this.applyFilters();
      });
    });

    // Vertical Category Filter List
    const categoryTabs = document.querySelectorAll('.store-category-tabs .store-tab-btn');
    categoryTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        categoryTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeCategory = tab.getAttribute('data-category') || 'all';
        this.applyFilters();
      });
    });

    // Vertical Placement Filter List (AI Mount Type)
    const placementBtns = document.querySelectorAll('.store-placement-list .store-placement-btn');
    placementBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        placementBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.placementFilter = btn.getAttribute('data-placement') || 'all';
        if (placementSelect) placementSelect.value = this.placementFilter;
        this.applyFilters();
      });
    });

    if (placementSelect) {
      placementSelect.addEventListener('change', (e) => {
        this.placementFilter = e.target.value;
        this.applyFilters();
      });
    }

    // Instant Search Input
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase().trim();
        if (clearSearchBtn) {
          clearSearchBtn.classList.toggle('hidden', !this.searchQuery);
        }
        this.applyFilters();
      });
    }

    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        this.searchQuery = '';
        clearSearchBtn.classList.add('hidden');
        this.applyFilters();
      });
    }

    // Sort Dropdown
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        this.sortOption = e.target.value;
        this.applyFilters();
      });
    }

    // Inspector Metadata Form Submit
    if (formInspector) {
      formInspector.addEventListener('submit', (e) => this.handleInspectorSave(e));
    }

    // 1-Click Normalizer Suite Handlers
    if (btnNormRotate) {
      btnNormRotate.addEventListener('click', () => this.normalizeRotate90());
    }

    if (btnNormSnapPivot) {
      btnNormSnapPivot.addEventListener('click', () => this.normalizeSnapPivot());
    }

    if (btnNormMeasure) {
      btnNormMeasure.addEventListener('click', () => this.normalizeAutoMeasure());
    }

    if (btnNormSaveGlb) {
      btnNormSaveGlb.addEventListener('click', () => this.normalizeExportGlb());
    }

    // Dropzone Ingest
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const file = e.dataTransfer.files ? e.dataTransfer.files[0] : null;
        if (file) this.handleGlbFileDrop(file);
      });
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files ? e.target.files[0] : null;
        if (file) this.handleGlbFileDrop(file);
      });
    }

    // Sub-Modal: Add Custom Model Events
    if (openAddBtn) openAddBtn.addEventListener('click', () => this.openAddModal());
    if (closeAddBtn) closeAddBtn.addEventListener('click', () => this.closeAddModal());
    if (cancelAddBtn) cancelAddBtn.addEventListener('click', () => this.closeAddModal());
    if (formAdd) formAdd.addEventListener('submit', (e) => this.handleAddFurnitureSubmit(e));

    // Handle Window Resize for Turntable
    window.addEventListener('resize', () => {
      const modal = document.getElementById('modal-furniture-store');
      if (modal && !modal.classList.contains('hidden')) {
        this.resizeTurntable();
      }
    });
  }

  // ================= DATA LOADING & NORMALIZATION =================

  bindFurnitureGenerator() {
    const dialog = document.getElementById('generate-furniture-dialog');
    if (!dialog) return;
    const form = document.getElementById('generate-furniture-form');
    const prompt = document.getElementById('generate-furniture-prompt');
    const status = document.getElementById('generate-furniture-status');
    const submit = form.querySelector('[type=submit]');
    document.getElementById('btn-generate-furniture').onclick = () => dialog.showModal();
    document.getElementById('generate-furniture-close').onclick = () => dialog.close();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      status.textContent = 'Đang tạo blueprint và đóng gói GLB…';
      try {
        const response = await fetch('/api/furniture-assets/generate', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt:prompt.value})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Không thể tạo mẫu.');
        const asset = this.normalizeAsset(result.data);
        this.assets.unshift(asset);
        this.activeCategory = this.activeType = this.placementFilter = 'all';
        this.searchQuery = '';
        this.sortOption = 'default';
        const sort = document.getElementById('furniture-store-sort');
        if (sort) sort.value = 'default';
        const search = document.getElementById('furniture-store-search');
        if (search) search.value = '';
        this.applyFilters();
        await this.inspectAsset(asset);
        await this.viewer?.assetLibrary?.loadRegisteredAsset(result.data);
        const card = document.querySelector('.furniture-item-card.active-inspected');
        const canvas = card?.querySelector('canvas');
        if (canvas) this.thumbnailRenderer.draw(canvas, asset.glb_path);
        form.reset();
        status.textContent = '';
        dialog.close();
        card?.scrollIntoView({ block:'center' });
        this.showToast('Đã lưu mẫu GLB vào Kho Nội Thất.');
      } catch (error) {
        status.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
  }

  async loadAssets() {
    try {
      const res = await fetch('/api/furniture-assets?type=all');
      if (res.ok) {
        const json = await res.json();
        const list = Array.isArray(json) ? json : (json.data || json.assets || []);
        if (Array.isArray(list) && list.length > 0) {
          this.assets = list.filter(item => item.asset_type !== 'real').map(item => this.normalizeAsset(item));
          this.applyFilters();
          this.autoInspectFirstAsset();
          return;
        }
      }
    } catch {
      // Fallback to static catalog if backend route not ready
    }

    // Fallback to the static GLB catalog
    try {
      const loaded = [];
      const resCat = await fetch('/assets/models/asset_catalog.json');
      if (resCat.ok) {
        const catalog = await resCat.json();
        loaded.push(...(catalog.assets || []).map(item => this.normalizeAsset({ ...item, asset_type: 'model' })));
      }

      if (loaded.length > 0) {
        this.assets = loaded;
      }
    } catch (err) {
      console.warn('Could not load fallback catalogs:', err);
    }

    this.applyFilters();
    this.autoInspectFirstAsset();
  }

  normalizeAsset(item) {
    const dims = item.dimensions || {};
    const w = dims.width || dims.nativeWidth || 1.0;
    const d = dims.depth || dims.nativeDepth || 1.0;
    const h = dims.height || dims.nativeHeight || 1.0;

    // Map category
    let cat = item.category || 'living';
    if (cat === 'living_room') cat = 'living';
    if (cat === 'kitchen_dining') cat = 'kitchen';
    if (cat === 'worship_altar' || cat === 'worship_rooftop') cat = /outdoor|patio|bbq/.test(item.asset_id || item.id) ? 'balcony' : 'worship';
    if (cat === 'bathroom_laundry') cat = 'bathroom';
    if (cat === 'balcony_outdoor' || cat === 'architectural' || cat === 'greenery' || cat === 'greenery_architectural') cat = 'balcony';

    // Infer placement rule if missing
    let placement = item.placement_type === 'floor_free' ? 'floor_center' : item.placement_type || 'floor_wall_backed';
    const id = (item.asset_id || item.id || '').toLowerCase();
    if (id.includes('dining_table') || id.includes('coffee_table') || id.includes('island') || id.includes('rug')) {
      placement = 'floor_center';
    } else if (id.includes('mirror') || id.includes('wall_unit') || id.includes('light_wall')) {
      placement = 'wall_mounted';
    } else if (id.includes('ceiling') || id.includes('chandelier') || id.includes('pendant')) {
      placement = 'ceiling';
    }

    const assetType = 'model';
    const defaultGlb = `/assets/models/${item.file || `${item.asset_id || item.id}.glb`}`;

    // Estimated or measured polycount
    let polycount = item.polycount || null;
    if (!polycount) {
      // Provide realistic initial estimate for fast badge rendering
      const estTris = this.estimatePolycount(cat, id);
      polycount = {
        triangles: estTris,
        vertices: Math.round(estTris * 0.65),
        status: estTris < 3500 ? 'opt' : (estTris < 12000 ? 'med' : 'heavy')
      };
    }

    return {
      id: item.id || item.asset_id,
      asset_id: item.asset_id || item.id,
      name: item.name || 'Mẫu nội thất',
      category: cat,
      asset_type: assetType,
      image_url: item.image_url || '',
      thumbnail_url: item.thumbnail_url || item.image_url || '',
      source_image_url: item.source_image_url || '',
      variant_of: item.variant_of || '',
      description: item.description || '',
      placement_type: placement,
      dimensions: {
        width: Number(Number(w).toFixed(2)),
        depth: Number(Number(d).toFixed(2)),
        height: Number(Number(h).toFixed(2))
      },
      size_x: typeof item.size_x === 'number' ? item.size_x : Number(Number(w).toFixed(2)),
      size_y: typeof item.size_y === 'number' ? item.size_y : Number(Number(h).toFixed(2)),
      size_z: typeof item.size_z === 'number' ? item.size_z : Number(Number(d).toFixed(2)),
      tags: Array.isArray(item.tags)
        ? item.tags
        : (typeof item.tags === 'string' ? item.tags.split(',').map(t => t.trim()) : [cat]),
      glb_path: item.glb_path || item.url || defaultGlb,
      is_builtin: item.is_builtin !== false && !item.is_custom,
      polycount
    };
  }

  estimatePolycount(cat, id) {
    if (id.includes('plant') || id.includes('ficus') || id.includes('greenery')) return 4850;
    if (id.includes('sofa') || id.includes('armchair')) return 2240;
    if (id.includes('bed')) return 3100;
    if (id.includes('table') || id.includes('desk')) return 880;
    if (id.includes('chair')) return 1120;
    if (id.includes('altar')) return 3400;
    if (id.includes('cabinet') || id.includes('wardrobe')) return 1450;
    if (id.includes('toilet') || id.includes('bathtub') || id.includes('lavabo')) return 2600;
    return 1650;
  }

  autoInspectFirstAsset() {
    if (!this.currentInspectedAsset && this.assets.length > 0) {
      this.inspectAsset(this.assets[0]);
    }
  }

  // ================= FILTERING, COUNTING & SORTING =================

  applyFilters() {
    this.updateFilterCounts();

    this.filteredAssets = this.assets.filter(asset => {
      // 0. Asset Type Filter
      if (this.activeType !== 'all') {
        if (asset.asset_type !== this.activeType) return false;
      }

      // 1. Category Filter
      if (this.activeCategory !== 'all') {
        if (this.activeCategory === 'balcony') {
          if (asset.category !== 'balcony' && asset.category !== 'outdoor' && asset.category !== 'architectural') {
            return false;
          }
        } else if (asset.category !== this.activeCategory) {
          return false;
        }
      }

      // 2. AI Placement Rule Filter
      if (this.placementFilter !== 'all') {
        if (this.placementFilter === 'floor_wall_backed') {
          if (asset.placement_type !== 'floor_wall_backed' && asset.placement_type !== 'wall_backed') {
            return false;
          }
        } else if (asset.placement_type !== this.placementFilter) {
          return false;
        }
      }

      // 3. Search Query Filter
      if (this.searchQuery) {
        const matchName = asset.name.toLowerCase().includes(this.searchQuery);
        const matchId = asset.asset_id.toLowerCase().includes(this.searchQuery);
        const matchTag = asset.tags.some(t => t.toLowerCase().includes(this.searchQuery));
        if (!matchName && !matchId && !matchTag) return false;
      }

      return true;
    });

    // 4. Sort Filtered Assets
    this.sortAssets();

    this.renderGrid();
  }

  sortAssets() {
    if (this.sortOption === 'name_asc') {
      this.filteredAssets.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    } else if (this.sortOption === 'name_desc') {
      this.filteredAssets.sort((a, b) => b.name.localeCompare(a.name, 'vi'));
    } else if (this.sortOption === 'volume_desc') {
      this.filteredAssets.sort((a, b) => {
        const vA = a.dimensions.width * a.dimensions.depth * a.dimensions.height;
        const vB = b.dimensions.width * b.dimensions.depth * b.dimensions.height;
        return vB - vA;
      });
    } else if (this.sortOption === 'tris_asc') {
      this.filteredAssets.sort((a, b) => {
        const tA = (a.polycount && a.polycount.triangles) || 0;
        const tB = (b.polycount && b.polycount.triangles) || 0;
        return tA - tB;
      });
    }
  }

  updateFilterCounts() {
    const total = this.assets.length;
    const modelCount = this.assets.filter(a => a.asset_type === 'model').length;
    const realCount = this.assets.filter(a => a.asset_type === 'real').length;

    // Sidebar Stats Card
    const statTotalEl = document.getElementById('stat-total-assets');
    const countModelEl = document.getElementById('count-type-model');
    const countRealEl = document.getElementById('count-type-real');
    const countAllEl = document.getElementById('count-type-all');
    const headerCountBadge = document.getElementById('furniture-store-count');

    if (statTotalEl) statTotalEl.textContent = total;
    if (countModelEl) countModelEl.textContent = modelCount;
    if (countRealEl) countRealEl.textContent = realCount;
    if (countAllEl) countAllEl.textContent = total;
    if (headerCountBadge) headerCountBadge.textContent = `${total} mẫu`;

    // Category Counts
    const cats = ['all', 'living', 'kitchen', 'bedroom', 'worship', 'bathroom', 'balcony'];
    cats.forEach(c => {
      const el = document.getElementById(`cat-count-${c}`);
      if (!el) return;
      if (c === 'all') {
        el.textContent = total;
      } else if (c === 'balcony') {
        el.textContent = this.assets.filter(a => a.category === 'balcony' || a.category === 'outdoor' || a.category === 'architectural').length;
      } else {
        el.textContent = this.assets.filter(a => a.category === c).length;
      }
    });

    // Placement Rule Counts
    const mounts = [
      { id: 'all', filter: () => true },
      { id: 'floor_wall_backed', filter: a => a.placement_type === 'floor_wall_backed' || a.placement_type === 'wall_backed' },
      { id: 'floor_center', filter: a => a.placement_type === 'floor_center' },
      { id: 'wall_mounted', filter: a => a.placement_type === 'wall_mounted' },
      { id: 'ceiling', filter: a => a.placement_type === 'ceiling' }
    ];

    mounts.forEach(m => {
      const el = document.getElementById(`mount-count-${m.id}`);
      if (el) {
        el.textContent = this.assets.filter(m.filter).length;
      }
    });
  }

  // ================= GRID RENDERING =================

  renderGrid() {
    const grid = document.getElementById('furniture-store-grid');
    const statusText = document.getElementById('grid-toolbar-status');
    if (!grid) return;

    if (statusText) {
      statusText.textContent = `Hiển thị ${this.filteredAssets.length} / ${this.assets.length} mẫu`;
    }

    grid.innerHTML = '';

    if (this.filteredAssets.length === 0) {
      grid.innerHTML = `
        <div class="store-empty-state">
          <div class="empty-icon">🔍</div>
          <h4>Không tìm thấy mẫu nội thất phù hợp</h4>
          <p>Hãy thử từ khóa khác hoặc bấm "+ Tải lên mẫu .glb mới" để đưa tài nguyên vào kho.</p>
        </div>
      `;
      return;
    }

    for (const asset of this.filteredAssets) {
      const card = document.createElement('div');
      card.className = 'furniture-item-card';
      if (this.currentInspectedAsset && this.currentInspectedAsset.asset_id === asset.asset_id) {
        card.classList.add('active-inspected');
      }

      const placementLabel = this.getPlacementLabel(asset.placement_type);
      const dims = [asset.size_x,asset.size_z,asset.size_y].map(value => Number(value).toFixed(2)).join(' × ') + ' m';
      const visualHtml = `<div class="furniture-card-img-wrap">
        <canvas class="furniture-card-thumbnail" width="512" height="512" aria-label="Hình chiếu 3D"></canvas>
        <span hidden class="thumbnail-unavailable">GLB không khả dụng</span>
      </div>`;
      const sourceBadgeHtml = '<span class="source-badge builtin">glTF</span>';

      // Polycount Badge
      const tris = (asset.polycount && asset.polycount.triangles) || this.estimatePolycount(asset.category, asset.asset_id);
      const trisText = tris >= 1000 ? `${(tris / 1000).toFixed(1)}k` : `${tris}`;
      const polyStatus = tris < 3500 ? 'opt' : (tris < 12000 ? 'med' : 'heavy');
      const polyLabel = polyStatus === 'opt' ? 'Tối ưu' : (polyStatus === 'med' ? 'Chuẩn' : 'Nặng');
      const polyBadgeHtml = `
        <span class="polycount-badge ${polyStatus}" title="${tris} Triangles - Trạng thái: ${polyLabel}">
          ⚡ ${trisText} tris
        </span>
      `;

      const variantHtml = asset.variant_of
        ? `<div class="real-variant-pill" title="Thay thế cho model 3D ${asset.variant_of}">🔄 Thay cho: <code>${asset.variant_of}</code></div>`
        : '';

      card.innerHTML = `
        <div class="furniture-card-visual">
          ${visualHtml}
          ${sourceBadgeHtml}
          ${polyBadgeHtml}
          <span class="placement-badge ${asset.placement_type}">
            ${placementLabel.icon} ${placementLabel.text}
          </span>
        </div>

        <div class="furniture-card-body">
          <h4 class="furniture-item-name" title="${asset.name}">${asset.name}</h4>
          <div class="furniture-item-code">${asset.asset_id}</div>
          ${variantHtml}

          <div class="furniture-meta-row">
            <span class="furniture-meta-lbl">Rộng (X) × Sâu (Z) × Cao (Y)</span>
            <span class="furniture-meta-val">${dims}</span>
          </div>

          <div class="furniture-tags-row">
            ${asset.tags.slice(0, 4).map(t => `<span class="furniture-tag-pill">#${t}</span>`).join('')}
          </div>
        </div>

        <div class="furniture-card-footer">
          <button class="btn-inspect-model" data-asset-id="${asset.asset_id}" title="Xem & Chuẩn hóa 3D">
            🔍 Soi 3D & Chuẩn hóa
          </button>
          <button class="btn-copy-asset-id" data-asset-id="${asset.asset_id}" title="Sao chép Asset ID">
            📋 Chép ID
          </button>
        </div>
      `;

      // Click card body to inspect
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-copy-asset-id')) return;
        this.inspectAsset(asset);
      });

      // Copy asset_id button
      const copyBtn = card.querySelector('.btn-copy-asset-id');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(asset.asset_id);
          copyBtn.textContent = '✓ Đã chép!';
          setTimeout(() => { copyBtn.textContent = '📋 Chép ID'; }, 1500);
        });
      }

      grid.appendChild(card);
      this.thumbnailRenderer.watch(card.querySelector("canvas"), asset.glb_path);
    }
  }

  getPlacementLabel(type) {
    switch (type) {
      case 'floor_wall_backed':
      case 'wall_backed':
        return { text: 'Tựa tường', icon: '🧱' };
      case 'floor_center':
        return { text: 'Giữa sàn / Tự do', icon: '📍' };
      case 'wall_mounted':
        return { text: 'Treo tường', icon: '📌' };
      case 'ceiling':
        return { text: 'Gắn trần', icon: '💡' };
      default:
        return { text: 'Sàn nhà', icon: '📐' };
    }
  }

  getCategoryIcon(cat) {
    switch (cat) {
      case 'living': return '🛋️';
      case 'kitchen': return '🍳';
      case 'bedroom': return '🛏️';
      case 'worship': return '🕯️';
      case 'bathroom': return '🚿';
      case 'balcony': return '🌿';
      default: return '📦';
    }
  }

  // ================= 3D LIVE INSPECTOR & CALIBRATION =================

  async inspectAsset(asset) {
    this.currentInspectedAsset = asset;

    // Highlight card in grid
    document.querySelectorAll('.furniture-item-card').forEach(card => {
      const codeEl = card.querySelector('.furniture-item-code');
      const isMatch = codeEl && codeEl.textContent.trim() === asset.asset_id;
      card.classList.toggle('active-inspected', isMatch);
    });

    // Populate Inspector Header
    const nameEl = document.getElementById('inspector-display-name');
    const idEl = document.getElementById('inspector-display-id');
    if (nameEl) nameEl.textContent = asset.name;
    if (idEl) idEl.textContent = asset.asset_id;

    // Populate Metadata Form
    this.populateFormWithAsset(asset);

    // Clear previous 3D mesh
    this.clearTurntableModel();

    // Load & Render 3D Model in Turntable
    await this.loadAssetIntoTurntable(asset);
  }

  populateFormWithAsset(asset) {
    const inputName = document.getElementById('inspect-name');
    const inputId = document.getElementById('inspect-id');
    const selectCat = document.getElementById('inspect-category');
    const selectPlacement = document.getElementById('inspect-placement');
    const inputW = document.getElementById('inspect-w');
    const inputD = document.getElementById('inspect-d');
    const inputH = document.getElementById('inspect-h');
    const inputTags = document.getElementById('inspect-tags');

    if (inputName) inputName.value = asset.name || '';
    if (inputId) inputId.value = asset.asset_id || '';
    if (selectCat) selectCat.value = asset.category || 'living';
    if (selectPlacement) selectPlacement.value = asset.placement_type || 'floor_wall_backed';
    if (inputW) inputW.value = asset.dimensions.width || 1.0;
    if (inputD) inputD.value = asset.dimensions.depth || 1.0;
    if (inputH) inputH.value = asset.dimensions.height || 1.0;
    if (inputTags) inputTags.value = Array.isArray(asset.tags) ? asset.tags.join(', ') : (asset.tags || '');
  }

  clearTurntableModel() {
    if (!this.currentModelGroup) return;
    while (this.currentModelGroup.children.length > 0) {
      const child = this.currentModelGroup.children[0];
      this.currentModelGroup.remove(child);
    }
    this.currentModelGroup.rotation.set(0, 0, 0);
    this.currentModelGroup.position.set(0, 0, 0);
    this.currentModelGroup.scale.set(1, 1, 1);
  }

  async loadAssetIntoTurntable(asset) {
    if (!this.currentModelGroup || !this.turntableScene) return;
    let loadedObject = null;

    // 1. Attempt loading glb file
    if (asset.glb_path) {
      try {
        const gltf = await this.loadGlbPromise(asset.glb_path);
        if (gltf && (gltf.scene || gltf.scenes[0])) {
          loadedObject = gltf.scene || gltf.scenes[0];
        }
      } catch (err) {
        console.warn(`[Studio] Could not load .glb for ${asset.asset_id}, creating procedural fallback:`, err.message);
      }
    }

    if (this.currentInspectedAsset !== asset) return;

    // 2. Fallback to procedural high-detail mesh
    if (!loadedObject) {
      loadedObject = this.createProceduralFallback(asset);
    }

    // 3. Configure shadows & materials
    loadedObject.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material) {
          child.material.side = THREE.DoubleSide;
        }
      }
    });

    this.currentModelGroup.add(loadedObject);

    // 4. Update BBox Helper & Analyze Geometry
    this.updateInspectorMetrics();

    // 5. Adjust Camera Framing
    this.frameActiveModel();
  }

  loadGlbPromise(url) {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(url, resolve, undefined, reject);
    });
  }

  createProceduralFallback(asset) {
    // Check if FurnitureGenerator has a procedural definition
    try {
      const proc = FurnitureGenerator.createFurnitureMesh({
        type: asset.asset_id,
        name: asset.name,
        dimensions: asset.dimensions
      });
      if (proc) return proc;
    } catch {}

    // Fallback rounded box representation with category material
    const w = asset.dimensions.width || 1.0;
    const d = asset.dimensions.depth || 1.0;
    const h = asset.dimensions.height || 0.8;

    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.45,
      metalness: 0.1
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h / 2;
    group.add(mesh);
    return group;
  }

  updateInspectorMetrics() {
    if (!this.currentModelGroup) return;

    // 1. Calculate Polycount
    let triangles = 0;
    let vertices = 0;

    this.currentModelGroup.traverse((child) => {
      if (child.isMesh && child.geometry) {
        const geo = child.geometry;
        if (geo.index) {
          triangles += geo.index.count / 3;
        } else if (geo.attributes.position) {
          triangles += geo.attributes.position.count / 3;
        }
        if (geo.attributes.position) {
          vertices += geo.attributes.position.count;
        }
      }
    });

    triangles = Math.round(triangles);
    vertices = Math.round(vertices);

    // 2. Calculate Bounding Box
    const bbox = new THREE.Box3().setFromObject(this.currentModelGroup);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    const w = Number(size.x.toFixed(2));
    const d = Number(size.z.toFixed(2));
    const h = Number(size.y.toFixed(2));

    // 3. Check Bottom-Center Pivot (Within 2cm tolerance)
    const centerX = (bbox.min.x + bbox.max.x) / 2;
    const centerZ = (bbox.min.z + bbox.max.z) / 2;
    const minY = bbox.min.y;
    const isCentered = Math.abs(centerX) < 0.02 && Math.abs(centerZ) < 0.02;
    const isBottomZero = Math.abs(minY) < 0.02;
    const isPivotNormalized = isCentered && isBottomZero;

    // 4. Update Metric Badges
    const trisEl = document.getElementById('metric-triangles');
    const vertsEl = document.getElementById('metric-vertices');
    const bboxEl = document.getElementById('metric-bbox');
    const pivotEl = document.getElementById('metric-pivot-status');

    const polyStatus = triangles < 3500 ? '🟢 Tối ưu' : (triangles < 12000 ? '🟡 Chuẩn' : '🔴 Nặng');
    if (trisEl) trisEl.textContent = `${triangles.toLocaleString()} (${polyStatus})`;
    if (vertsEl) vertsEl.textContent = `${vertices.toLocaleString()} đỉnh`;
    if (bboxEl) bboxEl.textContent = `${w} × ${d} × ${h} m`;
    if (pivotEl) {
      pivotEl.textContent = isPivotNormalized ? '✅ Chuẩn (0,0,0)' : '⚠️ Cần căn tâm';
      pivotEl.style.color = isPivotNormalized ? '#059669' : '#D97706';
    }

    // 5. Update BBox Helper
    if (this.turntableBBoxHelper) {
      this.turntableBBoxHelper.update();
      this.turntableBBoxHelper.visible = true;
    }

    // Store polycount on active asset
    if (this.currentInspectedAsset) {
      this.currentInspectedAsset.polycount = {
        triangles,
        vertices,
        status: triangles < 3500 ? 'opt' : (triangles < 12000 ? 'med' : 'heavy')
      };
    }
  }

  frameActiveModel() {
    if (!this.currentModelGroup || !this.turntableCamera || !this.turntableControls) return;

    const canvas = document.getElementById('turntable-canvas');
    const container = document.getElementById('turntable-container');

    // 1. In mini Three.js turntable inspector canvas, compute exact THREE.Box3().setFromObject(model)
    const bbox = new THREE.Box3().setFromObject(this.currentModelGroup);
    const center = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    bbox.getCenter(center);
    bbox.getBoundingSphere(sphere);

    // Calculate center and bounding sphere radius
    const radius = Math.max(sphere.radius, 0.25);

    // 2. Set aspect ratio (canvas.clientWidth / canvas.clientHeight)
    const canvasWidth = canvas?.clientWidth || container?.clientWidth || 380;
    const canvasHeight = canvas?.clientHeight || container?.clientHeight || 240;
    const aspect = canvasHeight > 0 ? (canvasWidth / canvasHeight) : (380 / 240);
    this.turntableCamera.aspect = aspect;

    // 3. Adjust camera.position based on radius / Math.sin((camera.fov * Math.PI / 180) / 2) with slight elevation
    const fovHalfRad = (this.turntableCamera.fov * Math.PI / 180) / 2;
    let distance = radius / Math.sin(fovHalfRad);

    // Prevent clipping or deformation on tall or wide viewports
    if (aspect < 1.0) {
      distance = distance / aspect;
    }
    const fitDistance = distance * 1.15;

    // View direction vector with slight elevation (elevation angle ~ 25 deg)
    const elevationDir = new THREE.Vector3(1.0, 0.58, 1.15).normalize();
    this.turntableCamera.position.copy(center).addScaledVector(elevationDir, fitDistance);

    // Set near/far clipping planes appropriately to avoid clipping
    this.turntableCamera.near = Math.max(0.01, fitDistance / 100);
    this.turntableCamera.far = Math.max(100, fitDistance * 20);
    this.turntableCamera.updateProjectionMatrix();

    // 4. Call camera.lookAt(center) and update OrbitControls target
    this.turntableControls.target.copy(center);
    this.turntableCamera.lookAt(center);
    this.turntableControls.update();
  }

  // ================= 1-CLICK ASSET NORMALIZER =================

  /**
   * Nút 1: "Xoay hướng chuẩn 90°"
   * Xoay hình học .glb để mặt lưng nằm đúng hướng -Z.
   */
  normalizeRotate90() {
    if (!this.currentModelGroup || !this.currentInspectedAsset) {
      alert('Vui lòng chọn mẫu nội thất để xoay!');
      return;
    }

    // Rotate 90 degrees around Y axis (clockwise)
    this.currentModelGroup.rotation.y += Math.PI / 2;

    // Swap Width and Depth in dimensions & size_x/y
    const oldW = this.currentInspectedAsset.dimensions.width;
    const oldD = this.currentInspectedAsset.dimensions.depth;
    this.currentInspectedAsset.dimensions.width = oldD;
    this.currentInspectedAsset.dimensions.depth = oldW;
    this.currentInspectedAsset.size_x = oldD;
    this.currentInspectedAsset.size_z = oldW;

    const inputW = document.getElementById('inspect-w');
    const inputD = document.getElementById('inspect-d');
    if (inputW) inputW.value = oldD;
    if (inputD) inputD.value = oldW;

    this.updateInspectorMetrics();
    this.showToast('✓ Đã xoay chuẩn 90°: Mặt lưng hướng về -Z (áp tường)!');
  }

  /**
   * Nút 2: "Căn chuẩn Tâm đáy (Snap Bottom-Center Pivot)"
   * Đưa gốc (0,0,0) về chính giữa mặt đáy tiếp giáp sàn.
   */
  normalizeSnapPivot() {
    if (!this.currentModelGroup || !this.currentInspectedAsset) {
      alert('Vui lòng chọn mẫu nội thất!');
      return;
    }

    const bbox = new THREE.Box3().setFromObject(this.currentModelGroup);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const minY = bbox.min.y;

    // Offset child mesh objects so that (0,0,0) is at bottom-center
    this.currentModelGroup.children.forEach(child => {
      child.position.x -= center.x;
      child.position.y -= minY;
      child.position.z -= center.z;
    });

    this.updateInspectorMetrics();
    this.showToast('🎯 Đã căn chuẩn tâm đáy: Gốc (0,0,0) nằm chính giữa mặt đáy!');
  }

  /**
   * Nút 3: "Tự đo kích thước 3D (Auto-Measure)"
   * Quét lại Bounding Box 3D thực tế và cập nhật form.
   */
  normalizeAutoMeasure() {
    if (!this.currentModelGroup || !this.currentInspectedAsset) return;

    const bbox = new THREE.Box3().setFromObject(this.currentModelGroup);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    const w = Number(size.x.toFixed(2));
    const d = Number(size.z.toFixed(2));
    const h = Number(size.y.toFixed(2));

    this.currentInspectedAsset.dimensions.width = w;
    this.currentInspectedAsset.dimensions.depth = d;
    this.currentInspectedAsset.dimensions.height = h;
    this.currentInspectedAsset.size_x = w;
    this.currentInspectedAsset.size_y = h;
    this.currentInspectedAsset.size_z = d;

    const inputW = document.getElementById('inspect-w');
    const inputD = document.getElementById('inspect-d');
    const inputH = document.getElementById('inspect-h');
    if (inputW) inputW.value = w;
    if (inputD) inputD.value = d;
    if (inputH) inputH.value = h;

    this.updateInspectorMetrics();
    this.showToast(`📐 Đã tự đo kích thước 3D: ${w} × ${d} × ${h} m!`);
  }

  /**
   * Nút 4: "Chụp thumbnail từ 3D canvas"
   * Chụp khung nhìn hiện tại làm ảnh đại diện sắc nét.
   */
  normalizeCaptureThumbnail() {
    if (!this.turntableRenderer || !this.turntableScene || !this.turntableCamera || !this.currentInspectedAsset) {
      return;
    }

    // 1. Temporarily hide reference grid, orientation arrows, and bbox helper
    if (this.turntableHelpersGroup) this.turntableHelpersGroup.visible = false;
    if (this.turntableBBoxHelper) this.turntableBBoxHelper.visible = false;

    // 2. Render frame
    this.turntableRenderer.render(this.turntableScene, this.turntableCamera);

    // 3. Grab DataURL PNG
    const dataUrl = this.turntableRenderer.domElement.toDataURL('image/png');

    // 4. Restore helpers
    if (this.turntableHelpersGroup) this.turntableHelpersGroup.visible = true;
    if (this.turntableBBoxHelper) this.turntableBBoxHelper.visible = true;

    // 5. Update asset thumbnail
    this.currentInspectedAsset.thumbnail_url = dataUrl;
    this.currentInspectedAsset.image_url = dataUrl;

    // 6. Update card in center grid immediately
    this.renderGrid();

    this.showToast('📸 Đã chụp thumbnail từ 3D canvas thành công!');
  }

  /**
   * Nút 5: "Lưu / Xuất File .glb Đã Chuẩn Hóa"
   * Dùng GLTFExporter xuất binary .glb và lưu lên server.
   */
  async normalizeExportGlb() {
    if (!this.currentModelGroup || !this.currentInspectedAsset) return;

    const asset = this.currentInspectedAsset;
    const saveBtn = document.getElementById('btn-norm-save-glb');
    const origHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span>⏳ Đang xuất .glb...</span>';
    }

    try {
      const glbArrayBuffer = await new Promise((resolve, reject) => {
        this.gltfExporter.parse(
          this.currentModelGroup,
          (result) => resolve(result),
          (err) => reject(err),
          { binary: true }
        );
      });

      // Convert ArrayBuffer to Base64
      let binary = '';
      const bytes = new Uint8Array(glbArrayBuffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const glbBase64 = `data:model/gltf-binary;base64,${btoa(binary)}`;

      // Save via API
      const payload = {
        name: asset.name,
        asset_id: asset.asset_id,
        category: asset.category,
        placement_type: asset.placement_type,
        dimensions: asset.dimensions,
        size_x: asset.size_x !== undefined ? asset.size_x : (asset.dimensions?.width || 1.0),
        size_y: asset.size_y !== undefined ? asset.size_y : (asset.dimensions?.height || 1.0),
        size_z: asset.size_z !== undefined ? asset.size_z : (asset.dimensions?.depth || 1.0),
        tags: asset.tags,
        glbBase64,
        thumbnail_url: asset.thumbnail_url,
        is_builtin: asset.is_builtin ? 1 : 0
      };

      await fetch('/api/furniture-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      this.showToast('💾 Đã xuất và lưu file .glb chuẩn hóa vào CSDL!');
    } catch (err) {
      console.error('Failed to export GLB:', err);
      alert('Lỗi xuất file .glb: ' + err.message);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = origHtml;
      }
    }
  }

  // ================= METADATA DIRECT EDIT & SQLITE SAVE =================

  async handleInspectorSave(e) {
    e.preventDefault();
    if (!this.currentInspectedAsset) return;

    const saveBtn = document.getElementById('btn-save-inspector-asset');
    const origHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span>⏳ Đang lưu vào SQLite Database...</span>';
    }

    try {
      const name = document.getElementById('inspect-name').value.trim();
      const assetId = document.getElementById('inspect-id').value.trim();
      const category = document.getElementById('inspect-category').value;
      const placementType = document.getElementById('inspect-placement').value;
      const width = parseFloat(document.getElementById('inspect-w').value) || 1.0;
      const depth = parseFloat(document.getElementById('inspect-d').value) || 1.0;
      const height = parseFloat(document.getElementById('inspect-h').value) || 1.0;
      const tagsStr = document.getElementById('inspect-tags').value.trim();
      const tags = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : [category];

      const payload = {
        name,
        asset_id: assetId,
        category,
        asset_type: this.currentInspectedAsset.asset_type || 'model',
        placement_type: placementType,
        dimensions: { width, depth, height },
        size_x: width,
        size_y: height,
        size_z: depth,
        tags,
        room_types: [category],
        thumbnail_url: this.currentInspectedAsset.thumbnail_url || '',
        image_url: this.currentInspectedAsset.image_url || '',
        is_builtin: this.currentInspectedAsset.is_builtin ? 1 : 0
      };

      // Call API
      const res = await fetch('/api/furniture-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error((await res.json()).error || 'Không thể cập nhật mẫu GLB.');

      // Update local asset
      Object.assign(this.currentInspectedAsset, {
        name,
        category,
        placement_type: placementType,
        dimensions: { width, depth, height },
        size_x: width,
        size_y: height,
        size_z: depth,
        tags
      });

      // Update Header Title
      const nameEl = document.getElementById('inspector-display-name');
      if (nameEl) nameEl.textContent = name;

      // Re-render and update counts
      this.applyFilters();
      this.showToast(`✓ Đã lưu cập nhật mẫu "${name}" vào SQLite Database!`);
    } catch (err) {
      console.error('Error saving asset metadata:', err);
      alert('Lỗi lưu CSDL: ' + err.message);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = origHtml;
      }
    }
  }

  // ================= FAST GLB DRAG & DROP INGEST =================

  async handleGlbFileDrop(file) {
    if (!file || !file.name.toLowerCase().endsWith('.glb')) {
      alert('Vui lòng chỉ kéo thả file mô hình định dạng Binary glTF 2.0 (.glb)!');
      return;
    }

    try {
      this.showToast(`⏳ Đang nạp và phân tích file "${file.name}"...`);

      const arrayBuffer = await file.arrayBuffer();
      const dataUrl = await this.readFileAsDataUrl(file);

      // Parse with GLTFLoader
      const gltf = await new Promise((resolve, reject) => {
        this.gltfLoader.parse(arrayBuffer, '', resolve, reject);
      });

      const loadedScene = gltf.scene || gltf.scenes[0];
      if (!loadedScene) {
        throw new Error('File .glb không chứa scene 3D hợp lệ!');
      }

      // Generate Clean Name & ID
      const baseName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
      const friendlyName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
      const assetId = 'custom_' + this.slugify(baseName);

      // Create Asset Record
      const newAsset = this.normalizeAsset({
        id: assetId,
        asset_id: assetId,
        name: friendlyName,
        category: this.activeCategory !== 'all' ? this.activeCategory : 'living',
        asset_type: 'model',
        placement_type: 'floor_wall_backed',
        dimensions: { width: 1.0, depth: 1.0, height: 1.0 },
        tags: ['custom', 'gltf'],
        is_builtin: false,
        is_custom: true
      });

      // Load into Turntable
      this.clearTurntableModel();
      loadedScene.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      this.currentModelGroup.add(loadedScene);

      // 1. Auto Snap Pivot to Bottom-Center
      this.normalizeSnapPivot();

      // 2. Auto Measure Bounding Box
      this.normalizeAutoMeasure();

      // 3. Auto Capture Thumbnail from Canvas
      this.normalizeCaptureThumbnail();

      // Unshift to assets list
      this.assets.unshift(newAsset);
      this.inspectAsset(newAsset);
      this.applyFilters();

      // Save to SQLite
      await fetch('/api/furniture-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newAsset,
          glbBase64: dataUrl,
          thumbnail_url: newAsset.thumbnail_url
        })
      });

      this.showToast(`🚀 Đã thêm mẫu "${friendlyName}" (${assetId}) vào Kho & SQLite!`);
    } catch (err) {
      console.error('Failed to ingest GLB file:', err);
      alert('Không thể nạp file .glb: ' + err.message);
    }
  }

  // ================= SUB-MODAL: ADD FURNITURE MODAL =================

  openAddModal() {
    const addModal = document.getElementById('modal-add-furniture');
    if (addModal) addModal.classList.remove('hidden');
  }

  closeAddModal() {
    const addModal = document.getElementById('modal-add-furniture');
    if (addModal) addModal.classList.add('hidden');
    const form = document.getElementById('form-add-furniture');
    if (form) form.reset();
  }

  async handleAddFurnitureSubmit(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('btn-submit-add-furniture');
    const origText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ Đang tải lên...</span>';
    }

    try {
      const assetType = 'model';
      const name = document.getElementById('add-furniture-name').value.trim();
      const assetId = document.getElementById('add-furniture-id').value.trim();
      const category = document.getElementById('add-furniture-category').value;
      const placementType = document.getElementById('add-furniture-placement').value;
      const width = parseFloat(document.getElementById('add-furniture-w').value) || 1.0;
      const depth = parseFloat(document.getElementById('add-furniture-d').value) || 1.0;
      const height = parseFloat(document.getElementById('add-furniture-h').value) || 1.0;
      const tagsStr = document.getElementById('add-furniture-tags').value.trim();
      const fileInput = document.getElementById('add-furniture-file');

      const file = fileInput.files ? fileInput.files[0] : null;
      if (!file || !/\.glb$/i.test(file.name)) throw new Error('Hãy chọn tệp .glb.');
      const glbBase64 = await this.readFileAsDataUrl(file);

      const tags = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : [category, assetType];

      const payload = {
        name,
        asset_id: assetId,
        category,
        asset_type: assetType,
        room_types: [category],
        placement_type: placementType,
        dimensions: { width, depth, height },
        size_x: width,
        size_y: height,
        size_z: depth,
        tags,
        glbBase64,
        is_builtin: 0
      };

      const res = await fetch('/api/furniture-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const resJson = await res.json();
      if (!res.ok) throw new Error(resJson.error || 'Không thể lưu mẫu GLB.');
      const saved = resJson.data || resJson;

      const createdItem = this.normalizeAsset(saved || {
        ...payload,
        id: assetId,
        is_builtin: false,
        is_custom: true
      });

      this.assets.unshift(createdItem);
      this.closeAddModal();
      this.applyFilters();
      this.inspectAsset(createdItem);

      if (this.onAssetAdded) {
        this.onAssetAdded(createdItem);
      }

      this.showToast(`✓ Đã thêm tài nguyên "${name}" vào Kho!`);
    } catch (err) {
      console.error('Error adding furniture asset:', err);
      alert('Có lỗi khi thêm mẫu: ' + err.message);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = origText;
      }
    }
  }

  // ================= UTILITIES & HELPERS =================

  open() {
    const modal = document.getElementById('modal-furniture-store');
    if (modal) {
      modal.classList.remove('hidden');
      this.applyFilters();
      setTimeout(() => this.resizeTurntable(), 80);
    }
  }

  close() {
    const modal = document.getElementById('modal-furniture-store');
    if (modal) modal.classList.add('hidden');
  }

  slugify(text) {
    return text
      .toString()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  showToast(message) {
    let toast = document.getElementById('studio-toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'studio-toast-notification';
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #0F172A;
        color: #FFFFFF;
        padding: 10px 18px;
        border-radius: 8px;
        font-size: 12.5px;
        font-weight: 600;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3);
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 8px;
        border-left: 4px solid #10B981;
        transition: all 0.3s ease;
        opacity: 0;
        transform: translateY(10px);
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }, 2800);
  }
}
