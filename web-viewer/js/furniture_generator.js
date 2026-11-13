/**
 * furniture_generator.js
 * OpenCADStudio_Z / Nếp Nhà - Hồ sơ kiến trúc
 *
 * High-Detail Parametric 3D Furniture & Architectural Element Generator.
 * Builds beveled, curved, multi-part 3D BIM models for Living Room, Kitchen & Dining,
 * Bedrooms, Traditional Vietnamese Ancestral Altar, Gym, Rooftop/Landscaping, Bathrooms,
 * plus full 3D Staircases, Doors, Windows, and Balcony Railings.
 */

import * as THREE from 'three';
import { ProceduralTextureManager } from './procedural_textures.js';

export class FurnitureGenerator {
  static _geoCache = new Map();

  constructor(materials = null) {
    this.materials = materials || ProceduralTextureManager.getMaterials();
  }

  static _getMaterials(materials) {
    const base = ProceduralTextureManager.getMaterials();
    if (!materials) return base;
    return new Proxy(materials, {
      get(target, prop) {
        return target[prop] || base[prop] || base.woodOak;
      }
    });
  }

  /**
   * Create a centered 3D rounded/beveled box geometry using ExtrudeGeometry.
   * Cached by dimensions to minimize memory and GC overhead.
   */
  static createRoundedBoxGeometry(width, height, depth, radius = 0.025, segments = 1) {
    const w = Math.max(0.02, width);
    const h = Math.max(0.01, height);
    const d = Math.max(0.02, depth);
    const r = Math.min(radius, w * 0.35, h * 0.35, d * 0.35);

    const seg = Math.min(segments, 1);
    const key = `rbox_${w.toFixed(3)}_${h.toFixed(3)}_${d.toFixed(3)}_${r.toFixed(3)}_${seg}`;
    if (this._geoCache.has(key)) {
      return this._geoCache.get(key);
    }

    const innerW = Math.max(0.005, w - r * 2);
    const innerD = Math.max(0.005, d - r * 2);
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

    const extrudeDepth = Math.max(0.004, h - r * 2);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: extrudeDepth,
      bevelEnabled: true,
      bevelSegments: seg,
      steps: 1,
      bevelSize: r,
      bevelThickness: r,
      curveSegments: Math.max(2, seg * 2)
    });

    // Rotate so extrusion is along Y (height) and center at (0, 0, 0)
    geo.rotateX(Math.PI / 2);
    geo.center();
    geo.computeVertexNormals();
    geo.userData = {
      isSharedGeometry: true,
      isSharedPBR: true,
      bevelEnabled: true,
      chamfered: true,
      bevelSize: r,
      bevelSegments: seg
    };
    geo._realDispose = geo.dispose.bind(geo);
    geo.dispose = () => {};

    this._geoCache.set(key, geo);
    return geo;
  }

  static _markDetail(...meshes) {
    for (const m of meshes) {
      if (m) {
        m.castShadow = false;
        m.userData = { ...(m.userData || {}), castShadow: false };
      }
    }
  }

  static _markPrimary(...meshes) {
    for (const m of meshes) {
      if (m) {
        m.castShadow = true;
        m.userData = { ...(m.userData || {}), castShadow: true };
      }
    }
  }

  /**
   * Helper to mark all meshes in a group as casting/receiving shadows & shared geometry flag.
   * Only primary meshes cast shadows; small detail meshes have castShadow disabled.
   */
  static _finalizeGroup(group, bimCategory = 'furniture') {
    group.traverse((child) => {
      if (child.isMesh) {
        if (child.userData.castShadow === false) {
          child.castShadow = false;
        } else if (child.userData.castShadow === true) {
          child.castShadow = true;
        } else if (child.castShadow === true) {
          // already explicitly set to true
        } else {
          child.castShadow = (bimCategory === 'structure');
        }
        if (child.userData.receiveShadow !== false) {
          child.receiveShadow = true;
        }
      }
      child.userData = { ...child.userData, bimCategory };
    });
    return group;
  }

  /**
   * Build a high-detail multi-part 3D furniture model scaled to item dimensions.
   * @param {Object} item - { type, name, width, depth, height, rotation, cx, cy, ... }
   * @param {Object} materials - PBR material dictionary from ProceduralTextureManager
   * @returns {THREE.Group}
   */
  static createFurnitureMesh(item, materials = null) {
    const mats = this._getMaterials(materials);
    const root = new THREE.Group();
    const inner = new THREE.Group();
    root.add(inner);

    const rawW = Math.max(0.3, item.width || 1.2);
    const rawD = Math.max(0.3, item.depth || 0.8);
    const h = Math.max(0.3, item.height || 0.75);
    const type = (item.type || 'furniture_generic').toLowerCase();

    // Determine canonical width (along X) and depth (along Z)
    let w = rawW;
    let d = rawD;
    let autoRotateY = 0;

    // For directional linear furniture, if CAD box is drawn taller in Z than X and no explicit rotation is set,
    // orient canonical width along the longer dimension and rotate 90 degrees.
    const directionalTypes = new Set([
      'sofa_sectional', 'sofa', 'tv_console', 'kitchen_cabinet',
      'wardrobe', 'desk', 'altar_table', 'vanity'
    ]);
    if (directionalTypes.has(type) && rawD > rawW * 1.25 && item.rotation === undefined) {
      w = rawD;
      d = rawW;
      autoRotateY = Math.PI / 2;
    }

    switch (type) {
      case 'sofa_sectional':
      case 'sofa':
        this._buildSofaSectional(inner, w, d, h, mats);
        break;
      case 'coffee_table':
        this._buildCoffeeTable(inner, w, d, h, mats);
        break;
      case 'tv_console':
        this._buildTvConsole(inner, w, d, h, mats);
        break;
      case 'kitchen_cabinet':
        this._buildKitchenCabinet(inner, w, d, h, mats);
        break;
      case 'dining_table':
        this._buildDiningTable(inner, w, d, h, mats);
        break;
      case 'chair_or_nightstand':
      case 'nightstand':
      case 'chair':
        this._buildChairOrNightstand(inner, w, d, h, item, mats);
        break;
      case 'bed_master':
      case 'bed':
        this._buildBedMaster(inner, w, d, h, mats);
        break;
      case 'wardrobe':
        this._buildWardrobe(inner, w, d, h, mats);
        break;
      case 'desk':
        this._buildStudyDesk(inner, w, d, h, mats);
        break;
      case 'altar_table':
        this._buildAltarTable(inner, w, d, h, mats);
        break;
      case 'gym_machine':
        this._buildGymMachine(inner, w, d, h, mats);
        break;
      case 'plants':
      case 'planter':
        this._buildBotanicalPlanter(inner, w, d, h, mats);
        break;
      case 'bbq':
        this._buildRooftopBbq(inner, w, d, h, mats);
        break;
      case 'toilet':
        this._buildToilet(inner, w, d, h, mats);
        break;
      case 'vanity':
        this._buildBathroomVanity(inner, w, d, h, mats);
        break;
      case 'bathtub':
      case 'shower':
        this._buildBathtub(inner, w, d, h, type === 'shower', mats);
        break;
      default:
        this._buildDesignerCredenza(inner, w, d, h, mats);
        break;
    }

    if (item.rotation !== undefined && item.rotation !== null) {
      const rot = Math.abs(item.rotation) > Math.PI * 2
        ? (item.rotation * Math.PI) / 180
        : item.rotation;
      inner.rotation.y = rot;
    } else if (autoRotateY !== 0) {
      inner.rotation.y = autoRotateY;
    }

    return this._finalizeGroup(root, 'furniture');
  }

  // =========================================================================
  // 1. LIVING ROOM: SOFA SECTIONAL, COFFEE TABLE, TV CONSOLE
  // =========================================================================

  static _buildSofaSectional(g, w, d, h, mats) {
    // 1. Woven Area Rug underneath (y = 0.004m, polygonOffsetFactor: -1)
    const rugW = w * 1.16;
    const rugD = Math.max(d * 1.55, 1.4);
    const rugGeo = new THREE.PlaneGeometry(rugW, rugD);
    const rug = new THREE.Mesh(rugGeo, mats.rugWoven);
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.004, rugD * 0.14);
    this._markDetail(rug);
    g.add(rug);

    // 2. Tapered wooden + brass legs
    const legH = 0.11;
    const legGeo = new THREE.CylinderGeometry(0.024, 0.015, legH, 8, 1);
    legGeo.computeVertexNormals();
    const footGeo = new THREE.CylinderGeometry(0.016, 0.014, 0.03, 8, 1);
    footGeo.computeVertexNormals();
    const legX = w / 2 - 0.08;
    const legZ = d / 2 - 0.08;
    for (const [lx, lz] of [[-legX, -legZ], [legX, -legZ], [-legX, legZ], [legX, legZ], [0, -legZ], [0, legZ]]) {
      const leg = new THREE.Mesh(legGeo, mats.woodWalnut);
      leg.position.set(lx, legH / 2, lz);
      const foot = new THREE.Mesh(footGeo, mats.metalBrass);
      foot.position.set(lx, 0.015, lz);
      this._markDetail(leg, foot);
      g.add(leg, foot);
    }

    // 3. Solid Walnut Base Platform (Primary Large Body)
    const baseH = 0.07;
    const baseGeo = this.createRoundedBoxGeometry(w - 0.02, baseH, d - 0.02, 0.015, 1);
    const base = new THREE.Mesh(baseGeo, mats.woodWalnut);
    base.position.set(0, legH + baseH / 2, 0);
    this._markPrimary(base);
    g.add(base);

    // 4. Padded Armrests (Left & Right)
    const armW = Math.min(0.22, w * 0.1);
    const armH = Math.min(0.46, h * 0.58);
    const armGeo = this.createRoundedBoxGeometry(armW, armH, d - 0.02, 0.035, 1);
    const armL = new THREE.Mesh(armGeo, mats.fabricVelvet);
    armL.position.set(-w / 2 + armW / 2, legH + baseH + armH / 2 - 0.02, 0);
    const armR = armL.clone();
    armR.position.x = w / 2 - armW / 2;
    this._markDetail(armL, armR);
    g.add(armL, armR);

    // 5. Upholstered Outer Back Frame (Primary Large Body)
    const backFrameD = 0.14;
    const backFrameH = h - legH - baseH;
    const backFrameGeo = this.createRoundedBoxGeometry(w, backFrameH, backFrameD, 0.03, 1);
    const backFrame = new THREE.Mesh(backFrameGeo, mats.fabricVelvet);
    backFrame.position.set(0, legH + baseH + backFrameH / 2, -d / 2 + backFrameD / 2);
    this._markPrimary(backFrame);
    g.add(backFrame);

    // 6. Individual Beveled Seat Cushions (3 cushions + optional L-chaise on right)
    const innerW = w - armW * 2;
    const numCushions = w >= 1.8 ? 3 : 2;
    const cushW = innerW / numCushions - 0.012;
    const cushH = 0.18;
    const cushD = d - backFrameD - 0.02;
    const seatY = legH + baseH + cushH / 2;

    for (let i = 0; i < numCushions; i++) {
      const cx = -innerW / 2 + (i + 0.5) * (innerW / numCushions);
      const isChaise = (i === numCushions - 1 && w >= 2.0);
      const thisD = isChaise ? cushD + Math.min(0.48, d * 0.45) : cushD;
      const thisZ = isChaise ? (backFrameD / 2) + (thisD - cushD) / 2 : backFrameD / 2;

      const cGeo = this.createRoundedBoxGeometry(cushW, cushH, thisD, 0.035, 1);
      const cMesh = new THREE.Mesh(cGeo, mats.fabricLinen);
      cMesh.position.set(cx, seatY, thisZ);
      this._markDetail(cMesh);
      g.add(cMesh);

      if (isChaise) {
        // Under-chaise walnut frame & brass front legs
        const chBaseGeo = this.createRoundedBoxGeometry(cushW, baseH, thisD - cushD, 0.015, 1);
        const chBase = new THREE.Mesh(chBaseGeo, mats.woodWalnut);
        chBase.position.set(cx, legH + baseH / 2, d / 2 + (thisD - cushD) / 2 - 0.02);
        this._markDetail(chBase);
        g.add(chBase);
      }

      // Angled plush backrest cushion
      const backCushH = Math.max(0.34, h - (legH + baseH + cushH) + 0.04);
      const backCushGeo = this.createRoundedBoxGeometry(cushW - 0.01, backCushH, 0.16, 0.035, 1);
      const backCush = new THREE.Mesh(backCushGeo, mats.fabricLinen);
      backCush.position.set(cx, seatY + cushH / 2 + backCushH * 0.42, -d / 2 + backFrameD + 0.06);
      backCush.rotation.x = -0.16;
      this._markDetail(backCush);
      g.add(backCush);
    }

    // 7. Decorative Throw Pillows in Warm Accent Tones
    const pillowGeo = this.createRoundedBoxGeometry(0.32, 0.30, 0.11, 0.035, 1);
    const pillowConfigs = [
      { x: -innerW / 2 + 0.18, z: -d / 2 + backFrameD + 0.16, ry: 0.35, rz: -0.15, mat: mats.pillowAccentTerra },
      { x: -innerW / 2 + 0.34, z: -d / 2 + backFrameD + 0.20, ry: 0.18, rz: -0.08, mat: mats.pillowAccentMustard },
      { x: innerW / 2 - 0.20, z: -d / 2 + backFrameD + 0.16, ry: -0.32, rz: 0.14, mat: mats.pillowAccentSage }
    ];
    for (const pc of pillowConfigs) {
      const pil = new THREE.Mesh(pillowGeo, pc.mat);
      pil.position.set(pc.x, seatY + cushH / 2 + 0.13, pc.z);
      pil.rotation.set(-0.15, pc.ry, pc.rz);
      this._markDetail(pil);
      g.add(pil);
    }
  }

  static _buildCoffeeTable(g, w, d, h, mats) {
    const tableH = Math.min(Math.max(h, 0.38), 0.48);
    const topThick = 0.035;

    // 1. Beveled Rounded Carrara Marble Tabletop (Primary Large Body)
    const topGeo = this.createRoundedBoxGeometry(w, topThick, d, Math.min(w, d) * 0.18, 1);
    const top = new THREE.Mesh(topGeo, mats.marbleCarrara);
    top.position.y = tableH - topThick / 2;
    this._markPrimary(top);
    g.add(top);

    // Brass rim trim under marble
    const rimGeo = this.createRoundedBoxGeometry(w - 0.03, 0.015, d - 0.03, Math.min(w, d) * 0.17, 1);
    const rim = new THREE.Mesh(rimGeo, mats.metalBrass);
    rim.position.y = tableH - topThick - 0.007;
    this._markDetail(rim);
    g.add(rim);

    // 2. Sculptural Crossed Walnut & Brass Frame Legs
    const legH = tableH - topThick - 0.01;
    const legGeo = new THREE.CylinderGeometry(0.022, 0.016, legH, 8, 1);
    legGeo.computeVertexNormals();
    const ox = w * 0.34;
    const oz = d * 0.32;
    for (const [lx, lz] of [[-ox, -oz], [ox, -oz], [-ox, oz], [ox, oz]]) {
      const leg = new THREE.Mesh(legGeo, mats.woodWalnut);
      leg.position.set(lx, legH / 2, lz);
      this._markDetail(leg);
      g.add(leg);
    }
    // Lower walnut stretcher shelf
    const shelfGeo = this.createRoundedBoxGeometry(w * 0.72, 0.02, d * 0.68, 0.06, 1);
    const shelf = new THREE.Mesh(shelfGeo, mats.woodWalnut);
    shelf.position.y = tableH * 0.32;
    this._markDetail(shelf);
    g.add(shelf);

    // 3. Decorative Tray + Ceramic Vase & Botanical Stems + Art Book
    const trayGeo = this.createRoundedBoxGeometry(w * 0.36, 0.02, d * 0.42, 0.02, 1);
    const tray = new THREE.Mesh(trayGeo, mats.woodWalnut);
    tray.position.set(-w * 0.14, tableH + 0.01, 0);
    this._markDetail(tray);
    g.add(tray);

    // Ceramic Vase
    const vaseGeo = new THREE.CylinderGeometry(0.04, 0.055, 0.16, 8, 1);
    vaseGeo.computeVertexNormals();
    const vaseBody = new THREE.Mesh(vaseGeo, mats.ceramicVase);
    vaseBody.position.set(-w * 0.16, tableH + 0.10, -0.02);
    this._markDetail(vaseBody);
    g.add(vaseBody);

    // Botanical leaves in vase
    const leafGeo = new THREE.SphereGeometry(0.055, 6, 6);
    leafGeo.scale(1.2, 0.5, 0.8);
    leafGeo.computeVertexNormals();
    for (let i = 0; i < 3; i++) {
      const leaf = new THREE.Mesh(leafGeo, i % 2 === 0 ? mats.treeFoliage : mats.plantFoliageLight);
      leaf.position.set(-w * 0.16 + (i - 1) * 0.04, tableH + 0.21 + i * 0.02, -0.02 + (i - 1) * 0.02);
      leaf.rotation.z = (i - 1) * 0.4;
      this._markDetail(leaf);
      g.add(leaf);
    }

    // Hardcover Architecture Art Book
    const bookGeo = this.createRoundedBoxGeometry(0.24, 0.032, 0.18, 0.006, 1);
    const book = new THREE.Mesh(bookGeo, mats.pillowAccentTerra);
    book.position.set(w * 0.18, tableH + 0.016, 0.02);
    book.rotation.y = 0.18;
    this._markDetail(book);
    g.add(book);
  }

  static _buildTvConsole(g, w, d, h, mats) {
    const consoleH = Math.min(Math.max(h, 0.42), 0.54);
    const legH = 0.12;
    const bodyH = consoleH - legH;

    // 1. Tapered Brass Legs
    const legGeo = new THREE.CylinderGeometry(0.02, 0.012, legH, 8, 1);
    legGeo.computeVertexNormals();
    for (const lx of [-w * 0.44, 0, w * 0.44]) {
      for (const lz of [-d * 0.36, d * 0.36]) {
        const leg = new THREE.Mesh(legGeo, mats.metalBrass);
        leg.position.set(lx, legH / 2, lz);
        this._markDetail(leg);
        g.add(leg);
      }
    }

    // 2. Walnut Media Credenza Carcass & Marble Top Inset (Primary Large Body)
    const bodyGeo = this.createRoundedBoxGeometry(w, bodyH, d, 0.018, 1);
    const body = new THREE.Mesh(bodyGeo, mats.woodWalnut);
    body.position.set(0, legH + bodyH / 2, 0);
    this._markPrimary(body);
    g.add(body);

    const topGeo = this.createRoundedBoxGeometry(w - 0.02, 0.02, d - 0.02, 0.01, 1);
    const top = new THREE.Mesh(topGeo, mats.marbleCarrara);
    top.position.set(0, consoleH + 0.01, 0);
    this._markDetail(top);
    g.add(top);

    // Slatted front doors + brass handles
    const numSlats = Math.max(12, Math.floor(w * 10));
    const slatGeo = new THREE.BoxGeometry(0.018, bodyH - 0.05, 0.012);
    for (let i = 0; i < numSlats; i++) {
      const sx = -w / 2 + 0.06 + (i / (numSlats - 1)) * (w - 0.12);
      const slat = new THREE.Mesh(slatGeo, mats.woodOak);
      slat.position.set(sx, legH + bodyH / 2, d / 2 + 0.006);
      this._markDetail(slat);
      g.add(slat);
    }

    // 3. Wall-mounted Slatted Wood Acoustic Backdrop Panel behind TV
    const panelH = 1.65;
    const panelW = w * 0.96;
    const backBoard = new THREE.Mesh(new THREE.BoxGeometry(panelW, panelH, 0.02), mats.woodWalnut);
    backBoard.position.set(0, consoleH + panelH / 2, -d / 2 + 0.01);
    this._markDetail(backBoard);
    g.add(backBoard);

    const wallSlats = Math.floor(panelW / 0.07);
    const wSlatGeo = new THREE.BoxGeometry(0.032, panelH, 0.022);
    for (let i = 0; i < wallSlats; i++) {
      const sx = -panelW / 2 + 0.035 + i * 0.07;
      const ws = new THREE.Mesh(wSlatGeo, mats.woodOak);
      ws.position.set(sx, consoleH + panelH / 2, -d / 2 + 0.025);
      this._markDetail(ws);
      g.add(ws);
    }

    // Warm vertical LED accent strip along backdrop edge
    const ledStrip = new THREE.Mesh(new THREE.BoxGeometry(0.02, panelH - 0.1, 0.025), mats.emissiveWarm);
    ledStrip.position.set(panelW / 2 - 0.02, consoleH + panelH / 2, -d / 2 + 0.025);
    this._markDetail(ledStrip);
    g.add(ledStrip);

    // 4. Ultra-Thin Glossy Black OLED TV Screen (65"-75" proportion)
    const tvW = Math.min(w * 0.68, 1.65);
    const tvH = tvW * 0.56;
    const tvY = consoleH + 0.22 + tvH / 2;
    const tvBezel = new THREE.Mesh(new THREE.BoxGeometry(tvW + 0.02, tvH + 0.02, 0.022), mats.metalBlack);
    tvBezel.position.set(0, tvY, -d / 2 + 0.08);
    const tvPanel = new THREE.Mesh(new THREE.BoxGeometry(tvW, tvH, 0.008), mats.tvScreen);
    tvPanel.position.set(0, tvY, -d / 2 + 0.095);
    this._markDetail(tvBezel, tvPanel);
    g.add(tvBezel, tvPanel);

    // 5. Matte Black Soundbar on Console
    const sbGeo = this.createRoundedBoxGeometry(tvW * 0.58, 0.055, 0.09, 0.015, 1);
    const soundbar = new THREE.Mesh(sbGeo, mats.metalBlack);
    soundbar.position.set(0, consoleH + 0.045, 0.04);
    this._markDetail(soundbar);
    g.add(soundbar);

    // 6. Indoor Ceramic Planter on one side of Credenza
    const potGeo = new THREE.CylinderGeometry(0.11, 0.085, 0.22, 8, 1);
    potGeo.computeVertexNormals();
    const pot = new THREE.Mesh(potGeo, mats.ceramicVase);
    pot.position.set(-w * 0.38, consoleH + 0.12, 0.04);
    const folGeo = new THREE.DodecahedronGeometry(0.16, 0);
    folGeo.computeVertexNormals();
    const foliage = new THREE.Mesh(folGeo, mats.treeFoliage);
    foliage.position.set(-w * 0.38, consoleH + 0.32, 0.04);
    this._markDetail(pot, foliage);
    g.add(pot, foliage);
  }

  // =========================================================================
  // 2. KITCHEN & DINING: KITCHEN CABINET, DINING TABLE, CHAIR / NIGHTSTAND
  // =========================================================================

  static _buildKitchenCabinet(g, w, d, h, mats) {
    const counterH = Math.min(Math.max(h, 0.85), 0.92);
    const hasFridge = w >= 2.1;
    const fridgeW = hasFridge ? 0.78 : 0;
    const cabW = w - fridgeW;
    const cabOffsetX = hasFridge ? -fridgeW / 2 : 0;

    // 1. Tall 2-Door Brushed Steel Refrigerator on right end (when width >= 2.1m)
    if (hasFridge) {
      const fridgeH = 2.08;
      const fx = w / 2 - fridgeW / 2;
      const fridgeBody = new THREE.Mesh(
        this.createRoundedBoxGeometry(fridgeW - 0.02, fridgeH, d + 0.04, 0.02, 1),
        mats.stainlessSteel
      );
      fridgeBody.position.set(fx, fridgeH / 2, 0.02);
      this._markPrimary(fridgeBody);
      g.add(fridgeBody);

      // Vertical French door split seam & brushed chrome handles
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.01, fridgeH * 0.92, 0.015), mats.metalBlack);
      seam.position.set(fx, fridgeH * 0.52, d / 2 + 0.042);
      const handleGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.65, 8, 1);
      handleGeo.computeVertexNormals();
      const hL = new THREE.Mesh(handleGeo, mats.metalChrome);
      hL.position.set(fx - 0.045, fridgeH * 0.58, d / 2 + 0.06);
      const hR = hL.clone();
      hR.position.x = fx + 0.045;
      this._markDetail(seam, hL, hR);
      g.add(seam, hL, hR);
    }

    // 2. Lower Cabinetry with Recessed Toe-Kick & Door Panel Reveals
    const toeH = 0.09;
    const lowerH = counterH - toeH - 0.035;
    const toeKick = new THREE.Mesh(new THREE.BoxGeometry(cabW - 0.02, toeH, d - 0.08), mats.metalBlack);
    toeKick.position.set(cabOffsetX, toeH / 2, -0.02);
    this._markDetail(toeKick);
    g.add(toeKick);

    const lowerBody = new THREE.Mesh(
      this.createRoundedBoxGeometry(cabW, lowerH, d - 0.02, 0.012, 1),
      mats.kitchenCabinet
    );
    lowerBody.position.set(cabOffsetX, toeH + lowerH / 2, 0);
    this._markPrimary(lowerBody);
    g.add(lowerBody);

    // Door panels & brushed brass bar handles
    const numDoors = Math.max(3, Math.floor(cabW / 0.55));
    const doorW = (cabW - 0.04) / numDoors;
    for (let i = 0; i < numDoors; i++) {
      const dx = cabOffsetX - cabW / 2 + 0.02 + (i + 0.5) * doorW;
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(doorW - 0.018, lowerH - 0.04, 0.015),
        mats.kitchenCabinet
      );
      panel.position.set(dx, toeH + lowerH / 2, d / 2 - 0.005);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(doorW * 0.45, 0.014, 0.024), mats.metalBrass);
      handle.position.set(dx, counterH - 0.11, d / 2 + 0.012);
      this._markDetail(panel, handle);
      g.add(panel, handle);
    }

    // 3. Carrara Marble Countertop (+0.035m overhang) + Backsplash
    const topGeo = this.createRoundedBoxGeometry(cabW + 0.03, 0.035, d + 0.03, 0.01, 1);
    const countertop = new THREE.Mesh(topGeo, mats.marbleCarrara);
    countertop.position.set(cabOffsetX, counterH - 0.017, 0.01);
    this._markPrimary(countertop);
    g.add(countertop);

    const splashH = 0.58;
    const splash = new THREE.Mesh(new THREE.BoxGeometry(cabW, splashH, 0.02), mats.marbleCarrara);
    splash.position.set(cabOffsetX, counterH + splashH / 2, -d / 2 + 0.015);
    this._markDetail(splash);
    g.add(splash);

    // 4. Recessed Stainless Steel Sink Basin + Curved Chrome Gooseneck Faucet
    const sinkX = cabOffsetX - cabW * 0.24;
    const sinkRim = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.012, 0.42), mats.stainlessSteel);
    sinkRim.position.set(sinkX, counterH + 0.004, 0.02);
    const sinkWell = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.014, 0.36), mats.metalBlack);
    sinkWell.position.set(sinkX, counterH + 0.006, 0.02);
    this._markDetail(sinkRim, sinkWell);
    g.add(sinkRim, sinkWell);

    // Gooseneck Faucet
    const faucetStemGeo = new THREE.CylinderGeometry(0.014, 0.018, 0.22, 8, 1);
    faucetStemGeo.computeVertexNormals();
    const faucetStem = new THREE.Mesh(faucetStemGeo, mats.metalChrome);
    faucetStem.position.set(sinkX, counterH + 0.11, -0.18);
    const faucetArcGeo = new THREE.TorusGeometry(0.085, 0.012, 6, 6, Math.PI);
    faucetArcGeo.computeVertexNormals();
    const faucetArc = new THREE.Mesh(faucetArcGeo, mats.metalChrome);
    faucetArc.position.set(sinkX, counterH + 0.21, -0.095);
    faucetArc.rotation.y = Math.PI / 2;
    this._markDetail(faucetStem, faucetArc);
    g.add(faucetStem, faucetArc);

    // 5. Glossy Black Induction Cooktop with Burner Rings
    const cookX = cabOffsetX + cabW * 0.24;
    const cooktop = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.012, 0.44), mats.cooktopGlass);
    cooktop.position.set(cookX, counterH + 0.005, 0.02);
    this._markDetail(cooktop);
    g.add(cooktop);

    const ringGeo = new THREE.RingGeometry(0.055, 0.072, 12);
    ringGeo.rotateX(-Math.PI / 2);
    for (const [rx, rz] of [[-0.14, -0.09], [0.14, -0.09], [-0.14, 0.11], [0.14, 0.11]]) {
      const ring = new THREE.Mesh(ringGeo, mats.emissiveWarm);
      ring.position.set(cookX + rx, counterH + 0.013, 0.02 + rz);
      this._markDetail(ring);
      g.add(ring);
    }

    // 6. Upper Wall Cabinets + Warm Under-Cabinet LED Strip + Range Hood
    const upperH = 0.65;
    const upperD = d * 0.58;
    const upperY = counterH + splashH + upperH / 2;
    const upperCab = new THREE.Mesh(
      this.createRoundedBoxGeometry(cabW, upperH, upperD, 0.012, 1),
      mats.woodOak
    );
    upperCab.position.set(cabOffsetX, upperY, -d / 2 + upperD / 2);
    this._markPrimary(upperCab);
    g.add(upperCab);

    // Warm under-cabinet LED strip
    const ledStrip = new THREE.Mesh(
      new THREE.BoxGeometry(cabW - 0.08, 0.015, 0.03),
      mats.emissiveWarm
    );
    ledStrip.position.set(cabOffsetX, counterH + splashH - 0.008, -d / 2 + upperD * 0.7);
    this._markDetail(ledStrip);
    g.add(ledStrip);
  }

  static _buildDiningTable(g, w, d, h, mats) {
    const tableH = Math.min(Math.max(h, 0.73), 0.78);
    const tableW = w * 0.78;
    const tableD = d * 0.64;

    // 1. Beveled Solid Oak & Carrara Marble Dining Tabletop (Primary Large Body)
    const oakSubTop = new THREE.Mesh(
      this.createRoundedBoxGeometry(tableW, 0.035, tableD, 0.04, 1),
      mats.woodOak
    );
    oakSubTop.position.y = tableH - 0.025;
    const marbleInlay = new THREE.Mesh(
      this.createRoundedBoxGeometry(tableW - 0.08, 0.018, tableD - 0.08, 0.03, 1),
      mats.marbleCarrara
    );
    marbleInlay.position.y = tableH - 0.005;
    this._markPrimary(oakSubTop, marbleInlay);
    g.add(oakSubTop, marbleInlay);

    // 2. 4 Tapered Angled Designer Legs with Brass Ferrules
    const legH = tableH - 0.03;
    const legGeo = new THREE.CylinderGeometry(0.032, 0.02, legH, 8, 1);
    legGeo.computeVertexNormals();
    const lx = tableW / 2 - 0.14;
    const lz = tableD / 2 - 0.12;
    for (const [ox, oz] of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]]) {
      const leg = new THREE.Mesh(legGeo, mats.woodWalnut);
      leg.position.set(ox, legH / 2, oz);
      leg.rotation.z = ox > 0 ? -0.06 : 0.06;
      this._markDetail(leg);
      g.add(leg);
    }

    // 3. Centerpiece Ceramic Bowl & Vase on Table
    const bowlGeo = new THREE.CylinderGeometry(0.16, 0.09, 0.07, 8, 1);
    bowlGeo.computeVertexNormals();
    const bowl = new THREE.Mesh(bowlGeo, mats.ceramicVase);
    bowl.position.set(-0.08, tableH + 0.035, 0);

    const vaseGeo = new THREE.CylinderGeometry(0.045, 0.06, 0.19, 8, 1);
    vaseGeo.computeVertexNormals();
    const vase = new THREE.Mesh(vaseGeo, mats.metalBrass);
    vase.position.set(0.12, tableH + 0.095, 0.02);

    const bouquetGeo = new THREE.SphereGeometry(0.085, 8, 6);
    bouquetGeo.computeVertexNormals();
    const bouquet = new THREE.Mesh(bouquetGeo, mats.plantFoliageLight);
    bouquet.position.set(0.12, tableH + 0.23, 0.02);
    this._markDetail(bowl, vase, bouquet);
    g.add(bowl, vase, bouquet);

    // 4. 4 to 6 Ergonomic Upholstered Dining Chairs Tucked Around Both Sides
    const numPerSide = tableW >= 1.45 ? 3 : 2;
    const spacing = tableW / (numPerSide + 0.35);
    for (let i = 0; i < numPerSide; i++) {
      const cx = ((i - (numPerSide - 1) / 2)) * spacing;
      // Front row chair (facing -Z)
      const cFront = this._createDiningChairMesh(mats);
      cFront.position.set(cx, 0, tableD / 2 + 0.14);
      cFront.rotation.y = Math.PI;
      g.add(cFront);

      // Back row chair (facing +Z)
      const cBack = this._createDiningChairMesh(mats);
      cBack.position.set(cx, 0, -tableD / 2 - 0.14);
      g.add(cBack);
    }
  }

  static _createDiningChairMesh(mats) {
    const cg = new THREE.Group();
    const seatH = 0.45;
    const seatW = 0.44;
    const seatD = 0.43;

    // 4 Tapered legs
    const legGeo = new THREE.CylinderGeometry(0.016, 0.011, seatH, 8, 1);
    legGeo.computeVertexNormals();
    for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
      const leg = new THREE.Mesh(legGeo, mats.woodWalnut);
      leg.position.set(lx, seatH / 2, lz);
      this._markDetail(leg);
      cg.add(leg);
    }

    // Beveled upholstered seat pad (Primary body of chair)
    const seatGeo = this.createRoundedBoxGeometry(seatW, 0.055, seatD, 0.02, 1);
    const seat = new THREE.Mesh(seatGeo, mats.fabricLinen);
    seat.position.y = seatH;
    this._markPrimary(seat);
    cg.add(seat);

    // Curved ergonomic backrest
    const backGeo = this.createRoundedBoxGeometry(seatW, 0.36, 0.05, 0.02, 1);
    const back = new THREE.Mesh(backGeo, mats.fabricVelvet);
    back.position.set(0, seatH + 0.21, -seatD / 2 + 0.03);
    back.rotation.x = -0.12;
    this._markDetail(back);
    cg.add(back);

    return cg;
  }

  static _buildChairOrNightstand(g, w, d, h, item, mats) {
    const nameStr = (item.name || '').toLowerCase();
    if (nameStr.includes('ghế') || nameStr.includes('chair')) {
      const chair = this._createDiningChairMesh(mats);
      g.add(chair);
      return;
    }

    // Bedside Nightstand with Warm Glowing Lamp
    const nsH = Math.min(Math.max(h, 0.46), 0.56);
    const legH = 0.12;
    const boxH = nsH - legH;

    const legGeo = new THREE.CylinderGeometry(0.015, 0.01, legH, 8, 1);
    legGeo.computeVertexNormals();
    for (const [lx, lz] of [[-w * 0.38, -d * 0.38], [w * 0.38, -d * 0.38], [-w * 0.38, d * 0.38], [w * 0.38, d * 0.38]]) {
      const leg = new THREE.Mesh(legGeo, mats.metalBrass);
      leg.position.set(lx, legH / 2, lz);
      this._markDetail(leg);
      g.add(leg);
    }

    // Body (Primary)
    const body = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, boxH, d, 0.015, 1),
      mats.woodWalnut
    );
    body.position.y = legH + boxH / 2;
    this._markPrimary(body);

    const topPad = new THREE.Mesh(
      this.createRoundedBoxGeometry(w - 0.02, 0.018, d - 0.02, 0.01, 1),
      mats.marbleCarrara
    );
    topPad.position.y = nsH + 0.008;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, 0.014, 0.02), mats.metalBrass);
    handle.position.set(0, legH + boxH * 0.6, d / 2 + 0.01);
    this._markDetail(topPad, handle);
    g.add(body, topPad, handle);

    // Warm Bedside Table Lamp
    const lampBaseGeo = new THREE.CylinderGeometry(0.055, 0.07, 0.10, 8, 1);
    lampBaseGeo.computeVertexNormals();
    const lampBase = new THREE.Mesh(lampBaseGeo, mats.metalBrass);
    lampBase.position.y = nsH + 0.06;

    const lampShadeGeo = new THREE.CylinderGeometry(0.08, 0.11, 0.16, 8, 1);
    lampShadeGeo.computeVertexNormals();
    const lampShade = new THREE.Mesh(lampShadeGeo, mats.emissiveWarm);
    lampShade.position.y = nsH + 0.21;
    this._markDetail(lampBase, lampShade);
    g.add(lampBase, lampShade);
  }

  // =========================================================================
  // 3. BEDROOMS: MASTER BED, WARDROBE, STUDY DESK
  // =========================================================================

  static _buildBedMaster(g, w, d, h, mats) {
    // 1. Woven Bedroom Area Rug underneath
    const rugGeo = new THREE.PlaneGeometry(w * 1.28, d * 1.15);
    const rug = new THREE.Mesh(rugGeo, mats.rugWoven);
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.004, d * 0.06);
    rug.userData.castShadow = false;
    g.add(rug);

    // 2. Solid Walnut Platform Frame + Warm Under-Bed Perimeter LED Strip
    const plinthH = 0.08;
    const frameH = 0.18;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(w - 0.16, plinthH, d - 0.18), mats.metalBlack);
    plinth.position.set(0, plinthH / 2, 0.04);
    const ledUnder = new THREE.Mesh(new THREE.BoxGeometry(w - 0.12, 0.015, d - 0.14), mats.emissiveWarm);
    ledUnder.position.set(0, plinthH - 0.01, 0.04);
    const frame = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, frameH, d - 0.08, 0.025, 1),
      mats.woodWalnut
    );
    frame.position.set(0, plinthH + frameH / 2, 0.04);
    this._markPrimary(frame);
    this._markDetail(plinth, ledUnder);
    g.add(plinth, ledUnder, frame);

    // 3. Tall Padded & Channeled Upholstered Headboard framed in Walnut
    const hbH = Math.max(1.12, h * 1.75);
    const hbD = 0.13;
    const hbBacking = new THREE.Mesh(
      this.createRoundedBoxGeometry(w + 0.16, hbH, hbD, 0.02, 1),
      mats.woodWalnut
    );
    hbBacking.position.set(0, hbH / 2, -d / 2 + hbD / 2);
    this._markPrimary(hbBacking);
    g.add(hbBacking);

    const numChannels = 6;
    const chanW = (w + 0.04) / numChannels;
    const chanGeo = this.createRoundedBoxGeometry(chanW - 0.012, hbH - 0.12, 0.065, 0.022, 1);
    for (let i = 0; i < numChannels; i++) {
      const cx = -(w + 0.04) / 2 + (i + 0.5) * chanW;
      const chan = new THREE.Mesh(chanGeo, mats.fabricVelvet);
      chan.position.set(cx, hbH / 2 + 0.02, -d / 2 + hbD + 0.02);
      this._markDetail(chan);
      g.add(chan);
    }

    // 4. Thick White Orthopedic Mattress with Rounded Edges
    const matW = w - 0.08;
    const matD = d - hbD - 0.06;
    const matH = 0.26;
    const matY = plinthH + frameH + matH / 2 - 0.03;
    const mattress = new THREE.Mesh(
      this.createRoundedBoxGeometry(matW, matH, matD, 0.045, 1),
      mats.beddingFabric
    );
    mattress.position.set(0, matY, hbD / 2);
    this._markDetail(mattress);
    g.add(mattress);

    // 5. Folded Quilted Duvet Covering 2/3 of the Bed + Foot Throw Runner
    const duvetD = matD * 0.66;
    const duvetH = matH + 0.04;
    const duvet = new THREE.Mesh(
      this.createRoundedBoxGeometry(matW + 0.04, duvetH, duvetD, 0.05, 1),
      mats.beddingDuvet
    );
    duvet.position.set(0, matY + 0.015, hbD / 2 + (matD - duvetD) / 2 + 0.01);
    this._markDetail(duvet);
    g.add(duvet);

    // Terracotta accent throw runner at the foot of the bed
    const runner = new THREE.Mesh(
      this.createRoundedBoxGeometry(matW + 0.06, duvetH + 0.015, matD * 0.22, 0.03, 1),
      mats.pillowAccentTerra
    );
    runner.position.set(0, matY + 0.02, d / 2 - matD * 0.13);
    this._markDetail(runner);
    g.add(runner);

    // 6. 4 Plump Beveled Pillows propped against Headboard
    const pilW = matW * 0.42;
    const pilGeo = this.createRoundedBoxGeometry(pilW, 0.14, 0.34, 0.04, 1);
    const topSurfaceY = matY + matH / 2;
    for (const side of [-1, 1]) {
      const px = side * (matW * 0.24);
      // Rear Euro pillow
      const pBack = new THREE.Mesh(pilGeo, mats.beddingFabric);
      pBack.position.set(px, topSurfaceY + 0.10, -d / 2 + hbD + 0.20);
      pBack.rotation.x = 0.35;
      // Front accent pillow
      const pFront = new THREE.Mesh(pilGeo, mats.pillowAccentSage);
      pFront.scale.set(0.85, 0.9, 0.85);
      pFront.position.set(px, topSurfaceY + 0.08, -d / 2 + hbD + 0.38);
      pFront.rotation.x = 0.22;
      this._markDetail(pBack, pFront);
      g.add(pBack, pFront);
    }

    // 7. 2 Matching Bedside Nightstand Shelves & Warm Glowing Bedside Lamps on Either Side
    const nsW = 0.34;
    const nsD = 0.32;
    const nsH = 0.16;
    const nsY = plinthH + frameH + 0.04;
    for (const side of [-1, 1]) {
      const nx = side * (w / 2 + nsW / 2 - 0.02);
      const nz = -d / 2 + hbD + nsD / 2 + 0.02;

      const nsBox = new THREE.Mesh(
        this.createRoundedBoxGeometry(nsW, nsH, nsD, 0.015, 1),
        mats.woodWalnut
      );
      nsBox.position.set(nx, nsY, nz);

      const nsTop = new THREE.Mesh(
        this.createRoundedBoxGeometry(nsW - 0.02, 0.016, nsD - 0.02, 0.008, 1),
        mats.marbleCarrara
      );
      nsTop.position.set(nx, nsY + nsH / 2 + 0.008, nz);

      const lampStemGeo = new THREE.CylinderGeometry(0.035, 0.05, 0.09, 8, 1);
      lampStemGeo.computeVertexNormals();
      const lampStem = new THREE.Mesh(lampStemGeo, mats.metalBrass);
      lampStem.position.set(nx, nsY + nsH / 2 + 0.055, nz);

      const lampShadeGeo = new THREE.CylinderGeometry(0.065, 0.09, 0.14, 8, 1);
      lampShadeGeo.computeVertexNormals();
      const lampShade = new THREE.Mesh(lampShadeGeo, mats.emissiveWarm);
      lampShade.position.set(nx, nsY + nsH / 2 + 0.16, nz);

      this._markDetail(nsBox, nsTop, lampStem, lampShade);
      g.add(nsBox, nsTop, lampStem, lampShade);
    }
  }

  static _buildWardrobe(g, w, d, h, mats) {
    const wardH = Math.max(h, 2.25);

    // 1. Walnut Outer Carcass (Primary Large Body)
    const carcass = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, wardH, d, 0.015, 1),
      mats.woodWalnut
    );
    carcass.position.y = wardH / 2;
    this._markPrimary(carcass);
    g.add(carcass);

    // Warm interior LED glow strip visible behind fluted glass doors
    const innerGlow = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.88, 0.03, d * 0.5),
      mats.emissiveWarm
    );
    innerGlow.position.set(0, wardH - 0.12, 0);
    this._markDetail(innerGlow);
    g.add(innerGlow);

    // 2. Framed Fluted-Glass & Oak Doors + Long Vertical Matte-Black Handles
    const numDoors = Math.max(2, Math.min(4, Math.round(w / 0.55)));
    const doorW = (w - 0.04) / numDoors;
    const doorH = wardH - 0.12;

    for (let i = 0; i < numDoors; i++) {
      const dx = -w / 2 + 0.02 + (i + 0.5) * doorW;
      // Frame border
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(doorW - 0.012, doorH, 0.022),
        mats.metalBlack
      );
      frame.position.set(dx, wardH / 2 + 0.02, d / 2 + 0.005);

      // Fluted glass inset
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(doorW - 0.07, doorH - 0.08, 0.026),
        mats.glassFrosted
      );
      glass.position.set(dx, wardH / 2 + 0.02, d / 2 + 0.007);

      // Long vertical matte-black pull handle
      const handleOffset = (i % 2 === 0) ? (doorW * 0.38) : (-doorW * 0.38);
      const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.016, doorH * 0.48, 0.032),
        mats.metalBrass
      );
      handle.position.set(dx + handleOffset, wardH * 0.5, d / 2 + 0.024);

      this._markDetail(frame, glass, handle);
      g.add(frame, glass, handle);
    }
  }

  static _buildStudyDesk(g, w, d, h, mats) {
    const deskH = Math.min(Math.max(h, 0.72), 0.78);
    const deskD = Math.min(d, 0.72);

    // 1. Beveled Oak Tabletop (Primary Large Body)
    const top = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, 0.035, deskD, 0.015, 1),
      mats.woodOak
    );
    top.position.set(0, deskH - 0.017, -d * 0.1);
    this._markPrimary(top);
    g.add(top);

    // 2. Left Matte-Black A-Frame Leg + Right 3-Drawer Walnut Pedestal
    const legFrame = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, deskH - 0.035, deskD - 0.08),
      mats.metalBlack
    );
    legFrame.position.set(-w / 2 + 0.06, (deskH - 0.035) / 2, -d * 0.1);
    this._markDetail(legFrame);
    g.add(legFrame);

    const pedW = Math.min(0.42, w * 0.34);
    const pedestal = new THREE.Mesh(
      this.createRoundedBoxGeometry(pedW, deskH - 0.035, deskD - 0.04, 0.012, 1),
      mats.woodWalnut
    );
    pedestal.position.set(w / 2 - pedW / 2 - 0.03, (deskH - 0.035) / 2, -d * 0.1);
    this._markPrimary(pedestal);
    g.add(pedestal);

    // 3. Laptop / Monitor with Glowing Screen + Articulated Desk Lamp
    const monW = 0.52;
    const monH = 0.32;
    const monStandGeo = new THREE.CylinderGeometry(0.018, 0.06, 0.12, 8, 1);
    monStandGeo.computeVertexNormals();
    const monStand = new THREE.Mesh(monStandGeo, mats.metalChrome);
    monStand.position.set(-0.08, deskH + 0.06, -d * 0.1 - deskD * 0.25);
    const monScreen = new THREE.Mesh(new THREE.BoxGeometry(monW, monH, 0.016), mats.tvScreen);
    monScreen.position.set(-0.08, deskH + 0.10 + monH / 2, -d * 0.1 - deskD * 0.22);
    this._markDetail(monStand, monScreen);
    g.add(monStand, monScreen);

    // Architect Desk Lamp
    const lampBaseGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.02, 8, 1);
    lampBaseGeo.computeVertexNormals();
    const lampBase = new THREE.Mesh(lampBaseGeo, mats.metalBrass);
    lampBase.position.set(w * 0.28, deskH + 0.01, -d * 0.1 - deskD * 0.2);

    const lampArmGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.34, 8, 1);
    lampArmGeo.computeVertexNormals();
    const lampArm = new THREE.Mesh(lampArmGeo, mats.metalBrass);
    lampArm.position.set(w * 0.28, deskH + 0.17, -d * 0.1 - deskD * 0.15);
    lampArm.rotation.x = 0.3;

    const lampHeadGeo = new THREE.ConeGeometry(0.055, 0.10, 8, 1);
    lampHeadGeo.computeVertexNormals();
    const lampHead = new THREE.Mesh(lampHeadGeo, mats.emissiveWarm);
    lampHead.position.set(w * 0.28, deskH + 0.32, -d * 0.1 - deskD * 0.08);
    this._markDetail(lampBase, lampArm, lampHead);
    g.add(lampBase, lampArm, lampHead);

    // 4. Ergonomic Swivel Office Chair
    const chairX = -0.08;
    const chairZ = deskD * 0.38;
    const chairGroup = new THREE.Group();
    chairGroup.position.set(chairX, 0, chairZ);

    // 5-star caster base + pneumatic stem
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.02, 0.26), mats.metalBlack);
      arm.position.set(Math.sin(a) * 0.12, 0.04, Math.cos(a) * 0.12);
      arm.rotation.y = a;
      this._markDetail(arm);
      chairGroup.add(arm);
    }
    const stemGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.42, 8, 1);
    stemGeo.computeVertexNormals();
    const stem = new THREE.Mesh(stemGeo, mats.metalBlack);
    stem.position.y = 0.23;
    const seat = new THREE.Mesh(this.createRoundedBoxGeometry(0.46, 0.06, 0.44, 0.02, 1), mats.fabricVelvet);
    seat.position.y = 0.45;
    const back = new THREE.Mesh(this.createRoundedBoxGeometry(0.44, 0.48, 0.045, 0.02, 1), mats.metalBlack);
    back.position.set(0, 0.72, 0.20);
    back.rotation.x = 0.12;
    this._markDetail(stem, seat, back);
    chairGroup.add(stem, seat, back);
    g.add(chairGroup);
  }

  // =========================================================================
  // 4. ALTAR, GYM & ROOFTOP: TRADITIONAL VIETNAMESE ALTAR, TREADMILL, PLANTS, BBQ
  // =========================================================================

  static _buildAltarTable(g, w, d, h, mats) {
    const altarH = Math.min(Math.max(h, 1.18), 1.32);

    // 1. 4 Sturdy Carved Mahogany Posts (Chân quỳ dạ cá)
    const legR = 0.052;
    const legGeo = new THREE.CylinderGeometry(legR, legR * 0.88, altarH, 8, 1);
    legGeo.computeVertexNormals();
    const lotusFootGeo = new THREE.CylinderGeometry(legR * 1.15, legR * 1.3, 0.06, 8, 1);
    lotusFootGeo.computeVertexNormals();
    const lx = w / 2 - 0.09;
    const lz = d / 2 - 0.09;
    for (const [ox, oz] of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]]) {
      const post = new THREE.Mesh(legGeo, mats.woodMahogany);
      post.position.set(ox, altarH / 2, oz);
      const lotusFoot = new THREE.Mesh(lotusFootGeo, mats.metalBrass);
      lotusFoot.position.set(ox, 0.03, oz);
      this._markDetail(post, lotusFoot);
      g.add(post, lotusFoot);
    }

    // 2. Main Altar Tabletop with Upturned Ceremonial Ends (Tai cuốn) + Carved Apron (Primary)
    const topGeo = this.createRoundedBoxGeometry(w + 0.06, 0.055, d + 0.04, 0.015, 1);
    const top = new THREE.Mesh(topGeo, mats.woodMahogany);
    top.position.y = altarH - 0.025;
    this._markPrimary(top);
    g.add(top);

    // Upturned scroll ends (Tai cuốn)
    const scrollGeo = new THREE.CylinderGeometry(0.035, 0.035, d + 0.04, 8, 1);
    scrollGeo.rotateX(Math.PI / 2);
    scrollGeo.computeVertexNormals();
    for (const side of [-1, 1]) {
      const scroll = new THREE.Mesh(scrollGeo, mats.woodMahogany);
      scroll.position.set(side * (w / 2 + 0.04), altarH + 0.01, 0);
      this._markDetail(scroll);
      g.add(scroll);
    }

    // Carved Front Apron (Dạ cá) with Gold Filigree Medallion
    const apron = new THREE.Mesh(
      this.createRoundedBoxGeometry(w - 0.14, 0.24, 0.04, 0.01, 1),
      mats.woodMahogany
    );
    apron.position.set(0, altarH - 0.18, d / 2 - 0.07);
    const goldInlay = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.55, 0.09, 0.048),
      mats.metalBrass
    );
    goldInlay.position.set(0, altarH - 0.18, d / 2 - 0.07);
    this._markDetail(apron, goldInlay);
    g.add(apron, goldInlay);

    // Companion Lower Offering Table (Bàn cơm) underneath (Primary)
    const subTableH = 0.56;
    const subTop = new THREE.Mesh(
      this.createRoundedBoxGeometry(w * 0.58, 0.035, d * 0.68, 0.01, 1),
      mats.woodMahogany
    );
    subTop.position.set(0, subTableH, 0.05);
    this._markPrimary(subTop);
    g.add(subTop);
    const subLegGeo = new THREE.BoxGeometry(0.035, subTableH, 0.035);
    for (const [sx, sz] of [[-w * 0.25, -d * 0.26], [w * 0.25, -d * 0.26], [-w * 0.25, d * 0.36], [w * 0.25, d * 0.36]]) {
      const sLeg = new THREE.Mesh(subLegGeo, mats.woodMahogany);
      sLeg.position.set(sx, subTableH / 2, sz);
      this._markDetail(sLeg);
      g.add(sLeg);
    }

    // 3. Stepped Upper Offering Shelf (Nhị cấp)
    const stepH = 0.14;
    const stepShelf = new THREE.Mesh(
      this.createRoundedBoxGeometry(w * 0.82, stepH, d * 0.38, 0.012, 1),
      mats.woodMahogany
    );
    stepShelf.position.set(0, altarH + stepH / 2, -d * 0.24);
    this._markDetail(stepShelf);
    g.add(stepShelf);

    // 4. Brass Incense Burner (Bát hương đồng), Candlesticks & Ceramic Lotus Vases
    const burnerGeo = new THREE.CylinderGeometry(0.085, 0.07, 0.13, 8, 1);
    burnerGeo.computeVertexNormals();
    const burner = new THREE.Mesh(burnerGeo, mats.metalBrass);
    burner.position.set(0, altarH + 0.065, 0.08);
    this._markDetail(burner);
    g.add(burner);

    // Two tall Brass Candlesticks (Chân nến đồng)
    const cStickGeo = new THREE.CylinderGeometry(0.018, 0.055, 0.28, 8, 1);
    cStickGeo.computeVertexNormals();
    const flameGeo = new THREE.SphereGeometry(0.022, 6, 4);
    flameGeo.computeVertexNormals();
    const vaseGeo = new THREE.CylinderGeometry(0.05, 0.075, 0.32, 8, 1);
    vaseGeo.computeVertexNormals();
    const lotusGeo = new THREE.ConeGeometry(0.065, 0.14, 8, 1);
    lotusGeo.computeVertexNormals();

    for (const side of [-1, 1]) {
      const cStick = new THREE.Mesh(cStickGeo, mats.metalBrass);
      cStick.position.set(side * (w * 0.22), altarH + 0.14, 0.06);
      const flame = new THREE.Mesh(flameGeo, mats.emissiveWarm);
      flame.position.set(side * (w * 0.22), altarH + 0.30, 0.06);
      this._markDetail(cStick, flame);
      g.add(cStick, flame);

      // Ceramic Lotus Vase (Lọ lục bình) on upper step
      const vase = new THREE.Mesh(vaseGeo, mats.ceramicVase);
      vase.position.set(side * (w * 0.32), altarH + stepH + 0.16, -d * 0.24);
      const lotus = new THREE.Mesh(lotusGeo, mats.pillowAccentTerra);
      lotus.position.set(side * (w * 0.32), altarH + stepH + 0.36, -d * 0.24);
      this._markDetail(vase, lotus);
      g.add(vase, lotus);
    }

    // 5. Warm Glowing Circular Trúc Chỉ Mandala Wall Medallion Behind Altar
    const medRadius = Math.min(w * 0.42, 0.56);
    const medFrameGeo = new THREE.CylinderGeometry(medRadius + 0.04, medRadius + 0.04, 0.025, 16, 1);
    medFrameGeo.computeVertexNormals();
    const medFrame = new THREE.Mesh(medFrameGeo, mats.woodMahogany);
    medFrame.rotation.x = Math.PI / 2;
    medFrame.position.set(0, altarH + stepH + medRadius + 0.12, -d / 2 + 0.015);

    const medDiscGeo = new THREE.CylinderGeometry(medRadius, medRadius, 0.032, 16, 1);
    medDiscGeo.computeVertexNormals();
    const medDisc = new THREE.Mesh(medDiscGeo, mats.emissiveGold);
    medDisc.rotation.x = Math.PI / 2;
    medDisc.position.set(0, altarH + stepH + medRadius + 0.12, -d / 2 + 0.022);
    this._markDetail(medFrame, medDisc);
    g.add(medFrame, medDisc);
  }

  static _buildGymMachine(g, w, d, h, mats) {
    // 1. Dark Non-Slip Workout Mat underneath
    const matGeo = new THREE.PlaneGeometry(w * 1.15, d * 1.15);
    const mat = new THREE.Mesh(matGeo, mats.metalBlack);
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.004;
    this._markDetail(mat);
    g.add(mat);

    const deckW = Math.min(w * 0.78, 0.82);
    const deckD = Math.max(d * 0.88, 1.35);

    // 2. Running Deck with Belt & Side Foot Rails (Primary)
    const deckFrame = new THREE.Mesh(
      this.createRoundedBoxGeometry(deckW, 0.11, deckD, 0.03, 1),
      mats.metalBlack
    );
    deckFrame.position.set(0, 0.09, 0);
    this._markPrimary(deckFrame);

    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(deckW - 0.16, 0.116, deckD - 0.14),
      mats.fabricVelvet
    );
    belt.position.set(0, 0.092, 0.04);

    const motorHood = new THREE.Mesh(
      this.createRoundedBoxGeometry(deckW - 0.02, 0.16, 0.34, 0.04, 1),
      mats.kitchenCabinet
    );
    motorHood.position.set(0, 0.18, -deckD / 2 + 0.18);
    this._markDetail(belt, motorHood);
    g.add(deckFrame, belt, motorHood);

    // 3. Angled Side Uprights & Handlebars
    const uprightH = Math.max(h, 1.28);
    const postGeo = new THREE.CylinderGeometry(0.028, 0.032, uprightH, 8, 1);
    postGeo.computeVertexNormals();
    const gripGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.42, 8, 1);
    gripGeo.computeVertexNormals();

    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, mats.metalBlack);
      post.position.set(side * (deckW / 2 - 0.04), uprightH / 2 + 0.08, -deckD / 2 + 0.24);
      post.rotation.x = 0.16;

      const grip = new THREE.Mesh(gripGeo, mats.metalChrome);
      grip.rotation.x = Math.PI / 2;
      grip.position.set(side * (deckW / 2 - 0.04), uprightH * 0.82, -deckD / 2 + 0.38);
      this._markDetail(post, grip);
      g.add(post, grip);
    }

    // 4. Angled Touchscreen Console with Glowing Telemetry Strip
    const consoleBox = new THREE.Mesh(
      this.createRoundedBoxGeometry(deckW + 0.04, 0.26, 0.12, 0.02, 1),
      mats.metalBlack
    );
    consoleBox.position.set(0, uprightH + 0.08, -deckD / 2 + 0.16);
    consoleBox.rotation.x = -0.45;

    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(deckW * 0.65, 0.16, 0.128),
      mats.tvScreen
    );
    screen.position.copy(consoleBox.position);
    screen.rotation.copy(consoleBox.rotation);
    this._markDetail(consoleBox, screen);
    g.add(consoleBox, screen);
  }

  static _buildBotanicalPlanter(g, w, d, h, mats) {
    const rad = Math.min(w, d) * 0.38;
    const potH = Math.min(0.45, h * 0.35);

    // Pot (Primary)
    const potGeo = new THREE.CylinderGeometry(rad, rad * 0.78, potH, 8, 1);
    potGeo.computeVertexNormals();
    const pot = new THREE.Mesh(potGeo, mats.terracottaPot);
    pot.position.y = potH / 2;
    this._markPrimary(pot);

    const trunkGeo = new THREE.CylinderGeometry(0.035, 0.055, h * 0.65, 8, 1);
    trunkGeo.computeVertexNormals();
    const trunk = new THREE.Mesh(trunkGeo, mats.woodWalnut);
    trunk.position.y = potH + (h * 0.65) / 2 - 0.05;
    this._markDetail(trunk);
    g.add(pot, trunk);

    // Multi-layered lush foliage clusters
    const clusters = [
      { x: 0, y: h * 0.82, z: 0, r: rad * 1.15, mat: mats.treeFoliage },
      { x: -rad * 0.45, y: h * 0.68, z: rad * 0.3, r: rad * 0.82, mat: mats.plantFoliageLight },
      { x: rad * 0.48, y: h * 0.72, z: -rad * 0.25, r: rad * 0.85, mat: mats.treeFoliage }
    ];
    for (const c of clusters) {
      const leafGeo = new THREE.DodecahedronGeometry(c.r, 0);
      leafGeo.computeVertexNormals();
      const leaf = new THREE.Mesh(leafGeo, c.mat);
      leaf.position.set(c.x, c.y, c.z);
      this._markDetail(leaf);
      g.add(leaf);
    }
  }

  static _buildRooftopBbq(g, w, d, h, mats) {
    const cabH = 0.86;
    const base = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, cabH, d, 0.015, 1),
      mats.metalBlack
    );
    base.position.y = cabH / 2;

    // Marble side prep counter (Primary) + Stainless steel central grill hood
    const counter = new THREE.Mesh(
      this.createRoundedBoxGeometry(w + 0.02, 0.03, d + 0.02, 0.01, 1),
      mats.marbleCarrara
    );
    counter.position.y = cabH + 0.015;
    this._markPrimary(base, counter);

    const hood = new THREE.Mesh(
      this.createRoundedBoxGeometry(w * 0.52, 0.32, d * 0.82, 0.04, 1),
      mats.stainlessSteel
    );
    hood.position.set(0, cabH + 0.18, -0.02);

    const handleGeo = new THREE.CylinderGeometry(0.012, 0.012, w * 0.42, 8, 1);
    handleGeo.computeVertexNormals();
    const handle = new THREE.Mesh(handleGeo, mats.metalChrome);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0, cabH + 0.16, d * 0.43);

    this._markDetail(hood, handle);
    g.add(base, counter, hood, handle);
  }

  // =========================================================================
  // 5. BATHROOMS: TOILET, VANITY WITH LED MIRROR, FREESTANDING BATHTUB
  // =========================================================================

  static _buildToilet(g, w, d, h, mats) {
    const bowlW = Math.min(w, 0.42);
    const bowlD = Math.min(d, 0.68);

    // 1. Curved Pedestal & Ergonomic Porcelain Bowl (Primary)
    const pedGeo = new THREE.CylinderGeometry(bowlW * 0.42, bowlW * 0.36, 0.24, 8, 1);
    pedGeo.computeVertexNormals();
    const pedestal = new THREE.Mesh(pedGeo, mats.ceramicSanitary);
    pedestal.scale.set(1, 1, 1.35);
    pedestal.position.set(0, 0.12, bowlD * 0.06);

    const bowlGeo = new THREE.SphereGeometry(bowlW * 0.48, 8, 6, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.65);
    bowlGeo.computeVertexNormals();
    const bowl = new THREE.Mesh(bowlGeo, mats.ceramicSanitary);
    bowl.scale.set(1, 0.95, 1.38);
    bowl.position.set(0, 0.38, bowlD * 0.10);

    // Seat lid
    const lidGeo = new THREE.CylinderGeometry(bowlW * 0.47, bowlW * 0.47, 0.032, 8, 1);
    lidGeo.computeVertexNormals();
    const lid = new THREE.Mesh(lidGeo, mats.ceramicSanitary);
    lid.scale.set(1, 1, 1.35);
    lid.position.set(0, 0.41, bowlD * 0.10);
    this._markDetail(lid);
    g.add(pedestal, bowl, lid);

    // 2. Rear Cistern Tank with Dual-Flush Chrome Button (Primary Tank)
    const tankH = 0.38;
    const tank = new THREE.Mesh(
      this.createRoundedBoxGeometry(bowlW * 0.96, tankH, bowlD * 0.34, 0.035, 1),
      mats.ceramicSanitary
    );
    tank.position.set(0, 0.38 + tankH / 2, -bowlD * 0.32);

    const flushBtnGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.015, 8, 1);
    flushBtnGeo.computeVertexNormals();
    const flushBtn = new THREE.Mesh(flushBtnGeo, mats.metalChrome);
    flushBtn.position.set(0, 0.38 + tankH + 0.006, -bowlD * 0.32);

    this._markPrimary(pedestal, bowl, tank);
    this._markDetail(flushBtn);
    g.add(tank, flushBtn);
  }

  static _buildBathroomVanity(g, w, d, h, mats) {
    const vanH = Math.min(Math.max(h, 0.82), 0.88);
    const cabH = 0.52;
    const cabY = vanH - 0.03 - cabH / 2;

    // 1. Floating Slatted Walnut Vanity Cabinet (Primary)
    const cab = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, cabH, d, 0.015, 1),
      mats.woodWalnut
    );
    cab.position.y = cabY;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, 0.015, 0.025), mats.metalBrass);
    handle.position.set(0, cabY + 0.12, d / 2 + 0.012);
    this._markPrimary(cab);
    this._markDetail(handle);
    g.add(cab, handle);

    // 2. White Carrara Marble Top (Primary) + Oval Porcelain Vessel Basin + Chrome Faucet
    const top = new THREE.Mesh(
      this.createRoundedBoxGeometry(w + 0.02, 0.035, d + 0.02, 0.01, 1),
      mats.marbleCarrara
    );
    top.position.y = vanH - 0.017;
    this._markPrimary(top);

    const vesselGeo = new THREE.CylinderGeometry(0.21, 0.16, 0.13, 8, 1);
    vesselGeo.computeVertexNormals();
    const vessel = new THREE.Mesh(vesselGeo, mats.ceramicSanitary);
    vessel.scale.set(1.25, 1, 0.9);
    vessel.position.set(0, vanH + 0.06, 0.02);

    const basinWellGeo = new THREE.CylinderGeometry(0.18, 0.14, 0.02, 8, 1);
    basinWellGeo.computeVertexNormals();
    const basinWell = new THREE.Mesh(basinWellGeo, mats.porcelainTile);
    basinWell.scale.set(1.22, 1, 0.88);
    basinWell.position.set(0, vanH + 0.118, 0.02);

    const faucetGeo = new THREE.CylinderGeometry(0.014, 0.018, 0.21, 8, 1);
    faucetGeo.computeVertexNormals();
    const faucet = new THREE.Mesh(faucetGeo, mats.metalChrome);
    faucet.position.set(0, vanH + 0.10, -d * 0.30);
    const spout = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.016, 0.12), mats.metalChrome);
    spout.position.set(0, vanH + 0.19, -d * 0.24);
    this._markDetail(vessel, basinWell, faucet, spout);
    g.add(top, vessel, basinWell, faucet, spout);

    // 3. Rounded Rectangular Wall Mirror with Warm LED Backlit Halo
    const mirW = w * 0.82;
    const mirH = 0.88;
    const mirY = vanH + 0.26 + mirH / 2;

    const halo = new THREE.Mesh(
      this.createRoundedBoxGeometry(mirW + 0.05, mirH + 0.05, 0.015, 0.08, 1),
      mats.emissiveWarm
    );
    halo.position.set(0, mirY, -d / 2 + 0.012);

    const mirror = new THREE.Mesh(
      this.createRoundedBoxGeometry(mirW, mirH, 0.018, 0.07, 1),
      mats.mirrorSurface
    );
    mirror.position.set(0, mirY, -d / 2 + 0.024);
    this._markDetail(halo, mirror);
    g.add(halo, mirror);
  }

  static _buildBathtub(g, w, d, h, hasShowerScreen, mats) {
    const tubH = Math.min(Math.max(h, 0.54), 0.62);
    const rx = w / 2 - 0.02;
    const rz = d / 2 - 0.02;

    // 1. Sculpted Freestanding Oval Soaking Tub (Primary)
    const tubGeo = new THREE.CylinderGeometry(1.0, 0.86, tubH, 12, 1);
    tubGeo.computeVertexNormals();
    const outerTub = new THREE.Mesh(tubGeo, mats.ceramicSanitary);
    outerTub.scale.set(rx, 1, rz);
    outerTub.position.y = tubH / 2;
    this._markPrimary(outerTub);

    // Curved top rim & recessed interior water/basin depth
    const rimGeo = new THREE.TorusGeometry(0.95, 0.055, 6, 8);
    rimGeo.computeVertexNormals();
    const rim = new THREE.Mesh(rimGeo, mats.ceramicSanitary);
    rim.rotation.x = Math.PI / 2;
    rim.scale.set(rx, rz, 1);
    rim.position.y = tubH - 0.02;

    const waterGeo = new THREE.CylinderGeometry(0.88, 0.82, 0.04, 10, 1);
    waterGeo.computeVertexNormals();
    const innerWater = new THREE.Mesh(waterGeo, mats.waterSurface);
    innerWater.scale.set(rx, 1, rz);
    innerWater.position.y = tubH * 0.68;

    // Wooden bath caddy across center
    const caddy = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.022, d * 0.96),
      mats.woodOak
    );
    caddy.position.set(0.12, tubH + 0.015, 0);
    this._markDetail(rim, innerWater, caddy);
    g.add(outerTub, rim, innerWater, caddy);

    // 2. Floor-Mounted Freestanding Chrome Filler Tap
    const standPipeGeo = new THREE.CylinderGeometry(0.018, 0.024, tubH + 0.24, 8, 1);
    standPipeGeo.computeVertexNormals();
    const standPipe = new THREE.Mesh(standPipeGeo, mats.metalChrome);
    standPipe.position.set(-w / 2 + 0.08, (tubH + 0.24) / 2, 0);
    const spout = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 0.022), mats.metalChrome);
    spout.position.set(-w / 2 + 0.16, tubH + 0.23, 0);
    this._markDetail(standPipe, spout);
    g.add(standPipe, spout);

    // 3. Optional Tempered Glass Shower Screen
    if (hasShowerScreen) {
      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.55, 1.85, 0.016),
        mats.glassClear
      );
      screen.position.set(-w * 0.2, 0.925, d / 2 + 0.01);
      this._markDetail(screen);
      g.add(screen);
    }
  }

  static _buildDesignerCredenza(g, w, d, h, mats) {
    const legH = 0.12;
    const bodyH = Math.max(0.25, h - legH);
    const body = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, bodyH, d, 0.02, 1),
      mats.woodOak
    );
    body.position.y = legH + bodyH / 2;
    this._markPrimary(body);

    const top = new THREE.Mesh(
      this.createRoundedBoxGeometry(w - 0.02, 0.02, d - 0.02, 0.01, 1),
      mats.marbleCarrara
    );
    top.position.y = h + 0.01;
    this._markDetail(top);
    g.add(body, top);
  }

  // =========================================================================
  // 6. ARCHITECTURAL DETAIL BUILDERS: STAIRCASE, DOOR, WINDOW, BALCONY RAILING
  // =========================================================================

  /**
   * Builds a full 3D U-shaped / two-flight staircase connecting lower floor (y=0) to upper floor (y=rise)
   * with individual oak treads (with nosing), white risers, angled structural stringer beams underneath,
   * mid-landing platform with baseboard, continuous handrails, and vertical balusters every 0.12m.
   */
  static buildDetailedStaircase(stairData, materials = null) {
    const mats = this._getMaterials(materials);
    const group = new THREE.Group();
    group.position.set(stairData.x || 0, 0, stairData.y || 0);

    const w = Math.max(1.2, stairData.width || 2.2);
    const d = Math.max(1.8, stairData.depth || 2.8);
    const rise = Math.max(2.6, stairData.rise || 3.6);
    const totalSteps = Math.max(16, stairData.stepsCount || 20);
    if (stairData.asset_id === 'stair_flight_straight') {
      const stepH = rise / totalSteps;
      const stepD = d / totalSteps;
      const tread = new THREE.BoxGeometry(w, 0.04, stepD + 0.015);
      for (let i = 0; i < totalSteps; i++) {
        const y = (i + 1) * stepH;
        const z = -d / 2 + (i + 0.5) * stepD;
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, y - 0.04, stepD), mats.stairRiser);
        body.position.set(0, (y - 0.04) / 2, z);
        const top = new THREE.Mesh(tread, mats.woodOak);
        top.position.set(0, y - 0.02, z);
        body.castShadow = top.castShadow = true;
        body.receiveShadow = top.receiveShadow = true;
        group.add(body, top);
      }
      group.rotation.y = stairData.rotation || 0;
      return group;
    }
    const halfSteps = Math.floor(totalSteps / 2);

    const landingD = Math.min(0.95, d * 0.34);
    const flightRun = d - landingD;
    const stepH = rise / totalSteps;
    const stepD = flightRun / halfSteps;
    const flightW = (w - 0.14) / 2;
    const treadThick = 0.038;
    const nosing = 0.024;

    const flight1X = -w / 4 - 0.02;
    const flight2X = w / 4 + 0.02;
    const startZ = -d / 2;
    const landingZ = d / 2 - landingD / 2;
    const midY = halfSteps * stepH;

    // 1. Flight 1 (going up from -Z toward +Z landing) + Flight 2 (going up from +Z landing toward -Z)
    const treadGeo = this.createRoundedBoxGeometry(flightW, treadThick, stepD + nosing, 0.008, 1);
    const riserGeo = this.createRoundedBoxGeometry(flightW - 0.01, stepH, 0.018, 0.002, 1);
    const balusterGeo = new THREE.CylinderGeometry(0.009, 0.009, 0.90, 6, 1);
    balusterGeo.computeVertexNormals();

    for (let i = 0; i < halfSteps; i++) {
      // --- Flight 1 ---
      const y1 = (i + 1) * stepH;
      const z1 = startZ + (i + 0.5) * stepD;

      const tread1 = new THREE.Mesh(treadGeo, mats.woodOak);
      tread1.position.set(flight1X, y1 - treadThick / 2, z1 - nosing / 2);
      this._markPrimary(tread1);
      const riser1 = new THREE.Mesh(riserGeo, mats.stairRiser);
      riser1.position.set(flight1X, y1 - stepH / 2, z1 - stepD / 2);
      this._markDetail(riser1);
      group.add(tread1, riser1);

      // Balusters every ~0.12m (2 balusters per tread along inner stairwell edge)
      for (const bOffset of [-stepD * 0.22, stepD * 0.22]) {
        const bal1 = new THREE.Mesh(balusterGeo, mats.metalBlack);
        bal1.position.set(flight1X + flightW / 2 - 0.03, y1 + 0.45, z1 + bOffset);
        this._markDetail(bal1);
        group.add(bal1);
      }

      // --- Flight 2 (Return flight to upper floor) ---
      const y2 = midY + (i + 1) * stepH;
      const z2 = (d / 2 - landingD) - (i + 0.5) * stepD;

      const tread2 = new THREE.Mesh(treadGeo, mats.woodOak);
      tread2.position.set(flight2X, y2 - treadThick / 2, z2 + nosing / 2);
      this._markPrimary(tread2);
      const riser2 = new THREE.Mesh(riserGeo, mats.stairRiser);
      riser2.position.set(flight2X, y2 - stepH / 2, z2 + stepD / 2);
      this._markDetail(riser2);
      group.add(tread2, riser2);

      for (const bOffset of [-stepD * 0.22, stepD * 0.22]) {
        const bal2 = new THREE.Mesh(balusterGeo, mats.metalBlack);
        bal2.position.set(flight2X - flightW / 2 + 0.03, y2 + 0.45, z2 + bOffset);
        this._markDetail(bal2);
        group.add(bal2);
      }
    }

    // 2. Angled Structural Stringer Beams Underneath Flight 1 & Flight 2
    const flightLen = Math.hypot(flightRun, midY);
    const flightAngle = Math.atan2(midY, flightRun);
    const stringerGeo = this.createRoundedBoxGeometry(0.08, 0.18, flightLen, 0.003, 1);

    const stringer1 = new THREE.Mesh(stringerGeo, mats.concreteSlab);
    stringer1.position.set(flight1X, midY / 2 - 0.09, startZ + flightRun / 2);
    stringer1.rotation.x = -flightAngle;

    const stringer2 = new THREE.Mesh(stringerGeo, mats.concreteSlab);
    stringer2.position.set(flight2X, midY + midY / 2 - 0.09, startZ + flightRun / 2);
    stringer2.rotation.x = flightAngle;
    this._markPrimary(stringer1, stringer2);
    group.add(stringer1, stringer2);

    // 3. Mid-Landing Platform with Oak Finish & Baseboard
    const landSlab = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, 0.16, landingD, 0.003, 1),
      mats.concreteSlab
    );
    landSlab.position.set(0, midY - 0.08, landingZ);
    const landTop = new THREE.Mesh(
      this.createRoundedBoxGeometry(w, treadThick, landingD, 0.01, 1),
      mats.woodOak
    );
    landTop.position.set(0, midY - treadThick / 2, landingZ);
    this._markPrimary(landSlab, landTop);

    const landBaseboard = new THREE.Mesh(
      this.createRoundedBoxGeometry(w - 0.02, 0.08, 0.02, 0.002, 1),
      mats.baseboardMat
    );
    landBaseboard.position.set(0, midY + 0.04, d / 2 - 0.01);
    this._markDetail(landBaseboard);
    group.add(landSlab, landTop, landBaseboard);

    // 4. Continuous Sloped Dark Steel / Walnut Handrails + Newel Posts
    const railGeo = new THREE.CylinderGeometry(0.022, 0.022, flightLen + 0.12, 8, 1);
    railGeo.rotateX(Math.PI / 2);
    railGeo.computeVertexNormals();

    const rail1 = new THREE.Mesh(railGeo, mats.woodWalnut);
    rail1.position.set(flight1X + flightW / 2 - 0.03, midY / 2 + 0.90, startZ + flightRun / 2);
    rail1.rotation.x = -flightAngle;

    const rail2 = new THREE.Mesh(railGeo, mats.woodWalnut);
    rail2.position.set(flight2X - flightW / 2 + 0.03, midY + midY / 2 + 0.90, startZ + flightRun / 2);
    rail2.rotation.x = flightAngle;
    this._markDetail(rail1, rail2);
    group.add(rail1, rail2);

    // Newel posts at bottom, mid-landing, and top
    const newelGeo = new THREE.BoxGeometry(0.045, 0.98, 0.045);
    const newelPositions = [
      [flight1X + flightW / 2 - 0.03, 0.49, startZ + 0.05],
      [flight1X + flightW / 2 - 0.03, midY + 0.49, d / 2 - landingD],
      [flight2X - flightW / 2 + 0.03, midY + 0.49, d / 2 - landingD],
      [flight2X - flightW / 2 + 0.03, rise + 0.49, startZ + 0.05]
    ];
    for (const [nx, ny, nz] of newelPositions) {
      const post = new THREE.Mesh(newelGeo, mats.metalBlack);
      post.position.set(nx, ny, nz);
      this._markDetail(post);
      group.add(post);
    }

    return this._finalizeGroup(group, 'structure');
  }

  /**
   * Builds a 3D architectural door with perimeter frame (jambs + header),
   * recessed-panel wooden door leaf (slightly ajar by default for 3D visual depth),
   * and metallic lever handles on both sides.
   */
  static buildDetailedDoor(doorData, materials = null) {
    const mats = this._getMaterials(materials);
    const group = new THREE.Group();

    const w = doorData.width || 0.92;
    const h = doorData.height || 2.20;
    const frameDepth = (doorData.wallThickness || 0.18) + 0.03;
    const jambW = 0.05;

    if (doorData.x !== undefined && doorData.y !== undefined) {
      group.position.set(doorData.x, 0, doorData.y);
    }
    if (doorData.rotation !== undefined) {
      group.rotation.y = doorData.rotation;
    } else if (doorData.angle !== undefined) {
      group.rotation.y = -doorData.angle;
    }

    // 1. Door Frame (Left Jamb, Right Jamb, Top Header Architrave)
    const jambGeo = new THREE.BoxGeometry(jambW, h, frameDepth);
    const leftJamb = new THREE.Mesh(jambGeo, mats.woodWalnut);
    leftJamb.position.set(-w / 2 + jambW / 2, h / 2, 0);
    const rightJamb = new THREE.Mesh(jambGeo, mats.woodWalnut);
    rightJamb.position.set(w / 2 - jambW / 2, h / 2, 0);

    const headerGeo = new THREE.BoxGeometry(w + 0.04, jambW * 1.2, frameDepth + 0.01);
    const header = new THREE.Mesh(headerGeo, mats.woodWalnut);
    header.position.set(0, h - jambW * 0.4, 0);
    this._markPrimary(leftJamb, rightJamb, header);
    group.add(leftJamb, rightJamb, header);

    // 2. Hinged Pivot Group & Recessed-Panel Wood Door Leaf
    const leafW = w - jambW * 2;
    const leafH = h - jambW - 0.01;
    const leafThick = 0.045;

    const hingePivot = new THREE.Group();
    hingePivot.position.set(-w / 2 + jambW, 0, 0);
    // Slightly ajar (22 degrees) unless explicitly closed so Dollhouse overhead view clearly shows doors
    const swingAngle = doorData.isOpen === false ? 0 : (doorData.swingAngle ?? 0.38);
    hingePivot.rotation.y = swingAngle;

    const leafMesh = new THREE.Mesh(
      this.createRoundedBoxGeometry(leafW, leafH, leafThick, 0.008, 1),
      mats.woodOak
    );
    leafMesh.position.set(leafW / 2, leafH / 2 + 0.005, 0);
    this._markPrimary(leafMesh);
    hingePivot.add(leafMesh);

    // Upper & Lower Recessed Decorative Molding Panels
    const panelW = leafW - 0.16;
    const upperPanel = new THREE.Mesh(
      new THREE.BoxGeometry(panelW, leafH * 0.46, leafThick + 0.012),
      mats.woodWalnut
    );
    upperPanel.position.set(leafW / 2, leafH * 0.68, 0);
    const lowerPanel = new THREE.Mesh(
      new THREE.BoxGeometry(panelW, leafH * 0.28, leafThick + 0.012),
      mats.woodWalnut
    );
    lowerPanel.position.set(leafW / 2, leafH * 0.24, 0);
    this._markDetail(upperPanel, lowerPanel);
    hingePivot.add(upperPanel, lowerPanel);

    // 3. Metallic Lever Handles on Both Sides
    const handleX = leafW - 0.08;
    const handleY = 1.02;
    const rose = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.14, leafThick + 0.03), mats.metalBrass);
    rose.position.set(handleX, handleY, 0);
    this._markDetail(rose);
    for (const side of [-1, 1]) {
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.018, 0.02), mats.metalBrass);
      lever.position.set(handleX - 0.035, handleY, side * (leafThick / 2 + 0.025));
      this._markDetail(lever);
      hingePivot.add(lever);
    }
    hingePivot.add(rose);
    group.add(hingePivot);

    return this._finalizeGroup(group, 'walls_openings');
  }

  /**
   * Builds a 3D architectural window with perimeter dark aluminum frame,
   * projecting stone sill plate, intermediate vertical mullions, and physical reflective glass pane.
   */
  static buildDetailedWindow(winData, materials = null) {
    const mats = this._getMaterials(materials);
    const group = new THREE.Group();

    let length = winData.width || 1.4;
    let angle = 0;
    const sillH = winData.sillHeight ?? 0.9;
    const winH = winData.windowHeight ?? 1.6;
    const frameDepth = (winData.wallThickness || 0.20) + 0.03;

    if (winData.p1 && winData.p2) {
      const dx = winData.p2.x - winData.p1.x;
      const dy = winData.p2.y - winData.p1.y;
      length = Math.max(0.4, Math.hypot(dx, dy));
      angle = Math.atan2(dy, dx);
      const midX = (winData.p1.x + winData.p2.x) / 2;
      const midY = (winData.p1.y + winData.p2.y) / 2;
      group.position.set(midX, sillH + winH / 2, midY);
      group.rotation.y = -angle;
    }

    const barT = 0.05;

    // 1. Perimeter Aluminum Frame (Top, Bottom, Left, Right)
    const hBarGeo = new THREE.BoxGeometry(length, barT, frameDepth);
    const topBar = new THREE.Mesh(hBarGeo, mats.metalBlack);
    topBar.position.y = winH / 2 - barT / 2;
    const botBar = new THREE.Mesh(hBarGeo, mats.metalBlack);
    botBar.position.y = -winH / 2 + barT / 2;

    const vBarGeo = new THREE.BoxGeometry(barT, winH, frameDepth);
    const leftBar = new THREE.Mesh(vBarGeo, mats.metalBlack);
    leftBar.position.x = -length / 2 + barT / 2;
    const rightBar = new THREE.Mesh(vBarGeo, mats.metalBlack);
    rightBar.position.x = length / 2 - barT / 2;
    this._markPrimary(topBar, botBar, leftBar, rightBar);
    group.add(topBar, botBar, leftBar, rightBar);

    // 2. Projecting Architectural Sill Plate underneath
    const sillPlate = new THREE.Mesh(
      this.createRoundedBoxGeometry(length + 0.08, 0.04, frameDepth + 0.06, 0.008, 1),
      mats.marbleCarrara
    );
    sillPlate.position.y = -winH / 2 - 0.015;
    this._markPrimary(sillPlate);
    group.add(sillPlate);

    // 3. Intermediate Vertical Mullions (every ~0.95m) & Transom Bar
    const numPanels = Math.max(1, Math.round(length / 0.95));
    const mullionGeo = new THREE.BoxGeometry(0.038, winH - barT * 2, frameDepth * 0.75);
    for (let i = 1; i < numPanels; i++) {
      const mx = -length / 2 + (i / numPanels) * length;
      const mullion = new THREE.Mesh(mullionGeo, mats.metalBlack);
      mullion.position.x = mx;
      this._markDetail(mullion);
      group.add(mullion);
    }

    if (winH >= 1.65) {
      const transom = new THREE.Mesh(
        new THREE.BoxGeometry(length - barT * 2, 0.032, frameDepth * 0.72),
        mats.metalBlack
      );
      transom.position.y = winH * 0.24;
      this._markDetail(transom);
      group.add(transom);
    }

    // 4. Physical Reflective Glass Pane
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(length - barT * 2, winH - barT * 2, 0.024),
      mats.glassClear
    );
    glass.userData.castShadow = false;
    this._markDetail(glass);
    group.add(glass);

    return this._finalizeGroup(group, 'walls_openings');
  }

  /**
   * Builds a 3D Balcony Railing / Balustrade with top handrail, bottom rail,
   * structural posts, vertical balusters every 0.12m, and tempered glass panel option.
   */
  static buildBalconyRailing(length, height = 1.05, materials = null, options = {}) {
    const mats = this._getMaterials(materials);
    const group = new THREE.Group();
    const len = Math.max(0.5, length || 3.0);
    const h = Math.max(0.85, height || 1.05);

    // 1. Top Walnut/Steel Handrail & Bottom Rail
    const topRail = new THREE.Mesh(
      this.createRoundedBoxGeometry(len, 0.045, 0.065, 0.012, 1),
      mats.woodWalnut
    );
    topRail.position.y = h - 0.022;

    const botRail = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.035, 0.045),
      mats.metalBlack
    );
    botRail.position.y = 0.08;
    this._markPrimary(topRail, botRail);
    group.add(topRail, botRail);

    // 2. End & Intermediate Structural Posts
    const numSpans = Math.max(1, Math.round(len / 1.4));
    const postGeo = new THREE.BoxGeometry(0.045, h, 0.045);
    for (let i = 0; i <= numSpans; i++) {
      const px = -len / 2 + (i / numSpans) * len;
      const post = new THREE.Mesh(postGeo, mats.metalBlack);
      post.position.set(px, h / 2, 0);
      this._markPrimary(post);
      group.add(post);
    }

    // 3. Vertical Balusters spaced every 0.12m + Tempered Glass Balustrade
    if (options.glassBalustrade) {
      const glassPanel = new THREE.Mesh(
        new THREE.BoxGeometry(len - 0.08, h - 0.16, 0.018),
        mats.glassClear
      );
      glassPanel.position.y = h / 2;
      glassPanel.userData.castShadow = false;
      this._markDetail(glassPanel);
      group.add(glassPanel);
    } else {
      const balusterCount = Math.floor(len / 0.12);
      const balGeo = new THREE.CylinderGeometry(0.008, 0.008, h - 0.12, 6, 1);
      balGeo.computeVertexNormals();
      for (let i = 1; i < balusterCount; i++) {
        const bx = -len / 2 + i * 0.12;
        const bal = new THREE.Mesh(balGeo, mats.metalBlack);
        bal.position.set(bx, h / 2 + 0.02, 0);
        this._markDetail(bal);
        group.add(bal);
      }
    }

    return this._finalizeGroup(group, 'walls_openings');
  }

  // Instance method delegates so callers can use either static or instance API
  createFurnitureMesh(item, materials = null) {
    return FurnitureGenerator.createFurnitureMesh(item, materials || this.materials);
  }

  buildDetailedStaircase(stairData, materials = null) {
    return FurnitureGenerator.buildDetailedStaircase(stairData, materials || this.materials);
  }

  buildDetailedDoor(doorData, materials = null) {
    return FurnitureGenerator.buildDetailedDoor(doorData, materials || this.materials);
  }

  buildDetailedWindow(winData, materials = null) {
    return FurnitureGenerator.buildDetailedWindow(winData, materials || this.materials);
  }

  buildBalconyRailing(length, height, materials = null, options = {}) {
    return FurnitureGenerator.buildBalconyRailing(length, height, materials || this.materials, options);
  }
}

export default FurnitureGenerator;
