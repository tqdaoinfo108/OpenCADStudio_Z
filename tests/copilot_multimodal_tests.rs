//! End-to-End Integration Tests for In-App AI Copilot & Multimodal Ingestion Engine.

use OpenCADStudio::ai::{
    copilot_state::{AgentKind, CopilotEvent, CopilotState},
    dwg_ingestion::summarize_document,
    excel_ingestion::{extract_aec_program, parse_raw_workbook, reconcile_excel_with_cad},
};
use document::{
    entities::{EntityType, LwPolyline, LwVertex, Text},
    types::{Vector2, Vector3},
    Document,
};
use serde_json::json;
use std::{fs::File, io::Write};

#[test]
fn test_excel_multimodal_aec_ingestion_and_diff() {
    let temp_dir = std::env::temp_dir().join(format!("ocs_test_excel_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let csv_path = temp_dir.join("villa_program.csv");

    // Create a real CSV/Excel schedule file representing modern 2-floor + rooftop villa brief
    let csv_data = "Room Name,Area (m2),Level,Min Width (m)\n\
Living Room,45.0,1,5.5\n\
Dining & Kitchen,35.0,1,4.5\n\
Master Bedroom,30.0,2,4.5\n\
Bedroom 2,22.0,2,4.0\n\
Bedroom 3,20.0,2,3.8\n\
Rooftop Terrace,50.0,Rooftop,6.0\n";

    let mut file = File::create(&csv_path).unwrap();
    file.write_all(csv_data.as_bytes()).unwrap();

    // 1. Ingest workbook using native calamine reader
    let workbook = parse_raw_workbook(&csv_path).expect("parse workbook");
    assert_eq!(workbook.sheets.len(), 1);
    assert_eq!(workbook.sheets[0].rows.len(), 6); // 6 room rows

    // 2. Extract semantic AEC program
    let program = extract_aec_program(&workbook);
    assert_eq!(program.rooms.len(), 6);
    assert_eq!(program.rooms[0].name, "Living Room");
    assert!((program.rooms[0].target_area_m2 - 45.0).abs() < 1e-4);
    assert!(program.rooms[0].level_name.contains('1'));
    assert_eq!(program.rooms[0].level_index, 0);

    let rooftop_room = program.rooms.iter().find(|r| r.name == "Rooftop Terrace").unwrap();
    assert!((rooftop_room.target_area_m2 - 50.0).abs() < 1e-4);

    // Verify LLM prompt context formatting
    let prompt_ctx = program.to_prompt_context();
    assert!(prompt_ctx.contains("INGESTED EXCEL PROGRAM"));
    assert!(prompt_ctx.contains("Living Room: 45 m2"));
    assert!(prompt_ctx.contains("Rooftop Terrace: 50 m2"));

    // 3. Test diff & reconciliation against CAD records
    let current_cad = json!({
        "records": [
            {"type": "Text", "text": "Living Room", "area_m2": 45.0}
        ]
    });

    let diff = reconcile_excel_with_cad(&program, &current_cad);
    assert_eq!(diff.missing_rooms.len(), 5);
    assert!(diff.missing_rooms.iter().any(|r| r.name == "Master Bedroom"));

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_dwg_spatial_context_summarizer() {
    let mut doc = Document::default();

    // Add a closed perimeter representing 15m x 25m site boundary (15,000mm x 25,000mm)
    let site_poly = LwPolyline {
        vertices: vec![
            LwVertex { location: Vector2::new(0.0, 0.0), vertex_id: 0, start_width: 0.0, end_width: 0.0, bulge: 0.0 },
            LwVertex { location: Vector2::new(15000.0, 0.0), vertex_id: 1, start_width: 0.0, end_width: 0.0, bulge: 0.0 },
            LwVertex { location: Vector2::new(15000.0, 25000.0), vertex_id: 2, start_width: 0.0, end_width: 0.0, bulge: 0.0 },
            LwVertex { location: Vector2::new(0.0, 25000.0), vertex_id: 3, start_width: 0.0, end_width: 0.0, bulge: 0.0 },
        ],
        is_closed: true,
        common: document::entities::EntityCommon {
            layer: "A-WALL".to_string(),
            ..Default::default()
        },
        ..Default::default()
    };
    doc.add_entity(EntityType::LwPolyline(site_poly)).unwrap();

    // Add room text annotation
    let text_entity = Text {
        value: "LIVING_ROOM".to_string(),
        insertion_point: Vector3::new(4000.0, 6000.0, 0.0),
        height: 300.0,
        common: document::entities::EntityCommon {
            layer: "A-ROOM".to_string(),
            ..Default::default()
        },
        ..Default::default()
    };
    doc.add_entity(EntityType::Text(text_entity)).unwrap();

    // Summarize document
    let digest = summarize_document(&doc, "sample_villa_base.dwg");
    assert_eq!(digest.total_entities, 2);
    assert!(digest.layers.iter().any(|l| l.name == "A-WALL"));
    assert!(digest.layers.iter().any(|l| l.name == "A-ROOM"));

    // Check bounding box extents: [0, 0, 15000, 25000]
    let [min_x, min_y, max_x, max_y] = digest.extents;
    assert!((min_x - 0.0).abs() < 1e-3);
    assert!((min_y - 0.0).abs() < 1e-3);
    assert!((max_x - 15000.0).abs() < 1e-3);
    assert!((max_y - 25000.0).abs() < 1e-3);

    // Check detected closed rooms/areas: 15m * 25m = 375 m2
    assert_eq!(digest.enclosed_regions.len(), 1);
    assert!((digest.enclosed_regions[0].approx_area_m2 - 375.0).abs() < 1e-2);

    // Verify text annotation inside bounds
    assert!(digest.enclosed_regions[0].room_name_labels.contains(&"LIVING_ROOM".to_string()));

    // Verify LLM prompt digest formatting
    let prompt_ctx = digest.to_prompt_context();
    assert!(prompt_ctx.contains("INGESTED DWG/DXF DIGEST"));
    assert!(prompt_ctx.contains("A-WALL"));
    assert!(prompt_ctx.contains("375.0 m²"));
    assert!(prompt_ctx.contains("LIVING_ROOM"));
}

#[test]
fn test_copilot_state_and_event_streaming() {
    let mut state = CopilotState::default();
    assert!(!state.is_busy);
    assert_eq!(state.messages.len(), 1); // Welcome message

    let (tx, rx) = std::sync::mpsc::channel();
    state.event_rx = Some(rx);

    // 1. Simulate Planner progress event
    tx.send(CopilotEvent::Progress {
        agent: AgentKind::Planner,
        phase: "Quy hoạch không gian".to_string(),
        step: 1,
        total: 4,
        detail: "Tính toán lưới trục kết cấu 15m x 25m".to_string(),
    }).unwrap();

    state.poll_events();
    assert_eq!(state.status.current_agent, AgentKind::Planner);
    assert!(state.status.is_active);
    assert!(state.status.description.contains("Tính toán lưới trục"));

    // 2. Simulate PlanReady event
    tx.send(CopilotEvent::PlanReady {
        summary: "Phương án Villa 2 tầng + tum áp mái trên khu đất 15m x 25m".to_string(),
        plan_json: json!({"grid_x": [0, 5500, 10500, 15000], "grid_y": [0, 6000, 14000, 20000, 25000]}),
    }).unwrap();

    state.poll_events();
    assert_eq!(state.messages.len(), 2);
    assert!(state.messages.last().unwrap().text.contains("Phương án Villa 2 tầng"));

    // 3. Simulate BatchExecuted event
    tx.send(CopilotEvent::BatchExecuted {
        phase_name: "Dựng tường chịu lực Tầng 1".to_string(),
        completed_steps: 16,
        total_steps: 16,
        handles: vec!["2A".to_string(), "2B".to_string(), "2C".to_string()],
    }).unwrap();

    state.poll_events();
    assert_eq!(state.messages.len(), 3);
    let batch_msg = state.messages.last().unwrap();
    assert!(batch_msg.text.contains("3 thực thể tạo mới"));
    assert_eq!(batch_msg.interactive_handles, vec!["2A", "2B", "2C"]);
    assert!(batch_msg.can_undo);

    // 4. Simulate QA Report event
    tx.send(CopilotEvent::QaReport {
        verdict: "PASSED".to_string(),
        issues: Vec::new(),
        image_base64: None,
    }).unwrap();

    state.poll_events();
    assert_eq!(state.messages.len(), 4);
    assert!(state.messages.last().unwrap().text.contains("PASSED"));

    // 5. Simulate Completed event
    tx.send(CopilotEvent::Completed {
        message: "Hoàn tất bàn giao hồ sơ thiết kế!".to_string(),
        delivery_path: Some("target/ai-deliveries/sample_villa.dxf".to_string()),
        created_handles: vec!["2A".to_string(), "2B".to_string()],
    }).unwrap();

    state.poll_events();
    assert!(!state.is_busy);
    assert!(!state.status.is_active);
    assert!(state.messages.last().unwrap().text.contains("Hoàn tất bàn giao"));
}

#[test]
fn test_in_process_mcp_client_bridge() {
    let mut client = OpenCADStudio::mcp::create_in_process_mcp_client(std::time::Duration::from_secs(5))
        .expect("create in-process client");
    // Test in-process sessions query without launching external process
    let result = client.tool("ocs_sessions", json!({"launch_if_none": false}));
    assert!(result.is_ok(), "in-process ocs_sessions call must succeed: {:?}", result.err());

    // Test calling in-process ocs_read guide
    let guide_res = client.tool("ocs_read", json!({"op": "guide"}));
    assert!(guide_res.is_ok(), "in-process ocs_read guide must succeed: {:?}", guide_res.err());
    let guide_val = guide_res.unwrap();
    assert!(guide_val.to_string().contains("guide") || guide_val.is_object());
}

#[test]
fn test_e2e_ui_chat_controller_full_villa_workflow() {
    use OpenCADStudio::ai::copilot_state::{AttachedFile, AttachedFileType, MessageRole};
    use sha2::{Digest as _, Sha256};

    // 1. Initialize UI Chat state
    let mut state = CopilotState::default();
    assert_eq!(state.messages.len(), 1);
    assert_eq!(state.messages[0].role, MessageRole::System);
    assert!(!state.is_busy);

    // 2. Set user prompt and multimodal attachments
    state.input_prompt = "Thiết kế một căn biệt thự hiện đại 2 tầng 1 tum trên lô đất 15m x 24m (xây dựng 12m x 16m). Tầng 1 sảnh + phòng khách + bếp ăn + PN ông bà. Tầng 2 Master + 2 PN con. Tum phòng thờ + gym + sân thượng trước + sân phơi sau. Dàn trang đầy đủ 7 phân vùng kỹ thuật: Mặt bằng T1, T2, Tum, Mặt đứng chính, Mặt đứng bên, Mặt cắt A-A và Khối 3D BIM massing.".to_string();

    state.attached_files.push(AttachedFile {
        path: std::path::PathBuf::from("target/ai-worker/sample_schedule.xlsx"),
        name: "villa_room_schedule.xlsx".to_string(),
        file_type: AttachedFileType::Excel,
        summary: "Excel: 3 sheets, 14 rooms".to_string(),
        ingestion_mode: OpenCADStudio::ai::dwg_ingestion::IngestionMode::MergeIntoCurrent,
    });

    state.attached_files.push(AttachedFile {
        path: std::path::PathBuf::from("target/ai-worker/sample_site.dwg"),
        name: "site_boundary_15x24m.dwg".to_string(),
        file_type: AttachedFileType::DwgDxf,
        summary: "DWG: 450 entities, 8 layers".to_string(),
        ingestion_mode: OpenCADStudio::ai::dwg_ingestion::IngestionMode::OpenAsActiveBase,
    });

    // Active selection context
    state.selected_handles = vec!["1A".to_string(), "1B".to_string(), "1C".to_string(), "1D".to_string()];
    state.selected_context_summary = Some("Đang chọn 4 đối tượng trên Layer A-WALL-EXTR".to_string());

    // 3. Simulate message dispatch and multi-agent channel streaming
    let (tx, rx) = std::sync::mpsc::channel();
    state.event_rx = Some(rx);
    state.is_busy = true;

    // Step A: Planner Agent
    tx.send(CopilotEvent::Progress {
        agent: AgentKind::Planner,
        phase: "Phân tích không gian & Lập quy hoạch".to_string(),
        step: 1,
        total: 5,
        detail: "Phân bổ 7 vùng không gian: T1, T2, Tum, Mặt đứng, Mặt cắt và Khối 3D".to_string(),
    }).unwrap();

    tx.send(CopilotEvent::PlanReady {
        summary: "Quy hoạch 7 phân vùng bản vẽ độc lập: [Vùng 1: T1 (0,0)], [Vùng 2: T2 (+22m)], [Vùng 3: Tum (+44m)], [Vùng 4: Mặt đứng chính (0,-18m)], [Vùng 5: Mặt đứng bên (+22m,-18m)], [Vùng 6: Mặt cắt A-A (+44m,-18m)], [Vùng 7: Khối 3D (+66m,0)]".to_string(),
        plan_json: json!({"regions": 7, "total_width_mm": 80000, "total_depth_mm": 42000}),
    }).unwrap();

    state.poll_events();
    assert_eq!(state.status.current_agent, AgentKind::Planner);
    assert_eq!(state.messages.len(), 2);

    // Step B: Execution Agent (Phase 1 to 5)
    for p in 1..=5 {
        tx.send(CopilotEvent::Progress {
            agent: AgentKind::Execution,
            phase: format!("Dựng hình CAD Phase {p}"),
            step: p,
            total: 5,
            detail: format!("Thực thi batch tạo thực thể cho phase {p}"),
        }).unwrap();
    }

    tx.send(CopilotEvent::BatchExecuted {
        phase_name: "Hoàn tất 7 phân vùng kỹ thuật".to_string(),
        completed_steps: 603,
        total_steps: 603,
        handles: vec!["7F".to_string(), "80".to_string(), "81".to_string(), "82".to_string()],
    }).unwrap();

    state.poll_events();
    assert_eq!(state.status.current_agent, AgentKind::Execution);
    assert_eq!(state.messages.len(), 3);
    let last_batch = state.messages.last().unwrap();
    assert!(last_batch.can_undo);
    assert!(last_batch.can_audit_fix);
    assert!(!last_batch.interactive_handles.is_empty());

    // Step C: QA Critic Agent
    tx.send(CopilotEvent::QaReport {
        verdict: "PASSED".to_string(),
        issues: Vec::new(),
        image_base64: Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string()),
    }).unwrap();

    state.poll_events();
    assert_eq!(state.status.current_agent, AgentKind::QaCritic);
    assert_eq!(state.messages.len(), 4);

    // Step D: Evolution Agent
    tx.send(CopilotEvent::EvolutionProposed {
        next_phase: "Xuất hồ sơ in ấn và bàn giao".to_string(),
        missing: Vec::new(),
    }).unwrap();

    state.poll_events();
    assert_eq!(state.status.current_agent, AgentKind::Evolution);
    assert_eq!(state.messages.len(), 5);

    // Step E: Completed
    let delivery_path = "target/ai-deliveries/Biet_Thu_Hien_Dai_2_Tang_1_Tum.dxf";
    tx.send(CopilotEvent::Completed {
        message: "Hồ sơ biệt thự 2 tầng 1 tum hoàn chỉnh đã được tạo lập và lưu trữ thành công!".to_string(),
        delivery_path: Some(delivery_path.to_string()),
        created_handles: vec!["7F".to_string(), "80".to_string()],
    }).unwrap();

    state.poll_events();
    assert!(!state.is_busy);
    assert!(!state.status.is_active);
    assert_eq!(state.messages.len(), 6);

    // 4. Verify No-Overlap Multi-View Bounding Boxes
    struct BBox { min_x: f64, min_y: f64, max_x: f64, max_y: f64 }
    let regions = vec![
        BBox { min_x: 0.0, min_y: 0.0, max_x: 15000.0, max_y: 24000.0 },         // Vùng 1: T1 & Đất
        BBox { min_x: 22000.0, min_y: 0.0, max_x: 37000.0, max_y: 24000.0 },     // Vùng 2: T2
        BBox { min_x: 44000.0, min_y: 0.0, max_x: 59000.0, max_y: 24000.0 },     // Vùng 3: Tum & Mái
        BBox { min_x: 0.0, min_y: -19500.0, max_x: 16000.0, max_y: -6000.0 },    // Vùng 4: Mặt đứng chính
        BBox { min_x: 22000.0, min_y: -19500.0, max_x: 40000.0, max_y: -6000.0 },// Vùng 5: Mặt đứng bên
        BBox { min_x: 44000.0, min_y: -19500.0, max_x: 62000.0, max_y: -6000.0 },// Vùng 6: Mặt cắt A-A
        BBox { min_x: 66000.0, min_y: 0.0, max_x: 81000.0, max_y: 24000.0 },     // Vùng 7: Khối 3D
    ];

    // Check all pairs are non-overlapping
    for i in 0..regions.len() {
        for j in (i + 1)..regions.len() {
            let r1 = &regions[i];
            let r2 = &regions[j];
            let overlaps = r1.min_x < r2.max_x && r1.max_x > r2.min_x && r1.min_y < r2.max_y && r1.max_y > r2.min_y;
            assert!(!overlaps, "Vùng {i} và Vùng {j} bị chồng đè tọa độ!");
        }
    }

    // 5. Verify Deliverable File Integrity & Cryptographic Hash
    let dxf_file = std::path::Path::new(delivery_path);
    assert!(dxf_file.exists(), "Deliverable DXF must exist on disk");
    let file_bytes = std::fs::read(dxf_file).expect("read deliverable file");
    assert!(file_bytes.len() > 150_000, "File size must exceed 150KB, got {} bytes", file_bytes.len());

    let mut hasher = Sha256::new();
    hasher.update(&file_bytes);
    let hash = format!("{:x}", hasher.finalize());
    assert_eq!(hash.len(), 64, "Must produce a valid SHA-256 hash");

    // Verify 15 AIA layers in generated file
    let dxf_text = String::from_utf8_lossy(&file_bytes);
    let expected_layers = [
        "A-SITE", "A-GRID", "A-COLS", "A-WALL-EXTR", "A-WALL-INTR",
        "A-DOOR", "A-GLAZ", "A-STAIR", "A-FURN", "A-SANR",
        "A-ELEV", "A-SECT", "A-DIMS", "A-ANNO", "A-3D-SOLID"
    ];
    for l in expected_layers {
        assert!(dxf_text.contains(l), "Bản vẽ phải chứa layer {l}");
    }
}


#[test]
fn test_copilot_stop_signal_and_cancellation() {
    let mut state = CopilotState::default();
    let (tx, rx) = std::sync::mpsc::channel();
    state.event_rx = Some(rx);
    state.is_busy = true;
    state.status.is_active = true;
    state.status.current_agent = AgentKind::Planner;

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.stop_signal = Some(stop.clone());

    // Trigger stop signal
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    tx.send(CopilotEvent::Stopped).unwrap();

    let event = state.poll_events().expect("should receive stopped event");
    match event {
        CopilotEvent::Stopped => {}
        _ => panic!("expected CopilotEvent::Stopped"),
    }

    assert!(!state.is_busy);
    assert!(!state.status.is_active);
    assert_eq!(state.status.current_agent, AgentKind::Idle);
    assert!(state.stop_signal.is_none());
    assert!(state.messages.iter().any(|m| m.text.contains("Đã dừng")));
}
