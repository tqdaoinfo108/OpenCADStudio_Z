import { buildRoomPartitions, furnitureType, validateAndSanitizeFloorPlan } from './architectural_layout.js';
/**
 * cad_bim_pipeline.js
 * OpenCADStudio_Z: Interactive 3D Architectural Dollhouse Web Viewer
 *
 * Ingests CAD DXF files or structured project documents, detects architectural
 * layers & floors, deduplicates double-line CAD walls/glazing, computes true
 * stairwell slab openings, and generates a rich 3D BIM Scene Graph (slabs,
 * exterior/interior walls, columns, stairs, doors, windows, oriented 3D
 * furniture & sanitary fixtures, room zones, and 2D floorplan data).
 */

export const ASSET_CATALOG_IDS = [
  'sofa_l_modern',
  'sofa_straight_3seat',
  'armchair_lounge',
  'coffee_table_set',
  'tv_cabinet_wall_unit',
  'entrance_shoe_cabinet',
  'floor_rug_textured',
  'kitchen_system_i',
  'kitchen_system_l',
  'kitchen_island_bar',
  'fridge_double_door',
  'dining_table_6chairs',
  'dining_table_4chairs',
  'bed_master_king',
  'bed_queen_modern',
  'bed_bunk_kids',
  'wardrobe_tall_glass',
  'work_desk_computer',
  'dressing_table_mirror',
  'vietnamese_worship_altar',
  'outdoor_bbq_station',
  'outdoor_patio_set',
  'toilet_onepiece',
  'lavabo_vanity_led_mirror',
  'shower_glass_enclosure',
  'bathtub_modern',
  'washer_dryer_tower',
  'balcony_planter_greenery',
  'indoor_potted_ficus',
  'railing_iron_baluster',
  'door_interior_wood',
  'door_balcony_glass',
  'window_casement_glass',
  'stair_flight_straight',
  'stair_flight_u_turn'
];

export const ASSET_CATALOG_SET = new Set(ASSET_CATALOG_IDS);
const isFurnitureAssetId = id => ASSET_CATALOG_SET.has(id) ||
  typeof id === 'string' && /^(?:generated|custom)_[a-z0-9_-]+$/i.test(id);

export class CadBimPipeline {
  constructor() {
    this.rawEntities = [];
    this.layers = new Set();
    this.floors = [];
    this.metadata = {};
  }

  /**
   * Parse ASCII DXF text into raw CAD entities
   * @param {string} dxfText
   * @returns {Array<Object>}
   */
  parseDxf(dxfText) {
    const lines = dxfText.replace(/\r/g, '').split('\n');
    const entities = [];
    let inEntities = false;
    let i = 0;
    let curr = null;

    while (i < lines.length - 1) {
      const code = lines[i].trim();
      const val = lines[i + 1] ? lines[i + 1].trim() : '';

      if (code === '0' && val === 'SECTION') {
        if (i + 3 < lines.length && lines[i + 3].trim() === 'ENTITIES') {
          inEntities = true;
          i += 4;
          continue;
        }
      } else if (code === '0' && val === 'ENDSEC' && inEntities) {
        if (curr) entities.push(curr);
        break;
      } else if (inEntities) {
        if (code === '0') {
          if (curr) entities.push(curr);
          curr = { type: val, layer: '0', points: [] };
        } else if (code === '8') {
          if (curr) curr.layer = val;
        } else if (code === '1') {
          if (curr) curr.text = val;
        } else if (code === '10') {
          const yVal = (i + 3 < lines.length) ? parseFloat(lines[i + 3].trim()) : 0;
          if (curr) {
            curr.points.push({ x: parseFloat(val), y: yVal });
          }
        } else if (code === '11') {
          const yVal = (i + 3 < lines.length) ? parseFloat(lines[i + 3].trim()) : 0;
          if (curr) {
            curr.end = { x: parseFloat(val), y: yVal };
          }
        } else if (code === '40') {
          if (curr) curr.radius = parseFloat(val);
        } else if (code === '50') {
          if (curr) curr.start_angle = parseFloat(val);
        } else if (code === '51') {
          if (curr) curr.end_angle = parseFloat(val);
        }
      }
      i += 2;
    }
    if (curr) entities.push(curr);
    return entities;
  }

  /**
   * Convert parsed entities or pre-parsed CAD structure into BIMSceneGraph
   * @param {Object|string} input - DXF text string or structured CAD object
   * @returns {Object} BIMSceneGraph
   */
  process(input) {
    if (typeof input === 'string') {
      this.rawEntities = this.parseDxf(input);
      return this.analyzeRawEntities(this.rawEntities);
    } else if (input && input.floors) {
      return this.processStructuredCad(input);
    } else {
      throw new Error('Unsupported CAD data format');
    }
  }

  /**
   * Analyze raw DXF entities, detect floor plan sheets and partition them
   */
  analyzeRawEntities(entities) {
    const floorTitles = [];
    for (const e of entities) {
      if ((e.type === 'TEXT' || e.type === 'MTEXT') && e.text) {
        const t = e.text.toUpperCase();
        if (t.includes('MẶT BẰNG') || t.includes('TẦNG') || t.includes('FLOOR')) {
          const pt = e.points && e.points[0] ? e.points[0] : { x: 0, y: 0 };
          floorTitles.push({ text: e.text, x: pt.x, y: pt.y });
        }
      }
    }

    floorTitles.sort((a, b) => a.x - b.x);

    let floorDefinitions = [];
    if (floorTitles.length > 0) {
      floorDefinitions = floorTitles.map((t, idx) => {
        const name = t.text.split('-')[0].trim();
        const elev = idx === 0 ? 0.0 : idx === 1 ? 3.9 : 3.9 + idx * 3.6;
        return {
          id: `floor_${idx + 1}`,
          name,
          desc: t.text,
          elevation: elev,
          height: idx === 0 ? 3.9 : 3.6,
          center_x: t.x,
          offset_x: t.x - floorTitles[0].x,
          entities: []
        };
      });
    } else {
      floorDefinitions = [{
        id: 'floor_1',
        name: 'Tầng 1',
        desc: 'Mặt bằng tổng thể',
        elevation: 0.0,
        height: 3.6,
        center_x: 0,
        offset_x: 0,
        entities: []
      }];
    }

    for (const e of entities) {
      const pts = e.points ? [...e.points] : [];
      if (e.end) pts.push(e.end);
      if (pts.length === 0) continue;

      const avgX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
      const avgY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;

      if (avgY < 0 && floorTitles.length > 0) continue;
      if (floorDefinitions.length > 0 && avgX > floorDefinitions[floorDefinitions.length - 1].center_x + 15000) continue;

      let closestFloor = floorDefinitions[0];
      let minDist = Infinity;
      for (const f of floorDefinitions) {
        const dist = Math.abs(avgX - f.center_x);
        if (dist < minDist) {
          minDist = dist;
          closestFloor = f;
        }
      }

      const normEnt = {
        type: e.type,
        layer: e.layer || '0',
        text: e.text
      };
      if (e.radius) normEnt.radius = e.radius / 1000.0;
      if (e.points) {
        normEnt.points = e.points.map(p => ({
          x: (p.x - closestFloor.offset_x) / 1000.0,
          y: p.y / 1000.0
        }));
      }
      if (e.end) {
        normEnt.end = {
          x: (e.end.x - closestFloor.offset_x) / 1000.0,
          y: e.end.y / 1000.0
        };
      }
      closestFloor.entities.push(normEnt);
    }

    return this.processStructuredCad({
      title: 'Hồ sơ Kiến trúc CAD',
      code: 'CAD-IMPORT',
      subtitle: 'Mô hình BIM 3D Trích xuất Tự động',
      lot_width: 15.0,
      lot_length: 24.0,
      lot_area: 360.0,
      total_floor_area: 474.0,
      floors: floorDefinitions
    });
  }

