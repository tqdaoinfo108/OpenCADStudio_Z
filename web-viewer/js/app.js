/**
 * app.js
 * OpenCADStudio_Z: Main Application Controller
 * Connects CAD-BIM Pipeline, 3D WebGL Viewer, 2D Floorplan SVGs, and UI HUD.
 * Full Multi-Project management, 5-Stage Progressive Rendering, Smart Floor Isolation,
 * Exploded View separation control, and dynamic furniture inspector.
 */

import { Viewer3D } from './viewer_3d.js';
import { CadBimPipeline } from './cad_bim_pipeline.js';
import { FloorplanSvgGenerator } from './floorplan_svg.js';
import { AssetLibraryManager } from './asset_library_manager.js';
import { SAMPLE_VILLA, SAMPLE_TOWNHOUSE_4F, SAMPLE_VILLA_GARDEN_3F } from './sample_models.js';
import { AiSettingsModal } from './ai_settings_modal.js';
import { FurnitureStoreModal } from './furniture_store_modal.js';
import { AiChatController } from './ai_chat_controller.js';

class ArchitecturalViewerApp {
  constructor() {
    this.pipeline = new CadBimPipeline();
    this.assetLibrary = AssetLibraryManager.getInstance();
    this.viewer = null;
    this.currentBim = null;
    this.activeFloorId = 'floor_1';
    this.floorVisibility = new Map();
    this.currentStage = 5; // 1 to 5

    // Multi-Project state
    this.availableProjects = [];
    this.activeProjectId = null;

    // Presentation Mode state
    this.isPresentationMode = false;

    // Modals & Chat Controllers
    this.aiSettings = null;
    this.furnitureStore = null;
    this.aiChat = null;

    this.init();
  }

  async init() {
    // 1. Initialize 3D Engine
    const container = document.getElementById('viewport-container');
    this.viewer = new Viewer3D(container, {
      onObjectSelected: (objData) => this.showObjectInspector(objData),
      onFloorIsolated: (floorId) => this.syncFloorIsolationUI(floorId),
      onAssetPreloadProgress: (loaded, total, assetId) => this.updateAssetPreloadBadge(loaded, total, assetId)
    });

    // 2. Initialize Modals and AI Chat Controller
    this.aiSettings = new AiSettingsModal();
    this.furnitureStore = new FurnitureStoreModal({
      viewer: this.viewer,
      onAssetAdded: (asset) => {
        console.log('[App] New custom furniture added:', asset);
      }
    });
    this.aiChat = new AiChatController(this);

    // 3. Setup DOM event listeners & CAD file drag/drop
    this.setupUIEventListeners();
    this.setupCadFileHandling();

    // 4. Preload 35 .glb models and load projects list in parallel
    await Promise.all([
      AssetLibraryManager.preloadAll((loaded, total, assetId) => this.updateAssetPreloadBadge(loaded, total, assetId)),
      this.loadProjectList()
    ]);

    // 5. Check URL query parameters (?mode=viewer & ?project=<id>)
    const urlParams = new URLSearchParams(window.location.search);
    const requestedProject = urlParams.get('project');
    const isViewerMode = urlParams.get('mode') === 'viewer';

    let defaultId = 'proj_sample_villa_3f';
    if (requestedProject) {
      const match = this.availableProjects.find(p => p.id === requestedProject || p.code === requestedProject);
      if (match) {
        defaultId = match.id;
      }
    } else {
      const defaultProject = this.availableProjects[0] || SAMPLE_VILLA;
      defaultId = defaultProject.id || 'proj_sample_villa_3f';
    }

    await this.switchProject(defaultId);

    // 6. Activate presentation mode if specified in URL
    if (isViewerMode) {
      this.enterPresentationMode();
    }
  }

  updateAssetPreloadBadge(loaded, total) {
    const badge = document.getElementById('asset-preload-badge');
    if (!badge) return;
    badge.textContent = `${loaded}/${total} GLB`;
    if (loaded >= total && total > 0) {
      badge.classList.add('ready');
    }
  }

  // ================= MULTI-PROJECT MANAGEMENT =================

