/**
 * viewer_3d.js
 * OpenCADStudio_Z: Interactive 3D Architectural Dollhouse Web Viewer
 *
 * 100% Real-time WebGL / Three.js 3D Engine:
 * - Singleton WebGLRenderer, Scene, PerspectiveCamera, and OrbitControls lifecycle
 * - Zero Memory Leak recursive scene disposal preserving cached PBR materials/textures
 * - Zero Z-Fighting (logarithmicDepthBuffer, micro-elevation offsets, polygonOffset)
 * - True 4-strip stairwell slab cutouts & segmented wall openings for doors/windows
 * - Dynamic View-Dependent Dollhouse Cutaway (dot(normal, toCamera) > 0.15)
 * - Studio PMREM environment reflections, PCFSoftShadowMap sun + contact shadow + 3000K room lights
 * - Smooth 600ms cubicOut camera transitions with instant user-input cancellation
 * - First-person 1.6m walkthrough with 360° mouse look, WASD/Arrows, and click-to-walk on slabs
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ProceduralTextureManager } from './procedural_textures.js';
import { FurnitureGenerator } from './furniture_generator.js';
import { AssetLibraryManager } from './asset_library_manager.js';

export class Viewer3D {
  constructor(canvasContainer, options = {}) {
    this.container = canvasContainer;
    this.options = options;

    // View state
    this.viewMode = 'dollhouse'; // 'dollhouse' | 'facade' | 'exploded' | 'walkthrough'
    this.interiorLightsOn = true;
    this.roomLabelsVisible = true;
    this.activeFloorId = 'floor_1';
    this.selectedObject = null;
    this.selectedObjectMesh = null;
    this.currentStage = 5; // 1: 2D AI, 2: Structure, 3: Cutaway Walls, 4: Furnishing, 5: PBR & Final
    this.explodedDistance = 4.5;

    // Three.js singletons
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.rafId = null;
    this._needsRender = true;
    this._rafScheduled = false;
    this._cutawayDirty = true;
    this._ceilingGlowDecals = [];
    this.isContextLost = false;
    this.resizeObserver = null;

    // Scene collections
    this.floorGroups = new Map(); // floorId -> THREE.Group
    this.exteriorWallEntries = []; // { wallGroup, fullWallGroup, cutawayStubMesh, normal, center, floorId, orientation }
    this.cutawayWalls = []; // References to exterior fullWallGroups for inspection/compatibility
    this.interiorLights = []; // Array of warm ceiling glow decal meshes (PointLights removed for perf)
    this.lightFixtures = []; // Array of ceiling light fixture meshes
    this.selectableObjects = []; // Array of furniture/sanitary groups for raycasting
    this.roomLabelSprites = []; // Array of 3D floating room label sprites
    this.slabMeshes = []; // Array of floor slab meshes for walkthrough click-to-walk
    this.siteGroup = null;
    this._needsGlbUpgrade = false;

    // First-person walkthrough state (1.6m eye height)
    this.walkthroughState = {
      active: false,
      position: new THREE.Vector3(2.5, 1.6, 2.5),
      yaw: 0,
      pitch: 0,
      isDraggingLook: false,
      lastPointerX: 0,
      lastPointerY: 0,
      walkTarget: null,
      keys: {
        w: false,
        a: false,
        s: false,
        d: false,
        arrowup: false,
        arrowdown: false,
        arrowleft: false,
        arrowright: false
      }
    };

    // Cached PBR Materials Library, Parametric Furniture Generator & Preloaded .glb Asset Library
    this.materials = this.initMaterials();
    this.furnitureGenerator = new FurnitureGenerator(this.materials);
    this.assetLibrary = AssetLibraryManager.getInstance();

    // Damped Camera Tweening (600ms cubicOut)
    this.tweenStartPos = new THREE.Vector3();
    this.tweenStartLookAt = new THREE.Vector3();
    this.targetCameraPos = null;
    this.targetLookAt = null;
    this.tweenStartTime = 0;
    this.tweenDuration = 600;
    this.animatingCamera = false;

    // Pointer interaction tracking
    this.pointerDownPos = { x: 0, y: 0 };

    this.init();
  }

  initMaterials() {
    const mats = ProceduralTextureManager.getMaterials();

    // Update architectural dollhouse colors to match Nếp Nhà reference palette
    if (mats.interiorPlaster) {
      mats.interiorPlaster.color.setHex(0xF5F2EB); // Warm architectural cream (#F5F2EB)
      mats.interiorPlaster.roughness = 0.78;
    }
    if (mats.cutawayCapMat) {
      mats.cutawayCapMat.color.setHex(0x3D3D3D); // Crisp dark gray section cap (#3D3D3D)
      mats.cutawayCapMat.roughness = 0.62;
    }
    if (mats.porcelainTile) {
      mats.porcelainTile.roughness = 0.25;
      mats.porcelainTile.envMapIntensity = 0.9;
    }
    if (mats.woodOakFloor) {
      mats.woodOakFloor.roughness = 0.45;
      mats.woodOakFloor.envMapIntensity = 0.7;
    }

    // Create specialized Zone-Based Room Flooring materials (shared & protected from disposal)
    if (!mats.zonePorcelainTile) {
      mats.zonePorcelainTile = new THREE.MeshStandardMaterial({
        color: 0xF5F2EC,
        map: ProceduralTextureManager.getTexture('porcelainTile'),
        bumpMap: ProceduralTextureManager.getTexture('porcelainTile'),
        bumpScale: 0.002,
        roughness: 0.25,
        metalness: 0.05,
        envMapIntensity: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      mats.zonePorcelainTile.userData = { isSharedPBR: true, materialKey: 'zonePorcelainTile' };
      mats.zonePorcelainTile.dispose = () => {};
    }

    if (!mats.zoneOakWoodFloor) {
      mats.zoneOakWoodFloor = new THREE.MeshStandardMaterial({
        color: 0xE2C9AA,
        map: ProceduralTextureManager.getTexture('woodOakFloor'),
        bumpMap: ProceduralTextureManager.getTexture('woodOakFloorBump'),
        bumpScale: 0.004,
        roughness: 0.45,
        metalness: 0.04,
        envMapIntensity: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      mats.zoneOakWoodFloor.userData = { isSharedPBR: true, materialKey: 'zoneOakWoodFloor' };
      mats.zoneOakWoodFloor.dispose = () => {};
    }

    if (!mats.zoneBathroomTile) {
      const bathTex = ProceduralTextureManager._getOrCreateCanvasTexture('bathroomAntiSlipTile', 256, 256, (ctx, w, h) => {
        ctx.fillStyle = '#D6D9DE';
        ctx.fillRect(0, 0, w, h);
        const grid = 4;
        const step = w / grid;
        for (let r = 0; r < grid; r++) {
          for (let c = 0; c < grid; c++) {
            const x = c * step;
            const y = r * step;
            ctx.fillStyle = (r + c) % 2 === 0 ? '#D9DCE1' : '#D1D5DA';
            ctx.fillRect(x + 1.5, y + 1.5, step - 3, step - 3);
            ctx.strokeStyle = '#B4B9C0';
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, step - 2, step - 2);
          }
        }
      }, { repeatX: 4, repeatY: 4 });

      mats.zoneBathroomTile = new THREE.MeshStandardMaterial({
        color: 0xD8DCE0,
        map: bathTex,
        bumpMap: bathTex,
        bumpScale: 0.0025,
        roughness: 0.72,
        metalness: 0.03,
        envMapIntensity: 0.45,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      mats.zoneBathroomTile.userData = { isSharedPBR: true, materialKey: 'zoneBathroomTile' };
      mats.zoneBathroomTile.dispose = () => {};
    }

    if (!mats.zoneOutdoorSlateTile) {
      const slateTex = ProceduralTextureManager._getOrCreateCanvasTexture('outdoorSlateTile', 256, 256, (ctx, w, h) => {
        ctx.fillStyle = '#52565C';
        ctx.fillRect(0, 0, w, h);
        const grid = 3;
        const step = w / grid;
        for (let r = 0; r < grid; r++) {
          for (let c = 0; c < grid; c++) {
            const x = c * step;
            const y = r * step;
            ctx.fillStyle = (r + c) % 2 === 0 ? '#575B62' : '#4D5157';
            ctx.fillRect(x + 2, y + 2, step - 4, step - 4);
            ctx.strokeStyle = '#383B40';
            ctx.lineWidth = 2.5;
            ctx.strokeRect(x + 1, y + 1, step - 2, step - 2);
          }
        }
      }, { repeatX: 4, repeatY: 4 });

      mats.zoneOutdoorSlateTile = new THREE.MeshStandardMaterial({
        color: 0x585C62,
        map: slateTex,
        bumpMap: slateTex,
        bumpScale: 0.0035,
        roughness: 0.65,
        metalness: 0.06,
        envMapIntensity: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      mats.zoneOutdoorSlateTile.userData = { isSharedPBR: true, materialKey: 'zoneOutdoorSlateTile' };
      mats.zoneOutdoorSlateTile.dispose = () => {};
    }

    return mats;
  }

  init() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xF4F2EC);
    this.scene.fog = new THREE.FogExp2(0xF4F2EC, 0.0065);

    // 2. Camera (near = 0.15, far = 250 for zero Z-fighting)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.15, 250);
    this.camera.position.set(18, 16, -16);

    // 3. Renderer (logarithmicDepthBuffer + high-performance + ACESFilmic + SRGBColorSpace)
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    // 4. Studio Environment Map (RoomEnvironment + PMREMGenerator) for realistic PBR reflections
    this.envMap = this.createRoomStudioEnvironment();
    if (this.envMap) {
      this.scene.environment = this.envMap;
      if ('environmentIntensity' in this.scene) {
        this.scene.environmentIntensity = 0.72;
      }
    }

    // 5. OrbitControls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 120;
    this.controls.target.set(5.0, 3.0, 6.0);

    // 6. Architectural Lighting & Contact Shadows
    this.setupLighting();
    this.renderer.shadowMap.autoUpdate = false;

    // 7. Lifecycle & Input Event Listeners
    this.setupEventListeners();

    // 8. Preload 35 .glb Assets in parallel & auto-upgrade scene if loadBimScene ran early
    this.assetLibrary.onReady(() => {
      if (this.bimData && this._needsGlbUpgrade) {
        this._needsGlbUpgrade = false;
        this.loadBimScene(this.bimData, { preserveCamera: true });
      }
    });
    this.assetLibrary.preloadAll((loaded, total, assetId) => {
      if (this.options.onAssetPreloadProgress) {
        this.options.onAssetPreloadProgress(loaded, total, assetId);
      }
    });

    // 9. Start Render Loop
    this.animate();
  }

  createRoomStudioEnvironment() {
    try {
      if (this.renderer && typeof THREE.PMREMGenerator === 'function') {
        const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        pmremGenerator.compileEquirectangularShader();
        const roomEnv = new RoomEnvironment(this.renderer);
        const renderTarget = pmremGenerator.fromScene(roomEnv, 0.04);
        const envTex = renderTarget.texture;
        envTex.userData = { isSharedPBR: true, textureKey: 'roomEnvironmentPMREM' };
        envTex.dispose = () => {};
        if (typeof roomEnv.dispose === 'function') {
          roomEnv.dispose();
        }
        pmremGenerator.dispose();
        return envTex;
      }
    } catch {
      // Fallback to procedural studio environment
    }
    return ProceduralTextureManager.createStudioEnvMap(this.renderer);
  }

  setupEventListeners() {
    const canvas = this.renderer.domElement;

    // WebGL Context Lost / Restored recovery
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.isContextLost = true;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
      this.isContextLost = false;
      ProceduralTextureManager._envMap = null;
      this.envMap = ProceduralTextureManager.createStudioEnvMap(this.renderer);
      if (this.envMap) {
        this.scene.environment = this.envMap;
      }
      if (this.bimData) {
        this.loadBimScene(this.bimData, { preserveCamera: true });
      }
      this._cutawayDirty = true;
      this._invalidateShadowMap();
      this.invalidate();
    }, false);

    // OrbitControls event listeners for demand-driven rendering and adaptive pixel ratio
    if (this.controls) {
      this.controls.addEventListener('start', () => {
        const dpr = window.devicePixelRatio || 1;
        if (dpr > 1.2) {
          this.renderer.setPixelRatio(1.0);
        }
        this.invalidate();
      });

      this.controls.addEventListener('change', () => {
        this._cutawayDirty = true;
        this.invalidate();
      });

      this.controls.addEventListener('end', () => {
        const dpr = window.devicePixelRatio || 1;
        this.renderer.setPixelRatio(Math.min(dpr, 1.5));
        this.invalidate();
      });
    }

    // ResizeObserver on container + window resize fallback
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onWindowResize());
      this.resizeObserver.observe(this.container);
    }
    window.addEventListener('resize', () => this.onWindowResize());

    // Cancel camera tween immediately when user scrolls wheel
    canvas.addEventListener('wheel', () => {
      this.animatingCamera = false;
      this._cutawayDirty = true;
      this.invalidate();
    }, { passive: true });

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  setupLighting() {
    // 1. Hemisphere Light (Warm sky 0xFFFBF2 + soft ground bounce 0xDDD6C7)
    this.hemiLight = new THREE.HemisphereLight(0xFFFBF2, 0xDDD6C7, 0.72);
    this.hemiLight.position.set(0, 50, 0);
    this.scene.add(this.hemiLight);

    // 2. Main Sun DirectionalLight (1024x1024 PCFShadowMap)
    this.sunLight = new THREE.DirectionalLight(0xFFF6E5, 1.38);
    this.sunLight.position.set(24, 38, -22);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 1.0;
    this.sunLight.shadow.camera.far = 140;
    const d = 28;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.02;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // 3. Secondary Soft Fill DirectionalLight (no shadow cost)
    this.fillLight = new THREE.DirectionalLight(0xE8F1F8, 0.35);
    this.fillLight.position.set(-20, 22, 24);
    this.scene.add(this.fillLight);

    // 4. Outer Ground Plane (y = -0.19m below structural slabs)
    const groundGeo = new THREE.PlaneGeometry(220, 220);
    groundGeo.userData = { isSharedGeometry: true };
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xEAE6DD,
      roughness: 0.92,
      metalness: 0.0,
      userData: { isSharedPBR: true }
    });
    this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.groundMesh.position.y = -0.19;
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);

    // 5. Contact Shadow Catcher Plane at y = -0.01m under Floor 1
    const shadowCatcherGeo = new THREE.PlaneGeometry(60, 60);
    shadowCatcherGeo.userData = { isSharedGeometry: true };
    const shadowCatcherMat = new THREE.ShadowMaterial({
      opacity: 0.22,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });
    shadowCatcherMat.userData = { isSharedPBR: true };
    this.contactShadowPlane = new THREE.Mesh(shadowCatcherGeo, shadowCatcherMat);
    this.contactShadowPlane.rotation.x = -Math.PI / 2;
    this.contactShadowPlane.position.set(7.5, -0.01, 10.0);
    this.contactShadowPlane.receiveShadow = true;
    this.scene.add(this.contactShadowPlane);
  }

  /**
   * Dynamically size sun shadow frustum around the active building
   */
  updateLightingForBuilding() {
    if (!this.bimData || !this.sunLight) return;
    const lotW = this.bimData.metadata?.lot_width || 12.0;
    const lotL = this.bimData.metadata?.lot_length || 16.0;
    const cx = lotW / 2;
    const cy = lotL / 2;
    const maxFloorElev = this.bimData.floors.reduce(
      (max, f) => Math.max(max, (f.elevation || 0) + (f.height || 3.6)),
      12.0
    );

    const span = Math.max(lotW, lotL, maxFloorElev) * 1.15 + 6.0;
    this.sunLight.target.position.set(cx, maxFloorElev * 0.35, cy);
    this.sunLight.position.set(cx + span * 0.85, span * 1.45, cy - span * 0.9);
    this.sunLight.shadow.camera.left = -span;
    this.sunLight.shadow.camera.right = span;
    this.sunLight.shadow.camera.top = span;
    this.sunLight.shadow.camera.bottom = -span;
    this.sunLight.shadow.camera.far = span * 3.5;
    this.sunLight.shadow.camera.updateProjectionMatrix();

    if (this.contactShadowPlane) {
      this.contactShadowPlane.position.set(cx, -0.01, cy);
    }
  }

  /**
   * Recursively traverse a removed scene group and dispose per-scene geometries
   * and unique transient textures/materials (e.g. Sprite CanvasTextures) while
   * keeping shared cached PBR materials and textures intact.
   */
  disposeSceneGroup(group) {
    if (!group) return;
    group.traverse((child) => {
      if (child.geometry) {
        const gUser = child.geometry.userData || {};
        if (!gUser.isSharedGeometry && !gUser.isSharedPBR) {
          child.geometry.dispose();
        }
      }
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
          if (!mat) continue;
          if (!ProceduralTextureManager.isSharedMaterial(mat) && !mat.userData?.isSharedPBR) {
            if (mat.map && !ProceduralTextureManager.isSharedTexture(mat.map) && !mat.map.userData?.isSharedPBR) {
              mat.map.dispose();
            }
            mat.dispose();
          }
        }
      }
    });
  }

  clearScene() {
    for (const [_, group] of this.floorGroups) {
      this.scene.remove(group);
      this.disposeSceneGroup(group);
    }
    this.floorGroups.clear();

    if (this.siteGroup) {
      this.scene.remove(this.siteGroup);
      this.disposeSceneGroup(this.siteGroup);
      this.siteGroup = null;
    }

    if (this.selectedObjectMesh) {
      this.scene.remove(this.selectedObjectMesh);
      this.disposeSceneGroup(this.selectedObjectMesh);
      this.selectedObjectMesh = null;
    }

    this.selectedObject = null;
    this.exteriorWallEntries = [];
    this.cutawayWalls = [];
    this.interiorLights = [];
    this._ceilingGlowDecals = [];
    this.lightFixtures = [];
    this.selectableObjects = [];
    this.roomLabelSprites = [];
    this.slabMeshes = [];
  }

  /**
   * Load and build complete 3D BIM scene graph
   * @param {Object} bimSceneGraph
   * @param {Object} [opts]
   */
  loadBimScene(bimSceneGraph, opts = {}) {
    this.clearScene();
    this.bimData = bimSceneGraph;
    this.activeFloorId = bimSceneGraph.floors[0]?.id || 'floor_1';

    this.updateLightingForBuilding();

    // 1. Site / Landscaping
    this.buildSite(bimSceneGraph.site, bimSceneGraph.metadata);

    // 2. Floors
    for (let idx = 0; idx < bimSceneGraph.floors.length; idx++) {
      const floor = bimSceneGraph.floors[idx];
      const floorGroup = new THREE.Group();
      floorGroup.name = floor.id;
      floorGroup.userData = {
        floorId: floor.id,
        floorIndex: idx,
        floorName: floor.name,
        elevation: floor.elevation
      };

      // Structural Slab (-0.18m to -0.002m) & Finished Floor (y=0.0m) with Stairwell Cutout
      this.buildFloorSlab(floor, floorGroup, idx);

      // Columns
      this.buildColumns(floor, floorGroup);

      // Walls (Exterior Dynamic Cutaway Walls + Segmented Openings + Interior Walls + Baseboards)
      this.buildWalls(floor, floorGroup, idx);

      // Detailed 3D Staircases
      this.buildStairs(floor, floorGroup);

      // Remaining Standalone Doors & Windows
      this.buildDoorsAndWindows(floor, floorGroup);

      // High-Detail Parametric 3D Furniture & Sanitary Fixtures
      this.buildFurniture(floor, floorGroup);

      // Floating 3D Room Labels
      this.buildRoomLabels(floor, floorGroup);

      // Per-Room Warm 3000K PointLights & Emissive Ceiling Fixtures
      this.buildInteriorLights(floor, floorGroup);

      // Stage 1: AI Detection 2D Overlay (y = +0.006m)
      this.buildAiDetectionOverlay(floor, floorGroup);

      floorGroup.position.y = floor.elevation;
      this.scene.add(floorGroup);
      this.floorGroups.set(floor.id, floorGroup);
    }

    // Apply active view mode, rendering stage, lights, and labels
    this.setRenderingStage(this.currentStage, { skipCamera: true });
    this.setInteriorLights(this.interiorLightsOn);
    this.setRoomLabelsVisible(this.roomLabelsVisible);

    if (!opts.preserveCamera) {
      this.setViewMode(this.viewMode);
    } else {
      this._cutawayDirty = true;
      this.updateDynamicCutaway();
    }
    this._cutawayDirty = true;
    this._invalidateShadowMap();
  }

  buildSite(siteData, metadata = {}) {
    this.siteGroup = new THREE.Group();
    this.siteGroup.name = 'site_landscape';

    const lotW = metadata.lot_width || 15.0;
    const lotL = metadata.lot_length || 24.0;
    const pad = 2.4;

    // Site lot plinth below structural slab (-0.185m to -0.025m)
    const lotGeo = new THREE.BoxGeometry(lotW + pad * 2, 0.16, lotL + pad * 2);
    const lotMesh = new THREE.Mesh(lotGeo, this.materials.grassGround);
    lotMesh.position.set(lotW / 2, -0.105, lotL / 2);
    lotMesh.receiveShadow = true;
    this.siteGroup.add(lotMesh);

    // Stone perimeter curb
    const borderGeo = new THREE.BoxGeometry(lotW + pad * 2 + 0.16, 0.14, lotL + pad * 2 + 0.16);
    const borderMesh = new THREE.Mesh(borderGeo, this.materials.concreteSlab);
    borderMesh.position.set(lotW / 2, -0.12, lotL / 2);
    borderMesh.receiveShadow = true;
    this.siteGroup.add(borderMesh);

    // Trees
    if (siteData && siteData.trees) {
      for (const t of siteData.trees) {
        const tree = this.createTreeModel(t.radius || 0.8);
        tree.position.set(t.x, -0.025, t.y);
        this.siteGroup.add(tree);
      }
    }

    // Swimming pool / Koi pond features
    if (siteData && siteData.features) {
      for (const f of siteData.features) {
        const fw = (f.maxX !== undefined && f.minX !== undefined) ? (f.maxX - f.minX) : 2.2;
        const fd = (f.maxY !== undefined && f.minY !== undefined) ? (f.maxY - f.minY) : 3.8;
        const fcx = (f.maxX !== undefined && f.minX !== undefined) ? (f.minX + f.maxX) / 2 : lotW * 0.75;
        const fcy = (f.maxY !== undefined && f.minY !== undefined) ? (f.minY + f.maxY) / 2 : lotL * 0.35;

        // Marble coping border around pool/pond
        const copingGeo = new THREE.BoxGeometry(fw + 0.28, 0.12, fd + 0.28);
        const coping = new THREE.Mesh(copingGeo, this.materials.marbleCarrara);
        coping.position.set(fcx, -0.02, fcy);
        coping.receiveShadow = true;

        const waterGeo = new THREE.BoxGeometry(fw, 0.14, fd);
        const water = new THREE.Mesh(waterGeo, this.materials.waterSurface);
        water.position.set(fcx, -0.005, fcy);
        this.siteGroup.add(coping, water);
      }
    }

    this.scene.add(this.siteGroup);
  }

  createTreeModel(radius = 0.8) {
    const tree = new THREE.Group();
    const scale = Math.max(0.65, Math.min(1.35, radius));

    const trunkGeo = new THREE.CylinderGeometry(0.10 * scale, 0.15 * scale, 1.7 * scale, 8);
    const trunk = new THREE.Mesh(trunkGeo, this.materials.woodWalnut);
    trunk.position.y = 0.85 * scale;
    trunk.castShadow = true;
    tree.add(trunk);

    const canopyMain = new THREE.Mesh(
      new THREE.DodecahedronGeometry(1.05 * scale, 1),
      this.materials.treeFoliage
    );
    canopyMain.position.y = 2.15 * scale;
    canopyMain.castShadow = false;
    canopyMain.receiveShadow = true;

    const canopySub = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.75 * scale, 1),
      this.materials.plantFoliageLight
    );
    canopySub.position.set(0.35 * scale, 2.55 * scale, 0.25 * scale);
    canopySub.castShadow = false;

    tree.add(canopyMain, canopySub);
    return tree;
  }

  /**
   * Build structural slab (y = -0.18m to -0.002m), base finished floor surface (y = 0.0m),
   * and Zone-Based Room Flooring patches (y = 0.0012m) partitioned by room function,
   * splitting upper floors into up to 4 non-overlapping rectangular strips around the stairwell void!
   */
  buildFloorSlab(floor, group, floorIdx = 0) {
    const finishMat = (floorIdx === 0 || floor.id === 'floor_1')
      ? this.materials.porcelainTile
      : this.materials.woodOakFloor;

    // Determine stairwell void cutout box on upper floors
    let stairHole = null;
    if (floorIdx > 0 || floor.id !== 'floor_1') {
      const slabWithHole = floor.slabs.find(s => s.stairOpening);
      if (slabWithHole && slabWithHole.stairOpening) {
        stairHole = slabWithHole.stairOpening;
      } else if (floor.stairs && floor.stairs.length > 0) {
        const st = floor.stairs[0];
        stairHole = {
          minX: st.x - st.width / 2,
          maxX: st.x + st.width / 2,
          minY: st.y - st.depth / 2,
          maxY: st.y + st.depth / 2
        };
      }
    }

    const addSlabRect = (minX, maxX, minY, maxY) => {
      const w = maxX - minX;
      const d = maxY - minY;
      if (w < 0.05 || d < 0.05) return;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      // 1. Structural Slab Box from y = -0.18m to y = -0.002m (height = 0.178m, center = -0.091m)
      const slabH = 0.178;
      const slabGeo = new THREE.BoxGeometry(w, slabH, d);
      const slabMesh = new THREE.Mesh(slabGeo, this.materials.concreteSlab);
      slabMesh.position.set(cx, -0.091, cy);
      slabMesh.receiveShadow = true;
      slabMesh.castShadow = true;
      slabMesh.userData = { bimCategory: 'structure', floorId: floor.id, isSlab: true };
      group.add(slabMesh);
      this.slabMeshes.push(slabMesh);

      // 2. Finished Floor Surface at y = 0.0m (polygonOffset: 1, 1)
      const finishGeo = new THREE.PlaneGeometry(w - 0.02, d - 0.02);
      const finishMesh = new THREE.Mesh(finishGeo, finishMat);
      finishMesh.rotation.x = -Math.PI / 2;
      finishMesh.position.set(cx, 0.0, cy);
      finishMesh.receiveShadow = true;
      finishMesh.userData = { bimCategory: 'structure', floorId: floor.id, isSlab: true };
      group.add(finishMesh);
      this.slabMeshes.push(finishMesh);
    };

    for (const slab of floor.slabs) {
      if (stairHole && (slab.hasStairOpening || floorIdx > 0)) {
        const hx0 = Math.max(slab.minX, stairHole.minX);
        const hx1 = Math.min(slab.maxX, stairHole.maxX);
        const hy0 = Math.max(slab.minY, stairHole.minY);
        const hy1 = Math.min(slab.maxY, stairHole.maxY);

        if (hx1 > hx0 + 0.1 && hy1 > hy0 + 0.1) {
          // Split into up to 4 non-overlapping rectangular strips around [hx0..hx1, hy0..hy1]:
          addSlabRect(slab.minX, hx0, slab.minY, slab.maxY);
          addSlabRect(hx1, slab.maxX, slab.minY, slab.maxY);
          addSlabRect(hx0, hx1, slab.minY, hy0);
          addSlabRect(hx0, hx1, hy1, slab.maxY);

          // Add concrete curb trim + protective balustrade around stairwell opening on upper floor
          const voidEdgeH = 0.178;
          const voidFrameThick = 0.04;
          const edgeTrimFront = new THREE.Mesh(
            new THREE.BoxGeometry(hx1 - hx0, voidEdgeH, voidFrameThick),
            this.materials.concreteSlab
          );
          edgeTrimFront.position.set((hx0 + hx1) / 2, -0.091, hy0 - voidFrameThick / 2);
          edgeTrimFront.userData = { bimCategory: 'structure' };
          group.add(edgeTrimFront);

          // Protective stairwell guardrail along exposed side of void
          if (hx0 - slab.minX > 0.6) {
            const railSpan = hy1 - hy0;
            const voidRail = this.assetLibrary.instantiateAsset(
              'railing_iron_baluster',
              { width: railSpan, height: 0.96, depth: 0.06, rotation: Math.PI / 2 },
              this.materials
            );
            voidRail.position.set(hx0 - 0.04, 0.003, (hy0 + hy1) / 2);
            voidRail.traverse(c => { c.userData = { ...c.userData, bimCategory: 'walls_openings' }; });
            group.add(voidRail);
          }
          continue;
        }
      }

      addSlabRect(slab.minX, slab.maxX, slab.minY, slab.maxY);
    }

    // 3. Zone-Based Room Flooring partitioned by room function (floor.rooms)
    const primarySlab = floor.slabs[0] || { minX: 0, maxX: 10, minY: 0, maxY: 15 };
    const addZonePatchRect = (rMinX, rMaxX, rMinY, rMaxY, zoneMat, zoneType, roomName) => {
      const zw = rMaxX - rMinX;
      const zd = rMaxY - rMinY;
      if (zw < 0.25 || zd < 0.25) return;
      const zGeo = new THREE.PlaneGeometry(zw, zd);
      const zMesh = new THREE.Mesh(zGeo, zoneMat);
      zMesh.rotation.x = -Math.PI / 2;
      zMesh.position.set((rMinX + rMaxX) / 2, 0.0012, (rMinY + rMaxY) / 2);
      zMesh.receiveShadow = true;
      zMesh.userData = {
        bimCategory: 'structure',
        floorId: floor.id,
        isSlab: true,
        isZoneFloor: true,
        floorZone: zoneType,
        roomName
      };
      group.add(zMesh);
      this.slabMeshes.push(zMesh);
    };

    const addZonePatchAvoidStair = (minX, maxX, minY, maxY, zoneMat, zoneType, roomName) => {
      if (stairHole && (floorIdx > 0 || floor.id !== 'floor_1')) {
        const hx0 = Math.max(minX, stairHole.minX - 0.05);
        const hx1 = Math.min(maxX, stairHole.maxX + 0.05);
        const hy0 = Math.max(minY, stairHole.minY - 0.05);
        const hy1 = Math.min(maxY, stairHole.maxY + 0.05);
        if (hx1 > hx0 + 0.05 && hy1 > hy0 + 0.05) {
          addZonePatchRect(minX, hx0, minY, maxY, zoneMat, zoneType, roomName);
          addZonePatchRect(hx1, maxX, minY, maxY, zoneMat, zoneType, roomName);
          addZonePatchRect(hx0, hx1, minY, hy0, zoneMat, zoneType, roomName);
          addZonePatchRect(hx0, hx1, hy1, maxY, zoneMat, zoneType, roomName);
          return;
        }
      }
      addZonePatchRect(minX, maxX, minY, maxY, zoneMat, zoneType, roomName);
    };

    for (const rm of (floor.rooms || [])) {
      if (rm.isOutdoor) continue;
      const rName = (rm.name || '').toUpperCase();
      let zoneMat = this.materials.zoneOakWoodFloor;
      let zoneType = 'bedroom_study';

      if (rName.includes('WC') || rName.includes('TẮM') || rName.includes('THAY ĐỒ') || rName.includes('VỆ SINH')) {
        zoneMat = this.materials.zoneBathroomTile;
        zoneType = 'bathroom';
      } else if (
        rName.includes('BAN CÔNG') ||
        rName.includes('SÂN THƯỢNG') ||
        rName.includes('GIẶT') ||
        rName.includes('PHƠI') ||
        rName.includes('BBQ') ||
        rName.includes('SKY')
      ) {
        zoneMat = this.materials.zoneOutdoorSlateTile;
        zoneType = 'balcony_terrace';
      } else if (
        rName.includes('KHÁCH') ||
        rName.includes('BẾP') ||
        rName.includes('ĂN') ||
        rName.includes('SẢNH') ||
        rName.includes('SINH HOẠT')
      ) {
        zoneMat = this.materials.zonePorcelainTile;
        zoneType = 'living_kitchen';
      } else if (
        rName.includes('NGỦ') ||
        rName.includes('HỌC') ||
        rName.includes('LÀM VIỆC') ||
        rName.includes('THỜ') ||
        rName.includes('MASTER')
      ) {
        zoneMat = this.materials.zoneOakWoodFloor;
        zoneType = 'bedroom_study';
      }

      const b = rm.bounds || {
        minX: rm.x - 1.6,
        maxX: rm.x + 1.6,
        minY: rm.y - 1.5,
        maxY: rm.y + 1.5
      };
      const cMinX = Math.max(primarySlab.minX + 0.08, b.minX);
      const cMaxX = Math.min(primarySlab.maxX - 0.08, b.maxX);
      const cMinY = Math.max(primarySlab.minY + 0.08, b.minY);
      const cMaxY = Math.min(primarySlab.maxY - 0.08, b.maxY);

      if (cMaxX > cMinX + 0.3 && cMaxY > cMinY + 0.3) {
        addZonePatchAvoidStair(cMinX, cMaxX, cMinY, cMaxY, zoneMat, zoneType, rm.name);
      }
    }

    // Ensure upper floors also have a dark slate balcony strip along the front edge
    if (floorIdx > 0 || floor.id !== 'floor_1') {
      const balDepth = Math.min(1.05, (primarySlab.maxY - primarySlab.minY) * 0.14);
      addZonePatchAvoidStair(
        primarySlab.minX + 0.06,
        primarySlab.maxX - 0.06,
        primarySlab.minY + 0.04,
        primarySlab.minY + balDepth,
        this.materials.zoneOutdoorSlateTile,
        'balcony_terrace',
        `Ban công ${floor.name}`
      );
    }
  }

  buildColumns(floor, group) {
    for (const col of floor.columns) {
      const colH = Math.max(0.5, (col.height || floor.height) - 0.006);
      const geo = new THREE.BoxGeometry(col.sizeX, colH, col.sizeY);
      const mesh = new THREE.Mesh(geo, this.materials.columnConcrete);
      mesh.position.set(col.x, 0.003 + colH / 2, col.y);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { bimCategory: 'structure' };
      group.add(mesh);
    }
  }

  /**
   * Build exterior walls (with dual fullWallGroup + cutawayStubMesh representations)
   * and interior dividing walls, segmenting walls cleanly around windows & doors
   * and adding interior baseboards at y = +0.003m.
   */
  buildWalls(floor, group, floorIdx = 0) {
    const slab = floor.slabs[0] || { minX: 0, maxX: 10, minY: 0, maxY: 15 };
    const bCenterX = (slab.minX + slab.maxX) / 2;
    const bCenterZ = (slab.minY + slab.maxY) / 2;

    // Reset claimed flags on doors and windows before matching to walls
    for (const d of (floor.doors || [])) d._claimed = false;
    for (const w of (floor.windows || [])) w._claimed = false;

    const normalMap = {
      south: new THREE.Vector3(0, 0, -1),
      north: new THREE.Vector3(0, 0, 1),
      west: new THREE.Vector3(-1, 0, 0),
      east: new THREE.Vector3(1, 0, 0)
    };

    // 1. Exterior Walls with Dynamic View-Dependent Cutaway
    for (const ew of floor.exteriorWalls) {
      const dx = ew.p2.x - ew.p1.x;
      const dy = ew.p2.y - ew.p1.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.2) continue;

      const wallGroup = new THREE.Group();
      wallGroup.name = ew.id || `ext_wall_${ew.orientation}`;
      wallGroup.userData = {
        type: 'wall',
        name: `Tường ngoại thất (${ew.orientation})`,
        floorId: floor.id,
        orientation: ew.orientation,
        bimCategory: 'walls_openings'
      };

      const wallMat = ew.orientation === 'south'
        ? this.materials.exteriorWall
        : this.materials.exteriorWall;

      // A) fullWallGroup: Full-height segmented wall + windows/doors/balcony railings on this wall
      const fullWallGroup = this.buildSegmentedWallGroup(
        ew,
        floor.doors || [],
        floor.windows || [],
        wallMat,
        true
      );
      fullWallGroup.name = `${wallGroup.name}_full`;
      fullWallGroup.userData = {
        type: 'wall',
        name: `Tường ngoại thất (${ew.orientation})`,
        isExteriorCutawayWall: true,
        orientation: ew.orientation,
        floorId: floor.id,
        bimCategory: 'walls_openings'
      };

      // Add balcony railing (railing_iron_baluster) and lush greenery planters (balcony_planter_greenery)
      // on upper-floor front balconies & terraces (placed on group so visible in both Dollhouse and Facade modes)
      if (ew.orientation === 'south' && (floorIdx > 0 || floor.id !== 'floor_1')) {
        const railSpan = length * 0.78;
        const rail = this.assetLibrary.instantiateAsset(
          'railing_iron_baluster',
          { width: railSpan, height: 1.05, depth: 0.08, rotation: 0 },
          this.materials
        );
        rail.position.set((ew.p1.x + ew.p2.x) / 2, 0.003, ew.p1.y - ew.thickness * 0.35);
        rail.userData = {
          ...rail.userData,
          bimCategory: 'walls_openings',
          floorId: floor.id
        };
        rail.traverse(c => {
          c.userData = { ...c.userData, bimCategory: 'walls_openings' };
        });
        group.add(rail);

        // Add lush balcony planter troughs on left and right balcony edges if not already occupied
        const planterW = Math.min(1.35, Math.max(0.75, length * 0.24));
        const planterPositions = [
          ew.p1.x + planterW * 0.65 + 0.18,
          ew.p2.x - planterW * 0.65 - 0.18
        ];
        const existingFurn = floor.furniture || [];
        for (const px of planterPositions) {
          const py = ew.p1.y + 0.32;
          const alreadyHasPlanter = existingFurn.some(
            it => Math.hypot((it.cx || 0) - px, (it.cy || 0) - py) < 0.75
          );
          if (!alreadyHasPlanter) {
            const planter = this.assetLibrary.instantiateAsset(
              'balcony_planter_greenery',
              { width: planterW, height: 0.68, depth: 0.38, rotation: 0 },
              this.materials
            );
            planter.position.set(px, 0.002, py);
            planter.userData = {
              ...planter.userData,
              bimCategory: 'furniture',
              floorId: floor.id,
              isBalconyGreenery: true
            };
            planter.traverse(c => {
              c.userData = { ...c.userData, bimCategory: 'furniture' };
            });
            group.add(planter);
          }
        }
      }

      // B) cutawayStubMesh: Low stub wall (20cm / 0.20m height) + crisp dark gray #3D3D3D section cap + 8cm baseboard
      const stubHeight = 0.20;
      const angle = Math.atan2(dy, dx);
      const midX = (ew.p1.x + ew.p2.x) / 2;
      const midY = (ew.p1.y + ew.p2.y) / 2;

      const cutawayStubMesh = new THREE.Group();
      cutawayStubMesh.name = `${wallGroup.name}_stub`;
      cutawayStubMesh.position.set(midX, 0, midY);
      cutawayStubMesh.rotation.y = -angle;
      cutawayStubMesh.userData = {
        type: 'wall_stub',
        orientation: ew.orientation,
        floorId: floor.id,
        stubHeight: 0.20,
        capColor: '#3D3D3D',
        bimCategory: 'walls_openings'
      };

      const stubBodyGeo = new THREE.BoxGeometry(length, stubHeight, ew.thickness);
      const stubBody = new THREE.Mesh(stubBodyGeo, this.materials.interiorPlaster);
      stubBody.position.set(0, 0.003 + stubHeight / 2, 0);
      stubBody.castShadow = true;
      stubBody.receiveShadow = true;
      stubBody.userData = { bimCategory: 'walls_openings' };

      const stubBaseboardGeo = new THREE.BoxGeometry(length, 0.08, ew.thickness + 0.014);
      const stubBaseboard = new THREE.Mesh(stubBaseboardGeo, this.materials.baseboardMat);
      stubBaseboard.position.set(0, 0.003 + 0.04, 0);
      stubBaseboard.castShadow = false;
      stubBaseboard.receiveShadow = true;
      stubBaseboard.userData = { bimCategory: 'walls_openings' };

      const capGeo = new THREE.BoxGeometry(length + 0.004, 0.018, ew.thickness + 0.008);
      const capMesh = new THREE.Mesh(capGeo, this.materials.cutawayCapMat);
      capMesh.position.set(0, 0.003 + stubHeight + 0.009, 0);
      capMesh.userData = { bimCategory: 'walls_openings', capColor: '#3D3D3D' };

      cutawayStubMesh.add(stubBody, stubBaseboard, capMesh);

      wallGroup.add(fullWallGroup, cutawayStubMesh);
      group.add(wallGroup);

      const outwardNormal = normalMap[ew.orientation] || new THREE.Vector3(0, 0, -1);
      this.exteriorWallEntries.push({
        wallGroup,
        fullWallGroup,
        cutawayStubMesh,
        normal: outwardNormal,
        center: new THREE.Vector3(bCenterX, floor.elevation, bCenterZ),
        floorId: floor.id,
        orientation: ew.orientation
      });
      this.cutawayWalls.push(fullWallGroup);
    }

    // 2. Interior Dividing Walls (segmented around interior doors + baseboards)
    for (const iw of floor.interiorWalls) {
      const dx = iw.p2.x - iw.p1.x;
      const dy = iw.p2.y - iw.p1.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.2) continue;

      const intrGroup = this.buildSegmentedWallGroup(
        iw,
        floor.doors || [],
        [],
        this.materials.interiorPlaster,
        false
      );
      intrGroup.userData = {
        type: 'wall',
        name: 'Tường ngăn phòng',
        floorId: floor.id,
        bimCategory: 'walls_openings'
      };

      // Dark architectural top section cap on interior walls for crisp dollhouse readability
      const capGeo = new THREE.BoxGeometry(length, 0.014, (iw.thickness || 0.15) + 0.004);
      const capMesh = new THREE.Mesh(capGeo, this.materials.cutawayCapMat);
      capMesh.position.set(length / 2, iw.height + 0.007, 0);
      capMesh.userData = { bimCategory: 'walls_openings' };
      intrGroup.add(capMesh);

      group.add(intrGroup);
    }
  }

  /**
   * Segment a wall line around any doors and windows that lie on it,
   * building left/right piers, window sill walls, lintel headers, baseboards,
   * and embedding the 3D door/window assemblies inside the wall openings.
   */
  buildSegmentedWallGroup(wall, doors, windows, wallMat, isExterior = false) {
    const x1 = wall.p1.x;
    const y1 = wall.p1.y;
    const x2 = wall.p2.x;
    const y2 = wall.p2.y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const L = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const ux = dx / L;
    const uy = dy / L;
    const H = wall.height || 3.4;
    const T = wall.thickness || (isExterior ? 0.20 : 0.15);
    const yBottom = 0.003; // Micro-elevation offset so walls never Z-fight with floor at y=0.0

    const segGroup = new THREE.Group();
    segGroup.position.set(x1, 0, y1);
    segGroup.rotation.y = -angle;

    const matchedOpenings = [];

    // Match windows along this wall
    for (const win of windows) {
      if (win._claimed || !win.p1 || !win.p2) continue;
      const wmx = (win.p1.x + win.p2.x) / 2;
      const wmy = (win.p1.y + win.p2.y) / 2;
      const perp = Math.abs(-(wmx - x1) * uy + (wmy - y1) * ux);
      const tCenter = (wmx - x1) * ux + (wmy - y1) * uy;
      const winLen = Math.hypot(win.p2.x - win.p1.x, win.p2.y - win.p1.y);
      const wux = (win.p2.x - win.p1.x) / Math.max(0.01, winLen);
      const wuy = (win.p2.y - win.p1.y) / Math.max(0.01, winLen);
      const align = Math.abs(ux * wux + uy * wuy);

      if (perp < 0.42 && align > 0.85 && tCenter > 0.2 && tCenter < L - 0.2) {
        win._claimed = true;
        const halfW = Math.min(winLen / 2, (L - 0.3) / 2);
        const sillY = Math.max(0.35, win.sillHeight ?? 0.85);
        const winH = Math.min(H - sillY - 0.18, win.windowHeight ?? 1.8);
        matchedOpenings.push({
          kind: 'window',
          t0: Math.max(0.12, tCenter - halfW),
          t1: Math.min(L - 0.12, tCenter + halfW),
          sillY,
          topY: sillY + winH,
          raw: win
        });
      }
    }

    // Match doors along this wall
    for (const door of doors) {
      if (door._claimed) continue;
      const dmx = door.x;
      const dmy = door.y;
      const perp = Math.abs(-(dmx - x1) * uy + (dmy - y1) * ux);
      const tCenter = (dmx - x1) * ux + (dmy - y1) * uy;
      if (perp < 0.42 && tCenter > 0.15 && tCenter < L - 0.15) {
        door._claimed = true;
        const dw = Math.min(door.width || 0.92, L - 0.24);
        const dh = Math.min(H - 0.15, door.height || 2.2);
        const t0 = Math.max(0.10, Math.min(L - 0.10 - dw, tCenter - dw / 2));
        matchedOpenings.push({
          kind: 'door',
          t0,
          t1: t0 + dw,
          sillY: yBottom,
          topY: dh,
          raw: door
        });
      }
    }

    // Sort openings along wall and resolve overlaps
    matchedOpenings.sort((a, b) => a.t0 - b.t0);
    const cleanOpenings = [];
    for (const op of matchedOpenings) {
      if (op.t1 - op.t0 < 0.35) continue;
      if (cleanOpenings.length === 0) {
        cleanOpenings.push(op);
      } else {
        const prev = cleanOpenings[cleanOpenings.length - 1];
        if (op.t0 >= prev.t1 + 0.08) {
          cleanOpenings.push(op);
        }
      }
    }

    const addWallBox = (xStart, xEnd, yStart, yEnd) => {
      const wLen = xEnd - xStart;
      const wHeight = yEnd - yStart;
      if (wLen < 0.03 || wHeight < 0.03) return;
      const geo = new THREE.BoxGeometry(wLen, wHeight, T);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set((xStart + xEnd) / 2, (yStart + yEnd) / 2, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { bimCategory: 'walls_openings' };
      segGroup.add(mesh);
    };

    const addBaseboard = (xStart, xEnd) => {
      const bLen = xEnd - xStart;
      if (bLen < 0.08) return;
      const bHeight = 0.08;
      const geo = new THREE.BoxGeometry(bLen, bHeight, T + 0.016);
      const mesh = new THREE.Mesh(geo, this.materials.baseboardMat);
      mesh.position.set((xStart + xEnd) / 2, yBottom + bHeight / 2, 0);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData = { bimCategory: 'walls_openings' };
      segGroup.add(mesh);
    };

    let cursor = 0;
    for (const op of cleanOpenings) {
      // Left solid pier before opening
      if (op.t0 > cursor + 0.03) {
        addWallBox(cursor, op.t0, yBottom, H);
        addBaseboard(cursor, op.t0);
      }

      const ow = op.t1 - op.t0;
      const oCenter = (op.t0 + op.t1) / 2;

      // Top lintel header above opening
      if (H > op.topY + 0.03) {
        addWallBox(op.t0, op.t1, op.topY, H);
      }

      // Sill wall below window + 3D Window / Door assembly
      if (op.kind === 'window') {
        if (op.sillY > yBottom + 0.03) {
          addWallBox(op.t0, op.t1, yBottom, op.sillY);
          addBaseboard(op.t0, op.t1);
        }
        const winH = op.topY - op.sillY;
        const winMesh = FurnitureGenerator.buildDetailedWindow(
          {
            width: ow,
            sillHeight: op.sillY,
            windowHeight: winH,
            wallThickness: T
          },
          this.materials
        );
        winMesh.position.set(oCenter, op.sillY + winH / 2, 0);
        winMesh.rotation.set(0, 0, 0);
        segGroup.add(winMesh);
      } else if (op.kind === 'door') {
        const doorMesh = FurnitureGenerator.buildDetailedDoor(
          {
            width: ow,
            height: op.topY,
            wallThickness: T
          },
          this.materials
        );
        doorMesh.position.set(oCenter, yBottom, 0);
        doorMesh.rotation.set(0, 0, 0);
        segGroup.add(doorMesh);
      }

      cursor = op.t1;
    }

    // Right solid pier after last opening
    if (L > cursor + 0.03) {
      addWallBox(cursor, L, yBottom, H);
      addBaseboard(cursor, L);
    }

    return segGroup;
  }

  buildStairs(floor, group) {
    for (const st of floor.stairs) {
      const stairGroup = FurnitureGenerator.buildDetailedStaircase(st, this.materials);
      group.add(stairGroup);
    }
  }

  buildDoorsAndWindows(floor, group) {
    // Only build doors/windows that were not already embedded into segmented walls
    for (const win of (floor.windows || [])) {
      if (win._claimed) continue;
      const winGroup = FurnitureGenerator.buildDetailedWindow(win, this.materials);
      group.add(winGroup);
    }
    for (const door of (floor.doors || [])) {
      if (door._claimed) continue;
      const doorGroup = FurnitureGenerator.buildDetailedDoor(door, this.materials);
      doorGroup.position.y = 0.003;
      group.add(doorGroup);
    }
  }

  buildFurniture(floor, group) {
    const items = [...(floor.furniture || []), ...(floor.sanitary || [])];
    for (const item of items) {
      const requestedAssetId = item.asset_id || item.assetId || item.type;
      const furnModel = this.assetLibrary.instantiateAsset(requestedAssetId, item, this.materials);
      if (!furnModel.userData?.isGlbAsset) {
        this._needsGlbUpgrade = true;
      }

      // Place at y = +0.002m so internal rugs/contact shadows sit cleanly above floor finishes (zero Z-fighting)
      furnModel.position.set(item.cx, 0.002, item.cy);

      const wMm = Math.round((item.width || 1.0) * 1000);
      const dMm = Math.round((item.depth || 0.8) * 1000);
      const hMm = Math.round((item.height || 0.75) * 1000);
      const resolvedAssetId = furnModel.userData?.assetId || this.assetLibrary.resolveAssetId(requestedAssetId, item);

      furnModel.userData = {
        ...furnModel.userData,
        type: 'furniture',
        name: item.name,
        category: item.type,
        asset_id: resolvedAssetId,
        assetId: resolvedAssetId,
        isGlbAsset: Boolean(furnModel.userData?.isGlbAsset),
        room: item.room || floor.name,
        dimensions: `${wMm} × ${dMm} × ${hMm} mm`,
        width: item.width,
        depth: item.depth,
        height: item.height,
        rotation: item.rotation || 0,
        material: item.material || 'Vật liệu PBR Cao cấp',
        layer: item.layer || 'A-FURN',
        floorId: floor.id,
        floorName: floor.name,
        bimCategory: 'furniture'
      };

      furnModel.traverse(child => {
        child.userData = {
          ...child.userData,
          bimCategory: 'furniture',
          assetId: resolvedAssetId
        };
      });

      this.selectableObjects.push(furnModel);
      group.add(furnModel);
    }
  }

  /**
   * Build emissive ceiling fixtures and warm ceiling glow decals for 60 FPS interior illumination
   * (0 PointLights in the entire scene to completely eliminate multi-pointlight overhead).
   */
  buildInteriorLights(floor, group) {
    const slab = floor.slabs[0] || { minX: 0, maxX: 10, minY: 0, maxY: 15 };
    const cx = (slab.minX + slab.maxX) / 2;
    const cy = (slab.minY + slab.maxY) / 2;

    const lightSpots = [];
    if (floor.rooms && floor.rooms.length > 0) {
      for (const rm of floor.rooms) {
        if (rm.isOutdoor) continue;
        if (lightSpots.length < 4) {
          lightSpots.push({ x: rm.x, y: rm.y, name: `Đèn trần ${rm.name}` });
        }
      }
    }
    if (lightSpots.length === 0) {
      lightSpots.push({ x: cx, y: cy, name: `Đèn trần ${floor.name}` });
    }

    const showLights = this.interiorLightsOn && (this.currentStage >= 4);

    for (const lp of lightSpots) {
      // Warm ceiling glow decal: PlaneGeometry(2.2, 2.2) at y = floor.height - 0.008
      const glowGeo = new THREE.PlaneGeometry(2.2, 2.2);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xFFDF9E,
        transparent: true,
        opacity: showLights ? 0.18 : 0.0,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const glowDecal = new THREE.Mesh(glowGeo, glowMat);
      glowDecal.rotation.x = Math.PI / 2;
      glowDecal.position.set(lp.x, floor.height - 0.008, lp.y);
      glowDecal.visible = showLights;
      glowDecal.userData = { bimCategory: 'lighting', floorId: floor.id };
      group.add(glowDecal);
      this.interiorLights.push(glowDecal);
      this._ceilingGlowDecals.push(glowDecal);

      // Sleek architectural recessed halo ceiling fixture
      const fixtureGroup = new THREE.Group();
      fixtureGroup.position.set(lp.x, floor.height - 0.06, lp.y);
      fixtureGroup.userData = { bimCategory: 'lighting', floorId: floor.id };

      const housing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.18, 0.035, 16),
        this.materials.metalBrass
      );
      housing.castShadow = false;
      housing.userData = { bimCategory: 'lighting' };

      const diffuser = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.15, 0.04, 16),
        this.materials.emissiveWarm
      );
      diffuser.castShadow = false;
      diffuser.userData = { bimCategory: 'lighting' };

      fixtureGroup.add(housing, diffuser);
      group.add(fixtureGroup);
      this.lightFixtures.push(fixtureGroup);
    }
  }

  buildRoomLabels(floor, group) {
    for (const rm of (floor.rooms || [])) {
      const sprite = this.createRoomLabelSprite(rm.name, `${rm.area} m²`);
      sprite.position.set(rm.x, floor.height * 0.72, rm.y);
      sprite.userData = { bimCategory: 'room_labels', floorId: floor.id };
      group.add(sprite);
      this.roomLabelSprites.push(sprite);
    }
  }

  createRoomLabelSprite(title, area) {
    const canvas = document.createElement('canvas');
    canvas.width = 416;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(255, 253, 249, 0.92)';
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(8, 8, 400, 112, 24);
    } else {
      ctx.rect(8, 8, 400, 112);
    }
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#D97706';
    ctx.stroke();

    ctx.font = '700 22px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#1E1D1B';
    ctx.textAlign = 'center';
    ctx.fillText(title.normalize('NFC').toUpperCase().substring(0, 24), 208, 54);

    ctx.font = '600 20px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#B45309';
    ctx.fillText(area, 208, 92);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(2.15, 0.66, 1.0);
    sprite.renderOrder = 10;
    return sprite;
  }

  /**
   * Build Stage 1 AI Detection Overlay at y = +0.006m with polygonOffset: -1
   */
  buildAiDetectionOverlay(floor, group) {
    const aiGroup = new THREE.Group();
    aiGroup.name = 'ai_detection_overlay';
    aiGroup.userData = { bimCategory: 'ai_detection' };

    if (floor.rooms) {
      const roomColors = [0x0284C7, 0xF59E0B, 0x10B981, 0x8B5CF6, 0xEC4899];
      floor.rooms.forEach((rm, i) => {
        const rw = rm.bounds ? (rm.bounds.maxX - rm.bounds.minX) : 3.6;
        const rd = rm.bounds ? (rm.bounds.maxY - rm.bounds.minY) : 3.0;
        const cx = rm.bounds ? (rm.bounds.minX + rm.bounds.maxX) / 2 : rm.x;
        const cy = rm.bounds ? (rm.bounds.minY + rm.bounds.maxY) / 2 : rm.y;

        const planeGeo = new THREE.PlaneGeometry(rw, rd);
        const planeMat = new THREE.MeshBasicMaterial({
          color: roomColors[i % roomColors.length],
          transparent: true,
          opacity: 0.20,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1
        });
        const plane = new THREE.Mesh(planeGeo, planeMat);
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(cx, 0.006, cy);
        plane.userData = { bimCategory: 'ai_detection' };
        aiGroup.add(plane);

        const edges = new THREE.EdgesGeometry(planeGeo);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x0284C7 }));
        line.rotation.x = -Math.PI / 2;
        line.position.set(cx, 0.008, cy);
        line.userData = { bimCategory: 'ai_detection' };
        aiGroup.add(line);
      });
    }

    const allFurn = [...(floor.furniture || []), ...(floor.sanitary || [])];
    for (const item of allFurn) {
      const fw = item.width || 1.2;
      const fd = item.depth || 0.8;
      const boxGeo = new THREE.BoxGeometry(fw, 0.06, fd);
      const boxMat = new THREE.MeshBasicMaterial({
        color: 0xD97706,
        wireframe: true,
        polygonOffset: true,
        polygonOffsetFactor: -1
      });
      const box = new THREE.Mesh(boxGeo, boxMat);
      box.position.set(item.cx, 0.036, item.cy);
      box.userData = { bimCategory: 'ai_detection' };
      aiGroup.add(box);

      const conf = item.confidence ? `${Math.round(item.confidence * 100)}%` : '98%';
      const badge = this.createAiDetectionBadgeSprite(`${item.name || 'Vật dụng'} [AI: ${conf}]`);
      badge.position.set(item.cx, 0.52, item.cy);
      badge.userData = { bimCategory: 'ai_detection' };
      aiGroup.add(badge);
    }

    aiGroup.visible = (this.currentStage === 1);
    group.add(aiGroup);
  }

  createAiDetectionBadgeSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 76;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(217, 119, 6, 0.92)';
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(6, 6, 372, 64, 16);
    } else {
      ctx.rect(6, 6, 372, 64);
    }
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    ctx.font = 'bold 20px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(text.substring(0, 30), 192, 44);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(2.3, 0.46, 1.0);
    return sprite;
  }

  // ================= DYNAMIC DOLLHOUSE CUTAWAY =================

  /**
   * Dynamically evaluate exterior wall visibility based on camera direction:
   * - In 'dollhouse' and 'exploded' modes:
   *   If dot(wallOutwardNormal, buildingCenterToCamera) > 0.15, hide fullWallGroup and show cutawayStubMesh!
   *   Otherwise show fullWallGroup and hide cutawayStubMesh!
   * - In 'facade' and 'walkthrough' modes:
   *   Always show fullWallGroup and hide cutawayStubMesh!
   */
  updateDynamicCutaway() {
    const showWallsStage = this.currentStage >= 3;
    const isCutawayMode = (this.viewMode === 'dollhouse' || this.viewMode === 'exploded');
    const camPos = this.camera.position;

    for (const entry of this.exteriorWallEntries) {
      if (!showWallsStage) {
        entry.wallGroup.visible = false;
        entry.fullWallGroup.visible = false;
        entry.cutawayStubMesh.visible = false;
        continue;
      }

      entry.wallGroup.visible = true;

      if (!isCutawayMode) {
        entry.fullWallGroup.visible = true;
        entry.cutawayStubMesh.visible = false;
      } else {
        const dx = camPos.x - entry.center.x;
        const dy = camPos.y - entry.center.y;
        const dz = camPos.z - entry.center.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const dot = (entry.normal.x * dx + entry.normal.y * dy + entry.normal.z * dz) / len;

        const facesCamera = dot > 0.15;
        entry.fullWallGroup.visible = !facesCamera;
        entry.cutawayStubMesh.visible = facesCamera;
      }
    }
  }

  // ================= VIEW MODES & PROGRESSIVE STAGES =================

  setExplodedDistance(distance) {
    this.explodedDistance = typeof distance === 'number' ? distance : 4.5;
    if (this.viewMode === 'exploded') {
      let idx = 0;
      for (const [_, group] of this.floorGroups) {
        group.position.y = group.userData.elevation + idx * this.explodedDistance;
        idx++;
      }
    }
    this._cutawayDirty = true;
    this._invalidateShadowMap();
  }

  setRenderingStage(stage, opts = {}) {
    this.currentStage = stage;

    for (const [_, group] of this.floorGroups) {
      group.traverse(child => {
        const cat = child.userData?.bimCategory;
        if (!cat) return;

        if (cat === 'ai_detection') {
          child.visible = (stage === 1);
        } else if (cat === 'structure') {
          child.visible = true;
        } else if (cat === 'walls_openings') {
          child.visible = (stage >= 3);
        } else if (cat === 'furniture') {
          child.visible = (stage >= 4);
        } else if (cat === 'lighting') {
          const showLights = (stage >= 4 && this.interiorLightsOn);
          child.visible = showLights;
          if (child.material && child.material.opacity !== undefined) {
            child.material.opacity = showLights ? 0.18 : 0.0;
          }
        } else if (cat === 'room_labels') {
          child.visible = (stage >= 4 && this.roomLabelsVisible);
        }
      });
    }

    if (this.siteGroup) {
      this.siteGroup.visible = (stage >= 2);
    }

    this._cutawayDirty = true;
    this._invalidateShadowMap();

    if (opts.skipCamera) {
      this.invalidate();
      return;
    }

    const { cx, cy, maxDim } = this.getBuildingCenterAndSpan();

    if (stage === 1) {
      const activeGroup = this.floorGroups.get(this.activeFloorId) || this.floorGroups.values().next().value;
      const elev = activeGroup ? activeGroup.userData.elevation : 0;
      this.animateCameraTo(
        new THREE.Vector3(cx, elev + Math.max(16, maxDim * 1.15), cy - 0.05),
        new THREE.Vector3(cx, elev, cy)
      );
    } else if (stage === 2) {
      this.animateCameraTo(
        new THREE.Vector3(cx + maxDim * 0.85, maxDim * 0.85, cy - maxDim * 0.95),
        new THREE.Vector3(cx, 3.5, cy)
      );
    } else if (stage === 5 && this.interiorLightsOn) {
      this.setInteriorLights(true);
    }
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.walkthroughState.active = false;
    this.walkthroughState.walkTarget = null;
    this.controls.enabled = true;

    for (const [_, group] of this.floorGroups) {
      group.position.y = group.userData.elevation;
      group.visible = true;
    }

    const { cx, cy, maxDim, totalHeight } = this.getBuildingCenterAndSpan();

    if (mode === 'dollhouse') {
      const dist = Math.max(maxDim * 1.28, totalHeight * 1.22, 16.5);
      this.animateCameraTo(
        new THREE.Vector3(cx + dist * 0.78, Math.max(13.5, totalHeight * 1.18), cy - dist * 0.86),
        new THREE.Vector3(cx, totalHeight * 0.42, cy)
      );
    } else if (mode === 'facade') {
      const dist = Math.max(maxDim * 1.35, totalHeight * 1.38, 18.5);
      this.animateCameraTo(
        new THREE.Vector3(cx + dist * 0.22, totalHeight * 0.52, cy - dist * 1.15),
        new THREE.Vector3(cx, totalHeight * 0.46, cy)
      );
    } else if (mode === 'exploded') {
      let idx = 0;
      for (const [_, group] of this.floorGroups) {
        group.position.y = group.userData.elevation + idx * (this.explodedDistance || 4.5);
        idx++;
      }
      const explodedTop = totalHeight + Math.max(1, this.floorGroups.size - 1) * (this.explodedDistance || 4.5);
      const dist = Math.max(maxDim * 1.45, 18.0);
      this.animateCameraTo(
        new THREE.Vector3(cx + dist * 0.88, explodedTop * 0.92, cy - dist * 0.92),
        new THREE.Vector3(cx, explodedTop * 0.42, cy)
      );
    } else if (mode === 'walkthrough') {
      this.enterWalkthrough();
    }

    this.setRoomLabelsVisible(this.roomLabelsVisible);
    this._cutawayDirty = true;
    this._invalidateShadowMap();
  }

  enterWalkthrough() {
    this.animatingCamera = false;
    this.walkthroughState.active = true;
    this.walkthroughState.walkTarget = null;
    this.controls.enabled = false;

    const activeGroup = this.floorGroups.get(this.activeFloorId) || this.floorGroups.values().next().value;
    const elev = activeGroup ? activeGroup.userData.elevation : 0.0;
    const floorData = this.bimData?.floors?.find(f => f.id === (activeGroup?.name || this.activeFloorId));
    const slab = floorData?.slabs?.[0] || { minX: 0, maxX: 8, minY: 0, maxY: 12 };
    const cx = (slab.minX + slab.maxX) / 2;
    const startZ = slab.minY + (slab.maxY - slab.minY) * 0.28;

    // Position camera at 1.6m eye height inside active floor looking into the floor
    this.walkthroughState.position.set(cx, elev + 1.6, startZ);
    this.walkthroughState.yaw = Math.PI; // Looking toward +Z (into the room)
    this.walkthroughState.pitch = -0.04;
    this.applyWalkthroughCameraRotation();
    this.updateDynamicCutaway();
  }

  applyWalkthroughCameraRotation() {
    this.camera.position.copy(this.walkthroughState.position);
    const lookDir = new THREE.Vector3(
      -Math.sin(this.walkthroughState.yaw) * Math.cos(this.walkthroughState.pitch),
      Math.sin(this.walkthroughState.pitch),
      -Math.cos(this.walkthroughState.yaw) * Math.cos(this.walkthroughState.pitch)
    );
    const target = this.walkthroughState.position.clone().add(lookDir);
    this.camera.lookAt(target);
    this.controls.target.copy(target);
    this._cutawayDirty = true;
    this.invalidate();
  }

  setInteriorLights(enabled) {
    this.interiorLightsOn = Boolean(enabled);
    const showLights = this.interiorLightsOn && (this.currentStage >= 4);
    const targetOpacity = showLights ? 0.18 : 0.0;

    for (const decal of this.interiorLights) {
      decal.visible = showLights;
      if (decal.material) {
        decal.material.opacity = targetOpacity;
      }
    }
    for (const decal of this._ceilingGlowDecals) {
      decal.visible = showLights;
      if (decal.material) {
        decal.material.opacity = targetOpacity;
      }
    }
    for (const fix of this.lightFixtures) {
      fix.visible = (this.currentStage >= 4);
    }
    if (this.materials.emissiveWarm) {
      this.materials.emissiveWarm.emissiveIntensity = this.interiorLightsOn ? 2.8 : 0.15;
    }
    if (this.hemiLight) {
      if (this.hemiLight.color?.setHex) {
        this.hemiLight.color.setHex(this.interiorLightsOn ? 0xFFF0D6 : 0xFFFBF2);
      }
      this.hemiLight.intensity = this.interiorLightsOn ? 0.88 : 0.72;
    }
    if (this.sunLight) {
      this.sunLight.intensity = this.interiorLightsOn ? 1.25 : 1.55;
    }
    this._invalidateShadowMap();
  }

  setRoomLabelsVisible(enabled) {
    this.roomLabelsVisible = Boolean(enabled);
    const show = this.roomLabelsVisible && (this.currentStage >= 4) && (this.viewMode !== 'facade');
    for (const sprite of this.roomLabelSprites) {
      sprite.visible = show;
    }
    this.invalidate();
  }

  setFloorVisibility(floorId, visible) {
    const group = this.floorGroups.get(floorId);
    if (group) {
      group.visible = Boolean(visible);
      this._cutawayDirty = true;
      this._invalidateShadowMap();
    }
  }

  /**
   * Isolate floors up to floorId: keep floorId and floors below visible, hide floors above.
   */
  isolateFloorUpTo(floorId) {
    if (!this.bimData || !this.bimData.floors) return;
    const targetIdx = this.bimData.floors.findIndex(f => f.id === floorId);
    if (targetIdx === -1) return;

    this.activeFloorId = floorId;
    this.bimData.floors.forEach((floor, idx) => {
      const isVis = idx <= targetIdx;
      const grp = this.floorGroups.get(floor.id);
      if (grp) {
        grp.visible = isVis;
      }
    });

    if (this.options.onFloorIsolated) {
      this.options.onFloorIsolated(floorId);
    }
    this._cutawayDirty = true;
    this.invalidate();
  }

  /**
   * Focus a specific floor: hide floors above it, keep it and floors below visible,
   * and smoothly animate the camera to a clear 3/4 overhead dollhouse angle.
   */
  focusFloor(floorId) {
    this.isolateFloorUpTo(floorId);
    this._cutawayDirty = true;
    this._invalidateShadowMap();
    const group = this.floorGroups.get(floorId);
    if (!group) return;

    const { cx, cy, maxDim } = this.getBuildingCenterAndSpan();
    const elev = group.position.y;

    if (this.walkthroughState.active) {
      this.walkthroughState.position.y = elev + 1.6;
      this.applyWalkthroughCameraRotation();
      return;
    }

    if (this.currentStage === 1) {
      this.animateCameraTo(
        new THREE.Vector3(cx, elev + Math.max(15, maxDim * 1.1), cy - 0.05),
        new THREE.Vector3(cx, elev, cy)
      );
    } else {
      const dist = Math.max(maxDim * 0.95, 10.5);
      this.animateCameraTo(
        new THREE.Vector3(cx + dist * 0.72, elev + dist * 0.68, cy - dist * 0.78),
        new THREE.Vector3(cx, elev + 1.2, cy)
      );
    }
  }

  focusBuilding() {
    const { cx, cy, maxDim, totalHeight } = this.getBuildingCenterAndSpan();
    const dist = Math.max(maxDim * 1.25, 13.5);
    this.animateCameraTo(
      new THREE.Vector3(cx + dist * 0.78, Math.max(12, totalHeight * 1.15), cy - dist * 0.86),
      new THREE.Vector3(cx, totalHeight * 0.36, cy)
    );
  }

  getBuildingCenterAndSpan() {
    let minX = 0, maxX = 12, minY = 0, maxY = 16;
    let totalHeight = 11.0;

    if (this.bimData) {
      const firstSlab = this.bimData.floors?.[0]?.slabs?.[0];
      if (firstSlab) {
        minX = firstSlab.minX;
        maxX = firstSlab.maxX;
        minY = firstSlab.minY;
        maxY = firstSlab.maxY;
      } else if (this.bimData.metadata) {
        maxX = this.bimData.metadata.lot_width || 12;
        maxY = this.bimData.metadata.lot_length || 16;
      }
      if (this.bimData.floors && this.bimData.floors.length > 0) {
        const topF = this.bimData.floors[this.bimData.floors.length - 1];
        totalHeight = (topF.elevation || 0) + (topF.height || 3.6);
      }
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const maxDim = Math.max(maxX - minX, maxY - minY, 8.0);
    return { cx, cy, maxDim, totalHeight, minX, maxX, minY, maxY };
  }

  /**
   * Focus on a selected 3D furniture object: isolate its floor (hide floors above)
   * and smoothly tween camera to a close-up 3/4 view.
   */
  focusObject(targetObject) {
    if (!targetObject) return;
    const floorId = targetObject.userData?.floorId;
    if (floorId && this.floorGroups.has(floorId)) {
      this.isolateFloorUpTo(floorId);
    }

    const box = new THREE.Box3().setFromObject(targetObject);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const { cx, cy } = this.getBuildingCenterAndSpan();
    // Approach from the exterior cutaway side toward the object so no interior wall blocks the close-up
    const dirX = center.x >= cx ? 1 : -1;
    const dirZ = center.z <= cy ? -1 : 1;
    const dist = Math.max(2.6, Math.max(size.x, size.z) * 1.45);

    this.animateCameraTo(
      new THREE.Vector3(center.x + dirX * dist * 0.85, center.y + Math.max(1.8, size.y * 1.35), center.z + dirZ * dist * 0.95),
      center
    );
  }

  /**
   * Time-based camera transition (duration = 600ms, cubicOut easing: 1 - Math.pow(1 - t, 3))
   */
  animateCameraTo(targetPos, targetLookAt, duration = 600) {
    this.tweenStartPos.copy(this.camera.position);
    this.tweenStartLookAt.copy(this.controls.target);
    this.targetCameraPos = targetPos.clone();
    this.targetLookAt = targetLookAt.clone();
    this.tweenStartTime = performance.now();
    this.tweenDuration = duration;
    this.animatingCamera = true;
    this._cutawayDirty = true;
    this.invalidate();
  }

  // ================= RAYCASTING & INTERACTION =================

  onPointerDown(event) {
    // Cancel active camera tween immediately on user pointer interaction
    this.animatingCamera = false;
    this.pointerDownPos = { x: event.clientX, y: event.clientY };

    if (this.walkthroughState.active) {
      this.walkthroughState.isDraggingLook = true;
      this.walkthroughState.lastPointerX = event.clientX;
      this.walkthroughState.lastPointerY = event.clientY;
    }
  }

  onPointerMove(event) {
    if (this.walkthroughState.active && this.walkthroughState.isDraggingLook) {
      const dx = event.clientX - this.walkthroughState.lastPointerX;
      const dy = event.clientY - this.walkthroughState.lastPointerY;
      this.walkthroughState.lastPointerX = event.clientX;
      this.walkthroughState.lastPointerY = event.clientY;

      this.walkthroughState.yaw -= dx * 0.005;
      this.walkthroughState.pitch = Math.max(
        -Math.PI / 3,
        Math.min(Math.PI / 3, this.walkthroughState.pitch - dy * 0.004)
      );
      this.applyWalkthroughCameraRotation();
      return;
    }

    // If user drags mouse while orbiting, cancel any active camera tween so controls never fight user
    if (event.buttons > 0) {
      const dragDist = Math.hypot(
        event.clientX - this.pointerDownPos.x,
        event.clientY - this.pointerDownPos.y
      );
      if (dragDist > 5) {
        this.animatingCamera = false;
      }
    }
  }

  onPointerUp(event) {
    const dragDist = Math.hypot(
      event.clientX - this.pointerDownPos.x,
      event.clientY - this.pointerDownPos.y
    );

    if (this.walkthroughState.active) {
      this.walkthroughState.isDraggingLook = false;

      // Click on floor slab in walkthrough mode -> smoothly walk to that point!
      if (dragDist < 6 && this.slabMeshes.length > 0) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const hits = this.raycaster.intersectObjects(this.slabMeshes, false);
        if (hits.length > 0) {
          const pt = hits[0].point;
          this.walkthroughState.walkTarget = new THREE.Vector3(
            pt.x,
            this.walkthroughState.position.y,
            pt.z
          );
          this.invalidate();
        }
      }
    } else {
      if (dragDist < 5) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const visibleSelectables = this.selectableObjects.filter(obj => {
          let cur = obj;
          while (cur) {
            if (!cur.visible) return false;
            cur = cur.parent;
          }
          return true;
        });

        const intersects = this.raycaster.intersectObjects(visibleSelectables, true);
        if (intersects.length > 0) {
          let rootObj = intersects[0].object;
          while (rootObj.parent && !rootObj.userData?.name && rootObj.parent !== this.scene) {
            rootObj = rootObj.parent;
          }
          if (rootObj && rootObj.userData?.name) {
            this.selectObject(rootObj);
          }
        }
      }
    }
  }

  /**
   * Select a 3D furniture/sanitary item:
   * - Automatically hide floors above the item's floor
   * - Highlight with glowing bounding box + base selection ring
   * - Animate camera to close-up angle
   * - Populate inspector card
   */
  selectObject(obj) {
    if (this.selectedObjectMesh) {
      this.scene.remove(this.selectedObjectMesh);
      this.disposeSceneGroup(this.selectedObjectMesh);
      this.selectedObjectMesh = null;
    }
    this.selectedObject = obj;

    if (!obj) return;

    // 1. Hide floors above the item's floor so view is never blocked
    const floorId = obj.userData?.floorId;
    if (floorId && this.floorGroups.has(floorId)) {
      this.isolateFloorUpTo(floorId);
    }

    // 2. Build glowing highlight bounding box + floor selection ring
    const highlightGroup = new THREE.Group();
    highlightGroup.name = 'selection_highlight_group';

    obj.updateWorldMatrix(true, true);
    const boxHelper = new THREE.BoxHelper(obj, 0xF59E0B);
    highlightGroup.add(boxHelper);

    const bbox = new THREE.Box3().setFromObject(obj);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bbox.getCenter(center);
    bbox.getSize(size);

    const ringRadius = Math.max(size.x, size.z) * 0.62 + 0.12;
    const ringGeo = new THREE.RingGeometry(ringRadius - 0.045, ringRadius, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xF59E0B,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      polygonOffset: true,
      polygonOffsetFactor: -2
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.set(center.x, bbox.min.y + 0.008, center.z);
    highlightGroup.add(ringMesh);

    this.scene.add(highlightGroup);
    this.selectedObjectMesh = highlightGroup;

    // 3. Notify UI Inspector
    if (this.options.onObjectSelected) {
      this.options.onObjectSelected(obj.userData);
    }

    // 4. Smoothly focus camera on selected object
    this.focusObject(obj);
    this.invalidate();
  }

  onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(this.walkthroughState.keys, k)) {
      this.walkthroughState.keys[k] = true;
      this.walkthroughState.walkTarget = null;
      this.invalidate();
    }
  }

  onKeyUp(e) {
    const k = e.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(this.walkthroughState.keys, k)) {
      this.walkthroughState.keys[k] = false;
      this.invalidate();
    }
  }

  onWindowResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this._cutawayDirty = true;
    this.invalidate();
  }

  // ================= RENDER ON DEMAND =================

  _invalidateShadowMap() {
    if (this.renderer && this.renderer.shadowMap) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.invalidate();
  }

  invalidate() {
    this._needsRender = true;
    if (!this._rafScheduled && !this.isContextLost) {
      this._rafScheduled = true;
      this.rafId = requestAnimationFrame(() => this._tick());
    }
  }

  animate() {
    this.invalidate();
  }

  _tick() {
    this._rafScheduled = false;
    if (this.isContextLost) return;

    let keepLooping = false;

    // 1. Damped Camera Transition (600ms cubicOut)
    if (this.animatingCamera && this.targetCameraPos && this.targetLookAt) {
      const elapsed = performance.now() - this.tweenStartTime;
      const t = Math.min(1.0, elapsed / Math.max(1, this.tweenDuration));
      const ease = 1 - Math.pow(1 - t, 3);

      this.camera.position.lerpVectors(this.tweenStartPos, this.targetCameraPos, ease);
      this.controls.target.lerpVectors(this.tweenStartLookAt, this.targetLookAt, ease);
      this._cutawayDirty = true;
      this._needsRender = true;

      if (t >= 1.0) {
        this.camera.position.copy(this.targetCameraPos);
        this.controls.target.copy(this.targetLookAt);
        this.animatingCamera = false;
      } else {
        keepLooping = true;
      }
    }

    // 2. First-Person Walkthrough (WASD / Arrows + Click-to-Walk)
    if (this.walkthroughState.active) {
      const keys = this.walkthroughState.keys;
      const hasKeyMove = keys.w || keys.arrowup || keys.s || keys.arrowdown || keys.a || keys.arrowleft || keys.d || keys.arrowright;
      const hasTargetMove = Boolean(this.walkthroughState.walkTarget);

      if (hasKeyMove || hasTargetMove) {
        const speed = 0.09;
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() > 0.0001) forward.normalize();
        const side = new THREE.Vector3(-forward.z, 0, forward.x);

        if (keys.w || keys.arrowup) this.walkthroughState.position.addScaledVector(forward, speed);
        if (keys.s || keys.arrowdown) this.walkthroughState.position.addScaledVector(forward, -speed);
        if (keys.a || keys.arrowleft) this.walkthroughState.position.addScaledVector(side, -speed);
        if (keys.d || keys.arrowright) this.walkthroughState.position.addScaledVector(side, speed);

        if (this.walkthroughState.walkTarget) {
          this.walkthroughState.position.lerp(this.walkthroughState.walkTarget, 0.08);
          if (this.walkthroughState.position.distanceTo(this.walkthroughState.walkTarget) < 0.08) {
            this.walkthroughState.walkTarget = null;
          }
        }

        const { minX, maxX, minY, maxY } = this.getBuildingCenterAndSpan();
        this.walkthroughState.position.x = Math.max(minX + 0.35, Math.min(maxX - 0.35, this.walkthroughState.position.x));
        this.walkthroughState.position.z = Math.max(minY + 0.35, Math.min(maxY - 0.35, this.walkthroughState.position.z));
        this.applyWalkthroughCameraRotation();
        this._cutawayDirty = true;
        this._needsRender = true;
        keepLooping = true;
      }
    } else {
      const controlsChanged = this.controls.update();
      if (controlsChanged) {
        this._cutawayDirty = true;
        this._needsRender = true;
        keepLooping = true;
      }
    }

    // 3. Dynamic View-Dependent Dollhouse Cutaway Evaluation only when dirty
    if (this._cutawayDirty) {
      this.updateDynamicCutaway();
      this._cutawayDirty = false;
    }

    // 4. Render Scene only if dirty
    if (this._needsRender) {
      this.renderer.render(this.scene, this.camera);
      this._needsRender = false;
    }

    // 5. Continue loop if active movement, camera animation, or damping
    if (keepLooping) {
      this.invalidate();
    }
  }
}
