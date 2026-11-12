/**
 * models.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 * Schemas & Document models for Architectural Projects & Floors.
 */

export class FloorDocument {
  /**
   * @param {Object} data
   * @param {string} data.id - Unique floor identifier (e.g. 'floor_1')
   * @param {string} data.name - Display name (e.g. 'Tầng 1')
   * @param {string} [data.desc] - Functional description (e.g. 'Phòng khách, Bếp ăn, WC')
   * @param {number} [data.elevation=0.0] - Height level relative to ground (meters)
   * @param {number} [data.height=3.6] - Floor-to-ceiling story height (meters)
   * @param {Array<Object>} [data.entities=[]] - CAD / BIM drawing entities
   * @param {Object|null} [data.aiAnalysis=null] - AI Vision / Spatial Geometry extraction results
   * @param {Object} [data.metadata={}] - Additional floor metadata
   */
  constructor(data = {}) {
    this.id = String(data.id || `floor_${Date.now()}`);
    this.name = String(data.name || 'Tầng');
    this.desc = String(data.desc || '');
    this.elevation = typeof data.elevation === 'number' ? data.elevation : 0.0;
    this.height = typeof data.height === 'number' && data.height > 0 ? data.height : 3.6;
    this.entities = Array.isArray(data.entities) ? data.entities : [];
    this.rooms = Array.isArray(data.rooms) ? data.rooms : (data.aiAnalysis?.rooms || []);
    this.furniture = Array.isArray(data.furniture) ? data.furniture : [];
    this.slabs = Array.isArray(data.slabs) ? data.slabs : [];
    this.exteriorWalls = Array.isArray(data.exteriorWalls) ? data.exteriorWalls : [];
    this.interiorWalls = Array.isArray(data.interiorWalls) ? data.interiorWalls : [];
    this.aiAnalysis = data.aiAnalysis || null;
    this.metadata = data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {};
  }

  /**
   * Validate floor document properties
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate() {
    const errors = [];
    if (!this.id || typeof this.id !== 'string') errors.push('Floor "id" must be a non-empty string.');
    if (!this.name || typeof this.name !== 'string') errors.push('Floor "name" must be a non-empty string.');
    if (typeof this.elevation !== 'number' || isNaN(this.elevation)) errors.push('Floor "elevation" must be a valid number.');
    if (typeof this.height !== 'number' || isNaN(this.height) || this.height <= 0) errors.push('Floor "height" must be a positive number.');
    if (!Array.isArray(this.entities)) errors.push('Floor "entities" must be an array.');
    return { valid: errors.length === 0, errors };
  }

  /**
   * Summary object without massive entity arrays (for listing APIs)
   */
  toSummary() {
    return {
      id: this.id,
      name: this.name,
      desc: this.desc,
      elevation: this.elevation,
      height: this.height,
      entitiesCount: this.entities.length,
      hasAiAnalysis: Boolean(this.aiAnalysis),
      aiSummary: this.aiAnalysis ? {
        roomsCount: this.aiAnalysis.rooms?.length || 0,
        usableArea: this.aiAnalysis.metrics?.usableArea || null,
        confidence: this.aiAnalysis.confidence || null
      } : null
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      desc: this.desc,
      elevation: this.elevation,
      height: this.height,
      entities: this.entities,
      rooms: this.rooms,
      furniture: this.furniture,
      slabs: this.slabs,
      exteriorWalls: this.exteriorWalls,
      interiorWalls: this.interiorWalls,
      aiAnalysis: this.aiAnalysis,
      metadata: this.metadata
    };
  }

  static fromJSON(data) {
    if (!data) return null;
    return new FloorDocument(data);
  }
}

