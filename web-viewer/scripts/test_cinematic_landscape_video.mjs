/**
 * test_cinematic_landscape_video.mjs
 * Comprehensive Verification Suite for Step 2 Deliverables:
 * 1. Unit Tests for CinematicTourDirector, VideoExporter, HUD Canvas Compositor
 * 2. Headless Chrome Playwright E2E Verification of:
 *    - Architectural Landscape Context (sidewalk, stepping stones, slatted fence, gate, palms, cypresses, shrubs, warm sky)
 *    - Cinematic Camera Tracks (4 scenarios, dynamic targets, stages)
 *    - Live Tour Playback & Floating HUD Overlay
 *    - Video Exporter Modal & High-Res Screenshots
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { CINEMATIC_SCENARIOS, CinematicTourDirector } from '../js/cinematic_tour_director.js';
import { VideoExporter } from '../js/video_exporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = process.env.VIEWER_SCREENSHOTS || path.join(ROOT, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const PLAYWRIGHT_PATH = 'file:///C:/Users/qdaoc/AppData/Local/npm-cache/_npx/9b9809298fe40d2c/node_modules/playwright-core/index.mjs';
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE_URL = process.env.VIEWER_URL || 'http://localhost:3000';

console.log('=================================================================');
console.log('🧪 STEP 2 VERIFICATION: CINEMATIC LANDSCAPE & VIDEO EXPORTER');
console.log('=================================================================');

let passedTests = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// =========================================================================
// PART 1: PURE UNIT TESTS (Node.js)
// =========================================================================
console.log('\n--- Part 1: Pure Unit Tests (Camera Tracks, Exporter & Compositor) ---');

// Mock Viewer for Node.js
class MockViewer {
  constructor() {
    this.camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100);
    this.controls = {
      target: new THREE.Vector3(),
      update: () => {},
      enabled: true
    };
    this.walkthroughState = { active: false };
    this.floorGroups = new Map();
    this.viewMode = 'dollhouse';
    this.explodedDistance = 0;
    this.interiorLightsOn = true;
    this.activeFloorId = 'floor_1';
    this._cutawayDirty = false;
    this._needsRender = false;
    this.bimData = {
      metadata: { lot_width: 15, lot_length: 24, title: 'Biệt Thự Hiện Đại', code: 'NN-2026-BT08' },
      floors: [
        { id: 'floor_1', name: 'Tầng 1', elevation: 0, height: 3.9, desc: 'Phòng khách & Bếp' },
        { id: 'floor_2', name: 'Tầng 2', elevation: 3.9, height: 3.6, desc: 'Phòng ngủ Master' },
        { id: 'floor_tum', name: 'Tầng Tum', elevation: 7.5, height: 3.2, desc: 'Phòng thờ & BBQ' }
      ]
    };
  }
  getBuildingCenterAndSpan() {
    return {
      cx: 7.5,
      cy: 12.0,
      maxDim: 18.0,
      totalHeight: 11.0,
      minX: 1.5,
      maxX: 13.5,
      minY: 4.5,
      maxY: 20.5
    };
  }
  setViewMode(m) { this.viewMode = m; }
  setExplodedDistance(d) { this.explodedDistance = d; }
  setInteriorLights(l) { this.interiorLightsOn = l; }
  isolateFloorUpTo(fid) { this.activeFloorId = fid; }
  showAllFloors() {}
  invalidate() {}
}

const mockViewer = new MockViewer();
const director = new CinematicTourDirector(mockViewer, { duration: 30 });

test('CinematicTourDirector exposes 4 registered scenarios', () => {
  const scenarios = director.getScenarios();
  assert.strictEqual(scenarios.length, 4);
  const ids = scenarios.map(s => s.id);
  assert(ids.includes('full_film'));
  assert(ids.includes('turntable'));
  assert(ids.includes('interior_walkthrough'));
  assert(ids.includes('floor_by_floor'));
});

test('Full tour plays the exterior, dollhouse and all floors on a continuous safe track', () => {
  director.setScenario('full_film', 30);
  assert.deepStrictEqual(director.scenarioStages.map(stage => stage.id),
    ['exterior_landscape', 'dollhouse', 'floor_1', 'floor_2', 'floor_tum']);
  const { minX, maxX, minY, maxY } = mockViewer.getBuildingCenterAndSpan();
  for (let i = 0; i <= 1000; i++) {
    const position = director.positionCurve.getPointAt(i / 1000);
    assert([position.x, position.y, position.z].every(Number.isFinite));
    assert(position.x < minX || position.x > maxX || position.z < minY - 1.12 || position.z > maxY);
  }
  for (const stage of director.scenarioStages.slice(1)) {
    const before = director.positionCurve.getPointAt(stage.uStart - 1e-7);
    const after = director.positionCurve.getPointAt(stage.uStart);
    assert(before.distanceTo(after) < 1e-4);
  }
  assert.strictEqual(director.seek(0.05).stageId, 'exterior_landscape');
  const overview = director.scenarioStages[1];
  director.seek((overview.uStart + overview.uEnd) / 2);
  assert.strictEqual(mockViewer.viewMode, 'dollhouse');
});

test('Turntable completes its exterior orbit before lifting to the dollhouse', () => {
  director.setScenario('turntable', 30);
  const endOfOrbit = director.scenarioStages[0].uEnd;
  const first = director.positionCurve.getPointAt(0);
  const last = director.positionCurve.getPointAt(endOfOrbit);
  assert(first.distanceTo(last) < 1e-6);
  assert.strictEqual(director.seek(1).stageId, 'dollhouse');
});

for (const scenario of ['interior_walkthrough', 'floor_by_floor']) {
  test(scenario + ' isolates each floor sequentially and enables house lights', () => {
    director.setScenario(scenario, 30);
    assert.deepStrictEqual(director.scenarioStages.map(stage => stage.id),
      ['floor_1', 'floor_2', 'floor_tum']);
    for (const stage of director.scenarioStages) {
      director.seek((stage.uStart + stage.uEnd) / 2);
      assert.strictEqual(mockViewer.activeFloorId, stage.id);
      assert.strictEqual(mockViewer.interiorLightsOn, true);
    }
  });
}

test('Stopping a live tour leaves its exact camera position and target with orbit controls', () => {
  director.start('full_film', 30);
  assert.strictEqual(mockViewer.controls.enabled, false);
  director.seek(0.4);
  const position = mockViewer.camera.position.clone();
  const target = mockViewer.controls.target.clone();
  director.stop();
  assert.strictEqual(mockViewer.controls.enabled, true);
  assert(mockViewer.camera.position.equals(position));
  assert(mockViewer.controls.target.equals(target));
});

test('VideoExporter initializes with options & settings', () => {
  const exporter = new VideoExporter({
    viewer: mockViewer,
    director,
    getProjectMeta: () => ({ title: 'Biệt Thự Hiện Đại 2 Tầng 1 Tum', code: 'NN-2026-BT08' })
  });

  assert.strictEqual(exporter.scenarioId, 'full_film');
  assert.strictEqual(exporter.aspectRatio, '16:9');
  assert.strictEqual(exporter.duration, 30);
  assert.strictEqual(exporter.bitrate, 12000000);
});

test('Direct Canvas HUD Compositor renders 16:9 and 9:16 layout without errors', () => {
  const exporter = new VideoExporter({ viewer: mockViewer, director });
  const mockCtx = {
    save: () => {},
    restore: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    beginPath: () => {},
    roundRect: () => {},
    fill: () => {},
    stroke: () => {},
    fillRect: () => {},
    fillText: () => {},
    measureText: (txt) => ({ width: (txt || '').length * 8 })
  };

  const sampleInfo = {
    progress: 0.5,
    timeSec: 15,
    duration: 30,
    badge: '🎬 NGOẠI THẤT',
    caption: 'Cảnh Quan Ngoại Thất',
    subCaption: 'Sân vườn đá bước dạo',
    floorName: 'Tầng 1',
    roomName: 'Sân Trước'
  };

  assert.doesNotThrow(() => exporter.drawCinematicHUD(mockCtx, 1920, 1080, sampleInfo, { title: 'Dự án A', code: 'NN-01' }));
  assert.doesNotThrow(() => exporter.drawCinematicHUD(mockCtx, 1080, 1920, sampleInfo, { title: 'Dự án A', code: 'NN-01' }));
});

// =========================================================================
// PART 2: LIVE HEADLESS CHROME PLAYWRIGHT E2E VERIFICATION
// =========================================================================
console.log('\n--- Part 2: Headless Chrome Playwright E2E Verification ---');

async function runPlaywrightVerification() {
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

  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  const jsRuntimeErrors = [];
  page.on('console', msg => {
    console.log('    [BROWSER]', msg.type(), msg.text());
  });
  page.on('pageerror', err => {
    console.error('    [PAGE ERROR]', err.message);
    jsRuntimeErrors.push(err.message);
  });
  page.on('response', res => {
    const url = res.url();
    const contentType = res.headers()['content-type'] || '';
    if (url.endsWith('.js') && contentType.includes('text/html')) {
      console.log('    [JS GOT HTML!]', res.status(), url);
    }
  });

  console.log(`  🌐 Navigating to ${BASE_URL}...`);
  await page.goto(`${BASE_URL}/?project=proj_sample_villa_3f`, { waitUntil: 'networkidle', timeout: 20000 });

  await page.waitForSelector('#viewport-container canvas', { timeout: 10000 });
  await page.waitForTimeout(1000);

  // 1. Verify 3D Landscape Meshes in Live Viewport
  const landscapeReport = await page.evaluate(() => {
    const app = window.app || window.__app;
    const v = window.viewer3D || app?.viewer || window.viewer;
    if (!v || !v.siteGroup) {
      return { ok: false, error: 'Viewer or siteGroup not found' };
    }

    const children = v.siteGroup.children;

    // Check landscape elements
    const hasLawn = children.some(c => c.geometry?.type === 'BoxGeometry' && c.position.y < -0.05);
    const hasSidewalk = children.some(c => c.position.z < -1.0 && c.position.z > -4.0);
    const hasRoad = children.some(c => c.position.z < -4.0);
    const steppingStones = children.filter(c => c.material?.userData?.materialKey === 'steppingStone');
    const groups = children.filter(c => c.type === 'Group');

    return {
      ok: true,
      childrenCount: children.length,
      hasLawn,
      hasSidewalk,
      hasRoad,
      steppingStoneCount: steppingStones.length,
      plantAndFenceGroups: groups.length,
      warmAtmosphere: v.warmAtmosphereEnabled,
      bgColorHex: v.scene.background.getHexString()
    };
  });

  assert(landscapeReport.ok, `Landscape verification failed: ${landscapeReport.error}`);
  assert(landscapeReport.hasLawn, 'Grass lawn plinth must exist');
  assert(landscapeReport.hasSidewalk, 'Front sidewalk must exist');
  assert(landscapeReport.hasRoad, 'Asphalt road must exist');
  assert(landscapeReport.steppingStoneCount >= 8, `Expected >= 8 stepping stones, found ${landscapeReport.steppingStoneCount}`);
  assert(landscapeReport.plantAndFenceGroups >= 4, `Expected botanical and fence groups, found ${landscapeReport.plantAndFenceGroups}`);
  assert.strictEqual(landscapeReport.warmAtmosphere, true, 'Warm sky atmosphere should be enabled');
  console.log(`  ✅ PASS: Live 3D Landscape Context (${landscapeReport.childrenCount} objects, ${landscapeReport.steppingStoneCount} stepping stones, warm sky #${landscapeReport.bgColorHex})`);
  passedTests++;

  // Capture Screenshot of Landscape Context
  const landscapePath = path.join(SCREENSHOTS_DIR, 'cinematic_landscape_context.png');
  await page.screenshot({ path: landscapePath });
  console.log(`  📸 Captured landscape context: ${landscapePath}`);

  // 2. Test Opening Video Exporter Modal
  console.log('  🎬 Testing Video Exporter Modal...');
  await page.click('#btn-export-video');
  await page.waitForTimeout(400);

  const modalVisible = await page.evaluate(() => {
    const m = document.getElementById('modal-video-exporter');
    return m && !m.classList.contains('hidden');
  });
  assert(modalVisible, 'Modal #modal-video-exporter should be visible');
  console.log('  ✅ PASS: Video Exporter Modal opened successfully');
  passedTests++;

  // Capture Screenshot of Video Exporter Modal
  const modalPath = path.join(SCREENSHOTS_DIR, 'cinematic_video_modal.png');
  await page.screenshot({ path: modalPath });
  console.log(`  📸 Captured video exporter modal: ${modalPath}`);

  // 3. Test Selecting Scenarios and Aspect Ratio in Modal
  await page.evaluate(() => {
    // Select Walkthrough scenario
    const card = document.querySelector('.scenario-select-card[data-scenario="interior_walkthrough"]');
    if (card) card.click();
    // Select 9:16 vertical
    const ratioBtn = document.querySelector('.aspect-ratio-btn[data-ratio="9:16"]');
    if (ratioBtn) ratioBtn.click();
    // Select 15s duration
    const durBtn = document.querySelector('.duration-pill-btn[data-duration="15"]');
    if (durBtn) durBtn.click();
  });
  await page.waitForTimeout(300);

  const configState = await page.evaluate(() => {
    const exp = window.videoExporter;
    return {
      scenarioId: exp?.scenarioId,
      aspectRatio: exp?.aspectRatio,
      duration: exp?.duration
    };
  });
  assert.strictEqual(configState.scenarioId, 'interior_walkthrough');
  assert.strictEqual(configState.aspectRatio, '9:16');
  assert.strictEqual(configState.duration, 15);
  console.log('  ✅ PASS: UI controls update VideoExporter state (interior_walkthrough, 9:16, 15s)');
  passedTests++;

  // 4. Test Live Tour Playback & Floating HUD Overlay
  console.log('  ▶️ Testing Live Tour Playback & HUD Overlay...');
  await page.click('#btn-start-live-tour');
  await page.waitForTimeout(600);

  const liveHudState = await page.evaluate(() => {
    const hud = document.getElementById('cinematic-live-hud');
    const isVisible = hud && !hud.classList.contains('hidden');
    const badge = document.getElementById('live-hud-badge')?.textContent;
    const caption = document.getElementById('live-hud-caption')?.textContent;
    const isPlaying = window.videoExporter?.director?.isPlaying;
    return { isVisible, badge, caption, isPlaying };
  });

  assert(liveHudState.isVisible, 'Live HUD #cinematic-live-hud should be visible during tour');
  assert(liveHudState.isPlaying, 'Tour director should be actively playing');
  console.log(`  ✅ PASS: Live Tour Active with HUD (${liveHudState.badge}: "${liveHudState.caption}")`);
  passedTests++;

  // Capture Screenshot with Live HUD Overlay
  const hudPath = path.join(SCREENSHOTS_DIR, 'cinematic_tour_hud.png');
  await page.screenshot({ path: hudPath });
  console.log(`  📸 Captured live tour HUD: ${hudPath}`);

  // Test Exit Live Tour
  await page.click('#btn-live-hud-exit');
  await page.waitForTimeout(300);

  const isTourStopped = await page.evaluate(() => {
    return !window.videoExporter?.director?.isPlaying;
  });
  assert(isTourStopped, 'Tour should be stopped after exit click');
  console.log('  ✅ PASS: Live Tour stopped and returned control cleanly');
  passedTests++;

  // 5. Test Presentation Mode Toolbar Tour Button
  await page.click('#btn-presentation-mode');
  await page.waitForTimeout(400);

  assert.equal(await page.locator('#presentation-toolbar').count(), 0);
  await page.click('#btn-view-tour-3d');
  await page.waitForTimeout(500);

  const presTourPlaying = await page.evaluate(() => window.videoExporter?.director?.isPlaying);
  assert(presTourPlaying, 'Tour should start from presentation mode toolbar button');
  console.log('  ✅ PASS: Presentation Mode integration with Tour button verified');
  passedTests++;

  await page.click('#btn-live-hud-exit');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.app-header', { state: 'visible' });

  // Verify JavaScript runtime page errors
  assert.strictEqual(jsRuntimeErrors.length, 0, `Expected 0 JS runtime page errors, got ${jsRuntimeErrors.length}: ${jsRuntimeErrors.join('; ')}`);
  console.log('  ✅ PASS: Exactly 0 JavaScript page errors during full interactive session');
  passedTests++;

  await browser.close();
}

(process.argv.includes('--unit') ? Promise.resolve() : runPlaywrightVerification()).then(() => {
  console.log('\n=================================================================');
  console.log(`🎉 ALL ${passedTests} VERIFICATION TESTS PASSED SUCCESSFULLY!`);
  console.log('=================================================================\n');
  process.exit(0);
}).catch(err => {
  console.error('\n❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
