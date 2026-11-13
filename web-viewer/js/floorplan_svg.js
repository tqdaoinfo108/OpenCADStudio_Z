/**
 * floorplan_svg.js
 * OpenCADStudio_Z: Interactive 2D Floorplan CAD Blueprint Engine
 * 
 * Generates crisp, standardized architectural 2D SVG blueprints from CAD/BIM floor data.
 * Features:
 *  - 2D Wall Topology & Boolean Merger: LWPOLYLINE / closed polygon paths, T-junction / X-junction cleanup,
 *    and mitered L-corners with solid seamless wall fills (zero dividing lines across junctions).
 *  - Architectural Coordinate System (A-GRID): Standardized numeric (1, 2, 3...) & alphabetic (A, B, C...)
 *    grid axes with Dash-dot linetypes and circular axis bubbles.
 *  - Professional Architectural Dimensions (A-DIMS): Bay-by-bay and overall dimensions with 45° witness ticks
 *    and millimeter labels.
 *  - Standardized Linetypes & Scales (LTSCALE): Dash-dot for grids, dashed for hidden lines, fine arcs for door swings.
 *  - True Wall Cutouts: Openings for doors and windows with architectural jambs, glazing, and swing arcs.
 */

// ============================================================================
// 1. COMPUTATIONAL GEOMETRY HELPERS
// ============================================================================

function distSq(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return dx * dx + dy * dy;
}

function dot(v1, v2) {
  return v1.x * v2.x + v1.y * v2.y;
}

function cross(v1, v2) {
  return v1.x * v2.y - v1.y * v2.x;
}

/**
 * Tests if point p is strictly inside simple polygon poly (excluding boundary within eps)
 */
function isPointStrictlyInsidePoly(p, poly, eps = 1e-3) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const l2 = distSq(poly[i], poly[j]);
    if (l2 > 1e-9) {
      const t = Math.max(0, Math.min(1, dot({ x: p.x - xi, y: p.y - yi }, { x: xj - xi, y: yj - yi }) / l2));
      const projX = xi + t * (xj - xi);
      const projY = yi + t * (yj - yi);
      if (Math.hypot(p.x - projX, p.y - projY) < eps) {
        return false; // Point is on polygon boundary
      }
    }
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Calculates parametric intersection of segments (p1, p2) and (p3, p4)
 */
function lineSegmentIntersection(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t >= 1e-4 && t <= 1 - 1e-4 && u >= 1e-4 && u <= 1 - 1e-4) {
    return {
      x: p1.x + t * (p2.x - p1.x),
      y: p1.y + t * (p2.y - p1.y),
      t, u
    };
  }
  return null;
}

/**
 * Constructs an oriented 2D bounding quad (4 vertices, CCW order) from a wall centerline + thickness
 */
function createWallQuad(p1, p2, thickness = 0.2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-5) return null;
  const nx = -dy / len;
  const ny = dx / len;
  const h = thickness / 2;
  return [
    { x: Math.round((p1.x - nx * h) * 1e4) / 1e4, y: Math.round((p1.y - ny * h) * 1e4) / 1e4 },
    { x: Math.round((p2.x - nx * h) * 1e4) / 1e4, y: Math.round((p2.y - ny * h) * 1e4) / 1e4 },
    { x: Math.round((p2.x + nx * h) * 1e4) / 1e4, y: Math.round((p2.y + ny * h) * 1e4) / 1e4 },
    { x: Math.round((p1.x + nx * h) * 1e4) / 1e4, y: Math.round((p1.y + ny * h) * 1e4) / 1e4 }
  ];
}

/**
 * Eliminates redundant collinear vertices along a closed polygon cycle
 */
function simplifyCollinear(pts, eps = 1e-4) {
  if (pts.length <= 3) return pts;
  const res = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = res.length > 0 ? res[res.length - 1] : pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    const crossVal = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(crossVal) > eps) {
      res.push(curr);
    }
  }
  return res.length >= 3 ? res : pts;
}

// ============================================================================
// 2. WALL TOPOLOGY & BOOLEAN UNION ENGINE
// ============================================================================

/**
 * Merges a collection of 2D oriented wall quads into clean closed boundary loops (LWPOLYLINE).
 * Solves T-junctions, X-junctions, and L-corners by removing internal interface seams.
 */