export class ProjectDocument {
  /**
   * @param {Object} data
   * @param {string} data.id - Unique project slug or UUID
   * @param {string} data.title - Project title (e.g. 'Nhà phố 4 Tầng Hiện Đại')
   * @param {string} [data.code] - Project code (e.g. 'NN-2026-NP04')
   * @param {string} [data.subtitle] - Subtitle / Phase (e.g. 'HỒ SƠ THIẾT KẾ THI CÔNG')
   * @param {number} [data.lot_width=0.0] - Land lot width in meters
   * @param {number} [data.lot_length=0.0] - Land lot length in meters
   * @param {number} [data.lot_area=0.0] - Land lot area in m²
   * @param {number} [data.total_floor_area=0.0] - Total building gross floor area in m²
   * @param {Array<FloorDocument|Object>} [data.floors=[]] - Floors in the project
   * @param {Object} [data.metadata={}] - Project creation and version metadata
   */
  constructor(data = {}) {
    this.id = String(data.id || `project_${Date.now()}`);
    this.title = String(data.title || 'Dự án kiến trúc mới');
    this.code = String(data.code || `NN-${new Date().getFullYear()}`);
    this.subtitle = String(data.subtitle || 'HỒ SƠ THIẾT KẾ THI CÔNG');
    this.style = String(data.style || 'modern');
    this.lot_width = typeof data.lot_width === 'number' ? data.lot_width : 0.0;
    this.lot_length = typeof data.lot_length === 'number' ? data.lot_length : 0.0;
    this.lot_area = typeof data.lot_area === 'number' && data.lot_area > 0
      ? data.lot_area
      : (this.lot_width * this.lot_length);
    this.total_floor_area = typeof data.total_floor_area === 'number' ? data.total_floor_area : 0.0;
    
    this.floors = (Array.isArray(data.floors) ? data.floors : []).map(f => 
      f instanceof FloorDocument ? f : new FloorDocument(f)
    );

    this.metadata = {
      createdAt: data.metadata?.createdAt || new Date().toISOString(),
      updatedAt: data.metadata?.updatedAt || new Date().toISOString(),
      author: data.metadata?.author || 'Nếp Nhà Architecture & OpenCADStudio',
      tags: Array.isArray(data.metadata?.tags) ? data.metadata.tags : ['BIM', 'Architectural'],
      ...(data.metadata || {})
    };

    if (this.total_floor_area === 0 && this.floors.length > 0) {
      this.total_floor_area = this.calculateTotalArea();
    }
  }

  /**
   * Approximate total floor area from floor entities or metadata
   */
  calculateTotalArea() {
    let sum = 0;
    for (const floor of this.floors) {
      const extr = floor.entities.find(e => e.layer === 'A-WALL-EXTR' && Array.isArray(e.points) && e.points.length >= 4);
      if (extr) {
        const xs = extr.points.map(p => p.x);
        const ys = extr.points.map(p => p.y);
        const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
        sum += area;
      } else if (this.lot_width > 0 && this.lot_length > 0) {
        sum += (this.lot_width * this.lot_length * 0.85); // typical coverage
      }
    }
    return Math.round(sum * 10) / 10;
  }

  /**
   * Add or replace floor
   * @param {FloorDocument|Object} floorData
   */
  addFloor(floorData) {
    const floor = floorData instanceof FloorDocument ? floorData : new FloorDocument(floorData);
    const existingIndex = this.floors.findIndex(f => f.id === floor.id);
    if (existingIndex >= 0) {
      this.floors[existingIndex] = floor;
    } else {
      this.floors.push(floor);
    }
    this.metadata.updatedAt = new Date().toISOString();
    return floor;
  }

  /**
   * Get floor by ID
   * @param {string} floorId
   * @returns {FloorDocument|null}
   */
  getFloor(floorId) {
    return this.floors.find(f => f.id === floorId) || null;
  }

  /**
   * Attach or update AI analysis to a specific floor
   */
  updateFloorAnalysis(floorId, analysis) {
    const floor = this.getFloor(floorId);
    if (!floor) return null;
    floor.aiAnalysis = analysis;
    this.metadata.updatedAt = new Date().toISOString();
    return floor;
  }

