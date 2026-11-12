# Interactive 3D Architectural Dollhouse Web Viewer (Nếp Nhà | Hồ sơ kiến trúc)

## 1. Overview
The **Interactive 3D Architectural Dollhouse Web Viewer** (`web-viewer/`) provides a real-time WebGL/Three.js presentation platform for architectural designs authored in **OpenCADStudio_Z**.

It bridges raw 2D/3D CAD vector drawings (`.dxf`/`.dwg`) with an interactive BIM scene graph, automatically constructing:
- Multi-floor building structures (slabs, columns, walls, stairs, doors, windows).
- Dollhouse architectural cutaways revealing furnished interior layouts.
- Dynamic dual-mode lighting (daylight and warm 3000K interior ceiling lighting).
- Synchronized interactive 2D vector floorplans with real-time selection.
- First-person interior walkthroughs at eye level (1.65m).

---

## 2. Strict Zero-Mock Policy Compliance
In strict adherence to the **Zero-Mock Policy**:
1. **Real-time 3D Rendering (100% Canvas):**
   - The primary viewport is driven directly by Three.js WebGLRenderer with PBR shaders (`MeshStandardMaterial`, `MeshPhysicalMaterial`), soft shadow mapping (`PCFSoftShadowMap`), and ACES Filmic Tone Mapping.
   - Smooth 360° OrbitControls orbiting, dollying, and panning.
2. **CAD-to-BIM Pipeline Execution:**
   - Evaluates actual CAD entities (`LINE`, `LWPOLYLINE`, `ARC`, `CIRCLE`, `TEXT`) and architectural layers:
     * `A-WALL-EXTR`, `A-WALL-INTR`: Wall geometry and cutaway tagging (`isExteriorCutawayWall`).
     * `A-COLS`: Structural reinforced concrete columns.
     * `A-3D-SLAB`: Concrete floor slabs with stairwell openings.
     * `A-STAIR`: Riser/tread geometry, landings, and dark metal railings.
     * `A-DOOR`, `A-GLAZ`: Doors, frames, and high-transmission glass.
     * `A-FURN`, `A-SANR`: Classifies geometric bounding boxes into parametric furniture (sofas, tables, beds, cabinetry, sanitary fixtures, ancestral altar, gym equipment).
     * `A-SITE`: Lot boundary, pond, and landscape vegetation.
     * `A-ANNO`: Room labels and floor area ($m^2$).
3. **Live CAD Ingestion:**
   - Supports user file upload or drag-and-drop of any `.dxf` drawing.

---

## 3. UI/UX Architecture ("Nếp Nhà" Layout)
- **Header:** Brand "Nếp Nhà | Hồ sơ kiến trúc", CAD file upload button (`📂 Nhập file CAD`), and fullscreen toggle.
- **Sidebar (320px width):**
  - **Project Metadata:** Building dimensions, lot area, total floor area ($m^2$).
  - **Floor List ("DANH MỤC TẦNG"):** Floor cards with active indicators, function summaries, and eye icons (`👁️`) to toggle individual floor visibility.
  - **Furniture Inspector ("CHI TIẾT NỘI THẤT"):** Dropdown of furniture items by floor; selecting focuses camera, highlights object, and displays CAD properties.
  - **2D Floorplan Widget ("MẶT BẰNG"):** Live vector SVG thumbnail of the active floor; click to open full CAD blueprint modal.
- **3D Viewport Controls:**
  - `🟠 Đèn nhà: BẬT / TẮT`: Toggles 3000K warm interior ceiling lights.
  - `🏷️ Nhãn phòng: BẬT / TẮT`: Toggles floating 3D room markers with area ($m^2$).
  - **Bottom View Mode Bar:**
    1. `🌐 Tổng thể` (Dollhouse Cutaway View)
    2. `🏢 Mặt tiền` (Full Exterior Facade View)
    3. `📑 Tách tầng` (Exploded Floor View)
    4. `🚶 Đi trong nhà` (First-Person Walkthrough)

---

## 4. Launching the Web Viewer

### With pnpm (Recommended):
```bash
cd web-viewer
pnpm install
pnpm dev
```

### With npm:
```bash
cd web-viewer
npm install
npm run dev
```

### Production Build:
```bash
cd web-viewer
pnpm build
```
Build output is saved to `web-viewer/dist/` (ignored by `.gitignore`).
