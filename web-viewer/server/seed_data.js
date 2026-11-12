/**
 * seed_data.js
 * OpenCADStudio_Z / Nếp Nhà - Web Viewer Backend
 * 2 distinct full architectural projects enriched with all 35 GLB Asset Catalog IDs
 * and wall-aligned rotations (in radians):
 * 1. 'Nhà phố 4 Tầng Hiện Đại (5 × 8 m)' (4 floors, 5x8m, full .glb furniture, stairs, rooms)
 * 2. 'Biệt thự Sân vườn 3 Tầng (12 × 16 m)' (3 floors, 12x16m, full .glb furniture, pool, gym, altar)
 */

import { ProjectDocument } from './models.js';

const ROT_NORTH_BACK = 0;               // Back against South/bottom (-Z) wall, facing +Z
const ROT_SOUTH_BACK = Math.PI;         // Back against North/top (+Z) wall, facing -Z
const ROT_WEST_BACK = Math.PI / 2;      // Back against West/left (-X) wall, facing +X
const ROT_EAST_BACK = -Math.PI / 2;     // Back against East/right (+X) wall, facing -X

function makeRectPoly(layer, x1, y1, x2, y2, props = {}) {
  return {
    type: 'LWPOLYLINE',
    layer,
    radius: 0.0,
    ...props,
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
      { x: x1, y: y1 }
    ]
  };
}

function makeLine(layer, x1, y1, x2, y2, props = {}) {
  return {
    type: 'LINE',
    layer,
    ...props,
    points: [{ x: x1, y: y1 }],
    end: { x: x2, y: y2 }
  };
}

function makeDoorPoint(x, y, asset_id = 'door_interior_wood', rotation = 0, width = 0.9) {
  return {
    type: 'POINT',
    layer: 'A-DOOR',
    asset_id,
    rotation,
    width,
    points: [{ x, y }]
  };
}

function makeText(layer, text, x, y, size = 0.3) {
  return {
    type: 'TEXT',
    layer,
    text,
    radius: size,
    points: [{ x, y }]
  };
}

function makeCircle(layer, x, y, radius) {
  return {
    type: 'CIRCLE',
    layer,
    radius,
    points: [{ x, y }]
  };
}

function makeStairLines(x1, y1, x2, y2, steps = 12, asset_id = 'stair_flight_straight', rotation = 0) {
  const lines = [];
  const dy = (y2 - y1) / steps;
  for (let i = 0; i <= steps; i++) {
    lines.push(makeLine('A-STAIR', x1, y1 + i * dy, x2, y1 + i * dy, { asset_id, rotation }));
  }
  lines.push(makeLine('A-STAIR', x1, y1, x1, y2, { asset_id, rotation }));
  lines.push(makeLine('A-STAIR', x2, y1, x2, y2, { asset_id, rotation }));
  return lines;
}

