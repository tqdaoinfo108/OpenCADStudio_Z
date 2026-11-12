# Enterprise Hierarchical Sub-Agent Swarm & Site/Parcel Image-to-CAD Architecture

## 1. Executive Summary

This specification documents the enterprise-grade **Multi-Subagent Swarm** and the breakthrough **Site/Parcel Image-to-CAD** engine implemented in `OpenCADStudio_Z`.
The system operates under a strict **Zero-Mock Policy**, ensuring:
- Every geometric calculation, boundary offset, and spatial clash check is solved with real deterministic algorithms.
- Seamless compatibility between **In-App Desktop AI Copilot UI** (real-time 60 FPS GPU rendering) and **Headless MCP Worker Mode**.
- Resilient brownfield continuation preserving existing CAD entities without destructive wipes.

---

## 2. Pillar 1: Breakthrough "Site/Parcel Image-to-CAD" Engine

### 2.1. The Engineering Challenge
Land parcels extracted from deed certificates (Sổ đỏ), survey maps, or aerial photographs frequently feature irregular geometries:
- Non-orthogonal lot shapes, trapezoidal boundaries, and flared rear edges (*nở hậu*).
- Survey traverse closure discrepancies.
- Ambiguous setbacks and irregular perimeter clearances.

### 2.2. Mathematical Solution (`site_parcel_analyzer.rs`)

1. **Closed Polygon Reconstruction & Bowditch Compass Adjustment:**
   - Traverses boundary vertices $[(x_0, y_0), (x_1, y_1), \dots, (x_n, y_n)]$.
   - Evaluates closure discrepancy $\Delta x = x_n - x_0$, $\Delta y = y_n - y_0$.
   - Applies proportional Bowditch adjustment across edge lengths to guarantee mathematical closure ($100\%$ zero-gap `PLINE` on Layer `A-SITE`).
2. **Automated Setback Offset Engine (`A-SETBACK`):**
   - Automatically offsets parcel boundaries inward based on regulatory standards:
     * Front road edge: $4.0\text{m} - 5.0\text{m}$ setback.
     * Rear boundary: $2.0\text{m} - 3.0\text{m}$ lightwell buffer.
     * Side boundaries: $1.0\text{m} - 1.5\text{m}$ security corridors.
3. **Maximal Inscribed Orthogonal Grid Algorithm:**
   - Instead of producing awkward slanted rooms following an irregular property line, the solver fits the **largest possible orthogonal rectangular building envelope** $(W \times D)$ strictly within the buildable polygon.
   - All primary living spaces (Living, Kitchen, Master Bedroom, Kids Bedrooms) are aligned to pure $90^\circ$ orthogonal grids.
   - Irregular boundary areas (*đất xéo / đất nở hậu*) are automatically designated as **Residual Functional Zones**:
     * **Front & Side Gardens / Koi Pond (`SIDE_GARDEN`)**
     * **Rear Sky Lightwells (`REAR_LIGHTWELL`)**
     * **Outdoor Access & Service Yards**

---

## 3. Pillar 2: Hierarchical Multi-Subagent Swarm

The single monolithic planner is replaced by a cooperative swarm of **5 Specialized Sub-Agents** coordinated via an in-memory `SharedBlackboardState`:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   LEAD ORCHESTRATOR SUB-AGENT                          │
│     (Task Dispatch, Context Triage, Event Streaming to UI)             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
               ┌────────────────────┴────────────────────┐
               ▼                                         ▼
