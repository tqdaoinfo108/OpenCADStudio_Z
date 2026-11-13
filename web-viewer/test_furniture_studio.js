/**
 * test_furniture_studio.js
 * Verification test suite for Modular 3D Asset Studio & Inspector Redesign
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebViewerServer } from './server/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function makeRequest(port, method, reqPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runStudioTests() {
  console.log('=== STARTING FURNITURE STUDIO & 3D INSPECTOR VERIFICATION ===\n');

  // TEST 1: Validate HTML Structure for 3-Column Studio Layout
  console.log('1. Validating 3-Column Studio HTML Structure in index.html...');
  const htmlPath = path.join(__dirname, 'index.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

  // Check 3 Columns
  assert.ok(htmlContent.includes('id="modal-furniture-store"'), 'Must contain #modal-furniture-store');
  assert.ok(htmlContent.includes('id="furniture-studio-sidebar"'), 'Must contain Column 1: #furniture-studio-sidebar');
  assert.ok(htmlContent.includes('id="furniture-studio-center"'), 'Must contain Column 2: #furniture-studio-center');
  assert.ok(htmlContent.includes('id="furniture-studio-inspector"'), 'Must contain Column 3: #furniture-studio-inspector');

  // Check Sidebar Stats & Filters
  assert.ok(htmlContent.includes('id="stat-total-assets"'), 'Sidebar must have #stat-total-assets');
  assert.ok(htmlContent.includes('id="count-type-model"'), 'Sidebar must have #count-type-model');
  assert.ok(htmlContent.includes('id="count-type-real"'), 'Sidebar must have #count-type-real');
  assert.ok(htmlContent.includes('id="furniture-store-search"'), 'Sidebar must have search input');
  assert.ok(htmlContent.includes('id="store-category-list"'), 'Sidebar must have vertical category filter list');
  assert.ok(htmlContent.includes('id="store-placement-list"'), 'Sidebar must have AI mount type filter list');
  assert.ok(htmlContent.includes('cat-count-living'), 'Category filter must have dynamic count badges');
  assert.ok(htmlContent.includes('mount-count-floor_wall_backed'), 'Placement filter must have dynamic count badges');

  // Check Center Grid
  assert.ok(htmlContent.includes('id="furniture-store-grid"'), 'Center must contain #furniture-store-grid');
  assert.ok(htmlContent.includes('id="furniture-store-sort"'), 'Center must contain #furniture-store-sort');

  // Check Right 3D Live Inspector & Normalizer
  assert.ok(htmlContent.includes('id="turntable-canvas"'), 'Inspector must have #turntable-canvas');
  assert.ok(htmlContent.includes('id="btn-norm-rotate-90"'), 'Inspector must have 1-Click Rotate 90° button');
  assert.ok(htmlContent.includes('id="btn-norm-snap-pivot"'), 'Inspector must have 1-Click Snap Pivot button');
  assert.ok(htmlContent.includes('id="btn-norm-measure"'), 'Inspector must have 1-Click Auto-Measure button');
  assert.ok(htmlContent.includes('id="btn-norm-snap-thumb"'), 'Inspector must have 1-Click Capture Thumbnail button');
  assert.ok(htmlContent.includes('id="btn-norm-save-glb"'), 'Inspector must have 1-Click Export GLB button');
  assert.ok(htmlContent.includes('id="form-inspector-edit"'), 'Inspector must have Metadata Edit Form');
  assert.ok(htmlContent.includes('id="inspector-dropzone"'), 'Inspector must have Drag & Drop Ingest Zone');
  console.log('   ✓ All 3-Column Studio layout elements confirmed in index.html!');

  // TEST 2: Validate CSS Rules in style.css
  console.log('\n2. Validating CSS Styles for 3-Column Studio in style.css...');
  const cssPath = path.join(__dirname, 'css', 'style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

  assert.ok(cssContent.includes('.modal-furniture-studio-content'), 'Must define .modal-furniture-studio-content');
  assert.ok(cssContent.includes('.modal-furniture-studio-body'), 'Must define .modal-furniture-studio-body');
  assert.ok(cssContent.includes('.store-studio-sidebar'), 'Must define .store-studio-sidebar');
  assert.ok(cssContent.includes('.store-studio-center'), 'Must define .store-studio-center');
  assert.ok(cssContent.includes('.store-studio-inspector'), 'Must define .store-studio-inspector');
  assert.ok(cssContent.includes('.polycount-badge'), 'Must define .polycount-badge');
  assert.ok(cssContent.includes('.active-inspected'), 'Must define .active-inspected');
  assert.ok(cssContent.includes('.turntable-canvas-container'), 'Must define .turntable-canvas-container');
  assert.ok(cssContent.includes('.normalizer-suite'), 'Must define .normalizer-suite');
  assert.ok(cssContent.includes('.btn-normalizer'), 'Must define .btn-normalizer');
  console.log('   ✓ All 3-Column Studio CSS styles confirmed in style.css!');

  // TEST 3: Validate JS Architecture in furniture_store_modal.js
  console.log('\n3. Validating JS Module Architecture in furniture_store_modal.js...');
  const jsPath = path.join(__dirname, 'js', 'furniture_store_modal.js');
  const jsContent = fs.readFileSync(jsPath, 'utf-8');

  assert.ok(jsContent.includes('class FurnitureStoreModal'), 'Must export FurnitureStoreModal');
  assert.ok(jsContent.includes('initTurntable'), 'Must have initTurntable method');
  assert.ok(jsContent.includes('inspectAsset'), 'Must have inspectAsset method');
  assert.ok(jsContent.includes('normalizeRotate90'), 'Must have normalizeRotate90 method');
  assert.ok(jsContent.includes('normalizeSnapPivot'), 'Must have normalizeSnapPivot method');
  assert.ok(jsContent.includes('normalizeAutoMeasure'), 'Must have normalizeAutoMeasure method');
  assert.ok(jsContent.includes('normalizeCaptureThumbnail'), 'Must have normalizeCaptureThumbnail method');
  assert.ok(jsContent.includes('normalizeExportGlb'), 'Must have normalizeExportGlb method');
  assert.ok(jsContent.includes('handleInspectorSave'), 'Must have handleInspectorSave method');
  assert.ok(jsContent.includes('handleGlbFileDrop'), 'Must have handleGlbFileDrop method');
  assert.ok(jsContent.includes('updateFilterCounts'), 'Must have updateFilterCounts method');
  console.log('   ✓ All core Studio & Inspector methods verified in furniture_store_modal.js!');

  // TEST 4: Backend API & SQLite Persistence Verification
  console.log('\n4. Testing Backend API & SQLite Persistence for Furniture Studio...');
  const testPort = 49450;
  const server = new WebViewerServer({ port: testPort });
  await server.start();
  console.log(`   ✓ WebViewerServer listening on port ${testPort}`);

  try {
    // 4.1 GET /api/furniture-assets?type=all
    const getRes = await makeRequest(testPort, 'GET', '/api/furniture-assets?type=all');
    assert.strictEqual(getRes.status, 200, 'GET /api/furniture-assets should return 200');
    const assets = getRes.body.data || getRes.body.assets || [];
    assert.ok(assets.length > 20, `Catalog should have pre-seeded items (found ${assets.length})`);
    console.log(`   ✓ Retrieved ${assets.length} items from SQLite catalog`);

    // 4.2 POST /api/furniture-assets (Direct Form Edit / Upsert)
    const targetAsset = assets[0];
    const updatedName = `${targetAsset.name} [Đã Hiệu Chuẩn]`;
    const editPayload = {
      name: updatedName,
      asset_id: targetAsset.asset_id,
      category: targetAsset.category || 'living',
      asset_type: targetAsset.asset_type || 'model',
      placement_type: 'floor_wall_backed',
      dimensions: { width: 2.45, depth: 1.15, height: 0.88 },
      tags: ['studio_tested', 'calibrated'],
      thumbnail_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      is_builtin: 1
    };

    const updateRes = await makeRequest(testPort, 'POST', '/api/furniture-assets', editPayload);
    assert.strictEqual(updateRes.status, 201, 'POST /api/furniture-assets update should return 201');
    console.log(`   ✓ Direct Metadata Update saved to SQLite for asset: "${targetAsset.asset_id}"`);

    // 4.3 Verify persistence by re-fetching
    const verifyRes = await makeRequest(testPort, 'GET', `/api/furniture-assets?search=${encodeURIComponent(targetAsset.asset_id)}`);
    const foundItems = verifyRes.body.data || [];
    const saved = foundItems.find(i => i.asset_id === targetAsset.asset_id);
    assert.ok(saved, 'Updated asset should be found in SQLite');
    assert.strictEqual(saved.name, updatedName, 'Saved name must match updated name');
    assert.strictEqual(saved.dimensions.width, 2.45, 'Saved width must match 2.45');
    assert.strictEqual(saved.dimensions.depth, 1.15, 'Saved depth must match 1.15');
    console.log(`   ✓ SQLite persistence confirmed: name="${saved.name}", W=${saved.dimensions.width}m, D=${saved.dimensions.depth}m`);

    // 4.4 Ingest new custom asset (simulating .glb drag & drop)
    const newCustomAsset = {
      name: 'Bàn Trà Studio Gỗ Sồi Calibrated',
      asset_id: 'custom_studio_oak_table_test',
      category: 'living',
      asset_type: 'model',
      placement_type: 'floor_center',
      dimensions: { width: 1.20, depth: 0.60, height: 0.45 },
      tags: ['oak', 'minimalist', 'studio_test'],
      glb_path: '/assets/models/custom/custom_studio_oak_table_test.glb',
      is_builtin: 0
    };

    const createRes = await makeRequest(testPort, 'POST', '/api/furniture-assets', newCustomAsset);
    assert.strictEqual(createRes.status, 201, 'POST /api/furniture-assets should return 201 for new asset');
    console.log(`   ✓ Ingested new custom asset: "${newCustomAsset.name}"`);

    // 4.5 Clean up created test asset
    const delRes = await makeRequest(testPort, 'DELETE', `/api/furniture-assets/${newCustomAsset.asset_id}`);
    assert.strictEqual(delRes.status, 200, 'DELETE should return 200');
    console.log(`   ✓ Cleaned up test custom asset "${newCustomAsset.asset_id}"`);

  } finally {
    await server.stop();
    console.log('   ✓ WebViewerServer stopped cleanly.');
  }

  console.log('\n=== ALL FURNITURE STUDIO & 3D INSPECTOR VERIFICATION TESTS PASSED! ===');
}

runStudioTests().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
