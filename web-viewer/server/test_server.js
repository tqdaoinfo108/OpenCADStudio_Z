import fs from 'node:fs';
/**
 * test_server.js
 * Comprehensive automated test suite for Web Viewer backend:
 * - models (ProjectDocument, FloorDocument)
 * - repositories (SqliteProjectRepository, MongoProjectRepository)
 * - ai_vision_extractor (offline geometry, spatial analysis, DXF parsing)
 * - REST API server & endpoints (GET, POST, DELETE, analyze-floor, static files)
 */

import assert from 'node:assert/strict';
import { furnitureType, roomAllowsFurniture, validateAndSanitizeFloorPlan } from '../js/architectural_layout.js';
import { CadBimPipeline } from '../js/cad_bim_pipeline.js';
import { ProjectDocument, FloorDocument, ChatMessage, FurnitureAsset, AiConfig } from './models.js';
import { SqliteProjectRepository } from './sqlite_repo.js';
import { MongoProjectRepository } from './mongo_repo.js';
import { createRepository } from './repository.js';
import { SEED_PROJECTS, PROJECT_TOWNHOUSE_4F, PROJECT_VILLA_GARDEN_3F } from './seed_data.js';
import { AiVisionExtractor } from './ai_vision_extractor.js';
import { TwoPassSpatialCompiler } from './two_pass_spatial_compiler.js';
import { WebViewerServer } from './index.js';