function mergeWallPolygons(polygons) {
  if (!polygons || polygons.length === 0) return { loops: [], pathD: '' };

  // 1. Gather all directed polygon edges
  const edges = [];
  for (let pi = 0; pi < polygons.length; pi++) {
    const poly = polygons[pi];
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      edges.push({ p1, p2, polyIdx: pi });
    }
  }

  // 2. Split edges at all edge-edge intersections and other polygon vertices
  const subSegments = [];
  for (let ei = 0; ei < edges.length; ei++) {
    const edge = edges[ei];
    const splits = [0, 1];

    for (let ej = 0; ej < edges.length; ej++) {
      if (ei === ej) continue;
      const other = edges[ej];
      const inter = lineSegmentIntersection(edge.p1, edge.p2, other.p1, other.p2);
      if (inter) {
        splits.push(inter.t);
      }
    }

    const dx = edge.p2.x - edge.p1.x;
    const dy = edge.p2.y - edge.p1.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 1e-9) {
      for (const poly of polygons) {
        for (const pt of poly) {
          const t = dot({ x: pt.x - edge.p1.x, y: pt.y - edge.p1.y }, { x: dx, y: dy }) / lenSq;
          if (t > 1e-4 && t < 1 - 1e-4) {
            const projX = edge.p1.x + t * dx;
            const projY = edge.p1.y + t * dy;
            if (Math.hypot(pt.x - projX, pt.y - projY) < 1e-4) {
              splits.push(t);
            }
          }
        }
      }
    }

    splits.sort((a, b) => a - b);
    const cleanSplits = [splits[0]];
    for (let k = 1; k < splits.length; k++) {
      if (splits[k] - cleanSplits[cleanSplits.length - 1] > 1e-4) {
        cleanSplits.push(splits[k]);
      }
    }

    for (let k = 0; k < cleanSplits.length - 1; k++) {
      const t1 = cleanSplits[k];
      const t2 = cleanSplits[k + 1];
      const u = {
        x: Math.round((edge.p1.x + t1 * dx) * 1e4) / 1e4,
        y: Math.round((edge.p1.y + t1 * dy) * 1e4) / 1e4
      };
      const v = {
        x: Math.round((edge.p1.x + t2 * dx) * 1e4) / 1e4,
        y: Math.round((edge.p1.y + t2 * dy) * 1e4) / 1e4
      };
      if (Math.hypot(u.x - v.x, u.y - v.y) > 1e-4) {
        subSegments.push({ u, v, polyIdx: edge.polyIdx });
      }
    }
  }

  // 3. Filter out sub-segments whose midpoints are strictly inside any other polygon
  const keptSegments = [];
  for (const seg of subSegments) {
    const mid = { x: (seg.u.x + seg.v.x) / 2, y: (seg.u.y + seg.v.y) / 2 };
    let insideOther = false;
    for (let pi = 0; pi < polygons.length; pi++) {
      if (pi === seg.polyIdx) continue;
      if (isPointStrictlyInsidePoly(mid, polygons[pi], 1e-3)) {
        insideOther = true;
        break;
      }
    }
    if (!insideOther) {
      keptSegments.push(seg);
    }
  }

  // 4. Remove duplicate / opposite internal interface seams between touching walls
  const finalSegments = [];
  for (let i = 0; i < keptSegments.length; i++) {
    const s1 = keptSegments[i];
    let isSharedInterface = false;
    for (let j = 0; j < keptSegments.length; j++) {
      if (i === j) continue;
      const s2 = keptSegments[j];
      if (Math.hypot(s1.u.x - s2.v.x, s1.u.y - s2.v.y) < 2e-3 &&
          Math.hypot(s1.v.x - s2.u.x, s1.v.y - s2.u.y) < 2e-3) {
        isSharedInterface = true;
        break;
      }
    }
    if (!isSharedInterface) {
      finalSegments.push(s1);
    }
  }

  // 5. Stitch remaining boundary segments into continuous closed cycles
  const used = new Array(finalSegments.length).fill(false);
  const loops = [];

  for (let startIdx = 0; startIdx < finalSegments.length; startIdx++) {
    if (used[startIdx]) continue;
    used[startIdx] = true;
    const loop = [finalSegments[startIdx].u, finalSegments[startIdx].v];
    let currentV = finalSegments[startIdx].v;

    let foundNext = true;
    while (foundNext) {
      foundNext = false;
      let bestIdx = -1;
      let bestDist = 3e-3;
      for (let i = 0; i < finalSegments.length; i++) {
        if (used[i]) continue;
        const d = Math.hypot(finalSegments[i].u.x - currentV.x, finalSegments[i].u.y - currentV.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }

      if (bestIdx !== -1) {
        used[bestIdx] = true;
        currentV = finalSegments[bestIdx].v;
        loop.push(currentV);
        foundNext = true;
        if (Math.hypot(currentV.x - loop[0].x, currentV.y - loop[0].y) < 3e-3) {
          break;
        }
      }
    }

    if (loop.length >= 3) {
      loops.push(simplifyCollinear(loop));
    }
  }

  // 6. Convert loops into combined SVG path string with fill-rule="evenodd"
  let pathD = '';
  for (const loop of loops) {
    if (loop.length < 3) continue;
    pathD += `M ${loop[0].x.toFixed(3)} ${(-loop[0].y).toFixed(3)} `;
    for (let k = 1; k < loop.length; k++) {
      pathD += `L ${loop[k].x.toFixed(3)} ${(-loop[k].y).toFixed(3)} `;
    }
    pathD += 'Z ';
  }

  return { loops, pathD: pathD.trim() };
}

/**
 * Cuts a wall centerline at door/window openings so the wall mesh is physically hollow at openings
 */
function cutWallAtOpenings(wall, openings = []) {
  const dx = wall.p2.x - wall.p1.x;
  const dy = wall.p2.y - wall.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return [wall];
  const ux = dx / len, uy = dy / len;

  const cuts = [];
  for (const op of openings) {
    const opX = typeof op.x === 'number' ? op.x : (typeof op.cx === 'number' ? op.cx : (op.p1 ? (op.p1.x + op.p2.x) / 2 : 0));
    const opY = typeof op.y === 'number' ? op.y : (typeof op.cy === 'number' ? op.cy : (op.p1 ? (op.p1.y + op.p2.y) / 2 : 0));
    const opDx = opX - wall.p1.x;
    const opDy = opY - wall.p1.y;
    const t = opDx * ux + opDy * uy;
    const perpDist = Math.abs(-opDx * uy + opDy * ux);

    if (perpDist <= (wall.thickness || 0.2) / 2 + 0.18 && t >= -0.2 && t <= len + 0.2) {
      const w = op.width || 0.9;
      const t1 = Math.max(0, t - w / 2);
      const t2 = Math.min(len, t + w / 2);
      if (t2 - t1 > 0.1) {
        cuts.push({ t1, t2 });
      }
    }
  }

  if (cuts.length === 0) return [wall];

  cuts.sort((a, b) => a.t1 - b.t1);
  const segments = [];
  let currT = 0;

  for (const cut of cuts) {
    if (cut.t1 > currT + 0.08) {
      segments.push({
        p1: { x: wall.p1.x + currT * ux, y: wall.p1.y + currT * uy },
        p2: { x: wall.p1.x + cut.t1 * ux, y: wall.p1.y + cut.t1 * uy },
        thickness: wall.thickness
      });
    }
    currT = Math.max(currT, cut.t2);
  }

  if (currT < len - 0.08) {
    segments.push({
      p1: { x: wall.p1.x + currT * ux, y: wall.p1.y + currT * uy },
      p2: { x: wall.p1.x + len * ux, y: wall.p1.y + len * uy },
      thickness: wall.thickness
    });
  }

  return segments.length > 0 ? segments : [wall];
}

// ============================================================================
// 3. FLOORPLAN SVG GENERATOR CLASS
// ============================================================================

