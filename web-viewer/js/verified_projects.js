import { buildRoomPartitions, normalizeRoom, validateAndSanitizeFloorPlan } from './architectural_layout.js';

const rect = (layer, x0, z0, x1, z1) => ({
  type: 'LWPOLYLINE', layer, closed: true,
  points: [{ x: x0, y: z0 }, { x: x1, y: z0 }, { x: x1, y: z1 }, { x: x0, y: z1 }]
});
const line = (layer, x, z, x1, z1, props = {}) => ({
  type: 'LINE', layer, points: [{ x, y: z }, { x: x1, y: z1 }], ...props
});
const room = (id, name, type, x0, z0, x1, z1) => normalizeRoom({
  id, name, type, x_min: x0, x_max: x1, z_min: z0, z_max: z1,
  isOutdoor: ['terrace', 'garden'].includes(type)
});
const item = (room_id, asset_id, name, width, depth, height, anchor_wall, offset_along_wall, z) => ({
  room_id, asset_id, name, width, depth, height, anchor_wall, offset_along_wall, z
});

const programs = {
  living: ['Phòng khách', w => [
    item('front', 'sofa_l_modern', 'Sofa chữ L', 2.25, 1.4, 0.84, 'west', 2.6),
    item('front', 'tv_cabinet_wall_unit', 'Kệ TV', 1.6, 0.36, 1.55, 'east', 2.5),
    item('front', 'floor_rug_textured', 'Thảm phòng khách', 1.35, 1.55, 0.02, 'center', w * 0.49, 2.65),
    item('front', 'entrance_shoe_cabinet', 'Tủ giày', 0.65, 0.32, 0.92, 'north', 0.8)
  ]],
  bedroom: ['Phòng ngủ Master', w => [
    item('front', 'bed_master_king', 'Giường King', 1.9, 2.05, 1.08, 'west', 2.55),
    item('front', 'wardrobe_tall_glass', 'Tủ quần áo', 1.05, 0.55, 2.25, 'south', 0.75),
    item('front', 'tv_cabinet_wall_unit', 'Kệ TV', 1.45, 0.32, 1.35, 'east', 2.05),
    item('front', 'dressing_table_mirror', 'Bàn trang điểm', 0.83, 0.4, 1.33, 'north', w - 0.85)
  ]],
  kids: ['Phòng ngủ hai bé', w => [
    item('front', 'bed_bunk_kids', 'Giường tầng', 1.05, 2, 1.75, 'west', 2.75),
    item('front', 'work_desk_computer', 'Bàn học đôi', 1.8, 0.55, 0.77, 'east', 2.35),
    item('front', 'wardrobe_tall_glass', 'Tủ quần áo', 1.05, 0.45, 2.16, 'west', 0.85)
  ]],
  worship: ['Phòng thờ', w => [
    item('front', 'vietnamese_worship_altar', 'Bàn thờ gỗ', 1.6, 0.68, 1.8, 'south', w - 1.2),
    item('front', 'indoor_potted_ficus', 'Cây cảnh', 0.44, 0.44, 1.1, 'west', 1.8)
  ]]
};

function rearFurniture(type, w) {
  if (type === 'kitchen') return [
    item('rear', 'kitchen_system_l', 'Tủ bếp chữ L', 2.15, 0.65, 2.05, 'west', 1.55),
    item('rear', 'fridge_double_door', 'Tủ lạnh', 0.75, 0.69, 1.82, 'east', 2.65),
    item('rear', 'dining_table_6chairs', 'Bàn ăn 6 ghế', 1.65, 1.25, 0.78, 'center', w * 0.52),
    ...(w >= 8 ? [item('rear', 'kitchen_island_bar', 'Đảo bếp', 1.75, 0.95, 0.92, 'center', w * 0.72)] : [])
  ];
  if (type === 'office') return [
    item('rear', 'work_desk_computer', 'Bàn làm việc', 1.35, 0.6, 0.8, 'east', 1.75),
    item('rear', 'wardrobe_tall_glass', 'Tủ sách', 0.92, 0.42, 1.85, 'south', 1.1),
    item('rear', 'sofa_straight_3seat', 'Sofa đọc sách', 1.65, 0.72, 0.83, 'west', 2)
  ];
  if (type === 'terrace') return [
    item('rear', 'outdoor_bbq_station', 'Bếp nướng BBQ', 1.4, 0.62, 1.1, 'south', w - 1.25),
    item('rear', 'outdoor_patio_set', 'Bàn trà sân thượng', 1.5, 1.55, 0.85, 'center', w * 0.66),
    item('rear', 'balcony_planter_greenery', 'Bồn cây sân thượng', 1.05, 0.36, 0.65, 'west', 1.7)
  ];
  return [
    item('rear', 'bed_queen_modern', 'Giường đôi', 1.55, 1.95, 1.03, 'east', 1.75),
    item('rear', 'wardrobe_tall_glass', 'Tủ quần áo', 1.12, 0.55, 2.2, 'south', 0.95)
  ];
}

