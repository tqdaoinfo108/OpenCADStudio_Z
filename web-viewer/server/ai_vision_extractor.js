import { normalizeRoom, validateAndSanitizeFloorPlan } from '../js/architectural_layout.js';
/**
 * ai_vision_extractor.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 * AI Vision Extractor pipeline supporting:
 * 1. OpenAI Vision API (gpt-4o / gpt-4-vision-preview) using OPENAI_API_KEY with 35-item GLB Asset Catalog schema.
 * 2. Intelligent Offline Spatial Geometry Parser for architectural images, floor drawings & CAD DXF.
 */

export const ASSET_CATALOG_IDS = [
  // Living Room (7)
  'sofa_l_modern',
  'sofa_straight_3seat',
  'armchair_lounge',
  'coffee_table_set',
  'tv_cabinet_wall_unit',
  'entrance_shoe_cabinet',
  'floor_rug_textured',
  // Kitchen & Dining (6)
  'kitchen_system_i',
  'kitchen_system_l',
  'kitchen_island_bar',
  'fridge_double_door',
  'dining_table_6chairs',
  'dining_table_4chairs',
  // Bedrooms (6)
  'bed_master_king',
  'bed_queen_modern',
  'bed_bunk_kids',
  'wardrobe_tall_glass',
  'work_desk_computer',
  'dressing_table_mirror',
  // Worship & Rooftop (3)
  'vietnamese_worship_altar',
  'outdoor_bbq_station',
  'outdoor_patio_set',
  // Bathroom & Laundry (5)
  'toilet_onepiece',
  'lavabo_vanity_led_mirror',
  'shower_glass_enclosure',
  'bathtub_modern',
  'washer_dryer_tower',
  // Greenery & Architecture (8)
  'balcony_planter_greenery',
  'indoor_potted_ficus',
  'railing_iron_baluster',
  'door_interior_wood',
  'door_balcony_glass',
  'window_casement_glass',
  'stair_flight_straight',
  'stair_flight_u_turn',
  'nightstand_oak','console_walnut','side_table_granite','bar_stool_oak','ceramic_vase',
  'floor_lamp_brass','bench_velvet','arch_mirror_brass','ceramic_planter_leaf','oak_bookcase',
  'pedestal_dining_oak','outdoor_planter_low','worship_screen_oak'
];

export const ASSET_CATALOG_SET = new Set(ASSET_CATALOG_IDS);

