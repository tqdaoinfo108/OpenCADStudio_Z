/**
 * ai_settings_modal.js
 * OpenCADStudio_Z / Nếp Nhà - AI Provider Configuration Controller
 * Supports OpenAI Official, Custom Proxies (Antigravity/OpenRouter/LiteLLM),
 * Google Gemini, Anthropic Claude, and Local Ollama.
 */

export class AiSettingsModal {
  constructor(options = {}) {
    this.onConfigSaved = options.onConfigSaved || null;

    this.presets = {
      openai: {
        name: 'OpenAI Official',
        baseUrl: 'https://api.openai.com/v1',
        defaultPrimary: 'gpt-4o',
        defaultVision: 'gpt-4o',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview', 'o1-mini']
      },
      custom_proxy: {
        name: 'OpenAI-Compatible Proxy (Antigravity / OpenRouter / LiteLLM)',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultPrimary: 'anthropic/claude-3.5-sonnet',
        defaultVision: 'google/gemini-flash-1.5',
        models: [
          'anthropic/claude-3.5-sonnet',
          'google/gemini-pro-1.5',
          'google/gemini-flash-1.5',
          'openai/gpt-4o',
          'meta-llama/llama-3.1-70b-instruct'
        ]
      },
      gemini: {
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultPrimary: 'gemini-1.5-pro',
        defaultVision: 'gemini-1.5-flash',
        models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.0-pro']
      },
      anthropic: {
        name: 'Anthropic Claude',
        baseUrl: 'https://api.anthropic.com/v1',
        defaultPrimary: 'claude-3-5-sonnet-20241022',
        defaultVision: 'claude-3-5-sonnet-20241022',
        models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']
      },
      ollama: {
        name: 'Local Ollama',
        baseUrl: 'http://localhost:11434/v1',
        defaultPrimary: 'llama3.2',
        defaultVision: 'llava',
        models: ['llama3.2', 'llama3.1:8b', 'mistral', 'qwen2.5-coder', 'llava', 'bakllava']
      }
    };

    this.currentConfig = {
      provider: 'custom_proxy',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      primaryModel: 'anthropic/claude-3.5-sonnet',
      visionModel: 'google/gemini-flash-1.5'
    };

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.loadConfig();
  }

  bindEvents() {
    const modal = document.getElementById('modal-ai-settings');
    const openBtn = document.getElementById('btn-ai-settings');
    const closeBtn = document.getElementById('modal-ai-close-btn');
    const cancelBtn = document.getElementById('btn-ai-cancel');
    const saveBtn = document.getElementById('btn-ai-save-config');
    const fetchModelsBtn = document.getElementById('btn-ai-fetch-models');
    const testConnBtn = document.getElementById('btn-ai-test-connection');
    const toggleKeyBtn = document.getElementById('btn-ai-toggle-key');
    const providerSelect = document.getElementById('ai-provider-select');

    if (openBtn) {
      openBtn.addEventListener('click', () => this.open());
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.close());
    }

    if (providerSelect) {
      providerSelect.addEventListener('change', (e) => {
        this.selectProvider(e.target.value);
      });
    }

    if (toggleKeyBtn) {
      toggleKeyBtn.addEventListener('click', () => this.toggleApiKeyVisibility());
    }

    if (fetchModelsBtn) {
      fetchModelsBtn.addEventListener('click', () => this.fetchModels());
    }

