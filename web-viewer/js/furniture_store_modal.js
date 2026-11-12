/**
 * furniture_store_modal.js
 * OpenCADStudio_Z / Nếp Nhà - Plug-and-Play Furniture Store Modal
 * Displays 35+ pre-baked modular glTF 2.0 (.glb) furniture items categorized by room,
 * supports real-time search, category filtering, placement badges, and uploading
 * custom .glb models with automated parameter binding.
 */

export class FurnitureStoreModal {
  constructor(options = {}) {
    this.viewer = options.viewer || null;
    this.onAssetAdded = options.onAssetAdded || null;

    this.assets = [];
    this.filteredAssets = [];
    this.activeCategory = 'all';
    this.searchQuery = '';
    this.placementFilter = 'all';

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.loadAssets();
  }

  bindEvents() {
    const openBtn = document.getElementById('btn-furniture-store');
    const closeBtn = document.getElementById('modal-furniture-close-btn');
    const searchInput = document.getElementById('furniture-store-search');
    const placementSelect = document.getElementById('furniture-store-placement-filter');
    const openAddBtn = document.getElementById('btn-open-add-furniture');
    const closeAddBtn = document.getElementById('modal-add-furniture-close-btn');
    const cancelAddBtn = document.getElementById('btn-cancel-add-furniture');
    const formAdd = document.getElementById('form-add-furniture');

    if (openBtn) {
      openBtn.addEventListener('click', () => this.open());
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    // Category Tabs
    const categoryTabs = document.querySelectorAll('.store-tab-btn');
    categoryTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        categoryTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeCategory = tab.getAttribute('data-category') || 'all';
        this.applyFilters();
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase().trim();
        this.applyFilters();
      });
    }

    if (placementSelect) {
      placementSelect.addEventListener('change', (e) => {
        this.placementFilter = e.target.value;
        this.applyFilters();
      });
    }

    // Custom Asset Upload Modal Events
    if (openAddBtn) {
      openAddBtn.addEventListener('click', () => this.openAddModal());
    }

    if (closeAddBtn) {
      closeAddBtn.addEventListener('click', () => this.closeAddModal());
    }

    if (cancelAddBtn) {
      cancelAddBtn.addEventListener('click', () => this.closeAddModal());
    }

    if (formAdd) {
      formAdd.addEventListener('submit', (e) => this.handleAddFurnitureSubmit(e));
    }

    // Auto slugify asset_id when name changes
    const addNameInput = document.getElementById('add-furniture-name');
    const addIdInput = document.getElementById('add-furniture-id');
    if (addNameInput && addIdInput) {
      addNameInput.addEventListener('input', () => {
        if (!addIdInput.dataset.manual) {
          addIdInput.value = this.slugify(addNameInput.value);
        }
      });
      addIdInput.addEventListener('input', () => {
        addIdInput.dataset.manual = 'true';
      });
    }

    // Custom .glb file input feedback
    const fileInput = document.getElementById('add-furniture-file');
    const fileLabel = document.getElementById('add-furniture-file-label');
    if (fileInput && fileLabel) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          fileLabel.classList.add('has-file');
          fileLabel.innerHTML = `<span>✓ Đã chọn: <strong>${file.name}</strong> (${(file.size / 1024).toFixed(1)} KB)</span>`;
          if (!addNameInput.value) {
            const rawName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
            addNameInput.value = rawName;
            if (!addIdInput.dataset.manual) {
              addIdInput.value = this.slugify(rawName);
            }
          }
        }
      });
    }
  }

  slugify(text) {
    return text
      .toString()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  open() {
    const modal = document.getElementById('modal-furniture-store');
    if (modal) {
      modal.classList.remove('hidden');
      this.applyFilters();
    }
  }

  close() {
    const modal = document.getElementById('modal-furniture-store');
    if (modal) modal.classList.add('hidden');
  }

  openAddModal() {
    const addModal = document.getElementById('modal-add-furniture');
    if (addModal) {
      addModal.classList.remove('hidden');
    }
  }

  closeAddModal() {
    const addModal = document.getElementById('modal-add-furniture');
    if (addModal) addModal.classList.add('hidden');
    const form = document.getElementById('form-add-furniture');
    if (form) form.reset();
    const fileLabel = document.getElementById('add-furniture-file-label');
    if (fileLabel) {
      fileLabel.classList.remove('has-file');
      fileLabel.innerHTML = '<span>📁 Nhấp để chọn file hoặc kéo thả file .glb vào đây</span>';
    }
    const addIdInput = document.getElementById('add-furniture-id');
    if (addIdInput) delete addIdInput.dataset.manual;
  }

  async loadAssets() {
    try {
      const res = await fetch('/api/furniture-assets');
      if (res.ok) {
        const json = await res.json();
        const list = Array.isArray(json) ? json : (json.data || []);
        if (Array.isArray(list) && list.length > 0) {
          this.assets = list.map(item => this.normalizeAsset(item));
          this.applyFilters();
          return;
        }
      }
    } catch {
      // Fallback to static catalog if backend route not ready
    }

    // Fallback: Fetch from public/assets/models/asset_catalog.json
    try {
      const resCat = await fetch('/assets/models/asset_catalog.json');
      if (resCat.ok) {
        const catalog = await resCat.json();
        this.assets = (catalog.assets || []).map(item => this.normalizeAsset(item));
      }
    } catch (err) {
      console.warn('Could not load fallback asset_catalog.json:', err);
    }

    this.applyFilters();
  }

  normalizeAsset(item) {
    const dims = item.dimensions || {};
    const w = dims.width || dims.nativeWidth || 1.0;
    const d = dims.depth || dims.nativeDepth || 1.0;
    const h = dims.height || dims.nativeHeight || 1.0;

    // Map category
    let cat = item.category || 'living';
    if (cat === 'living_room') cat = 'living';
    if (cat === 'kitchen_dining') cat = 'kitchen';
    if (cat === 'worship_altar') cat = 'worship';
    if (cat === 'bathroom_laundry') cat = 'bathroom';
    if (cat === 'balcony_outdoor' || cat === 'architectural') cat = 'balcony';

    // Infer placement rule if missing
    let placement = item.placement_type || 'floor_wall_backed';
    const id = (item.asset_id || item.id || '').toLowerCase();
    if (id.includes('dining_table') || id.includes('coffee_table') || id.includes('island') || id.includes('rug')) {
      placement = 'floor_center';
    } else if (id.includes('mirror') || id.includes('wall_unit') || id.includes('light_wall')) {
      placement = 'wall_mounted';
    } else if (id.includes('ceiling') || id.includes('chandelier') || id.includes('pendant')) {
      placement = 'ceiling';
    }

    return {
      id: item.id || item.asset_id,
      asset_id: item.asset_id || item.id,
      name: item.name || 'Mẫu nội thất',
      category: cat,
      placement_type: placement,
      dimensions: {
        width: Number(w.toFixed(2)),
        depth: Number(d.toFixed(2)),
        height: Number(h.toFixed(2))
      },
      tags: Array.isArray(item.tags) ? item.tags : (typeof item.tags === 'string' ? item.tags.split(',').map(t => t.trim()) : [cat]),
      glb_path: item.glb_path || item.url || `/assets/models/${item.file || (item.asset_id + '.glb')}`,
      is_builtin: item.is_builtin !== false && !item.is_custom,
      byteLength: item.byteLength || 0
    };
  }

  applyFilters() {
    this.filteredAssets = this.assets.filter(asset => {
      // 1. Category Filter
      if (this.activeCategory !== 'all') {
        if (this.activeCategory === 'balcony') {
          if (asset.category !== 'balcony' && asset.category !== 'outdoor' && asset.category !== 'architectural') {
            return false;
          }
        } else if (asset.category !== this.activeCategory) {
          return false;
        }
      }

      // 2. Placement Type Filter
      if (this.placementFilter !== 'all' && asset.placement_type !== this.placementFilter) {
        return false;
      }

      // 3. Search Query Filter
      if (this.searchQuery) {
        const matchName = asset.name.toLowerCase().includes(this.searchQuery);
        const matchId = asset.asset_id.toLowerCase().includes(this.searchQuery);
        const matchTag = asset.tags.some(t => t.toLowerCase().includes(this.searchQuery));
        if (!matchName && !matchId && !matchTag) return false;
      }

      return true;
    });

    this.renderGrid();
  }

  renderGrid() {
    const grid = document.getElementById('furniture-store-grid');
    const countBadge = document.getElementById('furniture-store-count');
    if (!grid) return;

    if (countBadge) {
      countBadge.textContent = `${this.filteredAssets.length} / ${this.assets.length} mẫu`;
    }

    grid.innerHTML = '';

    if (this.filteredAssets.length === 0) {
      grid.innerHTML = `
        <div class="store-empty-state">
          <div class="empty-icon">🔍</div>
          <h4>Không tìm thấy mẫu nội thất phù hợp</h4>
          <p>Hãy thử từ khóa khác hoặc bấm "+ Thêm Mẫu Mới (.glb)" để tải lên mô hình của bạn.</p>
        </div>
      `;
      return;
    }

    for (const asset of this.filteredAssets) {
      const card = document.createElement('div');
      card.className = 'furniture-item-card';

      const placementLabel = this.getPlacementLabel(asset.placement_type);
      const dims = `${asset.dimensions.width} × ${asset.dimensions.depth} × ${asset.dimensions.height} m`;
      const categoryIcon = this.getCategoryIcon(asset.category);

      card.innerHTML = `
        <div class="furniture-card-visual">
          <div class="visual-3d-placeholder">
            <span class="visual-icon">${categoryIcon}</span>
            <span class="visual-view-badge">glTF 2.0</span>
          </div>
          <span class="placement-badge ${asset.placement_type}">
            ${placementLabel.icon} ${placementLabel.text}
          </span>
          ${asset.is_builtin ? '<span class="source-badge builtin">Mẫu chuẩn</span>' : '<span class="source-badge custom">Tùy chỉnh</span>'}
        </div>

        <div class="furniture-card-body">
          <h4 class="furniture-item-name" title="${asset.name}">${asset.name}</h4>
          <div class="furniture-item-code">${asset.asset_id}</div>

          <div class="furniture-meta-row">
            <span class="furniture-meta-lbl">Kích thước:</span>
            <span class="furniture-meta-val">${dims}</span>
          </div>

          <div class="furniture-tags-row">
            ${asset.tags.map(t => `<span class="furniture-tag-pill">#${t}</span>`).join('')}
          </div>
        </div>

        <div class="furniture-card-footer">
          <button class="btn-inspect-model" data-asset-id="${asset.asset_id}" title="Xem mô hình 3D">
            👁️ Xem 3D
          </button>
          <button class="btn-copy-asset-id" data-asset-id="${asset.asset_id}" title="Sao chép mã để chat với AI">
            📋 Sao chép mã
          </button>
        </div>
      `;

      // Copy asset_id button
      const copyBtn = card.querySelector('.btn-copy-asset-id');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(asset.asset_id);
          copyBtn.textContent = '✓ Đã chép!';
          setTimeout(() => { copyBtn.textContent = '📋 Sao chép mã'; }, 1500);
        });
      }

      // Inspect model button
      const inspectBtn = card.querySelector('.btn-inspect-model');
      if (inspectBtn) {
        inspectBtn.addEventListener('click', () => {
          this.previewModelInViewer(asset);
        });
      }

      grid.appendChild(card);
    }
  }

  getPlacementLabel(type) {
    switch (type) {
      case 'floor_wall_backed':
        return { text: 'Tựa tường', icon: '🧱' };
      case 'floor_center':
        return { text: 'Giữa sàn / Tự do', icon: '📍' };
      case 'wall_mounted':
        return { text: 'Treo tường', icon: '📌' };
      case 'ceiling':
        return { text: 'Gắn trần', icon: '💡' };
      default:
        return { text: 'Sàn nhà', icon: '📐' };
    }
  }

  getCategoryIcon(cat) {
    switch (cat) {
      case 'living': return '🛋️';
      case 'kitchen': return '🍳';
      case 'bedroom': return '🛏️';
      case 'worship': return '🕯️';
      case 'bathroom': return '🚿';
      case 'balcony': return '🌿';
      default: return '📦';
    }
  }

  previewModelInViewer(asset) {
    this.close();
    // Pre-fill or highlight in furniture dropdown if exists in scene
    const furnSelect = document.getElementById('furniture-select');
    if (furnSelect) {
      const matchOpt = Array.from(furnSelect.options).find(o =>
        o.value.toLowerCase().includes(asset.name.toLowerCase()) ||
        o.value.toLowerCase().includes(asset.asset_id.toLowerCase())
      );
      if (matchOpt) {
        furnSelect.value = matchOpt.value;
        furnSelect.dispatchEvent(new Event('change'));
      }
    }

    // Notify user
    alert(`Đã chọn mẫu: "${asset.name}" (${asset.asset_id}). Kích thước: ${asset.dimensions.width}×${asset.dimensions.depth}×${asset.dimensions.height}m. Bạn có thể yêu cầu AI sắp đặt mẫu này trong tab Chat!`);
  }

  async handleAddFurnitureSubmit(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('btn-submit-add-furniture');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>⏳ Đang tải lên và phân tích mô hình...</span>';
    submitBtn.disabled = true;

    try {
      const name = document.getElementById('add-furniture-name').value.trim();
      const assetId = document.getElementById('add-furniture-id').value.trim();
      const category = document.getElementById('add-furniture-category').value;
      const placementType = document.getElementById('add-furniture-placement').value;
      const width = parseFloat(document.getElementById('add-furniture-w').value) || 1.0;
      const depth = parseFloat(document.getElementById('add-furniture-d').value) || 1.0;
      const height = parseFloat(document.getElementById('add-furniture-h').value) || 1.0;
      const tagsStr = document.getElementById('add-furniture-tags').value.trim();
      const fileInput = document.getElementById('add-furniture-file');

      if (!name || !assetId) {
        alert('Vui lòng nhập Tên và Mã mẫu nội thất!');
        return;
      }

      const file = fileInput.files ? fileInput.files[0] : null;
      let glbBase64 = null;
      let filename = `${assetId}.glb`;

      if (file) {
        filename = file.name;
        glbBase64 = await this.readFileAsDataUrl(file);
      }

      const tags = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : [category];

      const payload = {
        name,
        asset_id: assetId,
        category,
        room_types: JSON.stringify([category]),
        placement_type: placementType,
        dimensions: { width, depth, height },
        tags,
        glbBase64,
        filename,
        is_builtin: 0
      };

      let newAsset = null;
      try {
        const res = await fetch('/api/furniture-assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const resJson = await res.json();
          newAsset = resJson.data || resJson;
        }
      } catch (err) {
        console.warn('Backend /api/furniture-assets unreachable, adding locally:', err);
      }

      const createdItem = this.normalizeAsset(newAsset || {
        ...payload,
        id: assetId,
        is_builtin: false,
        is_custom: true
      });

      this.assets.unshift(createdItem);
      this.applyFilters();
      this.closeAddModal();

      if (this.onAssetAdded) {
        this.onAssetAdded(createdItem);
      }

      alert(`✓ Đã thêm thành công mẫu nội thất "${name}" (${assetId}) vào kho thư viện!`);
    } catch (err) {
      console.error('Error adding furniture asset:', err);
      alert('Có lỗi khi thêm mẫu nội thất: ' + err.message);
    } finally {
      submitBtn.innerHTML = originalText;
      submitBtn.disabled = false;
    }
  }

  readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}