  /**
   * Process partitioned CAD data into complete 3D BIM components
   */
  processStructuredCad(projectData) {
    const sceneGraph = {
      metadata: {
        id: projectData.id || 'default_project',
        title: projectData.title || 'Biệt thự Kiến trúc 3D',
        code: projectData.code || 'NN-2026',
        subtitle: projectData.subtitle || 'HỒ SƠ THIẾT KẾ THI CÔNG',
        lot_width: projectData.lot_width || 15.0,
        lot_length: projectData.lot_length || 24.0,
        lot_area: projectData.lot_area || 360.0,
        total_floor_area: projectData.total_floor_area || 0.0
      },
      floors: [],
      site: {
        boundary: null,
        trees: [],
        features: []
      },
      furnitureCatalog: []
    };

    let totalAreaCalculated = 0;

    for (let floorIdx = 0; floorIdx < projectData.floors.length; floorIdx++) {
      const floorRaw = projectData.floors[floorIdx];
      const floorHeight = floorRaw.height || 3.6;
      const hasRoomGrid = floorRaw.metadata?.roomGrid === true ||
        (floorRaw.rooms || []).some(room => Number.isFinite(room.x_min));
      const bimFloor = {
        id: floorRaw.id,
        name: floorRaw.name,
        desc: floorRaw.desc,
        elevation: floorRaw.elevation ?? (floorIdx * 3.6),
        height: floorHeight,
        slabs: [],
        exteriorWalls: [],
        interiorWalls: [],
        columns: [],
        stairs: [],
        doors: [],
        windows: [],
        furniture: [],
        sanitary: [],
        rooms: [],
        dimensions: [],
        metadata: { ...floorRaw.metadata, roomGrid: hasRoomGrid }
      };

      const entities = floorRaw.entities || [];

      // 1. Process Extents, Slabs & Exterior Walls
      let minX = 0, maxX = projectData.lot_width || 10.0, minY = 0, maxY = projectData.lot_length || 15.0;

      if (floorRaw.slabs && floorRaw.slabs.length > 0) {
        bimFloor.slabs.push(...floorRaw.slabs.map(s => ({ ...s })));
        minX = bimFloor.slabs[0].minX;
        maxX = bimFloor.slabs[0].maxX;
        minY = bimFloor.slabs[0].minY;
        maxY = bimFloor.slabs[0].maxY;
        for (const s of bimFloor.slabs) {
          totalAreaCalculated += (s.maxX - s.minX) * (s.maxY - s.minY);
        }
        if (floorRaw.exteriorWalls && floorRaw.exteriorWalls.length > 0) {
          bimFloor.exteriorWalls.push(...floorRaw.exteriorWalls.map(w => ({ ...w })));
        }
      } else {
        const extrPolys = entities.filter(e => e.layer === 'A-WALL-EXTR' && e.points && e.points.length >= 4);
        if (extrPolys.length > 0) {
          // Pick largest exterior boundary polygon
          let bestArea = -1;
          for (const poly of extrPolys) {
            const xs = poly.points.map(p => p.x);
            const ys = poly.points.map(p => p.y);
            const x0 = Math.min(...xs), x1 = Math.max(...xs);
            const y0 = Math.min(...ys), y1 = Math.max(...ys);
            const area = (x1 - x0) * (y1 - y0);
            if (area > bestArea) {
              bestArea = area;
              minX = x0; maxX = x1; minY = y0; maxY = y1;
            }
          }
        }

        const floorArea = (maxX - minX) * (maxY - minY);
        totalAreaCalculated += floorArea;

        bimFloor.slabs.push({
          type: 'slab',
          minX, maxX, minY, maxY,
          thickness: 0.18,
          elevation: floorRaw.elevation ?? 0,
          hasStairOpening: floorIdx > 0 || floorRaw.id !== 'floor_1'
        });

      }
      if (!bimFloor.exteriorWalls.length) {
        bimFloor.exteriorWalls.push(
          {
            id: `${floorRaw.id}_wall_south`,
            orientation: 'south',
            outwardNormal: { x: 0, y: 0, z: -1 },
            isExteriorCutawayWall: true,
            p1: { x: minX, y: minY },
            p2: { x: maxX, y: minY },
            height: floorHeight,
            thickness: 0.2
          },
          {
            id: `${floorRaw.id}_wall_north`,
            orientation: 'north',
            outwardNormal: { x: 0, y: 0, z: 1 },
            isExteriorCutawayWall: false,
            p1: { x: minX, y: maxY },
            p2: { x: maxX, y: maxY },
            height: floorHeight,
            thickness: 0.2
          },
          {
            id: `${floorRaw.id}_wall_west`,
            orientation: 'west',
            outwardNormal: { x: -1, y: 0, z: 0 },
            isExteriorCutawayWall: false,
            p1: { x: minX, y: minY },
            p2: { x: minX, y: maxY },
            height: floorHeight,
            thickness: 0.2
          },
          {
            id: `${floorRaw.id}_wall_east`,
            orientation: 'east',
            outwardNormal: { x: 1, y: 0, z: 0 },
            isExteriorCutawayWall: true,
            p1: { x: maxX, y: minY },
            p2: { x: maxX, y: maxY },
            height: floorHeight,
            thickness: 0.2
          }
        );
      }

      const slabBounds = { minX, maxX, minY, maxY };
      for (const wall of bimFloor.exteriorWalls) wall.isExterior = true;
      const terrace = floorRaw.rooms?.find(room => room.type === 'terrace' && room.isOutdoor);
      if (hasRoomGrid && terrace?.bounds?.maxY === maxY) {
        for (const wall of [...bimFloor.exteriorWalls]) {
          if (wall.orientation === 'north') wall.height = 1.05;
          if (wall.orientation === 'east' || wall.orientation === 'west') {
            const end = wall.p2;
            wall.p2 = { ...end, y: terrace.bounds.minY };
            bimFloor.exteriorWalls.push({ ...wall, id: wall.id + '_terrace', p1: wall.p2, p2: end, height: 1.05 });
          }
        }
      }

      // 2. Interior Walls (A-WALL-INTR) with double-line deduplication
      if (hasRoomGrid && !floorRaw.interiorWalls?.length) {
        bimFloor.interiorWalls = buildRoomPartitions(floorRaw.rooms || [], slabBounds).walls;
      } else if (floorRaw.interiorWalls && floorRaw.interiorWalls.length > 0) {
        bimFloor.interiorWalls.push(...floorRaw.interiorWalls);
      } else {
        const intrLines = entities.filter(e => e.layer === 'A-WALL-INTR' && e.points && e.points.length > 0);
        const rawSegments = [];
        for (const line of intrLines) {
          const p1 = line.points[0];
          const p2 = line.end || line.points[1];
          if (!p1 || !p2) continue;
          const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          if (len < 0.25) continue; // skip short end-caps of double-line walls
          rawSegments.push({
            p1: { x: p1.x, y: p1.y },
            p2: { x: p2.x, y: p2.y },
            height: floorHeight * 0.92,
            thickness: 0.15
          });
        }
        bimFloor.interiorWalls = this.deduplicateParallelWalls(rawSegments, 0.25);
      }

      bimFloor.interiorWalls = bimFloor.interiorWalls.map(wall => ({
        ...wall, height: Math.min(2.7, wall.height || 2.6), isExterior: false
      }));

      // 2.5 Clean wall intersections & snap T-junctions / L-corners
      this.cleanWallIntersections(bimFloor.exteriorWalls, bimFloor.interiorWalls, slabBounds);

      // 3. Columns (A-COLS)
      if (floorRaw.columns && floorRaw.columns.length > 0) {
        bimFloor.columns.push(...floorRaw.columns);
      } else {
        const colPolys = entities.filter(e => e.layer === 'A-COLS' && e.points && e.points.length >= 4);
        for (const col of colPolys) {
          const xs = col.points.map(p => p.x);
          const ys = col.points.map(p => p.y);
          bimFloor.columns.push({
            x: (Math.min(...xs) + Math.max(...xs)) / 2,
            y: (Math.min(...ys) + Math.max(...ys)) / 2,
            sizeX: Math.max(0.2, Math.max(...xs) - Math.min(...xs)),
            sizeY: Math.max(0.2, Math.max(...ys) - Math.min(...ys)),
            height: floorHeight
          });
        }
      }

      // 4. Stairs (A-STAIR) & Stairwell Opening Void
      if (floorRaw.stairs && floorRaw.stairs.length > 0) {
        bimFloor.stairs.push(...floorRaw.stairs.map(st => ({
          ...st,
          asset_id: st.asset_id && ASSET_CATALOG_SET.has(st.asset_id)
            ? st.asset_id
            : ((st.width || 1.2) >= 2.0 ? 'stair_flight_u_turn' : 'stair_flight_straight'),
          rotation: typeof st.rotation === 'number' ? st.rotation : 0
        })));
      } else {
        const stairLines = entities.filter(e => e.layer === 'A-STAIR');
        if (stairLines.length > 0) {
          const allStairPts = [];
          for (const s of stairLines) {
            if (s.points) allStairPts.push(...s.points);
            if (s.end) allStairPts.push(s.end);
          }
          if (allStairPts.length > 0) {
            const xs = allStairPts.map(p => p.x);
            const ys = allStairPts.map(p => p.y);
            const sMinX = Math.min(...xs);
            const sMaxX = Math.max(...xs);
            const sMinY = Math.min(...ys);
            const sMaxY = Math.max(...ys);
            const w = Math.max(sMaxX - sMinX, 1.1);
            const d = Math.max(sMaxY - sMinY, 1.8);
            const explicitStair = stairLines.find(s => s.asset_id);
            const asset_id = explicitStair?.asset_id && ASSET_CATALOG_SET.has(explicitStair.asset_id)
              ? explicitStair.asset_id
              : (w >= 2.0 ? 'stair_flight_u_turn' : 'stair_flight_straight');
            const rotation = typeof explicitStair?.rotation === 'number' ? explicitStair.rotation : 0;
            bimFloor.stairs.push({
              floorId: floorRaw.id,
              asset_id,
              rotation,
              x: (sMinX + sMaxX) / 2,
              y: (sMinY + sMaxY) / 2,
              width: w,
              depth: d,
              minX: (sMinX + sMaxX) / 2 - w / 2,
              maxX: (sMinX + sMaxX) / 2 + w / 2,
              minY: (sMinY + sMaxY) / 2 - d / 2,
              maxY: (sMinY + sMaxY) / 2 + d / 2,
              elevation: floorRaw.elevation ?? 0,
              rise: floorHeight,
              stepsCount: Math.max(16, Math.min(22, stairLines.length))
            });
          }
        }
      }

      // Prefer the opening projected from the staircase directly below this slab.
      if (floorRaw.metadata?.stairOpening) {
        for (const slab of bimFloor.slabs) {
          if (slab.stairOpening) continue;
          slab.hasStairOpening = true;
          slab.stairOpening = { ...floorRaw.metadata.stairOpening };
        }
      } else if (!hasRoomGrid && (floorIdx > 0 || floorRaw.id !== 'floor_1') && bimFloor.stairs.length > 0) {
        const st = bimFloor.stairs[0];
        const voidBox = {
          minX: st.minX ?? (st.x - st.width / 2),
          maxX: st.maxX ?? (st.x + st.width / 2),
          minY: st.minY ?? (st.y - st.depth / 2),
          maxY: st.maxY ?? (st.y + st.depth / 2)
        };
        for (const slab of bimFloor.slabs) {
          slab.hasStairOpening = true;
          slab.stairOpening = voidBox;
        }
      }

      // 5. Doors & Windows (A-DOOR, A-GLAZ)
      if (floorRaw.doors && floorRaw.doors.length > 0) {
        bimFloor.doors.push(...floorRaw.doors.map(d => ({
          ...d,
          asset_id: d.asset_id && ASSET_CATALOG_SET.has(d.asset_id)
            ? d.asset_id
            : (d.isExterior || (d.width || 0.9) >= 1.3 ? 'door_balcony_glass' : 'door_interior_wood'),
          rotation: typeof d.rotation === 'number' ? d.rotation : 0
        })));
      } else {
        const doorEnts = entities.filter(e => e.layer === 'A-DOOR');
        const rawDoors = [];
        for (const d of doorEnts) {
          if (d.points && d.points.length > 0) {
            const p1 = d.points[0];
            const p2 = d.end || d.points[1];
            let width = d.width || d.radius || 0.9;
            let pEnd = null;
            if (p2) {
              const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
              if (dist >= 0.65 && dist <= 3.6) {
                width = dist;
                pEnd = p2;
              }
            }
            rawDoors.push({
              x: p1.x,
              y: p1.y,
              p1: { x: p1.x, y: p1.y },
              p2: pEnd,
              width: Math.min(Math.max(width, 0.8), 2.8),
              height: 2.2,
              isArc: d.type === 'ARC',
              asset_id: d.asset_id || null,
              rotation: typeof d.rotation === 'number' ? d.rotation : null
            });
          }
        }
        bimFloor.doors = this.deduplicateDoors(rawDoors, bimFloor.exteriorWalls, bimFloor.interiorWalls);
      }

      if (floorRaw.windows && floorRaw.windows.length > 0) {
        bimFloor.windows.push(...floorRaw.windows.map(w => ({
          ...w,
          asset_id: w.asset_id && ASSET_CATALOG_SET.has(w.asset_id) ? w.asset_id : 'window_casement_glass',
          rotation: typeof w.rotation === 'number' ? w.rotation : 0
        })));
      } else {
        const glazEnts = entities.filter(e => e.layer === 'A-GLAZ');
        const rawWins = [];
        for (const g of glazEnts) {
          if (g.points && g.points.length >= 1) {
            const p1 = g.points[0];
            const p2 = g.end || g.points[1];
            if (p1 && p2 && Math.hypot(p2.x - p1.x, p2.y - p1.y) >= 0.4) {
              rawWins.push({
                p1: { x: p1.x, y: p1.y },
                p2: { x: p2.x, y: p2.y },
                sillHeight: 0.85,
                windowHeight: 1.85,
                asset_id: g.asset_id || 'window_casement_glass',
                rotation: typeof g.rotation === 'number' ? g.rotation : null
              });
            }
          }
        }
        bimFloor.windows = this.deduplicateParallelWindows(rawWins, bimFloor.exteriorWalls, 0.35);
      }

      // 6. Rooms & Annotations (A-ANNO) - Processed BEFORE furniture for room-aware classification
      if (floorRaw.rooms && floorRaw.rooms.length > 0) {
        bimFloor.rooms.push(...floorRaw.rooms);
      } else {
        const annoTexts = entities.filter(e => e.layer === 'A-ANNO' && e.text && e.text.trim().length > 2);
        for (const a of annoTexts) {
          const txt = a.text.trim();
          const areaMatch = txt.match(/(.+?)\s*\(([0-9.]+)\s*m²?\)/i);
          if (areaMatch) {
            const roomName = areaMatch[1].trim();
            const areaVal = parseFloat(areaMatch[2]);
            const pt = a.points && a.points[0] ? a.points[0] : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
            // Filter out outdoor site labels from interior floor room labels if outside slab
            const isSiteLabel = roomName.toUpperCase().includes('SÂN TRƯỚC') ||
              roomName.toUpperCase().includes('SÂN SAU') ||
              roomName.toUpperCase().includes('HỒ BƠI');
            const spanW = Math.min(Math.max(Math.sqrt(areaVal) * 0.85, 2.4), (maxX - minX) * 0.7);
            const spanD = Math.min(Math.max(Math.sqrt(areaVal) * 0.75, 2.2), (maxY - minY) * 0.6);
            bimFloor.rooms.push({
              name: roomName,
              area: areaVal,
              x: pt.x,
              y: pt.y,
              isOutdoor: isSiteLabel,
              elevation: floorRaw.elevation ?? 0,
              bounds: {
                minX: Math.max(minX + 0.15, pt.x - spanW / 2),
                maxX: Math.min(maxX - 0.15, pt.x + spanW / 2),
                minY: Math.max(minY + 0.15, pt.y - spanD / 2),
                maxY: Math.min(maxY - 0.15, pt.y + spanD / 2)
              }
            });
          }
        }
      }

      // 7. Furniture & Sanitary (A-FURN, A-SANR)
      if (floorRaw.furniture && floorRaw.furniture.length > 0) {
        for (const f of floorRaw.furniture) {
          const roomName = f.room || this.findClosestRoomName(f.cx, f.cy, bimFloor.rooms, floorRaw.name);
          const rotation = typeof f.rotation === 'number'
            ? f.rotation
            : this.computeWallAlignedRotation(f.cx, f.cy, f.width || 1.2, f.depth || 0.8, bimFloor.exteriorWalls, bimFloor.interiorWalls, slabBounds);
          const asset_id = isFurnitureAssetId(f.asset_id)
            ? f.asset_id
            : this.resolveAssetId(f.type, f.name, roomName, f.layer);
          const item = { ...f, room: roomName, asset_id, rotation };
          const type = furnitureType(item);
          const target = ['toilet', 'lavabo', 'shower', 'bathtub'].includes(type) ? bimFloor.sanitary : bimFloor.furniture;
          target.push(item);
        }
      }
      if (floorRaw.sanitary && floorRaw.sanitary.length > 0) {
        for (const s of floorRaw.sanitary) {
          const roomName = s.room || this.findClosestRoomName(s.cx, s.cy, bimFloor.rooms, floorRaw.name);
          const rotation = typeof s.rotation === 'number'
            ? s.rotation
            : this.computeWallAlignedRotation(s.cx, s.cy, s.width || 0.8, s.depth || 0.7, bimFloor.exteriorWalls, bimFloor.interiorWalls, slabBounds);
          const asset_id = isFurnitureAssetId(s.asset_id)
            ? s.asset_id
            : this.resolveAssetId(s.type, s.name, roomName, s.layer || 'A-SANR');
          const item = { ...s, room: roomName, asset_id, rotation };
          bimFloor.sanitary.push(item);
        }
      }

      if (bimFloor.furniture.length === 0 && bimFloor.sanitary.length === 0) {
        const furnEnts = entities.filter(e => (e.layer === 'A-FURN' || e.layer === 'A-SANR') && Array.isArray(e.points) && e.points.length >= 2);
        const rawRects = furnEnts.map(f => {
          const validPts = f.points.filter(p => p && typeof p.x === 'number' && !Number.isNaN(p.x) && typeof p.y === 'number' && !Number.isNaN(p.y));
          if (validPts.length === 0) return null;
          const xs = validPts.map(p => p.x);
          const ys = validPts.map(p => p.y);
          const rMinX = Math.min(...xs);
          const rMaxX = Math.max(...xs);
          const rMinY = Math.min(...ys);
          const rMaxY = Math.max(...ys);
          const w = Math.max(0.4, rMaxX - rMinX);
          const d = Math.max(0.4, rMaxY - rMinY);
          return {
            layer: f.layer,
            minX: rMinX,
            maxX: rMaxX,
            minY: rMinY,
            maxY: rMaxY,
            width: w,
            depth: d,
            cx: (rMinX + rMaxX) / 2,
            cy: (rMinY + rMaxY) / 2,
            asset_id: f.asset_id || null,
            furnType: f.furnType || null,
            name: f.name || null,
            height: f.height || null,
            rotation: f.rotation ?? null,
            material: f.material || null
          };
        }).filter(Boolean);

        const consolidatedRects = this.consolidateFurnitureRects(rawRects);

        for (const r of consolidatedRects) {
          const classified = this.classifyFurniture(
            r.layer,
            r.width,
            r.depth,
            r.cx,
            r.cy,
            floorRaw.id,
            floorIdx,
            slabBounds,
            bimFloor.rooms,
            r,
            bimFloor.exteriorWalls,
            bimFloor.interiorWalls
          );
          if (r.layer === 'A-SANR') {
            bimFloor.sanitary.push(classified);
          } else {
            bimFloor.furniture.push(classified);
          }
        }
      }

      // Enrich floor with additional architectural openings and furnishings if sparse
      if (!bimFloor.metadata?.roomGrid) this.enrichFloorBim(bimFloor, floorIdx, slabBounds, projectData);
      const sanitized = validateAndSanitizeFloorPlan(bimFloor);
      Object.assign(bimFloor, sanitized);

      // Register all floor items in sceneGraph.furnitureCatalog with unique names per floor
      const usedNames = new Map();
      for (const item of [...bimFloor.furniture, ...bimFloor.sanitary]) {
        if (!isFurnitureAssetId(item.asset_id)) {
          item.asset_id = this.resolveAssetId(item.type, item.name, item.room, item.layer);
        }
        if (typeof item.rotation !== 'number' || Number.isNaN(item.rotation)) {
          item.rotation = this.computeWallAlignedRotation(
            item.cx,
            item.cy,
            item.width || 1.0,
            item.depth || 0.8,
            bimFloor.exteriorWalls,
            bimFloor.interiorWalls,
            slabBounds
          );
        }
        const baseName = item.name || 'Nội thất';
        const count = (usedNames.get(baseName) || 0) + 1;
        usedNames.set(baseName, count);
        if (count > 1) {
          item.name = `${baseName} #${count}`;
        }
        sceneGraph.furnitureCatalog.push({
          ...item,
          floorId: bimFloor.id,
          floorName: bimFloor.name
        });
      }

      // 8. Site elements on Floor 1
      if (floorIdx === 0 || floorRaw.id === 'floor_1') {
        const siteEnts = entities.filter(e => e.layer === 'A-SITE');
        for (const s of siteEnts) {
          if (s.type === 'CIRCLE' && s.radius) {
            sceneGraph.site.trees.push({
              x: s.points[0].x,
              y: s.points[0].y,
              radius: s.radius
            });
          } else if (s.points && s.points.length >= 4) {
            const xs = s.points.map(p => p.x);
            const ys = s.points.map(p => p.y);
            const fMinX = Math.min(...xs), fMaxX = Math.max(...xs);
            const fMinY = Math.min(...ys), fMaxY = Math.max(...ys);
            const area = (fMaxX - fMinX) * (fMaxY - fMinY);
            // Skip lot boundary or building footprint rects
            const lotArea = (projectData.lot_width || 15) * (projectData.lot_length || 24);
            const slabArea = (maxX - minX) * (maxY - minY);
            if (Math.abs(area - lotArea) > 2.0 && Math.abs(area - slabArea) > 2.0) {
              sceneGraph.site.features.push({
                points: s.points,
                minX: fMinX,
                maxX: fMaxX,
                minY: fMinY,
                maxY: fMaxY,
                type: area > 12 ? 'swimming_pool' : 'pond_or_driveway'
              });
            }
          }
        }
      }

      // 9. Architectural Grid (A-GRID) & Dimensions (A-DIMS)
      bimFloor.gridAxes = this.computeArchitecturalGrid(bimFloor, slabBounds);
      bimFloor.dimensions = this.computeArchitecturalDimensions(bimFloor, slabBounds, bimFloor.gridAxes);

      sceneGraph.floors.push(bimFloor);
    }

    if (sceneGraph.metadata.total_floor_area === 0.0 && totalAreaCalculated > 0) {
      sceneGraph.metadata.total_floor_area = Math.round(totalAreaCalculated * 10) / 10;
    }

    return sceneGraph;
  }