// =========================================================================
// PROJECT 1: NHÀ PHỐ 4 TẦNG HIỆN ĐẠI (5 × 8 M)
// =========================================================================
export const PROJECT_TOWNHOUSE_4F = new ProjectDocument({
  id: 'nha-pho-4-tang-5x8',
  title: 'Nhà phố 4 Tầng Hiện Đại (5 × 8 m)',
  code: 'NN-2026-NP04',
  subtitle: 'HỒ SƠ THIẾT KẾ THI CÔNG KIẾN TRÚC NHÀ PHỐ HIỆN ĐẠI',
  lot_width: 5.0,
  lot_length: 8.0,
  lot_area: 40.0,
  total_floor_area: 160.0,
  metadata: {
    author: 'KTS. Lê Hoàng Nam - Nếp Nhà Studio',
    style: 'Modern Minimalist',
    orientation: 'Nam (South)',
    estimatedCostVND: 1850000000,
    tags: ['Nhà Phố', 'Hiện Đại', '4 Tầng', '5x8m', 'GLB 3D']
  },
  floors: [
    // --- TẦNG 1 ---
    {
      id: 'floor_1',
      name: 'Tầng 1',
      desc: 'Sân trước, Phòng khách, Bếp ăn, WC & Cầu thang',
      elevation: 0.0,
      height: 3.8,
      entities: [
        // Exterior Boundary (5x8m)
        makeRectPoly('A-WALL-EXTR', 0.0, 0.0, 5.0, 8.0),
        // Columns (6 columns 0.22x0.22m)
        makeRectPoly('A-COLS', 0.0, 0.0, 0.22, 0.22),
        makeRectPoly('A-COLS', 4.78, 0.0, 5.0, 0.22),
        makeRectPoly('A-COLS', 0.0, 3.89, 0.22, 4.11),
        makeRectPoly('A-COLS', 4.78, 3.89, 5.0, 4.11),
        makeRectPoly('A-COLS', 0.0, 7.78, 0.22, 8.0),
        makeRectPoly('A-COLS', 4.78, 7.78, 5.0, 8.0),
        // Interior Walls
        makeLine('A-WALL-INTR', 3.5, 4.0, 3.5, 7.8),
        makeLine('A-WALL-INTR', 3.5, 6.2, 4.8, 6.2),
        // Stairs
        ...makeStairLines(3.6, 4.0, 4.8, 6.1, 10, 'stair_flight_straight', ROT_NORTH_BACK),
        // Doors
        makeDoorPoint(2.5, 0.1, 'door_balcony_glass', ROT_NORTH_BACK, 1.6),
        makeDoorPoint(3.5, 6.8, 'door_interior_wood', ROT_WEST_BACK, 0.85),
        // Windows
        makeLine('A-GLAZ', 0.8, 0.1, 4.2, 0.1, { asset_id: 'window_casement_glass', rotation: ROT_NORTH_BACK }),
        makeLine('A-GLAZ', 0.8, 7.9, 2.8, 7.9, { asset_id: 'window_casement_glass', rotation: ROT_SOUTH_BACK }),

        // Furniture: Living Room (y: 0.0 .. 4.0)
        makeRectPoly('A-FURN', 0.25, 1.0, 1.85, 3.2, {
          asset_id: 'sofa_l_modern',
          furnType: 'sofa_sectional',
          name: 'Sofa góc chữ L bọc nỉ Bouclé Ý',
          rotation: ROT_WEST_BACK,
          height: 0.85,
          material: 'Vải nỉ Bouclé Ý & Chân gỗ Óc chó'
        }),
        makeRectPoly('A-FURN', 1.25, 1.05, 3.15, 3.15, {
          asset_id: 'floor_rug_textured',
          furnType: 'rug',
          name: 'Thảm trải sàn dệt nổi Bắc Âu',
          rotation: ROT_WEST_BACK,
          height: 0.02,
          material: 'Sợi len dệt thủ công Bắc Âu'
        }),
        makeRectPoly('A-FURN', 1.95, 1.55, 2.65, 2.65, {
          asset_id: 'coffee_table_set',
          furnType: 'coffee_table',
          name: 'Bàn trà đôi mặt đá Marble Carrara',
          rotation: ROT_WEST_BACK,
          height: 0.42,
          material: 'Đá Cẩm thạch Carrara & Khung thép đen'
        }),
        makeRectPoly('A-FURN', 2.05, 0.35, 2.85, 1.15, {
          asset_id: 'armchair_lounge',
          furnType: 'chair_or_nightstand',
          name: 'Ghế Armchair thư giãn Lounge',
          rotation: ROT_NORTH_BACK,
          height: 0.82,
          material: 'Da bò Ý & Chân đồng mạ vàng'
        }),
        makeRectPoly('A-FURN', 4.32, 1.0, 4.82, 3.2, {
          asset_id: 'tv_cabinet_wall_unit',
          furnType: 'tv_console',
          name: 'Hệ kệ Tivi gỗ Óc chó & OLED 75"',
          rotation: ROT_EAST_BACK,
          height: 1.65,
          material: 'Gỗ Óc chó Bắc Mỹ & Màn hình OLED 75"'
        }),
        makeRectPoly('A-FURN', 4.38, 0.22, 4.82, 0.92, {
          asset_id: 'entrance_shoe_cabinet',
          furnType: 'wardrobe',
          name: 'Tủ giày sảnh đón & Ghế thay giày',
          rotation: ROT_EAST_BACK,
          height: 1.15,
          material: 'Gỗ Sồi tự nhiên & Mặt đá Marble'
        }),
        makeRectPoly('A-FURN', 0.25, 0.25, 0.85, 0.85, {
          asset_id: 'indoor_potted_ficus',
          furnType: 'plants',
          name: 'Chậu cây Bàng Singapore phòng khách',
          rotation: ROT_NORTH_BACK,
          height: 1.35,
          material: 'Chậu Gốm Bát Tràng & Cây xanh tự nhiên'
        }),

        // Furniture: Kitchen & Dining (x: 0.0 .. 3.5, y: 4.0 .. 8.0)
        makeRectPoly('A-FURN', 0.45, 4.35, 2.25, 5.3, {
          asset_id: 'dining_table_6chairs',
          furnType: 'dining_table',
          name: 'Bàn ăn mặt đá Marble & 6 Ghế bọc da',
          rotation: ROT_NORTH_BACK,
          height: 0.76,
          material: 'Đá Cẩm thạch trắng & Gỗ Sồi'
        }),
        makeRectPoly('A-FURN', 0.55, 5.8, 2.35, 6.5, {
          asset_id: 'kitchen_island_bar',
          furnType: 'kitchen_cabinet',
          name: 'Bàn đảo bếp mặt đá Waterfall & Ghế Bar',
          rotation: ROT_SOUTH_BACK,
          height: 0.92,
          material: 'Đá Marble Carrara & Gỗ Óc chó'
        }),
        makeRectPoly('A-FURN', 0.25, 7.1, 2.55, 7.8, {
          asset_id: 'kitchen_system_i',
          furnType: 'kitchen_cabinet',
          name: 'Hệ tủ bếp chữ I kịch trần & Bếp từ',
          rotation: ROT_SOUTH_BACK,
          height: 2.25,
          material: 'Acrylic bóng gương & Đá Marble Carrara'
        }),
        makeRectPoly('A-FURN', 2.6, 7.05, 3.38, 7.8, {
          asset_id: 'fridge_double_door',
          furnType: 'kitchen_cabinet',
          name: 'Tủ lạnh Side-by-Side Inverter mặt thép',
          rotation: ROT_SOUTH_BACK,
          height: 1.82,
          material: 'Thép không gỉ Brushed Steel'
        }),

        // Sanitary: WC Tầng 1 (x: 3.5 .. 5.0, y: 6.2 .. 8.0)
        makeRectPoly('A-SANR', 4.25, 6.35, 4.82, 7.05, {
          asset_id: 'lavabo_vanity_led_mirror',
          furnType: 'vanity',
          name: 'Tủ Lavabo mặt đá & Gương LED (WC T1)',
          rotation: ROT_EAST_BACK,
          height: 1.8,
          material: 'Đá Marble Carrara & Gương LED Halo'
        }),
        makeRectPoly('A-SANR', 3.72, 7.15, 4.32, 7.8, {
          asset_id: 'toilet_onepiece',
          furnType: 'toilet',
          name: 'Bồn cầu liền khối thông minh TOTO (WC T1)',
          rotation: ROT_SOUTH_BACK,
          height: 0.74,
          material: 'Sứ vệ sinh tráng men Nano'
        }),

        // Site elements
        makeCircle('A-SITE', -0.8, 1.0, 0.5),
        makeCircle('A-SITE', 5.8, 1.0, 0.5),
        // Annotations
        makeText('A-ANNO', 'PHÒNG KHÁCH (18.5 m²)', 1.5, 2.2),
        makeText('A-ANNO', 'BẾP & PHÒNG ĂN (14.2 m²)', 1.4, 6.2),
        makeText('A-ANNO', 'WC TẦNG 1 (3.2 m²)', 4.0, 7.0)
      ]
    },

    // --- TẦNG 2 ---
    {
      id: 'floor_2',
      name: 'Tầng 2',
      desc: 'Phòng ngủ Master, Phòng thay đồ, WC riêng & Ban công',
      elevation: 3.8,
      height: 3.4,
      entities: [
        makeRectPoly('A-WALL-EXTR', 0.0, 0.0, 5.0, 8.0),
        makeRectPoly('A-COLS', 0.0, 0.0, 0.22, 0.22),
        makeRectPoly('A-COLS', 4.78, 0.0, 5.0, 0.22),
        makeRectPoly('A-COLS', 0.0, 3.89, 0.22, 4.11),
        makeRectPoly('A-COLS', 4.78, 3.89, 5.0, 4.11),
        makeRectPoly('A-COLS', 0.0, 7.78, 0.22, 8.0),
        makeRectPoly('A-COLS', 4.78, 7.78, 5.0, 8.0),
        makeLine('A-WALL-INTR', 0.0, 4.5, 3.5, 4.5),
        makeLine('A-WALL-INTR', 3.5, 4.0, 3.5, 7.8),
        makeLine('A-WALL-INTR', 2.0, 4.5, 2.0, 7.8),
        ...makeStairLines(3.6, 4.0, 4.8, 6.1, 10, 'stair_flight_straight', ROT_NORTH_BACK),
        makeDoorPoint(3.1, 4.5, 'door_interior_wood', ROT_NORTH_BACK, 0.9),
        makeDoorPoint(2.0, 5.4, 'door_interior_wood', ROT_WEST_BACK, 0.85),
        makeDoorPoint(2.5, 0.1, 'door_balcony_glass', ROT_NORTH_BACK, 1.8),
        makeLine('A-GLAZ', 0.6, 0.1, 4.4, 0.1, { asset_id: 'window_casement_glass', rotation: ROT_NORTH_BACK }),

        // Balcony Greenery & Railing (y: 0.0 .. 0.8)
        makeRectPoly('A-FURN', 0.25, 0.12, 1.45, 0.55, {
          asset_id: 'balcony_planter_greenery',
          furnType: 'plants',
          name: 'Bồn cây tiểu cảnh Ban công Tầng 2',
          rotation: ROT_NORTH_BACK,
          height: 0.85,
          material: 'Chậu đá mài & Cây nhiệt đới'
        }),
        makeRectPoly('A-FURN', 0.3, 0.02, 4.7, 0.16, {
          asset_id: 'railing_iron_baluster',
          furnType: 'railing',
          name: 'Hệ lan can sắt mỹ thuật Ban công Tầng 2',
          rotation: ROT_NORTH_BACK,
          height: 1.05,
          material: 'Hợp kim sắt sơn tĩnh điện đen mờ'
        }),

        // Master Bedroom (y: 0.8 .. 4.5)
        makeRectPoly('A-FURN', 0.25, 1.25, 2.35, 3.25, {
          asset_id: 'bed_master_king',
          furnType: 'bed_master',
          name: 'Giường ngủ Master King Size & Táp đầu giường',
          rotation: ROT_WEST_BACK,
          height: 1.15,
          material: 'Gỗ Óc chó, Nệm Linen Ý & Đèn ngủ ấm'
        }),
        makeRectPoly('A-FURN', 0.25, 3.4, 0.78, 4.35, {
          asset_id: 'dressing_table_mirror',
          furnType: 'desk',
          name: 'Bàn trang điểm gương tròn LED & Đôn nhung',
          rotation: ROT_WEST_BACK,
          height: 1.35,
          material: 'Gỗ Sồi, Gương LED cảm ứng & Chân đồng'
        }),
        makeRectPoly('A-FURN', 4.32, 1.3, 4.82, 3.3, {
          asset_id: 'tv_cabinet_wall_unit',
          furnType: 'tv_console',
          name: 'Hệ kệ Tivi gỗ Óc chó Phòng ngủ Master',
          rotation: ROT_EAST_BACK,
          height: 1.6,
          material: 'Gỗ Óc chó Bắc Mỹ & Màn hình OLED'
        }),
        makeRectPoly('A-FURN', 4.15, 0.65, 4.75, 1.2, {
          asset_id: 'indoor_potted_ficus',
          furnType: 'plants',
          name: 'Chậu cây xanh trang trí Phòng Master',
          rotation: ROT_NORTH_BACK,
          height: 1.3,
          material: 'Chậu Gốm & Cây xanh nội thất'
        }),

        // Walk-in Closet (x: 0.0 .. 2.0, y: 4.5 .. 7.8)
        makeRectPoly('A-FURN', 0.22, 4.8, 0.82, 7.3, {
          asset_id: 'wardrobe_tall_glass',
          furnType: 'wardrobe',
          name: 'Hệ tủ áo Walk-in Closet cánh kính Fluted LED',
          rotation: ROT_WEST_BACK,
          height: 2.4,
          material: 'Kính sọc Fluted Glass, Khung nhôm đen & LED'
        }),

        // Master Bathroom (x: 2.0 .. 3.5, y: 4.5 .. 7.8)
        makeRectPoly('A-SANR', 2.2, 4.65, 3.25, 5.2, {
          asset_id: 'lavabo_vanity_led_mirror',
          furnType: 'vanity',
          name: 'Tủ Lavabo Đá Carrara & Gương LED (WC Master)',
          rotation: ROT_NORTH_BACK,
          height: 1.85,
          material: 'Đá Marble Carrara & Gương LED Halo'
        }),
        makeRectPoly('A-SANR', 2.6, 5.55, 3.4, 7.15, {
          asset_id: 'bathtub_modern',
          furnType: 'bathtub',
          name: 'Bồn tắm nằm Freestanding Sứ Kohler',
          rotation: ROT_EAST_BACK,
          height: 0.62,
          material: 'Sứ Acrylic ngọc trai & Vòi đứng Chrome'
        }),
        makeRectPoly('A-SANR', 1.0, 6.75, 1.92, 7.72, {
          asset_id: 'shower_glass_enclosure',
          furnType: 'shower',
          name: 'Cabin tắm đứng vách kính cường lực Master',
          rotation: ROT_SOUTH_BACK,
          height: 2.1,
          material: 'Kính cường lực 10mm & Sen cây Inox'
        }),
        makeRectPoly('A-SANR', 2.15, 7.18, 2.75, 7.8, {
          asset_id: 'toilet_onepiece',
          furnType: 'toilet',
          name: 'Bồn cầu thông minh TOTO Neorest (WC Master)',
          rotation: ROT_SOUTH_BACK,
          height: 0.74,
          material: 'Sứ vệ sinh tráng men Nano'
        }),

        // Annotations
        makeText('A-ANNO', 'PHÒNG NGỦ MASTER (20.5 m²)', 1.8, 2.5),
        makeText('A-ANNO', 'PHÒNG THAY ĐỒ & WC (11.5 m²)', 2.6, 6.2),
        makeText('A-ANNO', 'BAN CÔNG (4.0 m²)', 2.5, 0.5)
      ]
    },

    // --- TẦNG 3 ---
    {
      id: 'floor_3',
      name: 'Tầng 3',
      desc: 'Phòng ngủ 2, Phòng ngủ trẻ em & học tập, WC & Ban công',
      elevation: 7.2,
      height: 3.4,
      entities: [
        makeRectPoly('A-WALL-EXTR', 0.0, 0.0, 5.0, 8.0),
        makeRectPoly('A-COLS', 0.0, 0.0, 0.22, 0.22),
        makeRectPoly('A-COLS', 4.78, 0.0, 5.0, 0.22),
        makeRectPoly('A-COLS', 0.0, 3.89, 0.22, 4.11),
        makeRectPoly('A-COLS', 4.78, 3.89, 5.0, 4.11),
        makeRectPoly('A-COLS', 0.0, 7.78, 0.22, 8.0),
        makeRectPoly('A-COLS', 4.78, 7.78, 5.0, 8.0),
        makeLine('A-WALL-INTR', 0.0, 4.5, 3.5, 4.5),
        makeLine('A-WALL-INTR', 3.5, 4.0, 3.5, 7.8),
        makeLine('A-WALL-INTR', 2.0, 4.5, 2.0, 7.8),
        ...makeStairLines(3.6, 4.0, 4.8, 6.1, 10, 'stair_flight_straight', ROT_NORTH_BACK),
        makeDoorPoint(3.1, 4.5, 'door_interior_wood', ROT_NORTH_BACK, 0.9),
        makeDoorPoint(2.0, 5.5, 'door_interior_wood', ROT_WEST_BACK, 0.85),
        makeDoorPoint(2.5, 0.1, 'door_balcony_glass', ROT_NORTH_BACK, 1.8),
        makeLine('A-GLAZ', 0.6, 0.1, 4.4, 0.1, { asset_id: 'window_casement_glass', rotation: ROT_NORTH_BACK }),

        // Balcony Greenery & Railing
        makeRectPoly('A-FURN', 3.4, 0.12, 4.6, 0.55, {
          asset_id: 'balcony_planter_greenery',
          furnType: 'plants',
          name: 'Bồn cây tiểu cảnh Ban công Tầng 3',
          rotation: ROT_NORTH_BACK,
          height: 0.85,
          material: 'Chậu đá mài & Cây xanh'
        }),
        makeRectPoly('A-FURN', 0.3, 0.02, 4.7, 0.16, {
          asset_id: 'railing_iron_baluster',
          furnType: 'railing',
          name: 'Hệ lan can sắt mỹ thuật Ban công Tầng 3',
          rotation: ROT_NORTH_BACK,
          height: 1.05,
          material: 'Hợp kim sắt sơn tĩnh điện đen mờ'
        }),

        // Furniture: Bedroom 2 (y: 0.8 .. 4.5)
        makeRectPoly('A-FURN', 0.25, 1.25, 2.25, 3.05, {
          asset_id: 'bed_queen_modern',
          furnType: 'bed_master',
          name: 'Giường ngủ Queen Size gỗ Sồi hiện đại',
          rotation: ROT_WEST_BACK,
          height: 1.08,
          material: 'Gỗ Sồi tự nhiên & Nệm Cotton hữu cơ'
        }),
        makeRectPoly('A-FURN', 0.4, 3.82, 2.4, 4.42, {
          asset_id: 'wardrobe_tall_glass',
          furnType: 'wardrobe',
          name: 'Tủ quần áo cánh kính Phòng ngủ 2',
          rotation: ROT_SOUTH_BACK,
          height: 2.35,
          material: 'Gỗ Sồi & Kính sọc Fluted'
        }),
        makeRectPoly('A-FURN', 4.18, 1.5, 4.82, 2.9, {
          asset_id: 'work_desk_computer',
          furnType: 'desk',
          name: 'Bàn làm việc & Màn hình máy tính (PN2)',
          rotation: ROT_EAST_BACK,
          height: 0.76,
          material: 'Gỗ Sồi & Chân thép sơn tĩnh điện'
        }),

        // Furniture: Kids / Study Room (x: 0.0 .. 2.0, y: 4.5 .. 7.8)
        makeRectPoly('A-FURN', 0.22, 4.75, 1.5, 6.65, {
          asset_id: 'bed_bunk_kids',
          furnType: 'bed_master',
          name: 'Giường tầng trẻ em đa năng kèm cầu thang',
          rotation: ROT_WEST_BACK,
          height: 1.75,
          material: 'Gỗ Thông Bắc Âu sơn an toàn'
        }),
        makeRectPoly('A-FURN', 0.35, 7.1, 1.75, 7.75, {
          asset_id: 'work_desk_computer',
          furnType: 'desk',
          name: 'Bàn học đôi kèm Kệ sách & Máy tính',
          rotation: ROT_SOUTH_BACK,
          height: 0.76,
          material: 'Gỗ Sồi tự nhiên & Ghế công thái học'
        }),

        // Sanitary: WC Tầng 3 (x: 2.0 .. 3.5, y: 4.5 .. 7.8)
        makeRectPoly('A-SANR', 2.2, 4.68, 3.2, 5.25, {
          asset_id: 'lavabo_vanity_led_mirror',
          furnType: 'vanity',
          name: 'Tủ Lavabo mặt đá & Gương LED (WC T3)',
          rotation: ROT_NORTH_BACK,
          height: 1.8,
          material: 'Đá Marble Carrara & Gương LED'
        }),
        makeRectPoly('A-SANR', 2.4, 5.65, 3.4, 6.6, {
          asset_id: 'shower_glass_enclosure',
          furnType: 'shower',
          name: 'Cabin tắm đứng vách kính (WC T3)',
          rotation: ROT_EAST_BACK,
          height: 2.1,
          material: 'Kính cường lực 10mm & Sen cây'
        }),
        makeRectPoly('A-SANR', 2.4, 7.1, 3.05, 7.78, {
          asset_id: 'toilet_onepiece',
          furnType: 'toilet',
          name: 'Bồn cầu liền khối TOTO (WC T3)',
          rotation: ROT_SOUTH_BACK,
          height: 0.74,
          material: 'Sứ vệ sinh tráng men Nano'
        }),

        // Annotations
        makeText('A-ANNO', 'PHÒNG NGỦ 2 (17.0 m²)', 1.8, 2.5),
        makeText('A-ANNO', 'PHÒNG HỌC & LÀM VIỆC (12.0 m²)', 1.2, 6.0),
        makeText('A-ANNO', 'WC TẦNG 3 (3.5 m²)', 2.8, 6.5)
      ]
    },

    // --- TẦNG 4 ---
    {
      id: 'floor_4',
      name: 'Tầng 4',
      desc: 'Phòng thờ gia tiên, Sân thượng Sky Garden & Khu giặt phơi',
      elevation: 10.6,
      height: 3.2,
      entities: [
        makeRectPoly('A-WALL-EXTR', 0.0, 0.0, 5.0, 8.0),
        makeRectPoly('A-COLS', 0.0, 0.0, 0.22, 0.22),
        makeRectPoly('A-COLS', 4.78, 0.0, 5.0, 0.22),
        makeRectPoly('A-COLS', 0.0, 3.89, 0.22, 4.11),
        makeRectPoly('A-COLS', 4.78, 3.89, 5.0, 4.11),
        makeRectPoly('A-COLS', 0.0, 7.78, 0.22, 8.0),
        makeRectPoly('A-COLS', 4.78, 7.78, 5.0, 8.0),
        makeLine('A-WALL-INTR', 0.0, 4.0, 3.5, 4.0),
        makeLine('A-WALL-INTR', 3.5, 4.0, 3.5, 7.8),
        ...makeStairLines(3.6, 4.0, 4.8, 6.1, 10, 'stair_flight_straight', ROT_NORTH_BACK),
        makeDoorPoint(2.8, 4.0, 'door_balcony_glass', ROT_NORTH_BACK, 1.4),
        makeLine('A-GLAZ', 0.8, 0.1, 4.2, 0.1, { asset_id: 'window_casement_glass', rotation: ROT_NORTH_BACK }),

        // Worship Room (x: 0.0 .. 3.5, y: 4.0 .. 8.0)
        makeRectPoly('A-FURN', 0.75, 6.75, 2.72, 7.72, {
          asset_id: 'vietnamese_worship_altar',
          furnType: 'altar_table',
          name: 'Án gian thờ Gia tiên Gỗ Gụ & Tranh Trúc Chỉ',
          rotation: ROT_SOUTH_BACK,
          height: 1.45,
          material: 'Gỗ Gụ chạm khắc, Đồng nguyên chất & Gốm Bát Tràng'
        }),
        makeRectPoly('A-FURN', 0.22, 6.95, 0.72, 7.5, {
          asset_id: 'indoor_potted_ficus',
          furnType: 'plants',
          name: 'Chậu cây Phát Tài phòng thờ',
          rotation: ROT_SOUTH_BACK,
          height: 1.25,
          material: 'Chậu Gốm Bát Tràng & Cây cảnh'
        }),

        // Sky Garden Outdoor Terrace (x: 0.0 .. 5.0, y: 0.0 .. 4.0)
        makeRectPoly('A-FURN', 1.35, 1.35, 3.05, 2.45, {
          asset_id: 'outdoor_patio_set',
          furnType: 'dining_table',
          name: 'Bộ bàn trà & Ghế thư giãn Sân thượng Sky Garden',
          rotation: ROT_NORTH_BACK,
          height: 0.75,
          material: 'Gỗ Teak ngoài trời & Đệm chống thấm'
        }),
        makeRectPoly('A-FURN', 0.35, 3.12, 2.45, 3.85, {
          asset_id: 'outdoor_bbq_station',
          furnType: 'bbq',
          name: 'Quầy Bar & Bếp nướng BBQ Inox Sân thượng',
          rotation: ROT_SOUTH_BACK,
          height: 0.95,
          material: 'Thép không gỉ 304 & Đá Granite đen'
        }),
        makeRectPoly('A-FURN', 0.25, 0.22, 1.55, 0.72, {
          asset_id: 'balcony_planter_greenery',
          furnType: 'plants',
          name: 'Bồn cây tiểu cảnh nhiệt đới Sân thượng (Trái)',
          rotation: ROT_NORTH_BACK,
          height: 0.85,
          material: 'Chậu đá mài & Cây nhiệt đới'
        }),
        makeRectPoly('A-FURN', 3.35, 0.22, 4.65, 0.72, {
          asset_id: 'balcony_planter_greenery',
          furnType: 'plants',
          name: 'Bồn cây tiểu cảnh nhiệt đới Sân thượng (Phải)',
          rotation: ROT_NORTH_BACK,
          height: 0.85,
          material: 'Chậu đá mài & Cây nhiệt đới'
        }),
        makeRectPoly('A-FURN', 0.3, 0.02, 4.7, 0.16, {
          asset_id: 'railing_iron_baluster',
          furnType: 'railing',
          name: 'Hệ lan can sắt mỹ thuật Sân thượng Tầng 4',
          rotation: ROT_NORTH_BACK,
          height: 1.05,
          material: 'Hợp kim sắt sơn tĩnh điện đen mờ'
        }),

        // Laundry Room (x: 3.5 .. 5.0, y: 6.1 .. 8.0)
        makeRectPoly('A-FURN', 3.85, 6.95, 4.65, 7.75, {
          asset_id: 'washer_dryer_tower',
          furnType: 'kitchen_cabinet',
          name: 'Tháp máy giặt sấy chồng tầng LG WashTower',
          rotation: ROT_SOUTH_BACK,
          height: 1.85,
          material: 'Thép sơn tĩnh điện đen mờ & Kính cường lực'
        }),

        // Annotations
        makeText('A-ANNO', 'PHÒNG THỜ GIA TIÊN (13.5 m²)', 1.8, 5.8),
        makeText('A-ANNO', 'SÂN THƯỢNG SKY GARDEN (16.0 m²)', 2.0, 2.0),
        makeText('A-ANNO', 'KHU GIẶT PHƠI (6.5 m²)', 4.0, 7.0)
      ]
    }
  ]
});


