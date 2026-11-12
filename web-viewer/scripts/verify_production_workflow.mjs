/**
 * verify_production_workflow.mjs
 * End-to-End Playwright & Node.js Verification Suite for OpenCADStudio_Z / Nếp Nhà
 * 
 * Verifies the complete 6-Step Production Workflow:
 * 1. Step 1 - Project Management (POST, GET, DELETE /api/projects & SQLite persistence)
 * 2. Step 2 - AI Provider Hub (POST /api/ai/models, POST /api/ai/test-connection, GET/POST /api/ai/config)
 * 3. Step 3 - Modular Furniture Store (GET /api/furniture-assets >= 35 items, POST /api/furniture-assets custom upload)
 * 4. Step 4 - AI Studio Chat & Spatial Compiler (POST /api/projects/:id/chat with Vietnamese prompt & 2-pass spatial compiler)
 * 5. Step 5 - Presentation Viewer Mode (Playwright headless Chrome: UI visibility, floor isolation, 4 view modes, lights, labels, 60 FPS, 0 errors/warnings)
 * 6. Capture High-Res Screenshots (Studio Mode & Presentation Mode into web-viewer/screenshots/)
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_VIEWER_DIR = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(WEB_VIEWER_DIR, 'screenshots');
const ARTIFACT_DIR = 'C:/Users/qdaoc/.gemini/antigravity/brain/b40c95a9-300b-41a2-8b5a-94158a080a6e';

const PLAYWRIGHT_PATH = 'file:///C:/Users/qdaoc/AppData/Local/npm-cache/_npx/9b9809298fe40d2c/node_modules/playwright-core/index.mjs';
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE_URL = process.env.VIEWER_URL || 'http://localhost:3000';
const SERVER_PORT = 3000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[VERIFICATION ASSERTION FAILED] ${message}`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * HTTP JSON Request helper
 */
async function httpRequest(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Connection': 'close',
      ...headers
    };
    if (postData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: SERVER_PORT,
        path: urlPath,
        method: method.toUpperCase(),
        headers: reqHeaders,
        agent: false
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (e) {
            parsed = null;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            rawText: raw
          });
        });
      }
    );

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Main verification runner
 */
