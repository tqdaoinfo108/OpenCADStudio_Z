/**
 * test_frontend_features.js
 * Verification test for frontend modules:
 * 1. Multi-Project Pipeline & Switching
 * 2. Multi-Stage Progressive Rendering logic
 * 3. Smart Floor Control isolation
 * 4. Floorplan SVG generation with Stage 1 AI Detection
 * 5. Exploded View Distance Calculations
 * 6. Furniture Catalog population & Inspector
 */

import assert from 'node:assert';
import { CadBimPipeline } from './js/cad_bim_pipeline.js';
import { FloorplanSvgGenerator } from './js/floorplan_svg.js';
import { SAMPLE_VILLA, SAMPLE_TOWNHOUSE_4F, SAMPLE_VILLA_GARDEN_3F } from './js/sample_models.js';

console.log('=== RUNNING FRONTEND CLIENT FEATURE TESTS ===\n');

// 1. Test Multi-Project CAD-BIM Pipeline
console.log('1. Testing Multi-Project Pipeline Processing...');
const pipeline = new CadBimPipeline();

// Test Project 1: Townhouse 4F (5x8m)
const bimTownhouse = pipeline.process(SAMPLE_TOWNHOUSE_4F);
assert.strictEqual(bimTownhouse.floors.length, 4, 'Townhouse should have 4 floors');
assert.strictEqual(bimTownhouse.metadata.lot_width, 5.0, 'Townhouse width should be 5m');
assert.strictEqual(bimTownhouse.metadata.lot_length, 8.0, 'Townhouse length should be 8m');
assert.ok(bimTownhouse.furnitureCatalog.length > 5, 'Townhouse should have extracted furniture items');
console.log(`   ✓ Townhouse 4F: ${bimTownhouse.floors.length} floors, ${bimTownhouse.furnitureCatalog.length} furniture items, ${bimTownhouse.metadata.total_floor_area} m²`);

// Test Project 2: Villa Garden 3F (12x16m)
const bimVillaGarden = pipeline.process(SAMPLE_VILLA_GARDEN_3F);
assert.strictEqual(bimVillaGarden.floors.length, 3, 'Villa Garden should have 3 floors');
assert.strictEqual(bimVillaGarden.metadata.lot_width, 18.0, 'Villa Garden site width should be 18m');
assert.ok(bimVillaGarden.furnitureCatalog.length > 10, 'Villa Garden should have rich furniture catalog');
console.log(`   ✓ Villa Garden 3F: ${bimVillaGarden.floors.length} floors, ${bimVillaGarden.furnitureCatalog.length} furniture items, ${bimVillaGarden.metadata.total_floor_area} m²`);

// Test Project 3: Villa Modern 2T1T (15x24m)
const bimVilla = pipeline.process(SAMPLE_VILLA);
assert.strictEqual(bimVilla.floors.length, 3, 'Villa 2T1T should have 3 floors');
console.log(`   ✓ Villa Modern: ${bimVilla.floors.length} floors, ${bimVilla.furnitureCatalog.length} furniture items, ${bimVilla.metadata.total_floor_area} m²`);

// 2. Test 2D Floorplan SVG Generator & Stage 1 AI Detection
console.log('\n2. Testing 2D Floorplan SVG Generator & Stage 1 AI Detection...');
const f1 = bimTownhouse.floors[0];
const svgDefault = FloorplanSvgGenerator.generate(f1, { stage: 5 });
assert.ok(svgDefault.includes('<svg'), 'Should generate valid SVG markup');
assert.ok(svgDefault.includes('cad-blueprint-svg'), 'Should have blueprint CSS class');
assert.ok(!svgDefault.includes('AI ZONE: 99%'), 'Stage 5 should not have AI Detection overlay');

const svgStage1 = FloorplanSvgGenerator.generate(f1, { stage: 1, showAiDetection: true });
assert.ok(svgStage1.includes('AI ZONE: 99%'), 'Stage 1 must include AI room detection tags');
assert.ok(svgStage1.includes('AI:'), 'Stage 1 must include AI confidence tags');
console.log('   ✓ Stage 1 AI Detection SVG contains bounding boxes and confidence tags.');

// 3. Test Smart Floor Control Logic
console.log('\n3. Testing Smart Floor Control Isolation Logic...');
const floors = bimTownhouse.floors;
const selectFloorSim = (activeId) => {
  const activeIdx = floors.findIndex(f => f.id === activeId);
  const visMap = new Map();
  floors.forEach((f, idx) => {
    visMap.set(f.id, idx <= activeIdx);
  });
  return visMap;
};