function buildFloor(w, d, index, program, rear, total) {
  const id = 'floor_' + (index + 1);
  const midStart = Number((d * 0.36).toFixed(2));
  const midEnd = Number((d * 0.70).toFixed(2));
  const stairWidth = w >= 8 ? 2.25 : 1.28;
  const hallEnd = w - stairWidth;
  const wetWidth = w >= 8 ? 3.4 : 2;
  const wetEnd = index === 0 ? midStart + 2.1 : midEnd;
  const [frontName, frontFurniture] = programs[program];
  const garage = w >= 8 && index === 0 ? 3.15 : 0;
  const rearName = { kitchen: 'Bếp và phòng ăn', office: 'Phòng làm việc', bedroom: 'Phòng ngủ phía sau', terrace: 'Sân thượng BBQ' }[rear];
  const wet = rear === 'terrace' ? 'laundry' : 'bathroom';
  const wetName = wet === 'laundry' ? 'Giặt phơi' : 'Phòng tắm WC';
  const rooms = [
    room('front', frontName, program === 'kids' ? 'bedroom' : program, garage, 0, w, midStart),
    room('hall', 'Sảnh thang', 'circulation', wetWidth, midStart, hallEnd, midEnd),
    room('stairs', 'Cầu thang', 'circulation', hallEnd, midStart, w, midEnd),
    room('wet', wetName, wet, 0, midStart, wetWidth, wetEnd),
    room('rear', rearName, rear, 0, midEnd, w, d)
  ];
  if (garage) rooms.push(room('garage', 'Gara', 'garage', 0, 0, garage, midStart));
  if (wetEnd < midEnd) rooms.push(room('storage', 'Kho', 'circulation', 0, wetEnd, wetWidth, midEnd));
  const { walls, doors } = buildRoomPartitions(rooms, { minX: 0, maxX: w, minY: 0, maxY: d },
    [['front', 'hall'], ['hall', 'stairs'], ['hall', 'wet'], ['hall', 'rear'], ['hall', 'storage'], ['front', 'garage']]);
  // Enter the stair along the flight axis, through the front landing.
  const stairDoor = doors.find(door => Math.abs(door.x - hallEnd) < 0.001 && door.y > midStart && door.y < midEnd);
  if (stairDoor) doors.splice(doors.indexOf(stairDoor), 1);
  doors.push({ x: (hallEnd + w) / 2, y: midStart, width: 0.9, rotation: 0 });
  doors.push({ x: (hallEnd + w) / 2, y: midEnd, width: 0.9, rotation: 0 });
  if (garage) doors.push({ x: garage / 2, y: 0, width: 2.55, rotation: 0 });
  doors.push({ x: w * 0.48, y: 0, width: index === 0 ? 1.18 : 1.45, rotation: 0 });
  const fixtures = wet === 'laundry' ? [
    item('wet', 'washer_dryer_tower', 'Máy giặt sấy', 0.66, 0.68, 1.74, 'west', 1.5),
    item('wet', 'lavabo_vanity_led_mirror', 'Chậu giặt', 0.5, 0.4, 0.86, 'south', 1.2)
  ] : [
    item('wet', 'toilet_onepiece', 'Bồn cầu', 0.42, 0.65, 0.75, 'north', 0.52),
    item('wet', 'lavabo_vanity_led_mirror', 'Lavabo gương LED', 0.51, 0.38, 1.72, 'west', index ? 1.58 : 1.05),
    ...(index ? [item('wet', 'shower_glass_enclosure', 'Vách tắm kính', 0.89, 0.88, 2.04, 'south', 0.6)] : [])
  ];
  const entities = [
    rect('A-WALL-EXTR', 0, 0, w, d),
    ...rooms.map(room => ({ type: 'TEXT', layer: 'A-ANNO',
      text: room.name + ' (' + room.area + ' m²)', points: [{ x: room.x, y: room.y }] })),
    ...walls.map(({ p1, p2 }) => line('A-WALL-INTR', p1.x, p1.y, p2.x, p2.y)),
    ...doors.map(({ x, y, width, rotation }) => ({ type: 'POINT', layer: 'A-DOOR', points: [{ x, y }], width, rotation,
      asset_id: y === 0 && index > 0 ? 'door_balcony_glass' : 'door_interior_wood' })),
    line('A-GLAZ', garage ? w * 0.64 : 0.28, 0, w * (garage ? 0.9 : 0.28), 0, { rotation: 0 }),
    ...(rear === 'terrace' ? [] : [line('A-GLAZ', w * 0.36, d, w * 0.7, d, { rotation: Math.PI })])
  ];
  if (garage) {
    entities.push(...[[-1.6, 1.4], [-1.7, d - 2.3], [w + 1.5, d - 1.8]].map(([x, y]) =>
      ({ type: 'CIRCLE', layer: 'A-SITE', points: [{ x, y }], radius: 0.95 })));
  }
  const stairMinX = hallEnd + 0.08, stairMaxX = w - 0.12;
  const stairMinZ = midStart + 0.12, stairMaxZ = midEnd - 0.16;
  if (index < total - 1) {
    for (let step = 0; step <= 18; step++) {
      const z = stairMinZ + (stairMaxZ - stairMinZ) * step / 18;
      entities.push(line('A-STAIR', stairMinX, z, stairMaxX, z, { asset_id: 'stair_flight_straight', rotation: 0 }));
    }
  }
  const stairOpening = index ? { minX: stairMinX, maxX: stairMaxX, minY: stairMinZ, maxY: stairMaxZ } : null;
  const floor = validateAndSanitizeFloorPlan({
    id, name: w === 6 && index === 3 ? 'Tầng tum' : 'Tầng ' + (index + 1), desc: [frontName, wetName, rearName].join(' · '),
    elevation: index * 3.2, height: 3.2,
    metadata: { roomGrid: true, terrace: rear === 'terrace', balcony: index > 0 },
    entities, rooms, interiorWalls: walls,
    slabs: [{ minX: 0, maxX: w, minY: 0, maxY: d, thickness: 0.18, hasStairOpening: !!stairOpening, stairOpening }],
    furniture: [...frontFurniture(w), ...fixtures, ...rearFurniture(rear, w)]
  });
  for (const furniture of floor.furniture) {
    const { cx, cy, width, depth, rotation } = furniture;
    const turned = Math.abs(Math.sin(rotation)) > 0.9;
    const halfX = (turned ? depth : width) / 2;
    const halfZ = (turned ? width : depth) / 2;
    entities.push({ ...rect('A-FURN', cx - halfX, cy - halfZ, cx + halfX, cy + halfZ),
      asset_id: furniture.asset_id, name: furniture.name, rotation, width, depth });
  }
  return floor;
}

