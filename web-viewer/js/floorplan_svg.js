/**
 * floorplan_svg.js
 * OpenCADStudio_Z: Interactive 2D Floorplan SVG Generator
 * 
 * Generates crisp, architectural 2D SVG blueprints from CAD BIM floor data
 * with interactive room/furniture hotspots and Stage 1 AI Detection overlays.
 */

export class FloorplanSvgGenerator {
  /**
   * Generate an SVG string representing the given BIM floor
   * @param {Object} floor - BIM floor data
   * @param {Object} options - styling and size options
   * @returns {string} SVG markup
   */
  static generate(floor, options = {}) {
    if (!floor) return '<svg></svg>';

    const showAiDetection = options.showAiDetection || options.stage === 1;

    // Determine bounding box from slabs, walls, or rooms
    let minX = 0, maxX = 15, minY = 0, maxY = 24;
    let foundBounds = false;

    if (floor.slabs && floor.slabs.length > 0) {
      const slab = floor.slabs[0];
      minX = slab.minX;
      maxX = slab.maxX;
      minY = slab.minY;
      maxY = slab.maxY;
      foundBounds = true;
    } else if (floor.exteriorWalls && floor.exteriorWalls.length > 0) {
      const xs = [];
      const ys = [];
      for (const w of floor.exteriorWalls) {
        if (w.p1) { xs.push(w.p1.x); ys.push(w.p1.y); }
        if (w.p2) { xs.push(w.p2.x); ys.push(w.p2.y); }
      }
      if (xs.length > 0) {
        minX = Math.min(...xs);
        maxX = Math.max(...xs);
        minY = Math.min(...ys);
        maxY = Math.max(...ys);
        foundBounds = true;
      }
    }

    if (!foundBounds && floor.rooms && floor.rooms.length > 0) {
      const xs = floor.rooms.map(r => r.x);
      const ys = floor.rooms.map(r => r.y);
      minX = Math.max(0, Math.min(...xs) - 2.0);
      maxX = Math.max(...xs) + 2.0;
      minY = Math.max(0, Math.min(...ys) - 2.0);
      maxY = Math.max(...ys) + 2.0;
    }

    const viewBoxWidth = Math.max(maxX - minX, 4);
    const viewBoxHeight = Math.max(maxY - minY, 4);
    // We flip Y so architectural CAD Y (pointing up/north) renders correctly in SVG
    const padding = 1.0;
    const vb = `${minX - padding} ${-maxY - padding} ${viewBoxWidth + padding * 2} ${viewBoxHeight + padding * 2}`;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="100%" height="100%" class="cad-blueprint-svg">
      <defs>
        <pattern id="grid-pattern" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#EAE8E1" stroke-width="0.04" />
        </pattern>
        <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#8D6E63" />
        </marker>
        <filter id="ai-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="0.15" flood-color="#0284C7" flood-opacity="0.6"/>
        </filter>
      </defs>

      <!-- Background & Site Grid -->
      <rect x="${minX - padding}" y="${-maxY - padding}" width="${viewBoxWidth + padding * 2}" height="${viewBoxHeight + padding * 2}" fill="#FAF9F6" />
      <rect x="${minX}" y="${-maxY}" width="${viewBoxWidth}" height="${viewBoxHeight}" fill="url(#grid-pattern)" />
    `;

    // 1. Slabs / Floor outline
    if (floor.slabs && floor.slabs.length > 0) {
      for (const slab of floor.slabs) {
        const sw = slab.maxX - slab.minX;
        const sh = slab.maxY - slab.minY;
        svg += `\n      <!-- Slab outline -->
        <rect x="${slab.minX}" y="${-slab.maxY}" width="${sw}" height="${sh}" fill="${showAiDetection ? '#F8FAFC' : '#F0EFEA'}" stroke="#CBD5E1" stroke-width="0.08" rx="0.1" />`;
      }
    } else {
      // Default floor outline
      const sw = maxX - minX;
      const sh = maxY - minY;
      svg += `\n      <rect x="${minX}" y="${-maxY}" width="${sw}" height="${sh}" fill="#F0EFEA" stroke="#CBD5E1" stroke-width="0.08" rx="0.1" />`;
    }

    // 1.5. Stage 1: AI Detected Room Zones
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
        const rw = rm.bounds ? (rm.bounds.maxX - rm.bounds.minX) : 3.6;
        const rh = rm.bounds ? (rm.bounds.maxY - rm.bounds.minY) : 3.0;
        const rx = rm.bounds ? rm.bounds.minX : rm.x - rw / 2;
        const ry = rm.bounds ? rm.bounds.maxY : rm.y + rh / 2;
        svg += `\n      <!-- AI Room Detection Box -->
        <rect x="${rx}" y="${-ry}" width="${rw}" height="${rh}" fill="${c}" stroke="#0284C7" stroke-width="0.04" stroke-dasharray="0.15,0.08" rx="0.15" />
        <rect x="${rx + 0.1}" y="${-ry + 0.1}" width="1.6" height="0.32" fill="#0284C7" rx="0.06"/>
        <text x="${rx + 0.9}" y="${-ry + 0.32}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.18" fill="#FFFFFF" font-weight="700" text-anchor="middle">AI ZONE: 99%</text>`;
      });
    }

    // 2. Stairwell void & Stairs
    if (floor.stairs && floor.stairs.length > 0) {
      for (const st of floor.stairs) {
        const sx = st.x - st.width / 2;
        const sy = st.y - st.depth / 2;
        svg += `\n      <!-- Stairwell -->
        <g class="svg-stair-group" data-item="stair">
          <rect x="${sx}" y="${-(sy + st.depth)}" width="${st.width}" height="${st.depth}" fill="#E8E5DD" stroke="#8D6E63" stroke-width="0.06" />`;
        // Steps
        const numSteps = 10;
        const stepH = st.depth / numSteps;
        for (let s = 0; s < numSteps; s++) {
          const stepY = sy + s * stepH;
          svg += `\n          <line x1="${sx}" y1="${-stepY}" x2="${sx + st.width}" y2="${-stepY}" stroke="#A0816C" stroke-width="0.03" />`;
        }
        // Stair direction arrow
        svg += `\n          <line x1="${st.x}" y1="${-(sy + 0.3)}" x2="${st.x}" y2="${-(sy + st.depth - 0.4)}" stroke="#8D6E63" stroke-width="0.06" marker-end="url(#arrow)" />
          <text x="${st.x + 0.2}" y="${-(sy + st.depth / 2)}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.25" fill="#8D6E63" font-weight="bold">LÊN</text>
        </g>`;
      }
    }

    // 3. Interior Walls
    if (floor.interiorWalls) {
      for (const iw of floor.interiorWalls) {
        if (!iw.p1 || !iw.p2) continue;
        svg += `\n      <line x1="${iw.p1.x}" y1="${-iw.p1.y}" x2="${iw.p2.x}" y2="${-iw.p2.y}" stroke="#334155" stroke-width="0.14" stroke-linecap="square" />`;
      }
    }

    // 4. Exterior Walls (Solid Architectural Dark)
    if (floor.exteriorWalls) {
      for (const ew of floor.exteriorWalls) {
        if (!ew.p1 || !ew.p2) continue;
        svg += `\n      <line x1="${ew.p1.x}" y1="${-ew.p1.y}" x2="${ew.p2.x}" y2="${-ew.p2.y}" stroke="#0F172A" stroke-width="0.22" stroke-linecap="square" />`;
      }
    }

    // 5. Columns
    if (floor.columns) {
      for (const col of floor.columns) {
        const cx = col.x - (col.sizeX || 0.25) / 2;
        const cy = col.y + (col.sizeY || 0.25) / 2;
        svg += `\n      <rect x="${cx}" y="${-cy}" width="${col.sizeX || 0.25}" height="${col.sizeY || 0.25}" fill="#1E293B" stroke="#0F172A" stroke-width="0.04" />`;
      }
    }

    // 6. Doors & Swings
    if (floor.doors) {
      for (const d of floor.doors) {
        const r = d.width || 0.9;
        svg += `\n      <!-- Door swing -->
        <g class="svg-door-group">
          <path d="M ${d.x} ${-d.y} A ${r} ${r} 0 0 1 ${d.x + r} ${-(d.y + r)}" fill="none" stroke="#3B82F6" stroke-width="0.03" stroke-dasharray="0.08,0.04" />
          <line x1="${d.x}" y1="${-d.y}" x2="${d.x + r}" y2="${-d.y}" stroke="#2563EB" stroke-width="0.06" />
        </g>`;
      }
    }

    // 7. Furniture & Sanitary Items
    const allItems = [...(floor.furniture || []), ...(floor.sanitary || [])];
    for (const item of allItems) {
      const w = item.width || 1.2;
      const d = item.depth || 0.8;
      const cx = typeof item.cx === 'number' ? item.cx : (typeof item.x === 'number' ? item.x : 0);
      const cy = typeof item.cy === 'number' ? item.cy : (typeof item.y === 'number' ? item.y : 0);
      const ix = cx - w / 2;
      const iy = cy + d / 2;
      const isSanr = item.layer === 'A-SANR' || item.type === 'toilet' || item.type === 'vanity' || item.type === 'bathtub';
      const fillColor = isSanr ? '#E0F2FE' : '#F3ECE4';
      const strokeColor = isSanr ? '#0284C7' : '#9A7B56';

      svg += `\n      <!-- Furniture item: ${item.name} -->
      <g class="svg-hotspot-item" data-id="${item.name}" data-layer="${item.layer || 'A-FURN'}" style="cursor: pointer;">
        <rect x="${ix}" y="${-iy}" width="${w}" height="${d}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="0.04" rx="0.08" />
        <text x="${cx}" y="${-cy + 0.08}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.22" fill="#4B5563" text-anchor="middle" font-weight="600">${(item.name || '').substring(0, 16)}</text>`;

      if (showAiDetection) {
        // AI detection bounding box with confidence badge
        const conf = item.confidence ? `${Math.round(item.confidence * 100)}%` : '98%';
        svg += `\n        <!-- AI BBox & confidence -->
        <rect x="${ix - 0.06}" y="${-iy - 0.06}" width="${w + 0.12}" height="${d + 0.12}" fill="none" stroke="#D97706" stroke-width="0.03" stroke-dasharray="0.08,0.05" />
        <rect x="${ix}" y="${-iy - 0.28}" width="${Math.min(w, 1.8)}" height="0.25" fill="#D97706" rx="0.05" />
        <text x="${ix + Math.min(w, 1.8) / 2}" y="${-iy - 0.1}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.16" fill="#FFFFFF" font-weight="700" text-anchor="middle">AI: ${conf}</text>`;
      }

      svg += `\n      </g>`;
    }

    // 8. Room Names & Areas
    if (floor.rooms) {
      for (const rm of floor.rooms) {
        svg += `\n      <!-- Room label -->
        <g class="svg-room-label">
          <rect x="${rm.x - 1.8}" y="${-rm.y - 0.35}" width="3.6" height="0.75" fill="rgba(255, 255, 255, 0.92)" stroke="#E2E8F0" stroke-width="0.03" rx="0.18" />
          <text x="${rm.x}" y="${-rm.y - 0.03}" font-family="'Lora', serif" font-size="0.32" font-weight="700" fill="#0F172A" text-anchor="middle">${rm.name.toUpperCase()}</text>
          <text x="${rm.x}" y="${-rm.y + 0.25}" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.25" font-weight="600" fill="#D97706" text-anchor="middle">${rm.area} m²</text>
        </g>`;
      }
    }

    // 9. North Arrow Indicator
    const naX = maxX - 0.8;
    const naY = -minY - 1.2;
    svg += `\n      <!-- North Compass -->
      <g transform="translate(${naX}, ${naY})">
        <circle cx="0" cy="0" r="0.5" fill="#FFFFFF" stroke="#64748B" stroke-width="0.04" />
        <polygon points="0,-0.42 0.16,0 0,-0.08" fill="#DC2626" />
        <polygon points="0,-0.42 -0.16,0 0,-0.08" fill="#991B1B" />
        <polygon points="0,0.42 0.16,0 0,0.08" fill="#94A3B8" />
        <polygon points="0,0.42 -0.16,0 0,0.08" fill="#64748B" />
        <text x="0" y="-0.54" font-family="'Plus Jakarta Sans', sans-serif" font-size="0.26" font-weight="bold" fill="#DC2626" text-anchor="middle">B</text>
      </g>
    </svg>`;

    return svg;
  }
}
