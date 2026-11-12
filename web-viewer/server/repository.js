/**
 * repository.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 * Abstract ProjectRepository interface and driver factory.
 */

import { ProjectDocument } from './models.js';

export class ProjectRepository {
  /**
   * Find all projects (returns array of ProjectDocument summaries or full instances)
   * @param {Object} [options]
   * @param {boolean} [options.summaryOnly=false]
   * @returns {Promise<Array<ProjectDocument|Object>>}
   */
  async findAll(options = {}) {
    throw new Error('Method findAll() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Find a project by its unique ID
   * @param {string} id
   * @returns {Promise<ProjectDocument|null>}
   */
  async findById(id) {
    throw new Error('Method findById() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Insert or update a project document
   * @param {ProjectDocument|Object} project
   * @returns {Promise<ProjectDocument>}
   */
  async save(project) {
    throw new Error('Method save() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Delete a project by ID
   * @param {string} id
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async delete(id) {
    throw new Error('Method delete() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Delete a project by ID (alias for delete)
   * @param {string} projectId
   * @returns {Promise<boolean>}
   */
  async deleteProject(projectId) {
    return this.delete(projectId);
  }

  /**
   * Get chat messages for a specific project
   * @param {string} projectId
   * @returns {Promise<Array<Object>>}
   */
  async getChatMessages(projectId) {
    return [];
  }

  /**
   * Append a chat message to a project's history
   * @param {string} projectId
   * @param {Object} msgData
   * @returns {Promise<Object>}
   */
  async addChatMessage(projectId, msgData) {
    throw new Error('Method addChatMessage() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Get furniture assets from database
   * @param {Object} [filter]
   * @param {string} [filter.category]
   * @param {string} [filter.search]
   * @returns {Promise<Array<Object>>}
   */
  async getFurnitureAssets(filter = {}) {
    return [];
  }

  /**
   * Add or update a furniture asset
   * @param {Object} assetData
   * @returns {Promise<Object>}
   */
  async addFurnitureAsset(assetData) {
    throw new Error('Method addFurnitureAsset() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Delete a furniture asset by ID or asset_id
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async deleteFurnitureAsset(id) {
    throw new Error('Method deleteFurnitureAsset() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Get AI Provider Hub configuration
   * @returns {Promise<Object>}
   */
  async getAiConfig() {
    throw new Error('Method getAiConfig() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Save AI Provider Hub configuration
   * @param {Object} config
   * @returns {Promise<Object>}
   */
  async saveAiConfig(config) {
    throw new Error('Method saveAiConfig() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Seed projects into database if empty or force flag is specified
   * @param {Array<ProjectDocument|Object>} projects
   * @param {boolean} [force=false]
   * @returns {Promise<{ seededCount: number, existingCount: number }>}
   */
  async seed(projects, force = false) {
    throw new Error('Method seed() must be implemented by ProjectRepository subclass.');
  }

  /**
   * Close or cleanup repository resources
   * @returns {Promise<void>}
   */
  async close() {
    // Default no-op
  }
}

/**
 * Repository Factory: instantiates appropriate repository based on driver
 * @param {Object} [options]
 * @param {string} [options.driver] - 'sqlite' (default) or 'mongo' / 'mongodb'
 * @param {string} [options.dbPath] - SQLite file path
 * @param {string} [options.uri] - MongoDB connection URI
 * @returns {Promise<ProjectRepository>}
 */
export async function createRepository(options = {}) {
  const driver = (options.driver || process.env.DATABASE_DRIVER || 'sqlite').toLowerCase();

  if (driver === 'mongo' || driver === 'mongodb') {
    const { MongoProjectRepository } = await import('./mongo_repo.js');
    const repo = new MongoProjectRepository(options);
    await repo.init();
    return repo;
  }

  const { SqliteProjectRepository } = await import('./sqlite_repo.js');
  const repo = new SqliteProjectRepository(options);
  await repo.init();
  return repo;
}
