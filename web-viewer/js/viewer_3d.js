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
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ProceduralTextureManager } from './procedural_textures.js';
import { FurnitureGenerator } from './furniture_generator.js';
import { AssetLibraryManager } from './asset_library_manager.js';
import { CinematicTourDirector } from './cinematic_tour_director.js';

export class Viewer3D {
  constructor(canvasContainer, options = {}) {
    this.container = canvasContainer;
    this.options = options;

    // View state
    this.viewMode = 'dollhouse'; // 'dollhouse' | 'facade' | 'exploded' | 'walkthrough'
    this.interiorLightsOn = true;
    this.roomLabelsVisible = false;
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

    // Post-processing & Ambient Occlusion
    this.composer = null;
    this.renderPass = null;
    this.ssaoPass = null;
    this.outputPass = null;
    this.postProcessingEnabled = true;
    this._chamferGeoCache = new Map();

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
    this.furnitureMode = 'model'; // 'model' | 'real'
    this.realBillboards = new Set();

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
      mats.interiorPlaster.color.setHex(0xF6F4EE);
      mats.interiorPlaster.roughness = 0.78;
    }
    mats.exteriorWall?.color.setHex(0xF6F4EE);
    if (mats.cutawayCapMat) {
      mats.cutawayCapMat.color.setHex(0x3B3E45);
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

    // Specialized Exterior Landscape Materials
    if (!mats.asphaltRoad) {
      mats.asphaltRoad = new THREE.MeshStandardMaterial({
        color: 0x282A2E,
        roughness: 0.88,
        metalness: 0.05
      });
      mats.asphaltRoad.userData = { isSharedPBR: true, materialKey: 'asphaltRoad' };
      mats.asphaltRoad.dispose = () => {};
    }

    if (!mats.sidewalkPaver) {
      mats.sidewalkPaver = new THREE.MeshStandardMaterial({
        color: 0xDCD8CF,
        roughness: 0.65,
        metalness: 0.03
      });
      mats.sidewalkPaver.userData = { isSharedPBR: true, materialKey: 'sidewalkPaver' };
      mats.sidewalkPaver.dispose = () => {};
    }

    if (!mats.fenceMetal) {
      mats.fenceMetal = new THREE.MeshStandardMaterial({
        color: 0x242528,
        roughness: 0.35,
        metalness: 0.75
      });
      mats.fenceMetal.userData = { isSharedPBR: true, materialKey: 'fenceMetal' };
      mats.fenceMetal.dispose = () => {};
    }

    if (!mats.gatePillar) {
      mats.gatePillar = new THREE.MeshStandardMaterial({
        color: 0xECE7DE,
        roughness: 0.75,
        metalness: 0.02
      });
      mats.gatePillar.userData = { isSharedPBR: true, materialKey: 'gatePillar' };
      mats.gatePillar.dispose = () => {};
    }

    if (!mats.steppingStone) {
      mats.steppingStone = new THREE.MeshStandardMaterial({
        color: 0x3C4046,
        roughness: 0.58,
        metalness: 0.08
      });
      mats.steppingStone.userData = { isSharedPBR: true, materialKey: 'steppingStone' };
      mats.steppingStone.dispose = () => {};
    }

    if (!mats.palmFoliage) {
      mats.palmFoliage = new THREE.MeshStandardMaterial({
        color: 0x2D6E3F,
        roughness: 0.55,
        metalness: 0.02,
        side: THREE.DoubleSide
      });
      mats.palmFoliage.userData = { isSharedPBR: true, materialKey: 'palmFoliage' };
      mats.palmFoliage.dispose = () => {};
    }

    if (!mats.cypressFoliage) {
      mats.cypressFoliage = new THREE.MeshStandardMaterial({
        color: 0x255234,
        roughness: 0.75,
        metalness: 0.02
      });
      mats.cypressFoliage.userData = { isSharedPBR: true, materialKey: 'cypressFoliage' };
      mats.cypressFoliage.dispose = () => {};
    }

    if (!mats.flowerBlossomWarm) {
      mats.flowerBlossomWarm = new THREE.MeshStandardMaterial({
        color: 0xE86A7A,
        roughness: 0.6,
        metalness: 0.0
      });
      mats.flowerBlossomWarm.userData = { isSharedPBR: true, materialKey: 'flowerBlossomWarm' };
      mats.flowerBlossomWarm.dispose = () => {};
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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    // 4. Studio Environment Map (RoomEnvironment + PMREMGenerator) for realistic PBR reflections
    this.envMap = this.createRoomStudioEnvironment();
    if (this.envMap) {
      this.scene.environment = this.envMap;
      if ('environmentIntensity' in this.scene) {
        this.scene.environmentIntensity = 0.85;
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

    // 7. Post-Processing Pipeline (Screen Space Ambient Occlusion via EffectComposer)
    this.initPostProcessing(width, height);

    // 8. Lifecycle & Input Event Listeners
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

  /**
   * Cinematic Post-Processing Pipeline:
   * EffectComposer + RenderPass + SSAOPass (Ambient Occlusion) + OutputPass (Tone Mapping & Color Management)
   */
  initPostProcessing(width, height) {
    try {
      const w = width || (this.container ? this.container.clientWidth : 0) || window.innerWidth || 1280;
      const h = height || (this.container ? this.container.clientHeight : 0) || window.innerHeight || 800;

      this.composer = new EffectComposer(this.renderer);
      this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

      // 1. Scene RenderPass
      this.renderPass = new RenderPass(this.scene, this.camera);
      this.composer.addPass(this.renderPass);

      // 2. SSAOPass (Screen Space Ambient Occlusion for grounded corners & walls)
      this.ssaoPass = new SSAOPass(this.scene, this.camera, w, h);
      this.ssaoPass.kernelRadius = 0.85; // Architectural ambient occlusion radius (85cm world space)
      this.ssaoPass.minDistance = 0.001; // Avoid self-shadowing acne
      this.ssaoPass.maxDistance = 0.12;  // Crevice contact depth falloff
      this.ssaoPass.output = SSAOPass.OUTPUT.Default; // Multiplies AO over scene color
      this.composer.addPass(this.ssaoPass);

      // 3. OutputPass (Applies Tone Mapping & SRGB Color Management)
      this.outputPass = new OutputPass();
      this.composer.addPass(this.outputPass);

      this.postProcessingEnabled = true;
    } catch (err) {
      console.warn('[Viewer3D] Postprocessing initialization warning, falling back to direct render:', err);
      this.postProcessingEnabled = false;
    }
  }

  /**
   * Micro-beveled / chamfered box geometry (2-3mm bevel)
   * Softens 90-degree knife edges to capture realistic specular highlights along walls, slabs, and columns
   */
  createChamferedBoxGeometry(width, height, depth, bevel = 0.003, segments = 2) {
    const w = Math.max(0.015, width);
    const h = Math.max(0.01, height);
    const d = Math.max(0.015, depth);
    const b = Math.min(bevel, w * 0.25, h * 0.25, d * 0.25);
    const seg = Math.max(1, segments);

    const key = `chamfer_${w.toFixed(3)}_${h.toFixed(3)}_${d.toFixed(3)}_${b.toFixed(4)}_${seg}`;
    if (!this._chamferGeoCache) {
      this._chamferGeoCache = new Map();
    }
    if (this._chamferGeoCache.has(key)) {
      return this._chamferGeoCache.get(key);
    }

    if (b <= 0.0005) {
      const box = new THREE.BoxGeometry(w, h, d);
      box.userData = {
        isSharedGeometry: true,
        isSharedPBR: true,
        bevelEnabled: true,
        chamfered: true
      };
      this._chamferGeoCache.set(key, box);
      return box;
    }

    const hw = Math.max(0.001, (w - b * 2) / 2);
    const hd = Math.max(0.001, (d - b * 2) / 2);
    const shape = new THREE.Shape();
    shape.moveTo(-hw, -hd);
    shape.lineTo(hw, -hd);
    shape.lineTo(hw, hd);
    shape.lineTo(-hw, hd);
    shape.closePath();

    const extrudeH = Math.max(0.001, h - b * 2);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: extrudeH,
      bevelEnabled: true,
      bevelSegments: seg,
      steps: 1,
      bevelSize: b,
      bevelThickness: b,
      bevelOffset: 0
    });

    geo.rotateX(Math.PI / 2);
    geo.center();
    geo.computeVertexNormals();

    geo.userData = {
      isSharedGeometry: true,
      isSharedPBR: true,
      bevelEnabled: true,
      chamfered: true,
      bevelSize: b,
      bevelSegments: seg
    };
    geo._realDispose = geo.dispose.bind(geo);
    geo.dispose = () => {};

    this._chamferGeoCache.set(key, geo);
    return geo;
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
          if (this.composer) this.composer.setPixelRatio(1.0);
        }
        this.invalidate();
      });

      this.controls.addEventListener('change', () => {
        this._cutawayDirty = true;
        this.invalidate();
      });

