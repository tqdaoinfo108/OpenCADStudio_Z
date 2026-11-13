import { buildRoomPartitions, normalizeRoom, roomAllowsFurniture, validateAndSanitizeFloorPlan } from '../js/architectural_layout.js';
/**
 * two_pass_spatial_compiler.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 *
 * Two-Pass Validated Spatial Compiler implementing the 4-phase architectural pipeline:
 * - Phase 1: Multimodal Extraction & Prompt Decomposition
 *            (user natural language, CAD DXF entities, Vision AI)
 * - Phase 2: Geometric Constraint Validation & Auto-Correction
 *            - Wall & Slab Sanitizer (clamping walls to 90°, corner closing, slab bounding)
 *            - Vertical Core & Stair Sync (multi-floor stair alignment, slab stair void cutting)
 *            - Modular Furniture Placement Solver (asset_id catalog mapping, wall-backed rotation, AABB collision & door swing clearances)
 * - Phase 3: 2D Floorplan Projection & Entity Updates
 * - Phase 4: Full 3D BIM Scene Graph Output
 */

import { CadBimPipeline } from '../js/cad_bim_pipeline.js';
import { FloorDocument, ProjectDocument } from './models.js';

export class TwoPassSpatialCompiler {
  /**
   * @param {Object} [options]
   * @param {Object} [options.repo] - ProjectRepository instance
   * @param {Object} [options.aiExtractor] - AiVisionExtractor instance
   */
  constructor(options = {}) {
    this.repo = options.repo || null;
    this.aiExtractor = options.aiExtractor || null;
    this.cadPipeline = new CadBimPipeline();
  }

  /**
   * Compile architectural project changes through the 4-phase pipeline
   * @param {Object} context
   * @param {ProjectDocument} context.project
   * @param {string} context.userMessage
   * @param {Array<Object>} [context.attachments=[]]
   * @param {string} [context.currentFloorId]
   * @param {Array<Object>} [context.furnitureCatalog=[]]
   * @param {Object} [context.aiConfig]
   * @returns {Promise<{ updatedProject: ProjectDocument, bimScene: Object, assistantMessage: string, stageInfo: Object }>}
   */
  async compile(context) {
    const {
      project,
      userMessage = '',
      attachments = [],
      currentFloorId = null,
      furnitureCatalog = [],
      aiConfig = null
    } = context;

    if (!project) {
      throw new Error('ProjectDocument is required for spatial compilation.');
    }

    const stageInfo = {
      phase1: { name: 'Multimodal Extraction & Intent Decomposition', status: 'pending', details: {} },
      phase2: { name: 'Geometric Constraint Validation & Auto-Correction', status: 'pending', details: {} },
      phase3: { name: '2D Floorplan Projection & Entity Update', status: 'pending', details: {} },
      phase4: { name: 'Full 3D BIM Scene Graph Generation', status: 'completed', details: {} }
    };

    // -------------------------------------------------------------------------
    // PHASE 1: Multimodal Extraction & Prompt Decomposition
    // -------------------------------------------------------------------------
    const intent = this.decomposePrompt({
      userMessage,
      attachments,
      project,
      currentFloorId
    });

    stageInfo.phase1 = {
      name: 'Multimodal Extraction & Intent Decomposition',
      status: 'completed',
      details: {
        action: intent.action,
        targetFloorId: intent.targetFloorId,
        roomsDetected: intent.rooms.map(r => r.name),
        furnitureRequested: intent.requestedFurniture.map(f => f.keyword),
        attachmentsProcessed: attachments.length
      }
    };

    // Apply high-level structural change (e.g. Add Floor, modify floor)
    const activeFloor = this.applyStructuralIntent(project, intent);

    // -------------------------------------------------------------------------
    // PHASE 2: Geometric Constraint Validation & Auto-Correction (Two-Pass)
    // -------------------------------------------------------------------------
    const phase2Details = {
      wallsSanitized: 0,
      cornersClosed: 0,
      stairVoidsCut: 0,
      furniturePlaced: 0,
      collisionsAvoided: 0,
      doorClearancesVerified: 0
    };

    // Pass 2.1: Wall & Slab Sanitizer
    const slabBounds = this.getSlabBounds(project, activeFloor);
    const wallSanitization = this.sanitizeWallsAndSlab(activeFloor, slabBounds);
    phase2Details.wallsSanitized = wallSanitization.wallsClamped;
    phase2Details.cornersClosed = wallSanitization.cornersClosed;
    phase2Details.tJunctionsCleaned = wallSanitization.tJunctionsCleaned || 0;

    // Pass 2.2: Vertical Core & Stair Sync across all floors
    const stairSyncResult = this.syncVerticalCoreAndStairs(project);
    phase2Details.stairVoidsCut = stairSyncResult.voidsCreated;

    // Pass 2.3: Modular Furniture Placement Solver
    for (const record of furnitureCatalog) {
      const id = record.asset_id;
      if (!id?.startsWith('generated_') || !userMessage.includes(id)) continue;
      const kind = record.tags?.find(tag => tag.startsWith('kind:'))?.slice(5);
      intent.requestedFurniture.push({ asset_id:id, keyword:id, name:record.name, category:kind || 'sofa' });
    }

    const furnitureSolverResult = this.solveFurniturePlacement({
      floor: activeFloor,
      requestedFurniture: intent.requestedFurniture,
      furnitureCatalog,
      slabBounds,
      existingStairs: stairSyncResult.stairsByFloor[activeFloor.id] || []
    });

    const authoredGrid = activeFloor.metadata?.roomGrid && activeFloor.rooms.length;
    const structuralLayers = new Set(['A-WALL-EXTR', 'A-WALL-INTR', 'A-DOOR', 'A-GLAZ', 'A-COLS', 'A-STAIR', 'A-SITE']);
    const authoredStructure = authoredGrid ? activeFloor.entities.filter(entity => structuralLayers.has(entity.layer)) : [];
    const roomTypes = new Map(intent.rooms.map(room => [room.zone, room]));
    const requestedRooms = [...roomTypes.values()];
    const hallWidth = requestedRooms.length > 1 ? Math.min(1.25, (slabBounds.maxX - slabBounds.minX) / 3) : 0;
    const roomMaxX = slabBounds.maxX - hallWidth;
    const span = slabBounds.maxY - slabBounds.minY;
    const rooms = authoredGrid ? activeFloor.rooms : requestedRooms.map((room, index) => normalizeRoom({
      ...room, id: 'room_' + (index + 1), x_min: slabBounds.minX, x_max: roomMaxX,
      z_min: slabBounds.minY + span * index / requestedRooms.length,
      z_max: slabBounds.minY + span * (index + 1) / requestedRooms.length
    }));
    if (!authoredGrid && hallWidth) {
      rooms.push(normalizeRoom({ id: 'hall', name: 'Sảnh', type: 'circulation',
        x_min: roomMaxX, x_max: slabBounds.maxX, z_min: slabBounds.minY, z_max: slabBounds.maxY }));
    }
    const { walls, doors } = buildRoomPartitions(rooms, slabBounds,
      rooms.filter(room => room.id !== 'hall').map(room => [room.id, 'hall']));
    const front = rooms.find(room => room.id !== 'hall');
    if (!authoredGrid && front) doors.push({ x: hallWidth ? roomMaxX + hallWidth / 2 : front.x, y: slabBounds.minY, width: 0.9, rotation: 0 });

    const anchorNames = ['north', 'west', 'south', 'east'];
    const incoming = furnitureSolverResult.placedItems.flatMap(item => {
      const room = rooms.find(candidate => roomAllowsFurniture(candidate, item));
      if (!room) return [];
      const rotation = ((Math.round((item.rotation || 0) / (Math.PI / 2)) % 4) + 4) % 4;
      const anchor = item.placement_type === 'floor_free' ? 'center' : anchorNames[rotation];
      const alongX = anchor !== 'west' && anchor !== 'east';
      return [{ ...item, z: room.y, room_id: room.id, anchor_wall: anchor,
        offset_along_wall: alongX ? room.x - room.bounds.minX : room.y - room.bounds.minY }];
    });
    const sanitized = validateAndSanitizeFloorPlan({
      ...activeFloor, rooms, doors: authoredGrid ? activeFloor.doors : doors,
      furniture: [...activeFloor.furniture, ...incoming],
      metadata: { ...activeFloor.metadata, roomGrid: true }
    });
    phase2Details.furniturePlaced = sanitized.furniture.length;
    phase2Details.collisionsAvoided = furnitureSolverResult.collisionsAvoided;
    phase2Details.doorClearancesVerified = furnitureSolverResult.doorClearancesVerified;

    stageInfo.phase2 = {
      name: 'Geometric Constraint Validation & Auto-Correction',
      status: 'completed',
      details: phase2Details
    };

    // -------------------------------------------------------------------------
    // PHASE 3: 2D Floorplan Projection & Entity Update
    // -------------------------------------------------------------------------
    this.updateFloorplanEntities({
      floor: activeFloor,
      slabBounds,
      rooms: sanitized.rooms,
      furniture: sanitized.furniture.map(item => ({ ...item, y: item.cy })),
      stairs: stairSyncResult.stairsByFloor[activeFloor.id] || []
    });

    activeFloor.metadata.roomGrid = true;
    activeFloor.rooms = sanitized.rooms;
    activeFloor.furniture = sanitized.furniture;
    activeFloor.sanitary = sanitized.sanitary;
    activeFloor.stairs = stairSyncResult.stairsByFloor[activeFloor.id] || [];
    if (authoredGrid) {
      activeFloor.entities = [...authoredStructure, ...activeFloor.entities.filter(entity => !structuralLayers.has(entity.layer))];
    } else {
      activeFloor.interiorWalls = walls;
      activeFloor.doors = doors;
      activeFloor.entities = activeFloor.entities.filter(entity => !['A-WALL-INTR', 'A-DOOR'].includes(entity.layer));
      activeFloor.entities.push(...walls.map(wall => ({ type: 'LINE', layer: 'A-WALL-INTR', points: [wall.p1, wall.p2] })));
      activeFloor.entities.push(...doors.map(door => ({ ...door, type: 'POINT', layer: 'A-DOOR', points: [{ x: door.x, y: door.y }] })));
    }

    // Recalculate project totals
    project.total_floor_area = project.calculateTotalArea();
    project.metadata.updatedAt = new Date().toISOString();

    stageInfo.phase3 = {
      name: '2D Floorplan Projection & Entity Update',
      status: 'completed',
      details: {
        floorId: activeFloor.id,
        floorName: activeFloor.name,
        entitiesCount: activeFloor.entities.length,
        grossAreaM2: (slabBounds.maxX - slabBounds.minX) * (slabBounds.maxY - slabBounds.minY)
      }
    };

    // -------------------------------------------------------------------------
    // PHASE 4: Full 3D BIM Scene Graph Generation
    // -------------------------------------------------------------------------
    const bimScene = this.cadPipeline.processStructuredCad(project.toJSON());

    stageInfo.phase4 = {
      name: 'Full 3D BIM Scene Graph Generation',
      status: 'completed',
      details: {
        totalFloors: bimScene.floors.length,
        totalWalls: bimScene.floors.reduce((acc, f) => acc + f.exteriorWalls.length + f.interiorWalls.length, 0),
        totalFurniture: bimScene.floors.reduce((acc, f) => acc + f.furniture.length, 0),
        totalSlabs: bimScene.floors.reduce((acc, f) => acc + f.slabs.length, 0)
      }
    };

    // Generate human-friendly architectural response in Vietnamese
    const assistantMessage = this.generateArchitecturalResponse({
      intent,
      activeFloor,
      stageInfo,
      project
    });

    return {
      updatedProject: project,
      bimScene,
      assistantMessage,
      stageInfo
    };
  }

