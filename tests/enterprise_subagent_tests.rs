//! Enterprise-Grade QA & Verification Test Suite for Sub-Agent Swarm & Site-Image-to-CAD.

use OpenCADStudio::ai::{
    site_parcel_analyzer::{ParcelAnalysisSpec, ParcelBoundaryEdge, ParcelCornerPoint, SiteParcelAnalyzer},
    spatial_query::SpatialQueryEngine,
    subagent_swarm::SubAgentSwarm,
    topology_summarizer::{AutoHealer, SemanticTopologySummarizer},
};
use serde_json::json;

/// Test Suite 1: Site/Parcel Image-to-CAD with Irregular Nở Hậu Lot
#[test]
fn test_site_image_to_cad_e2e() {
    // Sơ đồ thửa đất thực tế nở hậu:
    // Mặt tiền: 12.0m giáp đường Nguyễn Văn Huyên rộng 12m
    // Chiều sâu cạnh trái: 25.0m
    // Cạnh hậu: 14.8m (nở hậu 2.8m mang lại phong thủy vượng khí)
    // Chiều sâu cạnh phải: 25.3m
    let spec = ParcelAnalysisSpec {
        corners: vec![
            ParcelCornerPoint { id: 0, coord: [0.0, 0.0], label: "Đ1".into() },
            ParcelCornerPoint { id: 1, coord: [12000.0, 0.0], label: "Đ2".into() },
            ParcelCornerPoint { id: 2, coord: [14800.0, 25000.0], label: "Đ3".into() },
            ParcelCornerPoint { id: 3, coord: [0.0, 25000.0], label: "Đ4".into() },
        ],
        edges: vec![
            ParcelBoundaryEdge {
                from_corner: 0,
                to_corner: 1,
                length_mm: 12000.0,
                is_front_road: true,
                road_name: Some("ĐƯỜNG NGUYỄN VĂN HUYÊN".into()),
                road_width_m: Some(12.0),
            },
        ],
        compass_north_deg: 0.0,
        front_setback_mm: 4000.0,
        rear_setback_mm: 2000.0,
        side_setback_mm: 1000.0,
    };

    let site_plan = SiteParcelAnalyzer::process_parcel_plan(&spec);

    // 1. Kiểm tra tính toán diện tích tổng khu đất: ~ (12 + 14.8)/2 * 25 = 335 m2
    assert!((site_plan.total_lot_area_m2 - 335.0).abs() < 5.0);

    // 2. Kiểm tra chỉ giới xây dựng (Setback)
    assert!(site_plan.buildable_area_m2 > 150.0);

    // 3. Kiểm tra khung chữ nhật nội tiếp tối ưu (Maximal Inscribed Orthogonal Grid)
    let grid = &site_plan.inscribed_grid;
    assert!(grid.width_mm >= 8000.0, "Chiều rộng công trình tối thiểu 8m");
    assert!(grid.depth_mm >= 15000.0, "Chiều sâu công trình tối thiểu 15m");

    // 4. Kiểm tra các dải đất nở hậu/biên được phân bổ thành sân vườn hoặc giếng trời
    assert!(!grid.residual_zones.is_empty());
    assert!(grid.residual_zones.iter().any(|z| z.zone_type == "SIDE_GARDEN"));

    // 5. Kiểm tra thực thể CAD sinh ra: ranh đất, đường giao thông, kim chỉ nam hướng Bắc, nhãn chỉ số
    assert!(site_plan.cad_entities.iter().any(|e| e["layer"] == "A-SITE"));
    assert!(site_plan.cad_entities.iter().any(|e| e["layer"] == "A-SETBACK"));
    assert!(site_plan.cad_entities.iter().any(|e| {
        e["layer"] == "A-ANNO"
            && e.get("value")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|v| v.contains("BẮC"))
    }));
}