async function runTests() {
  console.log('=== STARTING WEB VIEWER BACKEND TEST SUITE ===\n');

  // -------------------------------------------------------------
  // TEST 1: Models & Validation
  // -------------------------------------------------------------
  console.log('1. Testing ProjectDocument & FloorDocument Models...');
  const floor1 = new FloorDocument({
    id: 'fl_test_1',
    name: 'Tầng Trệt Test',
    desc: 'Khu vực thử nghiệm',
    elevation: 0.0,
    height: 3.5,
    entities: [{ type: 'LINE', layer: 'A-WALL-INTR', points: [{ x: 0, y: 0 }], end: { x: 5, y: 0 } }]
  });
  const flValid = floor1.validate();
  assert.equal(flValid.valid, true, 'Floor document should be valid');

  const project1 = new ProjectDocument({
    id: 'proj_test_1',
    title: 'Dự án Test Mẫu',
    code: 'NN-TEST-01',
    lot_width: 6.0,
    lot_length: 12.0,
    floors: [floor1]
  });
  const projValid = project1.validate();
  assert.equal(projValid.valid, true, 'Project document should be valid');
  assert.equal(project1.floors.length, 1);
  assert.equal(project1.lot_area, 72.0);
  assert.ok(project1.total_floor_area > 0);

  // Test JSON serialization & deserialization
  const serialized = project1.toJSON();
  const deserialized = ProjectDocument.fromJSON(serialized);
  assert.equal(deserialized.id, project1.id);
  assert.equal(deserialized.floors[0].name, 'Tầng Trệt Test');
  console.log('   ✓ Models validation & serialization passed.');

  // -------------------------------------------------------------
  // TEST 2: SqliteProjectRepository
  // -------------------------------------------------------------
  console.log('2. Testing SqliteProjectRepository in :memory: ...');
  const sqliteRepo = new SqliteProjectRepository({ dbPath: ':memory:' });
  await sqliteRepo.init();

  // Test Seed
  const seedRes = await sqliteRepo.seed(SEED_PROJECTS);
  assert.equal(seedRes.seededCount, 3, 'Should seed 3 projects');
  assert.equal((await sqliteRepo.seed(SEED_PROJECTS, true)).seededCount, 0);
  
  // Test findAll
  const allProjects = await sqliteRepo.findAll();
  assert.equal(allProjects.length, 3, 'Should retrieve 3 seeded projects');
  assert.ok(allProjects.some(p => p.id === 'nha-pho-4-tang-5x8'));
  assert.ok(allProjects.some(p => p.id === 'biet-thu-san-vuon-3-tang-12x16'));

  // Test findById
  const townhouse = await sqliteRepo.findById('nha-pho-4-tang-5x8');
  assert.ok(townhouse, 'Townhouse project should be found');
  assert.equal(townhouse.floors.length, 4, 'Townhouse must have 4 floors');
  assert.equal(townhouse.lot_width, 5.0);
  assert.equal(townhouse.lot_length, 10.0);

  const villa = await sqliteRepo.findById('biet-thu-san-vuon-3-tang-12x16');
  assert.ok(villa, 'Villa project should be found');
  assert.equal(villa.floors.length, 3, 'Villa must have 3 floors');
  assert.equal(villa.lot_width, 10.0);
  assert.equal(villa.lot_length, 14.0);

  // Test save & delete
  const newProj = new ProjectDocument({
    id: 'proj_temp_delete',
    title: 'Dự án tạm cần xóa',
    lot_width: 5,
    lot_length: 10
  });
  await sqliteRepo.save(newProj);
  let foundTemp = await sqliteRepo.findById('proj_temp_delete');
  assert.ok(foundTemp, 'Saved temp project must exist');

  const delResult = await sqliteRepo.delete('proj_temp_delete');
  assert.equal(delResult, true, 'Delete operation should succeed');
  foundTemp = await sqliteRepo.findById('proj_temp_delete');
  assert.equal(foundTemp, null, 'Deleted project should no longer exist');

  // Test Furniture Catalog Seed & Methods
  const catalogItems = await sqliteRepo.getFurnitureAssets();
  assert.ok(catalogItems.length >= 35, 'Catalog should be seeded with at least 35 items');
  assert.ok(typeof catalogItems[0].size_x === 'number', 'Items must have numeric size_x');
  assert.ok(typeof catalogItems[0].size_y === 'number', 'Items must have numeric size_y');
  assert.ok(typeof catalogItems[0].size_z === 'number', 'Items must have numeric size_z');
  const livingItems = await sqliteRepo.getFurnitureAssets({ category: 'living_room' });
  assert.ok(livingItems.length >= 7, 'Should retrieve at least 7 living room items');
  const searchSofa = await sqliteRepo.getFurnitureAssets({ search: 'sofa' });
  assert.ok(searchSofa.length >= 2, 'Should find sofa items via search');

  // Test Custom Furniture add & delete
  const customAsset = await sqliteRepo.addFurnitureAsset({
    id: 'custom_lamp_arc',
    asset_id: 'custom_lamp_arc',
    name: 'Đèn sàn cần cong phong cách Bắc Âu',
    category: 'living_room',
    room_types: ['living_room'],
    placement_type: 'floor_free',
    dimensions: { width: 0.8, depth: 0.8, height: 2.1 }
  });
  assert.equal(customAsset.asset_id, 'custom_lamp_arc');
  let foundCustom = await sqliteRepo.getFurnitureAssets({ search: 'lamp_arc' });
  assert.equal(foundCustom.length, 1);
  const delCustom = await sqliteRepo.deleteFurnitureAsset('custom_lamp_arc');
  assert.equal(delCustom, true);
  foundCustom = await sqliteRepo.getFurnitureAssets({ search: 'lamp_arc' });
  assert.equal(foundCustom.length, 0);

  // Test Chat Messages repo methods
  const msg1 = await sqliteRepo.addChatMessage('nha-pho-4-tang-5x8', {
    sender: 'user',
    text: 'Thêm tầng 4 làm phòng thờ và sân thượng BBQ',
    attachments: []
  });
  assert.ok(msg1.id);
  const msgs = await sqliteRepo.getChatMessages('nha-pho-4-tang-5x8');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'Thêm tầng 4 làm phòng thờ và sân thượng BBQ');

  // Test AI Config repo methods
  const initialAi = await sqliteRepo.getAiConfig();
  assert.ok(initialAi);
  const updatedAi = await sqliteRepo.saveAiConfig({
    provider: 'ollama',
    base_url: 'http://localhost:11434',
    primary_model: 'llama3.3:latest',
    vision_model: 'llava:latest'
  });
  assert.equal(updatedAi.provider, 'ollama');
  assert.equal(updatedAi.primary_model, 'llama3.3:latest');

  await sqliteRepo.close();
  console.log('   ✓ SqliteProjectRepository CRUD, chat, furniture & AI config passed.');

  // Check persisted room zoning and the BIM conversion of all three seeded projects.
  const pipeline = new CadBimPipeline();
  for (const sample of SEED_PROJECTS) {
    const floors = pipeline.processStructuredCad(sample.toJSON()).floors;
    for (const [index, floor] of floors.entries()) {
      assert.equal(floor.height, 3.2);
      assert.equal(floor.slabs[0].thickness, 0.18);
      if (index > 0) assert.ok(floor.slabs[0].stairOpening);
      assert.ok(floor.exteriorWalls.length >= 4 && floor.interiorWalls.length > 0);
      for (const item of [...floor.furniture, ...floor.sanitary]) {
        const room = floor.rooms.find(entry => entry.id === item.room_id);
        assert.ok(room && roomAllowsFurniture(room, item), furnitureType(item));
        const rotated = Math.abs(Math.sin(item.rotation)) > 0.9;
        const halfX = (rotated ? item.depth : item.width) / 2;
        const halfZ = (rotated ? item.width : item.depth) / 2;
        const b = room.bounds;
        assert.ok(item.cx - halfX >= b.minX + 0.149 && item.cx + halfX <= b.maxX - 0.149);
        assert.ok(item.cy - halfZ >= b.minY + 0.149 && item.cy + halfZ <= b.maxY - 0.149);
      }
    }
  }
  const master = townhouse.floors[1];
  const wet = master.rooms.find(room => room.type === 'bathroom');
  const invalid = { asset_id: 'wardrobe_tall_glass', room_id: wet.id, cx: wet.x, cy: wet.y,
    width: 1.25, depth: 0.65, anchor_wall: 'west', offset_along_wall: 1 };
  const cleaned = validateAndSanitizeFloorPlan({ ...master, furniture: [...master.furniture, invalid] });
  assert.equal(cleaned.furniture.length, master.furniture.length);
  assert.ok(!cleaned.furniture.some(item => item.room_id === wet.id && furnitureType(item) === 'wardrobe'));

  // -------------------------------------------------------------
  // TEST 3: MongoProjectRepository Adapter
  // -------------------------------------------------------------
  console.log('3. Testing MongoProjectRepository Adapter (in-memory mode)...');
  const mongoRepo = new MongoProjectRepository();
  await mongoRepo.init();
  await mongoRepo.seed(SEED_PROJECTS);
  const mongoList = await mongoRepo.findAll();
  assert.equal(mongoList.length, 3);
  const mongoVilla = await mongoRepo.findById('biet-thu-san-vuon-3-tang-12x16');
  assert.equal(mongoVilla.title, PROJECT_VILLA_GARDEN_3F.title);
  await mongoRepo.close();
  console.log('   ✓ MongoProjectRepository adapter passed.');

  // -------------------------------------------------------------
  // TEST 4: AiVisionExtractor (Offline spatial parser & DXF)
  // -------------------------------------------------------------
  console.log('4. Testing AiVisionExtractor...');
  const extractor = new AiVisionExtractor();

  // Test Floor 1 analysis of Townhouse (with rooms, furniture, stairs)
  const townAnalysis = await extractor.analyzeFloor({
    floorDocument: townhouse.floors[0]
  });
  assert.ok(townAnalysis, 'Analysis should return result');
  assert.equal(townAnalysis.source, 'offline_spatial_geometry_parser');
  assert.ok(townAnalysis.rooms.length >= 3, 'Should detect at least 3 rooms');
  assert.equal(townAnalysis.metrics.grossAreaM2, 50.0);
  assert.ok(townAnalysis.metrics.hasStairs);
  assert.ok(townAnalysis.fengShui.recommendations.length > 0);
  assert.ok(townAnalysis.costEstimationVND.total > 0);

  // Test Floor 3 analysis of the villa's bedroom and roof terrace
  const villaFloor3Analysis = await extractor.analyzeFloor({
    floorDocument: villa.floors[2]
  });
  assert.ok(villaFloor3Analysis.rooms.some(r => r.zone === 'bedroom'));
  assert.ok(villaFloor3Analysis.rooms.some(r => r.zone === 'outdoor'));

  // Test Image Base64 offline heuristic
  const mockBase64 = Buffer.from('FAKE_IMAGE_DATA_FLOORPLAN_PNG').toString('base64');
  const imageAnalysis = await extractor.analyzeFloor({
    imageBase64: mockBase64,
    mimeType: 'image/png',
    floorContext: { id: 'floor_1', name: 'Mặt bằng Tầng 1' }
  }, { forceOffline: true });
  assert.ok(imageAnalysis);
  assert.equal(imageAnalysis.source, 'offline_image_heuristic_parser');
  console.log('   ✓ AiVisionExtractor spatial parser & heuristics passed.');

  // -------------------------------------------------------------
  // TEST 5: REST API Server & HTTP Endpoints
  // -------------------------------------------------------------
  console.log('5. Testing WebViewerServer REST Endpoints on random free port...');
  const testPort = 3891 + Math.floor(Math.random() * 500);
  const server = new WebViewerServer({
    port: testPort
  });
  await server.start();
  const baseUrl = `http://127.0.0.1:${testPort}`;

  try {
    // 5.1 GET /api/health
    const resHealth = await fetch(`${baseUrl}/api/health`);
    assert.equal(resHealth.status, 200);
    const dataHealth = await resHealth.json();
    assert.equal(dataHealth.status, 'ok');

    // 5.2 GET /api/projects
    const resProjects = await fetch(`${baseUrl}/api/projects`);
    assert.equal(resProjects.status, 200);
    const dataProjects = await resProjects.json();
    assert.equal(dataProjects.success, true);
    assert.ok(dataProjects.count >= 3);

    // 5.3 GET /api/projects/:id
    const resTown = await fetch(`${baseUrl}/api/projects/nha-pho-4-tang-5x8`);
    assert.equal(resTown.status, 200);
    const dataTown = await resTown.json();
    assert.equal(dataTown.data.title, PROJECT_TOWNHOUSE_4F.title);
    assert.equal(dataTown.data.floors.length, 4);

    // 5.4 POST /api/projects/:id/analyze-floor
    const resAnalyze = await fetch(`${baseUrl}/api/projects/nha-pho-4-tang-5x8/analyze-floor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        floorId: 'floor_1',
        forceOffline: true
      })
    });
    assert.equal(resAnalyze.status, 200);
    const dataAnalyze = await resAnalyze.json();
    assert.equal(dataAnalyze.success, true);
    assert.equal(dataAnalyze.floorId, 'floor_1');
    assert.ok(dataAnalyze.analysis.rooms.length > 0);

    // Verify analysis was persisted in project document
    const resTownUpdated = await fetch(`${baseUrl}/api/projects/nha-pho-4-tang-5x8`);
    const dataTownUpdated = await resTownUpdated.json();
    const fl1 = dataTownUpdated.data.floors.find(f => f.id === 'floor_1');
    assert.ok(fl1.aiAnalysis, 'Floor 1 should now have aiAnalysis attached');

    // 5.5 POST /api/projects (create project)
    const resCreate = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'nha-vuon-cap-4-mai-nhat',
        title: 'Nhà vườn Cấp 4 Mái Nhật',
        code: 'NN-2026-NV01',
        subtitle: 'BẢN VẼ XIN PHÉP XÂY DỰNG',
        lot_width: 10.0,
        lot_length: 15.0,
        floors: [
          {
            id: 'floor_1',
            name: 'Tầng 1',
            desc: 'Phòng khách, Bếp ăn, 3 Phòng ngủ',
            elevation: 0.0,
            height: 3.9,
            entities: []
          }
        ]
      })
    });
    assert.equal(resCreate.status, 201);
    const dataCreate = await resCreate.json();
    assert.equal(dataCreate.data.id, 'nha-vuon-cap-4-mai-nhat');

    // 5.6 DELETE /api/projects/:id
    const resDel = await fetch(`${baseUrl}/api/projects/nha-vuon-cap-4-mai-nhat`, {
      method: 'DELETE'
    });
    assert.equal(resDel.status, 200);
    const resCheckDel = await fetch(`${baseUrl}/api/projects/nha-vuon-cap-4-mai-nhat`);
    assert.equal(resCheckDel.status, 404);

    // 5.7 Static file serving: GET / (index.html)
    const resStatic = await fetch(`${baseUrl}/`);
    assert.equal(resStatic.status, 200);
    const htmlText = await resStatic.text();
    assert.ok(htmlText.includes('Nếp Nhà') || htmlText.includes('OpenCADStudio') || htmlText.includes('html'));

    // 5.8 AI Provider Hub: GET & POST /api/ai/config
    const resAiCfgGet = await fetch(`${baseUrl}/api/ai/config`);
    assert.equal(resAiCfgGet.status, 200);
    const dataAiCfgGet = await resAiCfgGet.json();
    assert.ok(dataAiCfgGet.success);
    assert.ok(dataAiCfgGet.data.provider);

    const resAiCfgPost = await fetch(`${baseUrl}/api/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'antigravity',
        primary_model: 'gemini-2.5-flash',
        vision_model: 'gemini-2.5-flash'
      })
    });
    assert.equal(resAiCfgPost.status, 200);
    const dataAiCfgPost = await resAiCfgPost.json();
    assert.equal(dataAiCfgPost.data.primary_model, 'gemini-2.5-flash');

    // 5.9 Dynamic AI Models Discovery: POST /api/ai/models
    const resModels = await fetch(`${baseUrl}/api/ai/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'antigravity' })
    });
    assert.equal(resModels.status, 200);
    const dataModels = await resModels.json();
    assert.ok(dataModels.success);
    assert.ok(Array.isArray(dataModels.models));
    assert.ok(dataModels.models.includes('gemini-2.5-flash'));

    // 5.10 AI Test Connection: POST /api/ai/test-connection
    const resTestConn = await fetch(`${baseUrl}/api/ai/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'antigravity' })
    });
    assert.equal(resTestConn.status, 200);
    const dataTestConn = await resTestConn.json();
    assert.ok(dataTestConn.success);
    assert.ok(typeof dataTestConn.latencyMs === 'number');

    // 5.11 Furniture Assets API: GET /api/furniture-assets & /api/furniture
    const resFurnGet = await fetch(`${baseUrl}/api/furniture-assets?category=living_room`);
    assert.equal(resFurnGet.status, 200);
    const dataFurnGet = await resFurnGet.json();
    assert.ok(dataFurnGet.success);
    assert.ok(dataFurnGet.count >= 7);
    assert.ok(typeof dataFurnGet.assets[0].size_x === 'number');
    assert.ok(typeof dataFurnGet.assets[0].size_y === 'number');
    assert.ok(typeof dataFurnGet.assets[0].size_z === 'number');

    const resFurnAlias = await fetch(`${baseUrl}/api/furniture`);
    assert.equal(resFurnAlias.status, 200);
    const dataFurnAlias = await resFurnAlias.json();
    assert.ok(dataFurnAlias.success);
    assert.ok(dataFurnAlias.assets.length >= 35);
    assert.ok(typeof dataFurnAlias.assets[0].size_x === 'number');

    // 5.12 Furniture Assets API: POST /api/furniture-assets & DELETE /api/furniture-assets/:id
    const dummyGlbBase64 = fs.readFileSync(new URL('../public/assets/models/armchair_lounge.glb',import.meta.url)).toString('base64');
    const resFurnPost = await fetch(`${baseUrl}/api/furniture-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset_id: 'custom_nordic_chair',
        name: 'Ghế bành thư giãn phong cách Bắc Âu',
        category: 'living_room',
        placement_type: 'floor_free',
        dimensions: { width: 0.85, depth: 0.82, height: 0.8 },
        glbBase64: dummyGlbBase64
      })
    });
    assert.equal(resFurnPost.status, 201);
    const dataFurnPost = await resFurnPost.json();
    assert.equal(dataFurnPost.data.asset_id, 'custom_nordic_chair');

    const resFurnDel = await fetch(`${baseUrl}/api/furniture-assets/custom_nordic_chair`, {
      method: 'DELETE'
    });
    assert.equal(resFurnDel.status, 200);

    // 5.13 Interactive Two-Pass Spatial Compiler: POST /api/projects/:id/chat
    const resChat = await fetch(`${baseUrl}/api/projects/nha-pho-4-tang-5x8/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Thêm sofa góc chữ L và bàn trà đôi vào phòng khách tầng 1'
      })
    });
    assert.equal(resChat.status, 200);
    const dataChat = await resChat.json();
    assert.ok(dataChat.success);
    assert.ok(dataChat.userMessage);
    assert.ok(dataChat.assistantMessage);
    assert.ok(dataChat.bimScene);
    assert.ok(dataChat.stageInfo.phase2.status === 'completed');
    assert.ok(dataChat.stageInfo.phase4.status === 'completed');

    // 5.14 Chat History: GET /api/projects/:id/chat
    const resChatHist = await fetch(`${baseUrl}/api/projects/nha-pho-4-tang-5x8/chat`);
    assert.equal(resChatHist.status, 200);
    const dataChatHist = await resChatHist.json();
    assert.ok(dataChatHist.success);
    assert.ok(dataChatHist.count >= 2, 'Should have user and assistant messages');

    // 5.15 Direct TwoPassSpatialCompiler Test: Add Floor 5 with altar & terrace
    const townProject = await server.repo.findById('nha-pho-4-tang-5x8');
    const compiler = new TwoPassSpatialCompiler({ repo: server.repo });
    const compileResult = await compiler.compile({
      project: townProject,
      userMessage: 'Thêm tầng 5 làm phòng thờ gia tiên và sân thượng BBQ ngoài trời'
    });
    assert.ok(compileResult.updatedProject.floors.length >= 5, 'Should have added 5th floor');
    const fl5 = compileResult.updatedProject.floors.find(f => f.id === 'floor_5');
    assert.ok(fl5, 'Floor 5 must exist');
    assert.ok(fl5.elevation > 0);
    assert.ok(compileResult.bimScene.floors.length >= 5);
    assert.ok(compileResult.stageInfo.phase2.details.wallsSanitized >= 0);

    console.log('   ✓ REST API endpoints, AI hub, furniture store & two-pass chat compiler passed.');
  } finally {
    await server.stop();
  }

  console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
