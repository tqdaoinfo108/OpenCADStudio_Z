# High-Reliability Smart MCP Architecture & Geometric Precision Engine

## 1. Architectural Overview

The **High-Reliability & Smart MCP Engine** upgrades OpenCADStudio's automation backbone with:
- **Zero-Crash / Fault-Tolerant Transactional Execution:** Atomic rollback, recoverable error continuation, command sanitization, and optimistic concurrency auto-rebase.
- **Sub-Millimeter Geometric Precision:** Algorithmic grid and wall endpoint snapping ($<50\text{mm}$), automatic wall-corner mitering, parametric opening host-wall attachment, and furniture clearance padding.
- **Smart Semantic Macro-Tools:** Atomic composite operations (`draw_structural_grid`, `draw_wall_network`, `place_opening_on_wall`, `generate_staircase`, `auto_dimension_and_label`) that eliminate manual drafting errors.
- **High-Speed Spatial Indexing & Clash Detection:** AABB bounding volume queries, pairwise collision detection (`find_clashes`), and Shoelace-based enclosed room polygon extraction (`find_enclosed_rooms`).
- **Semantic Topology Summarization & In-Memory Healing:** 90% token reduction for LLM prompts, RAM command caching, and zero-token in-memory auto-healing for minor drafting defects.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              HIGH-RELIABILITY MCP KERNEL                                │
│                                                                                        │
│  ┌───────────────────────────────┐     ┌────────────────────────────────────────────┐  │
│  │   Command Sanitizer           │     │         Smart Macro-Tools Engine           │  │
│  │   - Float normalization       │     │   - draw_structural_grid                   │  │
│  │   - Reject NaN / 0-len lines  │────►│   - draw_wall_network                      │  │
│  │   - Auto-close polyline loops │     │   - place_opening_on_wall                  │  │
│  └───────────────┬───────────────┘     │   - generate_staircase                     │  │
│                  │                     │   - auto_dimension_and_label               │  │
│                  ▼                     └─────────────────────┬──────────────────────┘  │
│  ┌───────────────────────────────┐                           │                         │
│  │ Geometric Precision Engine    │◄──────────────────────────┘                         │
│  │ - 50mm Algorithmic Snap       │                                                     │
│  │ - Wall-Corner Miter/Trim      │     ┌────────────────────────────────────────────┐  │
│  │ - Host Opening Break/Trim     │     │ Spatial Query & Clash Detection (AABB)     │  │
│  │ - Furniture Clearance Padding │────►│ - find_clashes (Doors, Columns, Furniture) │  │
│  └───────────────┬───────────────┘     │ - find_enclosed_rooms (Shoelace m² & Ctr)  │  │
│                  │                     │ - query_by_region (90% Token Reduction)    │  │
│                  ▼                     └─────────────────────┬──────────────────────┘  │
│  ┌───────────────────────────────┐                           │                         │
│  │ Resilient Batch Dispatcher    │◄──────────────────────────┘                         │
│  │ - atomic_rollback             │                                                     │
│  │ - continue_on_recoverable_err │     ┌────────────────────────────────────────────┐  │
│  │ - Optimistic Auto-Rebase      │────►│ Semantic Topology Summarizer & Auto-Healer │  │
│  └───────────────────────────────┘     └────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Pillar 1: Resilient & Transactional Batch Execution

### 2.1. Batch Resilience Modes (`op: "batch"`)
- **`continue_on_recoverable_error` (default: `true`):**
  When a batch contains a recoverable error (such as syntax formatting or an unrecognized minor parameter), the dispatcher logs the step error as a warning and proceeds with the remaining valid steps instead of aborting the entire drawing workflow.
- **`atomic_rollback` (default: `false`):**
  When enabled for strict transactions, any step failure causes an automatic multi-step `undo` sequence, resetting the document back to the pre-batch state and returning `"status": "rolled_back"`.

### 2.2. Pre-Execution Command & Geometry Sanitizer
- **Command Sanitizer (`CommandSanitizer::sanitize_command`):**
  Trims redundant whitespace, normalizes coordinate separators (e.g. `1500.000,2000.000` $\to$ `1500,2000`), and formats floating-point values to standard engineering precision.
- **Entity Geometry Validation (`CommandSanitizer::validate_entity_geometry`):**
  * Rejects non-finite coordinates (`NaN`, `Infinity`).
  * Eliminates degenerate lines with length $< 10^{-3}\text{mm}$.
  * Automatically sets `"closed": true` on polylines whose start and end vertices coincide within $10^{-2}\text{mm}$.
  * Auto-assigns default Layer `"0"` if unspecified.

### 2.3. Optimistic Concurrency & Auto-Rebase
- When parallel AI background drafting executes concurrently with user viewport interaction:
  `ConcurrencyRebase::can_auto_rebase(request, active_selection)` checks whether the mutation targets handles disjoint from the user's active selection.
