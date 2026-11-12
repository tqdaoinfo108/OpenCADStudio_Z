/**
 * sqlite_repo.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 * SQLite implementation of ProjectRepository using Node.js 24 built-in `node:sqlite` (DatabaseSync).
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRepository } from './repository.js';
import { ProjectDocument, ChatMessage, FurnitureAsset, AiConfig } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SqliteProjectRepository extends ProjectRepository {
  /**
   * @param {Object} [options]
   * @param {string} [options.dbPath] - SQLite database file path
   */
  constructor(options = {}) {
    super();
    // Default location: web-viewer/data/nepnha_projects.sqlite
    const defaultDataDir = path.resolve(__dirname, '..', 'data');
    const defaultDbPath = path.join(defaultDataDir, 'nepnha_projects.sqlite');
    
    this.dbPath = options.dbPath || process.env.SQLITE_DB_PATH || defaultDbPath;
    this.db = null;
  }

  /**
   * Initialize database and tables
   */
  async init() {
    if (this.db) return;

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this.createTables();
  }

  /**
   * Create schema
   */
  createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        code TEXT,
        subtitle TEXT,
        lot_width REAL DEFAULT 0.0,
        lot_length REAL DEFAULT 0.0,
        lot_area REAL DEFAULT 0.0,
        total_floor_area REAL DEFAULT 0.0,
        floors_count INTEGER DEFAULT 0,
        data TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_projects_code ON projects(code);
      CREATE INDEX IF NOT EXISTS idx_projects_title ON projects(title);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments TEXT,
        stage_info TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_project_id ON chat_messages(project_id);

      CREATE TABLE IF NOT EXISTS furniture_assets (
        id TEXT PRIMARY KEY,
        asset_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        room_types TEXT,
        placement_type TEXT,
        dimensions TEXT,
        tags TEXT,
        glb_path TEXT,
        is_builtin INTEGER DEFAULT 1,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_furniture_category ON furniture_assets(category);
      CREATE INDEX IF NOT EXISTS idx_furniture_asset_id ON furniture_assets(asset_id);

      CREATE TABLE IF NOT EXISTS ai_config (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        base_url TEXT,
        api_key TEXT,
        primary_model TEXT,
        vision_model TEXT,
        updated_at TEXT
      );
    `);

    this.seedFurnitureCatalog();
  }

  /**
   * Seed furniture_assets table with standard catalog items from asset_catalog.json
   */
  seedFurnitureCatalog() {
    try {
      const countStmt = this.db.prepare('SELECT count(*) as count FROM furniture_assets');
      const countRow = countStmt.get();
      if (Number(countRow.count) > 0) {
        return;
      }

      // Locate asset_catalog.json in public or dist
      const publicCatalog = path.resolve(__dirname, '..', 'public', 'assets', 'models', 'asset_catalog.json');
      const distCatalog = path.resolve(__dirname, '..', 'dist', 'assets', 'models', 'asset_catalog.json');
      const catalogPath = fs.existsSync(publicCatalog) ? publicCatalog : (fs.existsSync(distCatalog) ? distCatalog : null);

      if (!catalogPath) {
        console.warn('[SqliteProjectRepository] asset_catalog.json not found to seed furniture_assets');
        return;
      }

      const catalogData = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      const assets = catalogData.assets || [];

      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO furniture_assets (
          id, asset_id, name, category, room_types, placement_type, dimensions, tags, glb_path, is_builtin, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of assets) {
        const assetId = item.asset_id || item.id;
        const name = item.name || assetId;
        const category = item.category || 'living_room';

        let roomTypes = [category];
        if (category === 'living_room') roomTypes = ['living_room', 'common'];
        else if (category === 'kitchen_dining') roomTypes = ['kitchen', 'dining'];
        else if (category === 'bedroom') roomTypes = ['bedroom', 'master_bedroom', 'kids_bedroom'];
        else if (category === 'worship_rooftop') roomTypes = ['altar', 'terrace', 'balcony', 'rooftop'];
        else if (category === 'bathroom_laundry') roomTypes = ['bathroom', 'wc', 'laundry'];
        else if (category === 'greenery_architectural') roomTypes = ['living_room', 'balcony', 'corridor', 'terrace'];

        let placementType = 'floor_free';
        const idLower = assetId.toLowerCase();
        if (
          idLower.includes('sofa') || idLower.includes('tv_cabinet') || idLower.includes('shoe_cabinet') ||
          idLower.includes('bed') || idLower.includes('wardrobe') || idLower.includes('desk') ||
          idLower.includes('dressing') || idLower.includes('kitchen_system') || idLower.includes('fridge') ||
          idLower.includes('altar') || idLower.includes('toilet') || idLower.includes('lavabo') ||
          idLower.includes('bathtub') || idLower.includes('washer')
        ) {
          placementType = 'floor_wall_backed';
        } else if (idLower.includes('door') || idLower.includes('window')) {
          placementType = 'opening';
        } else if (idLower.includes('stair') || idLower.includes('railing')) {
          placementType = 'structural';
        }

        const tags = [category, ...(item.legacyTypes || [])];
        const glbPath = item.url || `/assets/models/${item.file || `${assetId}.glb`}`;

        insertStmt.run(
          item.id || assetId,
          assetId,
          name,
          category,
          JSON.stringify(roomTypes),
          placementType,
          JSON.stringify(item.dimensions || { width: 1.0, depth: 1.0, height: 1.0 }),
          JSON.stringify(tags),
          glbPath,
          1,
          new Date().toISOString()
        );
      }
    } catch (err) {
      console.error('[SqliteProjectRepository] Error seeding furniture catalog:', err);
    }
  }

  /**
   * Find all projects
   * @param {Object} [options]
   * @param {boolean} [options.summaryOnly=false]
   */
  async findAll(options = {}) {
    await this.init();
    const summaryOnly = options.summaryOnly !== false;

    const stmt = this.db.prepare('SELECT id, title, code, subtitle, lot_width, lot_length, lot_area, total_floor_area, floors_count, data, created_at, updated_at FROM projects ORDER BY created_at DESC');
    const rows = stmt.all();

    return rows.map(row => {
      try {
        const fullDoc = JSON.parse(row.data);
        const project = ProjectDocument.fromJSON(fullDoc);
        return summaryOnly ? project.toSummary() : project;
      } catch (err) {
        console.error(`Failed to parse project JSON for ${row.id}:`, err);
        return {
          id: row.id,
          title: row.title,
          code: row.code,
          subtitle: row.subtitle,
          lot_width: row.lot_width,
          lot_length: row.lot_length,
          lot_area: row.lot_area,
          total_floor_area: row.total_floor_area,
          floorsCount: row.floors_count,
          floors: [],
          metadata: { createdAt: row.created_at, updatedAt: row.updated_at }
        };
      }
    });
  }

  /**
   * Find project by ID
   * @param {string} id
   * @returns {Promise<ProjectDocument|null>}
   */
  async findById(id) {
    await this.init();
    const stmt = this.db.prepare('SELECT data FROM projects WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    try {
      const parsed = JSON.parse(row.data);
      return ProjectDocument.fromJSON(parsed);
    } catch (err) {
      console.error(`Corrupt project document in SQLite id=${id}:`, err);
      return null;
    }
  }

  /**
   * Save or update project
   * @param {ProjectDocument|Object} projectData
   * @returns {Promise<ProjectDocument>}
   */
  async save(projectData) {
    await this.init();
    const project = projectData instanceof ProjectDocument
      ? projectData
      : ProjectDocument.fromJSON(projectData);

    const validation = project.validate();
    if (!validation.valid) {
      throw new Error(`Invalid project: ${validation.errors.join('; ')}`);
    }

    const jsonText = JSON.stringify(project.toJSON());
    const stmt = this.db.prepare(`
      INSERT INTO projects (
        id, title, code, subtitle, lot_width, lot_length, lot_area,
        total_floor_area, floors_count, data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        code = excluded.code,
        subtitle = excluded.subtitle,
        lot_width = excluded.lot_width,
        lot_length = excluded.lot_length,
        lot_area = excluded.lot_area,
        total_floor_area = excluded.total_floor_area,
        floors_count = excluded.floors_count,
        data = excluded.data,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      project.id,
      project.title,
      project.code,
      project.subtitle,
      project.lot_width,
      project.lot_length,
      project.lot_area,
      project.total_floor_area,
      project.floors.length,
      jsonText,
      project.metadata?.createdAt || new Date().toISOString(),
      project.metadata?.updatedAt || new Date().toISOString()
    );

    return project;
  }

  /**
   * Delete project by ID
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    await this.init();
    try {
      this.db.prepare('DELETE FROM chat_messages WHERE project_id = ?').run(id);
    } catch {}
    const stmt = this.db.prepare('DELETE FROM projects WHERE id = ?');
    const result = stmt.run(id);
    return Number(result.changes) > 0;
  }

  /**
   * Alias for delete(id)
   * @param {string} projectId
   * @returns {Promise<boolean>}
   */
  async deleteProject(projectId) {
    return this.delete(projectId);
  }

  /**
   * Retrieve chat messages for a project
   * @param {string} projectId
   * @returns {Promise<Array<Object>>}
   */
  async getChatMessages(projectId) {
    await this.init();
    const stmt = this.db.prepare('SELECT id, project_id, sender, text, attachments, stage_info, created_at FROM chat_messages WHERE project_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(projectId);
    return rows.map(r => new ChatMessage(r).toJSON());
  }

  /**
   * Add a chat message to a project
   * @param {string} projectId
   * @param {Object} msgData
   * @returns {Promise<Object>}
   */
  async addChatMessage(projectId, msgData) {
    await this.init();
    const msg = new ChatMessage({ ...msgData, project_id: projectId });
    const stmt = this.db.prepare(`
      INSERT INTO chat_messages (id, project_id, sender, text, attachments, stage_info, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id,
      msg.project_id,
      msg.sender,
      msg.text,
      JSON.stringify(msg.attachments),
      msg.stage_info ? JSON.stringify(msg.stage_info) : null,
      msg.created_at
    );
    return msg.toJSON();
  }

  /**
   * Get furniture assets with optional category & search filter
   * @param {Object} [filter]
   * @param {string} [filter.category]
   * @param {string} [filter.search]
   * @returns {Promise<Array<Object>>}
   */
  async getFurnitureAssets(filter = {}) {
    await this.init();
    let query = 'SELECT id, asset_id, name, category, room_types, placement_type, dimensions, tags, glb_path, is_builtin, created_at FROM furniture_assets WHERE 1=1';
    const params = [];

    if (filter.category && filter.category !== 'all') {
      query += ' AND category = ?';
      params.push(filter.category);
    }

    if (filter.search && filter.search.trim()) {
      query += ' AND (name LIKE ? OR asset_id LIKE ? OR tags LIKE ?)';
      const term = `%${filter.search.trim()}%`;
      params.push(term, term, term);
    }

    query += ' ORDER BY is_builtin DESC, name ASC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);
    return rows.map(r => new FurnitureAsset(r).toJSON());
  }

  /**
   * Add or update furniture asset
   * @param {Object} assetData
   * @returns {Promise<Object>}
   */
  async addFurnitureAsset(assetData) {
    await this.init();
    const asset = new FurnitureAsset(assetData);
    const stmt = this.db.prepare(`
      INSERT INTO furniture_assets (
        id, asset_id, name, category, room_types, placement_type, dimensions, tags, glb_path, is_builtin, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        room_types = excluded.room_types,
        placement_type = excluded.placement_type,
        dimensions = excluded.dimensions,
        tags = excluded.tags,
        glb_path = excluded.glb_path,
        is_builtin = excluded.is_builtin
    `);
    stmt.run(
      asset.id,
      asset.asset_id,
      asset.name,
      asset.category,
      JSON.stringify(asset.room_types),
      asset.placement_type,
      JSON.stringify(asset.dimensions),
      JSON.stringify(asset.tags),
      asset.glb_path,
      asset.is_builtin,
      asset.created_at
    );
    return asset.toJSON();
  }

  /**
   * Delete furniture asset by ID or asset_id
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async deleteFurnitureAsset(id) {
    await this.init();
    const stmt = this.db.prepare('DELETE FROM furniture_assets WHERE id = ? OR asset_id = ?');
    const result = stmt.run(id, id);
    return Number(result.changes) > 0;
  }

  /**
   * Get singleton AI Config
   * @returns {Promise<Object>}
   */
  async getAiConfig() {
    await this.init();
    const stmt = this.db.prepare('SELECT id, provider, base_url, api_key, primary_model, vision_model, updated_at FROM ai_config WHERE id = ?');
    const row = stmt.get('default');
    if (!row) {
      const def = new AiConfig({
        id: 'default',
        provider: 'antigravity',
        base_url: 'https://api.openai.com/v1',
        api_key: process.env.OPENAI_API_KEY || '',
        primary_model: 'gemini-2.5-flash',
        vision_model: 'gemini-2.5-flash'
      });
      await this.saveAiConfig(def);
      return def.toJSON();
    }
    return new AiConfig(row).toJSON();
  }

  /**
   * Save singleton AI Config
   * @param {Object} config
   * @returns {Promise<Object>}
   */
  async saveAiConfig(config = {}) {
    await this.init();
    const cfg = new AiConfig({
      ...config,
      id: 'default',
      updated_at: new Date().toISOString()
    });
    const stmt = this.db.prepare(`
      INSERT INTO ai_config (id, provider, base_url, api_key, primary_model, vision_model, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        primary_model = excluded.primary_model,
        vision_model = excluded.vision_model,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      cfg.id,
      cfg.provider,
      cfg.base_url,
      cfg.api_key,
      cfg.primary_model,
      cfg.vision_model,
      cfg.updated_at
    );
    return cfg.toJSON();
  }

  /**
   * Seed projects if database is empty or force is requested
   * @param {Array<ProjectDocument|Object>} projects
   * @param {boolean} [force=false]
   */
  async seed(projects, force = false) {
    await this.init();
    const countStmt = this.db.prepare('SELECT count(*) as count FROM projects');
    const countRow = countStmt.get();
    const currentCount = Number(countRow.count);

    if (currentCount > 0 && !force) {
      return { seededCount: 0, existingCount: currentCount };
    }

    let seeded = 0;
    for (const p of projects) {
      await this.save(p);
      seeded++;
    }

    return { seededCount: seeded, existingCount: currentCount };
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
