/**
 * VideoExporter - Bộ Ghi Hình & Xuất Video 3D Toàn Cảnh
 * OpenCADStudio_Z / web-viewer
 *
 * - Modal điều khiển "🎬 Xuất Video 3D / Xem Tour Tự Động"
 * - Tùy chọn: 4 Kịch bản, Tỷ lệ khung hình (16:9 Ngang HD, 9:16 Dọc điện thoại), Thời lượng (15s, 30s, 45s)
 * - MediaRecorder với bitrate cao 10-12 Mbps
 * - HUD Caption đồ họa trực tiếp trên Canvas (Tên dự án, Phân đoạn, Tên tầng & Phòng hiện tại)
 * - Thanh tiến trình 0-100%, xem lại video trực tiếp và nút "⬇️ Tải Video Về Máy (.webm / .mp4)"
 * - Hỗ trợ "▶️ Xem Tour Trực Tiếp" (Live Preview tour trong viewport kèm floating HUD)
 */

import { CinematicTourDirector, CINEMATIC_SCENARIOS } from './cinematic_tour_director.js';

export class VideoExporter {
  /**
   * @param {Object} options
   * @param {import('./viewer_3d.js').Viewer3D} options.viewer
   * @param {CinematicTourDirector} [options.director]
   * @param {Function} [options.getProjectMeta]
   */
  constructor(options = {}) {
    this.viewer = options.viewer;
    this.director = options.director || new CinematicTourDirector(this.viewer);
    this.getProjectMeta = options.getProjectMeta || (() => ({
      title: 'Biệt Thự Hiện Đại 2 Tầng 1 Tum',
      code: 'NN-2026-BT08'
    }));

    // Configuration
    this.scenarioId = 'full_film';
    this.aspectRatio = '16:9'; // '16:9' | '9:16'
    this.duration = 30; // 15 | 30 | 45
    this.includeHud = true;
    this.fps = 30; // 30 fps produces rock-solid browser encode at 12 Mbps
    this.bitrate = 12000000; // 12 Mbps

    this.isExporting = false;
    this.isCancelled = false;
    this.recordedBlob = null;
    this.recordedUrl = null;

    this.initDOM();
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    this.modalEl = document.getElementById('modal-video-exporter');
    this.liveHudEl = document.getElementById('cinematic-live-hud');

    if (!this.modalEl) {
      console.warn('[VideoExporter] modal-video-exporter element not found in DOM.');
      return;
    }

    this.setupModalEvents();
    this.setupLiveHudEvents();
  }

  setupModalEvents() {
    // Close button
    const closeBtn = document.getElementById('btn-close-video-exporter');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());

