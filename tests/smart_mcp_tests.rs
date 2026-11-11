//! Integration & Precision Benchmark Tests for Smart MCP, Geometric Snapping & Resilience.

use serde_json::json;
use OpenCADStudio::ai::{
    geometric_precision::{FurnitureClearance, ParametricOpening, SnapEngine, WallSegment},
    mcp_resilience::{CommandSanitizer, ConcurrencyRebase},
    smart_macro::SmartMacro,
    spatial_query::SpatialQueryEngine,
    topology_summarizer::{AutoHealer, SemanticTopologySummarizer},
};

#[test]
fn test_batch_resilience_and_command_sanitization() {
    // 1. Command string sanitization
    let raw_cmd = "   LINE   0.0000,0.0000    15000.1289,24000.0000   ";
    let sanitized = CommandSanitizer::sanitize_command(raw_cmd).unwrap();
    assert_eq!(sanitized, "LINE 0,0 15000.13,24000");

    // 2. Geometry sanitization: reject NaN and zero-length lines
    let mut bad_zero_line = json!({
        "type": "Line",
        "start": [500.0, 500.0],
        "end": [500.0, 500.0]
    });
    assert!(CommandSanitizer::validate_entity_geometry(&mut bad_zero_line).is_err());

    let mut valid_poly = json!({
        "type": "LwPolyline",
        "vertices": [[0.0, 0.0], [5000.0, 0.0], [5000.0, 5000.0], [0.0, 5000.0], [0.0, 0.0]]
    });
    assert!(CommandSanitizer::validate_entity_geometry(&mut valid_poly).is_ok());
    assert_eq!(valid_poly["closed"], true); // Auto-closed polyline

    // 3. Optimistic Concurrency & Auto-rebase check
    let create_req = json!({
        "op": "entities_create",
        "entities": [{"type": "Line", "start": [0,0], "end": [100,100]}]
    });
    assert!(ConcurrencyRebase::can_auto_rebase(&create_req, &[]));
}

#[test]
fn test_geometric_precision_snapping_and_parametric_opening() {
    let grid_x = vec![0.0, 4000.0, 9000.0, 13000.0];
    let grid_y = vec![0.0, 5500.0, 10500.0, 16000.0];
    let endpoints = vec![[4000.0, 5500.0], [9000.0, 10500.0]];

    // Point at (4035, 5480) within 50mm threshold snaps to (4000, 5500)
    let snapped = SnapEngine::snap_point([4035.0, 5480.0], &grid_x, &grid_y, &endpoints, 50.0);
    assert_eq!(snapped, [4000.0, 5500.0]);

    // Point outside threshold does not snap
    let far_point = [4150.0, 5800.0];
    assert_eq!(SnapEngine::snap_point(far_point, &grid_x, &grid_y, &endpoints, 50.0), far_point);

    // Parametric Door Host Wall Break/Trim
    let host_wall = WallSegment::new([0.0, 0.0], [6000.0, 0.0], 200.0, "A-WALL-EXTR");
    let door_placement = ParametricOpening::place_on_wall(&host_wall, 1500.0, 900.0, false).unwrap();

    assert_eq!(door_placement.host_wall_segments.len(), 2);
    assert_eq!(door_placement.host_wall_segments[0].length(), 1500.0);
    assert_eq!(door_placement.host_wall_segments[1].length(), 3600.0);
    // Verified door leaf and 90-degree swing arc generated
    assert!(door_placement.opening_entities.iter().any(|e| e["layer"] == "A-DOOR" && e["type"] == "Arc"));

    // Furniture clearance auto-push
    let wall_vert = WallSegment::new([2000.0, 0.0], [2000.0, 6000.0], 200.0, "A-WALL-EXTR");
    let bad_furn_box = [1950.0, 1000.0, 3500.0, 2500.0]; // overlaps wall center at 2000
    let cleared = FurnitureClearance::push_out_of_walls(bad_furn_box, &[wall_vert], 60.0);
    // Wall h = 100 + clearance 60 -> min_x must be pushed to >= 2160
    assert!(cleared[0] >= 2160.0);
}