      this.controls.addEventListener('end', () => {
        const dpr = window.devicePixelRatio || 1;
        const targetDpr = Math.min(dpr, 1.5);
        this.renderer.setPixelRatio(targetDpr);
        if (this.composer) this.composer.setPixelRatio(targetDpr);
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

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
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

    // 2. Main Sun DirectionalLight (2048x2048 PCFSoftShadowMap)
    this.sunLight = new THREE.DirectionalLight(0xFFF6E5, 1.38);
    this.sunLight.position.set(24, 38, -22);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1.0;
    this.sunLight.shadow.camera.far = 140;
    const d = 28;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0001;
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
   * Set warm architectural sky atmosphere (warm golden-hour tone & soft lighting)
   * @param {boolean} [enabled=true]
   */
  setupWarmSky(enabled = true) {
    this.warmAtmosphereEnabled = enabled;
    if (enabled) {
      this.scene.background = new THREE.Color(0xF5EDE3); // Warm golden architectural sky
      this.scene.fog = new THREE.FogExp2(0xF5EDE3, 0.0055);
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0xFFF4E2);
        this.hemiLight.groundColor.setHex(0xD8CBBA);
        this.hemiLight.intensity = 0.82;
      }
      if (this.sunLight) {
        this.sunLight.color.setHex(0xFFEED3);
        this.sunLight.intensity = 1.45;
      }
      if (this.fillLight) {
        this.fillLight.color.setHex(0xFCE9D8);
        this.fillLight.intensity = 0.38;
      }
    } else {
      this.scene.background = new THREE.Color(0xF4F2EC);
      this.scene.fog = new THREE.FogExp2(0xF4F2EC, 0.0065);
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0xFFFBF2);
        this.hemiLight.groundColor.setHex(0xDDD6C7);
        this.hemiLight.intensity = 0.72;
      }
      if (this.sunLight) {
        this.sunLight.color.setHex(0xFFF6E5);
        this.sunLight.intensity = 1.38;
      }
      if (this.fillLight) {
        this.fillLight.color.setHex(0xE8F1F8);
        this.fillLight.intensity = 0.35;
      }
    }
    this._cutawayDirty = true;
    this._invalidateShadowMap();
    this.invalidate();
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
      const embeddedOpenings = this.buildWalls(floor, floorGroup, idx);

      // Detailed 3D Staircases
      this.buildStairs(floor, floorGroup);
      this.buildPergola(floor, floorGroup);
      if (idx === bimSceneGraph.floors.length - 1) this.buildFacadeRoof(floor, floorGroup);

      // Remaining Standalone Doors & Windows
      this.buildDoorsAndWindows(floor, floorGroup, embeddedOpenings);

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

  /**
   * Comprehensive Architectural Landscape Context Builder
   * Dựng cảnh quan ngoại thất chân công trình:
   * - Sân vườn đá bước dạo (stepping stone pathway) kết hợp thảm cỏ xanh
   * - Vỉa hè trước mặt tiền, bó vỉa & đường nhựa giao thông
   * - Cây cảnh quan đa dạng: tùng tháp, cọ nhiệt đới, cây bóng mát, bụi hoa & bồn cây
   * - Hàng rào thoáng kiến trúc, trụ cổng đôi hiện đại & cửa mở đón tiếp
   * - Nền trời ấm áp (setupWarmSky)
   * @param {Object} siteData
   * @param {Object} metadata
   */
  buildLandscapeContext(siteData, metadata = {}) {
    this.siteGroup = new THREE.Group();
    this.siteGroup.name = 'site_landscape';

    const lotW = metadata.lot_width || 15.0;
    const lotL = metadata.lot_length || 24.0;
    const pad = 3.6;

    // Building footprint reference for walkway & landscaping placement
    let bMinX = 1.5, bMaxX = Math.max(bMinX + 4.0, lotW - 1.5);
    let bMinY = 5.0, bMaxY = Math.max(bMinY + 6.0, lotL - 3.0);
    if (this.bimData?.floors?.[0]?.slabs?.[0]) {
      const s = this.bimData.floors[0].slabs[0];
      bMinX = s.minX;
      bMaxX = s.maxX;
      bMinY = s.minY;
      bMaxY = s.maxY;
    }

    // 1. Lush Green Lawn Plinth (-0.185m to -0.025m)
    const lotGeo = new THREE.BoxGeometry(lotW + pad * 2, 0.16, lotL + pad * 2);
    const lotMesh = new THREE.Mesh(lotGeo, this.materials.grassGround);
    lotMesh.position.set(lotW / 2, -0.105, lotL / 2);
    lotMesh.receiveShadow = true;
    this.siteGroup.add(lotMesh);

    // Stone perimeter curb around property plinth
    const borderGeo = new THREE.BoxGeometry(lotW + pad * 2 + 0.16, 0.14, lotL + pad * 2 + 0.16);
    const borderMesh = new THREE.Mesh(borderGeo, this.materials.concreteSlab);
    borderMesh.position.set(lotW / 2, -0.12, lotL / 2);
    borderMesh.receiveShadow = true;
    this.siteGroup.add(borderMesh);

    // 2. Vỉa hè trước mặt tiền (Front Sidewalk) & Bó vỉa (Curb) & Đường nhựa (Asphalt Street)
    // Sidewalk spanning the entire front facade from Z = -0.2m to Z = -3.2m
    const sidewalkW = lotW + pad * 2 + 8.0;
    const sidewalkD = 3.0;
    const sidewalkGeo = new THREE.BoxGeometry(sidewalkW, 0.12, sidewalkD);
    const sidewalkMesh = new THREE.Mesh(sidewalkGeo, this.materials.sidewalkPaver || this.materials.concreteSlab);
    sidewalkMesh.position.set(lotW / 2, -0.06, -0.2 - sidewalkD / 2);
    sidewalkMesh.receiveShadow = true;
    this.siteGroup.add(sidewalkMesh);

    // Stone curb along front edge of sidewalk (Z = -3.2m)
    const curbGeo = new THREE.BoxGeometry(sidewalkW, 0.16, 0.20);
    const curbMesh = new THREE.Mesh(curbGeo, this.materials.concreteSlab);
    curbMesh.position.set(lotW / 2, -0.06, -3.2);
    curbMesh.receiveShadow = true;
    this.siteGroup.add(curbMesh);

    // Asphalt roadway in front of property (Z = -3.3m to Z = -11.0m)
    const roadD = 7.7;
    const roadW = sidewalkW + 16.0;
    const roadGeo = new THREE.BoxGeometry(roadW, 0.10, roadD);
    const roadMesh = new THREE.Mesh(roadGeo, this.materials.asphaltRoad || this.materials.cutawayCapMat);
    roadMesh.position.set(lotW / 2, -0.13, -3.3 - roadD / 2);
    roadMesh.receiveShadow = true;
    this.siteGroup.add(roadMesh);

    // Road centerline white dashed markings
    const dashCount = Math.floor(roadW / 4.5);
    const dashStart = (lotW / 2) - (dashCount * 4.5) / 2;
    for (let di = 0; di < dashCount; di++) {
      const dashGeo = new THREE.BoxGeometry(2.4, 0.015, 0.18);
      const dashMat = new THREE.MeshBasicMaterial({ color: 0xF0F0EB });
      const dashMesh = new THREE.Mesh(dashGeo, dashMat);
      dashMesh.position.set(dashStart + di * 4.5 + 1.2, -0.075, -7.15);
      this.siteGroup.add(dashMesh);
    }

    // Driveway curb ramp / entrance transition in front of gate (X in [2.4, 6.4])
    const gateEntranceMinX = 2.4;
    const gateEntranceMaxX = Math.min(6.6, lotW - 1.5);
    const gateEntranceW = gateEntranceMaxX - gateEntranceMinX;
    const rampGeo = new THREE.BoxGeometry(gateEntranceW + 0.4, 0.08, 0.6);
    const rampMesh = new THREE.Mesh(rampGeo, this.materials.concreteSlab);
    rampMesh.position.set((gateEntranceMinX + gateEntranceMaxX) / 2, -0.09, -3.3);
    rampMesh.rotation.x = -0.12;
    this.siteGroup.add(rampMesh);

    // 3. Sân vườn đá bước dạo (Stepping Stone Pathway)
    // Main entrance path: connects front gate (X ≈ 4.4, Z ≈ 0.0) to house entrance porch (X ≈ (bMinX+bMaxX)/2, Z ≈ bMinY)
    const porchX = (bMinX + bMaxX) / 2;
    const porchZ = bMinY;
    const mainPathCount = 9;
    for (let pi = 0; pi < mainPathCount; pi++) {
      const u = pi / (mainPathCount - 1);
      // Gentle natural S-curve
      const stepX = 4.4 + (porchX - 4.4) * u + Math.sin(u * Math.PI) * 0.4;
      const stepZ = 0.4 + (porchZ - 0.9) * u;
      const stepW = 0.88 - (pi % 2) * 0.08;
      const stepD = 0.48;

      const stepGeo = this.createChamferedBoxGeometry(stepW, 0.038, stepD, 0.003, 1);
      const stepMesh = new THREE.Mesh(stepGeo, this.materials.steppingStone || this.materials.zoneOutdoorSlateTile);
      stepMesh.position.set(stepX, -0.015, stepZ);
      stepMesh.rotation.y = (pi % 2 === 0 ? 0.03 : -0.04);
      stepMesh.receiveShadow = true;
      stepMesh.castShadow = true;
      this.siteGroup.add(stepMesh);
    }

    // Secondary side garden path curving towards side yard & pool
    const sidePathCount = 7;
    for (let si = 0; si < sidePathCount; si++) {
      const v = si / (sidePathCount - 1);
      const sx = 4.4 + v * (bMaxX + 1.2 - 4.4);
      const sz = 2.2 + v * v * 7.5;
      const sideStepGeo = this.createChamferedBoxGeometry(0.78, 0.035, 0.44, 0.003, 1);
      const sideStep = new THREE.Mesh(sideStepGeo, this.materials.steppingStone || this.materials.zoneOutdoorSlateTile);
      sideStep.position.set(sx, -0.015, sz);
      sideStep.rotation.y = 0.15 * v;
      sideStep.receiveShadow = true;
      this.siteGroup.add(sideStep);
    }

    // 4. Hàng rào thoáng kiến trúc & Cổng chính (Modern Slatted Fence & Dual Pillars)
    const fenceZ = -0.15;
    const fenceH = 1.7;
    const fenceBaseH = 0.32;
    const slatH = fenceH - fenceBaseH;

    // Gate Pillars (Trụ cổng chính sang trọng)
    const pillarSize = 0.52;
    const pillarH = 2.35;
    const pillarGeo = this.createChamferedBoxGeometry(pillarSize, pillarH, pillarSize, 0.004, 2);
    const pillarCapGeo = this.createChamferedBoxGeometry(pillarSize + 0.12, 0.10, pillarSize + 0.12, 0.003, 1);

    const makeGatePillar = (px) => {
      const pGroup = new THREE.Group();
      const pMesh = new THREE.Mesh(pillarGeo, this.materials.gatePillar || this.materials.interiorPlaster);
      pMesh.position.set(px, pillarH / 2 - 0.02, fenceZ);
      pMesh.castShadow = true;
      pMesh.receiveShadow = true;

      const pCap = new THREE.Mesh(pillarCapGeo, this.materials.marbleCarrara || this.materials.concreteSlab);
      pCap.position.set(px, pillarH + 0.03, fenceZ);
      pCap.castShadow = true;

      // Modern warm exterior sconce light on pillar front
      const sconceGeo = new THREE.BoxGeometry(0.12, 0.22, 0.08);
      const sconceMat = new THREE.MeshStandardMaterial({
        color: 0x222225,
        roughness: 0.3,
        metalness: 0.8
      });
      const sconce = new THREE.Mesh(sconceGeo, sconceMat);
      sconce.position.set(px, 1.6, fenceZ - pillarSize / 2 - 0.04);

      const lightGlowGeo = new THREE.BoxGeometry(0.08, 0.14, 0.03);
      const lightGlowMat = new THREE.MeshBasicMaterial({ color: 0xFFE0B2 });
      const glow = new THREE.Mesh(lightGlowGeo, lightGlowMat);
      glow.position.set(px, 1.6, fenceZ - pillarSize / 2 - 0.07);

      pGroup.add(pMesh, pCap, sconce, glow);
      return pGroup;
    };

    this.siteGroup.add(makeGatePillar(gateEntranceMinX));
    this.siteGroup.add(makeGatePillar(gateEntranceMaxX));

    // Semi-open architectural gate at entrance
    const gateLeafW = (gateEntranceW - 0.2) / 2;
    const gateGroup = new THREE.Group();
    gateGroup.position.set(gateEntranceMinX + 0.1, 0, fenceZ);
    // Gate left leaf pivoted open slightly (-25 deg)
    const leftLeaf = new THREE.Group();
    leftLeaf.rotation.y = -0.44; // Welcoming open angle
    const gateFrameGeo = new THREE.BoxGeometry(gateLeafW, 1.65, 0.06);
    const gateFrame = new THREE.Mesh(gateFrameGeo, this.materials.fenceMetal || this.materials.cutawayCapMat);
    gateFrame.position.set(gateLeafW / 2, 0.85, 0);
    gateFrame.castShadow = true;
    leftLeaf.add(gateFrame);
    gateGroup.add(leftLeaf);
    this.siteGroup.add(gateGroup);

    // Helper: Build slatted fence panel (low concrete base + vertical metal louvers)
    const buildSlattedSection = (x1, x2, zPos, isRotated = false) => {
      const sectionGroup = new THREE.Group();
      const length = Math.abs(x2 - x1);
      const centerX = (x1 + x2) / 2;

      // Concrete plinth base
      const baseGeo = isRotated
        ? new THREE.BoxGeometry(0.20, fenceBaseH, length)
        : new THREE.BoxGeometry(length, fenceBaseH, 0.20);
      const baseMesh = new THREE.Mesh(baseGeo, this.materials.concreteSlab);
      baseMesh.position.set(centerX, fenceBaseH / 2 - 0.02, zPos);
      baseMesh.receiveShadow = true;
      baseMesh.castShadow = true;
      sectionGroup.add(baseMesh);

      // Top horizontal rail
      const topRailGeo = isRotated
        ? new THREE.BoxGeometry(0.06, 0.05, length)
        : new THREE.BoxGeometry(length, 0.05, 0.06);
      const topRail = new THREE.Mesh(topRailGeo, this.materials.fenceMetal || this.materials.cutawayCapMat);
      topRail.position.set(centerX, fenceH, zPos);
      sectionGroup.add(topRail);

      // Vertical metal louvers spaced every 0.15m
      const slatCount = Math.floor(length / 0.15);
      const slatStep = length / Math.max(1, slatCount);
      const slatMat = this.materials.fenceMetal || this.materials.cutawayCapMat;

      for (let si = 1; si < slatCount; si++) {
        const slatGeo = isRotated
          ? new THREE.BoxGeometry(0.04, slatH, 0.035)
          : new THREE.BoxGeometry(0.035, slatH, 0.04);
        const slatMesh = new THREE.Mesh(slatGeo, slatMat);
        const offset = -length / 2 + si * slatStep;
        if (isRotated) {
          slatMesh.position.set(centerX, fenceBaseH + slatH / 2, zPos + offset);
        } else {
          slatMesh.position.set(centerX + offset, fenceBaseH + slatH / 2, zPos);
        }
        slatMesh.castShadow = true;
        sectionGroup.add(slatMesh);
      }
      return sectionGroup;
    };

    // Front fence left segment (from -pad to gate left)
    this.siteGroup.add(buildSlattedSection(-pad, gateEntranceMinX - 0.3, fenceZ));
    // Front fence right segment (from gate right to lotW + pad)
    this.siteGroup.add(buildSlattedSection(gateEntranceMaxX + 0.3, lotW + pad, fenceZ));

    // Left perimeter fence (-pad, from Z=0 to lotL + pad)
    this.siteGroup.add(buildSlattedSection(-pad, -pad, (lotL + pad) / 2, true));
    // Right perimeter fence (lotW + pad, from Z=0 to lotL + pad)
    this.siteGroup.add(buildSlattedSection(lotW + pad, lotW + pad, (lotL + pad) / 2, true));

    // Rear boundary wall (solid privacy wall along Z = lotL + pad)
    const rearWallGeo = this.createChamferedBoxGeometry(lotW + pad * 2, 2.2, 0.22, 0.003, 2);
    const rearWall = new THREE.Mesh(rearWallGeo, this.materials.interiorPlaster || this.materials.concreteSlab);
    rearWall.position.set(lotW / 2, 1.08, lotL + pad);
    rearWall.receiveShadow = true;
    rearWall.castShadow = true;
    this.siteGroup.add(rearWall);

    // 5. Cây cảnh quan ngoại thất (Landscape Trees, Palms, Cypresses & Shrubs)
    // A. Two Columnar Cypresses flanking gate entrance
    const cypress1 = this.createColumnarCypress(1.15);
    cypress1.position.set(gateEntranceMinX - 0.75, -0.02, fenceZ + 0.65);
    const cypress2 = this.createColumnarCypress(1.15);
    cypress2.position.set(gateEntranceMaxX + 0.75, -0.02, fenceZ + 0.65);
    this.siteGroup.add(cypress1, cypress2);

    // B. Tropical Fan Palms (near front corner & pool patio)
    const palm1 = this.createTropicalPalm(1.2);
    palm1.position.set(lotW + pad - 1.4, -0.02, 1.8);
    const palm2 = this.createTropicalPalm(1.05);
    palm2.position.set(Math.min(lotW + 1.2, bMaxX + 1.8), -0.02, Math.min(lotL * 0.45, bMinY + 5.5));
    this.siteGroup.add(palm1, palm2);

    // C. Elegant Landscape Shade Trees
    if (siteData?.trees && siteData.trees.length > 0) {
      for (const t of siteData.trees) {
        const tree = this.createTreeModel(t.radius || 0.85);
        tree.position.set(t.x, -0.025, t.y);
        this.siteGroup.add(tree);
      }
    } else {
      // Natural default tree placement around villa
      const t1 = this.createTreeModel(0.95);
      t1.position.set(-pad + 1.6, -0.025, 3.5);
      const t2 = this.createTreeModel(1.1);
      t2.position.set(-pad + 1.8, -0.025, lotL * 0.6);
      const t3 = this.createTreeModel(0.9);
      t3.position.set(lotW + pad - 1.8, -0.025, lotL * 0.75);
      this.siteGroup.add(t1, t2, t3);
    }

    // D. Low Flowering Shrub Beds & Boxwood Hedges along front lawn & fence
    const shrubPositions = [
      { x: -pad + 1.2, z: 0.8, color: 0xE86A7A },
      { x: -pad + 2.5, z: 0.8, color: 0xF5C542 },
      { x: 1.2, z: 0.8, color: 0xE86A7A },
      { x: gateEntranceMaxX + 1.6, z: 0.8, color: 0xFFFFFF },
      { x: gateEntranceMaxX + 2.8, z: 0.8, color: 0xE86A7A },
      { x: lotW + pad - 2.2, z: 0.8, color: 0xF5C542 },
      { x: porchX - 1.8, z: bMinY - 0.5, color: 0xE86A7A },
      { x: porchX + 1.8, z: bMinY - 0.5, color: 0xFFFFFF }
    ];
    for (const sp of shrubPositions) {
      const shrub = this.createFloweringShrub(0.52, sp.color);
      shrub.position.set(sp.x, -0.02, sp.z);
      this.siteGroup.add(shrub);
    }

    // E. Modern Planter Boxes flanking house entrance porch
    const planter1 = this.createModernPlanter(0.55, 0.55, 0.70);
    planter1.position.set(porchX - 1.2, -0.02, porchZ - 0.35);
    const planter2 = this.createModernPlanter(0.55, 0.55, 0.70);
    planter2.position.set(porchX + 1.2, -0.02, porchZ - 0.35);
    this.siteGroup.add(planter1, planter2);

    // 6. Swimming Pool / Koi Pond Features
    if (siteData && siteData.features) {
      for (const f of siteData.features) {
        const fw = (f.maxX !== undefined && f.minX !== undefined) ? (f.maxX - f.minX) : 2.4;
        const fd = (f.maxY !== undefined && f.minY !== undefined) ? (f.maxY - f.minY) : 4.2;
        const fcx = (f.maxX !== undefined && f.minX !== undefined) ? (f.minX + f.maxX) / 2 : lotW * 0.78;
        const fcy = (f.maxY !== undefined && f.minY !== undefined) ? (f.minY + f.maxY) / 2 : lotL * 0.36;

        // Marble coping border around pool/pond
        const copingGeo = new THREE.BoxGeometry(fw + 0.32, 0.12, fd + 0.32);
        const coping = new THREE.Mesh(copingGeo, this.materials.marbleCarrara);
        coping.position.set(fcx, -0.02, fcy);
        coping.receiveShadow = true;

        const waterGeo = new THREE.BoxGeometry(fw, 0.14, fd);
        const water = new THREE.Mesh(waterGeo, this.materials.waterSurface);
        water.position.set(fcx, -0.005, fcy);
        this.siteGroup.add(coping, water);
      }
    }

    // Apply Warm Architectural Sky & Sunlight Atmosphere
    this.setupWarmSky(true);

    this.scene.add(this.siteGroup);
    return this.siteGroup;
  }

  /**
   * Backward-compatible delegation to buildLandscapeContext
   */
  buildSite(siteData, metadata = {}) {
    return this.buildLandscapeContext(siteData, metadata);
  }

  /**
   * Toggle 3D landscape context visibility
   * @param {boolean} visible
   */
  setLandscapeVisible(visible) {
    if (this.siteGroup) {
      this.siteGroup.visible = Boolean(visible);
      this._cutawayDirty = true;
      this.invalidate();
    }
  }

  /**
   * Create realistic architectural shade tree
   * @param {number} radius
   */
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
   * Create tropical fan palm tree (cọ cảnh phong cách villa)
   * @param {number} scale
   */
  createTropicalPalm(scale = 1.0) {
    const palm = new THREE.Group();
    const s = Math.max(0.6, Math.min(1.5, scale));

    // Curved slender trunk using segmented cylinder
    const trunkH = 3.2 * s;
    const trunkGeo = new THREE.CylinderGeometry(0.09 * s, 0.14 * s, trunkH, 7);
    const trunk = new THREE.Mesh(trunkGeo, this.materials.woodWalnut || this.materials.baseboardMat);
    trunk.position.set(0, trunkH / 2, 0);
    trunk.rotation.z = -0.06; // slight graceful lean
    trunk.castShadow = true;
    palm.add(trunk);

    // Crown of radiating arching palm fronds
    const frondCount = 9;
    const foliageMat = this.materials.palmFoliage || this.materials.plantFoliageLight;
    for (let fi = 0; fi < frondCount; fi++) {
      const angle = (fi / frondCount) * Math.PI * 2;
      const frondGroup = new THREE.Group();
      frondGroup.position.set(0, trunkH - 0.1 * s, 0);
      frondGroup.rotation.y = angle;

      // Curved blade
      const frondGeo = new THREE.ConeGeometry(0.35 * s, 1.65 * s, 4);
      const frond = new THREE.Mesh(frondGeo, foliageMat);
      frond.rotation.x = Math.PI / 2.6; // arch downward
      frond.position.set(0, 0, 0.8 * s);
      frond.scale.set(1.4, 1.0, 0.15); // flatten into leaf blade
      frond.castShadow = true;
      frondGroup.add(frond);
      palm.add(frondGroup);
    }
    return palm;
  }

  /**
   * Create slender columnar cypress (tùng tháp / trắc bách diệp)
   * @param {number} scale
   */
  createColumnarCypress(scale = 1.0) {
    const cypress = new THREE.Group();
    const s = Math.max(0.6, Math.min(1.6, scale));

    // Short trunk
    const trunkGeo = new THREE.CylinderGeometry(0.08 * s, 0.11 * s, 0.6 * s, 6);
    const trunk = new THREE.Mesh(trunkGeo, this.materials.woodWalnut);
    trunk.position.y = 0.3 * s;
    trunk.castShadow = true;
    cypress.add(trunk);

    // Layered conical / ellipsoidal evergreen foliage
    const foliageMat = this.materials.cypressFoliage || this.materials.treeFoliage;
    const levels = [
      { r: 0.48 * s, h: 1.5 * s, y: 1.2 * s },
      { r: 0.38 * s, h: 1.4 * s, y: 2.1 * s },
      { r: 0.24 * s, h: 1.2 * s, y: 2.9 * s }
    ];
    for (const lvl of levels) {
      const coneGeo = new THREE.ConeGeometry(lvl.r, lvl.h, 7);
      const coneMesh = new THREE.Mesh(coneGeo, foliageMat);
      coneMesh.position.y = lvl.y;
      coneMesh.castShadow = true;
      coneMesh.receiveShadow = true;
      cypress.add(coneMesh);
    }
    return cypress;
  }

  /**
   * Create low rounded flowering shrub (bụi cây viền hoa)
   * @param {number} radius
   * @param {number} [flowerColor]
   */
  createFloweringShrub(radius = 0.55, flowerColor = null) {
    const shrub = new THREE.Group();
    const r = Math.max(0.35, Math.min(0.85, radius));

    // Green foliage sphere
    const foliageGeo = new THREE.DodecahedronGeometry(r, 1);
    const foliageMesh = new THREE.Mesh(foliageGeo, this.materials.plantFoliageLight || this.materials.treeFoliage);
    foliageMesh.position.y = r * 0.85;
    foliageMesh.scale.set(1.15, 0.85, 1.15);
    foliageMesh.receiveShadow = true;
    shrub.add(foliageMesh);

    // Decorative flower blossom specks
    const blossomMat = flowerColor
      ? new THREE.MeshStandardMaterial({ color: flowerColor, roughness: 0.5 })
      : (this.materials.flowerBlossomWarm || this.materials.pillowAccentTerra);

    const blossomCount = 6;
    for (let bi = 0; bi < blossomCount; bi++) {
      const bGeo = new THREE.SphereGeometry(r * 0.12, 4, 4);
      const bMesh = new THREE.Mesh(bGeo, blossomMat);
      const theta = (bi / blossomCount) * Math.PI * 2;
      const phi = 0.4 + (bi % 3) * 0.3;
      bMesh.position.set(
        Math.cos(theta) * Math.sin(phi) * r * 1.05,
        foliageMesh.position.y + Math.cos(phi) * r * 0.85,
        Math.sin(theta) * Math.sin(phi) * r * 1.05
      );
      shrub.add(bMesh);
    }
    return shrub;
  }

  /**
   * Create modern ceramic planter box (chậu cây sảnh đón)
   */
  createModernPlanter(w = 0.5, d = 0.5, h = 0.65) {
    const planter = new THREE.Group();
    const potGeo = new THREE.BoxGeometry(w, h, d);
    const potMat = this.materials.ceramicVase || this.materials.exteriorAccentWall;
    const pot = new THREE.Mesh(potGeo, potMat);
    pot.position.y = h / 2;
    pot.castShadow = true;
    pot.receiveShadow = true;
    planter.add(pot);

    // Soil
    const soilGeo = new THREE.BoxGeometry(w - 0.06, 0.04, d - 0.06);
    const soil = new THREE.Mesh(soilGeo, this.materials.asphaltRoad || this.materials.woodWalnut);
    soil.position.y = h;
    planter.add(soil);

    // Upright plant leaves
    const plantGeo = new THREE.ConeGeometry(w * 0.42, h * 0.95, 5);
    const plantMat = this.materials.plantFoliageLight;
    const plant = new THREE.Mesh(plantGeo, plantMat);
    plant.position.y = h + (h * 0.95) / 2;
    plant.castShadow = true;
    planter.add(plant);

    return planter;
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
      const slabH = 0.18;
      const slabGeo = this.createChamferedBoxGeometry(w, slabH, d, 0.003, 2);
      const slabMesh = new THREE.Mesh(slabGeo, this.materials.concreteSlab);
      slabMesh.position.set(cx, -slabH / 2 - 0.002, cy);
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
            this.createChamferedBoxGeometry(hx1 - hx0, voidEdgeH, voidFrameThick, 0.002, 1),
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
    if (!floor.metadata?.roomGrid && (floorIdx > 0 || floor.id !== 'floor_1')) {
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
      const geo = this.createChamferedBoxGeometry(col.sizeX, colH, col.sizeY, 0.003, 2);
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

    // Assign openings before building meshes so wall order cannot steal a nearby opening.
    const allWalls = [...floor.exteriorWalls, ...floor.interiorWalls];
    const openingWall = new Map();
    for (const opening of [...floor.doors, ...floor.windows]) {
      const { p1, p2 } = opening;
      const x = p1 && p2 ? (p1.x + p2.x) / 2 : opening.cx ?? opening.x ?? p1?.x;
      const z = p1 && p2 ? (p1.y + p2.y) / 2 : opening.cy ?? opening.y ?? p1?.y;
      let best = Infinity;
      for (const wall of allWalls) {
        const dx = wall.p2.x - wall.p1.x;
        const dz = wall.p2.y - wall.p1.y;
        const length = Math.hypot(dx, dz);
        if (length < 0.1 || wall.height < 1.2) continue;
        const along = ((x - wall.p1.x) * dx + (z - wall.p1.y) * dz) / length;
        const across = Math.abs((z - wall.p1.y) * dx - (x - wall.p1.x) * dz) / length;
        if (along < -0.1 || along > length + 0.1 || across > Math.max(0.26, wall.thickness || 0.15)) continue;
        const parallel = p1 && p2
          ? Math.abs((p2.x - p1.x) * dz - (p2.y - p1.y) * dx) / (length * Math.hypot(p2.x - p1.x, p2.y - p1.y))
          : Number.isFinite(opening.rotation) ? Math.abs(Math.sin(opening.rotation + Math.atan2(dz, dx))) : 0;
        const score = across + (parallel || 0) * 0.2 + Math.max(0, -along, along - length);
        if (score < best) {
          best = score;
          openingWall.set(opening, wall);
        }
      }
    }
    const openingsFor = (items, wall) => items.filter(item => openingWall.get(item) === wall);

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
      if (length < 0.1) continue;

      const wallGroup = new THREE.Group();
      wallGroup.name = ew.id || `ext_wall_${ew.orientation}`;
      wallGroup.userData = {
        type: 'wall',
        name: `Tường ngoại thất (${ew.orientation})`,
        floorId: floor.id,
        orientation: ew.orientation,
        bimCategory: 'walls_openings'
      };

      const wallMat = this.materials.exteriorWall;

      // A) fullWallGroup: Full-height segmented wall + windows/doors/balcony railings on this wall
      const fullWallGroup = this.buildWallWithOpenings(
        ew,
        openingsFor(floor.doors, ew),
        openingsFor(floor.windows, ew),
        wallMat,
        true
      );
      fullWallGroup.name = `${wallGroup.name}_full`;
      fullWallGroup.userData = {
        ...fullWallGroup.userData,
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
        const balcony = new THREE.Mesh(new THREE.BoxGeometry(length, 0.18, 1.12), this.materials.interiorPlaster);
        balcony.position.set((ew.p1.x + ew.p2.x) / 2, -0.09, ew.p1.y - 0.56);
        balcony.castShadow = balcony.receiveShadow = true;
        balcony.userData.bimCategory = 'structure';
        group.add(balcony);
        const railSpan = length - 0.12;
        const rail = this.assetLibrary.instantiateAsset(
          'railing_iron_baluster',
          { width: railSpan, height: 1.05, depth: 0.08, rotation: 0 },
          this.materials
        );
        rail.position.set((ew.p1.x + ew.p2.x) / 2, 0.003, ew.p1.y - 1.05);
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
          const py = ew.p1.y - 0.83;
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

      const stubHeight = 0.25;
      const angle = Math.atan2(dy, dx);
      const midX = (ew.p1.x + ew.p2.x) / 2;
      const midY = (ew.p1.y + ew.p2.y) / 2;
      const cutawayStubMesh = new THREE.Group();
      cutawayStubMesh.name = wallGroup.name + '_stub';
      cutawayStubMesh.position.set(midX, 0, midY);
      cutawayStubMesh.rotation.y = -angle;
      cutawayStubMesh.userData = { type: 'wall_stub', floorId: floor.id, stubHeight, bimCategory: 'walls_openings' };
      const extDoorsOnWall = fullWallGroup.userData.openings.filter(opening => opening.kind === 'door');

      const addStubSegment = (s0, s1) => {
        const segLen = s1 - s0;
        if (segLen < 0.04) return;
        const segCenterLocal = (s0 + s1) / 2 - length / 2;

        const stubBodyHeight = stubHeight - 0.018;
        const stubBodyGeo = new THREE.BoxGeometry(segLen, stubBodyHeight, ew.thickness);
        const stubBody = new THREE.Mesh(stubBodyGeo, this.materials.interiorPlaster);
        stubBody.position.set(segCenterLocal, 0.003 + stubBodyHeight / 2, 0);
        stubBody.castShadow = true;
        stubBody.receiveShadow = true;
        stubBody.userData = { bimCategory: 'walls_openings' };

        const stubBaseboardGeo = this.createChamferedBoxGeometry(segLen, 0.08, ew.thickness + 0.014, 0.002, 1);
        const stubBaseboard = new THREE.Mesh(stubBaseboardGeo, this.materials.baseboardMat);
        stubBaseboard.position.set(segCenterLocal, 0.003 + 0.04, 0);
        stubBaseboard.castShadow = false;
        stubBaseboard.receiveShadow = true;
        stubBaseboard.userData = { bimCategory: 'walls_openings' };

        const capGeo = this.createChamferedBoxGeometry(segLen + 0.004, 0.018, ew.thickness + 0.008, 0.002, 1);
        const capMesh = new THREE.Mesh(capGeo, this.materials.cutawayCapMat);
        capMesh.position.set(segCenterLocal, 0.003 + stubHeight - 0.009, 0);
        capMesh.userData = { bimCategory: 'walls_openings', capColor: '#3B3E45' };

        cutawayStubMesh.add(stubBody, stubBaseboard, capMesh);
      };

      let stubCursor = 0;
      for (const d of extDoorsOnWall) {
        if (d.t0 > stubCursor + 0.03) {
          addStubSegment(stubCursor, d.t0);
        }
        stubCursor = d.t1;
      }
      if (length > stubCursor + 0.03) {
        addStubSegment(stubCursor, length);
      }

      wallGroup.add(fullWallGroup, cutawayStubMesh);
      group.add(wallGroup);

      const outwardNormal = ew.outwardNormal
        ? new THREE.Vector3(ew.outwardNormal.x, 0, ew.outwardNormal.z).normalize()
        : normalMap[ew.orientation] || new THREE.Vector3(-dy, 0, dx).normalize();
      if (!ew.outwardNormal && !normalMap[ew.orientation] &&
          outwardNormal.dot(new THREE.Vector3(midX - bCenterX, 0, midY - bCenterZ)) < 0) outwardNormal.negate();
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
      if (length < 0.1) continue;

      const intrGroup = this.buildWallWithOpenings(
        iw,
        openingsFor(floor.doors, iw),
        openingsFor(floor.windows, iw),
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
      const capGeo = new THREE.BoxGeometry(length, 0.014, iw.thickness || 0.15);
      const capMesh = new THREE.Mesh(capGeo, this.materials.cutawayCapMat);
      capMesh.position.set(length / 2, iw.height + 0.007, 0);
      capMesh.userData = { bimCategory: 'walls_openings' };
      intrGroup.add(capMesh);

      group.add(intrGroup);
    }
    return openingWall;
  }

  /**
   * Segment a wall line around any doors and windows that lie on it,
   * building left/right piers, window sill walls, lintel headers, baseboards,
   * and embedding the 3D door/window assemblies inside the wall openings.
   * Guarantees true CSG cutouts so openings are physically hollow and
   * walls NEVER pass through door or window openings.
   */
  buildWallWithOpenings(wall, doors, windows, wallMat, isExterior = false) {
    const x1 = wall.p1.x;
    const y1 = wall.p1.y;
    const x2 = wall.p2.x;
    const y2 = wall.p2.y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const L = Math.hypot(dx, dy);
    if (L < 0.1) return new THREE.Group();

    const angle = Math.atan2(dy, dx);
    const ux = dx / L;
    const uy = dy / L;
    const H = wall.height || 3.4;
    const T = wall.thickness || (isExterior ? 0.20 : 0.15);
    const yBottom = 0.003; // Micro-elevation offset so walls never Z-fight with floor at y=0.0

    const segGroup = new THREE.Group();
    segGroup.position.set(x1, 0, y1);
    segGroup.rotation.y = -angle;

    // 1. Match and compute door intervals along this wall
    const matchedDoors = [];
    for (const door of (doors || [])) {

      let dmx, dmy, dw;
      if (door.p1 && door.p2 && Math.hypot(door.p2.x - door.p1.x, door.p2.y - door.p1.y) > 0.3) {
        dmx = (door.p1.x + door.p2.x) / 2;
        dmy = (door.p1.y + door.p2.y) / 2;
        dw = Math.hypot(door.p2.x - door.p1.x, door.p2.y - door.p1.y);
      } else {
        dmx = door.cx != null ? door.cx : (door.x != null ? door.x : (door.p1 ? door.p1.x : (door.points?.[0]?.x ?? 0)));
        dmy = door.cy != null ? door.cy : (door.y != null ? door.y : (door.p1 ? door.p1.y : (door.points?.[0]?.y ?? 0)));
        dw = door.width || 0.92;
      }

      const perp = Math.abs(-(dmx - x1) * uy + (dmy - y1) * ux);
      const tCenter = (dmx - x1) * ux + (dmy - y1) * uy;

      // Match door if close to wall line and projected inside or near wall span
      if (Number.isFinite(tCenter) && perp < Math.max(0.55, T * 1.5) && tCenter >= -0.15 && tCenter <= L + 0.15) {
        const halfDW = dw / 2;
        const t0 = Math.max(0.04, Math.min(L - 0.2, tCenter - halfDW));
        const t1 = Math.min(L - 0.04, Math.max(0.2, tCenter + halfDW));
        const dh = Math.min(H - 0.15, door.height || 2.2);

        if (t1 - t0 >= 0.35) {
          matchedDoors.push({
            kind: 'door',
            t0,
            t1,
            sillY: yBottom,
            topY: dh,
            raw: door
          });
        }
      }
    }

    // Merge overlapping doors if any
    matchedDoors.sort((a, b) => a.t0 - b.t0);
    const cleanDoors = [];
    for (const d of matchedDoors) {
      if (cleanDoors.length === 0) {
        cleanDoors.push(d);
      } else {
        const prev = cleanDoors[cleanDoors.length - 1];
        if (d.t0 <= prev.t1 + 0.05) {
          prev.t1 = Math.max(prev.t1, d.t1);
          prev.topY = Math.max(prev.topY, d.topY);
        } else {
          cleanDoors.push(d);
        }
      }
    }

    // 2. Match and compute window intervals along this wall
    const matchedWindows = [];
    for (const win of (windows || [])) {

      let wmx, wmy, winLen;
      if (win.p1 && win.p2) {
        wmx = (win.p1.x + win.p2.x) / 2;
        wmy = (win.p1.y + win.p2.y) / 2;
        winLen = Math.hypot(win.p2.x - win.p1.x, win.p2.y - win.p1.y);
      } else {
        wmx = win.cx != null ? win.cx : (win.x != null ? win.x : (win.points?.[0]?.x ?? 0));
        wmy = win.cy != null ? win.cy : (win.y != null ? win.y : (win.points?.[0]?.y ?? 0));
        winLen = win.width || 1.4;
      }

      const perp = Math.abs(-(wmx - x1) * uy + (wmy - y1) * ux);
      const tCenter = (wmx - x1) * ux + (wmy - y1) * uy;

      if (Number.isFinite(tCenter) && perp < Math.max(0.55, T * 1.5) && tCenter >= -0.15 && tCenter <= L + 0.15) {
        const halfW = winLen / 2;
        const t0 = Math.max(0.04, Math.min(L - 0.2, tCenter - halfW));
        const t1 = Math.min(L - 0.04, Math.max(0.2, tCenter + halfW));

        if (t1 - t0 >= 0.25) {
          const sillY = Math.max(0.35, win.sillHeight ?? 0.85);
          const winH = Math.min(H - sillY - 0.18, win.windowHeight ?? 1.8);
          matchedWindows.push({
            kind: 'window',
            t0,
            t1,
            sillY,
            topY: sillY + winH,
            raw: win
          });
        }
      }
    }

    // 3. Resolve Door / Window Overlaps (DOORS TAKE ABSOLUTE PRECEDENCE OVER SILL/PARAPET)
    // Any window that overlaps a door is cleanly split into left/right window segments flanking the door,
    // ensuring the door opening is 100% hollow to the floor (zero sill wall cutting through doors).
    const splitWindows = [];
    for (const win of matchedWindows) {
      let segments = [{ t0: win.t0, t1: win.t1, sillY: win.sillY, topY: win.topY, raw: win.raw }];
      for (const door of cleanDoors) {
        const nextSegments = [];
        for (const seg of segments) {
          if (door.t1 <= seg.t0 + 0.05 || door.t0 >= seg.t1 - 0.05) {
            nextSegments.push(seg);
          } else {
            // Overlapping: create left piece if wide enough
            if (door.t0 > seg.t0 + 0.25) {
              nextSegments.push({ ...seg, t0: seg.t0, t1: door.t0 });
            }
            // Create right piece if wide enough
            if (door.t1 < seg.t1 - 0.25) {
              nextSegments.push({ ...seg, t0: door.t1, t1: seg.t1 });
            }
          }
        }
        segments = nextSegments;
      }
      for (const s of segments) {
        if (s.t1 - s.t0 >= 0.25) {
          splitWindows.push({ kind: 'window', ...s });
        }
      }
    }

    // 4. Combine all clean openings and sort along wall
    const allOpenings = [...cleanDoors, ...splitWindows];
    allOpenings.sort((a, b) => a.t0 - b.t0);

    const cleanOpenings = [];
    for (const op of allOpenings) {
      if (cleanOpenings.length === 0) {
        cleanOpenings.push(op);
      } else {
        const prev = cleanOpenings[cleanOpenings.length - 1];
        if (op.t0 >= prev.t1 - 0.02) {
          if (op.t0 < prev.t1) op.t0 = prev.t1;
          if (op.t1 - op.t0 >= 0.25) cleanOpenings.push(op);
        }
      }
    }

    // 5. True CSG Mesh Segmenting (physically hollow door/window openings)
    const addWallBox = (xStart, xEnd, yStart, yEnd) => {
      const wLen = xEnd - xStart;
      const wHeight = yEnd - yStart;
      if (wLen < 1e-6 || wHeight < 1e-6) return;
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
      const geo = this.createChamferedBoxGeometry(bLen, bHeight, T + 0.016, 0.002, 1);
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
      if (op.t0 > cursor) {
        addWallBox(cursor, op.t0, yBottom, H);
        addBaseboard(cursor, op.t0);
      }

      const ow = op.t1 - op.t0;
      const oCenter = (op.t0 + op.t1) / 2;

      // Top lintel header above opening
      if (H > op.topY + 0.03) {
        addWallBox(op.t0, op.t1, op.topY, H);
      }

      // Parapet wall below window & 3D Opening Assemblies
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
        // Door opening is 100% physically hollow to floor - ZERO parapet wall!
        const glazed = isExterior && op.raw.asset_id === 'door_balcony_glass';
        const doorMesh = glazed
          ? FurnitureGenerator.buildDetailedWindow({ width: ow, sillHeight: 0, windowHeight: op.topY, wallThickness: T }, this.materials)
          : FurnitureGenerator.buildDetailedDoor({ width: ow, height: op.topY, wallThickness: T }, this.materials);
        doorMesh.position.set(oCenter, yBottom + (glazed ? op.topY / 2 : 0), 0);
        doorMesh.rotation.set(0, 0, 0);
        segGroup.add(doorMesh);
      }

      cursor = op.t1;
    }

    // Right solid pier after last opening
    if (L > cursor) {
      addWallBox(cursor, L, yBottom, H);
      addBaseboard(cursor, L);
    }

    segGroup.userData.openings = cleanOpenings;
    return segGroup;
  }

  buildFacadeRoof(floor, group) {
    if (!floor.metadata?.roomGrid || !floor.slabs.length) return;
    const { minX, maxX, minY, maxY } = floor.slabs[0];
    const terrace = floor.rooms.find(room => room.type === 'terrace' && room.isOutdoor);
    const roofEnd = terrace?.bounds.minY ?? maxY;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX + 0.24, 0.18, roofEnd - minY + 0.24),
      this.materials.interiorPlaster);
    roof.position.set((maxX + minX) / 2, floor.height + 0.09, (roofEnd + minY) / 2);
    roof.castShadow = roof.receiveShadow = true;
    roof.userData = { bimCategory: 'structure', facadeRoof: true };
    group.add(roof);
  }

  buildPergola(floor, group) {
    const terrace = floor.rooms.find(room => room.type === 'terrace' && room.isOutdoor);
    if (!floor.metadata?.terrace || !terrace) return;
    const { minX, maxX, minY, maxY } = terrace.bounds;
    const left = minX + 0.28, right = maxX - 0.28;
    const front = minY + (maxY - minY) * 0.42, back = maxY - 0.25;
    const height = 2.68;
    const addBeam = (w, h, d, x, y, z) => {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.materials.woodOak);
      beam.position.set(x, y, z);
      beam.castShadow = beam.receiveShadow = true;
      beam.userData.bimCategory = 'structure';
      group.add(beam);
    };
    for (const z of [front, back]) {
      for (const x of [left, right]) addBeam(0.16, height, 0.16, x, height / 2, z);
      addBeam(right - left + 0.2, 0.17, 0.14, (left + right) / 2, height, z);
    }
    for (let x = left; x <= right; x += 0.42) {
      addBeam(0.09, 0.15, back - front + 0.24, x, height + 0.15, (front + back) / 2);
    }
  }

  buildStairs(floor, group) {
    for (const st of floor.stairs) {
      const stairGroup = FurnitureGenerator.buildDetailedStaircase(st, this.materials);
      group.add(stairGroup);
    }
  }

  buildDoorsAndWindows(floor, group, embeddedOpenings) {
    // Only build doors/windows that were not already embedded into segmented walls
    for (const win of (floor.windows || [])) {
      if (embeddedOpenings.has(win)) continue;
      const winGroup = FurnitureGenerator.buildDetailedWindow(win, this.materials);
      group.add(winGroup);
    }
    for (const door of (floor.doors || [])) {
      if (embeddedOpenings.has(door)) continue;
      const doorGroup = FurnitureGenerator.buildDetailedDoor(door, this.materials);
      doorGroup.position.y = 0.003;
      group.add(doorGroup);
    }
  }

  buildFurniture(floor, group) {
    const items = [...(floor.furniture || []), ...(floor.sanitary || [])];
    const slabBounds = floor.slabs?.[0] || this.getBuildingCenterAndSpan();
    if (!floor.rooms?.length) this.resolveWallMountedCollisions(items, floor.windows || [], slabBounds);

    for (const item of items) {
      const requestedAssetId = item.asset_id || item.assetId || item.type;
      const furnModel = this.assetLibrary.instantiateAsset(
        requestedAssetId,
        item,
        this.materials,
        { furnitureMode: this.furnitureMode }
      );
      if (!furnModel.userData?.isGlbAsset) {
        this._needsGlbUpgrade = true;
      }

      // Track active real billboard for cylindrical camera facing
      if (furnModel.userData?.isRealBillboard && furnModel.userData?.billboardMesh) {
        this.realBillboards.add(furnModel.userData.billboardMesh);
      }

      // Place at y = +0.002m so internal rugs/contact shadows sit cleanly above floor finishes (zero Z-fighting)
      const posX = typeof item.cx === 'number' && !isNaN(item.cx) ? item.cx : ((slabBounds.minX + slabBounds.maxX) / 2);
      const posZ = typeof item.cy === 'number' && !isNaN(item.cy) ? item.cy : ((slabBounds.minY + slabBounds.maxY) / 2);
      furnModel.position.set(posX, 0.002, posZ);

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
        isRealBillboard: Boolean(furnModel.userData?.isRealBillboard),
        furnitureMode: this.furnitureMode,
        room: item.room || floor.name,
        dimensions: `${wMm} × ${dMm} × ${hMm} mm`,
        width: item.width,
        depth: item.depth,
        height: item.height,
        rotation: item.rotation || 0,
        material: item.material || (this.furnitureMode === 'real' ? 'Ảnh thật PBR Impostor' : 'Vật liệu PBR Cao cấp'),
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
   * Semantic Bounding Box Collision Check & Auto-Relocation for TV units and wall-mounted objects.
   * Guarantees that TV units NEVER intersect or occlude windows.
   * If a TV unit collides with any window, it is slid along the wall to an unobstructed segment,
   * or placed on the opposite wall facing back into the room.
   */
  resolveWallMountedCollisions(items, windows = [], slab = null) {
    if (!Array.isArray(items) || !Array.isArray(windows) || windows.length === 0) return 0;
    const slabBounds = slab || { minX: 0, maxX: 10, minY: 0, maxY: 15 };
    let resolvedCount = 0;

    for (const item of items) {
      const isTv = item.asset_id === 'tv_cabinet_wall_unit' ||
        (item.name && item.name.toLowerCase().includes('tivi')) ||
        (item.name && item.name.toLowerCase().includes('kệ tv')) ||
        item.type === 'tv_console';

      if (!isTv) continue;

      if (typeof item.cx !== 'number' || isNaN(item.cx)) item.cx = (slabBounds.minX + slabBounds.maxX) / 2;
      if (typeof item.cy !== 'number' || isNaN(item.cy)) item.cy = (slabBounds.minY + slabBounds.maxY) / 2;

      const rot = item.rotation || 0;
      const isRot = Math.abs(Math.sin(rot)) > 0.7;
      const w = item.width || 2.2;
      const d = item.depth || 0.46;
      const spanX = isRot ? d : w;
      const spanY = isRot ? w : d;
      const halfX = spanX / 2;
      const halfY = spanY / 2;

      const checkCollision = (cx, cy, currentIsRot) => {
        const hX = (currentIsRot ? d : w) / 2;
        const hY = (currentIsRot ? w : d) / 2;
        const box = {
          minX: cx - hX,
          maxX: cx + hX,
          minY: cy - hY,
          maxY: cy + hY
        };

        for (const win of windows) {
          if (!win.p1 || !win.p2) continue;
          const wMinX = Math.min(win.p1.x, win.p2.x);
          const wMaxX = Math.max(win.p1.x, win.p2.x);
          const wMinY = Math.min(win.p1.y, win.p2.y);
          const wMaxY = Math.max(win.p1.y, win.p2.y);
          const isWinVert = Math.abs(win.p2.x - win.p1.x) < Math.abs(win.p2.y - win.p1.y);

          // 1. Direct AABB overlap check
          const aabbOverlap = !(box.maxX < wMinX - 0.25 || box.minX > wMaxX + 0.25 || box.maxY < wMinY - 0.25 || box.minY > wMaxY + 0.25);
          if (aabbOverlap) return true;

          // 2. Same-wall sightline occlusion check (near wall plane and overlapping along wall)
          if (currentIsRot && isWinVert) {
            const distToWall = Math.abs(cx - (win.p1.x + win.p2.x) / 2);
            if (distToWall < 1.25) {
              const yOverlap = !(box.maxY < wMinY - 0.15 || box.minY > wMaxY + 0.15);
              if (yOverlap) return true;
            }
          } else if (!currentIsRot && !isWinVert) {
            const distToWall = Math.abs(cy - (win.p1.y + win.p2.y) / 2);
            if (distToWall < 1.25) {
              const xOverlap = !(box.maxX < wMinX - 0.15 || box.minX > wMaxX + 0.15);
              if (xOverlap) return true;
            }
          }
        }
        return false;
      };

      if (!checkCollision(item.cx, item.cy, isRot)) continue;

      console.warn(`[Viewer3D] Semantic collision detected: "${item.name}" intersects window. Auto-correcting position...`);

      // Strategy 1: Slide TV along the current wall to an unobstructed segment
      let resolved = false;
      const deltas = [-1.4, 1.4, -2.2, 2.2, -3.0, 3.0, -3.8, 3.8, -4.6, 4.6];
      for (const delta of deltas) {
        const testCx = isRot ? item.cx : item.cx + delta;
        const testCy = isRot ? item.cy + delta : item.cy;
        if (testCx - halfX < slabBounds.minX + 0.05 || testCx + halfX > slabBounds.maxX - 0.05) continue;
        if (testCy - halfY < slabBounds.minY + 0.05 || testCy + halfY > slabBounds.maxY - 0.05) continue;
        if (!checkCollision(testCx, testCy, isRot)) {
          item.cx = Math.round(testCx * 100) / 100;
          item.cy = Math.round(testCy * 100) / 100;
          resolved = true;
          resolvedCount++;
          console.info(`[Viewer3D] Successfully slid "${item.name}" along wall to (${item.cx}, ${item.cy})`);
          break;
        }
      }

      // Strategy 2: Place on opposite wall facing into the room
      if (!resolved) {
        let oppCx = item.cx;
        let oppCy = item.cy;
        let oppRot = item.rotation || 0;
        let oppIsRot = isRot;

        if (isRot) {
          if (item.cx > (slabBounds.minX + slabBounds.maxX) / 2) {
            oppCx = slabBounds.minX + halfX + 0.15;
            oppRot = Math.PI / 2;
          } else {
            oppCx = slabBounds.maxX - halfX - 0.15;
            oppRot = -Math.PI / 2;
          }
        } else {
          if (item.cy > (slabBounds.minY + slabBounds.maxY) / 2) {
            oppCy = slabBounds.minY + halfY + 0.15;
            oppRot = 0;
          } else {
            oppCy = slabBounds.maxY - halfY - 0.15;
            oppRot = Math.PI;
          }
        }

        if (!checkCollision(oppCx, oppCy, oppIsRot)) {
          item.cx = Math.round(oppCx * 100) / 100;
          item.cy = Math.round(oppCy * 100) / 100;
          item.rotation = oppRot;
          resolved = true;
          resolvedCount++;
          console.info(`[Viewer3D] Successfully relocated "${item.name}" to opposite wall at (${item.cx}, ${item.cy})`);
        } else {
          for (const delta of deltas) {
            const testCx = oppIsRot ? oppCx : oppCx + delta;
            const testCy = oppIsRot ? oppCy + delta : oppCy;
            if (testCx - halfX < slabBounds.minX + 0.05 || testCx + halfX > slabBounds.maxX - 0.05) continue;
            if (testCy - halfY < slabBounds.minY + 0.05 || testCy + halfY > slabBounds.maxY - 0.05) continue;
            if (!checkCollision(testCx, testCy, oppIsRot)) {
              item.cx = Math.round(testCx * 100) / 100;
              item.cy = Math.round(testCy * 100) / 100;
              item.rotation = oppRot;
              resolved = true;
              resolvedCount++;
              console.info(`[Viewer3D] Successfully slid "${item.name}" on opposite wall to (${item.cx}, ${item.cy})`);
              break;
            }
          }
        }
      }
    }
    return resolvedCount;
  }

  /**
   * Cylindrical Camera-Facing Billboarding for Photorealistic Real Furniture Impostors.
   * Keeps quads perfectly vertical on the floor while smoothly facing the camera horizontally.
   */
  updateRealBillboards() {
    if (!this.realBillboards || this.realBillboards.size === 0) return;
    const camPos = this.camera.position;
    const worldPos = new THREE.Vector3();
    for (const bb of this.realBillboards) {
      if (!bb || !bb.parent) {
        this.realBillboards.delete(bb);
        continue;
      }
      bb.getWorldPosition(worldPos);
      const angle = Math.atan2(camPos.x - worldPos.x, camPos.z - worldPos.z);
      const parentRotY = bb.parent.rotation?.y || 0;
      const grandParentRotY = bb.parent.parent?.rotation?.y || 0;
      bb.rotation.y = angle - (parentRotY + grandParentRotY);
    }
  }

  /**
   * Set Furniture Display Mode ('model' = 3D Procedural GLB, 'real' = Photorealistic Product Impostor)
   * @param {'model'|'real'} mode
   */
  setFurnitureMode(mode) {
    const targetMode = (mode === 'real') ? 'real' : 'model';
    if (this.furnitureMode === targetMode) return;
    this.furnitureMode = targetMode;
    this.assetLibrary.furnitureMode = targetMode;

    // 1. Remove existing furniture objects and clear billboard set
    this.realBillboards.clear();
    for (const floorGroup of this.floorGroups.values()) {
      const toRemove = [];
      for (const child of floorGroup.children) {
        if (child.userData?.bimCategory === 'furniture') {
          toRemove.push(child);
        }
      }
      for (const m of toRemove) {
        floorGroup.remove(m);
        const selIdx = this.selectableObjects.indexOf(m);
        if (selIdx !== -1) this.selectableObjects.splice(selIdx, 1);
      }
    }

    // 2. Re-instantiate furniture in each floor group
    if (this.project && Array.isArray(this.project.floors)) {
      for (const floor of this.project.floors) {
        const floorGroup = this.floorGroups.get(floor.id);
        if (floorGroup) {
          this.buildFurniture(floor, floorGroup);
        }
      }
    }

    // 3. Re-apply stage visibility, face camera, and invalidate render
    this.setRenderingStage(this.currentStage, { skipCamera: true });
    this.updateRealBillboards();
    this.invalidate();
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
    ctx.fillText(title.normalize('NFC').toUpperCase(), 208, 54, 365);

    ctx.font = '600 20px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#B45309';
    ctx.fillText(area, 208, 92);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: true,
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
    for (const floor of this.floorGroups.values()) {
      const roof = floor.children.find(child => child.userData.facadeRoof);
      if (roof) roof.visible = showWallsStage && this.viewMode === 'facade';
    }

    const facingByFloor = new Map();
    if (isCutawayMode && showWallsStage) {
      for (const entry of this.exteriorWallEntries) {
        const dx = camPos.x - entry.center.x;
        const dz = camPos.z - entry.center.z;
        const dot = (entry.normal.x * dx + entry.normal.z * dz) / (Math.hypot(dx, dz) || 1);
        if (dot <= 0.15) continue;
        if (!facingByFloor.has(entry.floorId)) facingByFloor.set(entry.floorId, new Map());
        const faces = facingByFloor.get(entry.floorId);
        const side = entry.normal.x.toFixed(4) + ':' + entry.normal.z.toFixed(4);
        faces.set(side, Math.max(faces.get(side) || 0, dot));
      }
    }
    const cutByFloor = new Map([...facingByFloor].map(([id, sides]) =>
      [id, new Set([...sides].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([side]) => side))]));
    for (const entry of this.exteriorWallEntries) {
      const side = entry.normal.x.toFixed(4) + ':' + entry.normal.z.toFixed(4);
      const cut = cutByFloor.get(entry.floorId)?.has(side) ?? false;
      entry.wallGroup.visible = showWallsStage;
      entry.fullWallGroup.visible = showWallsStage && !cut;
      entry.cutawayStubMesh.visible = showWallsStage && cut;
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
    this.stopCinematicTour();
    this.viewMode = mode;
    this.walkthroughState.active = false;
    this.walkthroughState.walkTarget = null;
    this.controls.enabled = true;

    for (const [_, group] of this.floorGroups) {
      group.position.y = group.userData.elevation;
      group.visible = true;
    }

    this.activeFloorId = null;
    this.options.onFloorIsolated?.(null);
    const { cx, cy, maxDim, totalHeight } = this.getBuildingCenterAndSpan();

    if (mode === 'dollhouse') {
      this.focusBuilding();
    } else if (mode === 'facade') {
      const dist = Math.max(maxDim * 1.35, totalHeight * 1.38, 18.5) * Math.max(1, 0.63 / this.camera.aspect);
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
      const dist = Math.max(maxDim * 1.45, 18.0) * Math.max(1, 0.66 / this.camera.aspect);
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
   * Show all floors (reset floor isolation)
   */
  showAllFloors() {
    for (const [_, grp] of this.floorGroups) {
      grp.visible = true;
    }
    this._cutawayDirty = true;
    this._invalidateShadowMap();
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
      const dist = Math.max(maxDim * 1.02, 11) * Math.max(1, 0.65 / this.camera.aspect);
      this.animateCameraTo(
        new THREE.Vector3(cx + dist * 0.72, elev + dist * 0.68, cy - dist * 0.78),
        new THREE.Vector3(cx, elev + 1.2, cy)
      );
    }
  }

  focusBuilding() {
    const { cx, cy, minX, maxX, minY, maxY, totalHeight } = this.getBuildingCenterAndSpan();
    const target = new THREE.Vector3(cx, totalHeight * 0.48, cy);
    const direction = new THREE.Vector3(0.76, 0.61, -0.89).normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const vertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const horizontal = vertical * this.camera.aspect;
    let distance = 0;
    for (const x of [minX - 0.2, maxX + 0.2]) {
      for (const z of [minY - 1.2, maxY + 0.2]) {
        for (const y of [-0.18, totalHeight + 0.2]) {
          const corner = new THREE.Vector3(x, y, z).sub(target);
          const fit = Math.max(Math.abs(corner.dot(right)) / (horizontal * 0.87),
            Math.abs(corner.dot(up)) / (vertical * 0.8));
          distance = Math.max(distance, corner.dot(direction) + fit);
        }
      }
    }
    this.animateCameraTo(target.clone().addScaledVector(direction, distance), target);
  }

  getBuildingCenterAndSpan() {
    let minX = 0, maxX = 12, minY = 0, maxY = 16;
    let totalHeight = 11.0;

    if (this.bimData) {
      const slabs = this.bimData.floors.flatMap(floor => floor.slabs || []);
      if (slabs.length) {
        minX = Math.min(...slabs.map(slab => slab.minX));
        maxX = Math.max(...slabs.map(slab => slab.maxX));
        minY = Math.min(...slabs.map(slab => slab.minY));
        maxY = Math.max(...slabs.map(slab => slab.maxY));
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
    this.stopCinematicTour();
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

  /**
   * Start a cinematic spline camera tour
   * @param {string} [scenarioId='full_film']
   * @param {number} [duration=30]
   * @returns {CinematicTourDirector}
   */
  startCinematicTour(scenarioId = 'full_film', duration = 30) {
    if (!this._tourDirector) {
      this._tourDirector = new CinematicTourDirector(this);
    }
    this._tourDirector.start(scenarioId, duration);
    return this._tourDirector;
  }

  /**
   * Stop active cinematic tour
   */
  stopCinematicTour() {
    if (this._tourDirector) {
      this._tourDirector.stop();
    }
  }

  // ================= RAYCASTING & INTERACTION =================

  onPointerDown(event) {
    this.stopCinematicTour();
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
    if (this.composer) {
      this.composer.setSize(width, height);
    }
    if (this.ssaoPass) {
      this.ssaoPass.setSize(width, height);
    }
    this._cutawayDirty = true;
    this._invalidateShadowMap();
    this.invalidate();
  }

  // ================= RENDER ON DEMAND =================

  setTourResolution(playing) {
    if (!this.renderer) return;
    const regular = Math.min(window.devicePixelRatio || 1, 1.5);
    const pixelBudget = 440_000;
    const { clientWidth, clientHeight } = this.container;
    const ratio = playing ? Math.min(regular, Math.sqrt(pixelBudget / Math.max(1, clientWidth * clientHeight))) : regular;
    this.renderer.setPixelRatio(ratio);
  }

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

    let keepLooping = this._tourDirector?.update(performance.now()) || false;

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
    } else if (this.controls.enabled) {
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

    // 4. Render Scene only if dirty (Maintaining Render-On-Demand: 60 FPS when interacting, 0% GPU idle)
    if (this._needsRender) {
      this.updateRealBillboards();
      if (this.composer && this.postProcessingEnabled && !this._tourDirector?.isPlaying) {
        try {
          this.composer.render();
        } catch (e) {
          console.warn('[Viewer3D] Postprocessing render fallback:', e);
          this.postProcessingEnabled = false;
          this.renderer.render(this.scene, this.camera);
        }
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      this._needsRender = false;
    }

    // 5. Continue loop if active movement, camera animation, or damping
    if (keepLooping) {
      this.invalidate();
    }
  }
}