    if (testConnBtn) {
      testConnBtn.addEventListener('click', () => this.testConnection());
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.saveConfig();
      });
    }

    // Preset shortcut pills
    const presetPills = document.querySelectorAll('.ai-preset-pill');
    presetPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const pKey = pill.getAttribute('data-provider');
        if (pKey && this.presets[pKey]) {
          if (providerSelect) providerSelect.value = pKey;
          this.selectProvider(pKey);
        }
      });
    });
  }

  open() {
    this.populateForm();
    const modal = document.getElementById('modal-ai-settings');
    if (modal) modal.classList.remove('hidden');
  }

  close() {
    const modal = document.getElementById('modal-ai-settings');
    if (modal) modal.classList.add('hidden');
    this.resetStatusPills();
  }

  resetStatusPills() {
    const connPill = document.getElementById('ai-test-result');
    if (connPill) {
      connPill.className = 'ai-status-pill hidden';
      connPill.textContent = '';
    }
    const fetchPill = document.getElementById('ai-fetch-result');
    if (fetchPill) {
      fetchPill.className = 'ai-status-pill hidden';
      fetchPill.textContent = '';
    }
  }

  async loadConfig() {
    let loaded = null;
    try {
      const res = await fetch('/api/ai/config');
      if (res.ok) {
        const json = await res.json();
        const data = json.data || json;
        if (data && (data.base_url || data.baseUrl)) {
          loaded = {
            provider: data.provider || 'custom_proxy',
            baseUrl: data.base_url || data.baseUrl || '',
            apiKey: data.api_key || data.apiKey || '',
            primaryModel: data.primary_model || data.primaryModel || '',
            visionModel: data.vision_model || data.visionModel || ''
          };
        }
      }
    } catch {
      // Server offline or not ready
    }

    if (!loaded) {
      try {
        const local = localStorage.getItem('nepnha_ai_config');
        if (local) {
          loaded = JSON.parse(local);
        }
      } catch {}
    }

    if (loaded) {
      this.currentConfig = { ...this.currentConfig, ...loaded };
    }

    this.populateForm();
  }

  populateForm() {
    const providerSelect = document.getElementById('ai-provider-select');
    const baseUrlInput = document.getElementById('ai-base-url');
    const apiKeyInput = document.getElementById('ai-api-key');

    if (providerSelect) providerSelect.value = this.currentConfig.provider || 'custom_proxy';
    if (baseUrlInput) baseUrlInput.value = this.currentConfig.baseUrl || '';
    if (apiKeyInput) apiKeyInput.value = this.currentConfig.apiKey || '';

    this.populateModelDropdowns(
      this.presets[this.currentConfig.provider]?.models || [],
      this.currentConfig.primaryModel,
      this.currentConfig.visionModel
    );

    // Highlight active preset pill
    const presetPills = document.querySelectorAll('.ai-preset-pill');
    presetPills.forEach(pill => {
      const pKey = pill.getAttribute('data-provider');
      pill.classList.toggle('active', pKey === this.currentConfig.provider);
    });
  }

  selectProvider(providerKey) {
    const preset = this.presets[providerKey];
    if (!preset) return;

    this.currentConfig.provider = providerKey;

    const baseUrlInput = document.getElementById('ai-base-url');
    if (baseUrlInput) {
      baseUrlInput.value = preset.baseUrl;
      this.currentConfig.baseUrl = preset.baseUrl;
    }

    this.populateModelDropdowns(preset.models, preset.defaultPrimary, preset.defaultVision);

    const presetPills = document.querySelectorAll('.ai-preset-pill');
    presetPills.forEach(pill => {
      const pKey = pill.getAttribute('data-provider');
      pill.classList.toggle('active', pKey === providerKey);
    });
  }

  populateModelDropdowns(modelList = [], selectedPrimary = null, selectedVision = null) {
    const primarySelect = document.getElementById('ai-primary-model');
    const visionSelect = document.getElementById('ai-vision-model');

    const ensureList = [...new Set([
      ...modelList,
      selectedPrimary,
      selectedVision,
      'gpt-4o',
      'gemini-1.5-pro'
    ])].filter(Boolean);

    if (primarySelect) {
      primarySelect.innerHTML = '';
      for (const m of ensureList) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === selectedPrimary || (!selectedPrimary && m.includes('4o'))) {
          opt.selected = true;
        }
        primarySelect.appendChild(opt);
      }
      if (selectedPrimary && !ensureList.includes(selectedPrimary)) {
        const customOpt = new Option(selectedPrimary, selectedPrimary, true, true);
        primarySelect.add(customOpt);
      }
    }

    if (visionSelect) {
      visionSelect.innerHTML = '';
      for (const m of ensureList) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === selectedVision || (!selectedVision && (m.includes('flash') || m.includes('4o')))) {
          opt.selected = true;
        }
        visionSelect.appendChild(opt);
      }
      if (selectedVision && !ensureList.includes(selectedVision)) {
        const customOpt = new Option(selectedVision, selectedVision, true, true);
        visionSelect.add(customOpt);
      }
    }
  }

  toggleApiKeyVisibility() {
    const input = document.getElementById('ai-api-key');
    const btn = document.getElementById('btn-ai-toggle-key');
    if (!input) return;

    if (input.type === 'password') {
      input.type = 'text';
      if (btn) btn.textContent = '🙈';
    } else {
      input.type = 'password';
      if (btn) btn.textContent = '👁️';
    }
  }

  async fetchModels() {
    const fetchBtn = document.getElementById('btn-ai-fetch-models');
    const resultPill = document.getElementById('ai-fetch-result');
    const baseUrl = document.getElementById('ai-base-url')?.value.trim() || '';
    const apiKey = document.getElementById('ai-api-key')?.value.trim() || '';
    const provider = document.getElementById('ai-provider-select')?.value || 'custom_proxy';

    if (!baseUrl) {
      alert('Vui lòng nhập Base URL!');
      return;
    }

    if (fetchBtn) {
      fetchBtn.disabled = true;
      fetchBtn.classList.add('loading');
    }

    if (resultPill) {
      resultPill.className = 'ai-status-pill info';
      resultPill.textContent = '⏳ Đang quét danh sách mô hình từ endpoint...';
    }

    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, provider })
      });

      let modelList = [];
      if (res.ok) {
        const data = await res.json();
        modelList = Array.isArray(data) ? data : (data.models || data.data || []);
      }

      if (Array.isArray(modelList) && modelList.length > 0) {
        const primaryVal = document.getElementById('ai-primary-model')?.value;
        const visionVal = document.getElementById('ai-vision-model')?.value;
        this.populateModelDropdowns(modelList, primaryVal, visionVal);

        if (resultPill) {
          resultPill.className = 'ai-status-pill success';
          resultPill.textContent = `✓ Tìm thấy ${modelList.length} mô hình AI khả dụng!`;
        }
      } else {
        // Fallback to preset models
        const presetModels = this.presets[provider]?.models || [];
        this.populateModelDropdowns(presetModels);
        if (resultPill) {
          resultPill.className = 'ai-status-pill warning';
          resultPill.textContent = `⚠️ Đã tải ${presetModels.length} mô hình gợi ý mặc định.`;
        }
      }
    } catch (err) {
      const presetModels = this.presets[provider]?.models || [];
      this.populateModelDropdowns(presetModels);
      if (resultPill) {
        resultPill.className = 'ai-status-pill warning';
        resultPill.textContent = `⚠️ Không thể kết nối tới server: ${err.message}. Đã nạp danh sách gợi ý.`;
      }
    } finally {
      if (fetchBtn) {
        fetchBtn.disabled = false;
        fetchBtn.classList.remove('loading');
      }
    }
  }

  async testConnection() {
    const testBtn = document.getElementById('btn-ai-test-connection');
    const resultPill = document.getElementById('ai-test-result');
    const baseUrl = document.getElementById('ai-base-url')?.value.trim() || '';
    const apiKey = document.getElementById('ai-api-key')?.value.trim() || '';
    const provider = document.getElementById('ai-provider-select')?.value || 'custom_proxy';
    const primaryModel = document.getElementById('ai-primary-model')?.value || '';

    if (!baseUrl) {
      alert('Vui lòng nhập Base URL!');
      return;
    }

    if (testBtn) {
      testBtn.disabled = true;
      testBtn.classList.add('loading');
    }

    if (resultPill) {
      resultPill.className = 'ai-status-pill info';
      resultPill.textContent = '⚡ Đang kiểm tra kết nối API...';
    }

    const startTime = performance.now();
    try {
      const res = await fetch('/api/ai/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, provider, model: primaryModel })
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (res.ok) {
        const json = await res.json();
        const serverLatency = json.latencyMs || latencyMs;
        if (resultPill) {
          resultPill.className = 'ai-status-pill success';
          resultPill.textContent = `🟢 Kết nối thành công! Độ trễ: ${serverLatency}ms`;
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson.message || errJson.error || `HTTP ${res.status}`;
        if (resultPill) {
          resultPill.className = 'ai-status-pill error';
          resultPill.textContent = `🔴 Thất bại: ${msg} (${latencyMs}ms)`;
        }
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      if (resultPill) {
        resultPill.className = 'ai-status-pill error';
        resultPill.textContent = `🔴 Lỗi mạng: ${err.message} (${latencyMs}ms)`;
      }
    } finally {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.classList.remove('loading');
      }
    }
  }

  async saveConfig() {
    const provider = document.getElementById('ai-provider-select')?.value || 'custom_proxy';
    const baseUrl = document.getElementById('ai-base-url')?.value.trim() || '';
    const apiKey = document.getElementById('ai-api-key')?.value.trim() || '';
    const primaryModel = document.getElementById('ai-primary-model')?.value || '';
    const visionModel = document.getElementById('ai-vision-model')?.value || '';

    this.currentConfig = {
      provider,
      baseUrl,
      apiKey,
      primaryModel,
      visionModel
    };

    // Save to localStorage
    try {
      localStorage.setItem('nepnha_ai_config', JSON.stringify(this.currentConfig));
    } catch {}

    // Save to Backend SQLite API
    let savedOnServer = false;
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          base_url: baseUrl,
          api_key: apiKey,
          primary_model: primaryModel,
          vision_model: visionModel
        })
      });
      if (res.ok) savedOnServer = true;
    } catch (err) {
      console.warn('Backend not reached when saving AI config:', err);
    }

    if (this.onConfigSaved) {
      this.onConfigSaved(this.currentConfig);
    }

    this.close();

    const toastMsg = savedOnServer
      ? '✓ Cấu hình AI đã lưu thành công vào máy chủ!'
      : '✓ Cấu hình AI đã lưu cục bộ (Local Storage)!';
    alert(toastMsg);
  }

  getConfig() {
    return { ...this.currentConfig };
  }
}
