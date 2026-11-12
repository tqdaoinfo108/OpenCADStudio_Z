/**
 * mongo_repo.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 * MongoDB implementation/adapter of ProjectRepository configurable via DATABASE_DRIVER and MONGODB_URI.
 */

import { ProjectRepository } from './repository.js';
import { ProjectDocument } from './models.js';

export class MongoProjectRepository extends ProjectRepository {
  /**
   * @param {Object} [options]
   * @param {string} [options.uri] - MongoDB URI (e.g. mongodb://localhost:27017/nepnha)
   * @param {string} [options.dbName] - Database name (defaults to 'nepnha')
   */
  constructor(options = {}) {
    super();
    this.uri = options.uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/nepnha';
    this.dbName = options.dbName || process.env.MONGODB_DB_NAME || 'nepnha';
    this.client = null;
    this.db = null;
    this.collection = null;
    this.isMockMode = false;
    this.mockStore = new Map();
  }

  /**
   * Connect to MongoDB or activate mock fallback if package/instance unavailable
   */
  async init() {
    if (this.client || this.isMockMode) return;

    try {
      const mongodbModule = await import('mongodb');
      const { MongoClient } = mongodbModule;

      this.client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: 2000,
        connectTimeoutMS: 2000
      });
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.collection = this.db.collection('projects');

      // Ensure index
      await this.collection.createIndex({ id: 1 }, { unique: true });
      console.log(`[MongoProjectRepository] Connected successfully to MongoDB at ${this.uri.replace(/\/\/.*@/, '//***@')}`);
    } catch (err) {
      console.warn(`[MongoProjectRepository] MongoDB driver or server not reachable (${err.message}). Activating in-memory adapter fallback for testing.`);
      this.isMockMode = true;
      this.client = null;
      this.collection = null;
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

    if (this.isMockMode) {
      const list = Array.from(this.mockStore.values());
      return list.map(doc => {
        const p = ProjectDocument.fromJSON(doc);
        return summaryOnly ? p.toSummary() : p;
      });
    }

    const docs = await this.collection.find({}).sort({ 'metadata.createdAt': -1 }).toArray();
    return docs.map(doc => {
      const p = ProjectDocument.fromJSON(doc);
      return summaryOnly ? p.toSummary() : p;
    });
  }

  /**
   * Find project by ID
   * @param {string} id
   */
  async findById(id) {
    await this.init();
    if (this.isMockMode) {
      const doc = this.mockStore.get(id);
      return doc ? ProjectDocument.fromJSON(doc) : null;
    }

    const doc = await this.collection.findOne({ id });
    return doc ? ProjectDocument.fromJSON(doc) : null;
  }

  /**
   * Save or update project
   * @param {ProjectDocument|Object} projectData
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

    const doc = project.toJSON();

    if (this.isMockMode) {
      this.mockStore.set(project.id, JSON.parse(JSON.stringify(doc)));
      return project;
    }

    await this.collection.updateOne(
      { id: project.id },
      { $set: doc },
      { upsert: true }
    );

    return project;
  }

  /**
   * Delete project by ID
   * @param {string} id
   */
  async delete(id) {
    await this.init();
    if (this.isMockMode) {
      return this.mockStore.delete(id);
    }

    const result = await this.collection.deleteOne({ id });
    return result.deletedCount > 0;
  }

  /**
   * Seed projects
   * @param {Array<ProjectDocument|Object>} projects
   * @param {boolean} [force=false]
   */
  async seed(projects, force = false) {
    await this.init();
    let currentCount = 0;

    if (this.isMockMode) {
      currentCount = this.mockStore.size;
    } else {
      currentCount = await this.collection.countDocuments();
    }

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
   * Close connection
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.mockStore.clear();
    this.mockChatStore?.clear?.();
    this.mockFurnitureStore?.clear?.();
  }

  async deleteProject(projectId) {
    return this.delete(projectId);
  }

  async getChatMessages(projectId) {
    if (!this.mockChatStore) this.mockChatStore = new Map();
    const list = this.mockChatStore.get(projectId) || [];
    return [...list];
  }

  async addChatMessage(projectId, msgData) {
    if (!this.mockChatStore) this.mockChatStore = new Map();
    const list = this.mockChatStore.get(projectId) || [];
    const msg = {
      id: msgData.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      project_id: projectId,
      sender: msgData.sender || 'user',
      text: msgData.text || '',
      attachments: msgData.attachments || [],
      stage_info: msgData.stage_info || msgData.stageInfo || null,
      created_at: msgData.created_at || new Date().toISOString()
    };
    list.push(msg);
    this.mockChatStore.set(projectId, list);
    return msg;
  }

  async getFurnitureAssets(filter = {}) {
    if (!this.mockFurnitureStore) this.mockFurnitureStore = new Map();
    let items = Array.from(this.mockFurnitureStore.values());
    if (filter.category && filter.category !== 'all') {
      items = items.filter(i => i.category === filter.category);
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      items = items.filter(i => (i.name && i.name.toLowerCase().includes(q)) || (i.asset_id && i.asset_id.toLowerCase().includes(q)));
    }
    return items;
  }

  async addFurnitureAsset(assetData) {
    if (!this.mockFurnitureStore) this.mockFurnitureStore = new Map();
    const id = assetData.asset_id || assetData.id || `asset_${Date.now()}`;
    const doc = {
      id: assetData.id || id,
      asset_id: id,
      name: assetData.name || 'Nội thất',
      category: assetData.category || 'living_room',
      room_types: assetData.room_types || [],
      placement_type: assetData.placement_type || 'floor_wall_backed',
      dimensions: assetData.dimensions || { width: 1, depth: 1, height: 1 },
      tags: assetData.tags || [],
      glb_path: assetData.glb_path || `/assets/models/${id}.glb`,
      is_builtin: assetData.is_builtin !== undefined ? assetData.is_builtin : 1,
      created_at: assetData.created_at || new Date().toISOString()
    };
    this.mockFurnitureStore.set(id, doc);
    return doc;
  }

  async deleteFurnitureAsset(id) {
    if (!this.mockFurnitureStore) return false;
    return this.mockFurnitureStore.delete(id);
  }

  async getAiConfig() {
    return this.mockAiConfig || {
      id: 'default',
      provider: 'antigravity',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      primary_model: 'gemini-2.5-flash',
      vision_model: 'gemini-2.5-flash',
      updated_at: new Date().toISOString()
    };
  }

  async saveAiConfig(config = {}) {
    this.mockAiConfig = {
      id: 'default',
      provider: config.provider || 'antigravity',
      base_url: config.base_url || 'https://api.openai.com/v1',
      api_key: config.api_key || '',
      primary_model: config.primary_model || 'gemini-2.5-flash',
      vision_model: config.vision_model || 'gemini-2.5-flash',
      updated_at: new Date().toISOString()
    };
    return this.mockAiConfig;
  }
}