// =========================================================================
// PROJECT 2: BIỆT THỰ SÂN VƯỜN 3 TẦNG (12 × 16 M)
// =========================================================================
export const PROJECT_VILLA_GARDEN_3F = new ProjectDocument({
  id: 'biet-thu-san-vuon-3-tang-12x16',
  title: 'Biệt thự Sân vườn 3 Tầng (12 × 16 m)',
  code: 'NN-2026-BTV03',
  subtitle: 'HỒ SƠ THIẾT KẾ BIỆT THỰ SINH THÁI CAO CẤP',
  lot_width: 18.0,
  lot_length: 24.0,
  lot_area: 432.0,
  total_floor_area: 520.0,
  metadata: {
    author: 'Tổng công trình sư Trần Quang Huy - Nếp Nhà Architecture',
    style: 'Modern Luxury Eco-Villa',
    orientation: 'Đông Nam (South-East)',
    estimatedCostVND: 6800000000,
    tags: ['Biệt Thự', 'Sân Vườn', 'Hồ Bơi', 'Phòng Gym', 'Phòng Thờ', '3 Tầng', '12x16m', 'GLB 3D']
  },
  floors: [
    // --- TẦNG 1 ---
    {
      id: 'floor_1',
      name: 'Tầng 1',
      desc: 'Đại sảnh, Phòng khách thông tầng, Bếp đảo & Ăn VIP, PN Ông bà, Hồ bơi & Gara',
      elevation: 0.0,
      height: 4.0,
      entities: [
        // Building Footprint (12x16m offset within 18x24m site)
        makeRectPoly('A-WALL-EXTR', 2.0, 3.0, 14.0, 19.0),
        // Site Boundary
        makeRectPoly('A-SITE', 0.0, 0.0, 18.0, 24.0),
        // Outdoor Swimming Pool (Hồ bơi tràn viền)
        makeRectPoly('A-SITE', 14.5, 6.0, 17.5, 15.0),
        // Koi Fish Pond & Driveway
        makeRectPoly('A-SITE', 0.5, 1.0, 5.0, 2.5),
        // Landscape Trees
        makeCircle('A-SITE', 1.0, 3.0, 0.8),
        makeCircle('A-SITE', 1.0, 8.0, 0.9),
        makeCircle('A-SITE', 1.0, 14.0, 0.8),
        makeCircle('A-SITE', 1.0, 20.0, 1.0),
        makeCircle('A-SITE', 16.0, 3.0, 0.8),
        makeCircle('A-SITE', 16.0, 18.0, 0.9),
        makeCircle('A-SITE', 16.0, 22.0, 1.1),
        // Structural Columns (0.4 x 0.4m grid)
        makeRectPoly('A-COLS', 2.0, 3.0, 2.4, 3.4),
        makeRectPoly('A-COLS', 6.0, 3.0, 6.4, 3.4),
        makeRectPoly('A-COLS', 10.0, 3.0, 10.4, 3.4),
        makeRectPoly('A-COLS', 13.6, 3.0, 14.0, 3.4),
        makeRectPoly('A-COLS', 2.0, 8.0, 2.4, 8.4),
        makeRectPoly('A-COLS', 13.6, 8.0, 14.0, 8.4),
        makeRectPoly('A-COLS', 2.0, 13.5, 2.4, 13.9),
        makeRectPoly('A-COLS', 13.6, 13.5, 14.0, 13.9),
        makeRectPoly('A-COLS', 2.0, 18.6, 2.4, 19.0),
        makeRectPoly('A-COLS', 6.0, 18.6, 6.4, 19.0),
        makeRectPoly('A-COLS', 10.0, 18.6, 10.4, 19.0),
        makeRectPoly('A-COLS', 13.6, 18.6, 14.0, 19.0),
        // Interior Walls
        makeLine('A-WALL-INTR', 2.0, 10.0, 7.0, 10.0),
        makeLine('A-WALL-INTR', 7.0, 3.0, 7.0, 19.0),
        makeLine('A-WALL-INTR', 7.0, 11.5, 14.0, 11.5),
        makeLine('A-WALL-INTR', 2.0, 15.0, 7.0, 15.0),
        // Grand Staircase
        ...makeStairLines(7.2, 9.0, 9.8, 11.4, 14, 'stair_flight_u_turn', ROT_NORTH_BACK),
        // Doors & Glazing
        makeDoorPoint(5.0, 3.1, 'door_balcony_glass', ROT_NORTH_BACK, 1.8),
        makeDoorPoint(7.1, 12.0, 'door_interior_wood', ROT_WEST_BACK, 0.95),
        makeDoorPoint(4.5, 10.1, 'door_interior_wood', ROT_NORTH_BACK, 0.9),
        makeLine('A-GLAZ', 8.0, 3.1, 13.5, 3.1, { asset_id: 'window_casement_glass', rotation: ROT_NORTH_BACK }),
        makeLine('A-GLAZ', 13.9, 6.5, 13.9, 11.0, { asset_id: 'window_casement_glass', rotation: ROT_EAST_BACK }),

        // Furniture: Living Room (x: 7.0..14.0, y: 3.0..11.5)
        makeRectPoly('A-FURN', 8.4, 4.6, 11.6, 6.3, {
          asset_id: 'sofa_l_modern',
          furnType: 'sofa_sectional',
          name: 'Sofa góc chữ L bọc da Ý Minotti',
          rotation: ROT_NORTH_BACK,
          height: 0.85,
          material: 'Da bò Ý tự nhiên & Gỗ Óc chó'
        }),
        makeRectPoly('A-FURN', 11.9, 5.2, 12.8, 7.5, {
          asset_id: 'sofa_straight_3seat',
          furnType: 'sofa',
          name: 'Sofa băng 3 chỗ view Hồ bơi',
          rotation: ROT_EAST_BACK,
          height: 0.84,
          material: 'Vải Bouclé kem & Khung gỗ Sồi'
        }),
        makeRectPoly('A-FURN', 7.45, 6.5, 8.35, 7.4, {
          asset_id: 'armchair_lounge',
          furnType: 'chair_or_nightstand',
          name: 'Ghế Armchair Lounge xoay 360°',
          rotation: ROT_WEST_BACK,
          height: 0.82,
          material: 'Da lộn Cognac & Chân đồng'
        }),
        makeRectPoly('A-FURN', 8.5, 5.8, 11.5, 8.1, {
          asset_id: 'floor_rug_textured',
          furnType: 'rug',
          name: 'Thảm dệt thủ công Đại sảnh',
          rotation: ROT_NORTH_BACK,
          height: 0.02,
          material: 'Len lông cừu New Zealand'
        }),
        makeRectPoly('A-FURN', 9.3, 6.55, 10.9, 7.45, {
          asset_id: 'coffee_table_set',
          furnType: 'coffee_table',
          name: 'Bàn trà đôi mặt đá Cẩm thạch & Khay trà',
          rotation: ROT_NORTH_BACK,
          height: 0.42,
          material: 'Đá Marble Carrara & Chân đồng'
        }),
        makeRectPoly('A-FURN', 8.5, 3.22, 12.3, 3.72, {
          asset_id: 'tv_cabinet_wall_unit',
          furnType: 'tv_console',
          name: 'Hệ vách Tivi gỗ Óc chó & Tủ rượu LED',
          rotation: ROT_NORTH_BACK,
          height: 1.75,
          material: 'Gỗ Óc chó Bắc Mỹ & Kính sọc'
        }),
        makeRectPoly('A-FURN', 7.22, 3.45, 7.68, 4.85, {
          asset_id: 'entrance_shoe_cabinet',
          furnType: 'wardrobe',
          name: 'Tủ giày Đại sảnh & Ghế đón khách',
          rotation: ROT_WEST_BACK,
          height: 1.2,
          material: 'Gỗ Óc chó & Mặt đá trắng'
        }),
        makeRectPoly('A-FURN', 12.85, 3.4, 13.55, 4.1, {
          asset_id: 'indoor_potted_ficus',
          furnType: 'plants',
          name: 'Chậu cây Bàng Singapore Đại sảnh',
          rotation: ROT_NORTH_BACK,
          height: 1.45,
          material: 'Chậu Gốm & Cây xanh tự nhiên'
        }),

        // Furniture: Kitchen & Dining VIP (x: 7.0..14.0, y: 11.5..19.0)
        makeRectPoly('A-FURN', 8.5, 12.6, 12.1, 13.85, {
          asset_id: 'dining_table_6chairs',
          furnType: 'dining_table',
          name: 'Bàn ăn VIP mặt đá Cẩm thạch & Ghế bọc da',
          rotation: ROT_NORTH_BACK,
          height: 0.76,
          material: 'Đá Marble trắng & Gỗ Óc chó'
        }),
        makeRectPoly('A-FURN', 8.8, 15.3, 11.6, 16.3, {
          asset_id: 'kitchen_island_bar',
          furnType: 'kitchen_cabinet',
          name: 'Đảo bếp trung tâm mặt đá & Quầy Bar rượu',
          rotation: ROT_SOUTH_BACK,
          height: 0.92,
          material: 'Đá Marble Carrara & Gỗ Óc chó'
        }),
        makeRectPoly('A-FURN', 8.0, 17.65, 12.2, 18.65, {
          asset_id: 'kitchen_system_l',
          furnType: 'kitchen_cabinet',
          name: 'Hệ tủ bếp chữ L kịch trần & Thiết bị Bosch',
          rotation: ROT_SOUTH_BACK,
          height: 2.3,
          material: 'Acrylic bóng gương & Đá thạch anh'
        }),
        makeRectPoly('A-FURN', 12.4, 17.75, 13.4, 18.65, {
          asset_id: 'fridge_double_door',
          furnType: 'kitchen_cabinet',
          name: 'Tủ lạnh Side-by-Side 4 cánh mặt gương',
          rotation: ROT_SOUTH_BACK,
          height: 1.85,
          material: 'Thép không gỉ & Kính đen'
        }),

        // Furniture: Grandparent Bedroom (x: 2.0..7.0, y: 10.0..15.0)
        makeRectPoly('A-FURN', 2.3, 11.1, 4.4, 13.1, {
          asset_id: 'bed_queen_modern',
          furnType: 'bed_master',
          name: 'Giường ngủ Ông bà gỗ Sồi êm ái',
          rotation: ROT_WEST_BACK,
          height: 1.08,
          material: 'Gỗ Sồi tự nhiên & Nệm Linen'
        }),
        makeRectPoly('A-FURN', 5.85, 11.2, 6.45, 12.4, {
          asset_id: 'dressing_table_mirror',
          furnType: 'desk',
          name: 'Bàn trang điểm & Đọc sách Phòng Ông bà',
          rotation: ROT_EAST_BACK,
          height: 1.3,
          material: 'Gỗ Sồi & Gương LED ấm'
        }),
        makeRectPoly('A-FURN', 2.6, 14.1, 5.4, 14.78, {
          asset_id: 'wardrobe_tall_glass',
          furnType: 'wardrobe',
          name: 'Tủ quần áo kịch trần Phòng Ông bà',
          rotation: ROT_SOUTH_BACK,
          height: 2.35,
          material: 'Gỗ Sồi & Kính cường lực'
        }),

        // Sanitary: Bathroom Tầng 1 (x: 2.0..7.0, y: 15.0..19.0)
        makeRectPoly('A-SANR', 2.35, 17.55, 4.15, 18.6, {
          asset_id: 'bathtub_modern',
          furnType: 'bathtub',
          name: 'Bồn tắm ngâm thảo dược Phòng Ông bà',
          rotation: ROT_SOUTH_BACK,
          height: 0.62,
          material: 'Sứ tráng men Nano Kohler'
        }),
        makeRectPoly('A-SANR', 2.3, 15.35, 3.4, 16.4, {
          asset_id: 'shower_glass_enclosure',
          furnType: 'shower',
          name: 'Cabin tắm đứng chống trượt (WC T1)',
          rotation: ROT_WEST_BACK,
          height: 2.1,
          material: 'Kính cường lực 10mm & Inox 304'
        }),
        makeRectPoly('A-SANR', 4.5, 17.8, 5.7, 18.6, {
          asset_id: 'lavabo_vanity_led_mirror',
          furnType: 'vanity',
          name: 'Bàn Lavabo mặt đá & Gương LED (WC T1)',
          rotation: ROT_SOUTH_BACK,
          height: 1.85,
          material: 'Đá Marble Carrara & Gương LED'
        }),
        makeRectPoly('A-SANR', 5.95, 17.85, 6.65, 18.65, {
          asset_id: 'toilet_onepiece',
          furnType: 'toilet',
          name: 'Bồn cầu liền khối thông minh TOTO (WC T1)',
          rotation: ROT_SOUTH_BACK,
          height: 0.74,
          material: 'Sứ kháng khuẩn Cefiontect'
        }),

        // Annotations
        makeText('A-ANNO', 'PHÒNG KHÁCH THÔNG TẦNG (48.0 m²)', 10.5, 6.0),
        makeText('A-ANNO', 'BẾP ĐẢO & PHÒNG ĂN VIP (38.0 m²)', 10.5, 15.0),
        makeText('A-ANNO', 'PHÒNG NGỦ ÔNG BÀ (25.0 m²)', 4.5, 12.5),
        makeText('A-ANNO', 'HỒ BƠI VÔ CỰC (36.0 m²)', 16.0, 10.0),
        makeText('A-ANNO', 'GARA Ô TÔ (28.0 m²)', 4.5, 6.0)
      ]
    },

    // --- TẦNG 2 ---
    {
      id: 'floor_2',
      name: 'Tầng 2',
      desc: '2 Phòng ngủ Master VIP, Phòng sinh hoạt chung & Ban công view hồ bơi',
      elevation: 4.0,
      height: 3.6,
      entities: [
        makeRectPoly('A-WALL-EXTR', 2.0, 3.0, 14.0, 19.0),
        makeRectPoly('A-COLS', 2.0, 3.0, 2.4, 3.4),
        makeRectPoly('A-COLS', 6.0, 3.0, 6.4, 3.4),
        makeRectPoly('A-COLS', 10.0, 3.0, 10.4, 3.4),
        makeRectPoly('A-COLS', 13.6, 3.0, 14.0, 3.4),
        makeRectPoly('A-COLS', 2.0, 8.0, 2.4, 8.4),
        makeRectPoly('A-COLS', 13.6, 8.0, 14.0, 8.4),
        makeRectPoly('A-COLS', 2.0, 13.5, 2.4, 13.9),
        makeRectPoly('A-COLS', 13.6, 13.5, 14.0, 13.9),
        makeRectPoly('A-COLS', 2.0, 18.6, 2.4, 19.0),
        makeRectPoly('A-COLS', 6.0, 18.6, 6.4, 19.0),
        makeRectPoly('A-COLS', 10.0, 18.6, 10.4, 19.0),
        makeRectPoly('A-COLS', 13.6, 18.6, 14.0, 19.0),
        makeLine('A-WALL-INTR', 2.0, 10.5, 7.0, 10.5),
        makeLine('A-WALL-INTR', 7.0, 3.0, 7.0, 19.0),
        makeLine('A-WALL-INTR', 7.0, 11.5, 14.0, 11.5),
        makeLine('A-WALL-INTR', 2.0, 15.0, 7.0, 15.0),
        ...makeStairLines(7.2, 9.0, 9.8, 11.4, 14, 'stair_flight_u_turn', ROT_NORTH_BACK),
        makeDoorPoint(7.1, 5.0, 'door_interior_wood', ROT_WEST_BACK, 0.95),
        makeDoorPoint(7.1, 13.0, 'door_interior_wood', ROT_WEST_BACK, 0.95),
        makeDoorPoint(10.5, 3.1, 'door_balcony_glass', ROT_NORTH_BACK, 2.0),
        makeLine('A-GLAZ', 8.5, 3.1, 13.5, 3.1, { asset_id: 'window_casement_glass', rotation: ROT_NORTH_BACK }),
        makeLine('A-GLAZ', 13.9, 4.5, 13.9, 9.0, { asset_id: 'window_casement_glass', rotation: ROT_EAST_BACK }),

        // Balcony Greenery & Railing
        makeRectPoly('A-FURN', 8.2, 3.12, 9.8, 3.6, {
          asset_id: 'balcony_planter_greenery',
          furnType: 'plants',
          name: 'Bồn cây tiểu cảnh Ban công view Hồ bơi',
          rotation: ROT_NORTH_BACK,
          height: 0.85,
          material: 'Chậu đá mài & Cây nhiệt đới'
        }),
        makeRectPoly('A-FURN', 7.5, 3.02, 13.5, 3.16, {
          asset_id: 'railing_iron_baluster',
          furnType: 'railing',
          name: 'Lan can Ban công Tầng 2',
          rotation: ROT_NORTH_BACK,
          height: 1.05,
          material: 'Hợp kim sắt sơn tĩnh điện'
        }),

        // Master Bedroom 1 (x: 7.0..14.0, y: 3.0..11.5)
        makeRectPoly('A-FURN', 8.8, 4.2, 11.0, 6.4, {
          asset_id: 'bed_master_king',
          furnType: 'bed_master',
          name: 'Giường ngủ Master King Size Luxury',
          rotation: ROT_NORTH_BACK,
          height: 1.18,
          material: 'Gỗ Óc chó, Da bò Ý & Đèn ngủ ấm'
        }),
        makeRectPoly('A-FURN', 7.3, 4.3, 7.9, 5.5, {
          asset_id: 'dressing_table_mirror',
          furnType: 'desk',
          name: 'Bàn trang điểm gương LED Phòng Master 1',
          rotation: ROT_WEST_BACK,
          height: 1.35,
          material: 'Gỗ Óc chó & Gương tròn cảm ứng'
        }),
        makeRectPoly('A-FURN', 12.95, 4.3, 13.6, 6.7, {
          asset_id: 'tv_cabinet_wall_unit',
          furnType: 'tv_console',
          name: 'Hệ kệ Tivi gỗ Óc chó Phòng Master 1',
          rotation: ROT_EAST_BACK,
          height: 1.65,
          material: 'Gỗ Óc chó Bắc Mỹ & Màn hình OLED'
        }),
        makeRectPoly('A-FURN', 8.0, 9.1, 11.2, 9.8, {
          asset_id: 'wardrobe_tall_glass',
          furnType: 'wardrobe',
          name: 'Hệ tủ áo Walk-in Closet cánh kính LED',
          rotation: ROT_SOUTH_BACK,
          height: 2.4,
          material: 'Kính sọc Fluted Glass & Đèn LED ấm'
        }),
        // Sanitary Master 1
        makeRectPoly('A-SANR', 11.7, 7.5, 13.5, 8.6, {
          asset_id: 'bathtub_modern',
          furnType: 'bathtub',
          name: 'Bồn tắm nằm view Hồ bơi (Master 1)',
          rotation: ROT_EAST_BACK,
          height: 0.62,
          material: 'Sứ Acrylic Kohler & Vòi đồng'
        }),
        makeRectPoly('A-SANR', 9.6, 7.55, 10.9, 8.3, {
          asset_id: 'lavabo_vanity_led_mirror',
          furnType: 'vanity',
          name: 'Bàn Lavabo đôi Đá Carrara (Master 1)',
          rotation: ROT_NORTH_BACK,
          height: 1.85,
          material: 'Đá Marble Carrara & Gương LED'
        }),
        makeRectPoly('A-SANR', 8.0, 7.55, 8.75, 8.3, {
          asset_id: 'toilet_onepiece',
          furnType: 'toilet',
          name: 'Bồn cầu thông minh TOTO (Master 1)',
          rotation: ROT_NORTH_BACK,
          height: 0.74,
          material: 'Sứ tráng men Nano'
        }),

        // Family Living Lounge (x: 7.0..14.0, y: 11.5..19.0)
        makeRectPoly('A-FURN', 8.5, 12.6, 11.8, 14.2, {
          asset_id: 'sofa_l_modern',
          furnType: 'sofa_sectional',
          name: 'Sofa góc chữ L Phòng Sinh hoạt chung',
          rotation: ROT_NORTH_BACK,
          height: 0.85,
          material: 'Vải nỉ Bouclé & Gỗ Sồi'
        }),
        makeRectPoly('A-FURN', 8.6, 13.8, 11.6, 15.8, {
          asset_id: 'floor_rug_textured',
          furnType: 'rug',
          name: 'Thảm dệt Phòng Sinh hoạt chung',
          rotation: ROT_NORTH_BACK,
          height: 0.02,
          material: 'Len dệt Bắc Âu'
        }),
        makeRectPoly('A-FURN', 9.4, 14.5, 10.9, 15.4, {
          asset_id: 'coffee_table_set',
          furnType: 'coffee_table',
          name: 'Bàn trà đôi mặt đá Phòng Sinh hoạt chung',
          rotation: ROT_NORTH_BACK,
          height: 0.42,
          material: 'Đá Marble Carrara'
        }),
        makeRectPoly('A-FURN', 8.5, 18.0, 12.2, 18.6, {
          asset_id: 'tv_cabinet_wall_unit',
          furnType: 'tv_console',
          name: 'Hệ tủ sách & Kệ Tivi Phòng Sinh hoạt chung',
          rotation: ROT_SOUTH_BACK,
          height: 1.7,
          material: 'Gỗ Óc chó & Màn hình OLED'
        }),

        // Kids Bedroom & Study (x: 2.0..7.0, y: 3.0..10.5)
        makeRectPoly('A-FURN', 2.3, 4.2, 3.8, 6.3, {
          asset_id: 'bed_bunk_kids',
          furnType: 'bed_master',
          name: 'Giường tầng trẻ em Bắc Âu kèm cầu thang',
          rotation: ROT_WEST_BACK,
          height: 1.75,
          material: 'Gỗ Thông tự nhiên & Sơn an toàn'
        }),
        makeRectPoly('A-FURN', 2.3, 7.0, 3.05, 8.6, {
          asset_id: 'work_desk_computer',
          furnType: 'desk',
          name: 'Bàn học & Máy tính Phòng trẻ em',
          rotation: ROT_WEST_BACK,
          height: 0.76,
          material: 'Gỗ Sồi & Ghế công thái học'
        }),

        // Master Bedroom 2 (x: 2.0..7.0, y: 10.5..15.0)
        makeRectPoly('A-FURN', 2.3, 11.4, 4.4, 13.4, {
          asset_id: 'bed_queen_modern',
          furnType: 'bed_master',
          name: 'Giường ngủ Queen Size Phòng Master 2',
          rotation: ROT_WEST_BACK,
          height: 1.1,
          material: 'Gỗ Sồi tự nhiên & Nệm Linen'
        }),
        makeRectPoly('A-FURN', 2.5, 14.1, 5.5, 14.8, {
          asset_id: 'wardrobe_tall_glass',
          furnType: 'wardrobe',
          name: 'Tủ quần áo cánh kính Phòng Master 2',
          rotation: ROT_SOUTH_BACK,
          height: 2.4,
          material: 'Kính sọc Fluted & Khung nhôm đen'
        }),

        // Sanitary 2 (x: 2.0..7.0, y: 15.0..19.0)
        makeRectPoly('A-SANR', 2.3, 15.4, 3.4, 16.5, {
          asset_id: 'shower_glass_enclosure',
          furnType: 'shower',
          name: 'Cabin tắm đứng vách kính (WC Master 2)',
          rotation: ROT_WEST_BACK,
          height: 2.1,
          material: 'Kính cường lực 10mm & Sen cây'
        }),
        makeRectPoly('A-SANR', 2.5, 17.75, 3.85, 18.55, {
          asset_id: 'lavabo_vanity_led_mirror',
          furnType: 'vanity',
          name: 'Tủ Lavabo mặt đá & Gương LED (WC Master 2)',
          rotation: ROT_SOUTH_BACK,
          height: 1.85,
          material: 'Đá Marble Carrara & Gương LED'
        }),
        makeRectPoly('A-SANR', 4.8, 17.8, 5.6, 18.6, {
          asset_id: 'toilet_onepiece',
          furnType: 'toilet',
          name: 'Bồn cầu liền khối TOTO (WC Master 2)',
          rotation: ROT_SOUTH_BACK,
          height: 0.74,
          material: 'Sứ tráng men Nano'
        }),

        // Annotations
        makeText('A-ANNO', 'PHÒNG NGỦ MASTER 1 (42.0 m²)', 10.5, 6.0),
        makeText('A-ANNO', 'PHÒNG SINH HOẠT CHUNG (28.0 m²)', 10.5, 14.5),
        makeText('A-ANNO', 'PHÒNG NGỦ MASTER 2 (30.0 m²)', 4.5, 13.0),
        makeText('A-ANNO', 'BAN CÔNG VIEW HỒ BƠI (14.0 m²)', 11.0, 3.5)
      ]
    },

    // --- TẦNG 3 ---
    {
      id: 'floor_3',
      name: 'Tầng 3',
      desc: 'Phòng thờ gia tiên, Phòng Gym & Yoga, Phòng Sauna & Sky Lounge BBQ',
      elevation: 7.6,
      height: 3.6,
      entities: [
        makeRectPoly('A-WALL-EXTR', 2.0, 3.0, 14.0, 19.0),
        makeRectPoly('A-COLS', 2.0, 3.0, 2.4, 3.4),
        makeRectPoly('A-COLS', 6.0, 3.0, 6.4, 3.4),
        makeRectPoly('A-COLS', 10.0, 3.0, 10.4, 3.4),
        makeRectPoly('A-COLS', 13.6, 3.0, 14.0, 3.4),
        makeRectPoly('A-COLS', 2.0, 8.0, 2.4, 8.4),
        makeRectPoly('A-COLS', 13.6, 8.0, 14.0, 8.4),
        makeRectPoly('A-COLS', 2.0, 13.5, 2.4, 13.9),
        makeRectPoly('A-COLS', 13.6, 13.5, 14.0, 13.9),
        makeRectPoly('A-COLS', 2.0, 18.6, 2.4, 19.0),
        makeRectPoly('A-COLS', 6.0, 18.6, 6.4, 19.0),
        makeRectPoly('A-COLS', 10.0, 18.6, 10.4, 19.0),
        makeRectPoly('A-COLS', 13.6, 18.6, 14.0, 19.0),
        makeLine('A-WALL-INTR', 2.0, 9.5, 7.0, 9.5),
        makeLine('A-WALL-INTR', 7.0, 3.0, 7.0, 19.0),
        makeLine('A-WALL-INTR', 7.0, 11.5, 14.0, 11.5),
        ...makeStairLines(7.2, 9.0, 9.8, 11.4, 14, 'stair_flight_u_turn', ROT_NORTH_BACK),
        makeDoorPoint(7.1, 6.0, 'door_interior_wood', ROT_WEST_BACK, 0.95),
        makeDoorPoint(4.5, 9.6, 'door_interior_wood', ROT_NORTH_BACK, 0.95),
        makeDoorPoint(10.5, 11.5, 'door_balcony_glass', ROT_NORTH_BACK, 1.8),
        makeLine('A-GLAZ', 8.5, 3.1, 13.5, 3.1, { asset_id: 'window_casement_glass', rotation: ROT_NORTH_BACK }),

        // Altar Room (x: 2.0..7.0, y: 3.0..9.5)
        makeRectPoly('A-FURN', 3.1, 8.05, 5.4, 9.15, {
          asset_id: 'vietnamese_worship_altar',
          furnType: 'altar_table',
          name: 'Án gian thờ Gia tiên Gỗ Gụ & Vách hậu Trúc Chỉ',
          rotation: ROT_SOUTH_BACK,
          height: 1.48,
          material: 'Gỗ Gụ chạm khắc, Đồng nguyên chất & Gốm Bát Tràng'
        }),
        makeRectPoly('A-FURN', 2.35, 8.15, 2.95, 8.75, {
          asset_id: 'indoor_potted_ficus',
          furnType: 'plants',
          name: 'Chậu Tùng La Hán Phòng thờ (Trái)',
          rotation: ROT_SOUTH_BACK,
          height: 1.3,
          material: 'Chậu Gốm Bát Tràng & Cây cảnh'
        }),
        makeRectPoly('A-FURN', 5.65, 8.15, 6.25, 8.75, {
          asset_id: 'indoor_potted_ficus',
          furnType: 'plants',
          name: 'Chậu Mai Chiếu Thủy Phòng thờ (Phải)',
          rotation: ROT_SOUTH_BACK,
          height: 1.3,
          material: 'Chậu Gốm Bát Tràng & Cây cảnh'
        }),

        // Gym, Study & Fitness Room (x: 7.0..14.0, y: 3.0..11.5)
        makeRectPoly('A-FURN', 8.3, 4.2, 10.1, 5.0, {
          asset_id: 'work_desk_computer',
          furnType: 'gym_machine',
          name: 'Trạm điều khiển Fitness & Bàn làm việc',
          rotation: ROT_NORTH_BACK,
          height: 0.78,
          material: 'Hợp kim thép đen mờ & Gỗ Sồi'
        }),
        makeRectPoly('A-FURN', 10.8, 4.2, 12.8, 5.0, {
          asset_id: 'dining_table_4chairs',
          furnType: 'dining_table',
          name: 'Bàn trà & Thư giãn sau tập Gym',
          rotation: ROT_NORTH_BACK,
          height: 0.76,
          material: 'Gỗ Sồi tự nhiên & Nệm da'
        }),

        // Sauna, Jacuzzi & Laundry (x: 2.0..7.0, y: 9.5..19.0)
        makeRectPoly('A-FURN', 2.3, 10.1, 3.1, 10.9, {
          asset_id: 'washer_dryer_tower',
          furnType: 'kitchen_cabinet',
          name: 'Tháp máy giặt sấy LG WashTower Tầng 3',
          rotation: ROT_WEST_BACK,
          height: 1.85,
          material: 'Thép sơn tĩnh điện đen mờ'
        }),
        makeRectPoly('A-SANR', 4.8, 11.0, 6.5, 12.8, {
          asset_id: 'bathtub_modern',
          furnType: 'bathtub',
          name: 'Bồn tắm Jacuzzi Massage Thủy lực',
          rotation: ROT_EAST_BACK,
          height: 0.65,
          material: 'Sứ Acrylic cao cấp & Vòi Chrome'
        }),
        makeRectPoly('A-SANR', 2.3, 12.0, 3.4, 13.1, {
          asset_id: 'shower_glass_enclosure',
          furnType: 'shower',
          name: 'Cabin tắm tráng Khu Sauna',
          rotation: ROT_WEST_BACK,
          height: 2.1,
          material: 'Kính cường lực 10mm & Sen cây'
        }),
        makeRectPoly('A-SANR', 2.5, 14.5, 3.8, 15.3, {
          asset_id: 'lavabo_vanity_led_mirror',
          furnType: 'vanity',
          name: 'Tủ Lavabo mặt đá Khu Spa & Sauna',
          rotation: ROT_SOUTH_BACK,
          height: 1.85,
          material: 'Đá Marble Carrara & Gương LED'
        }),
        makeRectPoly('A-SANR', 4.5, 14.5, 5.3, 15.3, {
          asset_id: 'toilet_onepiece',
          furnType: 'toilet',
          name: 'Bồn cầu liền khối Khu Spa & Sauna',
          rotation: ROT_SOUTH_BACK,
          height: 0.74,
          material: 'Sứ tráng men Nano'
        }),

        // Sky Lounge & BBQ Party (x: 7.0..14.0, y: 11.5..19.0)
        makeRectPoly('A-FURN', 8.5, 13.0, 11.8, 14.4, {
          asset_id: 'outdoor_patio_set',
          furnType: 'dining_table',
          name: 'Bộ bàn tiệc & Sofa ngoài trời Sky Lounge',
          rotation: ROT_NORTH_BACK,
          height: 0.76,
          material: 'Gỗ Teak ngoài trời & Đệm chống thấm'
        }),
        makeRectPoly('A-FURN', 8.2, 17.5, 11.8, 18.4, {
          asset_id: 'outdoor_bbq_station',
          furnType: 'bbq',
          name: 'Quầy Bar & Bếp nướng BBQ Inox Sky Lounge',
          rotation: ROT_SOUTH_BACK,
          height: 0.95,
          material: 'Thép không gỉ 304 & Đá Granite đen'
        }),
        makeRectPoly('A-FURN', 12.4, 13.0, 13.5, 15.0, {
          asset_id: 'balcony_planter_greenery',
          furnType: 'plants',
          name: 'Bồn cây nhiệt đới Sky Lounge (Đông)',
          rotation: ROT_EAST_BACK,
          height: 0.9,
          material: 'Chậu đá mài & Cây nhiệt đới'
        }),
        makeRectPoly('A-FURN', 7.5, 18.0, 8.1, 18.6, {
          asset_id: 'indoor_potted_ficus',
          furnType: 'plants',
          name: 'Chậu cây cảnh Bàng Singapore Sky Lounge',
          rotation: ROT_SOUTH_BACK,
          height: 1.4,
          material: 'Chậu Gốm & Cây xanh'
        }),

        // Annotations
        makeText('A-ANNO', 'PHÒNG THỜ TRANG NGHIÊM (24.0 m²)', 4.5, 6.0),
        makeText('A-ANNO', 'PHÒNG TẬP GYM & FITNESS (34.0 m²)', 10.5, 6.5),
        makeText('A-ANNO', 'SKY LOUNGE & BBQ PARTY (36.0 m²)', 10.5, 15.0),
        makeText('A-ANNO', 'PHÒNG XÔNG HƠI SAUNA (14.0 m²)', 4.5, 12.0)
      ]
    }
  ]
});

export const SEED_PROJECTS = [
  PROJECT_TOWNHOUSE_4F,
  PROJECT_VILLA_GARDEN_3F
];
