# In-App Autonomous AI Copilot & Multimodal AEC Ingestion Engine

## 1. Overview & Architecture

The **In-App Autonomous AI Copilot** is a native CAD agent and multimodal reasoning engine embedded directly inside OpenCADStudio. It seamlessly connects the user's interactive drawing canvas with OpenAI reasoning models through an **in-process direct MCP bridge** and multi-agent background orchestrator without compromising 60 FPS GPU rendering performance.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 OPENCADSTUDIO DESKTOP                                  │
│                                                                                        │
│  ┌───────────────────────────────┐     ┌────────────────────────────────────────────┐  │
│  │   2D/3D WGPU Viewport         │     │         AI Copilot Dock Panel              │  │
│  │   - Real-time Entity Rendering│◄────┼─ Interactive Handles (Click to Zoom/Select)│  │
│  │   - Quad Menu ("Ask AI")      │     │─ Batch Undo, Audit & Fix, Auto-Evolve      │  │
│  │   - Active Selection Tracking ├────►│─ Multimodal Ingestion Bar (.xlsx, .dwg)    │  │
│  └───────────────┬───────────────┘     └─────────────────────┬──────────────────────┘  │
│                  │                                           │                         │
│                  │ Active Tab / Document Session             │ mpsc Event Channel      │
│                  ▼                                           ▼                         │
│  ┌───────────────────────────────┐     ┌────────────────────────────────────────────┐  │
│  │ In-Process MCP Engine         │◄────┤ Multi-Agent Background Worker Thread       │  │
│  │ - ocs_read (Records/Entities) │     │ - Planner Agent (Space planning & grids)   │  │
│  │ - ocs_execute (Batch mutator) │     │ - Execution Agent (Layered CAD drafting)   │  │
│  │ - ocs_capture (Vision QA)     │     │ - QA Critic Agent (Visual & rule audits)   │  │
│  │ - In-Memory JSON-RPC (Zero Subprocess)  - Evolution Agent (Iterative completion) │  │
│  └───────────────────────────────┘     └─────────────────────┬──────────────────────┘  │
└──────────────────────────────────────────────────────────────┼─────────────────────────┘
                                                               ▼
                                                  OpenAI Chat Completions API
                                                  (GPT-4o / o3-mini / Custom Endpoint)
```

---

## 2. In-Process Direct MCP Bridge (Zero Subprocess)

Unlike external automation runners that spawn separate desktop instances, the In-App AI Copilot operates via **in-process direct message dispatch**:
- **Direct Memory Access:** Tool calls (`ocs_read`, `ocs_execute`, `ocs_capture`, `ocs_sessions`) are routed directly to the running `OpenCADStudio` instance in memory via `handle_message()`.
- **Zero Overhead:** No child process spawning, pipe contention, or synchronization delays.
- **Immediate Repaint:** Viewport geometry epochs update immediately upon tool completion, ensuring edits appear on screen in real time.
- **Factory Wiring:** Built through `OpenCADStudio::mcp::create_in_process_mcp_client(timeout)` and registered as the primary client provider in `ocs_ai_worker::orchestrator::WorkerConfig`.

---

## 3. Multimodal AEC File Ingestion Engine

Users can attach files via drag-and-drop or file picker in the AI Copilot input bar.

### 3.1. Excel & CSV Schedule Ingestion (`calamine`)
- **Native Pure-Rust Parser:** Uses `calamine` with pure-Rust CSV fallback. Zero dependency on Microsoft Excel or external Office automation.
- **Supported Formats:** `.xlsx`, `.xls`, `.csv`, `.tsv`.
- **AEC Semantic Extraction:**
  * **Site Dimensions:** Extract boundary width, depth, and front/rear/side setbacks.
  * **Grid Axes:** Extract structural grid offsets (X1, X2, Y1, Y2...) and calculate column bay widths.
  * **Level Elevations:** Extract floor names, Z-elevations, floor-to-floor heights, and clear heights.
  * **Room Schedules:** Extract room names, target areas ($m^2$), minimum dimensions, functional classifications, and wet area flags (`[WET]`).
  * **Door & Window Schedules:** Extract opening tags (`D1`, `D2`, `W1`), widths, heights, sill elevations, and parent rooms.
  * **Furniture Lists:** Extract item types (`bed`, `sofa`, `table`, `toilet`, `sink`, `wardrobe`), bounding dimensions, and clearance zones.
- **Excel-to-CAD Reconciliation (`reconcile_excel_with_cad`):**
  Automatically compares the Excel schedule against live drawing text annotations and hatch boundaries to identify missing rooms, area deviations exceeding $\pm 10\%$, and generates suggested CAD correction steps.

### 3.2. DWG / DXF Semantic Ingestion
- **Mode A (Open as Active Base Drawing):** Loads the file as the active document, performs health audit, and builds initial context for AI generation.
- **Mode B (Merge Into Current Drawing):** Imports block definitions, boundaries, and site plans into the current active document without overwriting work.
- **Spatial Context Summarizer (Architectural Semantic Digest):**
  Compresses complex drawings containing tens of thousands of entities into a token-efficient semantic digest for LLM reasoning:
  * Extents and overall bounding box (e.g. `[0, 0] to [15000, 25000]` mm).
  * Layer inventory and entity distribution.
  * Block catalog and instance counts.
  * Detected structural grid axes.
  * Closed room boundaries with calculated areas ($m^2$) and associated text annotations (`TEXT`/`MTEXT`).

---

## 4. In-App AI Copilot UI & Controls

### 4.1. Accessing the AI Copilot Panel
- **Command Line:** Type `AICOPILOT`, `COPILOT`, or `AI` in the command prompt and press Enter.
- **Quad Cursor Menu:** Select any objects in the viewport, right-click/dwell to open the Quad Menu, and click **"Ask AI / Auto-Develop Selection"**.
- **Dock Tabs:** The panel docks alongside Properties, Layers, and Tool Palettes, supporting drag-resize and auto-collapse.

### 4.2. Chat Panel Controls
- **Live Agent Status Card:** Displays the currently active agent (`[Planner]`, `[Execution]`, `[QA Critic]`, `[Evolution]`), current phase name, completed/total steps progress bar, and real-time execution details.
- **Interactive Entity Handles:** Entity handles (`#2A`, `#2B`...) mentioned in AI responses are interactive buttons. Clicking a handle automatically selects the entity and centers/zooms the viewport directly to it (`SELECT` + `ZOOM O`).
- **Quick Action Buttons:**
  * **Undo AI Batch:** Instantly reverts the entire latest AI batch via `UNDO 1`.
  * **Run Audit & Fix:** Performs automated visual and rule-based inspection (`AUDIT Y`).
  * **Auto-Evolve Next Step:** Directs the Evolution Agent to proceed to the next architectural phase.
