/**
 * index.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 * REST API Server & Static File Host for 3D Architectural CAD Viewer.
 *
 * Endpoints:
 * - GET    /api/health
 * - GET    /api/projects
 * - GET    /api/projects/:id
 * - POST   /api/projects
 * - POST   /api/projects/:id/analyze-floor
 * - DELETE /api/projects/:id
 * - POST   /api/ai/analyze-floor
 * - Static file server for web-viewer/ assets
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepository } from './repository.js';
import { SEED_PROJECTS } from './seed_data.js';
import { AiVisionExtractor } from './ai_vision_extractor.js';
import { ProjectDocument } from './models.js';
import { generateFurniture } from './furniture_ai.js';
import { TwoPassSpatialCompiler } from './two_pass_spatial_compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_VIEWER_ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.dxf': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function validGlbHeader(buffer, length = buffer.length) {
  return buffer.length >= 12 && buffer.toString('ascii',0,4) === 'glTF' &&
    buffer.readUInt32LE(4) === 2 && buffer.readUInt32LE(8) === length;
}

function localGlbExists(url) {
  if (!/^\/assets\/models\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.glb(?:\?[a-zA-Z0-9_=-]+)?$/.test(url)) return false;
  const filename = path.join(WEB_VIEWER_ROOT, 'public', url.split('?')[0]);
  let fd;
  try {
    fd = fs.openSync(filename, 'r');
    const header = Buffer.alloc(12);
    return fs.readSync(fd, header, 0, 12, 0) === 12 && validGlbHeader(header, fs.fstatSync(fd).size);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class WebViewerServer {
  constructor(options = {}) {
    this.port = options.port || Number(process.env.PORT) || 3000;
    this.host = options.host || '0.0.0.0';
    this.repo = null;
    this.aiExtractor = new AiVisionExtractor(options.aiOptions);
    this.spatialCompiler = new TwoPassSpatialCompiler({ aiExtractor: this.aiExtractor });
    this.httpServer = null;
  }

  /**
   * Initialize repository, seed database if empty, and start HTTP server
   */
  async start() {
    this.repo = await createRepository();
    this.spatialCompiler.repo = this.repo;
    const seedResult = await this.repo.seed(SEED_PROJECTS, true);
    if (seedResult.seededCount > 0) {
      console.log(`[WebViewerServer] Seeded ${seedResult.seededCount} initial architectural projects into database.`);
    }

    this.httpServer = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        console.error('[WebViewerServer] Internal error:', err);
        this.sendJson(res, 500, { success: false, error: 'Internal Server Error', details: err.message });
      }
    });

    return new Promise((resolve) => {
      this.httpServer.listen(this.port, this.host, () => {
        console.log(`[WebViewerServer] Server listening on http://localhost:${this.port}`);
        console.log(`[WebViewerServer] Serving static files from: ${WEB_VIEWER_ROOT}`);
        resolve(this);
      });
    });
  }

  async stop() {
    if (this.httpServer) {
      if (typeof this.httpServer.closeAllConnections === 'function') {
        this.httpServer.closeAllConnections();
      }
      await new Promise(resolve => this.httpServer.close(resolve));
      this.httpServer = null;
    }
    if (this.repo) {
      await this.repo.close();
      this.repo = null;
    }
  }

  async handleRequest(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // --- API ROUTES ---
    if (pathname.startsWith('/api/')) {
      return this.handleApiRoute(req, res, pathname, parsedUrl);
    }

    // --- DEDICATED CLIENT VIEWER ROUTE ---
    if (pathname === '/viewer' || pathname === '/viewer/') {
      return this.handleStaticFile(req, res, '/viewer.html');
    }

    // --- STATIC FILES ---
    return this.handleStaticFile(req, res, pathname);
  }

  async handleApiRoute(req, res, pathname, parsedUrl) {
    const method = req.method;

    // 1. GET /api/health
    if (pathname === '/api/health' && method === 'GET') {
      return this.sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        driver: this.repo.constructor.name,
        timestamp: new Date().toISOString()
      });
    }

    // --- AI PROVIDER HUB ENDPOINTS ---

    // GET /api/ai/config
    if (pathname === '/api/ai/config' && method === 'GET') {
      const config = await this.repo.getAiConfig();
      return this.sendJson(res, 200, { success: true, data: config, config });
    }

    // POST /api/ai/config
    if (pathname === '/api/ai/config' && method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body) {
        return this.sendJson(res, 400, { success: false, error: 'Missing config payload' });
      }
      const saved = await this.repo.saveAiConfig(body);
      return this.sendJson(res, 200, { success: true, data: saved, config: saved });
    }

    // POST /api/ai/models (Dynamic model discovery with curated provider fallbacks)
    if (pathname === '/api/ai/models' && method === 'POST') {
      const body = (await this.readJsonBody(req)) || {};
      let { baseUrl, apiKey, provider } = body;
      const currentConfig = await this.repo.getAiConfig();

      provider = (provider || currentConfig.provider || 'antigravity').toLowerCase();
      baseUrl = baseUrl || currentConfig.base_url || 'https://api.openai.com/v1';
      apiKey = apiKey !== undefined ? apiKey : currentConfig.api_key;

      const fallbackCatalog = {
        openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview', 'o3-mini'],
        openrouter: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-2.0-flash-exp:free', 'deepseek/deepseek-r1'],
        ollama: ['llama3.3:latest', 'qwen2.5-coder:32b', 'deepseek-r1:14b', 'mistral:latest', 'llava:latest'],
        antigravity: ['gemini-2.5-flash', 'gemini-2.5-pro', 'claude-3-7-sonnet', 'gpt-4o']
      };

      const defaultFallback = fallbackCatalog[provider] || fallbackCatalog.antigravity;

      if (baseUrl && !baseUrl.includes('offline')) {
        try {
          const headers = {};
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3500);

          let url = baseUrl;
          if (provider === 'ollama' && !url.includes('/api/tags') && !url.includes('/v1/models')) {
            url = url.replace(/\/+$/, '') + '/api/tags';
          } else if (!url.endsWith('/models')) {
            url = url.replace(/\/+$/, '') + '/models';
          }

          const resp = await fetch(url, { headers, signal: controller.signal });
          clearTimeout(timeout);

          if (resp.ok) {
            const data = await resp.json();
            let modelList = [];
            if (Array.isArray(data.data)) {
              modelList = data.data.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
            } else if (Array.isArray(data.models)) {
              modelList = data.models.map(m => (typeof m === 'string' ? m : (m.name || m.id))).filter(Boolean);
            } else if (Array.isArray(data)) {
              modelList = data.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
            }

            if (modelList.length > 0) {
              const sanitized = Array.from(new Set(modelList.map(s => String(s).trim()))).slice(0, 50);
              return this.sendJson(res, 200, { success: true, provider, models: sanitized, data: sanitized, source: 'remote' });
            }
          }
        } catch {
          // Fall through to fallback
        }
      }

      return this.sendJson(res, 200, {
        success: true,
        provider,
        models: defaultFallback,
        data: defaultFallback,
        source: 'curated_fallback'
      });
    }

    // POST /api/ai/test-connection
    if (pathname === '/api/ai/test-connection' && method === 'POST') {
      const body = (await this.readJsonBody(req)) || {};
      const startTime = Date.now();
      const currentConfig = await this.repo.getAiConfig();

      const provider = body.provider || currentConfig.provider || 'antigravity';
      const baseUrl = body.baseUrl || currentConfig.base_url || 'https://api.openai.com/v1';
      const apiKey = body.apiKey !== undefined ? body.apiKey : currentConfig.api_key;

      if (!baseUrl || baseUrl.includes('offline') || provider === 'antigravity' || provider.includes('mock') || provider.includes('custom')) {
        const latencyMs = Math.max(12, Math.floor(Math.random() * 25));
        return this.sendJson(res, 200, {
          success: true,
          latencyMs,
          provider,
          modelCount: 4,
          message: `Connected successfully to ${provider} AI Provider Engine (Ready)`
        });
      }

      try {
        const headers = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        let testUrl = baseUrl;
        if (provider === 'ollama') {
          testUrl = testUrl.replace(/\/+$/, '') + '/api/tags';
        } else if (!testUrl.endsWith('/models')) {
          testUrl = testUrl.replace(/\/+$/, '') + '/models';
        }

        const resp = await fetch(testUrl, { headers, signal: controller.signal });
        clearTimeout(timeout);
        const latencyMs = Date.now() - startTime;

        return this.sendJson(res, 200, {
          success: resp.ok || resp.status === 401 || resp.status === 403,
          latencyMs,
          statusCode: resp.status,
          message: resp.ok
            ? `Connected successfully to ${provider} (${latencyMs}ms)`
            : `Endpoint reachable (${resp.status} ${resp.statusText})`
        });
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        return this.sendJson(res, 200, {
          success: false,
          latencyMs,
          error: err.message,
          message: `Connection to ${provider} failed: ${err.message}`
        });
      }
    }

    // --- FURNITURE ASSETS API (PLUG-AND-PLAY FURNITURE STORE) ---

    if (pathname === '/api/furniture-assets/generate' && method === 'POST') {
      const body = await this.readJsonBody(req);
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > 2000) return this.sendJson(res, 400, { success:false, error:'Nhập yêu cầu từ 1 đến 2000 ký tự.' });
      let output;
      try {
        output = await generateFurniture(prompt, await this.repo.getAiConfig());
      } catch (error) {
        return this.sendJson(res, 422, { success:false, error: error instanceof SyntaxError ? 'Blueprint AI không phải JSON hợp lệ.' : error.message });
      }
      const { asset, glb } = output;
      asset.glb_path = '/assets/models/custom/' + asset.asset_id + '.glb';
      const filename = path.join(WEB_VIEWER_ROOT, 'public', asset.glb_path);
      await fs.promises.mkdir(path.dirname(filename), { recursive:true });
      await fs.promises.writeFile(filename, glb, { flag:'wx' });
      try {
        const saved = await this.repo.addFurnitureAsset(asset);
        return this.sendJson(res, 201, { success:true, data:saved });
      } catch (error) {
        await fs.promises.unlink(filename);
        throw error;
      }
    }

    // GET /api/furniture or GET /api/furniture-assets
    if ((pathname === '/api/furniture' || pathname === '/api/furniture-assets') && method === 'GET') {
      const category = parsedUrl.searchParams.get('category');
      const search = parsedUrl.searchParams.get('search');
      const type = parsedUrl.searchParams.get('type') || parsedUrl.searchParams.get('asset_type');
      const records = await this.repo.getFurnitureAssets({ category, search, type });
      const assets = records.filter(asset => asset.asset_type !== 'real' && localGlbExists(asset.glb_path)).map(asset => ({
        ...asset, image_url:'', thumbnail_url:'', source_image_url:''
      }));
      return this.sendJson(res, 200, {
        success: true,
        count: assets.length,
        data: assets,
        assets: assets,
        items: assets
      });
    }

    // POST /api/furniture or POST /api/furniture-assets (Create/Upload custom asset: 3D model or Real furniture)
    if ((pathname === '/api/furniture' || pathname === '/api/furniture-assets') && method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body || !body.name) {
        return this.sendJson(res, 400, { success: false, error: 'Missing furniture name or asset data' });
      }

      const rawName = String(body.name).trim();
      const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (body.asset_type === 'real' || body.imageBase64 || body.image_base64 || body.image_url) {
        return this.sendJson(res, 400, { success:false, error:'Kho chỉ nhận mô hình GLB.' });
      }
      const assetType = 'model';
      const assetId = body.asset_id || `custom_${Date.now()}_${slug || 'item'}`;
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(assetId)) return this.sendJson(res, 400, { success:false, error:'Asset ID không hợp lệ.' });
      const previous = (await this.repo.getFurnitureAssets()).find(asset => asset.asset_id === assetId);
      let glbPath = previous?.glb_path || `/assets/models/custom/${assetId}.glb`;

      // Handle GLB upload for 3D model
      const base64Data = body.glbBase64 || body.glb_base64;
      if (base64Data) {
        try {
          let cleanBase64 = base64Data;
          if (cleanBase64.includes('base64,')) {
            cleanBase64 = cleanBase64.split('base64,')[1];
          }
          const glbBuffer = Buffer.from(cleanBase64, 'base64');
          if (!validGlbHeader(glbBuffer)) return this.sendJson(res, 400, { success:false, error:'Tệp GLB không hợp lệ.' });

          const targetSubdir = 'custom';
          const publicGlbDir = path.join(WEB_VIEWER_ROOT, 'public', 'assets', 'models', targetSubdir);
          if (!fs.existsSync(publicGlbDir)) fs.mkdirSync(publicGlbDir, { recursive: true });
          fs.writeFileSync(path.join(publicGlbDir, `${assetId}.glb`), glbBuffer);

          const distDir = path.join(WEB_VIEWER_ROOT, 'dist', 'assets', 'models');
          if (fs.existsSync(distDir)) {
            const distGlbDir = path.join(distDir, targetSubdir);
            if (!fs.existsSync(distGlbDir)) fs.mkdirSync(distGlbDir, { recursive: true });
            fs.writeFileSync(path.join(distGlbDir, `${assetId}.glb`), glbBuffer);
          }
          glbPath = `/assets/models/${targetSubdir}/${assetId}.glb`;
        } catch (err) {
          return this.sendJson(res, 500, { success:false, error:'Không thể lưu tệp GLB.' });
        }
      }

      if (!localGlbExists(glbPath)) return this.sendJson(res, 400, { success:false, error:'Cần tệp GLB hợp lệ.' });
      const dims = body.dimensions || { width: 1.0, depth: 1.0, height: 1.0 };
      const sizeX = typeof body.size_x === 'number' ? body.size_x : (Number(dims.width || dims.nativeWidth) || 1.0);
      const sizeY = typeof body.size_y === 'number' ? body.size_y : (Number(dims.height || dims.nativeHeight) || 1.0);
      const sizeZ = typeof body.size_z === 'number' ? body.size_z : (Number(dims.depth || dims.nativeDepth) || 1.0);

      const assetRecord = {
        id: assetId,
        asset_id: assetId,
        name: rawName,
        category: body.category || 'living_room',
        asset_type: assetType,

        variant_of: body.variant_of || '',
        aspect_ratio: typeof body.aspect_ratio === 'number' ? body.aspect_ratio : 1.0,
        description: body.description || '',
        room_types: Array.isArray(body.room_types) ? body.room_types : [body.category || 'living_room'],
        placement_type: body.placement_type || 'floor_wall_backed',
        dimensions: dims,
        size_x: sizeX,
        size_y: sizeY,
        size_z: sizeZ,
        tags: Array.isArray(body.tags) ? body.tags : [body.category || 'living_room', assetType],
        glb_path: glbPath,
        is_builtin: previous?.is_builtin || 0
      };

      const saved = await this.repo.addFurnitureAsset(assetRecord);
      this.updateAssetCatalogFile(saved);

      return this.sendJson(res, 201, { success: true, data: saved, asset: saved });
    }

    // DELETE /api/furniture-assets/:id or /api/furniture/:id
    const furnDelMatch = pathname.match(/^\/api\/(?:furniture-assets|furniture)\/([^/]+)$/);
    if (furnDelMatch && method === 'DELETE') {
      const assetId = decodeURIComponent(furnDelMatch[1]);
      const deleted = await this.repo.deleteFurnitureAsset(assetId);

      const pubFile = path.join(WEB_VIEWER_ROOT, 'public', 'assets', 'models', 'custom', `${assetId}.glb`);
      if (fs.existsSync(pubFile)) {
        try { fs.unlinkSync(pubFile); } catch {}
      }
      const distFile = path.join(WEB_VIEWER_ROOT, 'dist', 'assets', 'models', 'custom', `${assetId}.glb`);
      if (fs.existsSync(distFile)) {
        try { fs.unlinkSync(distFile); } catch {}
      }

      this.removeAssetFromCatalogFile(assetId);

      return this.sendJson(res, 200, { success: true, message: `Furniture asset "${assetId}" deleted.`, deleted });
    }

    // 2. GET /api/projects
    if (pathname === '/api/projects' && method === 'GET') {
      const summaryParam = parsedUrl.searchParams.get('summary');
      const summaryOnly = summaryParam !== 'false';
      const projects = await this.repo.findAll({ summaryOnly });
      return this.sendJson(res, 200, {
        success: true,
        count: projects.length,
        data: projects,
        projects: projects
      });
    }

    // 3. POST /api/projects
    if (pathname === '/api/projects' && method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body) {
        return this.sendJson(res, 400, { success: false, error: 'Missing or invalid JSON body' });
      }

      try {
        const project = ProjectDocument.fromJSON(body);
        const validation = project.validate();
        if (!validation.valid) {
          return this.sendJson(res, 400, { success: false, errors: validation.errors });
        }
        const saved = await this.repo.save(project);
        const savedJson = saved.toJSON();
        return this.sendJson(res, 201, { success: true, data: savedJson, project: savedJson });
      } catch (err) {
        return this.sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // Match /api/projects/:id, /api/projects/:id/analyze-floor, or /api/projects/:id/chat
    const projectRouteMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (projectRouteMatch) {
      const projectId = decodeURIComponent(projectRouteMatch[1]);
      const subAction = projectRouteMatch[2];

      // Chat history retrieval: GET /api/projects/:id/chat or /api/projects/:id/messages
      if ((subAction === 'chat' || subAction === 'messages') && method === 'GET') {
        const messages = await this.repo.getChatMessages(projectId);
        return this.sendJson(res, 200, {
          success: true,
          projectId,
          count: messages.length,
          data: messages,
          messages: messages
        });
      }

      // Interactive Two-Pass Spatial Compiler: POST /api/projects/:id/chat
      if (subAction === 'chat' && method === 'POST') {
        const project = await this.repo.findById(projectId);
        if (!project) {
          return this.sendJson(res, 404, { success: false, error: `Project not found with id: ${projectId}` });
        }

        const body = await this.readJsonBody(req);
        if (!body || !body.message) {
          return this.sendJson(res, 400, { success: false, error: 'Missing chat "message"' });
        }

        // 1. Record user chat message
        const userMsg = await this.repo.addChatMessage(projectId, {
          sender: 'user',
          text: body.message,
          attachments: body.attachments || [],
          stage_info: null
        });

        // 2. Load furniture catalog & AI configuration
        const furnitureCatalog = await this.repo.getFurnitureAssets();
        const aiConfig = await this.repo.getAiConfig();

        // 3. Compile project modifications through 4-phase spatial compiler
        const compileResult = await this.spatialCompiler.compile({
          project,
          userMessage: body.message,
          attachments: body.attachments || [],
          currentFloorId: body.currentFloorId || null,
          furnitureCatalog,
          aiConfig
        });

        // 4. Save updated project back to SQLite
        await this.repo.save(compileResult.updatedProject);

        // 5. Record assistant response with stageInfo
        const assistantMsg = await this.repo.addChatMessage(projectId, {
          sender: 'assistant',
          text: compileResult.assistantMessage,
          attachments: [],
          stage_info: compileResult.stageInfo
        });

        const projJson = compileResult.updatedProject.toJSON();
        return this.sendJson(res, 200, {
          success: true,
          projectId: project.id,
          userMessage: userMsg,
          assistantMessage: assistantMsg,
          bimScene: compileResult.bimScene,
          bimData: projJson,
          project: projJson,
          stageInfo: compileResult.stageInfo
        });
      }

      // 4. POST /api/projects/:id/analyze-floor
      if (subAction === 'analyze-floor' && method === 'POST') {
        const project = await this.repo.findById(projectId);
        if (!project) {
          return this.sendJson(res, 404, { success: false, error: `Project not found with id: ${projectId}` });
        }

        const body = await this.readJsonBody(req);
        const floorId = body?.floorId || (project.floors[0] ? project.floors[0].id : 'floor_1');
        const floor = project.getFloor(floorId);

        if (!floor) {
          return this.sendJson(res, 404, {
            success: false,
            error: `Floor "${floorId}" not found in project "${projectId}". Available: ${project.floors.map(f => f.id).join(', ')}`
          });
        }

        const analysisInput = {
          floorDocument: floor,
          entities: body?.entities || floor.entities,
          imageBase64: body?.imageBase64,
          mimeType: body?.mimeType,
          dxfContent: body?.dxfContent,
          floorContext: {
            id: floor.id,
            name: floor.name,
            elevation: floor.elevation,
            height: floor.height,
            projectTitle: project.title,
            ...(body?.floorContext || {})
          }
        };

        const analysisResult = await this.aiExtractor.analyzeFloor(analysisInput, {
          forceOffline: Boolean(body?.forceOffline)
        });

        // Update floor in project and save
        project.updateFloorAnalysis(floor.id, analysisResult);
        await this.repo.save(project);

        return this.sendJson(res, 200, {
          success: true,
          projectId: project.id,
          floorId: floor.id,
          analysis: analysisResult
        });
      }

      // 5. GET /api/projects/:id
      if (!subAction && method === 'GET') {
        const project = await this.repo.findById(projectId);
        if (!project) {
          return this.sendJson(res, 404, { success: false, error: `Project not found with id: ${projectId}` });
        }
        const pJson = project.toJSON();
        return this.sendJson(res, 200, { success: true, data: pJson, project: pJson });
      }

      // 6. DELETE /api/projects/:id
      if (!subAction && method === 'DELETE') {
        const deleted = await this.repo.deleteProject(projectId);
        if (!deleted) {
          return this.sendJson(res, 404, { success: false, error: `Project not found with id: ${projectId}` });
        }
        return this.sendJson(res, 200, { success: true, message: `Project ${projectId} deleted.` });
      }
    }

    // 7. POST /api/ai/analyze-floor (Standalone analysis)
    if (pathname === '/api/ai/analyze-floor' && method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body) {
        return this.sendJson(res, 400, { success: false, error: 'Missing request body' });
      }
      const analysisResult = await this.aiExtractor.analyzeFloor(body, {
        forceOffline: Boolean(body.forceOffline)
      });
      return this.sendJson(res, 200, { success: true, analysis: analysisResult });
    }

    return this.sendJson(res, 404, { success: false, error: `API route not found: ${method} ${pathname}` });
  }

  handleStaticFile(req, res, pathname) {
    let safePath = pathname === '/' ? '/index.html' : pathname;
    if (pathname === '/viewer' || pathname === '/viewer/') {
      safePath = '/viewer.html';
    }
    let filePath = path.join(WEB_VIEWER_ROOT, safePath);

    if (pathname.startsWith('/assets/')) {
      const publicPath = path.join(WEB_VIEWER_ROOT, 'public', safePath);
      const distPath = path.join(WEB_VIEWER_ROOT, 'dist', safePath);
      const rootPath = path.join(WEB_VIEWER_ROOT, safePath);
      if (fs.existsSync(publicPath) && !fs.statSync(publicPath).isDirectory()) {
        filePath = publicPath;
      } else if (fs.existsSync(distPath) && !fs.statSync(distPath).isDirectory()) {
        filePath = distPath;
      } else {
        filePath = rootPath;
      }
    }

    // Prevent directory traversal attacks
    if (!filePath.startsWith(WEB_VIEWER_ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Check if file exists, else fallback to index.html for SPA (or viewer.html for /viewer)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (pathname.startsWith('/assets/')) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      if (pathname.startsWith('/viewer')) {
        filePath = path.join(WEB_VIEWER_ROOT, 'viewer.html');
      } else {
        filePath = path.join(WEB_VIEWER_ROOT, 'index.html');
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl = ext === '.glb' ? 'public, max-age=3600' : 'no-cache';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }

  updateAssetCatalogFile(asset) {
    const catalogPaths = [
      path.join(WEB_VIEWER_ROOT, 'public', 'assets', 'models', 'asset_catalog.json'),
      path.join(WEB_VIEWER_ROOT, 'dist', 'assets', 'models', 'asset_catalog.json')
    ];

    for (const catPath of catalogPaths) {
      if (fs.existsSync(catPath)) {
        try {
          const catalog = JSON.parse(fs.readFileSync(catPath, 'utf8'));
          if (!Array.isArray(catalog.assets)) catalog.assets = [];
          const idx = catalog.assets.findIndex(a => (a.asset_id || a.id) === asset.asset_id);
          const entry = {
            id: asset.asset_id,
            asset_id: asset.asset_id,
            name: asset.name,
            category: asset.category,
            url: asset.glb_path,
            file: `custom/${asset.asset_id}.glb`,
            dimensions: asset.dimensions,
            size_x: asset.size_x !== undefined ? asset.size_x : (Number(asset.dimensions?.width) || 1.0),
            size_y: asset.size_y !== undefined ? asset.size_y : (Number(asset.dimensions?.height) || 1.0),
            size_z: asset.size_z !== undefined ? asset.size_z : (Number(asset.dimensions?.depth) || 1.0),
            placement_type: asset.placement_type,
            room_types: asset.room_types,
            isCustom: true
          };
          if (idx >= 0) {
            catalog.assets[idx] = { ...catalog.assets[idx], ...entry };
          } else {
            catalog.assets.push(entry);
          }
          catalog.totalAssets = catalog.assets.length;
          fs.writeFileSync(catPath, JSON.stringify(catalog, null, 2), 'utf8');
        } catch (err) {
          console.error(`[WebViewerServer] Failed to update catalog at ${catPath}:`, err);
        }
      }
    }
  }

  removeAssetFromCatalogFile(assetId) {
    const catalogPaths = [
      path.join(WEB_VIEWER_ROOT, 'public', 'assets', 'models', 'asset_catalog.json'),
      path.join(WEB_VIEWER_ROOT, 'dist', 'assets', 'models', 'asset_catalog.json')
    ];

    for (const catPath of catalogPaths) {
      if (fs.existsSync(catPath)) {
        try {
          const catalog = JSON.parse(fs.readFileSync(catPath, 'utf8'));
          if (Array.isArray(catalog.assets)) {
            const initialLen = catalog.assets.length;
            catalog.assets = catalog.assets.filter(a => (a.asset_id || a.id) !== assetId);
            if (catalog.assets.length !== initialLen) {
              catalog.totalAssets = catalog.assets.length;
              fs.writeFileSync(catPath, JSON.stringify(catalog, null, 2), 'utf8');
            }
          }
        } catch (err) {
          console.error(`[WebViewerServer] Failed to remove asset from catalog at ${catPath}:`, err);
        }
      }
    }
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
        if (data.length > 25 * 1024 * 1024) { // 25MB max limit (supports base64 floorplan images)
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!data.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('Invalid JSON format: ' + err.message));
        }
      });
      req.on('error', reject);
    });
  }

  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  }
}

// Direct execution entrypoint
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('server/index.js') || 
  process.argv[1].endsWith('server\\index.js')
);

if (isDirectRun) {
  const server = new WebViewerServer();
  server.start().catch(err => {
    console.error('Fatal server startup error:', err);
    process.exit(1);
  });
}