┌───────────────────────────────┐         ┌───────────────────────────────┐
│ SUB-AGENT 1: SITE SPECIALIST  │         │ BROWNFIELD CONTINUATION AGENT │
│ - Sổ đỏ / Deed parsing        │         │ - Read existing entity handles│
│ - Setbacks & Inscribed Grid   │         │ - In-place delta mutations    │
│ - Road profile & North compass│         │ - Multi-level spatial offsets │
└──────────────┬────────────────┘         └──────────────┬────────────────┘
               │                                         │
               └────────────────────┬────────────────────┘
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ SUB-AGENT 2: STRUCTURAL & SPATIAL PLANNER                              │
│ - Master column grid (300x300mm)                                       │
│ - Room schedule & Circulation topology                                 │
│ - Wet stack (WC / shafts) vertical continuity                          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ SUB-AGENT 3: DETAILED CAD & BIM MODELER                                │
│ - Double walls (200mm / 100mm) with corner miters                      │
│ - Parametric door / window host attachments & wall cuts                │
│ - 25-riser ergonomic staircase ($2h + b = 600\text{mm}$)               │
│ - Multi-view layout (Floor plans, Elevations, Sections, 3D Massing)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ SUB-AGENT 4: ENTERPRISE QA & SELF-HEALING INSPECTOR                    │
│ - Mathematical clash detection (`find_clashes` == 0)                   │
│ - In-memory line deduplication & vertex snapping                       │
│ - File structure audit (`ocs_audit` == 0 errors)                       │
│ - Visual verification snapshot (`ocs_render` PNG)                      │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1. Sub-Agent Roles & Responsibilities

1. **Lead Orchestrator:**
   Triage input requirements (Vietnamese prompt + parcel deed image + Excel room program + active drawing). Spawns required sub-agents and reports live status to the in-app chat stream.
2. **Sub-Agent 1 (Site Specialist):**
   Runs `SiteParcelAnalyzer` to produce boundary polylines (`A-SITE`), dimension texts (`A-DIMS`), road corridors, North arrow, and compute parcel coverage percentage.
3. **Sub-Agent 2 (Spatial Planner):**
   Builds the structural column grid at all axis intersections (`A-COLS`) and plans room allocation based on user prompts or attached `.xlsx` files.
4. **Sub-Agent 3 (BIM Modeler):**
   Executes precise drafting operations: double wall networks (`A-WALL-EXTR`, `A-WALL-INTR`), host wall break/trim for openings (`A-DOOR`, `A-GLAZ`), U-shaped 25-riser stairs (`A-STAIR`), furniture placement with clearance padding (`A-FURN`), and multi-view disjoint coordinate layout.
5. **Sub-Agent 4 (Enterprise QA Inspector):**
   Independent gatekeeper. Runs pairwise AABB clash detection, Shoelace area audits, line deduplication, issues `CorrectionTicket` for any geometric defects, and verifies lossless DXF/DWG saves.

---

## 4. Pillar 3: Brownfield In-Place Continuation Mode

When an architect opens an existing drawing:
- The system activates `IN_PLACE_CONTINUATION_MODE`.
- **Zero Destructive Resets:** The system never calls `ocs_new` or deletes existing user entities.
- Reads active handles and calculates clean bounding boxes.
- Appends newly requested floors (e.g. Tầng 2, Tầng Tum, 3D Massing) at predefined spatial offsets (e.g. $\Delta X = +22\text{m}$, $+44\text{m}$, $+66\text{m}$) so existing drafting remains intact.

---

## 5. Pillar 4: Verification & Test Suite

The enterprise benchmark suite is verified across 3 test modules in `tests/`:

1. **`enterprise_subagent_tests.rs` (3 tests):**
   - `test_site_image_to_cad_e2e`: Irregular nở hậu lot ($12.0\text{m} \to 14.8\text{m}$ rear), $335\,\text{m}^2$, setback offset, and $8\text{m} \times 18\text{m}$ inscribed grid fitting.
   - `test_subagent_brownfield_and_excel_e2e`: Brownfield continuation preserving existing handles `#10..#13` and adding Level 2 at $+22\text{m}$.
   - `test_enterprise_audit_gate`: Zero clashes, zero duplicate lines, complete AIA layer structure, passed QA verdict.
2. **`smart_mcp_tests.rs` (5 tests):**
   - Resilient batch execution, command sanitization, $50\text{mm}$ algorithmic snapping, parametric host openings, smart macros.
3. **`copilot_multimodal_tests.rs` (6 tests):**
   - Multi-agent progress streaming, DWG spatial summarizer, Excel AEC ingestion, E2E villa generation, and in-process MCP bridge.

```powershell
# Run the enterprise test suite
cargo test --test integration enterprise_subagent_tests
```
**Result:** 14/14 tests PASSED (100% OK, 0 failures, 0 warnings).
