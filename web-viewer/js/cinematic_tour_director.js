import * as THREE from 'three';

export const CINEMATIC_SCENARIOS = [
  {
    id: 'full_film',
    name: 'Phim Toàn Cảnh Điện Ảnh (Full Architectural Film)',
    shortName: 'Full Film',
    icon: '🎬',
    desc: 'Xoay 360° quanh công trình, nâng góc nhìn mặt cắt và lần lượt khám phá các tầng.',
    defaultDuration: 30,
    tags: ['Ngoại thất', 'Tách tầng', 'Nội thất', 'Điện ảnh']
  },
  {
    id: 'turntable',
    name: 'Xoay 360° Ngoại Thất & Cắt Lớp (Exterior Turntable)',
    shortName: '360° Turntable',
    icon: '🔄',
    desc: 'Vòng xoay 360° mượt mà quanh công trình ở góc phối cảnh 3/4, tường cắt lớp tự động mở ra khi camera lướt qua.',
    defaultDuration: 30,
    tags: ['360° Orbit', 'Mặt tiền', 'Cắt lớp', 'Toàn cảnh']
  },
  {
    id: 'interior_walkthrough',
    name: 'Hành Trình Nội Thất (Interior Walkthrough Tour)',
    shortName: 'Nội Thất',
    icon: '🚶',
    desc: 'Quan sát nội thất từng tầng từ cung nhìn bên ngoài công trình.',
    defaultDuration: 30,
    tags: ['Nội thất', 'Tầm mắt', 'Phòng khách', 'Phòng ngủ']
  },
  {
    id: 'floor_by_floor',
    name: 'Trình Chiếu Chi Tiết Từng Tầng (Floor-by-Floor)',
    shortName: 'Từng Tầng',
    icon: '📑',
    desc: 'Lần lượt cô lập và trình chiếu từng tầng theo thứ tự từ dưới lên.',
    defaultDuration: 30,
    tags: ['Tầng 1', 'Tầng 2', 'Tầng Tum', 'Cô lập tầng']
  }
];

export class CinematicTourDirector {
  /**
   * @param {import('./viewer_3d.js').Viewer3D} viewer
   * @param {Object} [options]
   */
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    viewer._tourDirector = this;
    this.options = options;

    this.currentScenarioId = 'full_film';
    this.duration = options.duration || 30; // seconds
    this.isPlaying = false;
    this.isPaused = false;
    this.currentTime = 0;
    this.progress = 0; // 0.0 to 1.0

    // Deterministic camera and target tracks shared with video export
    this.positionCurve = null;
    this.targetCurve = null;
    this.scenarioStages = [];

    // State backups to restore on exit
    this.savedCameraState = null;
    this.savedViewerState = null;

    // Callbacks
    this._onUpdateCallbacks = new Set();
    this._onCompleteCallbacks = new Set();
    this._onStopCallbacks = new Set();
    this._onStageChangeCallbacks = new Set();