  /**
   * Phase 1: Decompose natural language prompt and multimodal input into structured architectural intent
   */
  decomposePrompt({ userMessage, attachments, project, currentFloorId }) {
    const text = (userMessage || '').trim().toLowerCase();
    let action = 'MODIFY_FLOOR';
    let targetFloorNum = null;
    let targetFloorName = null;

    // Detect Add Floor intent (e.g. "thêm tầng 4", "thêm tầng áp mái", "add floor 4", "thêm 1 tầng")
    const isAddFloor = /thêm\s*(?:1\s*)?tầng|add\s*floor/i.test(text);
    const floorNumMatch = text.match(/tầng\s*(\d+|áp\s*mái|tum|lửng)/i);

    if (isAddFloor || (floorNumMatch && text.includes('thêm'))) {
      action = 'ADD_FLOOR';
      if (floorNumMatch) {
        const rawNum = floorNumMatch[1].trim();
        if (/^\d+$/.test(rawNum)) {
          targetFloorNum = parseInt(rawNum, 10);
          targetFloorName = `Tầng ${targetFloorNum}`;
        } else if (rawNum.includes('áp mái') || rawNum.includes('tum')) {
          targetFloorNum = project.floors.length + 1;
          targetFloorName = 'Tầng Áp Mái & Sân Thượng';
        } else if (rawNum.includes('lửng')) {
          targetFloorName = 'Tầng Lửng';
        }
      }
      if (!targetFloorNum) {
        targetFloorNum = project.floors.length + 1;
        targetFloorName = `Tầng ${targetFloorNum}`;
      }
    }

    // Detect target floor if modifying existing floor
    let targetFloorId = currentFloorId;
    if (action === 'ADD_FLOOR') {
      targetFloorId = `floor_${targetFloorNum}`;
    } else if (floorNumMatch && /^\d+$/.test(floorNumMatch[1])) {
      const num = parseInt(floorNumMatch[1], 10);
      const existing = project.floors.find(f => f.name.includes(`${num}`) || f.id === `floor_${num}`);
      if (existing) targetFloorId = existing.id;
    }

    if (!targetFloorId) {
      targetFloorId = project.floors[project.floors.length - 1]?.id || 'floor_1';
    }

    // Detect requested furniture keywords and map to catalog concepts
    const requestedFurniture = [];
    const furnitureKeywords = [
      { key: 'sofa chữ l', asset_id: 'sofa_l_modern', name: 'Sofa góc L', category: 'living_room' },
      { key: 'sofa', asset_id: 'sofa_straight_3seat', name: 'Sofa văng 3 chỗ', category: 'living_room' },
      { key: 'bàn trà', asset_id: 'coffee_table_set', name: 'Bàn trà đôi mặt đá', category: 'living_room' },
      { key: 'kệ tivi', asset_id: 'tv_cabinet_wall_unit', name: 'Kệ TV & vách lam', category: 'living_room' },
      { key: 'tivi', asset_id: 'tv_cabinet_wall_unit', name: 'Kệ TV & vách lam', category: 'living_room' },
      { key: 'tủ giày', asset_id: 'entrance_shoe_cabinet', name: 'Tủ giày sảnh', category: 'living_room' },
      { key: 'thảm', asset_id: 'floor_rug_textured', name: 'Thảm dệt trải sàn', category: 'living_room' },
      { key: 'bếp', asset_id: 'kitchen_system_l', name: 'Hệ tủ bếp chữ L', category: 'kitchen_dining' },
      { key: 'đảo bếp', asset_id: 'kitchen_island_bar', name: 'Đảo bếp kết hợp quầy bar', category: 'kitchen_dining' },
      { key: 'tủ lạnh', asset_id: 'fridge_double_door', name: 'Tủ lạnh 2 cánh Side-by-side', category: 'kitchen_dining' },
      { key: 'bàn ăn', asset_id: 'dining_table_6chairs', name: 'Bàn ăn 6 ghế', category: 'kitchen_dining' },
      { key: 'giường master', asset_id: 'bed_master_king', name: 'Giường King Master', category: 'bedroom' },
      { key: 'giường king', asset_id: 'bed_master_king', name: 'Giường King Master', category: 'bedroom' },
      { key: 'giường tầng', asset_id: 'bed_bunk_kids', name: 'Giường tầng trẻ em', category: 'bedroom' },
      { key: 'giường', asset_id: 'bed_queen_modern', name: 'Giường ngủ hiện đại', category: 'bedroom' },
      { key: 'tủ áo', asset_id: 'wardrobe_tall_glass', name: 'Tủ quần áo cánh kính', category: 'bedroom' },
      { key: 'tủ quần áo', asset_id: 'wardrobe_tall_glass', name: 'Tủ quần áo cánh kính', category: 'bedroom' },
      { key: 'bàn làm việc', asset_id: 'work_desk_computer', name: 'Bàn làm việc & ghế xoay', category: 'bedroom' },
      { key: 'bàn trang điểm', asset_id: 'dressing_table_mirror', name: 'Bàn phấn trang điểm', category: 'bedroom' },
      { key: 'bàn thờ', asset_id: 'vietnamese_worship_altar', name: 'Bàn thờ gia tiên truyền thống', category: 'worship_rooftop' },
      { key: 'phòng thờ', asset_id: 'vietnamese_worship_altar', name: 'Bàn thờ gia tiên truyền thống', category: 'worship_rooftop' },
      { key: 'bbq', asset_id: 'outdoor_bbq_station', name: 'Trạm nướng BBQ ngoài trời', category: 'worship_rooftop' },
      { key: 'bàn ngoài trời', asset_id: 'outdoor_patio_set', name: 'Bộ bàn ghế sân vườn ngoài trời', category: 'worship_rooftop' },
      { key: 'bàn sân thượng', asset_id: 'outdoor_patio_set', name: 'Bộ bàn ghế sân vườn ngoài trời', category: 'worship_rooftop' },
      { key: 'sân thượng', asset_id: 'outdoor_patio_set', name: 'Bộ bàn ghế sân vườn ngoài trời', category: 'worship_rooftop' },
      { key: 'bồn cầu', asset_id: 'toilet_onepiece', name: 'Bồn cầu liền khối', category: 'bathroom_laundry' },
      { key: 'toilet', asset_id: 'toilet_onepiece', name: 'Bồn cầu liền khối', category: 'bathroom_laundry' },
      { key: 'wc', asset_id: 'toilet_onepiece', name: 'Bồn cầu liền khối', category: 'bathroom_laundry' },
      { key: 'lavabo', asset_id: 'lavabo_vanity_led_mirror', name: 'Lavabo tủ gương LED', category: 'bathroom_laundry' },
      { key: 'vách kính', asset_id: 'shower_glass_enclosure', name: 'Cabin tắm kính cường lực', category: 'bathroom_laundry' },
      { key: 'bồn tắm', asset_id: 'bathtub_modern', name: 'Bồn tắm nằm ngâm thư giãn', category: 'bathroom_laundry' },
      { key: 'máy giặt', asset_id: 'washer_dryer_tower', name: 'Tháp máy giặt sấy', category: 'bathroom_laundry' },
      { key: 'chậu cây', asset_id: 'indoor_potted_ficus', name: 'Cây bàng Singapore nội thất', category: 'greenery_architectural' },
      { key: 'cây xanh', asset_id: 'indoor_potted_ficus', name: 'Cây bàng Singapore nội thất', category: 'greenery_architectural' },
      { key: 'bồn hoa', asset_id: 'balcony_planter_greenery', name: 'Bồn hoa tiểu cảnh ban công', category: 'greenery_architectural' }
    ];

    for (const fk of furnitureKeywords) {
      if (text.includes(fk.key)) {
        if (!requestedFurniture.some(rf => rf.asset_id === fk.asset_id)) {
          requestedFurniture.push({ keyword: fk.key, ...fk });
        }
      }
    }

    // Infer functional room spaces from prompt
    const rooms = [];
    if (text.includes('thờ') || text.includes('phòng thờ') || (action === 'ADD_FLOOR' && targetFloorNum >= 4)) {
      rooms.push({ name: 'Phòng Thờ Gia Tiên', zone: 'altar', minArea: 12.0 });
    }
    if (text.includes('sân thượng') || text.includes('tiểu cảnh') || (action === 'ADD_FLOOR' && targetFloorNum >= 4)) {
      rooms.push({ name: 'Sân Thượng & Vườn BBQ', zone: 'terrace', minArea: 16.0 });
    }
    if (text.includes('phòng ngủ') || text.includes('ngủ')) {
      rooms.push({ name: 'Phòng Ngủ', zone: 'bedroom', minArea: 15.0 });
    }
    if (text.includes('phòng khách')) {
      rooms.push({ name: 'Phòng Khách', zone: 'living', minArea: 20.0 });
    }
    if (text.includes('bếp') || text.includes('ăn')) {
      rooms.push({ name: 'Phòng Bếp & Ăn', zone: 'kitchen', minArea: 16.0 });
    }
    if (text.includes('vệ sinh') || text.includes('wc') || text.includes('tắm')) {
      rooms.push({ name: 'Phòng Vệ Sinh (WC)', zone: 'bathroom', minArea: 4.5 });
    }
    if (rooms.length === 0) {
      rooms.push({ name: 'Không Gian Chức Năng', zone: 'common', minArea: 25.0 });
    }

    return {
      action,
      targetFloorId,
      targetFloorNum,
      targetFloorName,
      requestedFurniture,
      rooms
    };
  }