    const cancelBtn = document.getElementById('btn-cancel-video-export');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.cancelExport());

    // Scenario selection cards
    const scenarioCards = this.modalEl.querySelectorAll('.scenario-select-card');
    scenarioCards.forEach(card => {
      card.addEventListener('click', () => {
        scenarioCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        this.scenarioId = card.getAttribute('data-scenario') || 'full_film';
      });
    });

    // Aspect ratio selection
    const ratioBtns = this.modalEl.querySelectorAll('.aspect-ratio-btn');
    ratioBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        ratioBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.aspectRatio = btn.getAttribute('data-ratio') || '16:9';
      });
    });

    // Duration selection
    const durationBtns = this.modalEl.querySelectorAll('.duration-pill-btn');
    durationBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        durationBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.duration = parseInt(btn.getAttribute('data-duration') || '30', 10);
      });
    });

    // HUD Caption toggle
    const hudCheckbox = document.getElementById('chk-video-hud');
    if (hudCheckbox) {
      hudCheckbox.addEventListener('change', (e) => {
        this.includeHud = Boolean(e.target.checked);
      });
    }

    // Action: Play Live Tour
    const btnLivePlay = document.getElementById('btn-start-live-tour');
    if (btnLivePlay) {
      btnLivePlay.addEventListener('click', () => {
        this.closeModal();
        this.startLiveTour();
      });
    }

    // Action: Start Record & Export
    const btnStartExport = document.getElementById('btn-start-video-export');
    if (btnStartExport) {
      btnStartExport.addEventListener('click', () => {
        this.startExport();
      });
    }

    // Action: Download Video
    const btnDownload = document.getElementById('btn-download-video-file');
    if (btnDownload) {
      btnDownload.addEventListener('click', () => {
        this.downloadVideo();
      });
    }

    // Action: Reset & Export Another
    const btnReset = document.getElementById('btn-export-another-video');
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        this.resetExportViews();
      });
    }
  }

  setupLiveHudEvents() {
    if (!this.liveHudEl) return;

    const btnPause = document.getElementById('btn-live-hud-pause');
    const btnReplay = document.getElementById('btn-live-hud-replay');
    const btnExit = document.getElementById('btn-live-hud-exit');
    const btnExportShortcut = document.getElementById('btn-live-hud-export');

    if (btnPause) {
      btnPause.addEventListener('click', () => {
        if (this.director.isPaused) {
          this.director.resume();
          btnPause.innerHTML = '<span>⏸️ Tạm Dừng</span>';
        } else {
          this.director.pause();
          btnPause.innerHTML = '<span>▶️ Tiếp Tục</span>';
        }
      });
    }

    if (btnReplay) {
      btnReplay.addEventListener('click', () => {
        this.director.seek(0);
        this.director.start(this.scenarioId, this.duration);
        if (btnPause) btnPause.innerHTML = '<span>⏸️ Tạm Dừng</span>';
      });
    }

    if (btnExit) {
      btnExit.addEventListener('click', () => {
        this.stopLiveTour();
      });
    }

    if (btnExportShortcut) {
      btnExportShortcut.addEventListener('click', () => {
        this.stopLiveTour();
        this.openModal();
      });
    }

    // Progress click seek
    const progTrack = document.getElementById('live-hud-progress-track');
    if (progTrack) {
      progTrack.addEventListener('click', (e) => {
        const rect = progTrack.getBoundingClientRect();
        const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.director.seek(u);
      });
    }
  }

  openModal() {
    if (!this.modalEl) return;
    this.resetExportViews();
    this.modalEl.classList.remove('hidden');
  }

  closeModal() {
    if (this.modalEl) this.modalEl.classList.add('hidden');
  }

  resetExportViews() {
    const configView = document.getElementById('video-export-config-view');
    const progressView = document.getElementById('video-export-progress-view');
    const resultView = document.getElementById('video-export-result-view');

    if (configView) configView.classList.remove('hidden');
    if (progressView) progressView.classList.add('hidden');
    if (resultView) resultView.classList.add('hidden');

    const videoEl = document.getElementById('video-preview-player');
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
    }
  }

  // =========================================================================
  // LIVE VIEWPORT TOUR (Xem Tour Trực Tiếp)
  // =========================================================================
  startLiveTour() {
    if (!this.liveHudEl) return;
    this.clearLiveTourHud();
    this.liveHudEl.classList.remove('hidden');

    const scenarioMeta = CINEMATIC_SCENARIOS.find(s => s.id === this.scenarioId) || CINEMATIC_SCENARIOS[0];
    const titleEl = document.getElementById('live-hud-title');
    if (titleEl) titleEl.textContent = scenarioMeta.name;

    const pauseBtn = document.getElementById('btn-live-hud-pause');
    if (pauseBtn) pauseBtn.innerHTML = '<span>⏸️ Tạm Dừng</span>';

    // Hook update callback
    this._unhookTourUpdate = this.director.onUpdate((info) => {
      this.updateLiveHud(info);
    });

    this._unhookTourComplete = this.director.onComplete(() => this.clearLiveTourHud());
    this._unhookTourStop = this.director.onStop(() => this.clearLiveTourHud());
    this.updateTourButton(true);

    this.director.start(this.scenarioId, this.duration);
  }

  updateLiveHud(info) {
    const badgeEl = document.getElementById('live-hud-badge');
    const captionEl = document.getElementById('live-hud-caption');
    const subCaptionEl = document.getElementById('live-hud-subcaption');
    const timeEl = document.getElementById('live-hud-time');
    const progBar = document.getElementById('live-hud-progress-bar');

    if (badgeEl) badgeEl.textContent = info.badge || '🎬 ĐIỆN ẢNH';
    if (captionEl) captionEl.textContent = info.caption || '';
    if (subCaptionEl) subCaptionEl.textContent = info.subCaption || '';

    if (timeEl) {
      const curM = Math.floor(info.timeSec / 60);
      const curS = Math.floor(info.timeSec % 60);
      const totM = Math.floor(info.duration / 60);
      const totS = Math.floor(info.duration % 60);
      timeEl.textContent = `${String(curM).padStart(2, '0')}:${String(curS).padStart(2, '0')} / ${String(totM).padStart(2, '0')}:${String(totS).padStart(2, '0')}`;
    }

    if (progBar) {
      progBar.style.width = `${(info.progress * 100).toFixed(1)}%`;
    }
  }

  stopLiveTour() {
    this.director.stop();
    this.clearLiveTourHud();
  }

  clearLiveTourHud() {
    this._unhookTourUpdate?.();
    this._unhookTourComplete?.();
    this._unhookTourStop?.();
    this.liveHudEl?.classList.add('hidden');
    this.updateTourButton(false);
  }

  updateTourButton(playing) {
    const button = document.getElementById('btn-view-tour-3d');
    const label = button?.querySelector('span:last-child');
    if (label) label.textContent = playing ? 'Dừng Tour' : 'Tour 3D';
    button?.setAttribute('aria-pressed', String(playing));
  }

  // =========================================================================
  // VIDEO RECORDING & EXPORT ENGINE (Ghi Hình & Xuất Video)
  // =========================================================================
  async startExport() {
    if (this.isExporting) return;
    this.isExporting = true;
    this.isCancelled = false;

    const configView = document.getElementById('video-export-config-view');
    const progressView = document.getElementById('video-export-progress-view');
    if (configView) configView.classList.add('hidden');
    if (progressView) progressView.classList.remove('hidden');

    this.updateExportProgress(0, 'Chuẩn bị Động cơ Đồ họa & Canvas 1080p...');

    // 1. Determine Dimensions
    let targetW = 1920;
    let targetH = 1080;
    if (this.aspectRatio === '9:16') {
      targetW = 1080;
      targetH = 1920;
    }

    // Offscreen Canvas for HUD Composition
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = targetW;
    exportCanvas.height = targetH;
    const ctx = exportCanvas.getContext('2d');

    // 2. Select Video MIME Type
    const mimeTypes = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    let chosenMime = 'video/webm';
    if (typeof MediaRecorder !== 'undefined') {
      for (const m of mimeTypes) {
        if (MediaRecorder.isTypeSupported(m)) {
          chosenMime = m;
          break;
        }
      }
    }

    // 3. Initialize MediaRecorder
    let recorder = null;
    const recordedChunks = [];

    try {
      const stream = exportCanvas.captureStream(this.fps);
      recorder = new MediaRecorder(stream, {
        mimeType: chosenMime,
        videoBitsPerSecond: this.bitrate
      });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };
      recorder.start(100);
    } catch (err) {
      console.warn('[VideoExporter] MediaRecorder fallback:', err);
    }

    // Save viewer state before export
    this.director.saveCurrentState();
    this.director.setScenario(this.scenarioId, this.duration);

    const totalFrames = Math.round(this.duration * this.fps);
    const projMeta = this.getProjectMeta();
    const webglCanvas = this.viewer.renderer.domElement;

    // 4. Render & Encode Loop (deterministic frame stepping)
    for (let frame = 0; frame <= totalFrames; frame++) {
      if (this.isCancelled) {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        this.director.restoreState();
        this.isExporting = false;
        return;
      }

      const u = frame / totalFrames;
      const info = this.director.seek(u);

      // Force render 3D scene
      this.viewer.renderer.render(this.viewer.scene, this.viewer.camera);

      // Draw onto composite canvas
      this.compositeFrame(ctx, webglCanvas, targetW, targetH);

      // Draw vector HUD Captions
      if (this.includeHud) {
        this.drawCinematicHUD(ctx, targetW, targetH, info, projMeta);
      }

      // Update progress UI
      const percent = Math.round((frame / totalFrames) * 100);
      const phaseText = percent < 30 ? 'Dựng cảnh quan 3D & Spline camera...'
        : percent < 70 ? 'Khám phá nội thất & Tách tầng dollhouse...'
        : percent < 95 ? 'Mã hóa video 12 Mbps & Hoàn thiện...' : 'Đóng gói tập tin video...';
      this.updateExportProgress(percent, phaseText);

      // Yield frame
      await new Promise(r => requestAnimationFrame(r));
    }

    // Finalize recording
    this.updateExportProgress(100, 'Hoàn thành ghi hình. Đang đóng gói...');
    await new Promise(r => setTimeout(r, 400));

    if (recorder && recorder.state !== 'inactive') {
      await new Promise(resolve => {
        recorder.onstop = resolve;
        recorder.stop();
      });
    }

    // Compile Blob
    const videoBlob = new Blob(recordedChunks, { type: chosenMime });
    this.recordedBlob = videoBlob;
    if (this.recordedUrl) URL.revokeObjectURL(this.recordedUrl);
    this.recordedUrl = URL.createObjectURL(videoBlob);

    // Restore viewer
    this.director.restoreState();
    this.isExporting = false;

    // Show Result View
    this.showExportResult(chosenMime, targetW, targetH, videoBlob.size);
  }

  cancelExport() {
    this.isCancelled = true;
    this.isExporting = false;
    this.resetExportViews();
  }

  compositeFrame(ctx, webglCanvas, targetW, targetH) {
    const srcW = webglCanvas.width;
    const srcH = webglCanvas.height;

    if (this.aspectRatio === '9:16') {
      // Center crop horizontally from 3D landscape canvas
      const targetAspect = 9 / 16;
      const srcAspect = srcW / srcH;

      let cropW, cropH, cropX, cropY;
      if (srcAspect > targetAspect) {
        cropH = srcH;
        cropW = srcH * targetAspect;
        cropX = (srcW - cropW) / 2;
        cropY = 0;
      } else {
        cropW = srcW;
        cropH = srcW / targetAspect;
        cropX = 0;
        cropY = (srcH - cropH) / 2;
      }

      ctx.drawImage(webglCanvas, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);
    } else {
      // 16:9 full frame fit
      ctx.drawImage(webglCanvas, 0, 0, srcW, srcH, 0, 0, targetW, targetH);
    }
  }

  /**
   * Draw professional architectural HUD onto the video frame
   */
  drawCinematicHUD(ctx, width, height, info, projMeta) {
    ctx.save();
    const isVertical = height > width;
    const scale = width / 1920; // scale factor relative to 1080p

    // 1. Top Vignette
    const topGrad = ctx.createLinearGradient(0, 0, 0, 140 * scale);
    topGrad.addColorStop(0, 'rgba(10, 12, 16, 0.72)');
    topGrad.addColorStop(1, 'rgba(10, 12, 16, 0.0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, width, 140 * scale);

    const padX = 40 * scale;
    const padY = 32 * scale;
    const pillH = 54 * scale;

    // 2. Top-Left: Project Dossier Pill
    const pillW = Math.min(width - padX * 2, isVertical ? 480 * scale : 560 * scale);
    ctx.fillStyle = 'rgba(22, 24, 30, 0.88)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.roundRect(padX, padY, pillW, pillH, 10 * scale);
    ctx.fill();
    ctx.stroke();

    ctx.font = `bold ${18 * scale}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = '#D4A373'; // warm gold tag
    ctx.fillText('🏛️ NẾP NHÀ 3D', padX + 16 * scale, padY + 34 * scale);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillText('|', padX + 185 * scale, padY + 34 * scale);

    ctx.font = `600 ${16 * scale}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    const projTitle = projMeta.title || 'Biệt Thự Hiện Đại 2 Tầng 1 Tum';
    const truncated = projTitle.length > 25 ? projTitle.slice(0, 23) + '...' : projTitle;
    ctx.fillText(truncated, padX + 205 * scale, padY + 34 * scale);

    // 3. Top-Right: Timecode Pill
    if (!isVertical) {
      const curM = Math.floor(info.timeSec / 60);
      const curS = Math.floor(info.timeSec % 60);
      const totM = Math.floor(info.duration / 60);
      const totS = Math.floor(info.duration % 60);
      const timeStr = `${String(curM).padStart(2, '0')}:${String(curS).padStart(2, '0')} / ${String(totM).padStart(2, '0')}:${String(totS).padStart(2, '0')}`;

      const timePillW = 210 * scale;
      const timePillX = width - padX - timePillW;
      ctx.fillStyle = 'rgba(22, 24, 30, 0.88)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.beginPath();
      ctx.roundRect(timePillX, padY, timePillW, pillH, 10 * scale);
      ctx.fill();
      ctx.stroke();

      ctx.font = `bold ${16 * scale}px monospace`;
      ctx.fillStyle = '#F3F4F6';
      ctx.fillText(timeStr, timePillX + 16 * scale, padY + 34 * scale);

      ctx.font = `bold ${13 * scale}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillStyle = '#10B981';
      ctx.fillText('● 1080p', timePillX + timePillW - 75 * scale, padY + 34 * scale);
    }

    // 4. Bottom Vignette
    const botGradH = 260 * scale;
    const botGrad = ctx.createLinearGradient(0, height - botGradH, 0, height);
    botGrad.addColorStop(0, 'rgba(10, 12, 16, 0.0)');
    botGrad.addColorStop(1, 'rgba(10, 12, 16, 0.90)');
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, height - botGradH, width, botGradH);

    // 5. Bottom Subtitle Card
    const cardW = isVertical ? width - padX * 2 : Math.min(width - padX * 2, 880 * scale);
    const cardH = 118 * scale;
    const cardX = isVertical ? padX : (width - cardW) / 2;
    const cardY = height - cardH - (isVertical ? 90 * scale : 48 * scale);

    ctx.fillStyle = 'rgba(18, 20, 26, 0.92)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 14 * scale);
    ctx.fill();
    ctx.stroke();

    // Stage Badge
    const badgeText = info.badge || '🎬 ĐIỆN ẢNH';
    ctx.font = `bold ${14 * scale}px "Plus Jakarta Sans", sans-serif`;
    const badgeW = ctx.measureText(badgeText).width + 24 * scale;
    const badgeH = 28 * scale;
    ctx.fillStyle = '#C89355';
    ctx.beginPath();
    ctx.roundRect(cardX + 22 * scale, cardY + 18 * scale, badgeW, badgeH, 6 * scale);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(badgeText, cardX + 34 * scale, cardY + 37 * scale);

    // Location tag
    if (info.floorName) {
      const locTag = `📍 ${info.floorName}${info.roomName ? ' • ' + info.roomName : ''}`;
      ctx.font = `600 ${14 * scale}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillStyle = '#9CA3AF';
      ctx.fillText(locTag, cardX + 36 * scale + badgeW, cardY + 37 * scale);
    }

    // Main Caption
    ctx.font = `bold ${24 * scale}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(info.caption || '', cardX + 22 * scale, cardY + 76 * scale);

    // Sub Caption
    ctx.font = `400 ${15 * scale}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = '#D1D5DB';
    ctx.fillText(info.subCaption || '', cardX + 22 * scale, cardY + 101 * scale);

    // 6. Bottom Progress Line
    const progY = height - 5 * scale;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(0, progY, width, 5 * scale);

    const progW = width * Math.max(0, Math.min(1, info.progress));
    ctx.fillStyle = '#D4A373';
    ctx.fillRect(0, progY, progW, 5 * scale);

    ctx.restore();
  }

  updateExportProgress(percent, label) {
    const barEl = document.getElementById('export-progress-bar-fill');
    const pctEl = document.getElementById('export-progress-percent-label');
    const descEl = document.getElementById('export-progress-desc-label');

    if (barEl) barEl.style.width = `${percent}%`;
    if (pctEl) pctEl.textContent = `${percent}%`;
    if (descEl) descEl.textContent = label;
  }

  showExportResult(mimeType, width, height, sizeBytes) {
    const progressView = document.getElementById('video-export-progress-view');
    const resultView = document.getElementById('video-export-result-view');
    if (progressView) progressView.classList.add('hidden');
    if (resultView) resultView.classList.remove('hidden');

    const videoEl = document.getElementById('video-preview-player');
    if (videoEl && this.recordedUrl) {
      videoEl.src = this.recordedUrl;
      videoEl.load();
      videoEl.play().catch(() => {});
    }

    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
    const metaEl = document.getElementById('video-result-meta-badge');
    if (metaEl) {
      const ext = mimeType.includes('mp4') ? 'MP4' : 'WEBM';
      metaEl.textContent = `${width}×${height} ${ext} • ${this.duration}s • 12 Mbps • ${sizeMb} MB`;
    }
  }

  downloadVideo() {
    if (!this.recordedUrl) return;

    const projMeta = this.getProjectMeta();
    const cleanCode = (projMeta.code || 'BIM').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ext = (this.recordedBlob?.type || '').includes('mp4') ? 'mp4' : 'webm';
    const filename = `NepNha_${cleanCode}_${this.scenarioId}_${this.aspectRatio.replace(':', 'x')}_${this.duration}s.${ext}`;

    const a = document.createElement('a');
    a.href = this.recordedUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}