  async loadProjectList() {
    const sampleVillaWithId = {
      id: SAMPLE_VILLA.id || 'proj_sample_villa_3f',
      ...SAMPLE_VILLA
    };

    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const json = await res.json();
        const list = Array.isArray(json) ? json : (json.data || []);
        if (Array.isArray(list) && list.length > 0) {
          this.availableProjects = list;
          // Ensure SAMPLE_VILLA is also available in the switcher
          const hasVilla = this.availableProjects.some(
            p => p.id === sampleVillaWithId.id || p.code === SAMPLE_VILLA.code
          );
          if (!hasVilla) {
            this.availableProjects.push(sampleVillaWithId);
          }
        } else {
          this.setupFallbackProjects();
        }
      } else {
        this.setupFallbackProjects();
      }
    } catch {
      // Offline or static mode
      this.setupFallbackProjects();
    }

    this.updateProjectCounts();
    this.renderProjectsGrid();
  }

  setupFallbackProjects() {
    this.availableProjects = [
      SAMPLE_TOWNHOUSE_4F,
      SAMPLE_VILLA_GARDEN_3F,
      { id: SAMPLE_VILLA.id || 'proj_sample_villa_3f', ...SAMPLE_VILLA }
    ];
  }

  updateProjectCounts() {
    const count = this.availableProjects.length;
    const headerCount = document.getElementById('header-projects-count');
    if (headerCount) headerCount.textContent = count;
    const modalCount = document.getElementById('modal-projects-count');
    if (modalCount) modalCount.textContent = `${count} dự án`;
  }

  renderProjectsGrid() {
    const container = document.getElementById('projects-grid-container');
    if (!container) return;
    container.innerHTML = '';

    for (const proj of this.availableProjects) {
      const card = document.createElement('div');
      const isCurrent = (proj.id === this.activeProjectId) || 
        (!this.activeProjectId && proj.title === this.currentBim?.metadata?.title);
      card.className = `project-card-item ${isCurrent ? 'active-project' : ''}`;

      const floorCount = proj.floors ? proj.floors.length : (proj.floorsCount || 1);
      const width = proj.lot_width || 10;
      const length = proj.lot_length || 15;
      const lotArea = proj.lot_area || (width * length);
      const floorArea = proj.total_floor_area || (lotArea * floorCount * 0.85);

      card.innerHTML = `
        <div class="project-card-top">
          <div>
            <h4 class="project-card-title">${proj.title}</h4>
            <div class="project-card-code">${proj.code || 'NN-BIM'} • ${proj.subtitle || 'Hồ sơ thiết kế kiến trúc'}</div>
          </div>
          ${isCurrent ? '<span class="active-pill-badge">Đang xem</span>' : ''}
        </div>

        <div class="project-card-meta-grid">
          <div class="project-meta-row">
            <span class="project-meta-lbl">Kích thước đất</span>
            <span class="project-meta-val">${width} × ${length} m</span>
          </div>
          <div class="project-meta-row">
            <span class="project-meta-lbl">Quy mô</span>
            <span class="project-meta-val">${floorCount} tầng</span>
          </div>
          <div class="project-meta-row">
            <span class="project-meta-lbl">Diện tích khu đất</span>
            <span class="project-meta-val">${lotArea} m²</span>
          </div>
          <div class="project-meta-row">
            <span class="project-meta-lbl">Tổng diện tích sàn</span>
            <span class="project-meta-val">${Math.round(floorArea)} m²</span>
          </div>
        </div>

        <div class="project-card-actions">
          <button class="btn-open-project ${isCurrent ? 'current' : ''}" data-project-id="${proj.id}">
            ${isCurrent ? '✓ Đang xem' : 'Mở dự án 3D'}
          </button>
        </div>
      `;

      const openBtn = card.querySelector('.btn-open-project');
      if (openBtn && !isCurrent) {
        openBtn.addEventListener('click', () => {
          this.switchProject(proj.id);
        });
      }

      container.appendChild(card);
    }
  }

  async switchProject(projectId) {
    let proj = this.availableProjects.find(p => p.id === projectId);
    if (!proj) return;

    // If project is only summary, fetch full document from API
    if (!proj.floors || (proj.floors.length > 0 && !proj.floors[0].entities && !proj.floors[0].slabs)) {
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (res.ok) {
          const json = await res.json();
          proj = json.data || json;
        }
      } catch (err) {
        console.warn('Could not fetch full project document from server:', err);
      }
    }

    this.activeProjectId = projectId;
    this.loadModelData(proj);
    this.closeProjectsModal();
    this.renderProjectsGrid();
  }

  openProjectsModal() {
    this.renderProjectsGrid();
    const modal = document.getElementById('modal-projects-list');
    if (modal) modal.classList.remove('hidden');
  }

  closeProjectsModal() {
    const modal = document.getElementById('modal-projects-list');
    if (modal) modal.classList.add('hidden');
  }

  // ================= NEW PROJECT CREATION =================

  openNewProjectModal() {
    const modal = document.getElementById('modal-new-project');
    if (modal) {
      modal.classList.remove('hidden');
      this.initNewProjectFloorRows();
    }
  }

  closeNewProjectModal() {
    const modal = document.getElementById('modal-new-project');
    if (modal) modal.classList.add('hidden');
  }

  initNewProjectFloorRows() {
    const container = document.getElementById('floor-rows-container');
    if (!container) return;
    container.innerHTML = '';

    const initialFloors = [
      { name: 'Tầng 1', height: 3.8 },
      { name: 'Tầng 2', height: 3.4 },
      { name: 'Tầng 3', height: 3.4 },
      { name: 'Tầng 4', height: 3.2 }
    ];

    initialFloors.forEach((f, idx) => {
      this.addFloorUploadRow(f.name, f.height, idx + 1);
    });
  }

  addFloorUploadRow(name = 'Tầng mới', height = 3.6, index = 1) {
    const container = document.getElementById('floor-rows-container');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'floor-upload-row';
    const rowId = `floor_row_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    row.innerHTML = `
      <input type="text" class="form-input floor-name-input" value="${name}" placeholder="Tên tầng">
      <input type="number" class="form-input floor-height-input" value="${height}" step="0.1" placeholder="Cao (m)">
      <label class="floor-file-label" id="label_${rowId}" title="Nhấp để tải ảnh 2D (.png/.jpg/.webp) hoặc CAD (.dxf)">
        <span>📁 Chọn bản vẽ 2D / CAD</span>
        <input type="file" class="floor-file-input" accept=".png,.jpg,.jpeg,.webp,.dxf" style="display: none;">
      </label>
      <button type="button" class="btn-remove-floor" title="Xóa tầng">✕</button>
    `;

    const fileInput = row.querySelector('.floor-file-input');
    const fileLabel = row.querySelector('.floor-file-label');
    const removeBtn = row.querySelector('.btn-remove-floor');

    fileLabel.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        fileLabel.classList.add('has-file');
        fileLabel.querySelector('span').textContent = `✓ ${file.name.substring(0, 18)}`;
      }
    });

    removeBtn.addEventListener('click', () => {
      if (container.children.length > 1) {
        row.remove();
      } else {
        alert('Dự án phải có ít nhất 1 tầng.');
      }
    });

    container.appendChild(row);
  }

  async handleNewProjectSubmit(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('btn-submit-new-project');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>⏳ Đang phân tích AI & dựng hình 3D...</span>';
    submitBtn.disabled = true;

    try {
      const title = document.getElementById('new-proj-title').value.trim();
      const code = document.getElementById('new-proj-code').value.trim() || `NN-${Date.now().toString().slice(-4)}`;
      const width = parseFloat(document.getElementById('new-proj-width').value) || 6.0;
      const length = parseFloat(document.getElementById('new-proj-length').value) || 12.0;
      const lotArea = width * length;

      const floorRows = document.querySelectorAll('.floor-upload-row');
      const floors = [];
      let currentElev = 0.0;

      for (let i = 0; i < floorRows.length; i++) {
        const row = floorRows[i];
        const flName = row.querySelector('.floor-name-input').value.trim() || `Tầng ${i + 1}`;
        const flHeight = parseFloat(row.querySelector('.floor-height-input').value) || 3.6;
        const fileInput = row.querySelector('.floor-file-input');
        const file = fileInput.files ? fileInput.files[0] : null;

        let fileData = null;
        let fileType = null;
        let mimeType = 'image/png';
        if (file) {
          fileType = file.name.toLowerCase().endsWith('.dxf') ? 'dxf' : 'image';
          mimeType = file.type || (fileType === 'dxf' ? 'text/plain' : 'image/png');
          fileData = await this.readFileAsData(file, fileType);
        }

        // Generate baseline CAD entities so backend validation and 3D engine succeed
        const baselineEntities = [
          {
            type: 'LWPOLYLINE',
            layer: 'A-WALL-EXTR',
            points: [
              { x: 0, y: 0 },
              { x: width, y: 0 },
              { x: width, y: length },
              { x: 0, y: length },
              { x: 0, y: 0 }
            ]
          },
          {
            type: 'TEXT',
            layer: 'A-ANNO',
            text: `KHÔNG GIAN ${flName.toUpperCase()} (${(width * length * 0.85).toFixed(1)} m²)`,
            points: [{ x: width / 2, y: length / 2 }]
          }
        ];

        floors.push({
          id: `floor_${i + 1}`,
          name: flName,
          desc: `Mặt bằng thiết kế ${flName}`,
          elevation: currentElev,
          height: flHeight,
          entities: baselineEntities,
          fileData,
          fileType,
          mimeType
        });

        currentElev += flHeight;
      }

      const totalFloorArea = lotArea * floors.length * 0.85;

      // Construct project payload
      const projectPayload = {
        id: `proj_${Date.now()}`,
        title,
        code,
        subtitle: 'HỒ SƠ THIẾT KẾ THI CÔNG KIẾN TRÚC MỚI',
        lot_width: width,
        lot_length: length,
        lot_area: lotArea,
        total_floor_area: Math.round(totalFloorArea),
        floors
      };

      // Attempt POST to REST API
      let createdProject = null;
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(projectPayload)
        });
        if (res.ok) {
          const resJson = await res.json();
          createdProject = resJson.data || resJson;
        }
      } catch (err) {
        console.warn('Backend /api/projects unreachable, saving client-side:', err);
      }

      // If server responded and any floor has uploaded image/dxf, trigger AI analysis
      if (createdProject && createdProject.id) {
        for (const fl of floors) {
          if (fl.fileData) {
            try {
              const analyzePayload = {
                floorId: fl.id,
                ...(fl.fileType === 'dxf' ? { dxfContent: fl.fileData } : { imageBase64: fl.fileData, mimeType: fl.mimeType })
              };
              await fetch(`/api/projects/${createdProject.id}/analyze-floor`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(analyzePayload)
              });
            } catch (err) {
              console.warn(`Analysis for ${fl.id} skipped:`, err);
            }
          }
        }
        // Fetch updated project with AI analysis
        try {
          const updatedRes = await fetch(`/api/projects/${createdProject.id}`);
          if (updatedRes.ok) {
            const upData = await updatedRes.json();
            createdProject = upData.data || upData;
          }
        } catch {}
      }

      const finalProject = createdProject || projectPayload;
      this.availableProjects.unshift(finalProject);
      this.updateProjectCounts();
      this.activeProjectId = finalProject.id;
      this.loadModelData(finalProject);

      this.closeNewProjectModal();
      alert(`Đã khởi tạo thành công dự án: "${title}" với ${floors.length} tầng!`);
    } catch (err) {
      console.error('Error creating project:', err);
      alert('Có lỗi khi tạo dự án: ' + err.message);
    } finally {
      submitBtn.innerHTML = originalText;
      submitBtn.disabled = false;
    }
  }

  readFileAsData(file, type) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      if (type === 'dxf') {
        reader.readAsText(file);
      } else {
        reader.readAsDataURL(file);
      }
    });
  }

  // ================= CAD MODEL & BIM PIPELINE =================

  loadModelData(cadInput) {
    try {
      this.currentBim = this.pipeline.process(cadInput);
      this.activeFloorId = this.currentBim.floors[0] ? this.currentBim.floors[0].id : 'floor_1';

      // Reset floor visibilities
      this.floorVisibility.clear();
      for (const f of this.currentBim.floors) {
        this.floorVisibility.set(f.id, true);
      }

      // Update UI components
      this.renderProjectHeader();
      this.renderSidebarStats();
      this.renderFloorList();
      this.renderFurnitureDropdown();
      this.renderFloorplanSvg();

      // Load into 3D viewer
      this.viewer.loadBimScene(this.currentBim);
      this.viewer.setRenderingStage(this.currentStage);
    } catch (err) {
      console.error('Failed to load CAD model:', err);
      alert('Không thể xử lý dữ liệu kiến trúc: ' + err.message);
    }
  }

  // ================= UI EVENT LISTENERS =================

  setupUIEventListeners() {
    // 1. Projects List Modal & Switcher
    const btnProjectsList = document.getElementById('btn-projects-list');
    if (btnProjectsList) {
      btnProjectsList.addEventListener('click', () => this.openProjectsModal());
    }

    const btnProjectsClose = document.getElementById('modal-projects-close-btn');
    if (btnProjectsClose) {
      btnProjectsClose.addEventListener('click', () => this.closeProjectsModal());
    }

    // 2. New Project Modal
    const btnNewProject = document.getElementById('btn-new-project');
    if (btnNewProject) {
      btnNewProject.addEventListener('click', () => this.openNewProjectModal());
    }

    const btnShortcutNewProject = document.getElementById('btn-shortcut-new-project');
    if (btnShortcutNewProject) {
      btnShortcutNewProject.addEventListener('click', () => {
        this.closeProjectsModal();
        this.openNewProjectModal();
      });
    }

    const btnNewProjectClose = document.getElementById('modal-new-project-close-btn');
    if (btnNewProjectClose) {
      btnNewProjectClose.addEventListener('click', () => this.closeNewProjectModal());
    }

    const btnCancelNewProject = document.getElementById('btn-cancel-new-project');
    if (btnCancelNewProject) {
      btnCancelNewProject.addEventListener('click', () => this.closeNewProjectModal());
    }

    const formNewProject = document.getElementById('form-new-project');
    if (formNewProject) {
      formNewProject.addEventListener('submit', (e) => this.handleNewProjectSubmit(e));
    }

    const btnAddFloorRow = document.getElementById('btn-add-floor-row');
    if (btnAddFloorRow) {
      btnAddFloorRow.addEventListener('click', () => {
        const count = document.querySelectorAll('.floor-upload-row').length;
        this.addFloorUploadRow(`Tầng ${count + 1}`, 3.4, count + 1);
      });
    }

    // Presets in New Project Modal
    const presetBtns = document.querySelectorAll('[data-preset]');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        presetBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const pType = btn.getAttribute('data-preset');
        if (pType === 'townhouse_4f') {
          document.getElementById('new-proj-title').value = 'Nhà phố 4 Tầng Hiện Đại (5 × 8 m)';
          document.getElementById('new-proj-code').value = 'NN-2026-NP04';
          document.getElementById('new-proj-width').value = '5.0';
          document.getElementById('new-proj-length').value = '8.0';
        } else if (pType === 'villa_garden_3f') {
          document.getElementById('new-proj-title').value = 'Biệt thự Sân vườn 3 Tầng (12 × 16 m)';
          document.getElementById('new-proj-code').value = 'NN-2026-BTV03';
          document.getElementById('new-proj-width').value = '12.0';
          document.getElementById('new-proj-length').value = '16.0';
        } else if (pType === 'villa_luxury_3f') {
          document.getElementById('new-proj-title').value = 'Biệt thự Hiện Đại 2 Tầng 1 Tum (15 × 24 m)';
          document.getElementById('new-proj-code').value = 'NN-2026-BT08';
          document.getElementById('new-proj-width').value = '15.0';
          document.getElementById('new-proj-length').value = '24.0';
        }
      });
    });

    // 3. 5-Stage Progressive Rendering Toolbar
    const stageButtons = document.querySelectorAll('[data-stage]');
    stageButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        stageButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const stage = parseInt(btn.getAttribute('data-stage'), 10);
        this.currentStage = stage;
        this.viewer.setRenderingStage(stage);
        this.renderFloorplanSvg();
      });
    });

    // 4. View Modes & Exploded Separation Slider
    const modeButtons = document.querySelectorAll('[data-view-mode]');
    const explodedCard = document.getElementById('exploded-slider-card');
    const explodedSlider = document.getElementById('exploded-distance-slider');
    const explodedValText = document.getElementById('exploded-distance-val');

    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        modeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.getAttribute('data-view-mode');
        this.viewer.setViewMode(mode);

        if (mode === 'exploded') {
          if (explodedCard) explodedCard.classList.remove('hidden');
        } else {
          if (explodedCard) explodedCard.classList.add('hidden');
        }
      });
    });

    if (explodedSlider && explodedValText) {
      explodedSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        explodedValText.textContent = `${val.toFixed(1)} m`;
        this.viewer.setExplodedDistance(val);
      });
    }

    // 5. Interior Warm Lighting Toggle
    const lightToggle = document.getElementById('toggle-interior-lights');
    if (lightToggle) {
      lightToggle.addEventListener('click', () => {
        const isActive = lightToggle.classList.toggle('active');
        lightToggle.querySelector('.label').textContent = isActive ? 'Đèn nhà: BẬT' : 'Đèn nhà: TẮT';
        this.viewer.setInteriorLights(isActive);
      });
    }

    // 6. Room Labels Toggle
    const labelsToggle = document.getElementById('toggle-room-labels');
    if (labelsToggle) {
      labelsToggle.addEventListener('click', () => {
        const isActive = labelsToggle.classList.toggle('active');
        labelsToggle.querySelector('.label').textContent = isActive ? 'Nhãn phòng: BẬT' : 'Nhãn phòng: TẮT';
        this.viewer.setRoomLabelsVisible(isActive);
      });
    }

    // 7. Furniture Dropdown & Highlighting
    const furnSelect = document.getElementById('furniture-select');
    if (furnSelect) {
      furnSelect.addEventListener('change', (e) => {
        const itemName = e.target.value;
        if (!itemName) return;
        const targetMesh = this.viewer.selectableObjects.find(
          m => m.userData && m.userData.name === itemName
        );
        if (targetMesh) {
          this.viewer.selectObject(targetMesh);
        }
      });
    }

    // 8. Floorplan thumbnail click -> Open 2D modal
    const floorplanCard = document.getElementById('floorplan-card');
    if (floorplanCard) {
      floorplanCard.addEventListener('click', () => this.openFloorplanModal());
    }

    const modalClose = document.getElementById('modal-close-btn');
    if (modalClose) {
      modalClose.addEventListener('click', () => this.closeFloorplanModal());
    }

    // 9. Close Inspector Card
    const inspectorClose = document.getElementById('inspector-close-btn');
    if (inspectorClose) {
      inspectorClose.addEventListener('click', () => {
        document.getElementById('object-inspector-card').classList.add('hidden');
        if (this.viewer.selectedObjectMesh) {
          this.viewer.disposeSceneGroup(this.viewer.selectedObjectMesh);
          this.viewer.scene.remove(this.viewer.selectedObjectMesh);
          this.viewer.selectedObjectMesh = null;
        }
        const furnSelect = document.getElementById('furniture-select');
        if (furnSelect) furnSelect.value = '';
      });
    }

    // 10. Fullscreen toggle
    const fullscreenBtn = document.getElementById('btn-fullscreen');
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        this.toggleBrowserFullscreen();
      });
    }

    // 11. Presentation Viewer Mode Controls
    const btnPresentationMode = document.getElementById('btn-presentation-mode');
    if (btnPresentationMode) {
      btnPresentationMode.addEventListener('click', () => {
        this.enterPresentationMode();
      });
    }

    const btnExitPresentation = document.getElementById('btn-return-studio') || document.getElementById('btn-exit-presentation');
    if (btnExitPresentation) {
      btnExitPresentation.addEventListener('click', () => {
        this.exitPresentationMode();
      });
    }

    const btnPresentationFs = document.getElementById('btn-presentation-fullscreen');
    if (btnPresentationFs) {
      btnPresentationFs.addEventListener('click', () => {
        this.toggleBrowserFullscreen();
      });
    }
  }

  enterPresentationMode() {
    this.isPresentationMode = true;
    document.body.classList.add('presentation-mode');
    document.body.classList.add('mode-viewer');

    const toolbar = document.getElementById('presentation-toolbar');
    if (toolbar) toolbar.classList.remove('hidden');

    // Close chat panel if open
    if (this.aiChat) {
      this.aiChat.closePanel();
    }

    // Resize viewport smoothly
    setTimeout(() => {
      if (this.viewer) this.viewer.onWindowResize();
    }, 100);
  }

  exitPresentationMode() {
    this.isPresentationMode = false;
    document.body.classList.remove('presentation-mode');
    document.body.classList.remove('mode-viewer');

    const toolbar = document.getElementById('presentation-toolbar');
    if (toolbar) toolbar.classList.add('hidden');

    // Resize viewport smoothly
    setTimeout(() => {
      if (this.viewer) this.viewer.onWindowResize();
    }, 100);
  }

  toggleBrowserFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }

  setupCadFileHandling() {
    const fileInput = document.getElementById('cad-file-input');
    const uploadBtn = document.getElementById('btn-upload-cad');

    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.readCadFile(file);
      });
    }

    // Drag and drop onto entire page
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith('.dxf')) {
          this.readCadFile(file);
        } else {
          alert('Vui lòng kéo thả file CAD định dạng .dxf');
        }
      }
    });
  }

  readCadFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dxfContent = e.target.result;
      this.loadModelData(dxfContent);
    };
    reader.readAsText(file);
  }

  // ================= UI RENDERING =================

  renderProjectHeader() {
    const m = this.currentBim.metadata;
    document.getElementById('project-title').textContent = m.title;
    document.getElementById('project-subtitle').textContent = m.subtitle;
    document.getElementById('project-code-badge').textContent = m.code;
  }

  renderSidebarStats() {
    const m = this.currentBim.metadata;
    document.getElementById('stat-dimensions').textContent = `${m.lot_width} × ${m.lot_length} m`;
    document.getElementById('stat-land-area').textContent = `${m.lot_area} m²`;
    document.getElementById('stat-floor-area').textContent = `${m.total_floor_area} m²`;
  }

  renderFloorList() {
    const container = document.getElementById('floor-list-container');
    container.innerHTML = '';

    for (const floor of this.currentBim.floors) {
      const card = document.createElement('div');
      card.className = `floor-card ${floor.id === this.activeFloorId ? 'active' : ''}`;
      card.setAttribute('data-floor-id', floor.id);

      card.innerHTML = `
        <div class="floor-indicator"></div>
        <div class="floor-info">
          <div class="floor-name">${floor.name}</div>
          <div class="floor-desc">${floor.desc}</div>
        </div>
        <button class="floor-eye-btn ${this.floorVisibility.get(floor.id) ? 'visible' : 'hidden'}" title="Ẩn/Hiện tầng">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      `;

      // Select floor on card click
      card.addEventListener('click', (e) => {
        if (e.target.closest('.floor-eye-btn')) return;
        this.selectFloor(floor.id);
      });

      // Toggle floor visibility
      const eyeBtn = card.querySelector('.floor-eye-btn');
      eyeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentVis = this.floorVisibility.get(floor.id);
        const newVis = !currentVis;
        this.floorVisibility.set(floor.id, newVis);
        eyeBtn.classList.toggle('visible', newVis);
        eyeBtn.classList.toggle('hidden', !newVis);
        this.viewer.setFloorVisibility(floor.id, newVis);
      });

      container.appendChild(card);
    }
  }

  /**
   * Smart Floor Control:
   * Clicking a floor hides all floors above it, updates bottom-left 2D thumbnail, and animates camera.
   */
  selectFloor(floorId) {
    this.syncFloorIsolationUI(floorId);
    this.viewer.focusFloor(floorId);
  }

  /**
   * Synchronize sidebar floor list, eye buttons, and bottom-left 2D SVG when a floor is isolated
   */
  syncFloorIsolationUI(floorId) {
    if (!this.currentBim || !this.currentBim.floors) return;
    this.activeFloorId = floorId;
    const activeIdx = this.currentBim.floors.findIndex(f => f.id === floorId);

    if (activeIdx !== -1) {
      this.currentBim.floors.forEach((floor, idx) => {
        // Hide all floors above active floor (idx > activeIdx)
        const isVisible = idx <= activeIdx;
        this.floorVisibility.set(floor.id, isVisible);
        this.viewer.setFloorVisibility(floor.id, isVisible);

        const card = document.querySelector(`.floor-card[data-floor-id="${floor.id}"]`);
        if (card) {
          card.classList.toggle('active', floor.id === floorId);
          const eyeBtn = card.querySelector('.floor-eye-btn');
          if (eyeBtn) {
            eyeBtn.classList.toggle('visible', isVisible);
            eyeBtn.classList.toggle('hidden', !isVisible);
          }
        }
      });
    }

    this.renderFloorplanSvg();
  }

  renderFurnitureDropdown() {
    const select = document.getElementById('furniture-select');
    select.innerHTML = '<option value="">-- Chọn vật thể để định vị... --</option>';

    // Group items by floor
    for (const floor of this.currentBim.floors) {
      const items = [...(floor.furniture || []), ...(floor.sanitary || [])];
      if (items.length === 0) continue;

      const optGroup = document.createElement('optgroup');
      optGroup.label = floor.name;

      for (const item of items) {
        const opt = document.createElement('option');
        opt.value = item.name;
        const roomLabel = item.room ? ` • ${item.room}` : '';
        opt.textContent = `${item.name}${roomLabel}`;
        optGroup.appendChild(opt);
      }
      select.appendChild(optGroup);
    }
  }

  renderFloorplanSvg() {
    const activeFloor = this.currentBim.floors.find(f => f.id === this.activeFloorId) || this.currentBim.floors[0];
    if (!activeFloor) return;

    const titleEl = document.getElementById('floorplan-title');
    if (titleEl) {
      titleEl.textContent = `MẶT BẰNG ${activeFloor.name.toUpperCase()}${this.currentStage === 1 ? ' [AI DETECTION]' : ''}`;
    }

    const svgMarkup = FloorplanSvgGenerator.generate(activeFloor, {
      width: 300,
      height: 260,
      showAiDetection: this.currentStage === 1,
      stage: this.currentStage
    });

    const previewContainer = document.getElementById('floorplan-svg-preview');
    if (previewContainer) previewContainer.innerHTML = svgMarkup;
  }

  openFloorplanModal() {
    const activeFloor = this.currentBim.floors.find(f => f.id === this.activeFloorId) || this.currentBim.floors[0];
    if (!activeFloor) return;

    const modal = document.getElementById('floorplan-modal');
    document.getElementById('modal-floor-title').textContent = `BẢN VẼ KỸ THUẬT CAD: ${activeFloor.name.toUpperCase()}`;
    const modalSvg = FloorplanSvgGenerator.generate(activeFloor, {
      width: 900,
      height: 700,
      showAiDetection: this.currentStage === 1,
      stage: this.currentStage
    });
    document.getElementById('modal-svg-container').innerHTML = modalSvg;
    modal.classList.remove('hidden');
  }

  closeFloorplanModal() {
    document.getElementById('floorplan-modal').classList.add('hidden');
  }

  showObjectInspector(objData) {
    const card = document.getElementById('object-inspector-card');
    if (!card) return;

    // Ensure Room row exists in inspector card
    let roomValEl = document.getElementById('inspector-room');
    if (!roomValEl) {
      const floorValEl = document.getElementById('inspector-floor');
      if (floorValEl && floorValEl.parentElement) {
        const roomRow = document.createElement('div');
        roomRow.className = 'inspector-row';
        roomRow.innerHTML = `
          <span class="inspector-label">Phòng / Khu vực:</span>
          <span class="inspector-val" id="inspector-room">Không gian chung</span>
        `;
        floorValEl.parentElement.insertAdjacentElement('afterend', roomRow);
        roomValEl = document.getElementById('inspector-room');
      }
    }

    document.getElementById('inspector-title').textContent = objData.name || 'Chi tiết cấu kiện';
    document.getElementById('inspector-layer').textContent = objData.layer || 'A-FURN';
    document.getElementById('inspector-dimensions').textContent = objData.dimensions || 'N/A';
    document.getElementById('inspector-material').textContent = objData.material || 'Vật liệu PBR';
    document.getElementById('inspector-floor').textContent = objData.floorName || 'Tầng 1';
    if (roomValEl) {
      roomValEl.textContent = objData.room || objData.floorName || 'Không gian chung';
    }

    const furnSelect = document.getElementById('furniture-select');
    if (furnSelect && objData.name) {
      furnSelect.value = objData.name;
    }

    card.classList.remove('hidden');
  }
}

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new ArchitecturalViewerApp();
});