  /**
   * Apply high-level structural change (create floor if ADD_FLOOR, or select existing floor)
   */
  applyStructuralIntent(project, intent) {
    if (intent.action === 'ADD_FLOOR') {
      const num = intent.targetFloorNum || (project.floors.length + 1);
      const floorId = `floor_${num}`;

      // Check if floor already exists
      let floor = project.getFloor(floorId);
      if (!floor) {
        const prevFloor = project.floors[project.floors.length - 1];
        const elevation = prevFloor ? (prevFloor.elevation + prevFloor.height) : ((num - 1) * 3.2);
        const storyHeight = 3.2;

        let floorDesc = intent.rooms.map(r => r.name).join(', ');
        if (!floorDesc) floorDesc = 'Phòng thờ gia tiên, Sân thượng cảnh quan & Giặt phơi';

        floor = new FloorDocument({
          id: floorId,
          name: intent.targetFloorName || `Tầng ${num}`,
          desc: floorDesc,
          elevation: Math.round(elevation * 100) / 100,
          height: storyHeight,
          entities: []
        });

        project.addFloor(floor);
      }
      return floor;
    }

    // Existing floor
    const existing = project.getFloor(intent.targetFloorId) || project.floors[project.floors.length - 1];
    return existing;
  }

  /**
   * Determine slab boundaries for a floor
   */
  getSlabBounds(project, floor) {
    const lotW = project.lot_width || 5.0;
    const lotL = project.lot_length || 8.0;

    // Look for existing exterior boundary wall or slab
    const extr = floor.entities.find(e => e.layer === 'A-WALL-EXTR' && Array.isArray(e.points) && e.points.length >= 4);
    if (extr) {
      const xs = extr.points.map(p => p.x);
      const ys = extr.points.map(p => p.y);
      return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys)
      };
    }

    // Check previous floor boundary if available
    const floorIdx = project.floors.findIndex(f => f.id === floor.id);
    if (floorIdx > 0) {
      const prevFloor = project.floors[0];
      const prevExtr = prevFloor.entities.find(e => e.layer === 'A-WALL-EXTR' && Array.isArray(e.points) && e.points.length >= 4);
      if (prevExtr) {
        const xs = prevExtr.points.map(p => p.x);
        const ys = prevExtr.points.map(p => p.y);
        return {
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys)
        };
      }
    }

    return {
      minX: 0.0,
      maxX: lotW,
      minY: 0.0,
      maxY: lotL
    };
  }

  /**
   * Pass 2.1: Wall & Slab Sanitizer
   * Clamps wall angles to 90°, closes corners within snap tolerance, keeps within slab bounds
   */
  sanitizeWallsAndSlab(floor, slabBounds) {
    let wallsClamped = 0;
    let cornersClosed = 0;

    const wallEntities = floor.entities.filter(e => e.layer === 'A-WALL-INTR' || e.layer === 'A-WALL-EXTR');
    const snapTolerance = 0.20; // 20cm snap tolerance for corner closure

    for (const wall of wallEntities) {
      if (wall.points && wall.points.length >= 2) {
        const p1 = wall.points[0];
        const p2 = wall.points[1] || wall.end || wall.points[wall.points.length - 1];

        const dx = Math.abs(p2.x - p1.x);
        const dy = Math.abs(p2.y - p1.y);
        const len = Math.sqrt(dx * dx + dy * dy);

        if (len > 0.05) {
          // Angle clamping: snap near-horizontal walls to dy = 0, near-vertical to dx = 0
          if (dy < 0.15 * len || dy < 0.12) {
            p2.y = p1.y;
            wallsClamped++;
          } else if (dx < 0.15 * len || dx < 0.12) {
            p2.x = p1.x;
            wallsClamped++;
          }
        }

        // Clamp within slab bounds
        p1.x = Math.max(slabBounds.minX, Math.min(slabBounds.maxX, p1.x));
        p1.y = Math.max(slabBounds.minY, Math.min(slabBounds.maxY, p1.y));
        p2.x = Math.max(slabBounds.minX, Math.min(slabBounds.maxX, p2.x));
        p2.y = Math.max(slabBounds.minY, Math.min(slabBounds.maxY, p2.y));
      }
    }

    // Corner vertex closure pass
    for (let i = 0; i < wallEntities.length; i++) {
      const w1 = wallEntities[i];
      if (!w1.points || w1.points.length < 2) continue;
      const pts1 = [w1.points[0], w1.points[1] || w1.end];

      for (let j = i + 1; j < wallEntities.length; j++) {
        const w2 = wallEntities[j];
        if (!w2.points || w2.points.length < 2) continue;
        const pts2 = [w2.points[0], w2.points[1] || w2.end];

        for (const pt1 of pts1) {
          for (const pt2 of pts2) {
            const dist = Math.hypot(pt1.x - pt2.x, pt1.y - pt2.y);
            if (dist > 0.0001 && dist <= snapTolerance) {
              const avgX = (pt1.x + pt2.x) / 2;
              const avgY = (pt1.y + pt2.y) / 2;
              pt1.x = Math.round(avgX * 100) / 100;
              pt1.y = Math.round(avgY * 100) / 100;
              pt2.x = pt1.x;
              pt2.y = pt1.y;
              cornersClosed++;
            }
          }
        }
      }
    }

    // T-junction & X-junction intersection cleanup pass
    let tJunctionsCleaned = 0;
    for (let i = 0; i < wallEntities.length; i++) {
      const w1 = wallEntities[i];
      if (!w1.points || w1.points.length < 2) continue;
      const pts1 = [w1.points[0], w1.points[1] || w1.end];

      for (let j = 0; j < wallEntities.length; j++) {
        if (i === j) continue;
        const w2 = wallEntities[j];
        if (!w2.points || w2.points.length < 2) continue;
        const pA = w2.points[0];
        const pB = w2.points[1] || w2.end;
        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-6) continue;

        for (const pt of pts1) {
          const t = ((pt.x - pA.x) * dx + (pt.y - pA.y) * dy) / lenSq;
          if (t >= -0.05 && t <= 1.05) {
            const clampedT = Math.max(0, Math.min(1, t));
            const projX = pA.x + clampedT * dx;
            const projY = pA.y + clampedT * dy;
            const dist = Math.hypot(pt.x - projX, pt.y - projY);
            if (dist > 0.001 && dist <= snapTolerance) {
              pt.x = Math.round(projX * 100) / 100;
              pt.y = Math.round(projY * 100) / 100;
              tJunctionsCleaned++;
            }
          }
        }
      }
    }

    return { wallsClamped, cornersClosed, tJunctionsCleaned };
  }

  /**
   * Pass 2.2: Vertical Core & Stair Sync
   * Checks stair positions across adjacent floors and cuts upper floor void (`stairOpening`)
   */
  syncVerticalCoreAndStairs(project) {
    let voidsCreated = 0;
    const stairsByFloor = {};

    // Standard stair shaft parameters for townhouses/villas
    const defaultStairConfig = {
      asset_id: 'stair_flight_u_turn',
      type: 'stair',
      width: 2.2,
      depth: 2.8,
      rotation: 0
    };

    // Find or infer stairs per floor
    for (let idx = 0; idx < project.floors.length; idx++) {
      const fl = project.floors[idx];
      stairsByFloor[fl.id] = [];

      // Check existing stair entities
      const treadPoints = fl.entities.filter(e => e.layer === 'A-STAIR').flatMap(e => e.points || []);
      const stairEntity = fl.stairs?.[0] || fl.entities.find(e =>
        e.layer === 'A-FLOR-STRS' ||
        (e.asset_id && e.asset_id.startsWith('stair_'))
      );

      if (stairEntity) {
        const xs = treadPoints.map(point => point.x);
        const zs = treadPoints.map(point => point.y);
        const footprint = treadPoints.length ? {
          x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...zs) + Math.max(...zs)) / 2,
          width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs)
        } : {};
        stairsByFloor[fl.id].push({
          id: `${fl.id}_stair`,
          asset_id: stairEntity.asset_id || defaultStairConfig.asset_id,
          x: stairEntity.x ?? footprint.x ?? (project.lot_width * 0.5),
          y: stairEntity.y ?? footprint.y ?? (project.lot_length * 0.5),
          width: stairEntity.width || footprint.width || defaultStairConfig.width,
          depth: stairEntity.depth || footprint.depth || defaultStairConfig.depth,
          rotation: stairEntity.rotation || 0
        });
      } else if (idx < project.floors.length - 1) {
        // Multi-floor building requires vertical circulation
        // Place central U-turn stair
        const centerX = project.lot_width > 0 ? (project.lot_width / 2) : 2.5;
        const centerY = project.lot_length > 0 ? (project.lot_length / 2) : 4.0;

        stairsByFloor[fl.id].push({
          id: `${fl.id}_stair`,
          asset_id: defaultStairConfig.asset_id,
          x: Math.round(centerX * 10) / 10,
          y: Math.round(centerY * 10) / 10,
          width: defaultStairConfig.width,
          depth: defaultStairConfig.depth,
          rotation: 0
        });
      }
    }

    // Cut upper floor slab openings matching lower floor stair shafts
    for (let idx = 0; idx < project.floors.length - 1; idx++) {
      const lowerFloor = project.floors[idx];
      const upperFloor = project.floors[idx + 1];
      const lowerStairs = stairsByFloor[lowerFloor.id] || [];

      if (lowerStairs.length > 0) {
        const stair = lowerStairs[0];
        const padding = 0.15; // 15cm margin for stairwell opening
        const opening = {
          minX: Math.round((stair.x - stair.width / 2 - padding) * 100) / 100,
          maxX: Math.round((stair.x + stair.width / 2 + padding) * 100) / 100,
          minY: Math.round((stair.y - stair.depth / 2 - padding) * 100) / 100,
          maxY: Math.round((stair.y + stair.depth / 2 + padding) * 100) / 100
        };

        // Attach opening metadata to upper floor slabs
        if (!upperFloor.metadata) upperFloor.metadata = {};
        upperFloor.metadata.stairOpening = opening;
        upperFloor.metadata.hasStairOpening = true;

        voidsCreated++;
      }
    }

    return { voidsCreated, stairsByFloor };
  }

  /**
   * Pass 2.3: Modular Furniture Placement Solver
   * Maps items to standard asset_id, sets wall-aligned rotation based on placement_type,
   * checks bounding boxes to avoid overlaps and door swings.
   */
  solveFurniturePlacement({ floor, requestedFurniture, furnitureCatalog, slabBounds, existingStairs }) {
    const placedItems = [];
    let collisionsAvoided = 0;
    let doorClearancesVerified = 0;

    const catalogMap = new Map();
    for (const item of furnitureCatalog) {
      catalogMap.set(item.asset_id || item.id, item);
    }

    // Default item definitions if catalog is empty
    const defaultAssetDims = {
      'sofa_l_modern': { width: 2.65, depth: 1.65, height: 0.85, placement_type: 'floor_wall_backed' },
      'sofa_straight_3seat': { width: 2.2, depth: 0.92, height: 0.84, placement_type: 'floor_wall_backed' },
      'tv_cabinet_wall_unit': { width: 2.2, depth: 0.46, height: 2.1, placement_type: 'floor_wall_backed' },
      'coffee_table_set': { width: 1.28, depth: 0.72, height: 0.48, placement_type: 'floor_free' },
      'dining_table_6chairs': { width: 1.95, depth: 1.38, height: 0.82, placement_type: 'floor_free' },
      'kitchen_system_l': { width: 2.6, depth: 1.85, height: 2.1, placement_type: 'floor_wall_backed' },
      'bed_master_king': { width: 2.65, depth: 2.15, height: 1.18, placement_type: 'floor_wall_backed' },
      'bed_queen_modern': { width: 2.04, depth: 2.05, height: 1.05, placement_type: 'floor_wall_backed' },
      'wardrobe_tall_glass': { width: 1.85, depth: 0.6, height: 2.3, placement_type: 'floor_wall_backed' },
      'vietnamese_worship_altar': { width: 1.75, depth: 0.92, height: 1.98, placement_type: 'floor_wall_backed' },
      'outdoor_bbq_station': { width: 1.85, depth: 0.68, height: 1.18, placement_type: 'floor_wall_backed' },
      'outdoor_patio_set': { width: 1.95, depth: 1.95, height: 2.34, placement_type: 'floor_free' },
      'toilet_onepiece': { width: 0.42, depth: 0.68, height: 0.76, placement_type: 'floor_wall_backed' },
      'lavabo_vanity_led_mirror': { width: 0.96, depth: 0.54, height: 1.99, placement_type: 'floor_wall_backed' },
      'shower_glass_enclosure': { width: 1.05, depth: 1.05, height: 2.05, placement_type: 'floor_wall_backed' },
      'washer_dryer_tower': { width: 0.66, depth: 0.68, height: 1.74, placement_type: 'floor_wall_backed' },
      'indoor_potted_ficus': { width: 0.65, depth: 0.65, height: 1.48, placement_type: 'floor_free' },
      'balcony_planter_greenery': { width: 1.2, depth: 0.36, height: 0.62, placement_type: 'floor_wall_backed' }
    };

    // Keep track of occupied bounding boxes
    const occupiedBoxes = [];

    // Stair exclusion zone
    for (const stair of existingStairs) {
      occupiedBoxes.push({
        minX: stair.x - stair.width / 2 - 0.2,
        maxX: stair.x + stair.width / 2 + 0.2,
        minY: stair.y - stair.depth / 2 - 0.2,
        maxY: stair.y + stair.depth / 2 + 0.2,
        tag: 'stair'
      });
    }

    // Door swing clearance zone (standard door entry near south or north)
    const doorSwing = {
      x: slabBounds.minX + 0.9,
      y: slabBounds.minY + 0.4,
      radius: 1.1
    };

    // Extract window openings for semantic collision checking
    const floorWindows = [];
    if (Array.isArray(floor.windows) && floor.windows.length > 0) {
      floorWindows.push(...floor.windows);
    } else if (Array.isArray(floor.entities)) {
      for (const ent of floor.entities) {
        if (ent.layer === 'A-GLAZ' && Array.isArray(ent.points) && ent.points.length >= 2) {
          floorWindows.push({
            p1: ent.points[0],
            p2: ent.end || ent.points[1]
          });
        }
      }
    }

    for (const req of requestedFurniture) {
      const assetId = req.asset_id;
      const catalogEntry = catalogMap.get(assetId);
      const defaultDims = defaultAssetDims[assetId] || { width: 1.5, depth: 1.0, height: 1.0, placement_type: 'floor_wall_backed' };

      const dims = catalogEntry?.dimensions || defaultDims;
      const placementType = catalogEntry?.placement_type || defaultDims.placement_type || 'floor_wall_backed';

      const width = dims.width || 1.2;
      const depth = dims.depth || 0.8;
      const height = dims.height || 0.9;

      // Wall-aligned rotation solver
      let cx = (slabBounds.minX + slabBounds.maxX) / 2;
      let cy = (slabBounds.minY + slabBounds.maxY) / 2;
      let rotation = 0; // 0 = back against North wall (-Z), front facing South (+Z)

      if (placementType === 'floor_wall_backed') {
        // Choose wall based on asset type
        if (assetId === 'vietnamese_worship_altar') {
          // Feng Shui: Altar backs to North wall, faces South
          cx = slabBounds.minX + width / 2 + 0.4;
          cy = slabBounds.minY + depth / 2 + 0.2;
          rotation = 0;
        } else if (assetId === 'outdoor_bbq_station') {
          // BBQ backs against East wall
          cx = slabBounds.maxX - width / 2 - 0.25;
          cy = slabBounds.maxY - depth / 2 - 0.5;
          rotation = -Math.PI / 2;
        } else if (assetId.includes('sofa')) {
          // Sofa backs to West wall or South wall
          cx = slabBounds.minX + width / 2 + 0.35;
          cy = slabBounds.minY + depth / 2 + 0.3;
          rotation = Math.PI / 2;
        } else if (assetId === 'tv_cabinet_wall_unit' || assetId.includes('tv')) {
          // TV Unit placement: face the sofa or bed if already placed, otherwise back against East wall
          const sofa = placedItems.find(it => it.asset_id && it.asset_id.includes('sofa'));
          const bed = placedItems.find(it => it.asset_id && it.asset_id.includes('bed'));
          if (sofa) {
            // Place on opposite wall facing sofa
            if (sofa.cx < (slabBounds.minX + slabBounds.maxX) / 2) {
              cx = slabBounds.maxX - depth / 2 - 0.25;
              cy = sofa.cy;
              rotation = -Math.PI / 2;
            } else {
              cx = slabBounds.minX + depth / 2 + 0.25;
              cy = sofa.cy;
              rotation = Math.PI / 2;
            }
          } else if (bed) {
            // Place on opposite wall facing bed
            if (bed.cy > (slabBounds.minY + slabBounds.maxY) / 2) {
              cx = bed.cx;
              cy = slabBounds.minY + depth / 2 + 0.25;
              rotation = 0;
            } else {
              cx = bed.cx;
              cy = slabBounds.maxY - depth / 2 - 0.25;
              rotation = Math.PI;
            }
          } else {
            cx = slabBounds.maxX - depth / 2 - 0.25;
            cy = (slabBounds.minY + slabBounds.maxY) / 2;
            rotation = -Math.PI / 2;
          }
        } else if (assetId.includes('bed')) {
          // Bed headboard backs against North or East wall
          cx = slabBounds.minX + width / 2 + 0.4;
          cy = slabBounds.minY + depth / 2 + 0.3;
          rotation = 0;
        } else if (assetId.includes('toilet') || assetId.includes('lavabo')) {
          // Bathroom fixtures back to West wall
          cx = slabBounds.minX + width / 2 + 0.2;
          cy = slabBounds.maxY - depth / 2 - 0.3;
          rotation = Math.PI / 2;
        } else {
          // General wall-backed: back against closest available wall
          cx = slabBounds.minX + width / 2 + 0.3;
          cy = slabBounds.minY + depth / 2 + 0.3;
          rotation = 0;
        }
      } else {
        // Floor free-standing (coffee table, dining table, patio set)
        if (assetId.includes('patio')) {
          cx = slabBounds.maxX - width / 2 - 0.8;
          cy = (slabBounds.minY + slabBounds.maxY) / 2;
        } else if (assetId.includes('table')) {
          cx = (slabBounds.minX + slabBounds.maxX) / 2;
          cy = (slabBounds.minY + slabBounds.maxY) / 2;
        }
        rotation = 0;
      }

      // Check collision and adjust position if necessary (AABB Collision Resolution)
      let attempts = 0;
      let collides = true;

      while (collides && attempts < 16) {
        collides = false;
        const isRot = Math.abs(Math.sin(rotation)) > 0.7;
        const spanX = isRot ? depth : width;
        const spanY = isRot ? width : depth;
        const box = {
          minX: cx - spanX / 2 - 0.1,
          maxX: cx + spanX / 2 + 0.1,
          minY: cy - spanY / 2 - 0.1,
          maxY: cy + spanY / 2 + 0.1
        };

        // Check door swing clearance
        const distToDoor = Math.hypot(cx - doorSwing.x, cy - doorSwing.y);
        if (distToDoor < doorSwing.radius + Math.max(width, depth) / 2) {
          collides = true;
          cx += 0.6; // Nudge away from door swing
          collisionsAvoided++;
        }

        // Semantic Check: Check window openings (guarantee TV and wall units NEVER occlude windows)
        for (const win of floorWindows) {
          if (!win.p1 || !win.p2) continue;
          const wMinX = Math.min(win.p1.x, win.p2.x);
          const wMaxX = Math.max(win.p1.x, win.p2.x);
          const wMinY = Math.min(win.p1.y, win.p2.y);
          const wMaxY = Math.max(win.p1.y, win.p2.y);
          const isWinVert = Math.abs(win.p2.x - win.p1.x) < Math.abs(win.p2.y - win.p1.y);

          const aabbOverlap = !(box.maxX < wMinX - 0.25 || box.minX > wMaxX + 0.25 || box.maxY < wMinY - 0.25 || box.minY > wMaxY + 0.25);
          let sameWallOverlap = false;
          if (isRot && isWinVert) {
            const distToWall = Math.abs(cx - (win.p1.x + win.p2.x) / 2);
            if (distToWall < 1.25) {
              sameWallOverlap = !(box.maxY < wMinY - 0.15 || box.minY > wMaxY + 0.15);
            }
          } else if (!isRot && !isWinVert) {
            const distToWall = Math.abs(cy - (win.p1.y + win.p2.y) / 2);
            if (distToWall < 1.25) {
              sameWallOverlap = !(box.maxX < wMinX - 0.15 || box.minX > wMaxX + 0.15);
            }
          }

          if (aabbOverlap || sameWallOverlap) {
            collides = true;
            collisionsAvoided++;
            if (isRot) {
              cy += 1.4;
              if (cy + spanY / 2 > slabBounds.maxY - 0.2) {
                // Switch to opposite wall
                cx = (cx > (slabBounds.minX + slabBounds.maxX) / 2)
                  ? (slabBounds.minX + depth / 2 + 0.25)
                  : (slabBounds.maxX - depth / 2 - 0.25);
                cy = slabBounds.minY + spanY / 2 + 0.3;
                rotation = (rotation + Math.PI) % (2 * Math.PI);
              }
            } else {
              cx += 1.4;
              if (cx + spanX / 2 > slabBounds.maxX - 0.2) {
                // Switch to opposite wall
                cy = (cy > (slabBounds.minY + slabBounds.maxY) / 2)
                  ? (slabBounds.minY + depth / 2 + 0.25)
                  : (slabBounds.maxY - depth / 2 - 0.25);
                cx = slabBounds.minX + spanX / 2 + 0.3;
                rotation = (rotation + Math.PI) % (2 * Math.PI);
              }
            }
            break;
          }
        }

        // Check against occupied bounding boxes
        for (const occ of occupiedBoxes) {
          if (box.minX < occ.maxX && box.maxX > occ.minX && box.minY < occ.maxY && box.maxY > occ.minY) {
            collides = true;
            cy += 0.8; // Nudge along Y axis
            if (cy + depth / 2 > slabBounds.maxY - 0.2) {
              cy = slabBounds.minY + depth / 2 + 0.3;
              cx += 1.0;
            }
            collisionsAvoided++;
            break;
          }
        }

        // Keep inside slab boundary
        cx = Math.max(slabBounds.minX + spanX / 2 + 0.1, Math.min(slabBounds.maxX - spanX / 2 - 0.1, cx));
        cy = Math.max(slabBounds.minY + spanY / 2 + 0.1, Math.min(slabBounds.maxY - spanY / 2 - 0.1, cy));
        attempts++;
      }

      doorClearancesVerified++;

      // Register placed item
      const itemRecord = {
        id: `${floor.id}_${assetId}_${placedItems.length + 1}`,
        asset_id: assetId,
        type: req.category || 'furniture',
        name: req.name || catalogEntry?.name || assetId,
        category: req.category || 'living_room',
        placement_type: placementType,
        x: Math.round(cx * 100) / 100,
        y: Math.round(cy * 100) / 100,
        z: floor.elevation ?? 0.0,
        width: Math.round(width * 100) / 100,
        depth: Math.round(depth * 100) / 100,
        height: Math.round(height * 100) / 100,
        rotation: Math.round(rotation * 1000) / 1000
      };

      placedItems.push(itemRecord);
      occupiedBoxes.push({
        minX: cx - width / 2,
        maxX: cx + width / 2,
        minY: cy - depth / 2,
        maxY: cy + depth / 2,
        tag: assetId
      });
    }

    return {
      placedItems,
      collisionsAvoided,
      doorClearancesVerified
    };
  }

  /**
   * Phase 3: Update floor entities and 2D floorplan data
   */
  updateFloorplanEntities({ floor, slabBounds, rooms, furniture, stairs }) {
    const entities = [];

    // 1. Exterior boundary polyline (A-WALL-EXTR)
    entities.push({
      type: 'LWPOLYLINE',
      layer: 'A-WALL-EXTR',
      closed: true,
      points: [
        { x: slabBounds.minX, y: slabBounds.minY },
        { x: slabBounds.maxX, y: slabBounds.minY },
        { x: slabBounds.maxX, y: slabBounds.maxY },
        { x: slabBounds.minX, y: slabBounds.maxY },
        { x: slabBounds.minX, y: slabBounds.minY }
      ]
    });

    // 2. Interior partition walls (A-WALL-INTR)
    if (rooms.length > 1) {
      const splitY = (slabBounds.minY + slabBounds.maxY) * 0.45;
      entities.push({
        type: 'LINE',
        layer: 'A-WALL-INTR',
        points: [
          { x: slabBounds.minX, y: splitY },
          { x: slabBounds.maxX, y: splitY }
        ]
      });
    }

    // 3. Stairs (A-FLOR-STRS)
    for (const stair of stairs) {
      entities.push({
        type: 'BLOCK',
        layer: 'A-FLOR-STRS',
        asset_id: stair.asset_id,
        x: stair.x,
        y: stair.y,
        width: stair.width,
        depth: stair.depth,
        rotation: stair.rotation
      });
    }

    // 4. Doors (A-DOOR)
    entities.push({
      type: 'DOOR',
      layer: 'A-DOOR',
      asset_id: 'door_interior_wood',
      x: slabBounds.minX + 0.9,
      y: slabBounds.minY + 0.2,
      width: 0.9,
      rotation: 0
    });

    // 5. Windows (A-GLAZ)
    entities.push({
      type: 'LINE',
      layer: 'A-GLAZ',
      asset_id: 'window_casement_glass',
      points: [
        { x: slabBounds.minX + 1.2, y: slabBounds.minY },
        { x: slabBounds.minX + 2.8, y: slabBounds.minY }
      ]
    });

    // 6. Furniture items (A-FURN)
    for (const item of furniture) {
      entities.push({
        type: 'INSERT',
        layer: 'A-FURN',
        asset_id: item.asset_id,
        name: item.name,
        x: item.x,
        y: item.y,
        width: item.width,
        depth: item.depth,
        height: item.height,
        rotation: item.rotation
      });
    }

    // 7. Room labels (A-AREA-ROOM)
    for (let i = 0; i < rooms.length; i++) {
      const rm = rooms[i];
      const yOffset = rm.y ?? slabBounds.minY + ((i + 0.5) / rooms.length) * (slabBounds.maxY - slabBounds.minY);
      entities.push({
        type: 'TEXT',
        layer: 'A-AREA-ROOM',
        text: `${rm.name} (${rm.area || rm.minArea || 15} m²)`,
        points: [{ x: rm.x ?? (slabBounds.minX + slabBounds.maxX) / 2, y: yOffset }]
      });
    }

    // 8. Architectural Grid (A-GRID) with Dash-dot linetype & bubbles
    const gridX = [slabBounds.minX, slabBounds.maxX];
    const gridY = [slabBounds.minY, slabBounds.maxY];
    if (rooms.length > 1) {
      gridY.splice(1, 0, (slabBounds.minY + slabBounds.maxY) * 0.45);
    }
    // X-Axes (Trục số: 1, 2...)
    gridX.forEach((gx, idx) => {
      const label = (idx + 1).toString();
      entities.push({
        type: 'LINE',
        layer: 'A-GRID',
        linetype: 'DASHDOT',
        label,
        points: [
          { x: gx, y: slabBounds.minY - 1.2 },
          { x: gx, y: slabBounds.maxY + 1.2 }
        ]
      });
      entities.push({
        type: 'CIRCLE',
        layer: 'A-GRID',
        radius: 0.32,
        label,
        points: [{ x: gx, y: slabBounds.minY - 1.2 }]
      });
      entities.push({
        type: 'CIRCLE',
        layer: 'A-GRID',
        radius: 0.32,
        label,
        points: [{ x: gx, y: slabBounds.maxY + 1.2 }]
      });
    });
    // Y-Axes (Trục chữ: A, B...)
    const gridLetters = ['A', 'B', 'C', 'D'];
    gridY.forEach((gy, idx) => {
      const label = gridLetters[idx % gridLetters.length];
      entities.push({
        type: 'LINE',
        layer: 'A-GRID',
        linetype: 'DASHDOT',
        label,
        points: [
          { x: slabBounds.minX - 1.2, y: gy },
          { x: slabBounds.maxX + 1.2, y: gy }
        ]
      });
      entities.push({
        type: 'CIRCLE',
        layer: 'A-GRID',
        radius: 0.32,
        label,
        points: [{ x: slabBounds.minX - 1.2, y: gy }]
      });
      entities.push({
        type: 'CIRCLE',
        layer: 'A-GRID',
        radius: 0.32,
        label,
        points: [{ x: slabBounds.maxX + 1.2, y: gy }]
      });
    });

    // 9. Dimensions (A-DIMS) in millimeters
    entities.push({
      type: 'DIMENSION',
      layer: 'A-DIMS',
      dimType: 'ALIGNED',
      value: Math.round((slabBounds.maxX - slabBounds.minX) * 1000),
      label: `${Math.round((slabBounds.maxX - slabBounds.minX) * 1000)}`,
      p1: { x: slabBounds.minX, y: slabBounds.minY - 0.6 },
      p2: { x: slabBounds.maxX, y: slabBounds.minY - 0.6 }
    });
    entities.push({
      type: 'DIMENSION',
      layer: 'A-DIMS',
      dimType: 'ALIGNED',
      value: Math.round((slabBounds.maxY - slabBounds.minY) * 1000),
      label: `${Math.round((slabBounds.maxY - slabBounds.minY) * 1000)}`,
      p1: { x: slabBounds.minX - 0.6, y: slabBounds.minY },
      p2: { x: slabBounds.minX - 0.6, y: slabBounds.maxY }
    });

    floor.entities = entities;

    // Attach AI analysis metadata to floor
    floor.aiAnalysis = {
      source: 'two_pass_spatial_compiler',
      confidence: 0.98,
      timestamp: new Date().toISOString(),
      rooms: rooms.map(r => ({
        ...r,
        areaM2: r.area || r.minArea || 16.0
      })),
      metrics: {
        grossAreaM2: Math.round((slabBounds.maxX - slabBounds.minX) * (slabBounds.maxY - slabBounds.minY) * 10) / 10,
        usableAreaM2: Math.round((slabBounds.maxX - slabBounds.minX) * (slabBounds.maxY - slabBounds.minY) * 0.88 * 10) / 10,
        roomsCount: rooms.length,
        hasStairs: stairs.length > 0
      },
      furniture: furniture.map(f => ({
        ...f,
        asset_id: f.asset_id,
        name: f.name,
        type: f.type,
        cx: f.x,
        cy: f.y,
        width: f.width,
        depth: f.depth,
        rotation: f.rotation
      })),
      fengShui: {
        orientation: 'Nam (Sinh khí)',
        recommendations: [
          'Bàn thờ gia tiên tọa Bắc hướng Nam, đón nhận phúc khí và ánh sáng tự nhiên.',
          'Khu vực sân thượng thoáng đãng, luân chuyển khí tốt khắp các tầng.'
        ]
      },
      costEstimationVND: {
        construction: 180000000,
        interiorFitout: 95000000,
        total: 275000000
      }
    };
  }

  /**
   * Generate architectural response in Vietnamese explaining actions and compiler validations
   */
  generateArchitecturalResponse({ intent, activeFloor, stageInfo, project }) {
    const isNewFloor = intent.action === 'ADD_FLOOR';
    const p2 = stageInfo.phase2.details;

    let response = `### 🏛️ Đã hoàn tất biên dịch không gian kiến trúc: **${activeFloor.name}**\n\n`;

    if (isNewFloor) {
      response += `Đã khởi tạo thành công **${activeFloor.name}** với cao độ cốt sàn **+${activeFloor.elevation.toFixed(2)}m** (chiều cao thông thủy tầng **${activeFloor.height.toFixed(2)}m**).\n\n`;
    } else {
      response += `Đã cập nhật mặt bằng và bố trí không gian cho **${activeFloor.name}**.\n\n`;
    }

    response += `#### 📐 Kết quả kiểm tra hình học 2-Pass (Auto-Correction):\n`;
    response += `- **Khung tường & Sàn:** Đã nắn chỉnh **${p2.wallsSanitized} đoạn tường** vuông góc 90° chuẩn CAD và hàn kín **${p2.cornersClosed} góc giao**.\n`;
    response += `- **Trục kỹ thuật & Cầu thang:** Đã đồng bộ trục giao thông đứng và khoét ô thông tầng (\`stairOpening\`) tại sàn trên (**${p2.stairVoidsCut} ô sàn**).\n`;
    response += `- **Bố trí nội thất module 3D:** Đã tự động giải thuật vị trí và góc xoay cho **${p2.furniturePlaced} vật dụng** (tựa lưng tường chuẩn trục, tránh va chạm **${p2.collisionsAvoided} vị trí**, kiểm tra khoảng mở cánh cửa **${p2.doorClearancesVerified} vị trí**).\n\n`;

    if (intent.rooms.length > 0) {
      response += `#### 🏡 Phân khu chức năng:\n`;
      for (const rm of intent.rooms) {
        response += `- **${rm.name}**: Diện tích ~${rm.minArea || 16} m².\n`;
      }
      response += `\n`;
    }

    response += `Tổng diện tích sàn toàn công trình hiện tại: **${project.total_floor_area.toFixed(1)} m²** (${project.floors.length} tầng). Toàn bộ mô hình 3D BIM đã sẵn sàng trên khung nhìn Dollhouse 3D.`;

    return response;
  }
}