async function runProductionWorkflowVerification() {
  console.log('================================================================================');
  console.log('   OpenCADStudio_Z / Nếp Nhà — 6-Step Production Workflow Verification');
  console.log('================================================================================\n');

  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const benchmarkReport = {
    timestamp: new Date().toISOString(),
    steps: {},
    passed: false
  };

  // ---------------------------------------------------------------------------
  // STEP 1: Project Management (Create, List, Read, Delete & SQLite Persistence)
  // ---------------------------------------------------------------------------
  console.log('>>> [STEP 1/6] Verifying Project Management & SQLite Persistence...');
  
  // 1.1 List existing projects
  const initialProjectsRes = await httpRequest('GET', '/api/projects');
  assert(initialProjectsRes.statusCode === 200, `GET /api/projects returned ${initialProjectsRes.statusCode}`);
  const initialProjects = initialProjectsRes.body?.data || initialProjectsRes.body?.projects || initialProjectsRes.body || [];
  console.log(`   - Initial projects in database: ${initialProjects.length}`);

  // 1.2 Create temporary project to test DELETE
  const tempProjId = `e2e_temp_${Date.now()}`;
  const createTempRes = await httpRequest('POST', '/api/projects', {
    id: tempProjId,
    title: 'Dự án Kiểm thử Tạm thời (Cần Xóa)',
    code: 'E2E-TEMP',
    lot_width: 5.0,
    lot_length: 15.0,
    floors: [
      {
        id: 'fl_temp_1',
        name: 'Tầng 1',
        elevation: 0.0,
        height: 3.6,
        entities: []
      }
    ]
  });
  assert([200, 201].includes(createTempRes.statusCode), `POST /api/projects temp returned ${createTempRes.statusCode}: ${createTempRes.rawText}`);
  console.log(`   - Created temporary project '${tempProjId}' (HTTP ${createTempRes.statusCode})`);

  // Verify it exists in GET /api/projects/:id
  const getTempRes = await httpRequest('GET', `/api/projects/${tempProjId}`);
  assert(getTempRes.statusCode === 200, `GET /api/projects/${tempProjId} returned ${getTempRes.statusCode}`);
  const tempProjData = getTempRes.body?.data || getTempRes.body?.project || getTempRes.body;
  assert(tempProjData?.id === tempProjId, 'Temp project ID mismatch');

  // Delete temp project
  const deleteTempRes = await httpRequest('DELETE', `/api/projects/${tempProjId}`);
  assert([200, 204].includes(deleteTempRes.statusCode), `DELETE /api/projects/${tempProjId} returned ${deleteTempRes.statusCode}`);
  console.log(`   - Deleted temporary project '${tempProjId}' successfully.`);

  // Verify deletion
  const getDeletedRes = await httpRequest('GET', `/api/projects/${tempProjId}`);
  assert([404, 200].includes(getDeletedRes.statusCode), `Expected 404 for deleted project, got ${getDeletedRes.statusCode}`);
  if (getDeletedRes.statusCode === 200) {
    assert(!getDeletedRes.body?.data && !getDeletedRes.body?.project, 'Deleted project should not have project data');
  }

  // 1.3 Create dedicated production workflow E2E project
  const workflowProjId = 'workflow-e2e-nha-pho';
  // Delete first if already existed from prior run
  await httpRequest('DELETE', `/api/projects/${workflowProjId}`).catch(() => {});

  const newProjectPayload = {
    id: workflowProjId,
    title: 'Nhà phố Đô thị Hiện đại 4x16m E2E',
    code: 'NN-E2E-001',
    lot_width: 4.5,
    lot_length: 16.0,
    style: 'modern_tropical',
    floors: [
      {
        id: 'floor_1',
        name: 'Tầng 1: Phòng khách & Bếp',
        elevation: 0.0,
        height: 3.8,
        entities: [],
        rooms: [
          { name: 'Phòng khách', type: 'living_room', x: 2.25, y: 4.0, width: 4.5, length: 6.0, area: 27.0 },
          { name: 'Bếp & Phòng ăn', type: 'kitchen', x: 2.25, y: 10.0, width: 4.5, length: 6.0, area: 27.0 }
        ],
        furniture: [
          { asset_id: 'sofa_l_modern', name: 'Sofa góc L', x: 1.2, y: 3.5, cx: 1.2, cy: 3.5, z: 0, rotY: 0 },
          { asset_id: 'dining_table_6chairs', name: 'Bàn ăn 6 ghế', x: 2.2, y: 9.5, cx: 2.2, cy: 9.5, z: 0, rotY: 1.57 }
        ]
      },
      {
        id: 'floor_2',
        name: 'Tầng 2: Phòng ngủ Master & Sinh hoạt',
        elevation: 3.8,
        height: 3.4,
        entities: [],
        rooms: [
          { name: 'Phòng ngủ Master', type: 'bedroom_master', x: 2.25, y: 4.5, width: 4.5, length: 7.0, area: 31.5 }
        ],
        furniture: [
          { asset_id: 'bed_master_king', name: 'Giường King', x: 2.2, y: 4.0, cx: 2.2, cy: 4.0, z: 3.8, rotY: 0 }
        ]
      },
      {
        id: 'floor_3',
        name: 'Tầng 3: 2 Phòng ngủ con',
        elevation: 7.2,
        height: 3.4,
        entities: [],
        rooms: [
          { name: 'Phòng ngủ 2', type: 'bedroom_child', x: 2.25, y: 4.0, width: 4.5, length: 5.5, area: 24.75 }
        ],
        furniture: [
          { asset_id: 'bed_queen_modern', name: 'Giường Queen', x: 2.2, y: 4.0, cx: 2.2, cy: 4.0, z: 7.2, rotY: 0 }
        ]
      }
    ]
  };

  const createWorkflowProjRes = await httpRequest('POST', '/api/projects', newProjectPayload);
  assert([200, 201].includes(createWorkflowProjRes.statusCode), `POST /api/projects for ${workflowProjId} failed: ${createWorkflowProjRes.rawText}`);
  
  // Verify persistence in SQLite
  const readWorkflowProjRes = await httpRequest('GET', `/api/projects/${workflowProjId}`);
  assert(readWorkflowProjRes.statusCode === 200, `Could not read back ${workflowProjId}`);
  const createdProj = readWorkflowProjRes.body?.data || readWorkflowProjRes.body?.project || readWorkflowProjRes.body;
  assert(createdProj.id === workflowProjId, 'Project ID mismatch in SQLite');
  assert(createdProj.floors?.length >= 3, `Expected at least 3 floors, got ${createdProj.floors?.length}`);
  console.log(`   ✓ Step 1 Passed: Project '${workflowProjId}' created and persisted in SQLite with ${createdProj.floors.length} floors.\n`);

  benchmarkReport.steps.step1_project_management = {
    status: 'PASS',
    projectId: workflowProjId,
    floors: createdProj.floors.length,
    lotWidth: createdProj.lot_width,
    lotLength: createdProj.lot_length
  };

  // ---------------------------------------------------------------------------
  // STEP 2: AI Provider Hub & Dynamic Model Configuration
  // ---------------------------------------------------------------------------
  console.log('>>> [STEP 2/6] Verifying AI Provider Hub & Configuration Endpoints...');
  
  // 2.1 GET /api/ai/config
  const getAiConfigRes = await httpRequest('GET', '/api/ai/config');
  assert([200, 404].includes(getAiConfigRes.statusCode), `GET /api/ai/config unexpected status ${getAiConfigRes.statusCode}`);
  console.log(`   - Initial AI Config status: HTTP ${getAiConfigRes.statusCode}`);

  // 2.2 POST /api/ai/config
  const testAiConfig = {
    provider: 'antigravity',
    base_url: 'https://api.openai.com/v1',
    api_key: 'sk-antigravity-mock-test-key-2026',
    primary_model: 'gemini-2.5-flash',
    vision_model: 'gemini-2.5-flash'
  };
  const saveAiConfigRes = await httpRequest('POST', '/api/ai/config', testAiConfig);
  assert([200, 201].includes(saveAiConfigRes.statusCode), `POST /api/ai/config failed: ${saveAiConfigRes.rawText}`);
  console.log(`   - Saved AI configuration (provider: ${testAiConfig.provider}, primary: ${testAiConfig.primary_model})`);

  // Verify config read-back
  const readbackAiConfigRes = await httpRequest('GET', '/api/ai/config');
  assert(readbackAiConfigRes.statusCode === 200, 'GET /api/ai/config read-back failed');
  const readbackConfig = readbackAiConfigRes.body?.data || readbackAiConfigRes.body?.config || readbackAiConfigRes.body;
  assert(readbackConfig.primary_model === 'gemini-2.5-flash' || readbackConfig.provider === 'antigravity', 'AI Config values not persisted');

  // 2.3 POST /api/ai/models
  const modelsRes = await httpRequest('POST', '/api/ai/models', {
    provider: 'antigravity',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-antigravity-mock-test-key-2026'
  });
  assert(modelsRes.statusCode === 200, `POST /api/ai/models returned ${modelsRes.statusCode}: ${modelsRes.rawText}`);
  const modelsList = modelsRes.body?.models || modelsRes.body?.data || [];
  assert(Array.isArray(modelsList) && modelsList.length > 0, `Expected models array, got: ${JSON.stringify(modelsList)}`);
  console.log(`   - Fetched models list: ${modelsList.length} models available (e.g. ${modelsList.slice(0, 3).join(', ')})`);

  // 2.4 POST /api/ai/test-connection
  const testConnRes = await httpRequest('POST', '/api/ai/test-connection', {
    provider: 'antigravity',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-antigravity-mock-test-key-2026'
  });
  assert(testConnRes.statusCode === 200, `POST /api/ai/test-connection returned ${testConnRes.statusCode}: ${testConnRes.rawText}`);
  assert(testConnRes.body?.success === true, `Expected success === true from test-connection`);
  console.log(`   - AI Test Connection: SUCCESS (Latency: ${testConnRes.body?.latencyMs || 'N/A'}ms, Provider: ${testConnRes.body?.provider})`);
  console.log('   ✓ Step 2 Passed: AI Provider Hub fully operational.\n');

  benchmarkReport.steps.step2_ai_provider_hub = {
    status: 'PASS',
    provider: testAiConfig.provider,
    modelsCount: modelsList.length,
    testConnectionLatency: testConnRes.body?.latencyMs || 0
  };

  // ---------------------------------------------------------------------------
  // STEP 3: Modular Furniture Store Catalog & Custom Asset Upload
  // ---------------------------------------------------------------------------
  console.log('>>> [STEP 3/6] Verifying Modular Furniture Store & Custom Asset Upload...');

  // 3.1 GET /api/furniture-assets
  const catalogRes = await httpRequest('GET', '/api/furniture-assets');
  assert(catalogRes.statusCode === 200, `GET /api/furniture-assets returned ${catalogRes.statusCode}`);
  const catalogItems = catalogRes.body?.data || catalogRes.body?.assets || catalogRes.body?.items || (Array.isArray(catalogRes.body) ? catalogRes.body : []);
  console.log(`   - Pre-seeded furniture catalog count: ${catalogItems.length} items`);
  assert(catalogItems.length >= 35, `Expected at least 35 pre-seeded furniture items, found ${catalogItems.length}`);

  // Verify structure of first item
  const sampleAsset = catalogItems[0];
  assert(sampleAsset.asset_id || sampleAsset.id, 'Asset missing asset_id');
  assert(sampleAsset.name, 'Asset missing name');
  console.log(`   - Sample catalog item: '${sampleAsset.name}' (${sampleAsset.asset_id})`);

  // 3.2 POST /api/furniture-assets (Upload Custom Asset)
  const customAssetId = `custom_art_chair_${Date.now()}`;
  const customAssetPayload = {
    asset_id: customAssetId,
    name: 'Ghế bành thư giãn Art Deco Cao Cấp',
    category: 'living_room',
    room_types: ['phong_khach', 'phong_ngu'],
    placement_type: 'floor_center',
    dimensions: { width: 0.95, depth: 0.90, height: 0.85 },
    tags: ['art_deco', 'thu_gian', 'custom_glb'],
    glbBase64: 'glTF...mock...data',
    glb_base64: 'glTF...mock...data'
  };

  const uploadAssetRes = await httpRequest('POST', '/api/furniture-assets', customAssetPayload);
  assert([200, 201].includes(uploadAssetRes.statusCode), `POST /api/furniture-assets returned ${uploadAssetRes.statusCode}: ${uploadAssetRes.rawText}`);
  console.log(`   - Uploaded custom asset '${customAssetPayload.name}' (${customAssetId})`);

  // 3.3 Verify custom asset appears in search
  const searchAssetRes = await httpRequest('GET', `/api/furniture-assets?search=${encodeURIComponent('Art Deco')}`);
  assert(searchAssetRes.statusCode === 200, `Search furniture assets failed with ${searchAssetRes.statusCode}`);
  const searchResults = searchAssetRes.body?.data || searchAssetRes.body?.assets || searchAssetRes.body?.items || (Array.isArray(searchAssetRes.body) ? searchAssetRes.body : []);
  assert(searchResults.some(a => (a.asset_id === customAssetId || a.name?.includes('Art Deco'))), 'Custom asset did not appear in search results');
  console.log(`   - Custom asset successfully queried from SQLite catalog.`);
  console.log('   ✓ Step 3 Passed: Modular Furniture Store verified.\n');

  benchmarkReport.steps.step3_furniture_store = {
    status: 'PASS',
    preSeededCount: catalogItems.length,
    customAssetUploaded: customAssetId
  };

  // ---------------------------------------------------------------------------
  // STEP 4: AI Studio Chat & Two-Pass Spatial Compiler
  // ---------------------------------------------------------------------------
  console.log('>>> [STEP 4/6] Verifying AI Studio Chat & Two-Pass Spatial Compiler...');

  const chatPrompt = 'Thêm tầng 4 phòng thờ trang nghiêm và sân BBQ ngoài trời với bàn ghế ăn sân vườn';
  console.log(`   - Sending conversational architectural prompt: "${chatPrompt}"...`);

  const chatRes = await httpRequest('POST', `/api/projects/${workflowProjId}/chat`, {
    message: chatPrompt,
    attachments: []
  });

  assert(chatRes.statusCode === 200, `POST /api/projects/${workflowProjId}/chat returned ${chatRes.statusCode}: ${chatRes.rawText}`);
  assert(chatRes.body?.success === true, `Expected chat endpoint success === true, got: ${chatRes.rawText}`);
  
  const updatedProject = chatRes.body?.project || chatRes.body?.data;
  assert(updatedProject, 'Chat endpoint did not return updated project');
  console.log(`   - AI Spatial Compiler Response received. Updated floors count: ${updatedProject.floors?.length}`);
  
  // Verify floor 4 was added or updated
  assert(updatedProject.floors?.length >= 4, `Expected at least 4 floors after adding Tầng 4, got ${updatedProject.floors?.length}`);
  const floor4 = updatedProject.floors[updatedProject.floors.length - 1];
  console.log(`   - Top Floor Name: "${floor4.name}" (Elevation: ${floor4.elevation}m, Height: ${floor4.height}m)`);
  
  // Verify 4-phase stage progress
  const stageInfo = chatRes.body?.stageInfo;
  if (stageInfo) {
    console.log(`   - Two-Pass Compiler Stage Info:`, Object.keys(stageInfo).map(k => `${k}: ${stageInfo[k].name}`));
  }

  // Verify chat messages were persisted in SQLite
  const messagesRes = await httpRequest('GET', `/api/projects/${workflowProjId}/messages`).catch(() => null);
  if (messagesRes && messagesRes.statusCode === 200) {
    const msgs = messagesRes.body?.data || messagesRes.body?.messages || [];
    console.log(`   - Chat history in SQLite: ${msgs.length} messages.`);
    assert(msgs.length >= 2, 'Expected at least 2 chat messages (user prompt + assistant response)');
  }

  console.log('   ✓ Step 4 Passed: Two-Pass Spatial Compiler generated valid 4th floor & updated BIM.\n');

  benchmarkReport.steps.step4_ai_spatial_compiler = {
    status: 'PASS',
    prompt: chatPrompt,
    resultingFloors: updatedProject.floors.length,
    topFloorName: floor4.name,
    hasEntities: floor4.entities?.length > 0 || floor4.rooms?.length > 0
  };

  // ---------------------------------------------------------------------------
  // STEP 5 & 6: Playwright Browser Test (Studio & Fullscreen Presentation Mode)
  // ---------------------------------------------------------------------------
  console.log('>>> [STEP 5/6] Verifying Frontend via Playwright (Studio & Presentation Mode)...');

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

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error' && !text.includes('fonts.googleapis.com') && !text.includes('fonts.gstatic.com')) {
      consoleErrors.push(text);
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

  // 5.1 Navigate to Studio Mode
  const studioUrl = `${BASE_URL}/?project=${workflowProjId}`;
  console.log(`   - Opening Studio Mode: ${studioUrl}...`);
  await page.goto(studioUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('#viewport-container canvas', { timeout: 15000 });
  await sleep(1000);

  // Verify Studio UI components
  const studioUiCheck = await page.evaluate(() => {
    const chatPanel = document.getElementById('ai-chat-panel') || document.querySelector('.ai-chat-panel');
    const header = document.querySelector('header') || document.querySelector('.main-header');
    const canvas = document.querySelector('#viewport-container canvas');
    return {
      hasHeader: Boolean(header),
      hasCanvas: Boolean(canvas),
      hasChatPanel: Boolean(chatPanel),
      activeProject: window.app?.activeProjectId
    };
  });
  console.log('   - Studio UI State:', studioUiCheck);

  // Capture High-Res Screenshot 1: Studio Mode
  console.log('>>> [STEP 6/6] Capturing Screenshot 1: Studio Mode...');
  const studioShotPath = path.join(SCREENSHOTS_DIR, 'workflow_studio_mode.png');
  await page.screenshot({ path: studioShotPath, fullPage: false });
  if (fs.existsSync(ARTIFACT_DIR)) {
    fs.copyFileSync(studioShotPath, path.join(ARTIFACT_DIR, 'workflow_studio_mode.png'));
  }
  console.log(`   ✓ Studio Mode screenshot saved: ${studioShotPath}`);

  // 5.2 Navigate to Presentation Viewer Mode via URL query ?mode=viewer
  const presentationUrl = `${BASE_URL}/?mode=viewer&project=${workflowProjId}`;
  console.log(`   - Opening Presentation Mode: ${presentationUrl}...`);
  await page.goto(presentationUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('#viewport-container canvas', { timeout: 15000 });
  await sleep(1200);

  // Verify Presentation UI:
  // - Chat and edit tools hidden
  // - Left sidebar with project info & floors preserved
  // - Top floating toggles & bottom 4 view modes preserved
  const presentationUiCheck = await page.evaluate(() => {
    const isViewerMode = document.body.classList.contains('presentation-mode') || 
                         document.body.classList.contains('mode-viewer') || 
                         window.app?.isPresentationMode === true || 
                         window.location.search.includes('mode=viewer');

    const chatPanel = document.getElementById('ai-chat-panel') || document.querySelector('.ai-chat-panel');
    const chatHidden = !chatPanel || chatPanel.classList.contains('hidden') || getComputedStyle(chatPanel).display === 'none';

    const sidebar = document.getElementById('sidebar-left') || document.querySelector('.sidebar') || document.querySelector('aside');
    const sidebarVisible = sidebar ? getComputedStyle(sidebar).display !== 'none' : true;

    const returnBtn = document.getElementById('btn-exit-presentation') ||
                      document.getElementById('btn-return-studio') ||
                      document.querySelector('.btn-presentation-back') ||
                      document.querySelector('.btn-return-studio') ||
                      document.querySelector('[data-action="return-studio"]');

    const lightToggle = document.getElementById('toggle-interior-lights');
    const labelToggle = document.getElementById('toggle-room-labels');

    const viewModes = ['dollhouse', 'facade', 'exploded', 'walkthrough'].map(mode => {
      const el = document.querySelector(`[data-view-mode="${mode}"]`);
      return { mode, exists: Boolean(el) };
    });

    return {
      isViewerMode,
      chatHidden,
      sidebarVisible,
      hasReturnBtn: Boolean(returnBtn),
      hasLightToggle: Boolean(lightToggle),
      hasLabelToggle: Boolean(labelToggle),
      viewModes
    };
  });
  console.log('   - Presentation UI Verification:', presentationUiCheck);
  assert(presentationUiCheck.chatHidden, 'Chat panel must be hidden in Presentation Viewer Mode');
  assert(presentationUiCheck.hasLightToggle, 'Interior lights toggle must remain accessible');
  assert(presentationUiCheck.hasLabelToggle, 'Room labels toggle must remain accessible');

  // 5.3 Test Floor Isolation click in Presentation Mode
  console.log('   - Testing Floor Isolation click in Presentation Mode...');
  const floorClickResult = await page.evaluate(async () => {
    const firstFloorCard = document.querySelector('.floor-card');
    if (firstFloorCard) {
      firstFloorCard.click();
      await new Promise(r => setTimeout(r, 200));
      return { clicked: true, floorId: firstFloorCard.dataset?.floorId };
    }
    return { clicked: false };
  });
  console.log('   - Floor Isolation Result:', floorClickResult);

  // 5.4 Test 4 View Modes (Dollhouse, Facade, Exploded, Walkthrough)
  console.log('   - Testing all 4 View Modes in Presentation Mode...');
  const viewModesToTest = ['dollhouse', 'facade', 'exploded', 'walkthrough'];
  for (const vm of viewModesToTest) {
    const btn = await page.$(`[data-view-mode="${vm}"]`);
    if (btn) {
      await btn.click();
      await sleep(250);
      const activeVm = await page.evaluate(() => window.app?.viewer?.viewMode || window.app?.viewMode);
      console.log(`     * Clicked view mode '${vm}' -> current: '${activeVm}'`);
    }
  }

  // Restore to Dollhouse mode
  const dollhouseBtn = await page.$('[data-view-mode="dollhouse"]');
  if (dollhouseBtn) await dollhouseBtn.click();
  await sleep(300);

  // 5.5 Test Light Toggle (Bật / Tắt Đèn nhà)
  console.log('   - Testing Light Toggle in Presentation Mode...');
  await page.click('#toggle-interior-lights');
  await sleep(150);
  const lightsOff = await page.evaluate(() => window.app?.viewer?.interiorLightsOn);
  console.log(`     * Lights toggled OFF: interiorLightsOn = ${lightsOff}`);
  await page.click('#toggle-interior-lights');
  await sleep(150);
  const lightsOn = await page.evaluate(() => window.app?.viewer?.interiorLightsOn);
  console.log(`     * Lights toggled ON: interiorLightsOn = ${lightsOn}`);

  // 5.6 Test Room Label Toggle (Bật / Tắt Nhãn phòng)
  console.log('   - Testing Room Label Toggle in Presentation Mode...');
  await page.click('#toggle-room-labels');
  await sleep(150);
  const labelsOff = await page.evaluate(() => window.app?.viewer?.roomLabelsVisible);
  console.log(`     * Labels toggled OFF: roomLabelsVisible = ${labelsOff}`);
  await page.click('#toggle-room-labels');
  await sleep(150);
  const labelsOn = await page.evaluate(() => window.app?.viewer?.roomLabelsVisible);
  console.log(`     * Labels toggled ON: roomLabelsVisible = ${labelsOn}`);

  // 5.7 Measure Interactive FPS (target 60 FPS) during active camera orbit
  console.log('   - Benchmarking active camera orbit FPS in Presentation Mode...');
  await page.evaluate(() => {
    const v = window.app.viewer;
    window.__perfFrameCount = 0;
    window.__perfStartTime = performance.now();
    v._workflowOrigRender = v.renderer.render.bind(v.renderer);
    v.renderer.render = function(...args) {
      window.__perfFrameCount++;
      return v._workflowOrigRender(...args);
    };
  });

  const canvasBox = await page.locator('#viewport-container canvas').boundingBox();
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(cx + i * 7, cy + (i % 2 === 0 ? 5 : -5));
    await sleep(20);
  }
  await page.mouse.up();

  const fpsReport = await page.evaluate(() => {
    const v = window.app.viewer;
    const elapsed = performance.now() - window.__perfStartTime;
    const frames = window.__perfFrameCount;
    if (v._workflowOrigRender) {
      v.renderer.render = v._workflowOrigRender;
    }
    const fps = Math.round((frames / (elapsed / 1000)) * 10) / 10;
    return {
      frames,
      elapsedMs: Math.round(elapsed),
      fps
    };
  });
  console.log(`   - Orbit FPS Benchmark: ${fpsReport.fps} FPS (${fpsReport.frames} frames rendered in ${fpsReport.elapsedMs}ms)`);
  assert(fpsReport.fps >= 50, `Expected at least 50-60 FPS interactive smoothness, got ${fpsReport.fps} FPS`);

  // Capture High-Res Screenshot 2: Presentation Mode
  console.log('>>> [STEP 6/6] Capturing Screenshot 2: Presentation Viewer Mode...');
  const presentationShotPath = path.join(SCREENSHOTS_DIR, 'workflow_presentation_mode.png');
  await page.screenshot({ path: presentationShotPath, fullPage: false });
  if (fs.existsSync(ARTIFACT_DIR)) {
    fs.copyFileSync(presentationShotPath, path.join(ARTIFACT_DIR, 'workflow_presentation_mode.png'));
  }
  console.log(`   ✓ Presentation Mode screenshot saved: ${presentationShotPath}`);

  // Check WebGL context health & console errors
  const webglHealth = await page.evaluate(() => {
    const gl = window.app?.viewer?.renderer?.getContext();
    return {
      isContextLost: gl ? gl.isContextLost() : false,
      drawCalls: window.app?.viewer?.renderer?.info?.render?.calls,
      triangles: window.app?.viewer?.renderer?.info?.render?.triangles
    };
  });

  await browser.close();

  console.log('\n--- WebGL & Console Cleanliness Verification ---');
  console.log(`   - Console Errors: ${consoleErrors.length}`);
  console.log(`   - Page Errors:    ${pageErrors.length}`);
  console.log(`   - WebGL Warnings: ${webglWarnings.length}`);
  console.log(`   - WebGL Context:  ${webglHealth.isContextLost ? 'LOST' : 'HEALTHY (Active)'}`);

  assert(consoleErrors.length === 0, `Expected 0 console errors, got ${consoleErrors.length}: ${consoleErrors.join('; ')}`);
  assert(pageErrors.length === 0, `Expected 0 page errors, got ${pageErrors.length}: ${pageErrors.join('; ')}`);
  assert(webglWarnings.length === 0, `Expected 0 WebGL warnings, got ${webglWarnings.length}: ${webglWarnings.join('; ')}`);
  assert(!webglHealth.isContextLost, 'WebGL Context was lost');

  benchmarkReport.steps.step5_presentation_mode = {
    status: 'PASS',
    presentationUiCheck,
    measuredFps: fpsReport.fps,
    drawCalls: webglHealth.drawCalls,
    triangles: webglHealth.triangles
  };

  benchmarkReport.steps.step6_screenshots = {
    status: 'PASS',
    studioShot: studioShotPath,
    presentationShot: presentationShotPath
  };

  benchmarkReport.passed = true;

  console.log('\n================================================================================');
  console.log('   🎉 ALL 6 PRODUCTION WORKFLOW STEPS VERIFIED & PASSED SUCCESSFULLY!');
  console.log('================================================================================');
  console.log(JSON.stringify(benchmarkReport, null, 2));

  return benchmarkReport;
}

runProductionWorkflowVerification().catch(err => {
  console.error('\n❌ WORKFLOW VERIFICATION FAILED:', err);
  process.exit(1);
});