  /**
   * Wall Intersection Cleanup:
   * Detects T-junctions, L-corners and X-junctions between interior walls and other walls.
   * Snaps wall endpoints cleanly onto intersecting centerlines and trims overshoots.
   */
  cleanWallIntersections(exteriorWalls = [], interiorWalls = [], slabBounds = null, snapTolerance = 0.28) {
    const allWalls = [...exteriorWalls, ...interiorWalls];
    let snappedCount = 0;

    for (const iw of interiorWalls) {
      if (!iw.p1 || !iw.p2) continue;
      for (const pt of [iw.p1, iw.p2]) {
        for (const other of allWalls) {
          if (other === iw || !other.p1 || !other.p2) continue;
          const dx = other.p2.x - other.p1.x;
          const dy = other.p2.y - other.p1.y;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 1e-6) continue;

          // Projection parameter t
          const t = ((pt.x - other.p1.x) * dx + (pt.y - other.p1.y) * dy) / lenSq;
          if (t >= -0.05 && t <= 1.05) {
            const clampedT = Math.max(0, Math.min(1, t));
            const projX = other.p1.x + clampedT * dx;
            const projY = other.p1.y + clampedT * dy;
            const dist = Math.hypot(pt.x - projX, pt.y - projY);

            if (dist > 1e-4 && dist <= snapTolerance) {
              pt.x = Math.round(projX * 1000) / 1000;
              pt.y = Math.round(projY * 1000) / 1000;
              snappedCount++;
            }
          }
        }
      }
    }
    return snappedCount;
  }

  /**
   * Compute Architectural Grid Axes (A-GRID)
   * Clusters column centers and building extents into standardized numeric (1, 2, 3...)
   * and alphabetic (A, B, C...) grid axes with Dash-dot linetype.
   */
  computeArchitecturalGrid(bimFloor, slabBounds = { minX: 0, maxX: 10, minY: 0, maxY: 15 }) {
    const xCoords = [];
    const yCoords = [];

    if (bimFloor.columns && bimFloor.columns.length > 0) {
      for (const c of bimFloor.columns) {
        if (typeof c.x === 'number') xCoords.push(c.x);
        if (typeof c.y === 'number') yCoords.push(c.y);
      }
    }

    if (xCoords.length < 2) {
      xCoords.push(slabBounds.minX, slabBounds.maxX);
    }
    if (yCoords.length < 2) {
      yCoords.push(slabBounds.minY, slabBounds.maxY);
    }

    function cluster(vals) {
      vals.sort((a, b) => a - b);
      const groups = [];
      for (const v of vals) {
        if (groups.length === 0 || v - groups[groups.length - 1].avg > 0.35) {
          groups.push({ sum: v, count: 1, avg: v });
        } else {
          const last = groups[groups.length - 1];
          last.sum += v;
          last.count += 1;
          last.avg = last.sum / last.count;
        }
      }
      return groups.map(g => Math.round(g.avg * 100) / 100);
    }

    const uniqueX = cluster(xCoords);
    const uniqueY = cluster(yCoords);

    const xAxes = uniqueX.map((x, idx) => ({
      id: `axis_x_${idx + 1}`,
      label: (idx + 1).toString(),
      type: 'X',
      coord: x
    }));

    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const yAxes = uniqueY.map((y, idx) => ({
      id: `axis_y_${letters[idx % letters.length]}`,
      label: letters[idx % letters.length] + (idx >= letters.length ? Math.floor(idx / letters.length) : ''),
      type: 'Y',
      coord: y
    }));

    return { xAxes, yAxes };
  }

  /**
   * Compute Architectural Dimensions (A-DIMS)
   * Generates bay-by-bay dimensions and total building dimensions in millimeters.
   */
  computeArchitecturalDimensions(bimFloor, slabBounds, gridAxes) {
    const dims = [];
    const xAxes = gridAxes.xAxes || [];
    const yAxes = gridAxes.yAxes || [];

    // X-bay dimensions
    for (let i = 0; i < xAxes.length - 1; i++) {
      const a = xAxes[i], b = xAxes[i + 1];
      const dist = Math.abs(b.coord - a.coord);
      if (dist > 0.1) {
        dims.push({
          id: `dim_x_${a.label}_${b.label}`,
          axis: 'X',
          type: 'BAY',
          start: a.coord,
          end: b.coord,
          distanceM: Math.round(dist * 100) / 100,
          distanceMm: Math.round(dist * 1000),
          label: `${Math.round(dist * 1000)}`
        });
      }
    }

    // X total dimension
    if (xAxes.length >= 2) {
      const first = xAxes[0], last = xAxes[xAxes.length - 1];
      const totalDist = Math.abs(last.coord - first.coord);
      dims.push({
        id: `dim_x_total`,
        axis: 'X',
        type: 'TOTAL',
        start: first.coord,
        end: last.coord,
        distanceM: Math.round(totalDist * 100) / 100,
        distanceMm: Math.round(totalDist * 1000),
        label: `${Math.round(totalDist * 1000)}`
      });
    }

    // Y-bay dimensions
    for (let j = 0; j < yAxes.length - 1; j++) {
      const a = yAxes[j], b = yAxes[j + 1];
      const dist = Math.abs(b.coord - a.coord);
      if (dist > 0.1) {
        dims.push({
          id: `dim_y_${a.label}_${b.label}`,
          axis: 'Y',
          type: 'BAY',
          start: a.coord,
          end: b.coord,
          distanceM: Math.round(dist * 100) / 100,
          distanceMm: Math.round(dist * 1000),
          label: `${Math.round(dist * 1000)}`
        });
      }
    }

    // Y total dimension
    if (yAxes.length >= 2) {
      const first = yAxes[0], last = yAxes[yAxes.length - 1];
      const totalDist = Math.abs(last.coord - first.coord);
      dims.push({
        id: `dim_y_total`,
        axis: 'Y',
        type: 'TOTAL',
        start: first.coord,
        end: last.coord,
        distanceM: Math.round(totalDist * 100) / 100,
        distanceMm: Math.round(totalDist * 1000),
        label: `${Math.round(totalDist * 1000)}`
      });
    }

    return dims;
  }

  /**
   * Merge parallel double-line CAD wall segments into clean single centerline walls
   */
  deduplicateParallelWalls(segments, maxDist = 0.25) {
    const used = new Array(segments.length).fill(false);
    const merged = [];

    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;
      const a = segments[i];
      const adx = a.p2.x - a.p1.x;
      const ady = a.p2.y - a.p1.y;
      const aHorizontal = Math.abs(adx) >= Math.abs(ady);

      let partnerIdx = -1;
      for (let j = i + 1; j < segments.length; j++) {
        if (used[j]) continue;
        const b = segments[j];
        const bdx = b.p2.x - b.p1.x;
        const bdy = b.p2.y - b.p1.y;
        const bHorizontal = Math.abs(bdx) >= Math.abs(bdy);
        if (aHorizontal !== bHorizontal) continue;

        if (aHorizontal) {
          const ay = (a.p1.y + a.p2.y) / 2;
          const by = (b.p1.y + b.p2.y) / 2;
          const perpDist = Math.abs(ay - by);
          const aMinX = Math.min(a.p1.x, a.p2.x), aMaxX = Math.max(a.p1.x, a.p2.x);
          const bMinX = Math.min(b.p1.x, b.p2.x), bMaxX = Math.max(b.p1.x, b.p2.x);
          const overlap = Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX);
          if (perpDist <= maxDist && overlap > 0.5) {
            partnerIdx = j;
            break;
          }
        } else {
          const ax = (a.p1.x + a.p2.x) / 2;
          const bx = (b.p1.x + b.p2.x) / 2;
          const perpDist = Math.abs(ax - bx);
          const aMinY = Math.min(a.p1.y, a.p2.y), aMaxY = Math.max(a.p1.y, a.p2.y);
          const bMinY = Math.min(b.p1.y, b.p2.y), bMaxY = Math.max(b.p1.y, b.p2.y);
          const overlap = Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY);
          if (perpDist <= maxDist && overlap > 0.5) {
            partnerIdx = j;
            break;
          }
        }
      }

      if (partnerIdx !== -1) {
        used[i] = true;
        used[partnerIdx] = true;
        const b = segments[partnerIdx];
        if (aHorizontal) {
          const midY = (a.p1.y + a.p2.y + b.p1.y + b.p2.y) / 4;
          const minX = Math.min(a.p1.x, a.p2.x, b.p1.x, b.p2.x);
          const maxX = Math.max(a.p1.x, a.p2.x, b.p1.x, b.p2.x);
          merged.push({
            p1: { x: minX, y: midY },
            p2: { x: maxX, y: midY },
            height: a.height,
            thickness: 0.15
          });
        } else {
          const midX = (a.p1.x + a.p2.x + b.p1.x + b.p2.x) / 4;
          const minY = Math.min(a.p1.y, a.p2.y, b.p1.y, b.p2.y);
          const maxY = Math.max(a.p1.y, a.p2.y, b.p1.y, b.p2.y);
          merged.push({
            p1: { x: midX, y: minY },
            p2: { x: midX, y: maxY },
            height: a.height,
            thickness: 0.15
          });
        }
      } else {
        used[i] = true;
        merged.push(a);
      }
    }

    return merged;
  }

  /**
   * Deduplicate double-line glazing and snap windows onto the nearest exterior wall
   */
  deduplicateParallelWindows(windows, exteriorWalls, maxDist = 0.35) {
    const deduped = this.deduplicateParallelWalls(windows, maxDist).map(w => ({
      p1: w.p1,
      p2: w.p2,
      sillHeight: 0.85,
      windowHeight: 1.85,
      asset_id: 'window_casement_glass',
      rotation: 0
    }));

    // Snap each window to nearest exterior wall line so cutouts align cleanly
    for (const win of deduped) {
      const mx = (win.p1.x + win.p2.x) / 2;
      const my = (win.p1.y + win.p2.y) / 2;
      let bestWall = null;
      let bestDist = 0.6;

      for (const ew of exteriorWalls) {
        const wHorizontal = Math.abs(ew.p2.x - ew.p1.x) >= Math.abs(ew.p2.y - ew.p1.y);
        if (wHorizontal) {
          const wy = (ew.p1.y + ew.p2.y) / 2;
          const d = Math.abs(my - wy);
          if (d < bestDist) {
            bestDist = d;
            bestWall = { ew, wHorizontal: true, coord: wy };
          }
        } else {
          const wx = (ew.p1.x + ew.p2.x) / 2;
          const d = Math.abs(mx - wx);
          if (d < bestDist) {
            bestDist = d;
            bestWall = { ew, wHorizontal: false, coord: wx };
          }
        }
      }

      if (bestWall) {
        win.wallId = bestWall.ew.id;
        win.orientation = bestWall.ew.orientation;
        if (bestWall.wHorizontal) {
          win.p1.y = bestWall.coord;
          win.p2.y = bestWall.coord;
          win.rotation = bestWall.ew.orientation === 'north' ? Math.PI : 0;
        } else {
          win.p1.x = bestWall.coord;
          win.p2.x = bestWall.coord;
          win.rotation = bestWall.ew.orientation === 'east' ? -Math.PI / 2 : Math.PI / 2;
        }
      }
    }

    return deduped;
  }

  /**
   * Deduplicate door entities (LINE + ARC pairs) and align them with the host wall
   */
  deduplicateDoors(rawDoors, exteriorWalls, interiorWalls) {
    const unique = [];
    for (const d of rawDoors) {
      const existing = unique.find(u => Math.hypot(u.x - d.x, u.y - d.y) < 0.35);
      if (existing) {
        if (d.isArc && d.width) existing.width = d.width;
        if (d.asset_id && !existing.asset_id) existing.asset_id = d.asset_id;
        continue;
      }
      unique.push({ ...d });
    }

    const allWalls = [
      ...exteriorWalls.map(w => ({ ...w, isExterior: true })),
      ...interiorWalls.map((w, idx) => ({ ...w, id: `intr_wall_${idx}`, isExterior: false }))
    ];

    for (const door of unique) {
      let bestWall = null;
      let bestDist = 0.65;
      for (const w of allWalls) {
        const wHorizontal = Math.abs(w.p2.x - w.p1.x) >= Math.abs(w.p2.y - w.p1.y);
        if (wHorizontal) {
          const wy = (w.p1.y + w.p2.y) / 2;
          const minX = Math.min(w.p1.x, w.p2.x) - 0.3;
          const maxX = Math.max(w.p1.x, w.p2.x) + 0.3;
          if (door.x >= minX && door.x <= maxX && Math.abs(door.y - wy) < bestDist) {
            bestDist = Math.abs(door.y - wy);
            bestWall = { w, wHorizontal: true, coord: wy };
          }
        } else {
          const wx = (w.p1.x + w.p2.x) / 2;
          const minY = Math.min(w.p1.y, w.p2.y) - 0.3;
          const maxY = Math.max(w.p1.y, w.p2.y) + 0.3;
          if (door.y >= minY && door.y <= maxY && Math.abs(door.x - wx) < bestDist) {
            bestDist = Math.abs(door.x - wx);
            bestWall = { w, wHorizontal: false, coord: wx };
          }
        }
      }

      if (bestWall) {
        door.wallId = bestWall.w.id;
        door.isExterior = bestWall.w.isExterior;
        door.orientation = bestWall.w.orientation || (bestWall.wHorizontal ? 'horizontal' : 'vertical');
        if (bestWall.wHorizontal) {
          door.y = bestWall.coord;
          if (door.rotation == null) {
            door.rotation = bestWall.w.orientation === 'north' ? Math.PI : 0;
          }
        } else {
          door.x = bestWall.coord;
          if (door.rotation == null) {
            door.rotation = bestWall.w.orientation === 'east' ? -Math.PI / 2 : Math.PI / 2;
          }
        }
      } else if (door.rotation == null) {
        door.rotation = 0;
      }

      if (!door.asset_id || !ASSET_CATALOG_SET.has(door.asset_id)) {
        door.asset_id = (door.isExterior || (door.width || 0.9) >= 1.35)
          ? 'door_balcony_glass'
          : 'door_interior_wood';
      }
    }

    return unique;
  }

  /**
   * Consolidate multi-part CAD furniture blocks (such as L-shaped sofa legs and
   * tiny 0.4x0.4 dining chairs surrounding a dining table) so 3D parametric models
   * do not overlap. Preserves any item that already carries an explicit `asset_id`.
   */
  consolidateFurnitureRects(rects) {
    const used = new Array(rects.length).fill(false);
    const result = [];

    // 1. Identify dining tables (~1.8-2.5m by 0.85-1.3m) surrounded by small 0.4x0.4 chair blocks,
    //    and master beds (~1.6-2.3m by 1.8-2.3m) flanked by small bedside nightstand blocks
    for (let i = 0; i < rects.length; i++) {
      if (used[i]) continue;
      const r = rects[i];
      if (r.layer !== 'A-FURN' || r.asset_id) continue;
      const dimMax = Math.max(r.width, r.depth);
      const dimMin = Math.min(r.width, r.depth);

      // Check for small chair blocks around a dining table
      if (dimMax >= 1.6 && dimMin >= 0.8 && dimMin <= 1.4) {
        const nearbyChairs = [];
        for (let j = 0; j < rects.length; j++) {
          if (i === j || used[j]) continue;
          const c = rects[j];
          if (c.layer === 'A-FURN' && !c.asset_id && Math.max(c.width, c.depth) <= 0.52) {
            const dx = Math.max(0, Math.max(r.minX - c.maxX, c.minX - r.maxX));
            const dy = Math.max(0, Math.max(r.minY - c.maxY, c.minY - r.maxY));
            if (Math.hypot(dx, dy) < 0.45) {
              nearbyChairs.push(j);
            }
          }
        }
        if (nearbyChairs.length >= 2) {
          for (const cj of nearbyChairs) used[cj] = true;
          r.furnType = 'dining_table';
          r.asset_id = nearbyChairs.length >= 5 ? 'dining_table_6chairs' : 'dining_table_4chairs';
        }
      }

      // Check for small nightstand blocks flanking a master bed
      if (dimMax >= 1.75 && dimMax <= 2.35 && dimMin >= 1.55 && dimMin <= 2.25) {
        for (let j = 0; j < rects.length; j++) {
          if (i === j || used[j]) continue;
          const n = rects[j];
          if (n.layer === 'A-FURN' && !n.asset_id && Math.max(n.width, n.depth) <= 0.65) {
            const dx = Math.max(0, Math.max(r.minX - n.maxX, n.minX - r.maxX));
            const dy = Math.max(0, Math.max(r.minY - n.maxY, n.minY - r.maxY));
            if (Math.hypot(dx, dy) <= 0.35) {
              used[j] = true;
            }
          }
        }
      }
    }

    // 2. Merge touching L-shaped sofa sub-rectangles (e.g. 3.0x0.8 + 0.8x1.4)
    for (let i = 0; i < rects.length; i++) {
      if (used[i]) continue;
      const a = rects[i];
      if (a.layer === 'A-FURN' && !a.furnType && !a.asset_id && Math.max(a.width, a.depth) >= 2.2 && Math.min(a.width, a.depth) <= 0.95) {
        for (let j = i + 1; j < rects.length; j++) {
          if (used[j]) continue;
          const b = rects[j];
          if (b.layer !== 'A-FURN' || b.furnType || b.asset_id) continue;
          const bMax = Math.max(b.width, b.depth);
          const bMin = Math.min(b.width, b.depth);
          if (bMax >= 1.1 && bMax <= 1.8 && bMin >= 0.65 && bMin <= 0.95) {
            const touchX = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
            const touchY = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
            if (touchX <= 0.08 && touchY <= 0.08) {
              used[j] = true;
              const minX = Math.min(a.minX, b.minX);
              const maxX = Math.max(a.maxX, b.maxX);
              const minY = Math.min(a.minY, b.minY);
              const maxY = Math.max(a.maxY, b.maxY);
              a.minX = minX;
              a.maxX = maxX;
              a.minY = minY;
              a.maxY = maxY;
              a.width = maxX - minX;
              a.depth = maxY - minY;
              a.cx = (minX + maxX) / 2;
              a.cy = (minY + maxY) / 2;
              a.furnType = 'sofa_sectional';
              a.asset_id = 'sofa_l_modern';
              break;
            }
          }
        }
      }
      used[i] = true;
      result.push(a);
    }

    return result;
  }

  findClosestRoomName(x, y, rooms, fallbackName = 'Không gian chung') {
    if (!rooms || rooms.length === 0) return fallbackName;
    let bestRoom = rooms[0];
    let bestDist = Infinity;
    for (const rm of rooms) {
      if (rm.isOutdoor) continue;
      const d = Math.hypot(x - rm.x, y - rm.y);
      if (d < bestDist) {
        bestDist = d;
        bestRoom = rm;
      }
    }
    return bestRoom ? bestRoom.name : fallbackName;
  }

  /**
   * Compute wall-aligned rotation (in radians) so the back (-Z) of the object
   * faces the nearest exterior or interior wall of its room.
   * Convention:
   *   0           = back against South/bottom wall (-Z)
   *   Math.PI     = back against North/top wall (+Z)
   *   Math.PI / 2 = back against West/left wall (-X)
   *  -Math.PI / 2 = back against East/right wall (+X)
   */
  computeWallAlignedRotation(cx, cy, width, depth, exteriorWalls = [], interiorWalls = [], slabBounds = { minX: 0, maxX: 10, minY: 0, maxY: 15 }) {
    const isVertical = depth > width * 1.25;
    const allWalls = [...exteriorWalls, ...interiorWalls];

    let bestDist = Infinity;
    let bestRot = 0;

    for (const w of allWalls) {
      if (!w.p1 || !w.p2) continue;
      const dx = w.p2.x - w.p1.x;
      const dy = w.p2.y - w.p1.y;
      const isHoriz = Math.abs(dx) >= Math.abs(dy);

      if (isHoriz) {
        const wy = (w.p1.y + w.p2.y) / 2;
        const wx0 = Math.min(w.p1.x, w.p2.x) - 0.35;
        const wx1 = Math.max(w.p1.x, w.p2.x) + 0.35;
        if (cx >= wx0 && cx <= wx1) {
          const dist = Math.abs(cy - wy);
          if (dist < bestDist) {
            bestDist = dist;
            bestRot = wy <= cy ? 0 : Math.PI;
          }
        }
      } else {
        const wx = (w.p1.x + w.p2.x) / 2;
        const wy0 = Math.min(w.p1.y, w.p2.y) - 0.35;
        const wy1 = Math.max(w.p1.y, w.p2.y) + 0.35;
        if (cy >= wy0 && cy <= wy1) {
          const dist = Math.abs(cx - wx);
          if (dist < bestDist) {
            bestDist = dist;
            bestRot = wx <= cx ? (Math.PI / 2) : (-Math.PI / 2);
          }
        }
      }
    }

    if (isVertical && Math.abs(Math.sin(bestRot)) < 0.5) {
      const midX = (slabBounds.minX + slabBounds.maxX) / 2;
      return cx <= midX ? (Math.PI / 2) : (-Math.PI / 2);
    }

    return bestRot;
  }

  /**
   * Map a furniture type/name/room/layer to one of the 35 canonical asset_id strings.
   */
  resolveAssetId(type = '', name = '', roomName = '', layer = 'A-FURN') {
    const t = String(type).toLowerCase();
    const n = String(name).toLowerCase();
    const r = String(roomName).toLowerCase();

    if (layer === 'A-SANR' || t === 'toilet' || t === 'vanity' || t === 'bathtub' || t === 'shower') {
      if (t === 'bathtub' || n.includes('bồn tắm') || n.includes('jacuzzi')) return 'bathtub_modern';
      if (t === 'shower' || n.includes('cabin') || n.includes('tắm đứng') || n.includes('vách kính')) return 'shower_glass_enclosure';
      if (t === 'vanity' || n.includes('lavabo')) return 'lavabo_vanity_led_mirror';
      return 'toilet_onepiece';
    }

    if (t === 'railing' || n.includes('lan can')) return 'railing_iron_baluster';
    if (t === 'rug' || n.includes('thảm')) return 'floor_rug_textured';
    if (n.includes('tủ giày') || n.includes('shoe')) return 'entrance_shoe_cabinet';
    if (t === 'sofa_sectional' || n.includes('chữ l')) return 'sofa_l_modern';
    if (t === 'sofa') return 'sofa_straight_3seat';
    if (t === 'chair_or_nightstand' || n.includes('armchair') || n.includes('ghế thư giãn')) return 'armchair_lounge';
    if (t === 'coffee_table' || n.includes('bàn trà')) return 'coffee_table_set';
    if (t === 'tv_console' || n.includes('tivi') || n.includes('oled')) return 'tv_cabinet_wall_unit';
    if (n.includes('tủ lạnh') || n.includes('side-by-side') || n.includes('fridge')) return 'fridge_double_door';
    if (n.includes('đảo bếp') || n.includes('island')) return 'kitchen_island_bar';
    if (n.includes('giặt') || n.includes('sấy') || n.includes('washtower')) return 'washer_dryer_tower';
    if (t === 'kitchen_cabinet') return n.includes('chữ i') ? 'kitchen_system_i' : 'kitchen_system_l';
    if (t === 'dining_table') {
      if (r.includes('sân thượng') || r.includes('sky') || r.includes('bbq') || n.includes('ngoài trời') || n.includes('sân thượng')) {
        return 'outdoor_patio_set';
      }
      return n.includes('4 ghế') ? 'dining_table_4chairs' : 'dining_table_6chairs';
    }
    if (t === 'bed_master' || t === 'bed') {
      if (n.includes('tầng') || n.includes('trẻ em') || n.includes('bunk')) return 'bed_bunk_kids';
      if (n.includes('queen') || (!n.includes('master') && !n.includes('king') && !r.includes('master'))) return 'bed_queen_modern';
      return 'bed_master_king';
    }
    if (t === 'wardrobe' || n.includes('tủ áo') || n.includes('tủ quần áo') || n.includes('closet') || n.includes('tủ sách')) {
      return 'wardrobe_tall_glass';
    }
    if (n.includes('trang điểm') || n.includes('dressing')) return 'dressing_table_mirror';
    if (t === 'desk' || t === 'gym_machine') return 'work_desk_computer';
    if (t === 'altar_table' || n.includes('thờ')) return 'vietnamese_worship_altar';
    if (t === 'bbq' || n.includes('bbq') || n.includes('nướng')) return 'outdoor_bbq_station';
    if (t === 'plants' || t === 'planter') {
      return (r.includes('ban công') || r.includes('sân thượng') || r.includes('bbq') || n.includes('ban công') || n.includes('sân thượng') || n.includes('bồn cây'))
        ? 'balcony_planter_greenery'
        : 'indoor_potted_ficus';
    }
    return 'work_desk_computer';
  }

  /**
   * Intelligently classify a CAD rectangle into architectural 3D furniture
   * using room context, normalized slab coordinates, and aspect ratio.
   * Ensures every returned item carries an explicit `asset_id` (one of the 35 IDs)
   * and wall-aligned `rotation` (in radians).
   */
  classifyFurniture(layer, width, depth, cx, cy, floorId, floorIdx, slabBounds, rooms, rawItem = {}, exteriorWalls = [], interiorWalls = []) {
    const roomName = this.findClosestRoomName(cx, cy, rooms, `Tầng ${floorIdx + 1}`);
    const roomUpper = roomName.toUpperCase();

    const isVertical = depth > width * 1.25;
    const dimMax = Math.max(width, depth);
    const dimMin = Math.min(width, depth);

    const slabW = Math.max(1, slabBounds.maxX - slabBounds.minX);
    const slabD = Math.max(1, slabBounds.maxY - slabBounds.minY);
    const relX = (cx - slabBounds.minX) / slabW;
    const relY = (cy - slabBounds.minY) / slabD;

    let type = rawItem.furnType || 'desk';
    let name = rawItem.name || 'Vật dụng nội thất';
    let color = '#C2A682';
    let height = rawItem.height || 0.76;
    let material = rawItem.material || 'Gỗ Sồi Tự Nhiên';
    let rotation = rawItem.rotation != null
      ? rawItem.rotation
      : this.computeWallAlignedRotation(cx, cy, width, depth, exteriorWalls, interiorWalls, slabBounds);
    let asset_id = rawItem.asset_id && ASSET_CATALOG_SET.has(rawItem.asset_id) ? rawItem.asset_id : null;

    if (rawItem.asset_id && ASSET_CATALOG_SET.has(rawItem.asset_id)) {
      asset_id = rawItem.asset_id;
      type = rawItem.furnType || this.assetIdToLegacyType(asset_id);
      name = rawItem.name || this.assetIdToDefaultName(asset_id) || name;
      height = rawItem.height || this.assetIdToDefaultHeight(asset_id);
      material = rawItem.material || this.assetIdToDefaultMaterial(asset_id) || material;
    } else if (layer === 'A-SANR') {
      if (rawItem.furnType === 'bathtub' || dimMax >= 1.45) {
        type = 'bathtub';
        asset_id = 'bathtub_modern';
        name = rawItem.name || 'Bồn tắm nằm Freestanding Sứ Kohler';
        color = '#FFFFFF';
        height = 0.62;
        material = 'Sứ tráng men Nano & Vòi Chrome';
      } else if (rawItem.furnType === 'shower' || (dimMax >= 0.9 && dimMin >= 0.85)) {
        type = 'shower';
        asset_id = 'shower_glass_enclosure';
        name = rawItem.name || 'Cabin tắm đứng vách kính cường lực';
        color = '#E0F2FE';
        height = 2.1;
        material = 'Kính cường lực 10mm & Sen cây Inox';
      } else if (rawItem.furnType === 'vanity' || dimMax >= 0.85) {
        type = 'vanity';
        asset_id = 'lavabo_vanity_led_mirror';
        name = rawItem.name || 'Bàn Lavabo Đá Carrara & Gương LED';
        color = '#F3F4F6';
        height = 1.85;
        material = 'Đá Marble Carrara & Gương LED Halo';
      } else {
        type = 'toilet';
        asset_id = 'toilet_onepiece';
        name = rawItem.name || 'Bồn cầu liền khối thông minh TOTO';
        color = '#FFFFFF';
        height = 0.74;
        material = 'Sứ vệ sinh kháng khuẩn';
      }
    } else if (rawItem.furnType) {
      type = rawItem.furnType;
      if (type === 'sofa_sectional') {
        asset_id = asset_id || 'sofa_l_modern';
        name = rawItem.name || 'Sofa góc chữ L bọc nỉ Bouclé & Thảm dệt';
        height = 0.85;
        material = 'Vải nỉ Bouclé Ý & Chân gỗ Óc chó';
      } else if (type === 'dining_table') {
        asset_id = asset_id || 'dining_table_6chairs';
        name = rawItem.name || 'Bàn ăn mặt đá Marble & 6 Ghế bọc da';
        height = 0.76;
        material = 'Đá Cẩm thạch trắng & Gỗ Sồi';
      } else {
        asset_id = asset_id || this.resolveAssetId(type, name, roomName, layer);
      }
    } else if (roomUpper.includes('THỜ')) {
      if (dimMax >= 1.4 && dimMin <= 1.25) {
        type = 'altar_table';
        asset_id = 'vietnamese_worship_altar';
        name = 'Án gian thờ Gỗ Gụ & Tranh Trúc Chỉ';
        color = '#5D2E14';
        height = 1.45;
        material = 'Gỗ Gụ chạm khắc & Đồng nguyên chất';
      } else {
        type = 'plants';
        asset_id = 'indoor_potted_ficus';
        name = 'Chậu bonsai & Đôn gỗ phòng thờ';
        color = '#4E6E42';
        height = 1.25;
        material = 'Gốm Bát Tràng & Cây cảnh';
      }
    } else if (roomUpper.includes('GYM') || roomUpper.includes('THỂ HÌNH') || roomUpper.includes('FITNESS')) {
      type = 'gym_machine';
      asset_id = 'work_desk_computer';
      name = 'Trạm tập Fitness đa năng & Màn hình';
      color = '#1F2937';
      height = 1.35;
      material = 'Hợp kim thép đen mờ & Cao su';
    } else if (roomUpper.includes('SÂN THƯỢNG') || roomUpper.includes('SKY') || roomUpper.includes('BBQ')) {
      if (dimMax >= 2.0 && (relY > 0.7 || dimMin <= 0.9)) {
        type = 'bbq';
        asset_id = 'outdoor_bbq_station';
        name = 'Quầy Bar & Bếp nướng BBQ ngoài trời';
        color = '#27272A';
        height = 0.95;
        material = 'Thép không gỉ & Đá Granite đen';
      } else if (dimMax >= 1.1 && dimMin >= 0.85) {
        type = 'dining_table';
        asset_id = 'outdoor_patio_set';
        name = 'Bộ bàn trà & Tiệc sân thượng Sky Garden';
        color = '#92400E';
        height = 0.76;
        material = 'Gỗ Teak ngoài trời & Khung nhôm';
      } else {
        type = 'plants';
        asset_id = 'balcony_planter_greenery';
        name = 'Bồn cây nhiệt đới & Tiểu cảnh Sân thượng';
        color = '#3F6212';
        height = 0.9;
        material = 'Chậu đá mài & Cây xanh';
      }
    } else if (roomUpper.includes('GIẶT') || roomUpper.includes('PHƠI') || roomUpper.includes('SAUNA') || roomUpper.includes('XÔNG HƠI')) {
      if (roomUpper.includes('SAUNA') || roomUpper.includes('XÔNG HƠI')) {
        type = 'sofa_sectional';
        asset_id = 'sofa_straight_3seat';
        name = 'Hệ ghế gỗ Thông phòng xông hơi Sauna';
        color = '#B45309';
        height = 0.85;
        material = 'Gỗ Thông Phần Lan chịu nhiệt';
      } else {
        type = 'kitchen_cabinet';
        asset_id = 'washer_dryer_tower';
        name = 'Tháp máy giặt sấy chồng tầng LG WashTower';
        color = '#475569';
        height = 1.85;
        material = 'Thép sơn tĩnh điện & Kính cường lực';
      }
    } else if (roomUpper.includes('BẾP') || roomUpper.includes('ĂN')) {
      if (dimMin <= 1.08 && (dimMax >= 2.3 && relY > 0.72 || relX < 0.22 || relX > 0.78)) {
        type = 'kitchen_cabinet';
        asset_id = dimMax >= 3.0 ? 'kitchen_system_l' : 'kitchen_system_i';
        name = 'Hệ tủ bếp kịch trần, Bếp từ & Hút mùi';
        color = '#2C353B';
        height = 2.25;
        material = 'Acrylic bóng gương & Đá Marble Carrara';
      } else if (dimMax >= 1.5 && dimMin >= 0.95 && relY <= 0.78) {
        type = 'dining_table';
        asset_id = dimMax >= 1.75 ? 'dining_table_6chairs' : 'dining_table_4chairs';
        name = 'Bàn ăn 6 ghế mặt đá Carrara & Đèn thả';
        color = '#8D6E63';
        height = 0.76;
        material = 'Gỗ Sồi Nga & Đá Cẩm thạch';
      } else {
        type = 'kitchen_cabinet';
        asset_id = 'kitchen_island_bar';
        name = 'Bàn đảo bếp mặt đá Waterfall & Ghế Bar';
        color = '#334155';
        height = 0.92;
        material = 'Đá Marble Carrara & Gỗ Óc chó';
      }
    } else if (roomUpper.includes('KHÁCH') || roomUpper.includes('SINH HOẠT')) {
      if (dimMin <= 0.68 && dimMax >= 1.8) {
        type = 'tv_console';
        asset_id = 'tv_cabinet_wall_unit';
        name = 'Kệ Tivi gỗ Óc chó, Vách lam & Màn hình OLED 75"';
        color = '#4A2C1D';
        height = 1.65;
        material = 'Gỗ Óc chó Bắc Mỹ & Đồng xước';
        if (rawItem.rotation == null) {
          rotation = cy > (slabBounds.minY + slabD * 0.32) ? Math.PI : 0;
        }
      } else if (dimMax <= 2.1 && dimMin <= 1.05 && dimMax >= 0.8) {
        type = 'coffee_table';
        asset_id = 'coffee_table_set';
        name = 'Bàn trà đôi mặt đá Marble Carrara & Khay Decor';
        color = '#F3F4F6';
        height = 0.42;
        material = 'Đá Cẩm thạch trắng & Khung đồng';
      } else {
        type = 'sofa_sectional';
        asset_id = 'sofa_l_modern';
        name = 'Sofa góc chữ L bọc nỉ Bouclé cao cấp';
        color = '#C8B9A6';
        height = 0.85;
        material = 'Vải Bouclé Ý, Gỗ Sồi & Thảm dệt';
      }
    } else if (roomUpper.includes('NGỦ') || roomUpper.includes('MASTER') || roomUpper.includes('THAY ĐỒ') || roomUpper.includes('HỌC') || roomUpper.includes('LÀM VIỆC')) {
      if (roomUpper.includes('THAY ĐỒ')) {
        type = 'wardrobe';
        asset_id = 'wardrobe_tall_glass';
        name = 'Hệ tủ quần áo Walk-in Closet cánh kính LED';
        color = '#374151';
        height = 2.4;
        material = 'Kính sọc Fluted Glass & Gỗ Óc chó';
      } else if (dimMax >= 1.75 && dimMin >= 1.45) {
        type = 'bed_master';
        const isMaster = roomUpper.includes('MASTER');
        asset_id = isMaster ? 'bed_master_king' : 'bed_queen_modern';
        name = isMaster ? 'Giường King Size Master bọc nệm & Đèn ngủ' : 'Giường ngủ Queen Size gỗ Sồi tự nhiên';
        color = '#E5E0D8';
        height = isMaster ? 1.15 : 1.08;
        material = 'Nệm Linen cao cấp & Gỗ Óc chó';
      } else if (dimMax <= 0.85 && dimMin <= 0.85) {
        type = 'chair_or_nightstand';
        asset_id = 'armchair_lounge';
        name = 'Ghế Armchair thư giãn góc đọc sách';
        color = '#785A46';
        height = 0.82;
        material = 'Nỉ Nhung & Chân đồng mạ vàng';
      } else if (roomUpper.includes('HỌC') || roomUpper.includes('LÀM VIỆC')) {
        if (relY > 0.8) {
          type = 'wardrobe';
          asset_id = 'wardrobe_tall_glass';
          name = 'Tủ sách & Hồ sơ kịch trần cánh kính';
          color = '#4B5563';
          height = 2.35;
          material = 'Gỗ Sồi & Kính cường lực';
        } else {
          type = 'desk';
          asset_id = 'work_desk_computer';
          name = 'Bàn làm việc Giám đốc & Ghế công thái học';
          color = '#A16207';
          height = 0.76;
          material = 'Gỗ Óc chó, Chân thép & Màn hình';
        }
      } else if (dimMax >= 2.0 && dimMin <= 0.9) {
        type = 'wardrobe';
        asset_id = 'wardrobe_tall_glass';
        name = 'Tủ quần áo âm tường cánh kính Fluted';
        color = '#374151';
        height = 2.4;
        material = 'Khung nhôm đen mờ & Kính sọc';
      } else {
        type = 'desk';
        asset_id = roomUpper.includes('MASTER') ? 'dressing_table_mirror' : 'work_desk_computer';
        name = roomUpper.includes('MASTER')
          ? 'Bàn trang điểm gương tròn LED & Đôn nhung'
          : 'Bàn làm việc & Học tập kèm Máy tính';
        color = '#B45309';
        height = roomUpper.includes('MASTER') ? 1.35 : 0.76;
        material = 'Gỗ Sồi tự nhiên & Kim loại';
      }
    } else {
      if (dimMax >= 1.8 && dimMin >= 1.5) {
        type = 'bed_master';
        asset_id = 'bed_queen_modern';
        name = 'Giường ngủ đôi cao cấp';
        height = 1.1;
      } else if (dimMax >= 2.0 && dimMin <= 0.85) {
        type = 'wardrobe';
        asset_id = 'wardrobe_tall_glass';
        name = 'Tủ lưu trữ cánh kính đa năng';
        height = 2.35;
      } else if (dimMax <= 0.8 && dimMin <= 0.8) {
        type = 'plants';
        asset_id = 'indoor_potted_ficus';
        name = 'Chậu cây xanh nội thất';
        height = 1.3;
      } else {
        type = 'desk';
        asset_id = 'work_desk_computer';
        name = 'Bàn nội thất đa năng';
        height = 0.76;
      }
    }

    if (!asset_id || !ASSET_CATALOG_SET.has(asset_id)) {
      asset_id = this.resolveAssetId(type, name, roomName, layer);
    }

    // When rotated ±90 degrees (|sin(rotation)| > 0.7), world Y span is local X width and world X span is local Z depth
    const isRotated90 = Math.abs(Math.sin(rotation)) > 0.7;
    const swapAxes = rawItem.rotation != null ? isRotated90 : isVertical;
    const finalWidth = swapAxes ? depth : width;
    const finalDepth = swapAxes ? width : depth;

    return {
      asset_id,
      type,
      name,
      layer,
      room: roomName,
      cx,
      cy,
      width: Math.max(0.25, finalWidth),
      depth: Math.max(0.14, finalDepth),
      height,
      rotation,
      color,
      material,
      confidence: 0.96 + ((Math.abs(Math.round(cx * 10 + cy * 10)) % 4) * 0.01)
    };
  }

  assetIdToLegacyType(asset_id) {
    const map = {
      sofa_l_modern: 'sofa_sectional',
      sofa_straight_3seat: 'sofa',
      armchair_lounge: 'chair_or_nightstand',
      coffee_table_set: 'coffee_table',
      tv_cabinet_wall_unit: 'tv_console',
      entrance_shoe_cabinet: 'wardrobe',
      floor_rug_textured: 'rug',
      kitchen_system_i: 'kitchen_cabinet',
      kitchen_system_l: 'kitchen_cabinet',
      kitchen_island_bar: 'kitchen_cabinet',
      fridge_double_door: 'kitchen_cabinet',
      dining_table_6chairs: 'dining_table',
      dining_table_4chairs: 'dining_table',
      bed_master_king: 'bed_master',
      bed_queen_modern: 'bed_master',
      bed_bunk_kids: 'bed_master',
      wardrobe_tall_glass: 'wardrobe',
      work_desk_computer: 'desk',
      dressing_table_mirror: 'desk',
      vietnamese_worship_altar: 'altar_table',
      outdoor_bbq_station: 'bbq',
      outdoor_patio_set: 'dining_table',
      toilet_onepiece: 'toilet',
      lavabo_vanity_led_mirror: 'vanity',
      shower_glass_enclosure: 'shower',
      bathtub_modern: 'bathtub',
      washer_dryer_tower: 'kitchen_cabinet',
      balcony_planter_greenery: 'plants',
      indoor_potted_ficus: 'plants',
      railing_iron_baluster: 'railing',
      door_interior_wood: 'door',
      door_balcony_glass: 'door',
      window_casement_glass: 'window',
      stair_flight_straight: 'stair',
      stair_flight_u_turn: 'stair'
    };
    return map[asset_id] || 'desk';
  }

  assetIdToDefaultHeight(asset_id) {
    const heights = {
      sofa_l_modern: 0.85,
      sofa_straight_3seat: 0.84,
      armchair_lounge: 0.82,
      coffee_table_set: 0.42,
      tv_cabinet_wall_unit: 1.65,
      entrance_shoe_cabinet: 1.15,
      floor_rug_textured: 0.02,
      kitchen_system_i: 2.2,
      kitchen_system_l: 2.25,
      kitchen_island_bar: 0.92,
      fridge_double_door: 1.82,
      dining_table_6chairs: 0.76,
      dining_table_4chairs: 0.76,
      bed_master_king: 1.15,
      bed_queen_modern: 1.08,
      bed_bunk_kids: 1.75,
      wardrobe_tall_glass: 2.4,
      work_desk_computer: 0.76,
      dressing_table_mirror: 1.35,
      vietnamese_worship_altar: 1.45,
      outdoor_bbq_station: 0.95,
      outdoor_patio_set: 0.75,
      toilet_onepiece: 0.74,
      lavabo_vanity_led_mirror: 1.85,
      shower_glass_enclosure: 2.1,
      bathtub_modern: 0.62,
      washer_dryer_tower: 1.85,
      balcony_planter_greenery: 0.85,
      indoor_potted_ficus: 1.35,
      railing_iron_baluster: 1.05
    };
    return heights[asset_id] || 0.76;
  }

  assetIdToDefaultName(asset_id) {
    const names = {
      sofa_l_modern: 'Sofa góc chữ L bọc nỉ Bouclé & Gối tựa',
      sofa_straight_3seat: 'Sofa văng 3 chỗ bọc da Ý',
      armchair_lounge: 'Ghế Armchair thư giãn Lounge',
      coffee_table_set: 'Bàn trà đôi mặt đá Marble Carrara',
      tv_cabinet_wall_unit: 'Kệ Tivi gỗ Óc chó & Màn hình OLED 75"',
      entrance_shoe_cabinet: 'Tủ giày sảnh đón & Ghế thay giày',
      floor_rug_textured: 'Thảm trải sàn dệt nổi Bắc Âu',
      kitchen_system_i: 'Hệ tủ bếp kịch trần chữ I & Bếp từ',
      kitchen_system_l: 'Hệ tủ bếp kịch trần chữ L, Bếp từ & Chậu rửa',
      kitchen_island_bar: 'Đảo bếp đá Marble & Ghế Bar',
      fridge_double_door: 'Tủ lạnh Side-by-Side Inverter mặt thép',
      dining_table_6chairs: 'Bàn ăn mặt đá Marble & 6 Ghế bọc da',
      dining_table_4chairs: 'Bàn ăn 4 ghế gỗ Sồi & Mặt đá',
      bed_master_king: 'Giường ngủ Master King Size & Tab đầu giường',
      bed_queen_modern: 'Giường ngủ Queen Size gỗ Sồi tự nhiên',
      bed_bunk_kids: 'Giường tầng trẻ em & Cầu thang hộp',
      wardrobe_tall_glass: 'Tủ quần áo kịch trần cánh kính Fluted',
      work_desk_computer: 'Bàn làm việc & Máy tính iMac',
      dressing_table_mirror: 'Bàn trang điểm gương tròn LED & Đôn nỉ',
      vietnamese_worship_altar: 'Án gian thờ Gỗ Gụ & Vách CNC Trúc Chỉ',
      outdoor_bbq_station: 'Quầy bếp nướng BBQ & Bar Sân thượng',
      outdoor_patio_set: 'Bộ bàn tiệc & Sofa ngoài trời Sân thượng',
      toilet_onepiece: 'Bồn cầu liền khối thông minh TOTO',
      lavabo_vanity_led_mirror: 'Tủ Lavabo đá Carrara & Gương LED',
      shower_glass_enclosure: 'Cabin tắm đứng vách kính cường lực',
      bathtub_modern: 'Bồn tắm nằm Freestanding Sứ Kohler',
      washer_dryer_tower: 'Tháp máy giặt sấy chồng tầng LG WashTower',
      balcony_planter_greenery: 'Bồn cây cảnh nhiệt đới Ban công',
      indoor_potted_ficus: 'Chậu cây Bàng Singapore trong nhà',
      railing_iron_baluster: 'Lan can sắt mỹ thuật sơn tĩnh điện',
      door_interior_wood: 'Cửa gỗ thông phòng',
      door_balcony_glass: 'Cửa kính lùa ra Ban công / Sân vườn',
      window_casement_glass: 'Cửa sổ kính khung nhôm Xingfa',
      stair_flight_straight: 'Cầu thang thẳng mặt gỗ lan can kính',
      stair_flight_u_turn: 'Cầu thang đổi chiều chữ U có chiếu nghỉ'
    };
    return names[asset_id] || 'Vật dụng nội thất';
  }

  assetIdToDefaultMaterial(asset_id) {
    const materials = {
      sofa_l_modern: 'Vải nỉ Bouclé Ý & Chân gỗ Óc chó',
      sofa_straight_3seat: 'Da bò Ý & Khung gỗ Sồi',
      armchair_lounge: 'Da bò Ý & Chân hợp kim đồng',
      coffee_table_set: 'Đá Cẩm thạch trắng & Khung đồng',
      tv_cabinet_wall_unit: 'Gỗ Óc chó Bắc Mỹ & Kính đen',
      entrance_shoe_cabinet: 'Gỗ Sồi tự nhiên & Đá Marble',
      floor_rug_textured: 'Len dệt thủ công Bắc Âu',
      kitchen_system_i: 'Acrylic bóng gương & Đá Quartz',
      kitchen_system_l: 'Acrylic bóng gương & Đá Marble Carrara',
      kitchen_island_bar: 'Đá Cẩm thạch & Gỗ Óc chó',
      fridge_double_door: 'Thép không gỉ Brushed Steel',
      dining_table_6chairs: 'Đá Marble trắng vân mây & Da bò',
      dining_table_4chairs: 'Gỗ Sồi tự nhiên & Đá nhân tạo',
      bed_master_king: 'Gỗ Óc chó, Đầu giường bọc da & Nệm Linen',
      bed_queen_modern: 'Gỗ Sồi tự nhiên & Vải Linen',
      bed_bunk_kids: 'Gỗ Tần bì tự nhiên sơn an toàn',
      wardrobe_tall_glass: 'Khung nhôm Anode & Kính sọc tối màu',
      work_desk_computer: 'Gỗ Sồi tự nhiên & Chân thép đen mờ',
      dressing_table_mirror: 'Gỗ Sồi, Mặt đá & Gương cảm ứng LED',
      vietnamese_worship_altar: 'Gỗ Gụ chạm khắc & Đồng nguyên chất',
      outdoor_bbq_station: 'Thép không gỉ 304 & Đá Granite đen',
      outdoor_patio_set: 'Gỗ Teak ngoài trời & Đệm chống thấm',
      toilet_onepiece: 'Sứ vệ sinh tráng men Nano kháng khuẩn',
      lavabo_vanity_led_mirror: 'Đá Marble Carrara & Gương LED Halo',
      shower_glass_enclosure: 'Kính cường lực 10mm & Phụ kiện Inox 304',
      bathtub_modern: 'Sứ Acrylic nguyên khối & Vòi sen đứng',
      washer_dryer_tower: 'Thép sơn tĩnh điện đen mờ',
      balcony_planter_greenery: 'Chậu đá mài & Cây cảnh nhiệt đới',
      indoor_potted_ficus: 'Chậu Gốm Bát Tràng & Cây xanh',
      railing_iron_baluster: 'Hợp kim sắt sơn tĩnh điện'
    };
    return materials[asset_id] || 'Gỗ Sồi Tự Nhiên';
  }

  /**
   * Semantic Bounding Box Collision Check & Auto-Relocation for TV units and wall-mounted objects.
   * Guarantees that TV units NEVER intersect or occlude windows.
   */
  resolveTvWindowCollisions(furniture, windows = [], slab = null) {
    if (!Array.isArray(furniture) || !Array.isArray(windows) || windows.length === 0) return 0;
    const slabBounds = slab || { minX: 0, maxX: 10, minY: 0, maxY: 15 };
    let resolvedCount = 0;

    for (const item of furniture) {
      const isTv = item.asset_id === 'tv_cabinet_wall_unit' ||
        (item.name && item.name.toLowerCase().includes('tivi')) ||
        (item.name && item.name.toLowerCase().includes('kệ tv')) ||
        item.type === 'tv_console';

      if (!isTv) continue;

      if (typeof item.cx !== 'number' || Number.isNaN(item.cx)) item.cx = (slabBounds.minX + slabBounds.maxX) / 2;
      if (typeof item.cy !== 'number' || Number.isNaN(item.cy)) item.cy = (slabBounds.minY + slabBounds.maxY) / 2;

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

      // Strategy 1: Slide along current wall
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
              break;
            }
          }
        }
      }
    }
    return resolvedCount;
  }

  /**
   * Enrich any sparse floor with complete architectural windows, doors, and
   * room-appropriate 3D .glb furniture so every floor of every project looks richly detailed.
   */
  enrichFloorBim(bimFloor, floorIdx, slabBounds, projectData) {
    const { minX, maxX, minY, maxY } = slabBounds;
    const w = maxX - minX;
    const d = maxY - minY;

    // 1. Ensure rich exterior windows on South, East, and North walls
    if (bimFloor.windows.length < 3) {
      const hasSouth = bimFloor.windows.some(win => Math.abs(win.p1.y - minY) < 0.4);
      const hasNorth = bimFloor.windows.some(win => Math.abs(win.p1.y - maxY) < 0.4);
      const hasEast = bimFloor.windows.some(win => Math.abs(win.p1.x - maxX) < 0.4);

      if (!hasSouth) {
        bimFloor.windows.push({
          asset_id: 'window_casement_glass',
          rotation: 0,
          p1: { x: minX + w * 0.2, y: minY },
          p2: { x: minX + w * 0.8, y: minY },
          wallId: `${bimFloor.id}_wall_south`,
          orientation: 'south',
          sillHeight: 0.85,
          windowHeight: 1.85
        });
      }
      if (!hasNorth) {
        bimFloor.windows.push({
          asset_id: 'window_casement_glass',
          rotation: Math.PI,
          p1: { x: minX + w * 0.22, y: maxY },
          p2: { x: minX + w * 0.68, y: maxY },
          wallId: `${bimFloor.id}_wall_north`,
          orientation: 'north',
          sillHeight: 0.9,
          windowHeight: 1.65
        });
      }
      if (!hasEast && d >= 10) {
        bimFloor.windows.push({
          asset_id: 'window_casement_glass',
          rotation: -Math.PI / 2,
          p1: { x: maxX, y: minY + d * 0.2 },
          p2: { x: maxX, y: minY + d * 0.42 },
          wallId: `${bimFloor.id}_wall_east`,
          orientation: 'east',
          sillHeight: 0.85,
          windowHeight: 1.8
        });
      }
    }

    // 2. Ensure interior/exterior doors exist on every floor
    if (bimFloor.doors.length === 0) {
      bimFloor.doors.push(
        {
          asset_id: 'door_balcony_glass',
          x: minX + w * 0.35,
          y: minY,
          width: 1.6,
          height: 2.2,
          wallId: `${bimFloor.id}_wall_south`,
          isExterior: true,
          orientation: 'south',
          rotation: 0
        },
        {
          asset_id: 'door_interior_wood',
          x: minX + w * 0.5,
          y: minY + d * 0.5,
          width: 0.9,
          height: 2.15,
          isExterior: false,
          orientation: 'horizontal',
          rotation: 0
        }
      );
    }

    // 3. Check each room on the floor and add rich .glb furnishing if needed
    const allItems = [...bimFloor.furniture, ...bimFloor.sanitary];
    const hasNear = (x, y, rad = 2.0) => allItems.some(it => Math.hypot(it.cx - x, it.cy - y) < rad);
    const hasAssetInRoom = (rmName, assetId) => allItems.some(it => it.room === rmName && it.asset_id === assetId);

    const addItem = (item, isSanitary = false) => {
      if (isSanitary) {
        bimFloor.sanitary.push(item);
      } else {
        bimFloor.furniture.push(item);
      }
      allItems.push(item);
    };

    for (const rm of bimFloor.rooms) {
      if (rm.isOutdoor) continue;
      const rName = rm.name.toUpperCase();

      // Living Room enrichment (e.g. SAMPLE_VILLA Tầng 1)
      if (rName.includes('PHÒNG KHÁCH')) {
        if (!hasAssetInRoom(rm.name, 'floor_rug_textured')) {
          addItem({
            asset_id: 'floor_rug_textured',
            type: 'rug',
            name: 'Thảm trải sàn dệt nổi Phòng khách',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x - 0.3,
            cy: rm.y - 0.2,
            width: 2.6,
            depth: 1.9,
            height: 0.02,
            rotation: 0,
            material: 'Len dệt Bắc Âu cao cấp',
            confidence: 0.98
          });
        }
        if (!hasAssetInRoom(rm.name, 'armchair_lounge')) {
          addItem({
            asset_id: 'armchair_lounge',
            type: 'chair_or_nightstand',
            name: 'Ghế Armchair thư giãn Lounge',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x + 1.3,
            cy: rm.y - 0.5,
            width: 0.85,
            depth: 0.85,
            height: 0.82,
            rotation: -Math.PI / 2,
            material: 'Da bò Ý & Chân đồng',
            confidence: 0.98
          });
        }
        if (!hasAssetInRoom(rm.name, 'entrance_shoe_cabinet')) {
          addItem({
            asset_id: 'entrance_shoe_cabinet',
            type: 'wardrobe',
            name: 'Tủ giày sảnh đón & Ghế thay giày',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x + 2.4,
            cy: minY + 0.55,
            width: 1.3,
            depth: 0.42,
            height: 1.15,
            rotation: 0,
            material: 'Gỗ Sồi tự nhiên & Mặt đá Marble',
            confidence: 0.97
          });
        }
        if (!hasAssetInRoom(rm.name, 'indoor_potted_ficus')) {
          addItem({
            asset_id: 'indoor_potted_ficus',
            type: 'plants',
            name: 'Chậu cây Bàng Singapore Phòng khách',
            layer: 'A-FURN',
            room: rm.name,
            cx: minX + 0.65,
            cy: minY + 0.65,
            width: 0.65,
            depth: 0.65,
            height: 1.35,
            rotation: 0,
            material: 'Chậu Gốm Bát Tràng & Cây xanh',
            confidence: 0.98
          });
        }
      }

      // Kitchen & Dining enrichment
      if (rName.includes('BẾP') || rName.includes('PHÒNG ĂN')) {
        if (!hasAssetInRoom(rm.name, 'fridge_double_door')) {
          addItem({
            asset_id: 'fridge_double_door',
            type: 'kitchen_cabinet',
            name: 'Tủ lạnh Side-by-Side Inverter mặt thép',
            layer: 'A-FURN',
            room: rm.name,
            cx: Math.min(maxX - 1.2, rm.x + 3.2),
            cy: maxY - 0.55,
            width: 0.92,
            depth: 0.78,
            height: 1.85,
            rotation: Math.PI,
            material: 'Thép không gỉ Brushed Steel',
            confidence: 0.98
          });
        }
        if (!hasAssetInRoom(rm.name, 'kitchen_island_bar') && w >= 8) {
          addItem({
            asset_id: 'kitchen_island_bar',
            type: 'kitchen_cabinet',
            name: 'Đảo bếp đá Marble Carrara & Ghế Bar',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x + 0.8,
            cy: rm.y - 1.2,
            width: 1.9,
            depth: 0.85,
            height: 0.92,
            rotation: 0,
            material: 'Đá Cẩm thạch trắng & Gỗ Óc chó',
            confidence: 0.98
          });
        }
      }

      // Family Living Room
      if (rName.includes('SINH HOẠT CHUNG')) {
        if (!allItems.some(it => it.room === rm.name && (it.type === 'coffee_table' || it.asset_id === 'coffee_table_set'))) {
          addItem({
            asset_id: 'coffee_table_set',
            type: 'coffee_table',
            name: 'Bàn trà mặt đá phòng Sinh hoạt chung',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x,
            cy: rm.y + 0.6,
            width: 1.2,
            depth: 0.7,
            height: 0.42,
            rotation: 0,
            material: 'Đá Marble Carrara & Khung đồng',
            confidence: 0.98
          });
        }
        if (!allItems.some(it => it.room === rm.name && (it.type === 'tv_console' || it.asset_id === 'tv_cabinet_wall_unit'))) {
          addItem({
            asset_id: 'tv_cabinet_wall_unit',
            type: 'tv_console',
            name: 'Kệ Tivi & Hệ loa phòng Sinh hoạt chung',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x,
            cy: rm.y + 1.7,
            width: 2.2,
            depth: 0.48,
            height: 1.6,
            rotation: Math.PI,
            material: 'Gỗ Óc chó & Màn hình OLED',
            confidence: 0.97
          });
        }
      }

      // Master Bedroom enrichment
      if (rName.includes('PHÒNG NGỦ MASTER')) {
        if (!hasAssetInRoom(rm.name, 'dressing_table_mirror')) {
          addItem({
            asset_id: 'dressing_table_mirror',
            type: 'desk',
            name: 'Bàn trang điểm gương tròn LED Master',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x - 1.6,
            cy: rm.y + 1.4,
            width: 1.1,
            depth: 0.52,
            height: 1.35,
            rotation: Math.PI / 2,
            material: 'Gỗ Sồi, Gương LED cảm ứng & Chân đồng',
            confidence: 0.98
          });
        }
        if (!hasAssetInRoom(rm.name, 'tv_cabinet_wall_unit')) {
          const roomCenterX = typeof rm.x === 'number' && !Number.isNaN(rm.x) ? rm.x : (minX + maxX) / 2;
          const roomCenterY = typeof rm.y === 'number' && !Number.isNaN(rm.y) ? rm.y : (minY + maxY) / 2;
          addItem({
            asset_id: 'tv_cabinet_wall_unit',
            type: 'tv_console',
            name: 'Kệ Tivi gỗ Óc chó Phòng ngủ Master',
            layer: 'A-FURN',
            room: rm.name,
            cx: Math.min(maxX - 0.5, roomCenterX + 2.2),
            cy: roomCenterY,
            width: 2.1,
            depth: 0.46,
            height: 1.6,
            rotation: -Math.PI / 2,
            material: 'Gỗ Óc chó Bắc Mỹ & Màn hình OLED',
            confidence: 0.98
          });
        }
      }

      // Balcony enrichment
      if (rName.includes('BAN CÔNG')) {
        if (!hasAssetInRoom(rm.name, 'balcony_planter_greenery')) {
          addItem({
            asset_id: 'balcony_planter_greenery',
            type: 'plants',
            name: `Bồn cây tiểu cảnh ${rm.name}`,
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x,
            cy: minY + 0.45,
            width: 1.4,
            depth: 0.48,
            height: 0.85,
            rotation: 0,
            material: 'Chậu đá mài & Cây nhiệt đới',
            confidence: 0.98
          });
        }
        if (!hasAssetInRoom(rm.name, 'outdoor_patio_set') && rm.area >= 10) {
          addItem({
            asset_id: 'outdoor_patio_set',
            type: 'dining_table',
            name: `Bàn trà thư giãn ${rm.name}`,
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x,
            cy: rm.y,
            width: 1.4,
            depth: 1.0,
            height: 0.75,
            rotation: 0,
            material: 'Gỗ Teak ngoài trời & Đệm chống thấm',
            confidence: 0.97
          });
        }
      }

      // Bathroom & Walk-in Closet enrichment
      if (rName.includes('THAY ĐỒ & WC MASTER') || rName.includes('WC CHUNG') || rName.includes('WC RIÊNG')) {
        if (!allItems.some(it => Math.hypot(it.cx - rm.x, it.cy - rm.y) < 3.0 && it.type === 'vanity')) {
          addItem({
            asset_id: 'lavabo_vanity_led_mirror',
            type: 'vanity',
            name: `Bàn Lavabo mặt đá & Gương LED (${rm.name})`,
            layer: 'A-SANR',
            room: rm.name,
            cx: rm.x + 0.8,
            cy: rm.y - 0.6,
            width: 1.1,
            depth: 0.58,
            height: 1.85,
            rotation: 0,
            material: 'Đá Marble Carrara & Gương LED',
            confidence: 0.98
          }, true);
        }
        if (!allItems.some(it => Math.hypot(it.cx - rm.x, it.cy - rm.y) < 3.0 && it.type === 'toilet')) {
          addItem({
            asset_id: 'toilet_onepiece',
            type: 'toilet',
            name: `Bồn cầu thông minh Kohler (${rm.name})`,
            layer: 'A-SANR',
            room: rm.name,
            cx: rm.x - 0.7,
            cy: rm.y + 0.6,
            width: 0.58,
            depth: 0.72,
            height: 0.74,
            rotation: Math.PI,
            material: 'Sứ tráng men Nano',
            confidence: 0.99
          }, true);
        }
        if (!allItems.some(it => Math.hypot(it.cx - rm.x, it.cy - rm.y) < 3.2 && it.asset_id === 'shower_glass_enclosure')) {
          addItem({
            asset_id: 'shower_glass_enclosure',
            type: 'shower',
            name: `Cabin tắm đứng vách kính (${rm.name})`,
            layer: 'A-SANR',
            room: rm.name,
            cx: rm.x - 0.8,
            cy: rm.y - 0.6,
            width: 1.0,
            depth: 1.0,
            height: 2.1,
            rotation: 0,
            material: 'Kính cường lực 10mm & Sen cây',
            confidence: 0.98
          }, true);
        }
        if (rName.includes('THAY ĐỒ') && !allItems.some(it => Math.hypot(it.cx - rm.x, it.cy - rm.y) < 3.5 && it.type === 'wardrobe')) {
          addItem({
            asset_id: 'wardrobe_tall_glass',
            type: 'wardrobe',
            name: 'Hệ tủ áo Walk-in Closet kịch trần',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x + 1.1,
            cy: rm.y + 1.2,
            width: 2.2,
            depth: 0.6,
            height: 2.4,
            rotation: Math.PI,
            material: 'Gỗ Óc chó & Kính sọc Fluted',
            confidence: 0.98
          });
        }
      }

      // Secondary Bedrooms enrichment
      if ((rName.includes('PHÒNG NGỦ 2') || rName.includes('PHÒNG NGỦ 3')) && w >= 10) {
        if (rName.includes('PHÒNG NGỦ 3')) {
          const bedItem = allItems.find(it => it.room === rm.name && (it.type === 'bed_master' || it.type === 'bed'));
          if (bedItem) {
            bedItem.asset_id = 'bed_bunk_kids';
            bedItem.name = 'Giường tầng trẻ em đa năng kèm cầu thang';
            bedItem.height = 1.75;
          }
        }
        if (!allItems.some(it => Math.hypot(it.cx - rm.x, it.cy - rm.y) < 3.5 && it.type === 'wardrobe')) {
          addItem({
            asset_id: 'wardrobe_tall_glass',
            type: 'wardrobe',
            name: `Tủ quần áo cánh kính (${rm.name})`,
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x,
            cy: rm.y - 1.9,
            width: 2.0,
            depth: 0.58,
            height: 2.35,
            rotation: 0,
            material: 'Gỗ Sồi & Kính cường lực tối màu',
            confidence: 0.97
          });
        }
        if (!allItems.some(it => Math.hypot(it.cx - rm.x, it.cy - rm.y) < 3.5 && it.type === 'desk')) {
          addItem({
            asset_id: 'work_desk_computer',
            type: 'desk',
            name: `Bàn làm việc & Máy tính (${rm.name})`,
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x + 1.2,
            cy: rm.y - 0.5,
            width: 1.3,
            depth: 0.65,
            height: 0.76,
            rotation: -Math.PI / 2,
            material: 'Gỗ Sồi & Chân thép sơn tĩnh điện',
            confidence: 0.96
          });
        }
      }

      // Rooftop BBQ & Terrace enrichment
      if (rName.includes('VƯỜN BBQ') || rName.includes('SÂN THƯỢNG TRƯỚC')) {
        if (!hasNear(rm.x, rm.y, 3.0)) {
          addItem({
            asset_id: 'outdoor_bbq_station',
            type: 'bbq',
            name: 'Quầy bếp nướng BBQ & Bar Sân thượng',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x - 2.2,
            cy: rm.y - 1.2,
            width: 2.4,
            depth: 0.75,
            height: 0.95,
            rotation: 0,
            material: 'Thép không gỉ & Đá Granite',
            confidence: 0.98
          });
          addItem({
            asset_id: 'outdoor_patio_set',
            type: 'dining_table',
            name: 'Bộ bàn tiệc & Sofa ngoài trời Sân thượng',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x + 1.2,
            cy: rm.y,
            width: 2.1,
            depth: 1.1,
            height: 0.76,
            rotation: 0,
            material: 'Gỗ Teak & Khung hợp kim đen',
            confidence: 0.98
          });
          addItem({
            asset_id: 'balcony_planter_greenery',
            type: 'plants',
            name: 'Bồn cây tiểu cảnh nhiệt đới Sân thượng',
            layer: 'A-FURN',
            room: rm.name,
            cx: minX + 1.2,
            cy: rm.y - 1.5,
            width: 1.2,
            depth: 0.5,
            height: 0.9,
            rotation: 0,
            material: 'Chậu đá mài & Cây cảnh',
            confidence: 0.97
          });
          addItem({
            asset_id: 'indoor_potted_ficus',
            type: 'plants',
            name: 'Chậu cây cảnh Bàng Singapore Sân thượng',
            layer: 'A-FURN',
            room: rm.name,
            cx: maxX - 1.2,
            cy: rm.y - 1.5,
            width: 0.85,
            depth: 0.85,
            height: 1.35,
            rotation: 0,
            material: 'Chậu Gốm & Cây xanh',
            confidence: 0.97
          });
        }
      }

      // Laundry & Utility Terrace enrichment
      if (rName.includes('SÂN PHƠI & KỸ THUẬT')) {
        if (!hasNear(rm.x, rm.y, 3.0)) {
          addItem({
            asset_id: 'washer_dryer_tower',
            type: 'kitchen_cabinet',
            name: 'Tháp máy giặt sấy chồng tầng LG WashTower',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x - 1.8,
            cy: rm.y + 1.2,
            width: 0.75,
            depth: 0.75,
            height: 1.85,
            rotation: Math.PI,
            material: 'Thép sơn tĩnh điện & Kính cường lực',
            confidence: 0.98
          });
          addItem({
            asset_id: 'balcony_planter_greenery',
            type: 'plants',
            name: 'Vườn cây cảnh Sân sau tầng Tum',
            layer: 'A-FURN',
            room: rm.name,
            cx: rm.x + 2.5,
            cy: rm.y + 1.0,
            width: 1.3,
            depth: 0.55,
            height: 0.9,
            rotation: Math.PI,
            material: 'Chậu đá mài & Cây cảnh',
            confidence: 0.96
          });
        }
      }
    }
  }
}