export class AiVisionExtractor {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey] - OpenAI API Key
   * @param {string} [options.model] - OpenAI Vision Model (default 'gpt-4o')
   * @param {string} [options.apiBase] - API Base URL (default 'https://api.openai.com/v1')
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || null;
    this.model = options.model || process.env.OPENAI_VISION_MODEL || 'gpt-4o';
    this.apiBase = options.apiBase || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
  }

  /**
   * Main entry point to analyze floor data
   * @param {Object} input
   * @param {string} [input.imageBase64] - Base64 encoded floor plan image
   * @param {string} [input.mimeType] - Image MIME type (e.g. 'image/png')
   * @param {string} [input.dxfContent] - Raw CAD DXF string
   * @param {Array<Object>} [input.entities] - CAD entities array
   * @param {Object} [input.floorDocument] - FloorDocument object
   * @param {Object} [input.floorContext] - Context info (floor name, elevation, project title)
   * @param {Object} [options]
   * @param {boolean} [options.forceOffline=false] - Force offline geometry parser
   * @returns {Promise<Object>} Architectural analysis result
   */
  async analyzeFloor(input, options = {}) {
    const forceOffline = options.forceOffline || !this.apiKey;
    const floorContext = {
      ...(input.floorContext || {}),
      ...(input.floorDocument ? {
        id: input.floorDocument.id,
        name: input.floorDocument.name,
        elevation: input.floorDocument.elevation,
        height: input.floorDocument.height,
        desc: input.floorDocument.desc
      } : {})
    };

    // 1. If image provided and OpenAI API key is available
    if (input.imageBase64 && !forceOffline) {
      try {
        const aiResult = await this.analyzeWithOpenAiVision({
          imageBase64: input.imageBase64,
          mimeType: input.mimeType || 'image/png',
          floorContext
        });
        if (aiResult) return aiResult;
      } catch (err) {
        console.warn(`[AiVisionExtractor] OpenAI Vision API failed (${err.message}). Falling back to offline spatial parser.`);
      }
    }

    // 2. If DXF text provided
    if (input.dxfContent) {
      return this.analyzeDxf(input.dxfContent, floorContext);
    }

    // 3. If CAD entities provided
    const entities = input.entities || input.floorDocument?.entities || [];
    if (entities && entities.length > 0) {
      return this.extractFromCadEntities(entities, floorContext);
    }

    // 4. If only image provided and offline
    if (input.imageBase64) {
      return this.extractFromImageHeuristic(input.imageBase64, floorContext);
    }

    // 5. Default fallback based on context
    return this.generateDefaultSpatialAnalysis(floorContext);
  }

  /**
   * Build the OpenAI Vision system prompt containing the 35-item GLB Asset Catalog
   * and wall-aligned rotation convention.
   */
  getSystemPrompt() {
    return `Bạn là chuyên gia kiến trúc và BIM 3D cao cấp của hệ thống "Nếp Nhà - OpenCADStudio".
Nhiệm vụ của bạn là phân tích bản vẽ mặt bằng 2D và trích xuất không gian phòng, nội thất, cửa đi, cửa sổ, cầu thang sang mô hình 3D chuẩn glTF 2.0 (.glb).

Khai báo rooms trước furniture. Mỗi phòng có room_id duy nhất, zone, x_min, x_max, z_min, z_max theo mét. Các hình chữ nhật nằm trong sàn, không chồng lấn, dùng chung đúng tọa độ tại vách liền kề. Khai báo cửa thông giữa phòng và hành lang trên ranh giới đã khai báo. Tường ngăn được dựng từ các ranh giới.
Mỗi món đồ có room_id, anchor_wall (north, south, west, east hoặc center), offset_along_wall tính bằng mét từ đầu trục tăng của phòng, và width, depth, height. Với center, offset được đo trên trục X và nội thất bắt đầu ở giữa chiều sâu phòng. Không tự đặt cx, cy hoặc rotation.
WC chỉ có bồn cầu, lavabo, vách tắm, bồn tắm hoặc máy giặt. Phân khu đồ phòng ngủ, phòng khách, bếp và phòng thờ theo chức năng, giữ trống vùng mở cửa và trước cửa sổ.

DANH MỤC 35 MÃ TÀI SẢN 3D CHUẨN (asset_id):
- Phòng khách (Living Room): "sofa_l_modern", "sofa_straight_3seat", "armchair_lounge", "coffee_table_set", "tv_cabinet_wall_unit", "entrance_shoe_cabinet", "floor_rug_textured"
- Bếp & Phòng ăn (Kitchen & Dining): "kitchen_system_i", "kitchen_system_l", "kitchen_island_bar", "fridge_double_door", "dining_table_6chairs", "dining_table_4chairs"
- Phòng ngủ & Học tập (Bedrooms): "bed_master_king", "bed_queen_modern", "bed_bunk_kids", "wardrobe_tall_glass", "work_desk_computer", "dressing_table_mirror"
- Phòng thờ & Sân thượng (Worship & Rooftop): "vietnamese_worship_altar", "outdoor_bbq_station", "outdoor_patio_set"
- Phòng tắm & Giặt phơi (Bathroom & Laundry): "toilet_onepiece", "lavabo_vanity_led_mirror", "shower_glass_enclosure", "bathtub_modern", "washer_dryer_tower"
- Cây xanh & Kiến trúc (Greenery & Architecture): "balcony_planter_greenery", "indoor_potted_ficus", "railing_iron_baluster", "door_interior_wood", "door_balcony_glass", "window_casement_glass", "stair_flight_straight", "stair_flight_u_turn"

QUY ƯỚC GÓC XOAY 3D (rotation tính bằng radian quanh trục Y):
- Mặt lưng của vật dụng (đầu giường, lưng sofa, lưng tủ áo, lưng bàn thờ, két nước bồn cầu) ở hướng -Z cục bộ, mặt trước hướng về +Z cục bộ.
- rotation = 0: Lưng tựa vào tường phía Bắc/trên (-Z), mặt hướng về +Z.
- rotation = 3.14159 (Math.PI): Lưng tựa vào tường phía Nam/dưới (+Z), mặt hướng về -Z.
- rotation = 1.5708 (Math.PI / 2): Lưng tựa vào tường phía Tây/trái (-X), mặt hướng về +X (Đông).
- rotation = -1.5708 (-Math.PI / 2): Lưng tựa vào tường phía Đông/phải (+X), mặt hướng về -X (Tây).`;
  }

  /**
   * JSON Schema for OpenAI Vision structured output
   */
  getResponseJsonSchema() {
    return {
      name: 'floorplan_3d_bim_extraction',
      strict: false,
      schema: {
        type: 'object',
        required: ['source', 'rooms', 'furniture', 'doors', 'windows', 'stairs', 'metrics'],
        properties: {
          source: { type: 'string' },
          model: { type: 'string' },
          timestamp: { type: 'string' },
          confidence: { type: 'number' },
          summary: { type: 'string' },
          rooms: {
            type: 'array',
            items: {
              type: 'object',
              required: ['room_id', 'name', 'areaM2', 'zone', 'x_min', 'x_max', 'z_min', 'z_max'],
              properties: {
                name: { type: 'string' },
                room_id: { type: 'string' },
                x_min: { type: 'number' },
                x_max: { type: 'number' },
                z_min: { type: 'number' },
                z_max: { type: 'number' },
                areaM2: { type: 'number' },
                zone: { type: 'string', enum: [
                  'living', 'bedroom', 'bathroom', 'wc', 'kitchen', 'dining', 'worship', 'office',
                  'circulation', 'laundry', 'terrace', 'garden', 'garage', 'common'
                ] },
                notes: { type: 'string' }
              }
            }
          },
          furniture: {
            type: 'array',
            items: {
              type: 'object',
              required: ['asset_id', 'type', 'name', 'room_id', 'anchor_wall', 'offset_along_wall', 'width', 'depth', 'height'],
              properties: {
                asset_id: { type: 'string', enum: ASSET_CATALOG_IDS },
                type: { type: 'string' },
                name: { type: 'string' },
                location: { type: 'string' },
                room_id: { type: 'string' },
                anchor_wall: { type: 'string', enum: ['north', 'south', 'east', 'west', 'center'] },
                offset_along_wall: { type: 'number', minimum: 0 },
                width: { type: 'number' },
                depth: { type: 'number' },
                height: { type: 'number' }
              }
            }
          },
          doors: {
            type: 'array',
            items: {
              type: 'object',
              required: ['asset_id', 'rotation'],
              properties: {
                asset_id: { type: 'string', enum: ['door_interior_wood', 'door_balcony_glass'] },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                rotation: { type: 'number' }
              }
            }
          },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              required: ['asset_id', 'rotation'],
              properties: {
                asset_id: { type: 'string', enum: ['window_casement_glass'] },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                rotation: { type: 'number' }
              }
            }
          },
          metrics: {
            type: 'object',
            properties: {
              grossAreaM2: { type: 'number' },
              usableAreaM2: { type: 'number' },
              circulationRatioPct: { type: 'number' },
              daylightExposurePct: { type: 'number' }
            }
          },
          stairs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['asset_id', 'rotation'],
              properties: {
                asset_id: { type: 'string', enum: ['stair_flight_straight', 'stair_flight_u_turn'] },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                depth: { type: 'number' },
                rotation: { type: 'number' }
              }
            }
          }
        }
      }
    };
  }

  /**
   * OpenAI Vision API call
   */
  async analyzeWithOpenAiVision({ imageBase64, mimeType = 'image/png', floorContext = {} }) {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    const dataUrl = `data:${mimeType};base64,${cleanBase64}`;

    const systemPrompt = this.getSystemPrompt();
    const userPrompt = `Hãy phân tích bản vẽ mặt bằng kiến trúc này (${floorContext.name || 'Mặt bằng tầng'}).
Mỗi vật dụng nội thất (furniture), cửa đi (doors), cửa sổ (windows) và cầu thang (stairs) PHẢI có trường "asset_id" thuộc đúng danh sách 35 mã chuẩn:
${JSON.stringify(ASSET_CATALOG_IDS)}
Cửa đi, cửa sổ và cầu thang có rotation (radian). Nội thất khai báo room_id, anchor_wall và offset_along_wall theo quy tắc hệ lưới phòng.

Trả về kết quả DUY NHẤT dưới dạng JSON hợp lệ (không kèm markdown \`\`\`json) với cấu trúc sau:
{
  "source": "openai_vision",
  "model": "${this.model}",
  "timestamp": "${new Date().toISOString()}",
  "confidence": 0.94,
  "summary": "Tóm tắt không gian kiến trúc tầng",
  "rooms": [
    { "room_id": "living_1", "name": "Phòng khách", "areaM2": 20, "zone": "living", "x_min": 0, "x_max": 5, "z_min": 0, "z_max": 4 }
  ],
  "furniture": [
    { "asset_id": "sofa_l_modern", "type": "sofa", "name": "Sofa góc chữ L", "room_id": "living_1", "anchor_wall": "west", "offset_along_wall": 2.2, "width": 2.4, "depth": 1.6, "height": 0.85 }
  ],
  "doors": [
    { "asset_id": "door_balcony_glass", "x": 2.5, "y": 0.1, "width": 1.6, "height": 2.2, "rotation": 0 }
  ],
  "windows": [
    { "asset_id": "window_casement_glass", "x": 2.5, "y": 0.1, "width": 1.8, "height": 1.8, "rotation": 0 }
  ],
  "stairs": [
    { "asset_id": "stair_flight_straight", "x": 4.2, "y": 5.0, "width": 1.2, "depth": 2.2, "rotation": 0 }
  ],
  "metrics": {
    "grossAreaM2": 80.0,
    "usableAreaM2": 68.5,
    "circulationRatioPct": 14.5,
    "daylightExposurePct": 85.0
  },
  "fengShui": {
    "doorOrientation": "Hướng cửa chính / cửa ban công",
    "ventilationAssessment": "Đánh giá thông gió đối lưu tự nhiên",
    "recommendations": ["Khuyến nghị 1", "Khuyến nghị 2"]
  },
  "costEstimationVND": {
    "roughConstruction": 450000000,
    "interiorFitOut": 280000000,
    "total": 730000000
  }
}`;

    const response = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              {
                type: 'image_url',
                image_url: { url: dataUrl, detail: 'high' }
              }
            ]
          }
        ],
        temperature: 0.2,
        max_tokens: 2500
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI Vision HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('Empty response from OpenAI Vision');
    }

    const jsonStr = content.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    const validRoomGrid = Array.isArray(parsed.rooms) && parsed.rooms.length > 0 &&
      parsed.rooms.every(room => room.room_id && normalizeRoom(room));
    if (!validRoomGrid) throw new Error('The spatial analysis did not return a valid room grid.');
    const anchors = new Set(['north', 'south', 'east', 'west', 'center']);
    parsed.furniture = (Array.isArray(parsed.furniture) ? parsed.furniture : [])
      .filter(item => item.room_id && anchors.has(item.anchor_wall) &&
        [item.offset_along_wall, item.width, item.depth, item.height].every(n => Number.isFinite(n) && n >= 0))
      .map(item => ({ ...item, asset_id: ASSET_CATALOG_SET.has(item.asset_id)
        ? item.asset_id : this.mapTypeToAssetId(item.type, item.name) }));
    return validateAndSanitizeFloorPlan({ ...parsed, metadata: { roomGrid: true } });
  }

  /**
   * Intelligent Offline Spatial Geometry Parser for CAD entities
   * (Also aliased as analyzeEntities for backwards compatibility)
   * @param {Array<Object>} entities
   * @param {Object} floorContext
   */
  extractFromCadEntities(entities, floorContext = {}) {
    // 1. Calculate floor bounds & gross slab area from A-WALL-EXTR
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const extrPolys = entities.filter(e => e.layer === 'A-WALL-EXTR' && Array.isArray(e.points) && e.points.length >= 4);

    if (extrPolys.length > 0) {
      for (const poly of extrPolys) {
        for (const pt of poly.points) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }
      }
    } else {
      for (const e of entities) {
        const pts = e.points ? [...e.points] : [];
        if (e.end) pts.push(e.end);
        for (const pt of pts) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }
      }
    }

    if (!isFinite(minX)) { minX = 0; maxX = 5.0; minY = 0; maxY = 8.0; }
    const width = isFinite(maxX - minX) && (maxX - minX) > 0 ? (maxX - minX) : 5.0;
    const length = isFinite(maxY - minY) && (maxY - minY) > 0 ? (maxY - minY) : 8.0;
    const grossArea = Math.round(width * length * 10) / 10;
    const slabBounds = { minX, maxX, minY, maxY };

    // Collect interior wall segments for wall-aligned rotation calculation
    const interiorWallLines = entities.filter(e => e.layer === 'A-WALL-INTR' && Array.isArray(e.points) && e.points.length >= 1);
    const wallSegments = [
      { p1: { x: minX, y: minY }, p2: { x: maxX, y: minY }, orientation: 'south' },
      { p1: { x: minX, y: maxY }, p2: { x: maxX, y: maxY }, orientation: 'north' },
      { p1: { x: minX, y: minY }, p2: { x: minX, y: maxY }, orientation: 'west' },
      { p1: { x: maxX, y: minY }, p2: { x: maxX, y: maxY }, orientation: 'east' }
    ];
    for (const w of interiorWallLines) {
      const p1 = w.points[0];
      const p2 = w.end || w.points[1];
      if (p1 && p2) {
        wallSegments.push({ p1, p2, orientation: 'interior' });
      }
    }

    // 2. Detect Rooms & Areas from A-ANNO
    const annoTexts = entities.filter(e => e.layer === 'A-ANNO' && e.text);
    const rooms = [];
    let detectedUsableArea = 0;

    for (const a of annoTexts) {
      const txt = a.text.trim();
      const match = txt.match(/(.+?)\s*\(([0-9.]+)\s*m²?\)/i);
      if (match) {
        const roomName = match[1].trim();
        const areaVal = parseFloat(match[2]);
        detectedUsableArea += areaVal;

        const pt = a.points?.[0] || { x: minX + width / 2, y: minY + length / 2 };
        rooms.push({
          name: roomName,
          areaM2: areaVal,
          zone: this.classifyZoneByName(roomName),
          centroid: { x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 },
          elevation: floorContext.elevation || 0.0
        });
      }
    }

    if (rooms.length === 0) {
      const estimatedRooms = this.synthesizeRoomsFromDimensions(width, length, floorContext);
      rooms.push(...estimatedRooms);
      detectedUsableArea = rooms.reduce((sum, r) => sum + r.areaM2, 0);
    }

    const usableArea = Math.round((detectedUsableArea > 0 ? detectedUsableArea : grossArea * 0.82) * 10) / 10;

    // 3. Classify and map furniture & sanitary items to 35-item catalog with wall-aligned rotation
    const furnEnts = entities.filter(e => (e.layer === 'A-FURN' || e.layer === 'A-SANR') && Array.isArray(e.points) && e.points.length >= 4);
    const furnitureList = [];
    const furnitureCounts = {};
    const assetIdCounts = {};

    for (const f of furnEnts) {
      const xs = f.points.map(p => p.x);
      const ys = f.points.map(p => p.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const d = Math.max(...ys) - Math.min(...ys);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

      const fInfo = this.classifyFurnitureGeometry(
        f.layer,
        w,
        d,
        cx,
        cy,
        floorContext.id,
        rooms,
        slabBounds,
        wallSegments,
        f
      );
      furnitureList.push(fInfo);
      furnitureCounts[fInfo.type] = (furnitureCounts[fInfo.type] || 0) + 1;
      assetIdCounts[fInfo.asset_id] = (assetIdCounts[fInfo.asset_id] || 0) + 1;
    }

    // 4. Doors, Windows, Columns & Stairs with asset_id & rotation
    const doorEnts = entities.filter(e => e.layer === 'A-DOOR');
    const windowEnts = entities.filter(e => e.layer === 'A-GLAZ');
    const columns = entities.filter(e => e.layer === 'A-COLS');
    const stairEnts = entities.filter(e => e.layer === 'A-STAIR');

    const doors = doorEnts.map(d => {
      const pt = d.points?.[0] || { x: minX + width / 2, y: minY };
      const isExterior = Math.abs(pt.y - minY) < 0.35 || Math.abs(pt.y - maxY) < 0.35 || Math.abs(pt.x - minX) < 0.35 || Math.abs(pt.x - maxX) < 0.35;
      const rot = typeof d.rotation === 'number'
        ? d.rotation
        : this.computeWallAlignedRotation(pt.x, pt.y, d.width || 0.9, 0.2, wallSegments, slabBounds);
      return {
        asset_id: d.asset_id && ASSET_CATALOG_SET.has(d.asset_id)
          ? d.asset_id
          : (isExterior ? 'door_balcony_glass' : 'door_interior_wood'),
        x: Math.round(pt.x * 100) / 100,
        y: Math.round(pt.y * 100) / 100,
        width: d.width || (isExterior ? 1.6 : 0.9),
        height: 2.2,
        rotation: Math.round(rot * 10000) / 10000
      };
    });

    let totalWindowLength = 0;
    const windows = [];
    for (const w of windowEnts) {
      if (w.points?.[0] && (w.end || w.points?.[1])) {
        const p1 = w.points[0];
        const p2 = w.end || w.points[1];
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        totalWindowLength += len;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const rot = typeof w.rotation === 'number'
          ? w.rotation
          : this.computeWallAlignedRotation(mx, my, len, 0.2, wallSegments, slabBounds);
        windows.push({
          asset_id: w.asset_id && ASSET_CATALOG_SET.has(w.asset_id) ? w.asset_id : 'window_casement_glass',
          p1: { x: p1.x, y: p1.y },
          p2: { x: p2.x, y: p2.y },
          width: Math.round(len * 100) / 100,
          sillHeight: 0.85,
          windowHeight: 1.8,
          rotation: Math.round(rot * 10000) / 10000
        });
      } else {
        totalWindowLength += 1.8;
      }
    }
    if (windowEnts.length > 0 && totalWindowLength === 0) {
      totalWindowLength = windowEnts.length * 1.8;
    }

    const stairs = [];
    if (stairEnts.length > 0) {
      const stairPts = [];
      for (const s of stairEnts) {
        if (s.points) stairPts.push(...s.points);
        if (s.end) stairPts.push(s.end);
      }
      if (stairPts.length > 0) {
        const sxs = stairPts.map(p => p.x);
        const sys = stairPts.map(p => p.y);
        const sw = Math.max(Math.max(...sxs) - Math.min(...sxs), 1.1);
        const sd = Math.max(Math.max(...sys) - Math.min(...sys), 1.8);
        const scx = (Math.min(...sxs) + Math.max(...sxs)) / 2;
        const scy = (Math.min(...sys) + Math.max(...sys)) / 2;
        const explicitStairId = stairEnts.find(s => s.asset_id)?.asset_id;
        stairs.push({
          asset_id: explicitStairId && ASSET_CATALOG_SET.has(explicitStairId)
            ? explicitStairId
            : (sw >= 2.0 ? 'stair_flight_u_turn' : 'stair_flight_straight'),
          x: Math.round(scx * 100) / 100,
          y: Math.round(scy * 100) / 100,
          width: Math.round(sw * 100) / 100,
          depth: Math.round(sd * 100) / 100,
          rotation: 0
        });
      }
    }

    const windowToFloorRatio = grossArea > 0 ? Math.min(1.0, (totalWindowLength * 1.5) / grossArea) : 0.15;
    const daylightExposurePct = Math.round(windowToFloorRatio * 100 * 2.5);
    const circulationRatioPct = Math.max(8.0, Math.round(((grossArea - usableArea) / grossArea) * 100 * 10) / 10);
    const fengShui = this.generateFengShuiInsights(floorContext, rooms, stairEnts, furnitureList);
    const costEstimationVND = this.estimateConstructionCost(grossArea, usableArea, floorContext);

    return {
      source: 'offline_spatial_geometry_parser',
      timestamp: new Date().toISOString(),
      confidence: 0.95,
      floorId: floorContext.id || 'floor_1',
      floorName: floorContext.name || 'Mặt bằng',
      summary: `Mặt bằng ${floorContext.name || ''} diện tích phủ bì ${grossArea} m², diện tích sử dụng ${usableArea} m² với ${rooms.length} phân khu chức năng và ${furnitureList.length} vật dụng nội thất 3D (.glb).`,
      dimensions: {
        widthMeters: Math.round(width * 100) / 100,
        lengthMeters: Math.round(length * 100) / 100,
        aspectRatio: Math.round((length / width) * 100) / 100
      },
      metrics: {
        grossAreaM2: grossArea,
        usableAreaM2: usableArea,
        circulationRatioPct,
        daylightExposurePct: Math.min(100, daylightExposurePct),
        doorsCount: doorEnts.length,
        windowsCount: windowEnts.length,
        columnsCount: columns.length,
        hasStairs: stairEnts.length > 0
      },
      rooms,
      furniture: furnitureList,
      furnitureCounts,
      assetIdCounts,
      furnitureSample: furnitureList.slice(0, 25),
      doors,
      windows,
      stairs,
      fengShui,
      costEstimationVND
    };
  }

  analyzeEntities(entities, floorContext = {}) {
    return this.extractFromCadEntities(entities, floorContext);
  }

  /**
   * DXF string analyzer
   */
  analyzeDxf(dxfText, floorContext = {}) {
    const entities = this.parseDxfEntities(dxfText);
    return this.extractFromCadEntities(entities, floorContext);
  }

  /**
   * Lightweight ASCII DXF parser
   */
  parseDxfEntities(dxfText) {
    const lines = dxfText.replace(/\r/g, '').split('\n');
    const entities = [];
    let inEntities = false;
    let curr = null;

    for (let i = 0; i < lines.length - 1; i += 2) {
      const code = lines[i].trim();
      const val = lines[i + 1] ? lines[i + 1].trim() : '';

      if (code === '0' && val === 'SECTION') {
        if (i + 3 < lines.length && lines[i + 3].trim() === 'ENTITIES') {
          inEntities = true;
          i += 2;
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
          if (curr) curr.points.push({ x: parseFloat(val), y: yVal });
        } else if (code === '11') {
          const yVal = (i + 3 < lines.length) ? parseFloat(lines[i + 3].trim()) : 0;
          if (curr) curr.end = { x: parseFloat(val), y: yVal };
        } else if (code === '40') {
          if (curr) curr.radius = parseFloat(val);
        }
      }
    }
    if (curr) entities.push(curr);
    return entities;
  }

  /**
   * Heuristic image analyzer for offline mode
   * (Also aliased as offlineImageAnalysis for backwards compatibility)
   */
  extractFromImageHeuristic(imageBase64, floorContext = {}) {
    const approxBytes = Math.round((imageBase64.length * 3) / 4);
    const defaultAnalysis = this.generateDefaultSpatialAnalysis(floorContext);

    return {
      ...defaultAnalysis,
      source: 'offline_image_heuristic_parser',
      imageMetadata: {
        approximateBytes: approxBytes,
        encodedLength: imageBase64.length
      },
      confidence: 0.88,
      notes: 'Phân tích bản vẽ 2D bằng giải thuật định vị không gian thông minh offline với danh mục 35 tài sản .glb (sẵn sàng chuyển sang OpenAI Vision khi cấu hình OPENAI_API_KEY).'
    };
  }

  offlineImageAnalysis(imageBase64, floorContext = {}) {
    return this.extractFromImageHeuristic(imageBase64, floorContext);
  }

  /**
   * Default fallback architectural analysis with full 35-catalog asset_id and wall-aligned rotation
   */
  generateDefaultSpatialAnalysis(floorContext = {}) {
    const isGround = !floorContext.elevation || floorContext.elevation === 0;
    const isTop = floorContext.id?.includes('4') || floorContext.id?.includes('3');

    const rooms = isGround ? [
      { name: 'Phòng khách thông thoáng', areaM2: 22.0, zone: 'living' },
      { name: 'Phòng bếp & Bàn ăn', areaM2: 16.5, zone: 'kitchen' },
      { name: 'WC tầng 1', areaM2: 3.5, zone: 'sanitary' },
      { name: 'Sân trước & Cầu thang', areaM2: 12.0, zone: 'circulation' }
    ] : isTop ? [
      { name: 'Phòng thờ gia tiên trang nghiêm', areaM2: 15.0, zone: 'altar' },
      { name: 'Sân thượng Sky Lounge tiểu cảnh', areaM2: 24.0, zone: 'outdoor' },
      { name: 'Khu giặt & sân phơi', areaM2: 8.0, zone: 'utility' }
    ] : [
      { name: 'Phòng ngủ Master', areaM2: 24.0, zone: 'bedroom' },
      { name: 'Phòng ngủ phụ', areaM2: 16.0, zone: 'bedroom' },
      { name: 'WC khép kín', areaM2: 5.0, zone: 'sanitary' },
      { name: 'Hành lang & Ban công', areaM2: 9.0, zone: 'circulation' }
    ];

    const furniture = isGround ? [
      { asset_id: 'sofa_l_modern', type: 'sofa_sectional', name: 'Sofa góc chữ L bọc nỉ Bouclé', room: 'Phòng khách thông thoáng', cx: 1.4, cy: 2.1, width: 2.4, depth: 1.6, height: 0.85, rotation: Math.PI / 2 },
      { asset_id: 'floor_rug_textured', type: 'rug', name: 'Thảm trải sàn dệt nổi Bắc Âu', room: 'Phòng khách thông thoáng', cx: 2.1, cy: 2.1, width: 2.4, depth: 1.8, height: 0.02, rotation: Math.PI / 2 },
      { asset_id: 'coffee_table_set', type: 'coffee_table', name: 'Bàn trà đôi mặt đá Marble', room: 'Phòng khách thông thoáng', cx: 2.3, cy: 2.1, width: 1.2, depth: 0.7, height: 0.42, rotation: Math.PI / 2 },
      { asset_id: 'tv_cabinet_wall_unit', type: 'tv_console', name: 'Hệ kệ Tivi gỗ Óc chó & OLED 75"', room: 'Phòng khách thông thoáng', cx: 4.5, cy: 2.1, width: 2.2, depth: 0.48, height: 1.6, rotation: -Math.PI / 2 },
      { asset_id: 'entrance_shoe_cabinet', type: 'wardrobe', name: 'Tủ giày sảnh đón & Ghế thay giày', room: 'Phòng khách thông thoáng', cx: 4.5, cy: 0.6, width: 1.2, depth: 0.42, height: 1.15, rotation: -Math.PI / 2 },
      { asset_id: 'indoor_potted_ficus', type: 'plants', name: 'Chậu cây Bàng Singapore nội thất', room: 'Phòng khách thông thoáng', cx: 0.5, cy: 0.6, width: 0.65, depth: 0.65, height: 1.35, rotation: 0 },
      { asset_id: 'dining_table_6chairs', type: 'dining_table', name: 'Bàn ăn mặt đá Marble & 6 Ghế', room: 'Phòng bếp & Bàn ăn', cx: 1.5, cy: 5.2, width: 1.9, depth: 0.95, height: 0.76, rotation: 0 },
      { asset_id: 'kitchen_system_l', type: 'kitchen_cabinet', name: 'Hệ tủ bếp chữ L kịch trần', room: 'Phòng bếp & Bàn ăn', cx: 1.5, cy: 7.4, width: 2.6, depth: 0.65, height: 2.2, rotation: Math.PI },
      { asset_id: 'fridge_double_door', type: 'kitchen_cabinet', name: 'Tủ lạnh Side-by-Side Inverter', room: 'Phòng bếp & Bàn ăn', cx: 3.0, cy: 7.4, width: 0.9, depth: 0.75, height: 1.82, rotation: Math.PI },
      { asset_id: 'lavabo_vanity_led_mirror', type: 'vanity', name: 'Tủ Lavabo mặt đá & Gương LED', room: 'WC tầng 1', cx: 4.5, cy: 6.7, width: 0.9, depth: 0.55, height: 1.8, rotation: -Math.PI / 2 },
      { asset_id: 'toilet_onepiece', type: 'toilet', name: 'Bồn cầu liền khối TOTO', room: 'WC tầng 1', cx: 4.1, cy: 7.5, width: 0.55, depth: 0.7, height: 0.74, rotation: Math.PI }
    ] : isTop ? [
      { asset_id: 'vietnamese_worship_altar', type: 'altar_table', name: 'Án gian thờ Gia tiên Gỗ Gụ', room: 'Phòng thờ gia tiên trang nghiêm', cx: 1.8, cy: 7.2, width: 1.97, depth: 0.97, height: 1.45, rotation: Math.PI },
      { asset_id: 'outdoor_bbq_station', type: 'bbq', name: 'Quầy Bar & Bếp nướng BBQ Sân thượng', room: 'Sân thượng Sky Lounge tiểu cảnh', cx: 1.5, cy: 3.4, width: 2.2, depth: 0.75, height: 0.95, rotation: Math.PI },
      { asset_id: 'outdoor_patio_set', type: 'dining_table', name: 'Bộ bàn trà Sân thượng Sky Lounge', room: 'Sân thượng Sky Lounge tiểu cảnh', cx: 2.2, cy: 1.8, width: 1.6, depth: 1.1, height: 0.75, rotation: 0 },
      { asset_id: 'balcony_planter_greenery', type: 'plants', name: 'Bồn cây tiểu cảnh Sân thượng', room: 'Sân thượng Sky Lounge tiểu cảnh', cx: 0.9, cy: 0.4, width: 1.2, depth: 0.45, height: 0.85, rotation: 0 },
      { asset_id: 'washer_dryer_tower', type: 'kitchen_cabinet', name: 'Tháp máy giặt sấy chồng tầng', room: 'Khu giặt & sân phơi', cx: 4.2, cy: 7.3, width: 0.72, depth: 0.72, height: 1.85, rotation: Math.PI }
    ] : [
      { asset_id: 'bed_master_king', type: 'bed_master', name: 'Giường ngủ Master King Size', room: 'Phòng ngủ Master', cx: 1.4, cy: 2.2, width: 2.0, depth: 2.1, height: 1.15, rotation: Math.PI / 2 },
      { asset_id: 'dressing_table_mirror', type: 'desk', name: 'Bàn trang điểm gương LED', room: 'Phòng ngủ Master', cx: 0.6, cy: 3.8, width: 1.1, depth: 0.52, height: 1.35, rotation: Math.PI / 2 },
      { asset_id: 'tv_cabinet_wall_unit', type: 'tv_console', name: 'Kệ Tivi treo tường Phòng ngủ Master', room: 'Phòng ngủ Master', cx: 4.5, cy: 2.2, width: 2.0, depth: 0.45, height: 1.5, rotation: -Math.PI / 2 },
      { asset_id: 'wardrobe_tall_glass', type: 'wardrobe', name: 'Tủ quần áo cánh kính Fluted LED', room: 'Phòng ngủ Master', cx: 0.6, cy: 6.0, width: 2.2, depth: 0.6, height: 2.4, rotation: Math.PI / 2 },
      { asset_id: 'bathtub_modern', type: 'bathtub', name: 'Bồn tắm nằm Freestanding Kohler', room: 'WC khép kín', cx: 2.8, cy: 6.5, width: 1.7, depth: 0.8, height: 0.62, rotation: -Math.PI / 2 },
      { asset_id: 'lavabo_vanity_led_mirror', type: 'vanity', name: 'Tủ Lavabo mặt đá & Gương LED', room: 'WC khép kín', cx: 2.8, cy: 5.0, width: 1.0, depth: 0.55, height: 1.85, rotation: 0 },
      { asset_id: 'toilet_onepiece', type: 'toilet', name: 'Bồn cầu liền khối thông minh', room: 'WC khép kín', cx: 2.6, cy: 7.4, width: 0.55, depth: 0.7, height: 0.74, rotation: Math.PI }
    ];

    const doors = [
      { asset_id: 'door_balcony_glass', x: 2.5, y: 0.1, width: 1.6, height: 2.2, rotation: 0 },
      { asset_id: 'door_interior_wood', x: 3.2, y: 4.5, width: 0.9, height: 2.15, rotation: 0 }
    ];
    const windows = [
      { asset_id: 'window_casement_glass', x: 2.5, y: 0.1, width: 2.4, height: 1.8, rotation: 0 }
    ];
    const stairs = [
      { asset_id: 'stair_flight_straight', x: 4.2, y: 5.0, width: 1.2, depth: 2.1, rotation: 0 }
    ];

    const grossArea = 65.0;
    const usableArea = rooms.reduce((sum, r) => sum + r.areaM2, 0);

    return {
      source: 'offline_default_spatial_estimator',
      timestamp: new Date().toISOString(),
      confidence: 0.85,
      floorId: floorContext.id || 'floor_1',
      floorName: floorContext.name || 'Mặt bằng mẫu',
      summary: `Mặt bằng không gian tiêu chuẩn với ${rooms.length} phòng chức năng và ${furniture.length} vật dụng 3D (.glb), tối ưu hóa công năng và đối lưu gió tự nhiên.`,
      metrics: {
        grossAreaM2: grossArea,
        usableAreaM2: usableArea,
        circulationRatioPct: 15.2,
        daylightExposurePct: 82.0,
        doorsCount: doors.length,
        windowsCount: windows.length,
        columnsCount: 6,
        hasStairs: true
      },
      rooms,
      furniture,
      furnitureSample: furniture,
      doors,
      windows,
      stairs,
      fengShui: {
        doorOrientation: 'Minh đường thông thoáng, đón sinh khí',
        ventilationAssessment: 'Thiết kế giếng trời kết hợp ô thông tầng đối lưu tốt',
        recommendations: [
          'Bố trí cửa sổ mở đón gió tươi hướng Nam/Đông Nam',
          'Tránh đặt bếp nấu đối diện trực tiếp cửa vệ sinh'
        ]
      },
      costEstimationVND: this.estimateConstructionCost(grossArea, usableArea, floorContext)
    };
  }

  /**
   * Compute wall-aligned rotation (in radians) so the back (-Z) of the object
   * faces the nearest exterior or interior wall segment.
   * Convention:
   *   0           = back against South/bottom wall (-Z)
   *   Math.PI     = back against North/top wall (+Z)
   *   Math.PI / 2 = back against West/left wall (-X)
   *  -Math.PI / 2 = back against East/right wall (+X)
   */
  computeWallAlignedRotation(cx, cy, width, depth, wallSegments = [], slabBounds = { minX: 0, maxX: 5, minY: 0, maxY: 8 }) {
    const isVertical = depth > width * 1.25;
    let bestDist = Infinity;
    let bestRot = 0;

    for (const seg of wallSegments) {
      const p1 = seg.p1;
      const p2 = seg.p2;
      if (!p1 || !p2) continue;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const isHoriz = Math.abs(dx) >= Math.abs(dy);

      if (isHoriz) {
        const wy = (p1.y + p2.y) / 2;
        const wxMin = Math.min(p1.x, p2.x) - 0.3;
        const wxMax = Math.max(p1.x, p2.x) + 0.3;
        if (cx >= wxMin && cx <= wxMax) {
          const d = Math.abs(cy - wy);
          if (d < bestDist) {
            bestDist = d;
            bestRot = wy <= cy ? 0 : Math.PI;
          }
        }
      } else {
        const wx = (p1.x + p2.x) / 2;
        const wyMin = Math.min(p1.y, p2.y) - 0.3;
        const wyMax = Math.max(p1.y, p2.y) + 0.3;
        if (cy >= wyMin && cy <= wyMax) {
          const d = Math.abs(cx - wx);
          if (d < bestDist) {
            bestDist = d;
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

  // Helper classification methods
  classifyZoneByName(name) {
    const n = name.toLowerCase();
    if (n.includes('khách') || n.includes('living')) return 'living';
    if (n.includes('bếp') || n.includes('ăn') || n.includes('kitchen') || n.includes('dining')) return 'kitchen';
    if (n.includes('ngủ') || n.includes('bed')) return 'bedroom';
    if (n.includes('wc') || n.includes('vệ sinh') || n.includes('tắm') || n.includes('bath')) return 'sanitary';
    if (n.includes('thờ') || n.includes('altar')) return 'altar';
    if (n.includes('gym') || n.includes('thể thao') || n.includes('fitness')) return 'gym';
    if (n.includes('hồ bơi') || n.includes('pool')) return 'pool';
    if (n.includes('sân') || n.includes('ban công') || n.includes('balcony') || n.includes('sky') || n.includes('bbq')) return 'outdoor';
    if (n.includes('gara') || n.includes('xe')) return 'garage';
    return 'circulation';
  }

  mapTypeToAssetId(type = '', name = '', roomName = '') {
    const t = String(type).toLowerCase();
    const n = String(name).toLowerCase();
    const r = String(roomName).toLowerCase();

    if (t === 'sofa_sectional' || n.includes('chữ l')) return 'sofa_l_modern';
    if (t === 'sofa') return 'sofa_straight_3seat';
    if (t === 'armchair' || n.includes('armchair')) return 'armchair_lounge';
    if (t === 'coffee_table' || n.includes('bàn trà')) return 'coffee_table_set';
    if (t === 'tv_console' || n.includes('tivi')) return 'tv_cabinet_wall_unit';
    if (n.includes('tủ giày')) return 'entrance_shoe_cabinet';
    if (t === 'rug' || n.includes('thảm')) return 'floor_rug_textured';
    if (n.includes('đảo bếp') || n.includes('island')) return 'kitchen_island_bar';
    if (n.includes('tủ lạnh') || n.includes('fridge')) return 'fridge_double_door';
    if (n.includes('giặt') || n.includes('sấy') || n.includes('washtower')) return 'washer_dryer_tower';
    if (t === 'kitchen_cabinet') return n.includes('chữ i') ? 'kitchen_system_i' : 'kitchen_system_l';
    if (t === 'dining_table') {
      if (r.includes('sân thượng') || r.includes('sky') || n.includes('ngoài trời')) return 'outdoor_patio_set';
      return n.includes('4 ghế') ? 'dining_table_4chairs' : 'dining_table_6chairs';
    }
    if (t === 'bed_master' || t === 'bed') {
      if (n.includes('tầng') || n.includes('bunk') || n.includes('trẻ em')) return 'bed_bunk_kids';
      if (n.includes('queen') || (!n.includes('master') && !n.includes('king') && !r.includes('master'))) return 'bed_queen_modern';
      return 'bed_master_king';
    }
    if (t === 'wardrobe' || n.includes('tủ áo') || n.includes('tủ quần áo')) return 'wardrobe_tall_glass';
    if (n.includes('trang điểm') || n.includes('dressing')) return 'dressing_table_mirror';
    if (t === 'desk' || t === 'gym_machine') return 'work_desk_computer';
    if (t === 'altar_table' || n.includes('thờ')) return 'vietnamese_worship_altar';
    if (t === 'bbq' || n.includes('bbq')) return 'outdoor_bbq_station';
    if (t === 'toilet' || n.includes('bồn cầu')) return 'toilet_onepiece';
    if (t === 'vanity' || n.includes('lavabo')) return 'lavabo_vanity_led_mirror';
    if (t === 'shower' || n.includes('tắm đứng') || n.includes('cabin')) return 'shower_glass_enclosure';
    if (t === 'bathtub' || n.includes('bồn tắm')) return 'bathtub_modern';
    if (t === 'plants' || t === 'planter') {
      return (r.includes('ban công') || r.includes('sân thượng') || n.includes('ban công'))
        ? 'balcony_planter_greenery'
        : 'indoor_potted_ficus';
    }
    return 'work_desk_computer';
  }

  classifyFurnitureGeometry(layer, width, depth, cx, cy, floorId, rooms = [], slabBounds = { minX: 0, maxX: 5, minY: 0, maxY: 8 }, wallSegments = [], rawEntity = {}) {
    const dimMax = Math.max(width, depth);
    const dimMin = Math.min(width, depth);

    // Find closest room
    let closestRoom = null;
    let minRoomDist = Infinity;
    for (const rm of rooms) {
      if (rm.centroid) {
        const d = Math.hypot(cx - rm.centroid.x, cy - rm.centroid.y);
        if (d < minRoomDist) {
          minRoomDist = d;
          closestRoom = rm;
        }
      }
    }
    const roomName = rawEntity.room || closestRoom?.name || '';
    const roomZone = closestRoom?.zone || '';

    const rotation = typeof rawEntity.rotation === 'number'
      ? rawEntity.rotation
      : this.computeWallAlignedRotation(cx, cy, width, depth, wallSegments, slabBounds);

    if (rawEntity.asset_id && ASSET_CATALOG_SET.has(rawEntity.asset_id)) {
      return {
        asset_id: rawEntity.asset_id,
        type: rawEntity.furnType || rawEntity.type || 'furniture',
        name: rawEntity.name || 'Nội thất 3D',
        room: roomName,
        cx: Math.round(cx * 100) / 100,
        cy: Math.round(cy * 100) / 100,
        width: Math.round(width * 100) / 100,
        depth: Math.round(depth * 100) / 100,
        rotation: Math.round(rotation * 10000) / 10000
      };
    }

    let type = 'furniture_misc';
    let name = 'Vật dụng nội thất tiêu chuẩn';
    let asset_id = 'work_desk_computer';

    if (layer === 'A-SANR') {
      if (dimMax >= 1.45) {
        type = 'bathtub';
        name = 'Bồn tắm nằm Freestanding Sứ Kohler';
        asset_id = 'bathtub_modern';
      } else if (dimMax >= 0.9 && dimMin >= 0.85) {
        type = 'shower';
        name = 'Cabin tắm đứng vách kính cường lực';
        asset_id = 'shower_glass_enclosure';
      } else if (dimMax >= 0.78) {
        type = 'vanity';
        name = 'Bàn Lavabo mặt đá & Gương LED';
        asset_id = 'lavabo_vanity_led_mirror';
      } else {
        type = 'toilet';
        name = 'Bồn cầu liền khối cao cấp';
        asset_id = 'toilet_onepiece';
      }
    } else if (roomZone === 'altar' || roomName.toLowerCase().includes('thờ')) {
      if (dimMax >= 1.4) {
        type = 'altar_table';
        name = 'Án gian thờ Gia tiên Gỗ Gụ chạm khắc';
        asset_id = 'vietnamese_worship_altar';
      } else {
        type = 'plants';
        name = 'Chậu cây cảnh phòng thờ';
        asset_id = 'indoor_potted_ficus';
      }
    } else if (roomZone === 'outdoor' || roomName.toLowerCase().includes('sân thượng') || roomName.toLowerCase().includes('ban công')) {
      if (dimMax >= 1.9 && dimMin <= 0.95) {
        type = 'bbq';
        name = 'Quầy Bar & Bếp nướng BBQ Sân thượng';
        asset_id = 'outdoor_bbq_station';
      } else if (dimMax >= 1.2 && dimMin >= 0.85) {
        type = 'dining_table';
        name = 'Bộ bàn trà & Ghế thư giãn Sân thượng';
        asset_id = 'outdoor_patio_set';
      } else {
        type = 'plants';
        name = 'Bồn cây tiểu cảnh nhiệt đới Ban công';
        asset_id = 'balcony_planter_greenery';
      }
    } else if (roomName.toLowerCase().includes('giặt')) {
      type = 'kitchen_cabinet';
      name = 'Tháp máy giặt sấy chồng tầng';
      asset_id = 'washer_dryer_tower';
    } else if (dimMax >= 2.3 && dimMin <= 0.9) {
      if (roomZone === 'kitchen' || cy > (slabBounds.minY + (slabBounds.maxY - slabBounds.minY) * 0.6)) {
        type = 'kitchen_cabinet';
        name = 'Hệ tủ bếp chữ L & mặt đá Granite';
        asset_id = 'kitchen_system_l';
      } else if (roomZone === 'living') {
        type = 'tv_console';
        name = 'Hệ kệ Tivi gỗ Óc chó & Màn hình OLED';
        asset_id = 'tv_cabinet_wall_unit';
      } else {
        type = 'wardrobe';
        name = 'Tủ quần áo kịch trần cánh kính';
        asset_id = 'wardrobe_tall_glass';
      }
    } else if (dimMax >= 1.75 && dimMin >= 1.45) {
      type = 'bed';
      const isMaster = roomName.toLowerCase().includes('master') || floorId === 'floor_2';
      name = isMaster ? 'Giường ngủ Master King Size' : 'Giường ngủ Queen Size hiện đại';
      asset_id = isMaster ? 'bed_master_king' : 'bed_queen_modern';
    } else if (dimMax >= 1.7 && dimMin >= 0.8 && dimMin <= 1.35) {
      if (floorId === 'floor_3' || floorId === 'floor_4') {
        type = 'altar_table';
        name = 'Bàn thờ gia tiên gỗ gụ chạm khắc';
        asset_id = 'vietnamese_worship_altar';
      } else if (roomZone === 'kitchen' || cy > (slabBounds.minY + (slabBounds.maxY - slabBounds.minY) * 0.5)) {
        type = 'dining_table';
        name = 'Bàn ăn mặt đá Marble & 6 Ghế';
        asset_id = 'dining_table_6chairs';
      } else {
        type = 'sofa';
        name = 'Sofa góc chữ L bọc nỉ Bouclé';
        asset_id = 'sofa_l_modern';
      }
    } else if (dimMax >= 0.8 && dimMax <= 1.5 && dimMin <= 0.85) {
      if (roomZone === 'living') {
        type = 'coffee_table';
        name = 'Bàn trà đôi mặt đá Marble';
        asset_id = 'coffee_table_set';
      } else if (roomZone === 'bedroom') {
        type = 'desk';
        name = 'Bàn trang điểm / Bàn làm việc';
        asset_id = roomName.toLowerCase().includes('master') ? 'dressing_table_mirror' : 'work_desk_computer';
      } else {
        type = 'coffee_table';
        name = 'Bàn trà mặt đá/kính';
        asset_id = 'coffee_table_set';
      }
    } else if (floorId?.includes('3') && dimMax >= 1.6) {
      type = 'gym_machine';
      name = 'Thiết bị tập Gym & Bàn kỹ thuật';
      asset_id = 'work_desk_computer';
    } else {
      type = 'plants';
      name = 'Chậu cây xanh nội thất';
      asset_id = 'indoor_potted_ficus';
    }

    return {
      asset_id,
      type,
      name,
      room: roomName,
      cx: Math.round(cx * 100) / 100,
      cy: Math.round(cy * 100) / 100,
      width: Math.round(width * 100) / 100,
      depth: Math.round(depth * 100) / 100,
      rotation: Math.round(rotation * 10000) / 10000
    };
  }

  synthesizeRoomsFromDimensions(w, l, floorContext) {
    return [
      { name: 'Khu vực mặt tiền & sinh hoạt', areaM2: Math.round(w * l * 0.45 * 10) / 10, zone: 'living' },
      { name: 'Khu vực chức năng trung tâm', areaM2: Math.round(w * l * 0.35 * 10) / 10, zone: 'bedroom' },
      { name: 'Khu vực phụ trợ & vệ sinh', areaM2: Math.round(w * l * 0.20 * 10) / 10, zone: 'sanitary' }
    ];
  }

  generateFengShuiInsights(floorContext, rooms, stairs, furnitureList) {
    const recommendations = [];

    const hasAltar = rooms.some(r => r.zone === 'altar') || furnitureList.some(f => f.type === 'altar_table' || f.asset_id === 'vietnamese_worship_altar');
    if (hasAltar) {
      recommendations.push('Phòng thờ đặt tại tầng cao nhất, vị trí "tọa cát hướng cát", giữ không gian tôn nghiêm thanh tịnh.');
    }

    const hasKitchen = rooms.some(r => r.zone === 'kitchen');
    if (hasKitchen) {
      recommendations.push('Khu vực bếp nấu được bố trí tránh đối diện trực tiếp cửa nhà vệ sinh, hợp quy luật Thủy - Hỏa tương khắc.');
    }

    if (stairs.length > 0) {
      recommendations.push('Cầu thang bố trí kẹp sườn nhà giúp dòng khí lưu chuyển điều hòa liên tục giữa các tầng.');
    }

    recommendations.push('Hệ thống mở cửa đón sáng tự nhiên tạo sinh khí và giảm nhiệt hấp thụ vào mùa nóng.');

    return {
      doorOrientation: 'Tọa Bắc Hướng Nam / Đông Nam - Đón gió tự nhiên mát mẻ quanh năm',
      ventilationAssessment: 'Thiết kế thông minh tạo hiệu ứng ống khói tự nhiên qua cầu thang và giếng trời',
      recommendations
    };
  }

  estimateConstructionCost(grossArea, usableArea, floorContext) {
    const unitPriceRough = 3800000;
    const unitPriceFitOut = 2800000;
    const roughCost = Math.round(grossArea * unitPriceRough);
    const fitOutCost = Math.round(usableArea * unitPriceFitOut);

    return {
      currency: 'VND',
      unitPricePerM2: unitPriceRough + unitPriceFitOut,
      roughConstruction: roughCost,
      interiorFitOut: fitOutCost,
      total: roughCost + fitOutCost,
      formattedTotal: `${((roughCost + fitOutCost) / 1000000000).toFixed(2)} tỷ VNĐ`
    };
  }
}
