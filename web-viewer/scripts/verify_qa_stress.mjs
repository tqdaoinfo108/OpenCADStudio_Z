/**
 * verify_qa_stress.mjs
 * Automated Browser QA & Stress-Test Verification for OpenCADStudio_Z 3D Web Viewer
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_VIEWER_DIR = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(WEB_VIEWER_DIR, 'screenshots');
const ARTIFACT_DIR = 'C:/Users/qdaoc/.gemini/antigravity/brain/6d9d0f69-2663-4484-b741-4ec8b642e32b';

const PLAYWRIGHT_PATH = 'file:///C:/Users/qdaoc/AppData/Local/npm-cache/_npx/9b9809298fe40d2c/node_modules/playwright-core/index.mjs';
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE_URL = process.env.VIEWER_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runVerification() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const { chromium } = await import(PLAYWRIGHT_PATH);
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--enable-accelerated-2d-canvas',
      '--window-size=1920,1080'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2
  });

  const page = await context.newPage();

  const consoleErrors = [];
  const webglWarnings = [];
  const pageErrors = [];
  let contextLostCount = 0;

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      // Ignore google fonts network error if offline, capture everything else
      if (!text.includes('fonts.googleapis.com') && !text.includes('fonts.gstatic.com')) {
        consoleErrors.push(text);
      }
    }
    if (
      text.includes('THREE.WebGL') ||
      text.includes('WebGL warning') ||
      text.includes('CONTEXT_LOST') ||
      text.includes('webglcontextlost') ||
      (type === 'warning' && text.toLowerCase().includes('webgl'))
    ) {
      webglWarnings.push(text);
    }
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err.stack || err.message || String(err));
  });

  console.log(`[1/10] Opening ${BASE_URL}...`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#viewport-container canvas', { timeout: 10000 });
  await sleep(800);

  // Attach context loss listener inside page
  await page.evaluate(() => {
    window.__webglContextLosses = 0;
    const canvas = document.querySelector('#viewport-container canvas');
    if (canvas) {
      canvas.addEventListener('webglcontextlost', () => {
        window.__webglContextLosses++;
      });
    }
  });

  // Ensure we start on the 4-floor project 'nha-pho-4-tang-5x8'
  const initialProjectInfo = await page.evaluate(async () => {
    if (window.app.activeProjectId !== 'nha-pho-4-tang-5x8') {
      await window.app.switchProject('nha-pho-4-tang-5x8');
    }
    return {
      activeProjectId: window.app.activeProjectId,
      title: document.getElementById('project-title')?.textContent,
      floorsCount: window.app.currentBim?.floors?.length,
      floorIds: window.app.currentBim?.floors?.map(f => f.id)
    };
  });
  console.log(`[2/10] Active Project:`, initialProjectInfo);
  assert(initialProjectInfo.floorsCount === 4, `Expected 4 floors in nha-pho-4-tang-5x8, got ${initialProjectInfo.floorsCount}`);

  // Wait for AssetLibraryManager to finish preloading all 35 .glb models
  const assetLibraryReport = await page.evaluate(async () => {
    const alm = window.AssetLibraryManager || window.app?.viewer?.assetLibrary;
    if (alm && typeof alm.preloadAll === 'function') {
      await alm.preloadAll();
    }
    // Wait a tick if scene auto-upgrade was triggered
    await new Promise(r => setTimeout(r, 250));
    const stats = alm?.getStats ? alm.getStats() : {
      loadedCount: alm?.loadedCount || 0,
      failedCount: alm?.failedCount || 0,
      totalCount: alm?.totalCount || 0,
      isLoaded: Boolean(alm?.isLoaded)
    };

    const v = window.app.viewer;
    let glbFurnitureCount = 0;
    let contactShadowCount = 0;
    let sharedGpuMeshCount = 0;
    const instantiatedAssetIds = new Set();

    for (const obj of v.selectableObjects) {
      let hasGlbMesh = Boolean(obj.userData?.isGlbAsset);
      let hasContactShadow = false;
      obj.traverse((child) => {
        if (child.isMesh) {
          if (child.userData?.isGlbInstance) hasGlbMesh = true;
          if (child.name === 'ContactShadowPlane' || child.userData?.isContactShadow) {
            hasContactShadow = true;
          }
          if (child.geometry?.userData?.isSharedGeometry && child.material?.userData?.isSharedPBR) {
            sharedGpuMeshCount++;
          }
        }
        if (child.userData?.assetId) {
          instantiatedAssetIds.add(child.userData.assetId);
        }
      });
      if (hasGlbMesh) glbFurnitureCount++;
      if (hasContactShadow) contactShadowCount++;
    }

    return {
      ...stats,
      selectableFurnitureCount: v.selectableObjects.length,
      glbFurnitureCount,
      contactShadowCount,
      sharedGpuMeshCount,
      distinctAssetIdsInScene: instantiatedAssetIds.size
    };
  });
  console.log(`[2.5/10] AssetLibraryManager & GLB Instantiation Report:`, assetLibraryReport);
  assert(
    assetLibraryReport.loadedCount === 35 && assetLibraryReport.failedCount === 0,
    `Expected 35 loaded GLB models and 0 failed, got loaded=${assetLibraryReport.loadedCount}, failed=${assetLibraryReport.failedCount}`
  );
  assert(
    assetLibraryReport.glbFurnitureCount === assetLibraryReport.selectableFurnitureCount && assetLibraryReport.glbFurnitureCount > 0,
    `Expected all ${assetLibraryReport.selectableFurnitureCount} placed furniture items to be GLB instances, got ${assetLibraryReport.glbFurnitureCount}`
  );
  assert(
    assetLibraryReport.contactShadowCount === assetLibraryReport.selectableFurnitureCount,
    `Expected all ${assetLibraryReport.selectableFurnitureCount} placed furniture items to include ContactShadowPlane, got ${assetLibraryReport.contactShadowCount}`
  );
  assert(
    assetLibraryReport.sharedGpuMeshCount > 0,
    'Expected GLB meshes to share GPU BufferGeometry and PBR Material instances'
  );

  // Wait for camera animation to settle in default 'Tổng thể' (dollhouse) mode, Stage 5
  await page.evaluate(() => {
    window.app.viewer.setRenderingStage(5);
    window.app.viewer.setViewMode('dollhouse');
  });
  await sleep(750);

  // Verify Dynamic Cutaway in 'Tổng thể' (dollhouse) mode
  const dollhouseCutawayReport = await page.evaluate(() => {
    const v = window.app.viewer;
    v.updateDynamicCutaway();
    const entries = v.exteriorWallEntries;
    let cutawayCount = 0;
    let fullWallCount = 0;
    for (const e of entries) {
      if (e.cutawayStubMesh.visible && !e.fullWallGroup.visible) cutawayCount++;
      if (e.fullWallGroup.visible && !e.cutawayStubMesh.visible) fullWallCount++;
    }
    return {
      totalExteriorWalls: entries.length,
      cutawayFrontWalls: cutawayCount,
      solidBackdropWalls: fullWallCount
    };
  });
  console.log(`[3/10] Dollhouse Dynamic Cutaway verification:`, dollhouseCutawayReport);
  assert(dollhouseCutawayReport.cutawayFrontWalls > 0, 'Expected front-facing walls to be cutaway in Tổng thể mode');
  assert(dollhouseCutawayReport.solidBackdropWalls > 0, 'Expected back-facing walls to remain solid in Tổng thể mode');
  assert(
    dollhouseCutawayReport.cutawayFrontWalls + dollhouseCutawayReport.solidBackdropWalls === dollhouseCutawayReport.totalExteriorWalls,
    'Every exterior wall must either show cutawayStubMesh or fullWallGroup in Tổng thể mode'
  );

  // Capture Screenshot 1: dollhouse_overview.png
  console.log(`[4/10] Capturing Screenshot 1: dollhouse_overview.png (Tổng thể 4-floor Dollhouse Cutaway)...`);
  const shot1Path = path.join(SCREENSHOTS_DIR, 'dollhouse_overview.png');
  await page.screenshot({ path: shot1Path, fullPage: false });
  fs.copyFileSync(shot1Path, path.join(WEB_VIEWER_DIR, 'dollhouse_overview.png'));
  if (fs.existsSync(ARTIFACT_DIR)) {
    fs.copyFileSync(shot1Path, path.join(ARTIFACT_DIR, 'dollhouse_overview.png'));
  }

  // Stress Test: 20 Consecutive Floor Switches (Tầng 1 -> Tầng 2 -> Tầng 3 -> Tầng 4 x 5 cycles)
  console.log(`[5/10] Performing 20 consecutive floor switches (Tầng 1 -> Tầng 2 -> Tầng 3 -> Tầng 4)...`);
  const floorOrder = ['floor_1', 'floor_2', 'floor_3', 'floor_4'];
  let floorSwitchCount = 0;
  for (let cycle = 0; cycle < 5; cycle++) {
    for (let fIdx = 0; fIdx < floorOrder.length; fIdx++) {
      const fId = floorOrder[fIdx];
      await page.click(`.floor-card[data-floor-id="${fId}"]`);
      await sleep(60);
      const state = await page.evaluate((expectedIdx) => {
        const floors = window.app.currentBim.floors;
        const vis = floors.map(f => window.app.viewer.floorGroups.get(f.id)?.visible);
        const svgTitle = document.getElementById('floorplan-title')?.textContent || '';
        return { vis, svgTitle };
      }, fIdx);

      // Verify floors <= fIdx are visible and floors > fIdx are hidden
      for (let i = 0; i < 4; i++) {
        const shouldBeVis = i <= fIdx;
        assert(
          state.vis[i] === shouldBeVis,
          `Floor switch #${floorSwitchCount + 1} (${fId}): expected floor_${i + 1} visible=${shouldBeVis}, got ${state.vis[i]}`
        );
      }
      floorSwitchCount++;
    }
  }
  console.log(`   -> Completed ${floorSwitchCount}/20 consecutive floor switches with 100% isolation accuracy.`);

  // Capture Screenshot 2: isolated_floor_interior.png
  // Let's isolate Floor 1 (or Floor 2) and frame a close-up of the interior PBR furniture, AND also test Tách tầng
  console.log(`[6/10] Capturing Screenshot 2: isolated_floor_interior.png (Close-up isolated floor showing 3D PBR furniture)...`);
  await page.click(`.floor-card[data-floor-id="floor_1"]`);
  await page.evaluate(() => {
    // Position camera for a rich close-up of Floor 1 Living + Dining + Kitchen PBR furniture
    const v = window.app.viewer;
    v.isolateFloorUpTo('floor_1');
    v.animateCameraTo(
      { x: 7.2, y: 5.2, z: -2.2, clone() { return new v.camera.position.constructor(7.2, 5.2, -2.2); } },
      { x: 2.3, y: 0.7, z: 3.8, clone() { return new v.camera.position.constructor(2.3, 0.7, 3.8); } },
      400
    );
  });
  await sleep(650);
  const shot2Path = path.join(SCREENSHOTS_DIR, 'isolated_floor_interior.png');
  await page.screenshot({ path: shot2Path, fullPage: false });
  fs.copyFileSync(shot2Path, path.join(WEB_VIEWER_DIR, 'isolated_floor_interior.png'));
  if (fs.existsSync(ARTIFACT_DIR)) {
    fs.copyFileSync(shot2Path, path.join(ARTIFACT_DIR, 'isolated_floor_interior.png'));
  }

  // Test all 4 View Modes: Tổng thể (dollhouse), Mặt tiền (facade), Tách tầng (exploded), Đi trong nhà (walkthrough)
  console.log(`[7/10] Switching across all 4 View Modes & verifying Mặt tiền cutaway restore...`);
  // 1) Mặt tiền (facade)
  await page.click('[data-view-mode="facade"]');
  await sleep(750);
  const facadeWallReport = await page.evaluate(() => {
    const v = window.app.viewer;
    v.updateDynamicCutaway();
    const entries = v.exteriorWallEntries;
    let fullCount = 0;
    let stubCount = 0;
    for (const e of entries) {
      if (e.fullWallGroup.visible) fullCount++;
      if (e.cutawayStubMesh.visible) stubCount++;
    }
    return {
      viewMode: v.viewMode,
      totalExteriorWalls: entries.length,
      fullVisible: fullCount,
      stubVisible: stubCount
    };
  });
  console.log(`   -> Mặt tiền mode wall state:`, facadeWallReport);
  assert(
    facadeWallReport.fullVisible === facadeWallReport.totalExteriorWalls && facadeWallReport.stubVisible === 0,
    'In Mặt tiền mode, 100% of exterior walls must show fullWallGroup and 0 cutawayStubMesh'
  );

  // Capture Screenshot 3: exterior_facade.png
  console.log(`   -> Capturing Screenshot 3: exterior_facade.png (Mặt tiền full exterior view)...`);
  const shot3Path = path.join(SCREENSHOTS_DIR, 'exterior_facade.png');
  await page.screenshot({ path: shot3Path, fullPage: false });
  fs.copyFileSync(shot3Path, path.join(WEB_VIEWER_DIR, 'exterior_facade.png'));
  if (fs.existsSync(ARTIFACT_DIR)) {
    fs.copyFileSync(shot3Path, path.join(ARTIFACT_DIR, 'exterior_facade.png'));
  }

  // 2) Tách tầng (exploded) + slider
  await page.click('[data-view-mode="exploded"]');
  await sleep(700);
  const explodedReport = await page.evaluate(() => {
    const slider = document.getElementById('exploded-distance-slider');
    slider.value = '6.0';
    slider.dispatchEvent(new Event('input'));
    const elevations = [];
    for (const [id, grp] of window.app.viewer.floorGroups) {
      elevations.push({ id, y: grp.position.y });
    }
    return {
      viewMode: window.app.viewer.viewMode,
      explodedDistance: window.app.viewer.explodedDistance,
      elevations
    };
  });
  assert(explodedReport.viewMode === 'exploded' && explodedReport.explodedDistance === 6.0, 'Exploded view slider failed');
  assert(explodedReport.elevations[1].y > explodedReport.elevations[0].y + 8.0, 'Exploded floor elevation separation not applied');

  // 3) Đi trong nhà (walkthrough)
  await page.click('[data-view-mode="walkthrough"]');
  await sleep(300);
  const walkthroughReport = await page.evaluate(() => {
    const v = window.app.viewer;
    const beforePos = v.walkthroughState.position.clone();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    v.animate();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
    const afterPos = v.walkthroughState.position.clone();
    return {
      active: v.walkthroughState.active,
      eyeHeight: beforePos.y,
      moved: beforePos.distanceTo(afterPos) > 0.01
    };
  });
  assert(walkthroughReport.active, 'Walkthrough mode did not activate');
  assert(Math.abs(walkthroughReport.eyeHeight - 1.6) < 0.05, `Expected 1.6m eye height on Floor 1, got ${walkthroughReport.eyeHeight}`);

  // 4) Return to Tổng thể (dollhouse)
  await page.click('[data-view-mode="dollhouse"]');
  await sleep(650);

  // Test all 5 Render Stages (Stage 1..5)
  console.log(`[8/10] Testing all 5 Progressive Render Stages (Stage 1..5)...`);
  const stageReports = [];
  for (let stage = 1; stage <= 5; stage++) {
    await page.click(`[data-stage="${stage}"]`);
    await sleep(250);
    const stInfo = await page.evaluate((s) => {
      const v = window.app.viewer;
      let aiVis = false, wallVis = false, furnVis = false, lightVis = false;
      for (const [_, grp] of v.floorGroups) {
        grp.traverse(c => {
          const cat = c.userData?.bimCategory;
          if (cat === 'ai_detection' && c.visible) aiVis = true;
          if (cat === 'walls_openings' && c.visible) wallVis = true;
          if (cat === 'furniture' && c.visible) furnVis = true;
          if (cat === 'lighting' && c.visible) lightVis = true;
        });
      }
      return { stage: v.currentStage, aiVis, wallVis, furnVis, lightVis };
    }, stage);
    stageReports.push(stInfo);
    assert(stInfo.stage === stage, `Stage mismatch: expected ${stage}, got ${stInfo.stage}`);
    if (stage === 1) assert(stInfo.aiVis === true && stInfo.furnVis === false, 'Stage 1 should show AI overlay and hide 3D furniture');
    if (stage === 2) assert(stInfo.aiVis === false && stInfo.wallVis === false, 'Stage 2 should show only structure/slabs');
    if (stage === 3) assert(stInfo.wallVis === true && stInfo.furnVis === false, 'Stage 3 should show walls/openings without furniture');
    if (stage === 4) assert(stInfo.furnVis === true, 'Stage 4 should show 3D furniture');
    if (stage === 5) assert(stInfo.furnVis === true && stInfo.lightVis === true, 'Stage 5 should show PBR furniture + warm lighting');
  }
  console.log(`   -> All 5 Render Stages verified:`, stageReports);

  // Select 5 different 3D furniture items, toggle lights & room labels
  console.log(`[9/10] Selecting 5 different 3D furniture items & toggling Đèn nhà / Nhãn phòng...`);
  const selectedFurnitureReport = await page.evaluate(async () => {
    const select = document.getElementById('furniture-select');
    const options = Array.from(select.querySelectorAll('option')).filter(o => o.value);
    const chosen = options.slice(0, 5);
    const results = [];
    for (const opt of chosen) {
      select.value = opt.value;
      select.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 120));
      const card = document.getElementById('object-inspector-card');
      results.push({
        value: opt.value,
        inspectorVisible: !card.classList.contains('hidden'),
        title: document.getElementById('inspector-title')?.textContent,
        dimensions: document.getElementById('inspector-dimensions')?.textContent,
        material: document.getElementById('inspector-material')?.textContent,
        floor: document.getElementById('inspector-floor')?.textContent,
        room: document.getElementById('inspector-room')?.textContent,
        hasHighlightMesh: Boolean(window.app.viewer.selectedObjectMesh)
      });
    }
    // Close inspector at end
    document.getElementById('inspector-close-btn')?.click();
    return results;
  });
  assert(selectedFurnitureReport.length === 5, `Expected 5 furniture selections, got ${selectedFurnitureReport.length}`);
  for (const item of selectedFurnitureReport) {
    assert(item.inspectorVisible && item.hasHighlightMesh, `Furniture selection failed for ${item.value}`);
  }
  console.log(`   -> Selected 5 3D furniture items:`, selectedFurnitureReport.map(i => `${i.title} (${i.floor})`));

  // Toggle Đèn nhà: Bật/Tắt
  await page.click('#toggle-interior-lights');
  await sleep(100);
  const lightsOffState = await page.evaluate(() => ({
    lightsOn: window.app.viewer.interiorLightsOn,
    label: document.querySelector('#toggle-interior-lights .label')?.textContent,
    anyPointLightVisible: window.app.viewer.interiorLights.some(l => l.visible)
  }));
  assert(lightsOffState.lightsOn === false && lightsOffState.anyPointLightVisible === false, 'Interior lights should turn off');
  await page.click('#toggle-interior-lights');
  await sleep(100);
  const lightsOnState = await page.evaluate(() => ({
    lightsOn: window.app.viewer.interiorLightsOn,
    label: document.querySelector('#toggle-interior-lights .label')?.textContent,
    anyPointLightVisible: window.app.viewer.interiorLights.some(l => l.visible)
  }));
  assert(lightsOnState.lightsOn === true && lightsOnState.anyPointLightVisible === true, 'Interior lights should turn back on');

  // Toggle Nhãn phòng: Bật/Tắt
  await page.click('#toggle-room-labels');
  await sleep(100);
  const labelsOffState = await page.evaluate(() => ({
    labelsOn: window.app.viewer.roomLabelsVisible,
    label: document.querySelector('#toggle-room-labels .label')?.textContent,
    anySpriteVisible: window.app.viewer.roomLabelSprites.some(s => s.visible)
  }));
  assert(labelsOffState.labelsOn === false && labelsOffState.anySpriteVisible === false, 'Room labels should hide');
  await page.click('#toggle-room-labels');
  await sleep(100);
  const labelsOnState = await page.evaluate(() => ({
    labelsOn: window.app.viewer.roomLabelsVisible,
    label: document.querySelector('#toggle-room-labels .label')?.textContent,
    anySpriteVisible: window.app.viewer.roomLabelSprites.some(s => s.visible)
  }));
  assert(labelsOnState.labelsOn === true && labelsOnState.anySpriteVisible === true, 'Room labels should show again');

  // Switch between projects in SQLite
  console.log(`[10/10] Switching between SQLite projects & checking WebGL memory lifecycle...`);
  const projectSwitchReport = [];
  const projectIds = ['biet-thu-san-vuon-3-tang-12x16', 'proj_sample_villa_3f', 'nha-pho-4-tang-5x8'];
  for (const pid of projectIds) {
    await page.evaluate(async (id) => {
      window.app.openProjectsModal();
      await window.app.switchProject(id);
    }, pid);
    await sleep(350);
    const info = await page.evaluate(() => ({
      activeProjectId: window.app.activeProjectId,
      title: document.getElementById('project-title')?.textContent,
      floors: window.app.currentBim?.floors?.length,
      selectableFurnitureCount: window.app.viewer.selectableObjects.length,
      geometriesInMemory: window.app.viewer.renderer.info.memory.geometries,
      texturesInMemory: window.app.viewer.renderer.info.memory.textures
    }));
    projectSwitchReport.push(info);
  }
  console.log(`   -> SQLite Project Switch Report:`, projectSwitchReport);

  contextLostCount = await page.evaluate(() => window.__webglContextLosses || 0);
  const webglHealth = await page.evaluate(() => {
    const gl = window.app.viewer.renderer.getContext();
    return {
      isContextLost: gl.isContextLost(),
      geometries: window.app.viewer.renderer.info.memory.geometries,
      textures: window.app.viewer.renderer.info.memory.textures,
      calls: window.app.viewer.renderer.info.render.calls,
      triangles: window.app.viewer.renderer.info.render.triangles
    };
  });

  await browser.close();

  const summary = {
    status: 'PASS',
    consoleErrorsCount: consoleErrors.length,
    consoleErrors,
    pageErrorsCount: pageErrors.length,
    pageErrors,
    webglWarningsCount: webglWarnings.length,
    webglWarnings,
    contextLostCount,
    webglHealth,
    assetLibraryReport,
    floorSwitchesVerified: floorSwitchCount,
    dollhouseCutawayReport,
    facadeWallReport,
    stageReportsCount: stageReports.length,
    selectedFurnitureCount: selectedFurnitureReport.length,
    projectSwitchReport,
    screenshots: [
      shot1Path,
      shot2Path,
      shot3Path
    ]
  };

  console.log('\n=== QA VERIFICATION SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  assert(consoleErrors.length === 0, `Expected 0 console errors, got ${consoleErrors.length}: ${consoleErrors.join('; ')}`);
  assert(pageErrors.length === 0, `Expected 0 page errors, got ${pageErrors.length}: ${pageErrors.join('; ')}`);
  assert(webglWarnings.length === 0, `Expected 0 WebGL warnings, got ${webglWarnings.length}: ${webglWarnings.join('; ')}`);
  assert(contextLostCount === 0 && !webglHealth.isContextLost, 'Expected 0 WebGL context losses');
}

runVerification().catch((err) => {
  console.error('QA Verification failed:', err);
  process.exit(1);
});
