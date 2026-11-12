/**
 * test_e2e_verification.js
 * Comprehensive End-to-End Verification of SQLite Persistence, REST Endpoints, and AI Analysis.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebViewerServer } from './server/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeRequest(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: {
          'Connection': 'close',
          ...(postData
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
              }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : null;
            resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, raw });
          }
        });
      }
    );

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('=== STARTING END-TO-END VERIFICATION & PERSISTENCE TEST ===\n');

  const basePort = 49152 + Math.floor(Math.random() * 1000);
  const testPort1 = basePort;
  const testPort2 = basePort + 1;
  const dbPath = path.resolve(__dirname, 'data', 'nepnha_projects.sqlite');
  console.log(`[Config] Instance 1 Port: ${testPort1}, Instance 2 Port: ${testPort2}`);
  console.log(`[Config] SQLite Database Path: ${dbPath}`);

  // Ensure data dir exists
  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  // PHASE 1: Launch Server Instance #1
  console.log('\n--- PHASE 1: Starting WebViewerServer Instance #1 ---');
  process.env.DATABASE_DRIVER = 'sqlite';
  process.env.SQLITE_DB_PATH = dbPath;

  const server1 = new WebViewerServer({ port: testPort1 });
  await server1.start();
  console.log('✓ Instance #1 started successfully.');

  // Test 1: GET /api/health
  console.log('\n1. Testing GET /api/health ...');
  const healthRes = await makeRequest(testPort1, 'GET', '/api/health');
  if (healthRes.status !== 200 || healthRes.body?.status !== 'ok') {
    throw new Error(`Health check failed: ${JSON.stringify(healthRes)}`);
  }
  console.log(`✓ Health check OK: driver=${healthRes.body.driver}, status=${healthRes.body.status}`);

  // Test 2: GET /api/projects (Seeds)
  console.log('\n2. Testing GET /api/projects (Seed Verification) ...');
  const listRes = await makeRequest(testPort1, 'GET', '/api/projects');
  if (listRes.status !== 200 || !Array.isArray(listRes.body?.data)) {
    throw new Error(`GET /api/projects failed: ${JSON.stringify(listRes)}`);
  }
  console.log(`✓ Seeded projects found: count=${listRes.body.count}`);
  const seedIds = listRes.body.data.map((p) => p.id);
  console.log(`  Project IDs: ${seedIds.join(', ')}`);
  if (!seedIds.includes('nha-pho-4-tang-5x8') || !seedIds.includes('biet-thu-san-vuon-3-tang-12x16')) {
    throw new Error(`Missing expected seed projects! Found: ${seedIds.join(', ')}`);
  }

  // Test 3: GET /api/projects/nha-pho-4-tang-5x8
  console.log('\n3. Testing GET /api/projects/nha-pho-4-tang-5x8 ...');
  const detailRes = await makeRequest(testPort1, 'GET', '/api/projects/nha-pho-4-tang-5x8');
  if (detailRes.status !== 200 || !detailRes.body?.data) {
    throw new Error(`GET project detail failed: ${JSON.stringify(detailRes)}`);
  }
  const townhouse = detailRes.body.data;
  console.log(`✓ Retrieved project: "${townhouse.title}", floors=${townhouse.floors.length}`);

  // Test 4: POST /api/projects (Create new project)
  console.log('\n4. Testing POST /api/projects (Create new project) ...');
  const newProjectPayload = {
    id: 'test_persist_coastal_villa',
    title: 'Biệt thự Nghỉ dưỡng Ven Biển (10 × 20 m)',
    code: 'NP-E2E-TEST',
    scale: '1:100',
    unit: 'mm',
    lotDimensions: { width: 10, length: 20 },
    landArea: 200,
    floors: [
      {
        id: 'floor_1',
        name: 'Tầng 1 - Phòng khách & Bếp BBQ',
        elevation: 0,
        height: 3.8,
        boundary: [
          [0, 0],
          [10, 0],
          [10, 16],
          [0, 16],
        ],
        rooms: [
          { name: 'Phòng khách Biển', area: 55, function: 'living' },
          { name: 'Bếp & Đảo bar ngoài trời', area: 40, function: 'kitchen' },
        ],
        entities: [
          {
            type: 'LINE',
            layer: 'A-WALL',
            start: [0, 0, 0],
            end: [10, 0, 0],
            color: '#FFFFFF',
          },
          {
            type: 'INSERT',
            layer: 'A-FURN',
            name: 'Sofa góc L ven biển',
            insertionPoint: [5, 4, 0],
            category: 'living',
            material: 'Vải Linen chống ẩm & Gỗ Teak',
          },
        ],
      },
    ],
  };

  const createRes = await makeRequest(testPort1, 'POST', '/api/projects', newProjectPayload);
  if (createRes.status !== 201 || !createRes.body?.success) {
    throw new Error(`POST /api/projects failed: ${JSON.stringify(createRes)}`);
  }
  console.log(`✓ Created new project: id=${createRes.body.data.id}`);

  // Test 5: POST /api/projects/:id/analyze-floor (AI Analysis)
  console.log('\n5. Testing POST /api/projects/:id/analyze-floor ...');
  const analyzeRes = await makeRequest(
    testPort1,
    'POST',
    '/api/projects/test_persist_coastal_villa/analyze-floor',
    {
      floorId: 'floor_1',
      forceOffline: true,
      floorContext: {
        climateZone: 'coastal',
      },
    }
  );

  if (analyzeRes.status !== 200 || !analyzeRes.body?.analysis) {
    throw new Error(`Floor analysis failed: ${JSON.stringify(analyzeRes)}`);
  }
  const analysis = analyzeRes.body.analysis;
  console.log(`✓ AI Analysis succeeded:`);
  console.log(`  - Engine used: ${analysis.engine}`);
  console.log(`  - Rooms detected: ${analysis.rooms?.length || 0}`);

  // Test 6: Verify Static File Serving
  console.log('\n6. Testing Static File Serving (GET /index.html) ...');
  const staticRes = await makeRequest(testPort1, 'GET', '/index.html');
  if (staticRes.status !== 200 || !staticRes.raw.includes('Nếp Nhà')) {
    throw new Error(`Static file serving failed: ${staticRes.status}`);
  }
  console.log('✓ Static file serving confirmed (HTML content validated).');

  // PHASE 2: Stop Server Instance #1
  console.log('\n--- PHASE 2: Stopping Instance #1 and Simulating Server Restart ---');
  await server1.stop();
  console.log('✓ Instance #1 stopped cleanly.');

  // Check file exists on disk
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file missing at ${dbPath}`);
  }
  const stats = fs.statSync(dbPath);
  console.log(`✓ SQLite database file size on disk: ${stats.size} bytes`);

  // Small delay to ensure OS closes all sockets
  await new Promise(r => setTimeout(r, 200));

  // PHASE 3: Launch Server Instance #2 (Using same SQLite DB file)
  console.log('\n--- PHASE 3: Starting WebViewerServer Instance #2 on same DB ---');
  const server2 = new WebViewerServer({ port: testPort2 });
  await server2.start();
  console.log('✓ Instance #2 started successfully.');

  // Test 7: Verify SQLite Persistence of newly created project across restart
  console.log('\n7. Verifying Persistence: GET /api/projects/test_persist_coastal_villa ...');
  const persistCheckRes = await makeRequest(testPort2, 'GET', '/api/projects/test_persist_coastal_villa');
  if (persistCheckRes.status !== 200 || !persistCheckRes.body?.data) {
    throw new Error(`Persistence verification failed! Status: ${persistCheckRes.status}`);
  }
  const reloaded = persistCheckRes.body.data;
  console.log(`✓ Successfully loaded project from SQLite after restart!`);
  console.log(`  - Title: ${reloaded.title}`);
  console.log(`  - Floor 1 analysis persisted: ${Boolean(reloaded.floors[0]?.aiAnalysis)}`);
  if (!reloaded.floors[0]?.aiAnalysis) {
    throw new Error('AI analysis was not persisted across restart!');
  }

  // Test 8: DELETE /api/projects/:id
  console.log('\n8. Testing DELETE /api/projects/test_persist_coastal_villa ...');
  const deleteRes = await makeRequest(testPort2, 'DELETE', '/api/projects/test_persist_coastal_villa');
  if (deleteRes.status !== 200 || !deleteRes.body?.success) {
    throw new Error(`DELETE failed: ${JSON.stringify(deleteRes)}`);
  }
  console.log('✓ Project deleted successfully.');

  // Test 9: Verify Deletion
  const verifyDeleteRes = await makeRequest(testPort2, 'GET', '/api/projects/test_persist_coastal_villa');
  if (verifyDeleteRes.status !== 404) {
    throw new Error(`Expected 404 after deletion, got ${verifyDeleteRes.status}`);
  }
  console.log('✓ Confirmed 404 Not Found after deletion.');

  // Clean shutdown
  console.log('\n--- Cleaning up ---');
  await server2.stop();
  console.log('✓ Instance #2 stopped cleanly.');

  console.log('\n=== ALL END-TO-END & PERSISTENCE VERIFICATION TESTS PASSED! ===');
}

run().catch((err) => {
  console.error('\n❌ E2E VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