    this.activeStageIndex = -1;
    this._lastTickTime = 0;
  }

  getScenarios() {
    return CINEMATIC_SCENARIOS;
  }

  getActiveScenario() {
    return CINEMATIC_SCENARIOS.find(s => s.id === this.currentScenarioId) || CINEMATIC_SCENARIOS[0];
  }

  /**
   * Build spline paths and keyframe triggers for the specified scenario
   * @param {string} scenarioId
   * @param {number} [duration]
   */
  setScenario(scenarioId, duration = null) {
    if (scenarioId) this.currentScenarioId = scenarioId;
    if (duration && duration > 0) this.duration = duration;

    const bounds = this.viewer.getBuildingCenterAndSpan();
    const bim = this.viewer.bimData;
    const floors = bim?.floors || [];

    this.buildSafeScenario(bounds, floors);

    this.progress = 0;
    this.currentTime = 0;
    this.activeStageIndex = -1;
  }

  /**
   * Start live camera tour in the active 3D viewport
   * @param {string} [scenarioId]
   * @param {number} [duration]
   */
  start(scenarioId = null, duration = null) {
    this.setScenario(scenarioId || this.currentScenarioId, duration || this.duration);
    const v = this.viewer;
    v.animatingCamera = false;
    v.walkthroughState.active = false;
    v.walkthroughState.walkTarget = null;
    const damping = v.controls.enableDamping;
    v.controls.enableDamping = false;
    v.controls.update();
    v.controls.enableDamping = damping;
    v.controls.enabled = false;
    v.setTourResolution?.(true);

    this.isPlaying = true;
    this.isPaused = false;
    this._lastTickTime = performance.now();
    this.seek(0);
    v.invalidate();
  }

  pause() {
    if (this.isPlaying) this.isPaused = true;
  }

  resume() {
    if (!this.isPlaying) {
      this.start();
      return;
    }
    this.isPaused = false;
    this._lastTickTime = performance.now();
    this.viewer.invalidate();
  }

  stop() {
    if (!this.isPlaying) return;
    this.releaseControls();
    for (const callback of this._onStopCallbacks) callback();
  }

  releaseControls() {
    this.isPlaying = this.isPaused = false;
    const v = this.viewer;
    v.camera.lookAt(v.controls.target);
    v.controls.enabled = true;
    v.setTourResolution?.(false);
    v._cutawayDirty = true;
    v.invalidate();
  }

  onStop(callback) {
    this._onStopCallbacks.add(callback);
    return () => this._onStopCallbacks.delete(callback);
  }

  saveCurrentState() {
    this.savedCameraState = {
      position: this.viewer.camera.position.clone(),
      target: this.viewer.controls.target.clone()
    };
    this.savedViewerState = {
      viewMode: this.viewer.viewMode,
      explodedDistance: this.viewer.explodedDistance,
      interiorLightsOn: this.viewer.interiorLightsOn,
      activeFloorId: this.viewer.activeFloorId
    };
  }

  _showAllFloors(v) {
    if (typeof v.showAllFloors === 'function') {
      v.showAllFloors();
    } else if (v.floorGroups) {
      for (const [_, grp] of v.floorGroups) {
        grp.visible = true;
      }
      v._cutawayDirty = true;
      v.invalidate();
    }
  }

  restoreState() {
    if (this.savedViewerState) {
      this.viewer.setExplodedDistance(this.savedViewerState.explodedDistance);
      this.viewer.setInteriorLights(this.savedViewerState.interiorLightsOn);
      this._showAllFloors(this.viewer);
      this.viewer.setViewMode(this.savedViewerState.viewMode);
      if (this.savedViewerState.activeFloorId) this.viewer.isolateFloorUpTo(this.savedViewerState.activeFloorId);
      this.viewer.animatingCamera = false;
    }
    if (this.savedCameraState) {
      this.viewer.camera.position.copy(this.savedCameraState.position);
      this.viewer.controls.target.copy(this.savedCameraState.target);
      this.viewer.camera.lookAt(this.savedCameraState.target);
    }
  }

  /**
   * Deterministically evaluate camera, target, stages and scene triggers at progress u (0.0 to 1.0)
   * @param {number} u - normalized progress [0, 1]
   * @returns {Object} current HUD metadata
   */
  seek(u) {
    const clampedU = Math.max(0.0, Math.min(1.0, u));
    this.progress = clampedU;
    this.currentTime = clampedU * this.duration;

    if (!this.positionCurve || !this.targetCurve) {
      this.setScenario(this.currentScenarioId, this.duration);
    }

    // 1. Evaluate Spline Position & Target LookAt
    const [pos, target] = this.sampleTracks(clampedU);

    this.viewer.camera.position.copy(pos);
    this.viewer.controls.target.copy(target);
    this.viewer.camera.lookAt(target);

    // 2. Determine Active Stage & Trigger Scene Adjustments
    const stageInfo = this._evaluateStage(clampedU);

    // 3. Mark Viewport Dirty
    this.viewer._cutawayDirty = true;
    this.viewer._needsRender = true;
    this.viewer.invalidate();

    const info = {
      progress: clampedU,
      timeSec: this.currentTime,
      duration: this.duration,
      scenarioId: this.currentScenarioId,
      scenarioName: this.getActiveScenario().name,
      ...stageInfo
    };

    for (const cb of this._onUpdateCallbacks) {
      try { cb(info); } catch (e) { console.error(e); }
    }

    return info;
  }

  update(now) {
    if (!this.isPlaying || this.isPaused) return false;
    const dt = (now - this._lastTickTime) / 1000;
    this._lastTickTime = now;
    const boundary = this.scenarioStages[this.activeStageIndex]?.uEnd ?? 1;
    const progress = Math.min(boundary, (this.currentTime + Math.max(0, dt)) / this.duration);
    this.seek(progress);
    if (progress < 1) return true;
    this.releaseControls();
    for (const callback of this._onCompleteCallbacks) callback();
    return false;
  }

  _evaluateStage(u) {
    let stage = this.scenarioStages[0];
    let stageIdx = 0;

    for (let i = 0; i < this.scenarioStages.length; i++) {
      if (u >= this.scenarioStages[i].uStart && (u < this.scenarioStages[i].uEnd || i === this.scenarioStages.length - 1)) {
        stage = this.scenarioStages[i];
        stageIdx = i;
        break;
      }
    }

    if (stageIdx !== this.activeStageIndex) {
      this.activeStageIndex = stageIdx;
      // Execute state changes associated with entering stage
      if (typeof stage.onEnter === 'function') {
        stage.onEnter(this.viewer, this);
      }
      for (const cb of this._onStageChangeCallbacks) {
        try { cb(stage); } catch (e) { console.error(e); }
      }
    }

    if (typeof stage.onProgress === 'function') {
      const stageProgress = (u - stage.uStart) / Math.max(0.0001, stage.uEnd - stage.uStart);
      stage.onProgress(this.viewer, stageProgress, this);
    }

    return {
      stageIndex: stageIdx,
      stageId: stage.id,
      caption: stage.caption,
      subCaption: stage.subCaption,
      badge: stage.badge,
      floorName: stage.floorName || 'Toàn công trình',
      roomName: stage.roomName || ''
    };
  }

  onUpdate(cb) { this._onUpdateCallbacks.add(cb); return () => this._onUpdateCallbacks.delete(cb); }
  onComplete(cb) { this._onCompleteCallbacks.add(cb); return () => this._onCompleteCallbacks.delete(cb); }
  onStageChange(cb) { this._onStageChangeCallbacks.add(cb); return () => this._onStageChangeCallbacks.delete(cb); }

  // =========================================================================
  // SCENARIO 1: FULL ARCHITECTURAL FILM (Cảnh quan -> Tách tầng -> Nội thất)
  // =========================================================================
  buildSafeScenario(bounds, floors) {
    const { cx, cy, maxDim, totalHeight, minX, maxX, minY, maxY } = bounds;
    const radius = Math.hypot((maxX - minX) / 2, (maxY - minY) / 2 + 1.25) + Math.max(1.6, maxDim * 0.16);
    const frontAngle = -Math.PI / 2;
    const outside = (angle, height, distance = radius) =>
      new THREE.Vector3(cx + Math.cos(angle) * distance, height, cy + Math.sin(angle) * distance);
    const target = (height, z = cy, x = cx) => new THREE.Vector3(x, height, z);
    const ease = t => (1 - Math.cos(Math.PI * t)) / 2;
    const exteriorHeight = totalHeight * 0.55;
    const overviewHeight = totalHeight + maxDim * 0.62;
    const overviewAngle = frontAngle + 0.5;
    const overviewRadius = (radius + maxDim * 0.36) * Math.max(1, 0.64 / this.viewer.camera.aspect || 1);
    const stages = [];
    const apply = (v, mode, floorId = null) => {
      v.viewMode = mode;
      v.animatingCamera = false;
      for (const group of v.floorGroups.values()) group.position.y = group.userData.elevation;
      if (floorId) {
        v.isolateFloorUpTo(floorId);
        v.setInteriorLights(true);
      } else {
        this._showAllFloors(v);
        v.options?.onFloorIsolated?.(null);
      }
      v.setRoomLabelsVisible?.(v.roomLabelsVisible);
      v.options?.onTourViewChange?.(mode, v.interiorLightsOn);
      v._invalidateShadowMap?.();
    };

    const showExterior = ['full_film', 'turntable'].includes(this.currentScenarioId) || floors.length === 0;
    if (showExterior) {
      stages.push({
        id: 'exterior_landscape', badge: 'Mặt tiền', caption: 'Ngoại thất 360°', weight: 2.2,
        onEnter: v => apply(v, 'facade'),
        sample: t => [outside(frontAngle + Math.PI * 2 * t, exteriorHeight, overviewRadius), target(totalHeight * 0.43)]
      });
      stages.push({
        id: 'dollhouse', badge: 'Tổng thể', caption: 'Mặt cắt toàn công trình', weight: 1.3,
        onEnter: v => apply(v, 'dollhouse'),
        sample: t => [outside(frontAngle + 0.5 * t, THREE.MathUtils.lerp(exteriorHeight, overviewHeight, t), overviewRadius),
          target(totalHeight * (0.43 + 0.04 * t))]
      });
    }

    if (this.currentScenarioId !== 'turntable') {
      let previous = showExterior ? { angle: overviewAngle, height: overviewHeight, radius: overviewRadius,
        look: target(totalHeight * 0.47) } : null;
      for (const floor of floors) {
        const y = (floor.elevation || 0) + 2.8;
        const lookY = (floor.elevation || 0) + 0.72;
        const rooms = (floor.rooms || []).slice().sort((a, b) => a.y - b.y);
        const front = rooms[0];
        const back = rooms.at(-1);
        const points = [
          target(lookY, front?.y ?? minY + (cy - minY) * 0.5, front?.x ?? cx),
          target(lookY, cy),
          target(lookY, back?.y ?? maxY - (maxY - cy) * 0.5, back?.x ?? cx)
        ];
        // Sweep toward the flank as the target reaches the rear rooms.
        const startAngle = frontAngle + 0.28;
        const endAngle = frontAngle + 1.85;
        const entry = previous;
        const blend = entry ? 0.34 : 0;
        stages.push({
          id: floor.id, badge: floor.name, caption: floor.desc || floor.name, floorName: floor.name, weight: 1.45,
          onEnter: v => apply(v, 'dollhouse', floor.id),
          sample: t => {
            if (entry && t < blend) {
              const f = ease(t / blend);
              return [outside(THREE.MathUtils.lerp(entry.angle, startAngle, f),
                THREE.MathUtils.lerp(entry.height, y, f), THREE.MathUtils.lerp(entry.radius, radius, f)),
                entry.look.clone().lerp(points[0], f)];
            }
            const f = (t - blend) / (1 - blend);
            const firstHalf = f <= 0.5;
            const look = firstHalf ? points[0].clone().lerp(points[1], ease(f * 2))
              : points[1].clone().lerp(points[2], ease(f * 2 - 1));
            return [outside(THREE.MathUtils.lerp(startAngle, endAngle, ease(f)), y), look];
          }
        });
        previous = { angle: endAngle, height: y, radius, look: points[2] };
      }
    }

    const total = stages.reduce((sum, stage) => sum + stage.weight, 0);
    let cursor = 0;
    this.scenarioStages = stages.map(stage => {
      const uStart = cursor / total;
      cursor += stage.weight;
      return { ...stage, uStart, uEnd: cursor / total };
    });
    const sample = u => {
      const stage = this.scenarioStages.find(entry => u < entry.uEnd) || this.scenarioStages.at(-1);
      const local = THREE.MathUtils.clamp((u - stage.uStart) / (stage.uEnd - stage.uStart), 0, 1);
      return stage.sample(stage.floorName ? local : ease(local));
    };
    this.sampleTracks = sample;
    this.positionCurve = { getPointAt: u => sample(u)[0] };
    this.targetCurve = { getPointAt: u => sample(u)[1] };
  }
}
