# Nếp Nhà | Hồ sơ kiến trúc - 3D Dollhouse Web Viewer

**Interactive 3D Architectural Dollhouse Web Viewer kết nối trực tiếp với file CAD (`.dxf`/`.dwg`) từ OpenCADStudio_Z.**

---

## 🏛️ Giới thiệu tổng quan
Ứng dụng Web này là nền tảng hiển thị hồ sơ kiến trúc đa tầng thời gian thực 100% bằng **Three.js / WebGL**, tuân thủ nguyên tắc **Strict Zero-Mock Policy**:
- **Khung nhìn WebGL thời gian thực:** Xoay 360° với OrbitControls, đổ bóng mềm (PCFSoftShadowMap), vật liệu PBR (Physically Based Rendering).
- **Cầu nối CAD-to-BIM Pipeline:** Tự động đọc dữ liệu các layer thực tế (`A-WALL-EXTR`, `A-WALL-INTR`, `A-COLS`, `A-3D-SLAB`, `A-STAIR`, `A-DOOR`, `A-GLAZ`, `A-FURN`, `A-SANR`, `A-SITE`, `A-ANNO`).
- **4 Chế độ xem 3D chuyên biệt:**
  1. `🌐 Tổng thể` (Dollhouse Cutaway View): Tự động ẩn các bức tường biên phía trước để nhìn xuyên vào không gian nội thất đa tầng như mô hình cắt lớp kiến trúc.
  2. `🏢 Mặt tiền` (Full Exterior Facade View): Hiển thị đầy đủ ngoại thất, lam trang trí, ban công kính và mái.
  3. `📑 Tách tầng` (Exploded Floor View): Tự động tách giãn độ cao các tầng theo phương đứng $Z$ để quan sát độc lập từng tầng.
  4. `🚶 Đi trong nhà` (First-Person Walkthrough): Trải nghiệm đi bộ góc nhìn thứ nhất ở tầm mắt 1.65m với phím `WASD`.
- **Hệ thống chiếu sáng kép:** Bật/Tắt ánh sáng ấm áp ban đêm (`PointLight` 3000K tại từng phòng) và ánh sáng ban ngày.
- **Bản vẽ mặt bằng 2D SVG:** Tự động sinh bản vẽ kỹ thuật 2D cho từng tầng đồng bộ với mô hình 3D.
- **Tải lên file CAD tự do:** Hỗ trợ kéo thả hoặc nạp bất kỳ file `.dxf` nào khác để dựng 3D tức thì.

---

## 🚀 Hướng dẫn chạy ứng dụng

### Cách 1: Chạy bằng pnpm (Khuyên dùng)
```bash
cd web-viewer
pnpm install
pnpm dev
```
Truy cập: `http://localhost:5173/`

### Cách 2: Chạy bằng npm / Vite
```bash
cd web-viewer
npm install
npm run dev
```
Truy cập: `http://localhost:5173/`

### Cách 2: Chạy bằng Python HTTP Server (Không cần cài đặt thêm)
```bash
cd web-viewer
python -m http.server 8080
```
Truy cập: `http://localhost:8080/`

### Build sản phẩm tĩnh (Production Build)
```bash
cd web-viewer
pnpm build
# Hoặc: npm run build
```
File tĩnh sẽ được đóng gói sẵn sàng trong thư mục `dist/`.

---

## 📂 Cấu trúc thư mục
```
web-viewer/
├── .gitignore              # Bỏ qua node_modules, dist, cache, logs
├── package.json            # Scripts dev, build, preview và dependencies Three.js
├── index.html              # Giao diện chuẩn "Nếp Nhà | Hồ sơ kiến trúc"
├── README.md               # Tài liệu hướng dẫn sử dụng
├── css/
│   └── style.css           # Bảng màu kiến trúc sang trọng (#F4F3EF, #EAE8E1, #2C2B29)
├── js/
│   ├── app.js              # Bộ điều phối trung tâm ứng dụng
│   ├── cad_bim_pipeline.js # Parser DXF sang BIMSceneGraph đa tầng
│   ├── viewer_3d.js        # Engine 3D Three.js PBR, ánh sáng, cutaways, camera
│   ├── floorplan_svg.js    # Bộ sinh bản vẽ mặt bằng 2D SVG tương tác
│   └── sample_models.js    # Dữ liệu biệt thự mẫu chuẩn OpenCADStudio
├── sample_data/
│   └── Biet_Thu_Hien_Dai_2_Tang_1_Tum.dxf  # File CAD DXF gốc
└── vendor/
    └── three/              # Bản Three.js ESM dùng offline 100%
```