function project(id, code, title, width, depth, floorPrograms, metadata = {}) {
  return {
    id, code, title, subtitle: 'Hồ sơ kiến trúc · Nếp Nhà Studio',
    lot_width: width, lot_length: depth, lot_area: width * depth,
    total_floor_area: width * depth * floorPrograms.length,
    metadata: { seedRevision: 2, ...metadata },
    floors: floorPrograms.map(([front, rear], index) => buildFloor(width, depth, index, front, rear, floorPrograms.length))
  };
}

// Keep stable public project IDs so existing share URLs still work after migration.
export const PROJECT_TOWNHOUSE_4F = project('nha-pho-4-tang-5x8', 'NN-2026-NP04',
  'Nhà phố Liền kề 5 × 10 m · 4 tầng', 5, 10,
  [['living', 'kitchen'], ['bedroom', 'office'], ['kids', 'bedroom'], ['worship', 'terrace']]);
export const PROJECT_VILLA_GARDEN_3F = project('biet-thu-san-vuon-3-tang-12x16', 'NN-2026-BT08',
  'Biệt thự Hiện đại 10 × 14 m · 3 tầng sân vườn', 10, 14,
  [['living', 'kitchen'], ['bedroom', 'bedroom'], ['kids', 'terrace']], { garden: true });
export const PROJECT_TOWNHOUSE_3F = project('proj_sample_villa_3f', 'NN-2026-NP36',
  'Nhà phố Hiện đại 6 × 12 m · 3 tầng 1 tum', 6, 12,
  [['living', 'kitchen'], ['bedroom', 'office'], ['kids', 'bedroom'], ['worship', 'terrace']]);
export const SEED_PROJECTS = [PROJECT_TOWNHOUSE_4F, PROJECT_VILLA_GARDEN_3F, PROJECT_TOWNHOUSE_3F];