/// Test Suite 2: Multi-Subagent Coordination & Brownfield Renovation with Excel Program
#[test]
fn test_subagent_brownfield_and_excel_e2e() {
    // Bản vẽ hiện trạng có sẵn các tường tầng 1 (handles: 10, 11, 12, 13)
    let existing_entities = vec![
        json!({"type": "Line", "layer": "A-WALL-EXTR", "handle": "10", "start": [0.0, 0.0], "end": [12000.0, 0.0]}),
        json!({"type": "Line", "layer": "A-WALL-EXTR", "handle": "11", "start": [12000.0, 0.0], "end": [12000.0, 16000.0]}),
        json!({"type": "Line", "layer": "A-WALL-EXTR", "handle": "12", "start": [12000.0, 16000.0], "end": [0.0, 16000.0]}),
        json!({"type": "Line", "layer": "A-WALL-EXTR", "handle": "13", "start": [0.0, 16000.0], "end": [0.0, 0.0]}),
    ];

    let initial_handles = vec!["10".into(), "11".into(), "12".into(), "13".into()];
    let swarm = SubAgentSwarm::new("Brownfield Renovation & Expansion", true, initial_handles.clone());

    // Sub-Agents phối hợp phát triển thêm Tầng 2 theo yêu cầu mở rộng tại tọa độ offset X = 22m
    let added_entities = swarm.run_brownfield_continuation(&existing_entities, 22000.0).unwrap();
    assert!(!added_entities.is_empty());

    let bb = swarm.blackboard.lock().unwrap();
    // Khẳng định chế độ brownfield giữ nguyên handle cũ, không gọi ocs_new
    assert!(bb.is_brownfield);
    assert_eq!(bb.initial_handles, initial_handles);
    assert!(bb.generated_entities.iter().any(|e| e["layer"] == "A-COLS"));
}

/// Test Suite 3: Enterprise Quality Audit Gate (Zero-Clash, Zero-Duplicate, Strict Multi-View Disjoint)
#[test]
fn test_enterprise_audit_gate() {
    let swarm = SubAgentSwarm::new("Biệt Thự Hiện Đại Đạt Chuẩn Doanh Nghiệp", false, Vec::new());

    // 1. Phối hợp đầy đủ 5 Sub-Agents
    let _site = swarm.run_site_specialist(None).unwrap();
    let _grid = swarm.run_spatial_planner().unwrap();
    let _bim = swarm.run_bim_modeler().unwrap();
    let qa_report = swarm.run_qa_inspector().unwrap();

    // 2. Kiểm định chốt chặn QA
    assert_eq!(qa_report.verdict, "PASSED", "QA Inspector phải phê duyệt thiết kế");
    assert_eq!(qa_report.tickets.iter().filter(|t| t.severity == "CRITICAL").count(), 0);

    // 3. Kiểm định va chạm không gian (AABB Spatial Index)
    let bb = swarm.blackboard.lock().unwrap();
    let clashes = SpatialQueryEngine::find_clashes(&bb.generated_entities);
    assert_eq!(clashes.len(), 0, "Không được có va chạm giữa các cấu kiện");

    // 4. Kiểm tra làm sạch hình học (Zero duplicate collinear lines)
    let mut ents_clone = bb.generated_entities.clone();
    let heal_check = AutoHealer::auto_heal(&mut ents_clone);
    assert_eq!(heal_check.duplicate_lines_removed, 0, "Bản vẽ đã sạch 100% không còn nét thừa trùng lặp");

    // 5. Kiểm tra phân bố Layer chuẩn AIA
    let digest = SemanticTopologySummarizer::summarize(&bb.generated_entities);
    assert!(digest.layer_counts.contains_key("A-SITE"));
    assert!(digest.layer_counts.contains_key("A-GRID"));
    assert!(digest.layer_counts.contains_key("A-COLS"));
    assert!(digest.layer_counts.contains_key("A-WALL-EXTR"));
    assert!(digest.layer_counts.contains_key("A-DOOR"));
    assert!(digest.layer_counts.contains_key("A-STAIR"));
    assert!(digest.layer_counts.contains_key("A-ANNO"));
}
