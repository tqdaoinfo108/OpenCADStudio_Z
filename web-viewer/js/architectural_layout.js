const zones = {
  bathroom: 'toilet lavabo shower bathtub washing_machine',
  bedroom: 'bed wardrobe nightstand desk dressing_table tv_cabinet plant rug',
  living: 'sofa coffee_table tv_cabinet shoe_cabinet rug plant',
  kitchen: 'kitchen_cabinet fridge dining_table island',
  worship: 'altar plant screen',
  office: 'desk wardrobe sofa plant',
  laundry: 'washing_machine lavabo',
  terrace: 'bbq patio plant',
  garden: 'patio plant',
  garage: '',
  circulation: ''
};

const assetTypes = {
  toilet: /^toilet/,
  lavabo: /^lavabo/,
  shower: /^shower/,
  bathtub: /^bathtub/,
  washing_machine: /^washer/,
  bed: /^bed_/,
  wardrobe: /^(wardrobe|shelving)/,
  nightstand: /^nightstand/,
  desk: /^work_desk/,
  dressing_table: /^dressing_table/,
  tv_cabinet: /^tv_cabinet/,
  plant: /^(indoor_potted|balcony_planter)/,
  rug: /^floor_rug/,
  sofa: /^(sofa|armchair)/,
  coffee_table: /^coffee_table/,
  shoe_cabinet: /^entrance_shoe/,
  kitchen_cabinet: /^kitchen_system/,
  fridge: /^fridge/,
  dining_table: /^dining_table/,
  island: /^kitchen_island/,
  altar: /^vietnamese_worship/,
  bbq: /^outdoor_bbq/,
  patio: /^outdoor_patio/
};
const aliases = {
  wc: 'bathroom', sanitary: 'bathroom', dining: 'kitchen', altar: 'worship',
  master: 'bedroom', kids: 'bedroom', outdoor: 'terrace', stair: 'circulation',
  hallway: 'circulation', storage: 'office'
};
const itemAliases = {
  vanity: 'lavabo', tv: 'tv_cabinet', tv_console: 'tv_cabinet', sofa_sectional: 'sofa',
  altar_table: 'altar', washer: 'washing_machine'
};
const rotations = { north: 0, south: Math.PI, west: Math.PI / 2, east: -Math.PI / 2, center: 0 };
const wallBacked = new Set('bed wardrobe sofa desk dressing_table tv_cabinet shoe_cabinet kitchen_cabinet fridge altar toilet lavabo shower bathtub washing_machine'.split(' '));
const margin = 0.15;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function normalizeRoom(room, index = 0) {
  const { minX = room.x_min, maxX = room.x_max, minY = room.z_min, maxY = room.z_max } = room.bounds || {};
  if (![minX, maxX, minY, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return null;
  const raw = String(room.type || room.zone || '').toLowerCase();
  const name = room.name || room.id || room.room_id;
  const type = /\bwc\b|phòng tắm|vệ sinh/i.test(name || '') ? 'bathroom'
    : aliases[raw] || raw || (
      /phòng ngủ|master/i.test(name) ? 'bedroom' : /phòng khách/i.test(name) ? 'living'
        : /bếp|bàn ăn/i.test(name) ? 'kitchen' : /phòng thờ/i.test(name) ? 'worship' : ''
    );
  return {
    ...room, id: String(room.id || room.room_id || 'room_' + (index + 1)), name, type,
    isOutdoor: room.isOutdoor ?? (type === 'terrace' || type === 'garden'),
    x: (minX + maxX) / 2, y: (minY + maxY) / 2, area: Math.round((maxX - minX) * (maxY - minY) * 100) / 100,
    bounds: { minX, maxX, minY, maxY }
  };
}

function point(opening) {
  const [a, b] = opening.points || [opening.p1, opening.p2];
  const end = opening.end || b;
  return a && end ? [(a.x + end.x) / 2, (a.y + end.y) / 2, Math.hypot(a.x - end.x, a.y - end.y), Math.abs(a.x - end.x) >= Math.abs(a.y - end.y)]
    : [opening.cx ?? opening.x ?? a?.x, opening.cy ?? opening.y ?? a?.y, opening.width,
      Math.abs(Math.cos(opening.rotation || 0)) >= Math.SQRT1_2];
}

export function roomAllowsFurniture(room, item) {
  return (zones[room.type]?.split(' ').includes(furnitureType(item))) ?? room.type === 'common';
}

export function furnitureType(item) {
  return Object.keys(assetTypes).find(type => assetTypes[type].test(item.asset_id || '')) ||
    itemAliases[item.type] || item.type;
}

export function validateAndSanitizeFloorPlan(floor) {
  let rooms = (floor.rooms || []).map(normalizeRoom).filter(Boolean);
  const explicit = floor.metadata?.roomGrid === true || (floor.rooms || []).some(room => Number.isFinite(room.x_min));
  if (!rooms.length && !explicit) return floor;
  if (explicit) {
    const slab = floor.slabs?.[0];
    const verified = [];
    for (const room of rooms) {
      const b = room.bounds;
      const bounded = slab ? normalizeRoom({ ...room, bounds: {
        minX: Math.max(slab.minX, b.minX), maxX: Math.min(slab.maxX, b.maxX),
        minY: Math.max(slab.minY, b.minY), maxY: Math.min(slab.maxY, b.maxY)
      } }) : room;
      if (!bounded) continue;
      const a = bounded.bounds;
      if (verified.some(other => {
        const c = other.bounds;
        return other.id === bounded.id ||
          Math.min(a.maxX, c.maxX) - Math.max(a.minX, c.minX) > 1e-6 &&
          Math.min(a.maxY, c.maxY) - Math.max(a.minY, c.minY) > 1e-6;
      })) continue;
      verified.push(bounded);
    }
    rooms = verified;
  }

  const doorPoints = (floor.doors?.length ? floor.doors : floor.entities?.filter(e => e.layer === 'A-DOOR') || []).map(point);
  const windowPoints = (floor.windows?.length ? floor.windows : floor.entities?.filter(e => e.layer === 'A-GLAZ') || []).map(point);
  const wetRooms = rooms.filter(room => room.type === 'bathroom');
  const intersectsWetRoom = (x, z, hw, hd) => wetRooms.some(({ bounds: b }) =>
    x + hw > b.minX && x - hw < b.maxX && z + hd > b.minY && z - hd < b.maxY);
  const placed = [];
  const result = { ...floor, rooms, furniture: [], sanitary: [] };
  for (const key of ['sanitary', 'furniture']) {
    for (const item of floor[key] || []) {
      const type = furnitureType(item);
      const x = item.cx ?? item.x;
      const z = item.cy ?? item.z;
      const declared = rooms.find(room => item.room_id === room.id);
      const containing = rooms.filter(({ bounds: b }) => x > b.minX && x < b.maxX && z > b.minY && z < b.maxY);
      const room = declared || containing.find(r => r.type === 'bathroom') ||
        containing.find(r => r.name === item.room) || containing[0];
      const allowed = zones[room?.type];
      if (allowed !== undefined && !allowed.split(' ').includes(type)) continue;
      if (!room || (!explicit && allowed === undefined)) {
        const angle = item.rotation || 0;
        const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
        const width = item.width || 0, depth = item.depth || 0;
        const hw = (width * cos + depth * sin) / 2;
        const hd = (width * sin + depth * cos) / 2;
        if (!explicit && !intersectsWetRoom(x, z, hw, hd)) result[key].push(item);
        continue;
      }
      const { minX, maxX, minY, maxY } = room.bounds;
      const distances = { north: z - minY, south: maxY - z, west: x - minX, east: maxX - x };
      const anchor = Object.hasOwn(rotations, item.anchor_wall) ? item.anchor_wall :
        wallBacked.has(type) ? Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0] : 'center';
      const side = anchor === 'west' || anchor === 'east';
      const rotation = rotations[anchor];
      const width = item.width;
      const depth = item.depth;
      if (![width, depth].every(n => Number.isFinite(n) && n > 0)) continue;
      const hw = (side ? depth : width) / 2;
      const hd = (side ? width : depth) / 2;
      const loX = minX + margin + hw, hiX = maxX - margin - hw;
      const loZ = minY + margin + hd, hiZ = maxY - margin - hd;
      if (loX > hiX || loZ > hiZ) continue;
      const offset = item.offset_along_wall;
      const startX = anchor === 'west' ? loX : anchor === 'east' ? hiX :
        clamp(!side && Number.isFinite(offset) ? minX + offset : x ?? room.x, loX, hiX);
      const startZ = anchor === 'north' ? loZ : anchor === 'south' ? hiZ :
        clamp(side && Number.isFinite(offset) ? minY + offset : z ?? room.y, loZ, hiZ);
      const collides = (cx, cz) => {
        if (doorPoints.some(([dx, dz, span]) => Math.hypot(
          Math.max(0, Math.abs(dx - cx) - hw), Math.max(0, Math.abs(dz - cz) - hd)
        ) < Math.max(0.9, (span || 0) / 2))) return true;
        if ((item.height || 0) > 1 && windowPoints.some(([wx, wz, span, horizontal]) =>
          Math.abs(wx - cx) < hw + (horizontal ? (span || 1) / 2 : 0.42) &&
          Math.abs(wz - cz) < hd + (horizontal ? 0.42 : (span || 1) / 2))) return true;
        if (room.type !== 'bathroom' && intersectsWetRoom(cx, cz, hw, hd)) return true;
        return placed.some(box => Math.abs(cx - box.x) < hw + box.hw + 0.025 &&
          Math.abs(cz - box.z) < hd + box.hd + 0.025);
      };
      const candidates = [[startX, startZ]];
      const steps = Math.ceil(Math.max(hiX - loX, hiZ - loZ) / 0.15);
      for (let i = 1; i <= steps; i++) {
        const delta = i * 0.15;
        if (anchor === 'center' || !side) candidates.push([startX - delta, startZ], [startX + delta, startZ]);
        if (anchor === 'center' || side) candidates.push([startX, startZ - delta], [startX, startZ + delta]);
      }
      if (anchor === 'center') {
        for (let cx = loX; cx <= hiX; cx += 0.2) {
          for (let cz = loZ; cz <= hiZ; cz += 0.2) candidates.push([cx, cz]);
        }
      }
      const position = candidates.find(([cx, cz]) =>
        cx >= loX && cx <= hiX && cz >= loZ && cz <= hiZ && !collides(cx, cz));
      if (!position) continue;
      const [cx, cy] = position;
      placed.push({ x: cx, z: cy, hw, hd });
      result[key].push({ ...item, cx, cy, x: cx, z: cy, rotation, room_id: room.id, room: room.name,
        anchor_wall: anchor, offset_along_wall: side ? cy - minY : cx - minX });
    }
  }
  return result;
}

// Split room edges at every junction and emit each shared boundary once.
export function buildRoomPartitions(rooms, bounds, connections = []) {
  const lines = new Map();
  for (const room of rooms.map(normalizeRoom).filter(Boolean)) {
    const { minX, maxX, minY, maxY } = room.bounds;
    for (const [axis, fixed, from, to] of [
      ['x', minY, minX, maxX], ['x', maxY, minX, maxX],
      ['z', minX, minY, maxY], ['z', maxX, minY, maxY]
    ]) {
      const boundary = axis === 'x' ? [bounds.minY, bounds.maxY] : [bounds.minX, bounds.maxX];
      if (boundary.some(value => Math.abs(value - fixed) < 0.001)) continue;
      const key = axis + ':' + fixed;
      if (!lines.has(key)) lines.set(key, { axis, fixed, edges: [] });
      lines.get(key).edges.push({ from, to, room });
    }
  }
  const walls = [], doors = [];
  for (const { axis, fixed, edges } of lines.values()) {
    const cuts = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].sort((a, b) => a - b);
    const coordinates = value => axis === 'x' ? { x: value, y: fixed } : { x: fixed, y: value };
    for (let i = 1; i < cuts.length; i++) {
      const from = cuts[i - 1], to = cuts[i], mid = (from + to) / 2;
      const adjacent = edges.filter(edge => mid > edge.from && mid < edge.to).map(edge => edge.room);
      if (!adjacent.length || adjacent.every(room => room.isOutdoor)) continue;
      walls.push({ p1: coordinates(from), p2: coordinates(to), height: 2.6, thickness: 0.15, isExterior: false });
      const passage = adjacent.length === 2 && connections.some(pair => adjacent.every(room => pair.includes(room.id)));
      if (passage && to - from >= 1) {
        doors.push({ ...coordinates(mid), width: Math.min(0.9, to - from - 0.12), height: 2.2, rotation: axis === 'x' ? 0 : Math.PI / 2 });
      }
    }
  }
  return { walls, doors };
}