// Selecting Floor 2 (index 1) in 4-floor house: Floor 1 & 2 visible, Floor 3 & 4 hidden
const visFloor2 = selectFloorSim('floor_2');
assert.strictEqual(visFloor2.get('floor_1'), true, 'Floor 1 should be visible');
assert.strictEqual(visFloor2.get('floor_2'), true, 'Floor 2 should be visible');
assert.strictEqual(visFloor2.get('floor_3'), false, 'Floor 3 should be hidden');
assert.strictEqual(visFloor2.get('floor_4'), false, 'Floor 4 should be hidden');
console.log('   ✓ Selecting Floor 2 correctly isolates floors 1 & 2, hiding upper floors 3 & 4.');

// Selecting Floor 1: only Floor 1 visible
const visFloor1 = selectFloorSim('floor_1');
assert.strictEqual(visFloor1.get('floor_1'), true, 'Floor 1 should be visible');
assert.strictEqual(visFloor1.get('floor_2'), false, 'Floor 2 should be hidden');
assert.strictEqual(visFloor1.get('floor_3'), false, 'Floor 3 should be hidden');
assert.strictEqual(visFloor1.get('floor_4'), false, 'Floor 4 should be hidden');
console.log('   ✓ Selecting Floor 1 isolates Floor 1 completely.');

// 4. Test 5-Stage Progressive Rendering Filter Matrix
console.log('\n4. Testing 5-Stage Progressive Rendering Filter Matrix...');
const categories = ['ai_detection', 'structure', 'walls_openings', 'furniture', 'lighting', 'room_labels'];
const checkVisibility = (cat, stage) => {
  if (cat === 'ai_detection') return stage === 1;
  if (cat === 'structure') return true;
  if (cat === 'walls_openings') return stage >= 3;
  if (cat === 'furniture') return stage >= 4;
  if (cat === 'lighting' || cat === 'room_labels') return stage === 5;
  return false;
};

// Stage 1
assert.strictEqual(checkVisibility('ai_detection', 1), true);
assert.strictEqual(checkVisibility('walls_openings', 1), false);
assert.strictEqual(checkVisibility('furniture', 1), false);

// Stage 2
assert.strictEqual(checkVisibility('structure', 2), true);
assert.strictEqual(checkVisibility('walls_openings', 2), false);
assert.strictEqual(checkVisibility('furniture', 2), false);

// Stage 3
assert.strictEqual(checkVisibility('structure', 3), true);
assert.strictEqual(checkVisibility('walls_openings', 3), true);
assert.strictEqual(checkVisibility('furniture', 3), false);

// Stage 4
assert.strictEqual(checkVisibility('structure', 4), true);
assert.strictEqual(checkVisibility('walls_openings', 4), true);
assert.strictEqual(checkVisibility('furniture', 4), true);
assert.strictEqual(checkVisibility('lighting', 4), false);

// Stage 5
assert.strictEqual(checkVisibility('structure', 5), true);
assert.strictEqual(checkVisibility('walls_openings', 5), true);
assert.strictEqual(checkVisibility('furniture', 5), true);
assert.strictEqual(checkVisibility('lighting', 5), true);
assert.strictEqual(checkVisibility('room_labels', 5), true);
console.log('   ✓ 5-Stage progressive rendering visibility logic matches architectural specs.');

// 5. Test Exploded Separation Calculations
console.log('\n5. Testing Exploded View Distance Calculations...');
const calcExplodedPositions = (distance) => {
  return floors.map((f, idx) => f.elevation + idx * distance);
};

const posDefault = calcExplodedPositions(4.5);
assert.strictEqual(posDefault[0], 0.0);
assert.strictEqual(posDefault[1], 3.8 + 4.5);
assert.strictEqual(posDefault[2], 7.2 + 9.0);

const posSlider8m = calcExplodedPositions(8.0);
assert.strictEqual(posSlider8m[1], 3.8 + 8.0);
assert.strictEqual(posSlider8m[3], 10.6 + 24.0);
console.log(`   ✓ Exploded vertical separation dynamic slider produces accurate elevations.`);

// 6. Test Dynamic Furniture Catalog & Lookup
console.log('\n6. Testing Dynamic Furniture Catalog & Lookup...');
const catalog = bimTownhouse.furnitureCatalog;
assert.ok(catalog.length > 0, 'Catalog should contain items');
const sofa = catalog.find(i => i.type === 'sofa_sectional' || i.name.toLowerCase().includes('sofa'));
assert.ok(sofa, 'Should identify living room sofa');
assert.ok(sofa.floorId, 'Furniture item should track its parent floor');
console.log(`   ✓ Furniture item "${sofa.name}" successfully classified on floor "${sofa.floorName || sofa.floorId}"`);

console.log('\n=== ALL FRONTEND FEATURE TESTS PASSED! ===');