- **Active Selection Context Banner:** Automatically senses currently selected entities on the canvas and attaches their handles and properties to prompts.

### 4.3. Settings & Persistence
Click the gear icon (⚙) at the top of the AI Copilot panel to configure:
- `API Key`: Stored securely in `app_config.json` (falls back to `$OPENAI_API_KEY`).
- `Base URL`: Configurable for official OpenAI or local/custom proxy endpoints (e.g. `http://127.0.0.1:55790/v1`).
- `Planner Model`: e.g. `gpt-4o` or `o3-mini`.
- `Vision QA Model`: e.g. `gpt-4o` for visual screenshot verification.

---

## 5. Verification & Test Suite

The copilot suite is tested end-to-end in `tests/copilot_multimodal_tests.rs`:
- `test_excel_multimodal_aec_ingestion_and_diff`: Validates multi-room scheduling, area parsing, prompt digest generation, and CAD diff reconciliation.
- `test_dwg_spatial_context_summarizer`: Validates closed polyline perimeter detection (375 $m^2$), text entity label association, and bounding box computation.
- `test_copilot_state_and_event_streaming`: Validates asynchronous progress streaming, batch execution state transitions, and interactive handle generation.
- `test_in_process_mcp_client_bridge`: Validates direct zero-subprocess in-memory tool execution for `ocs_sessions` and `ocs_read`.
- `test_e2e_ui_chat_controller_full_villa_workflow`: Full end-to-end integration test validating the entire UI chat controller pipeline, multi-agent event streaming, non-overlapping multi-view layout, and deliverable cryptographic verification.

To run the verification suite:
```powershell
cargo test --test integration copilot_multimodal_tests
```

---

## 6. End-to-End Case Study: Modern 2-Story + Rooftop Villa (15m x 24m)

The full autonomous generation pipeline can be executed via `scripts/generate_villa_complete.py`:
```powershell
python scripts/generate_villa_complete.py
```

### Architectural Layout & Coordinate Regions
- **Region 1 (X0=0, Y0=0):** Mặt bằng Tầng 1 (Sảnh, Phòng khách thông tầng, Bếp ăn, Phòng ngủ ông bà khép kín, Gara, WC1, Sân trước hồ cá Koi, Sân sau).
- **Region 2 (X0=22000, Y0=0):** Mặt bằng Tầng 2 (Phòng ngủ Master + Ban công kính + Walk-in closet, 2 Phòng ngủ con, Sinh hoạt chung, Khoảng thông tầng Void).
- **Region 3 (X0=44000, Y0=0):** Mặt bằng Tầng Tum & Mái (Phòng thờ, Phòng gym, Sân thượng trước BBQ, Sân phơi sau, Buồng thang).
- **Region 4 (X0=0, Y0=-18000):** Mặt đứng chính (Trục 1-4) thể hiện tam cấp, ban công kính, lam chắn nắng, mái vươn và mốc cao độ (-0.450, ±0.000, +3.900, +7.500, +10.800, +11.400).
- **Region 5 (X0=22000, Y0=-18000):** Mặt đứng bên trái (Trục A-D) dài 16m.
- **Region 6 (X0=44000, Y0=-18000):** Mặt cắt dọc A-A qua phòng khách thông tầng và buồng thang bộ 25 bậc.
- **Region 7 (X0=66000, Y0=0, Z0=0):** Mô hình khối 3D BIM Massing của toàn bộ công trình.

### Deliverables & Verification Metrics
- **Deliverable DXF:** `target/ai-deliveries/Biet_Thu_Hien_Dai_2_Tang_1_Tum.dxf`
  * Size: 235,467 bytes
  * SHA-256: `95d684ca5a2bcb9f99dff0b8f5b1340bb9e74547e8e09f1671079761035be686`
- **Deliverable DWG:** `target/ai-deliveries/Biet_Thu_Hien_Dai_2_Tang_1_Tum.dwg`
  * Size: 42,110 bytes
  * SHA-256: `d827d5bf41c7b9024413d210741bc0d18a4c9f7a28177ab7e3543df92c3830dc`
- **Rendered Viewport Snapshot (PNG):** `target/ai-deliveries/Biet_Thu_Hien_Dai_2_Tang_1_Tum.png`
  * Size: 296,921 bytes
- **Audit Summary:** `status: "passed"`, `errors: 0`, `warnings: 0`, `dropped_on_save: 0`, `lossless: true`.
- **Entity Count:** 603 total CAD entities distributed across 15 standard AIA layers.