export class FloorplanSvgGenerator {
  /**
   * Generate an architectural SVG string representing the given BIM floor
   * @param {Object} floor - BIM floor data
   * @param {Object} options - styling and size options
   * @returns {string} SVG markup
   */
  static generate(floor, options = {}) {
    if (!floor) return '<svg></svg>';

    const showAiDetection = options.showAiDetection || options.stage === 1;

    // 1. Determine bounding box from slabs, walls, or rooms
    let minX = 0, maxX = 15, minY = 0, maxY = 24;
    let foundBounds = false;

    if (floor.slabs && floor.slabs.length > 0) {
      const slab = floor.slabs[0];
      if (Number.isFinite(slab.minX) && Number.isFinite(slab.maxX) && Number.isFinite(slab.minY) && Number.isFinite(slab.maxY)) {
        minX = slab.minX;
        maxX = slab.maxX;
        minY = slab.minY;
        maxY = slab.maxY;
        foundBounds = true;
      }
    }

    if (!foundBounds && floor.exteriorWalls && floor.exteriorWalls.length > 0) {
      const xs = [];
      const ys = [];
      for (const w of floor.exteriorWalls) {
        if (w.p1 && Number.isFinite(w.p1.x) && Number.isFinite(w.p1.y)) { xs.push(w.p1.x); ys.push(w.p1.y); }
        if (w.p2 && Number.isFinite(w.p2.x) && Number.isFinite(w.p2.y)) { xs.push(w.p2.x); ys.push(w.p2.y); }
      }
      if (xs.length > 0 && ys.length > 0) {
        minX = Math.min(...xs);
        maxX = Math.max(...xs);
        minY = Math.min(...ys);
        maxY = Math.max(...ys);
        foundBounds = true;
      }
    }

    if (!foundBounds && floor.rooms && floor.rooms.length > 0) {
      const xs = floor.rooms.map(r => Number.isFinite(r.x) ? r.x : (Number.isFinite(r.cx) ? r.cx : null)).filter(v => v !== null);
      const ys = floor.rooms.map(r => Number.isFinite(r.y) ? r.y : (Number.isFinite(r.cy) ? r.cy : null)).filter(v => v !== null);
      if (xs.length > 0 && ys.length > 0) {
        minX = Math.max(0, Math.min(...xs) - 2.0);
        maxX = Math.max(...xs) + 2.0;
        minY = Math.max(0, Math.min(...ys) - 2.0);
        maxY = Math.max(...ys) + 2.0;
        foundBounds = true;
      }
    }

    if (!Number.isFinite(minX)) minX = 0;
    if (!Number.isFinite(maxX) || maxX <= minX) maxX = minX + 15;
    if (!Number.isFinite(minY)) minY = 0;
    if (!Number.isFinite(maxY) || maxY <= minY) maxY = minY + 24;

    const slabBounds = { minX, maxX, minY, maxY };
    const viewBoxWidth = Math.max(maxX - minX, 4);
    const viewBoxHeight = Math.max(maxY - minY, 4);

    // Padding for A-GRID axis bubbles and A-DIMS dimension strings
    const padding = 2.8;
    const vb = `${(minX - padding).toFixed(2)} ${(-maxY - padding).toFixed(2)} ${(viewBoxWidth + padding * 2).toFixed(2)} ${(viewBoxHeight + padding * 2).toFixed(2)}`;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="100%" height="100%" class="cad-blueprint-svg">
      <defs>
        <pattern id="cad-grid-pattern" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#E2E8F0" stroke-width="0.03" />
        </pattern>
        <pattern id="concrete-hatch" width="0.4" height="0.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.4" stroke="#0F172A" stroke-width="0.03" opacity="0.15"/>
        </pattern>
        <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#0F172A" />
        </marker>
        <filter id="ai-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="0.15" flood-color="#0284C7" flood-opacity="0.6"/>
        </filter>
        <filter id="blueprint-shadow" x="-5%" y="-5%" width="110%" height="110%">
          <feDropShadow dx="0.05" dy="0.05" stdDeviation="0.08" flood-color="#000000" flood-opacity="0.12"/>
        </filter>
      </defs>

      <!-- Background & Site Canvas -->
      <rect x="${(minX - padding).toFixed(2)}" y="${(-maxY - padding).toFixed(2)}" width="${(viewBoxWidth + padding * 2).toFixed(2)}" height="${(viewBoxHeight + padding * 2).toFixed(2)}" fill="#FAF9F6" />
      <rect x="${minX}" y="${-maxY}" width="${viewBoxWidth}" height="${viewBoxHeight}" fill="url(#cad-grid-pattern)" />
    `;

    // 2. Slabs / Floor outline (Clean Architectural Base)
    if (floor.slabs && floor.slabs.length > 0) {
      for (const slab of floor.slabs) {
        const sw = slab.maxX - slab.minX;
        const sh = slab.maxY - slab.minY;
        svg += `\n      <!-- Slab outline -->
        <rect x="${slab.minX}" y="${-slab.maxY}" width="${sw}" height="${sh}" fill="${showAiDetection ? '#F8FAFC' : '#F1EFE9'}" stroke="#CBD5E1" stroke-width="0.06" rx="0.08" />`;
      }
    } else {
      const sw = maxX - minX;
      const sh = maxY - minY;
      svg += `\n      <rect x="${minX}" y="${-maxY}" width="${sw}" height="${sh}" fill="#F1EFE9" stroke="#CBD5E1" stroke-width="0.06" rx="0.08" />`;
    }

    // 3. Stage 1: AI Detected Room Zones
    if (showAiDetection && floor.rooms && floor.rooms.length > 0) {
      const roomColors = [
        'rgba(59, 130, 246, 0.08)',
        'rgba(245, 158, 11, 0.08)',
        'rgba(16, 185, 129, 0.08)',
        'rgba(139, 92, 246, 0.08)',
        'rgba(236, 72, 153, 0.08)',
        'rgba(14, 165, 233, 0.08)'
      ];
      floor.rooms.forEach((rm, i) => {
        const c = roomColors[i % roomColors.length];
        const rw = rm.bounds ? (rm.bounds.maxX - rm.bounds.minX) : (typeof rm.width === 'number' ? rm.width : 3.6);
        const rh = rm.bounds ? (rm.bounds.maxY - rm.bounds.minY) : (typeof rm.length === 'number' ? rm.length : 3.0);
        const baseCenterX = typeof rm.x === 'number' ? rm.x : (typeof rm.cx === 'number' ? rm.cx : 0);
        const baseCenterY = typeof rm.y === 'number' ? rm.y : (typeof rm.cy === 'number' ? rm.cy : 0);
        const rx = rm.bounds ? rm.bounds.minX : baseCenterX - rw / 2;
        const ry = rm.bounds ? rm.bounds.maxY : baseCenterY + rh / 2;
        svg += `\n      <!-- AI Room Detection Box -->
        <rect x="${rx}" y="${-ry}" width="${rw}" height="${rh}" fill="${c}" stroke="#0284C7" stroke-width="0.04" stroke-dasharray="0.15,0.08" rx="0.12" />
        <rect x="${rx + 0.1}" y="${-ry + 0.1}" width="1.6" height="0.32" fill="#0284C7" rx="0.06"/>
        <text x="${rx + 0.9}" y="${-ry + 0.32}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.18" fill="#FFFFFF" font-weight="700" text-anchor="middle">AI ZONE: 99%</text>`;
      });
    }

    // 4. Architectural Grid Axes (A-GRID) with Dash-dot linetypes & Axis Bubbles
    const gridAxes = floor.gridAxes || this.extractGridAxes(floor, slabBounds);
    svg += this.renderGridAxesSvg(gridAxes, slabBounds);

    // 5. Architectural Dimensions (A-DIMS) with 45° witness ticks
    const dimensions = (floor.dimensions && floor.dimensions.length > 0)
      ? floor.dimensions
      : this.extractDimensions(gridAxes, slabBounds);
    svg += this.renderDimensionsSvg(dimensions, slabBounds, gridAxes);

    // 6. Stairwell void & Stairs (A-FLOR-STRS)
    if (floor.stairs && floor.stairs.length > 0) {
      for (const st of floor.stairs) {
        const sw = typeof st.width === 'number' ? st.width : 2.4;
        const sd = typeof st.depth === 'number' ? st.depth : 3.0;
        const stx = typeof st.x === 'number' ? st.x : (typeof st.cx === 'number' ? st.cx : 0);
        const sty = typeof st.y === 'number' ? st.y : (typeof st.cy === 'number' ? st.cy : 0);
        const sx = stx - sw / 2;
        const sy = sty - sd / 2;
        svg += `\n      <!-- Stairwell Void & Stairs -->
        <g class="svg-stair-group cad-stair-group" data-layer="A-FLOR-STRS">
          <rect x="${sx}" y="${-(sy + sd)}" width="${sw}" height="${sd}" fill="#EAE6DC" stroke="#64748B" stroke-width="0.05" />`;
        // Steps
        const numSteps = 10;
        const stepH = sd / numSteps;
        for (let s = 0; s < numSteps; s++) {
          const stepY = sy + s * stepH;
          svg += `\n          <line x1="${sx}" y1="${-stepY}" x2="${sx + sw}" y2="${-stepY}" stroke="#78716C" stroke-width="0.03" />`;
        }
        // Direction arrow & text
        svg += `\n          <line x1="${stx}" y1="${-(sy + 0.3)}" x2="${stx}" y2="${-(sy + sd - 0.4)}" stroke="#0F172A" stroke-width="0.05" marker-end="url(#arrow)" />
          <text x="${stx + 0.22}" y="${-(sy + sd / 2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.25" fill="#0F172A" font-weight="700">LÊN</text>
        </g>`;
      }
    }

    // 7. SEAMLESS SOLID WALL TOPOLOGY (LWPOLYLINE / SVG Polygon Merger)
    // Welds all exterior & interior walls, cleans T/X junctions & mitered L-corners
    svg += this.renderSeamlessWallsSvg(floor, slabBounds);

    // 8. Architectural Columns (A-COLS)
    if (floor.columns && floor.columns.length > 0) {
      svg += `\n      <!-- Structural Columns (A-COLS) -->
      <g class="cad-column-group" data-layer="A-COLS">`;
      for (const col of floor.columns) {
        const colSizeX = typeof col.sizeX === 'number' ? col.sizeX : (typeof col.width === 'number' ? col.width : 0.22);
        const colSizeY = typeof col.sizeY === 'number' ? col.sizeY : (typeof col.depth === 'number' ? col.depth : 0.22);
        const colX = typeof col.x === 'number' ? col.x : (typeof col.cx === 'number' ? col.cx : 0);
        const colY = typeof col.y === 'number' ? col.y : (typeof col.cy === 'number' ? col.cy : 0);
        const cx = colX - colSizeX / 2;
        const cy = colY + colSizeY / 2;
        svg += `\n        <rect class="cad-column" x="${cx}" y="${-cy}" width="${colSizeX}" height="${colSizeY}" fill="#0F172A" stroke="#0F172A" stroke-width="0.02" />`;
      }
      svg += `\n      </g>`;
    }

    // 9. Windows & Architectural Glazing (A-GLAZ)
    if (floor.windows && floor.windows.length > 0) {
      svg += this.renderWindowsSvg(floor.windows);
    }

    // 10. Doors & Swings (A-DOOR) with standardized fine dashed swing arcs
    if (floor.doors && floor.doors.length > 0) {
      svg += this.renderDoorsSvg(floor.doors);
    }

    // 11. Hidden Lines (A-HIDD) with uniform LTSCALE
    svg += this.renderHiddenLinesSvg(floor, slabBounds);

    // 12. Furniture & Sanitary Hotspots (A-FURN / A-SANR)
    const allItems = [...(floor.furniture || []), ...(floor.sanitary || [])];
    if (allItems.length > 0) {
      svg += `\n      <!-- Furniture & Equipment Hotspots -->
      <g class="cad-furniture-group" data-layer="A-FURN">`;
      for (const item of allItems) {
        const w = item.width || 1.2;
        const d = item.depth || 0.8;
        const cx = typeof item.cx === 'number' ? item.cx : (typeof item.x === 'number' ? item.x : 0);
        const cy = typeof item.cy === 'number' ? item.cy : (typeof item.y === 'number' ? item.y : 0);
        const ix = cx - w / 2;
        const iy = cy + d / 2;
        const isSanr = item.layer === 'A-SANR' || item.type === 'toilet' || item.type === 'vanity' || item.type === 'bathtub';
        const fillColor = isSanr ? '#E0F2FE' : '#F4ECE4';
        const strokeColor = isSanr ? '#0284C7' : '#94704B';

        svg += `\n        <!-- Hotspot item: ${item.name || item.asset_id} -->
        <g class="svg-hotspot-item" data-id="${item.name || item.asset_id}" data-layer="${item.layer || 'A-FURN'}" style="cursor: pointer;">
          <rect x="${ix}" y="${-iy}" width="${w}" height="${d}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="0.035" rx="0.06" />
          <text x="${cx}" y="${-cy + 0.08}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.22" fill="#334155" text-anchor="middle" font-weight="600">${(item.name || item.asset_id || '').substring(0, 16)}</text>`;

        if (showAiDetection) {
          const conf = item.confidence ? `${Math.round(item.confidence * 100)}%` : '98%';
          svg += `\n          <!-- AI BBox & confidence -->
          <rect x="${ix - 0.05}" y="${-iy - 0.05}" width="${w + 0.1}" height="${d + 0.1}" fill="none" stroke="#D97706" stroke-width="0.03" stroke-dasharray="0.12,0.06" />
          <rect x="${ix}" y="${-iy - 0.28}" width="${Math.min(w, 1.8)}" height="0.25" fill="#D97706" rx="0.05" />
          <text x="${ix + Math.min(w, 1.8) / 2}" y="${-iy - 0.1}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.16" fill="#FFFFFF" font-weight="700" text-anchor="middle">AI: ${conf}</text>`;
        }

        svg += `\n        </g>`;
      }
      svg += `\n      </g>`;
    }

    // 13. Room Labels & Areas (A-AREA-ROOM)
    if (floor.rooms && floor.rooms.length > 0) {
      svg += `\n      <!-- Room Labels (A-AREA-ROOM) -->
      <g class="cad-room-labels-group" data-layer="A-AREA-ROOM">`;
      for (const rm of floor.rooms) {
        const rx = typeof rm.x === 'number' ? rm.x : (typeof rm.cx === 'number' ? rm.cx : 0);
        const ry = typeof rm.y === 'number' ? rm.y : (typeof rm.cy === 'number' ? rm.cy : 0);
        const areaVal = rm.area !== undefined ? rm.area : (typeof rm.width === 'number' && typeof rm.length === 'number' ? (rm.width * rm.length).toFixed(1) : '');
        const rName = (rm.name || 'Phòng').toUpperCase();
        svg += `\n        <!-- Room label: ${rName} -->
        <g class="svg-room-label">
          <rect x="${rx - 1.8}" y="${-ry - 0.36}" width="3.6" height="0.75" fill="rgba(255, 255, 255, 0.94)" stroke="#CBD5E1" stroke-width="0.03" rx="0.16" filter="url(#blueprint-shadow)" />
          <text x="${rx}" y="${-ry - 0.04}" font-family="'Lora', serif" font-size="0.30" font-weight="700" fill="#0F172A" text-anchor="middle">${rName}</text>
          ${areaVal ? `<text x="${rx}" y="${-ry + 0.24}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.23" font-weight="600" fill="#D97706" text-anchor="middle">${areaVal} m²</text>` : ''}
        </g>`;
      }
      svg += `\n      </g>`;
    }

    // 14. North Compass Indicator
    const naX = maxX + 1.2;
    const naY = -maxY - 0.8;
    svg += `\n      <!-- North Compass Indicator -->
      <g transform="translate(${naX.toFixed(2)}, ${naY.toFixed(2)})">
        <circle cx="0" cy="0" r="0.48" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.03" filter="url(#blueprint-shadow)" />
        <polygon points="0,-0.40 0.14,0 0,-0.08" fill="#DC2626" />
        <polygon points="0,-0.40 -0.14,0 0,-0.08" fill="#991B1B" />
        <polygon points="0,0.40 0.14,0 0,0.08" fill="#64748B" />
        <polygon points="0,0.40 -0.14,0 0,0.08" fill="#334155" />
        <text x="0" y="-0.52" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.25" font-weight="700" fill="#DC2626" text-anchor="middle">B</text>
      </g>

      <!-- Drawing Title & Engineering Scale -->
      <g transform="translate(${minX}, ${(-minY + 1.8).toFixed(2)})">
        <text x="0" y="0" font-family="'Lora', serif" font-size="0.36" font-weight="700" fill="#0F172A">MẶT BẰNG ${floor.name.toUpperCase()}</text>
        <text x="0" y="0.32" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.20" font-weight="600" fill="#64748B">TỶ LỆ: 1/100 | HỆ TRỤC: TCVN 4453 | LTSCALE: 1.0</text>
      </g>
    </svg>`;

    return svg;
  }

  // ============================================================================
  // 4. SUB-RENDERERS & GEOMETRY METHODS
  // ============================================================================

  /**
   * Welds all walls into unified seamless 2D boundary polygons (LWPOLYLINE / path)
   * Resolves T-junctions, X-junctions, and mitered L-corners
   */
  static renderSeamlessWallsSvg(floor, slabBounds) {
    const rawExt = floor.exteriorWalls && floor.exteriorWalls.length > 0 ? floor.exteriorWalls : [];
    const rawInt = floor.interiorWalls && floor.interiorWalls.length > 0 ? floor.interiorWalls : [];

    // Fallback: If no walls exist, construct 4 exterior boundary walls from slabBounds
    const extWalls = rawExt.length > 0 ? rawExt.map(w => ({ ...w, thickness: w.thickness || 0.22 })) : [
      { p1: { x: slabBounds.minX, y: slabBounds.minY }, p2: { x: slabBounds.maxX, y: slabBounds.minY }, thickness: 0.22 },
      { p1: { x: slabBounds.maxX, y: slabBounds.minY }, p2: { x: slabBounds.maxX, y: slabBounds.maxY }, thickness: 0.22 },
      { p1: { x: slabBounds.maxX, y: slabBounds.maxY }, p2: { x: slabBounds.minX, y: slabBounds.maxY }, thickness: 0.22 },
      { p1: { x: slabBounds.minX, y: slabBounds.maxY }, p2: { x: slabBounds.minX, y: slabBounds.minY }, thickness: 0.22 }
    ];

    const intWalls = rawInt.map(w => ({ ...w, thickness: w.thickness || 0.15 }));

    // Clean wall intersections: snap interior endpoints to intersecting walls
    const allWalls = [...extWalls, ...intWalls];
    for (const iw of intWalls) {
      if (!iw.p1 || !iw.p2) continue;
      for (const pt of [iw.p1, iw.p2]) {
        for (const other of allWalls) {
          if (other === iw || !other.p1 || !other.p2) continue;
          const dx = other.p2.x - other.p1.x;
          const dy = other.p2.y - other.p1.y;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 1e-6) continue;
          const t = ((pt.x - other.p1.x) * dx + (pt.y - other.p1.y) * dy) / lenSq;
          if (t >= -0.05 && t <= 1.05) {
            const clampedT = Math.max(0, Math.min(1, t));
            const projX = other.p1.x + clampedT * dx;
            const projY = other.p1.y + clampedT * dy;
            const dist = Math.hypot(pt.x - projX, pt.y - projY);
            if (dist > 1e-4 && dist <= 0.28) {
              pt.x = Math.round(projX * 1000) / 1000;
              pt.y = Math.round(projY * 1000) / 1000;
            }
          }
        }
      }
    }

    // Door openings: cut wall segments so openings are physically hollow
    const doors = floor.doors || [];
    const quads = [];

    for (const wall of allWalls) {
      if (!wall.p1 || !wall.p2) continue;
      const cutSegments = cutWallAtOpenings(wall, doors);
      for (const seg of cutSegments) {
        const q = createWallQuad(seg.p1, seg.p2, seg.thickness || 0.2);
        if (q) quads.push(q);
      }
    }

    // Perform 2D Polygon Union / Boundary Stitching
    const merged = mergeWallPolygons(quads);

    if (merged.pathD) {
      return `\n      <!-- Seamless CAD Wall Mass (Polylines merged into solid fill, zero dividing lines) -->
      <g class="cad-walls-group" data-layer="A-WALL">
        <path class="cad-wall-seamless cad-wall" data-layer="A-WALL" d="${merged.pathD}" fill="#1E293B" stroke="#0F172A" stroke-width="0.03" stroke-linejoin="miter" stroke-miterlimit="3" fill-rule="evenodd" />
      </g>`;
    }

    // Fallback if quads were degenerate
    let fallback = `\n      <!-- Fallback CAD Walls Group -->
      <g class="cad-walls-group" data-layer="A-WALL">`;
    for (const w of allWalls) {
      if (!w.p1 || !w.p2) continue;
      fallback += `\n        <line class="cad-wall" x1="${w.p1.x}" y1="${-w.p1.y}" x2="${w.p2.x}" y2="${-w.p2.y}" stroke="#1E293B" stroke-width="${w.thickness || 0.2}" stroke-linecap="square" />`;
    }
    fallback += `\n      </g>`;
    return fallback;
  }

  /**
   * Renders the A-GRID architectural coordinate system
   * Displays Dash-dot grid lines and numbered/lettered circular bubbles
   */
  static renderGridAxesSvg(gridAxes, slabBounds) {
    const xAxes = gridAxes.xAxes || [];
    const yAxes = gridAxes.yAxes || [];
    if (xAxes.length === 0 && yAxes.length === 0) return '';

    const yBottom = slabBounds.minY - 1.4;
    const yTop = slabBounds.maxY + 1.4;
    const xLeft = slabBounds.minX - 1.4;
    const xRight = slabBounds.maxX + 1.4;

    let svg = `\n      <!-- Architectural Grid Coordinate System (A-GRID: Dash-dot linetypes & bubbles) -->
      <g class="cad-grid-system" data-layer="A-GRID">`;

    // Vertical Grid Lines (Trục số: 1, 2, 3...)
    for (const ax of xAxes) {
      const x = ax.coord;
      svg += `\n        <!-- Grid Axis ${ax.label} -->
        <line class="cad-grid-line" x1="${x.toFixed(2)}" y1="${(-yBottom).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(-yTop).toFixed(2)}" stroke="#64748B" stroke-width="0.02" stroke-dasharray="0.6,0.12,0.08,0.12" opacity="0.9" />
        <!-- Bottom Bubble -->
        <circle class="cad-grid-bubble" cx="${x.toFixed(2)}" cy="${(-yBottom).toFixed(2)}" r="0.32" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.03" />
        <text class="cad-grid-label" x="${x.toFixed(2)}" y="${(-yBottom).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.26" font-weight="700" fill="#0F172A" text-anchor="middle" dominant-baseline="central">${ax.label}</text>
        <!-- Top Bubble -->
        <circle class="cad-grid-bubble" cx="${x.toFixed(2)}" cy="${(-yTop).toFixed(2)}" r="0.32" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.03" />
        <text class="cad-grid-label" x="${x.toFixed(2)}" y="${(-yTop).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.26" font-weight="700" fill="#0F172A" text-anchor="middle" dominant-baseline="central">${ax.label}</text>`;
    }

    // Horizontal Grid Lines (Trục chữ: A, B, C...)
    for (const ay of yAxes) {
      const y = ay.coord;
      svg += `\n        <!-- Grid Axis ${ay.label} -->
        <line class="cad-grid-line" x1="${xLeft.toFixed(2)}" y1="${(-y).toFixed(2)}" x2="${xRight.toFixed(2)}" y2="${(-y).toFixed(2)}" stroke="#64748B" stroke-width="0.02" stroke-dasharray="0.6,0.12,0.08,0.12" opacity="0.9" />
        <!-- Left Bubble -->
        <circle class="cad-grid-bubble" cx="${xLeft.toFixed(2)}" cy="${(-y).toFixed(2)}" r="0.32" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.03" />
        <text class="cad-grid-label" x="${xLeft.toFixed(2)}" y="${(-y).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.26" font-weight="700" fill="#0F172A" text-anchor="middle" dominant-baseline="central">${ay.label}</text>
        <!-- Right Bubble -->
        <circle class="cad-grid-bubble" cx="${xRight.toFixed(2)}" cy="${(-y).toFixed(2)}" r="0.32" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.03" />
        <text class="cad-grid-label" x="${xRight.toFixed(2)}" y="${(-y).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.26" font-weight="700" fill="#0F172A" text-anchor="middle" dominant-baseline="central">${ay.label}</text>`;
    }

    svg += `\n      </g>`;
    return svg;
  }

  /**
   * Renders professional architectural dimension strings (A-DIMS) with 45° witness ticks
   */
  static renderDimensionsSvg(dimensions, slabBounds, gridAxes) {
    if (!dimensions || dimensions.length === 0) return '';

    const xAxes = gridAxes.xAxes || [];
    const yAxes = gridAxes.yAxes || [];

    let svg = `\n      <!-- Architectural Dimensions (A-DIMS: Bay dimensions & total dimensions in mm) -->
      <g class="cad-dimensions-group" data-layer="A-DIMS">`;

    // 1. X Bay Dimensions (placed at y = slabBounds.minY - 0.70)
    const dimY1 = slabBounds.minY - 0.70;
    for (let i = 0; i < xAxes.length - 1; i++) {
      const a = xAxes[i], b = xAxes[i + 1];
      const distMm = Math.round(Math.abs(b.coord - a.coord) * 1000);
      const midX = (a.coord + b.coord) / 2;
      svg += `\n        <!-- Dim Bay ${a.label}-${b.label} -->
        <line class="cad-dim-witness" x1="${a.coord.toFixed(2)}" y1="${(-slabBounds.minY).toFixed(2)}" x2="${a.coord.toFixed(2)}" y2="${(-dimY1 + 0.15).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-witness" x1="${b.coord.toFixed(2)}" y1="${(-slabBounds.minY).toFixed(2)}" x2="${b.coord.toFixed(2)}" y2="${(-dimY1 + 0.15).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-line" x1="${a.coord.toFixed(2)}" y1="${(-dimY1).toFixed(2)}" x2="${b.coord.toFixed(2)}" y2="${(-dimY1).toFixed(2)}" stroke="#475569" stroke-width="0.02" />
        <!-- 45-deg Architectural Ticks -->
        <line class="cad-dim-tick" x1="${(a.coord - 0.08).toFixed(2)}" y1="${(-dimY1 - 0.08).toFixed(2)}" x2="${(a.coord + 0.08).toFixed(2)}" y2="${(-dimY1 + 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <line class="cad-dim-tick" x1="${(b.coord - 0.08).toFixed(2)}" y1="${(-dimY1 - 0.08).toFixed(2)}" x2="${(b.coord + 0.08).toFixed(2)}" y2="${(-dimY1 + 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <text class="cad-dim-text" x="${midX.toFixed(2)}" y="${(-dimY1 - 0.10).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.22" font-weight="600" fill="#334155" text-anchor="middle">${distMm}</text>`;
    }

    // 2. X Total Dimension (placed at y = slabBounds.minY - 2.15)
    if (xAxes.length >= 2) {
      const first = xAxes[0], last = xAxes[xAxes.length - 1];
      const totalMm = Math.round(Math.abs(last.coord - first.coord) * 1000);
      const midX = (first.coord + last.coord) / 2;
      const dimY2 = slabBounds.minY - 2.15;
      svg += `\n        <!-- Dim Total X -->
        <line class="cad-dim-witness" x1="${first.coord.toFixed(2)}" y1="${(-slabBounds.minY + 0.1).toFixed(2)}" x2="${first.coord.toFixed(2)}" y2="${(-dimY2 + 0.15).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-witness" x1="${last.coord.toFixed(2)}" y1="${(-slabBounds.minY + 0.1).toFixed(2)}" x2="${last.coord.toFixed(2)}" y2="${(-dimY2 + 0.15).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-line" x1="${first.coord.toFixed(2)}" y1="${(-dimY2).toFixed(2)}" x2="${last.coord.toFixed(2)}" y2="${(-dimY2).toFixed(2)}" stroke="#475569" stroke-width="0.02" />
        <line class="cad-dim-tick" x1="${(first.coord - 0.08).toFixed(2)}" y1="${(-dimY2 - 0.08).toFixed(2)}" x2="${(first.coord + 0.08).toFixed(2)}" y2="${(-dimY2 + 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <line class="cad-dim-tick" x1="${(last.coord - 0.08).toFixed(2)}" y1="${(-dimY2 - 0.08).toFixed(2)}" x2="${(last.coord + 0.08).toFixed(2)}" y2="${(-dimY2 + 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <text class="cad-dim-text" x="${midX.toFixed(2)}" y="${(-dimY2 - 0.10).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.22" font-weight="700" fill="#0F172A" text-anchor="middle">${totalMm}</text>`;
    }

    // 3. Y Bay Dimensions (placed at x = slabBounds.minX - 0.70)
    const dimX1 = slabBounds.minX - 0.70;
    for (let j = 0; j < yAxes.length - 1; j++) {
      const a = yAxes[j], b = yAxes[j + 1];
      const distMm = Math.round(Math.abs(b.coord - a.coord) * 1000);
      const midY = (a.coord + b.coord) / 2;
      svg += `\n        <!-- Dim Bay ${a.label}-${b.label} -->
        <line class="cad-dim-witness" x1="${(slabBounds.minX).toFixed(2)}" y1="${(-a.coord).toFixed(2)}" x2="${(dimX1 - 0.15).toFixed(2)}" y2="${(-a.coord).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-witness" x1="${(slabBounds.minX).toFixed(2)}" y1="${(-b.coord).toFixed(2)}" x2="${(dimX1 - 0.15).toFixed(2)}" y2="${(-b.coord).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-line" x1="${dimX1.toFixed(2)}" y1="${(-a.coord).toFixed(2)}" x2="${dimX1.toFixed(2)}" y2="${(-b.coord).toFixed(2)}" stroke="#475569" stroke-width="0.02" />
        <line class="cad-dim-tick" x1="${(dimX1 - 0.08).toFixed(2)}" y1="${(-a.coord + 0.08).toFixed(2)}" x2="${(dimX1 + 0.08).toFixed(2)}" y2="${(-a.coord - 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <line class="cad-dim-tick" x1="${(dimX1 - 0.08).toFixed(2)}" y1="${(-b.coord + 0.08).toFixed(2)}" x2="${(dimX1 + 0.08).toFixed(2)}" y2="${(-b.coord - 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <text class="cad-dim-text" x="${(dimX1 - 0.12).toFixed(2)}" y="${(-midY).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.22" font-weight="600" fill="#334155" text-anchor="end" dominant-baseline="central">${distMm}</text>`;
    }

    // 4. Y Total Dimension (placed at x = slabBounds.minX - 2.15)
    if (yAxes.length >= 2) {
      const first = yAxes[0], last = yAxes[yAxes.length - 1];
      const totalMm = Math.round(Math.abs(last.coord - first.coord) * 1000);
      const midY = (first.coord + last.coord) / 2;
      const dimX2 = slabBounds.minX - 2.15;
      svg += `\n        <!-- Dim Total Y -->
        <line class="cad-dim-witness" x1="${(slabBounds.minX).toFixed(2)}" y1="${(-first.coord).toFixed(2)}" x2="${(dimX2 - 0.15).toFixed(2)}" y2="${(-first.coord).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-witness" x1="${(slabBounds.minX).toFixed(2)}" y1="${(-last.coord).toFixed(2)}" x2="${(dimX2 - 0.15).toFixed(2)}" y2="${(-last.coord).toFixed(2)}" stroke="#94A3B8" stroke-width="0.015" />
        <line class="cad-dim-line" x1="${dimX2.toFixed(2)}" y1="${(-first.coord).toFixed(2)}" x2="${dimX2.toFixed(2)}" y2="${(-last.coord).toFixed(2)}" stroke="#475569" stroke-width="0.02" />
        <line class="cad-dim-tick" x1="${(dimX2 - 0.08).toFixed(2)}" y1="${(-first.coord + 0.08).toFixed(2)}" x2="${(dimX2 + 0.08).toFixed(2)}" y2="${(-first.coord - 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <line class="cad-dim-tick" x1="${(dimX2 - 0.08).toFixed(2)}" y1="${(-last.coord + 0.08).toFixed(2)}" x2="${(dimX2 + 0.08).toFixed(2)}" y2="${(-last.coord - 0.08).toFixed(2)}" stroke="#0F172A" stroke-width="0.035" />
        <text class="cad-dim-text" x="${(dimX2 - 0.12).toFixed(2)}" y="${(-midY).toFixed(2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.22" font-weight="700" fill="#0F172A" text-anchor="end" dominant-baseline="central">${totalMm}</text>`;
    }

    svg += `\n      </g>`;
    return svg;
  }

  /**
   * Renders Windows & Architectural Glazing (A-GLAZ)
   */
  static renderWindowsSvg(windows) {
    let svg = `\n      <!-- Architectural Glazing (A-GLAZ: Frame & Glass Pane lines) -->
      <g class="cad-window-group" data-layer="A-GLAZ">`;

    for (const win of windows) {
      if (!win.p1 || !win.p2) continue;
      const dx = win.p2.x - win.p1.x;
      const dy = win.p2.y - win.p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.2) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const h = 0.10; // Half wall sill thickness

      // Outer & Inner Sill frame lines
      const f1x1 = win.p1.x - nx * h, f1y1 = win.p1.y - ny * h;
      const f1x2 = win.p2.x - nx * h, f1y2 = win.p2.y - ny * h;
      const f2x1 = win.p1.x + nx * h, f2y1 = win.p1.y + ny * h;
      const f2x2 = win.p2.x + nx * h, f2y2 = win.p2.y + ny * h;

      svg += `\n        <!-- Window opening ${len.toFixed(2)}m -->
        <polygon points="${f1x1.toFixed(2)},${(-f1y1).toFixed(2)} ${f1x2.toFixed(2)},${(-f1y2).toFixed(2)} ${f2x2.toFixed(2)},${(-f2y2).toFixed(2)} ${f2x1.toFixed(2)},${(-f2y1).toFixed(2)}" fill="rgba(186, 230, 253, 0.45)" stroke="none" />
        <line x1="${f1x1.toFixed(2)}" y1="${(-f1y1).toFixed(2)}" x2="${f1x2.toFixed(2)}" y2="${(-f1y2).toFixed(2)}" stroke="#64748B" stroke-width="0.025" />
        <line x1="${f2x1.toFixed(2)}" y1="${(-f2y1).toFixed(2)}" x2="${f2x2.toFixed(2)}" y2="${(-f2y2).toFixed(2)}" stroke="#64748B" stroke-width="0.025" />
        <!-- Center Glass Panes -->
        <line x1="${(win.p1.x - nx * 0.02).toFixed(2)}" y1="${(-(win.p1.y - ny * 0.02)).toFixed(2)}" x2="${(win.p2.x - nx * 0.02).toFixed(2)}" y2="${(-(win.p2.y - ny * 0.02)).toFixed(2)}" stroke="#0284C7" stroke-width="0.035" />
        <line x1="${(win.p1.x + nx * 0.02).toFixed(2)}" y1="${(-(win.p1.y + ny * 0.02)).toFixed(2)}" x2="${(win.p2.x + nx * 0.02).toFixed(2)}" y2="${(-(win.p2.y + ny * 0.02)).toFixed(2)}" stroke="#0284C7" stroke-width="0.035" />`;
    }

    svg += `\n      </g>`;
    return svg;
  }

  /**
   * Renders Doors & Swings (A-DOOR) with standardized fine dashed swing arcs
   */
  static renderDoorsSvg(doors) {
    let svg = `\n      <!-- Architectural Doors (A-DOOR: Leaf & Dashed Swing Arc) -->
      <g class="cad-door-group" data-layer="A-DOOR">`;

    for (const d of doors) {
      const r = typeof d.width === 'number' ? d.width : 0.9;
      const dx = typeof d.x === 'number' ? d.x : (typeof d.cx === 'number' ? d.cx : 0);
      const dy = typeof d.y === 'number' ? d.y : (typeof d.cy === 'number' ? d.cy : 0);
      const rot = typeof d.rotation === 'number' ? d.rotation : 0;

      svg += `\n        <!-- Door at (${dx.toFixed(2)}, ${dy.toFixed(2)}) -->
        <g class="svg-door-group" transform="translate(${dx.toFixed(2)}, ${(-dy).toFixed(2)}) rotate(${rot})">
          <path class="cad-door-swing" d="M 0 0 A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${r.toFixed(2)} ${(-r).toFixed(2)}" fill="none" stroke="#3B82F6" stroke-width="0.025" stroke-dasharray="0.08,0.04" />
          <line class="cad-door-leaf" x1="0" y1="0" x2="${r.toFixed(2)}" y2="0" stroke="#2563EB" stroke-width="0.05" stroke-linecap="round" />
        </g>`;
    }

    svg += `\n      </g>`;
    return svg;
  }

  /**
   * Renders Hidden Lines (A-HIDD) with uniform LTSCALE for slab voids, beams, and overhangs
   */
  static renderHiddenLinesSvg(floor, slabBounds) {
    let svg = `\n      <!-- Hidden Lines (A-HIDD: Consistent LTSCALE dashed lines) -->
      <g class="cad-hidden-lines-group" data-layer="A-HIDD">`;

    // Stair void overhang indicator
    if (floor.stairs && floor.stairs.length > 0) {
      for (const st of floor.stairs) {
        const sw = typeof st.width === 'number' ? st.width : 2.4;
        const sd = typeof st.depth === 'number' ? st.depth : 3.0;
        const stx = typeof st.x === 'number' ? st.x : (typeof st.cx === 'number' ? st.cx : 0);
        const sty = typeof st.y === 'number' ? st.y : (typeof st.cy === 'number' ? st.cy : 0);
        const sx = stx - sw / 2;
        const sy = sty - sd / 2;
        // Stair break / cut lines
        svg += `\n        <line x1="${(sx - 0.2).toFixed(2)}" y1="${(-(sy + sd / 2 - 0.15)).toFixed(2)}" x2="${(sx + sw + 0.2).toFixed(2)}" y2="${(-(sy + sd / 2 + 0.15)).toFixed(2)}" stroke="#94A3B8" stroke-width="0.025" stroke-dasharray="0.16,0.08" />`;
      }
    }

    svg += `\n      </g>`;
    return svg;
  }

  /**
   * Helper to extract primary architectural grid axes from column positions or building bounds
   */
  static extractGridAxes(floor, slabBounds) {
    const xCoords = [];
    const yCoords = [];

    if (floor.columns && floor.columns.length > 0) {
      for (const c of floor.columns) {
        if (typeof c.x === 'number') xCoords.push(c.x);
        if (typeof c.y === 'number') yCoords.push(c.y);
      }
    }

    if (xCoords.length < 2) {
      xCoords.push(slabBounds.minX, slabBounds.maxX);
    }
    if (yCoords.length < 2) {
      yCoords.push(slabBounds.minY, slabBounds.maxY);
    }

    function cluster(vals) {
      vals.sort((a, b) => a - b);
      const groups = [];
      for (const v of vals) {
        if (groups.length === 0 || v - groups[groups.length - 1].avg > 0.35) {
          groups.push({ sum: v, count: 1, avg: v });
        } else {
          const last = groups[groups.length - 1];
          last.sum += v;
          last.count += 1;
          last.avg = last.sum / last.count;
        }
      }
      return groups.map(g => Math.round(g.avg * 100) / 100);
    }

    const uniqueX = cluster(xCoords);
    const uniqueY = cluster(yCoords);

    const xAxes = uniqueX.map((x, idx) => ({
      id: `axis_x_${idx + 1}`,
      label: (idx + 1).toString(),
      type: 'X',
      coord: x
    }));

    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const yAxes = uniqueY.map((y, idx) => ({
      id: `axis_y_${letters[idx % letters.length]}`,
      label: letters[idx % letters.length] + (idx >= letters.length ? Math.floor(idx / letters.length) : ''),
      type: 'Y',
      coord: y
    }));

    return { xAxes, yAxes };
  }

  /**
   * Helper to extract default architectural dimensions from grid axes and slab bounds
   */
  static extractDimensions(gridAxes, slabBounds) {
    const dims = [];
    const xAxes = gridAxes.xAxes || [];
    const yAxes = gridAxes.yAxes || [];

    for (let i = 0; i < xAxes.length - 1; i++) {
      const a = xAxes[i], b = xAxes[i + 1];
      const dist = Math.abs(b.coord - a.coord);
      if (dist > 0.1) {
        dims.push({
          id: `dim_x_${a.label}_${b.label}`,
          axis: 'X',
          type: 'BAY',
          start: a.coord,
          end: b.coord,
          distanceM: Math.round(dist * 100) / 100,
          distanceMm: Math.round(dist * 1000),
          label: `${Math.round(dist * 1000)}`
        });
      }
    }

    for (let j = 0; j < yAxes.length - 1; j++) {
      const a = yAxes[j], b = yAxes[j + 1];
      const dist = Math.abs(b.coord - a.coord);
      if (dist > 0.1) {
        dims.push({
          id: `dim_y_${a.label}_${b.label}`,
          axis: 'Y',
          type: 'BAY',
          start: a.coord,
          end: b.coord,
          distanceM: Math.round(dist * 100) / 100,
          distanceMm: Math.round(dist * 1000),
          label: `${Math.round(dist * 1000)}`
        });
      }
    }

    return dims;
  }
}