#[test]
fn test_smart_macro_tools_dispatch() {
    // 1. draw_structural_grid
    let grid_params = json!({
        "origin": [1000.0, 2000.0],
        "bays_x": [4000.0, 4000.0, 4000.0],
        "bays_y": [5500.0, 5000.0, 5500.0],
        "column_size": 300.0
    });
    let grid_entities = SmartMacro::dispatch("draw_structural_grid", &grid_params).unwrap();
    assert!(!grid_entities.is_empty());
    assert_eq!(grid_entities.iter().filter(|e| e["layer"] == "A-COLS").count(), 16);

    // 2. draw_wall_network
    let wall_params = json!({
        "centerlines": [
            [[0.0, 0.0], [12000.0, 0.0]],
            [[12000.0, 0.0], [12000.0, 16000.0]]
        ],
        "thickness": 200.0,
        "layer": "A-WALL-EXTR"
    });
    let wall_entities = SmartMacro::dispatch("draw_wall_network", &wall_params).unwrap();
    assert_eq!(wall_entities.len(), 4); // 2 centerlines x 2 offset double lines

    // 3. generate_staircase
    let stair_params = json!({
        "bounds": [5500.0, 10500.0, 9500.0, 15500.0],
        "floor_height": 3900.0,
        "stair_type": "U_SHAPE"
    });
    let stair_entities = SmartMacro::dispatch("generate_staircase", &stair_params).unwrap();
    assert!(stair_entities.iter().any(|e| e["layer"] == "A-STAIR" && e["closed"] == true));

    // 4. auto_dimension_and_label
    let dim_params = json!({
        "rooms": [
            {"name": "Phòng Khách", "area_m2": 44.0, "center": [5000.0, 7500.0]},
            {"name": "Phòng Bếp", "area_m2": 38.0, "center": [5000.0, 18000.0]}
        ]
    });
    let dim_entities = SmartMacro::dispatch("auto_dimension_and_label", &dim_params).unwrap();
    assert_eq!(dim_entities.len(), 2);
    assert!(dim_entities[0]["value"].as_str().unwrap().contains("44.0 m²"));
}

#[test]
fn test_spatial_query_clash_detection_and_region_filter() {
    let furn1 = json!({
        "type": "LwPolyline",
        "layer": "A-FURN",
        "closed": true,
        "vertices": [[0.0, 0.0], [2000.0, 0.0], [2000.0, 2000.0], [0.0, 2000.0]]
    });
    let furn2 = json!({
        "type": "LwPolyline",
        "layer": "A-FURN",
        "closed": true,
        "vertices": [[1500.0, 1500.0], [3500.0, 1500.0], [3500.0, 3500.0], [1500.0, 3500.0]]
    });
    let col = json!({
        "type": "LwPolyline",
        "layer": "A-COLS",
        "closed": true,
        "vertices": [[9000.0, 9000.0], [9300.0, 9000.0], [9300.0, 9300.0], [9000.0, 9300.0]]
    });

    let entities = vec![furn1, furn2, col];

    // 1. Clash Detection
    let clashes = SpatialQueryEngine::find_clashes(&entities);
    assert_eq!(clashes.len(), 1);
    assert_eq!(clashes[0]["clash_type"], "FURNITURE_OVERLAP");

    // 2. Region Query (Filter)
    let region_ents = SpatialQueryEngine::query_by_region(&entities, [0.0, 0.0, 4000.0, 4000.0]);
    assert_eq!(region_ents.len(), 2); // Excludes distant column at 9000,9000
}

#[test]
fn test_semantic_topology_summarizer_and_auto_healer() {
    let mut entities = vec![
        json!({"type": "Line", "layer": "A-WALL", "start": [0.0, 0.0], "end": [5000.0, 0.0]}),
        json!({"type": "Line", "layer": "A-WALL", "start": [0.0, 0.0], "end": [5000.0, 0.0]}), // Duplicate
        json!({"type": "LwPolyline", "layer": "A-WALL-EXTR", "closed": true, "vertices": [[0.0, 0.0], [4000.0, 0.0], [4000.0, 5000.0], [0.0, 5000.0]]}),
    ];

    // Auto-healer dedupes collinear duplicate lines
    let report = AutoHealer::auto_heal(&mut entities);
    assert_eq!(report.duplicate_lines_removed, 1);
    assert_eq!(entities.len(), 2);

    // Topology summary compression
    let digest = SemanticTopologySummarizer::summarize(&entities);
    assert_eq!(digest.total_entities, 2);
    assert_eq!(digest.enclosed_rooms.len(), 1);

    let summary_md = digest.to_llm_summary();
    assert!(summary_md.contains("COMPACT DRAWING TOPOLOGY"));
    assert!(summary_md.contains("20.0 m²"));
}