  /**
   * Validate complete project document
   */
  validate() {
    const errors = [];
    if (!this.id || typeof this.id !== 'string') errors.push('Project "id" must be a non-empty string.');
    if (!this.title || typeof this.title !== 'string') errors.push('Project "title" must be a non-empty string.');
    if (typeof this.lot_width !== 'number' || this.lot_width < 0) errors.push('Project "lot_width" must be non-negative.');
    if (typeof this.lot_length !== 'number' || this.lot_length < 0) errors.push('Project "lot_length" must be non-negative.');
    
    for (const [idx, floor] of this.floors.entries()) {
      const flValidation = floor.validate();
      if (!flValidation.valid) {
        errors.push(`Floor[${idx}] "${floor.name}" invalid: ${flValidation.errors.join(', ')}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Summary object for project index lists
   */
  toSummary() {
    return {
      id: this.id,
      title: this.title,
      code: this.code,
      subtitle: this.subtitle,
      style: this.style,
      lot_width: this.lot_width,
      lot_length: this.lot_length,
      lot_area: this.lot_area,
      total_floor_area: this.total_floor_area,
      floorsCount: this.floors.length,
      floors: this.floors.map(f => f.toSummary()),
      metadata: this.metadata
    };
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      code: this.code,
      subtitle: this.subtitle,
      style: this.style,
      lot_width: this.lot_width,
      lot_length: this.lot_length,
      lot_area: this.lot_area,
      total_floor_area: this.total_floor_area,
      floors: this.floors.map(f => f.toJSON()),
      metadata: this.metadata
    };
  }

  static fromJSON(data) {
    if (!data) return null;
    return new ProjectDocument(data);
  }
}

/**
 * ChatMessage model for interactive architectural AI agent conversation
 */
export class ChatMessage {
  /**
   * @param {Object} data
   * @param {string} [data.id]
   * @param {string} data.project_id
   * @param {string} [data.sender='user'] - 'user' | 'assistant' | 'system'
   * @param {string} [data.text='']
   * @param {Array|string} [data.attachments=[]]
   * @param {Object|string} [data.stage_info=null]
   * @param {string} [data.created_at]
   */
  constructor(data = {}) {
    this.id = String(data.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    this.project_id = String(data.project_id || data.projectId || '');
    this.sender = String(data.sender || 'user');
    this.text = String(data.text || '');

    if (Array.isArray(data.attachments)) {
      this.attachments = data.attachments;
    } else if (typeof data.attachments === 'string') {
      try {
        this.attachments = JSON.parse(data.attachments);
      } catch {
        this.attachments = [];
      }
    } else {
      this.attachments = [];
    }

    const stageVal = data.stage_info !== undefined ? data.stage_info : data.stageInfo;
    if (stageVal && typeof stageVal === 'object') {
      this.stage_info = stageVal;
    } else if (typeof stageVal === 'string') {
      try {
        this.stage_info = JSON.parse(stageVal);
      } catch {
        this.stage_info = null;
      }
    } else {
      this.stage_info = null;
    }

    this.created_at = String(data.created_at || data.createdAt || new Date().toISOString());
  }

  toJSON() {
    return {
      id: this.id,
      project_id: this.project_id,
      sender: this.sender,
      text: this.text,
      attachments: this.attachments,
      stage_info: this.stage_info,
      created_at: this.created_at
    };
  }

  static fromJSON(data) {
    if (!data) return null;
    return new ChatMessage(data);
  }
}

/**
 * FurnitureAsset model for plug-and-play modular furniture catalog & custom assets
 */
export class FurnitureAsset {
  /**
   * @param {Object} data
   * @param {string} [data.id]
   * @param {string} data.asset_id
   * @param {string} data.name
   * @param {string} [data.category='living_room']
   * @param {Array<string>|string} [data.room_types=[]]
   * @param {string} [data.placement_type='floor_wall_backed']
   * @param {Object|string} [data.dimensions={}]
   * @param {Array<string>|string} [data.tags=[]]
   * @param {string} [data.glb_path='']
   * @param {number|boolean} [data.is_builtin=1]
   * @param {string} [data.created_at]
   */
  constructor(data = {}) {
    const rawId = data.id || data.asset_id || `asset_${Date.now()}`;
    this.id = String(rawId);
    this.asset_id = String(data.asset_id || data.id || `asset_${Date.now()}`);
    this.name = String(data.name || 'Nội thất mẫu');
    this.category = String(data.category || 'living_room');

    if (Array.isArray(data.room_types)) {
      this.room_types = data.room_types;
    } else if (typeof data.room_types === 'string') {
      try {
        this.room_types = JSON.parse(data.room_types);
      } catch {
        this.room_types = data.room_types.split(',').map(s => s.trim()).filter(Boolean);
      }
    } else {
      this.room_types = [];
    }

    this.placement_type = String(data.placement_type || 'floor_wall_backed');

    if (data.dimensions && typeof data.dimensions === 'object') {
      this.dimensions = { ...data.dimensions };
    } else if (typeof data.dimensions === 'string') {
      try {
        this.dimensions = JSON.parse(data.dimensions);
      } catch {
        this.dimensions = { width: 1.0, depth: 1.0, height: 1.0 };
      }
    } else {
      this.dimensions = { width: 1.0, depth: 1.0, height: 1.0 };
    }

    if (Array.isArray(data.tags)) {
      this.tags = data.tags;
    } else if (typeof data.tags === 'string') {
      try {
        this.tags = JSON.parse(data.tags);
      } catch {
        this.tags = data.tags.split(',').map(s => s.trim()).filter(Boolean);
      }
    } else {
      this.tags = [];
    }

    this.glb_path = String(data.glb_path || data.url || `/assets/models/${this.asset_id}.glb`);
    this.is_builtin = (data.is_builtin === 0 || data.is_builtin === false) ? 0 : 1;
    this.created_at = String(data.created_at || data.createdAt || new Date().toISOString());
  }

  toJSON() {
    return {
      id: this.id,
      asset_id: this.asset_id,
      name: this.name,
      category: this.category,
      room_types: this.room_types,
      placement_type: this.placement_type,
      dimensions: this.dimensions,
      tags: this.tags,
      glb_path: this.glb_path,
      is_builtin: this.is_builtin,
      created_at: this.created_at
    };
  }

  static fromJSON(data) {
    if (!data) return null;
    return new FurnitureAsset(data);
  }
}

/**
 * AiConfig model for AI Provider Hub configuration (OpenAI, Ollama, OpenRouter, Antigravity)
 */
export class AiConfig {
  /**
   * @param {Object} data
   * @param {string} [data.id='default']
   * @param {string} [data.provider='antigravity']
   * @param {string} [data.base_url='https://api.openai.com/v1']
   * @param {string} [data.api_key='']
   * @param {string} [data.primary_model='gemini-2.5-flash']
   * @param {string} [data.vision_model='gemini-2.5-flash']
   * @param {string} [data.updated_at]
   */
  constructor(data = {}) {
    this.id = String(data.id || 'default');
    this.provider = String(data.provider || 'antigravity');
    this.base_url = String(data.base_url || data.baseUrl || 'https://api.openai.com/v1');
    this.api_key = String(data.api_key || data.apiKey || '');
    this.primary_model = String(data.primary_model || data.primaryModel || 'gemini-2.5-flash');
    this.vision_model = String(data.vision_model || data.visionModel || 'gemini-2.5-flash');
    this.updated_at = String(data.updated_at || data.updatedAt || new Date().toISOString());
  }

  toJSON() {
    return {
      id: this.id,
      provider: this.provider,
      base_url: this.base_url,
      api_key: this.api_key,
      primary_model: this.primary_model,
      vision_model: this.vision_model,
      updated_at: this.updated_at
    };
  }

  static fromJSON(data) {
    if (!data) return null;
    return new AiConfig(data);
  }
}