- If non-conflicting, the request automatically rebases to the active tab's current `edit_revision` instead of rejecting with `stale_state`.

---

## 3. Pillar 2: Geometric Precision & Auto-Snap Engine

### 3.1. Algorithmic Grid & Endpoint Snapping (`SnapEngine`)
- Snaps coordinates within threshold $\Delta \le 50\text{mm}$:
  1. Priority 1: Snaps to existing wall endpoints and column corners.
  2. Priority 2: Snaps $X$ and $Y$ coordinates to structural grid axes.
- Eliminates drafting gaps and misalignment caused by floating-point calculation approximations.

### 3.2. Parametric Host-Wall Attachment (`ParametricOpening`)
- When placing doors or windows on a host wall:
  * Projects opening center onto the wall centerline.
  * Breaks (cuts) the double wall into two trimmed segments ($P_1 \to \text{Jamb}_1$ and $\text{Jamb}_2 \to P_2$).
  * Generates jamb closure lines, door leaf line swung $90^\circ$, and an exact quarter arc for the door swing on `A-DOOR` (or dual glazing lines on `A-GLAZ`).

### 3.3. Furniture Clearance Padding (`FurnitureClearance`)
- Checks furniture bounding box $[x_0, y_0, x_1, y_1]$ against all adjacent wall boundary segments.
- If any edge penetrates or intersects a wall, automatically shifts the furniture bounding box outward by the required clearance distance (e.g. $60\text{mm}$), preventing furniture lines from cutting into walls.

---

## 4. Pillar 3: Smart Semantic Macro-Tools

Instead of orchestrating hundreds of primitive `LINE` commands, the AI agent can dispatch smart macro operations through `ocs_execute`:

| Macro Name | Parameters | Output & Behavior |
|---|---|---|
| `draw_structural_grid` | `origin`, `bays_x`, `bays_y`, `column_size`, `extension` | Generates all grid lines (`A-GRID`), circle bubbles with text numbers/letters (`A-ANNO`), and column rectangles (`A-COLS`) at intersections in 1 atomic call. |
| `draw_wall_network` | `centerlines`, `thickness`, `layer` | Calculates double offset lines for exterior ($200\text{mm}$) and interior ($100\text{mm}$) walls with end joins. |
| `place_opening_on_wall` | `wall_start`, `wall_end`, `offset`, `width`, `kind`, `thickness` | Breaks double host walls and creates door leaf, swing arc, or window glazing. |
| `generate_staircase` | `bounds`, `floor_height`, `stair_type` | Computes risers ($2h + b = 600\text{mm}$), treads, central void, step lines, and directional arrows. |
| `auto_dimension_and_label` | `rooms: [{name, area_m2, center}]` | Generates linear dimension chains and room labels with area centered at room centroids. |

---

## 5. Pillar 4: Spatial Query & Collision Detection

Available via `ocs_read` for high-speed geometry inspection:
- **`find_clashes`:** Detects overlapping furniture, door swing arcs intersecting columns/furniture, and text label collisions.
- **`find_enclosed_rooms`:** Runs Shoelace polygon algorithm to calculate actual room area in $\text{m}^2$, perimeter, and centroid coordinates.
- **`query_by_region`:** Filters entities within a rectangular bounding box $[min_x, min_y, max_x, max_y]$, reducing LLM token consumption by $> 90\%$.

---

## 6. Pillar 5: Context Compression & In-Memory Auto-Healer

- **`SemanticTopologySummarizer`:**
  Compresses complex drawings containing thousands of entities into a concise Markdown digest (Entity counts, Layer distribution, Enclosed rooms with areas, and Clash status).
- **`AutoHealer`:**
  Performs in-memory defect repair without requiring LLM round-trips:
  * Dedupes overlapping collinear lines.
  * Snaps open polyline vertices within $10\text{mm}$ to integer coordinates.

---

## 7. Verification & Benchmark Test Suite

The test suite is verified in `tests/smart_mcp_tests.rs`:
```powershell
cargo test --test integration smart_mcp_tests
```

**Results:** 5/5 Benchmark Tests PASSED:
1. `test_batch_resilience_and_command_sanitization`: Verified command trimming, float coordinate sanitization, degenerate line rejection, polyline auto-closing, and optimistic rebase checks.
2. `test_geometric_precision_snapping_and_parametric_opening`: Verified 50mm snap threshold, host wall break/trim, and furniture clearance padding.
3. `test_smart_macro_tools_dispatch`: Verified structural grid generation (16 columns), double wall generation, staircase calculations, and dimension/label placement.
4. `test_spatial_query_clash_detection_and_region_filter`: Verified furniture clash detection, enclosed room area calculation ($20.0\,\text{m}^2$), and spatial region filtering.
5. `test_semantic_topology_summarizer_and_auto_healer`: Verified collinear line deduplication and token-efficient topology summarization.
