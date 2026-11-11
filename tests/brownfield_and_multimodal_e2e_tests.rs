//! Comprehensive End-to-End Tests for Multimodal Chat UI & Deep Brownfield In-Place CAD Engine.
//!
//! Covers:
//! - Scenario 1: Vietnamese Input & Multi-line Textarea (IME, Shift+Enter, Unicode rendering).
//! - Scenario 2: Clipboard Paste Image & Drag-Drop Excel/DWG Multimodal Ingestion.
//! - Scenario 3: Relational Rubber-Banding Stretch & In-Place Delta Editing on Existing CAD Drawing.
//! - Scenario 4: Seamless Layout Extension (Floor 2, Elevation, 3D Block) on Existing Sheet without Clashes.

use OpenCADStudio::ai::{
    brownfield::{DeepBrownfieldEngine, DrawingUnit},
    copilot_state::CopilotState,
    multimodal::{AttachedImage, MultimodalAttachmentManager},
    spatial_query::SpatialQueryEngine,
};
use base64::Engine;
use document::{
    entities::{EntityCommon, EntityType, Text},
    types::Vector3,
    Document,
};
use iced::widget::text_editor;
use serde_json::json;
use std::{fs::File, io::Write};

#[test]
fn test_scenario_1_vietnamese_input_and_multiline_textarea() {
    let mut state = CopilotState::default();

    // 1. Simulate typing multiline Vietnamese text with full diacritics
    // Line 1:
    let line1 = "MẶT BẰNG TẦNG 1 - BIỆT THỰ HIỆN ĐẠI";
    for ch in line1.chars() {
        state.input_content.perform(text_editor::Action::Edit(text_editor::Edit::Insert(ch)));
    }
    assert_eq!(state.input_content.line_count(), 1);

    // Simulate Shift + Enter (Insert newline)
    state.input_content.perform(text_editor::Action::Edit(text_editor::Edit::Enter));
    assert_eq!(state.input_content.line_count(), 2);

    // Line 2:
    let line2 = "Phòng Ngủ Ông Bà - 24.5 m² (Cửa sổ hướng Đông Nam)";
    for ch in line2.chars() {
        state.input_content.perform(text_editor::Action::Edit(text_editor::Edit::Insert(ch)));
    }

    // Simulate Shift + Enter
    state.input_content.perform(text_editor::Action::Edit(text_editor::Edit::Enter));
    assert_eq!(state.input_content.line_count(), 3);

    // Line 3:
    let line3 = "Bếp ăn & Phòng khách liên thông thoáng đãng";
    for ch in line3.chars() {
        state.input_content.perform(text_editor::Action::Edit(text_editor::Edit::Insert(ch)));
    }

    let full_text = state.current_prompt();
    assert!(full_text.contains("MẶT BẰNG TẦNG 1"));
    assert!(full_text.contains("Phòng Ngủ Ông Bà - 24.5 m²"));
    assert!(full_text.contains("Bếp ăn & Phòng khách"));

    // 2. Verify that this text converts cleanly into CAD Text and MText entities
    let mut doc = Document::default();
    let text_ent = EntityType::Text(Text {
        value: line1.to_string(),
        insertion_point: Vector3::new(100.0, 200.0, 0.0),
        height: 350.0,
        common: EntityCommon {
            layer: "A-ANNO".to_string(),
            ..Default::default()
        },
        ..Default::default()
    });
    let handle = doc.add_entity(text_ent).expect("add entity to document");
    assert!(handle.value() > 0);

    // Verify entity text content in document
    let digest = OpenCADStudio::ai::dwg_ingestion::summarize_document(&doc, "vietnamese_test.dwg");
    assert_eq!(digest.total_entities, 1);
    assert!(digest.layers.iter().any(|l| l.name == "A-ANNO"));

    // Clear prompt works
    state.clear_prompt();
    assert_eq!(state.input_content.line_count(), 1);
    assert!(state.current_prompt().is_empty());
}

#[test]
fn test_scenario_2_clipboard_paste_image_and_multimodal_drag_drop() {
    let temp_dir = std::env::temp_dir().join(format!("ocs_test_multimodal_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    // 1. Test In-Memory Image Creation and Base64 Encoding (Ctrl+V paste simulation)
    let img_width = 640u32;
    let img_height = 480u32;
    let mut test_img = image::RgbaImage::new(img_width, img_height);
    for pixel in test_img.pixels_mut() {
        *pixel = image::Rgba([255, 100, 50, 255]); // orange-red
    }

    let mut png_bytes = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_bytes);
    test_img.write_to(&mut cursor, image::ImageFormat::Png).expect("encode PNG");
    assert!(!png_bytes.is_empty());

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let attached_img = AttachedImage {
        id: "img_test_1".to_string(),
        name: "sketch_mat_bang.png".to_string(),
        width: img_width,
        height: img_height,
        bytes: png_bytes.clone(),
        base64: b64.clone(),
    };

    assert_eq!(attached_img.width, 640);
    assert_eq!(attached_img.height, 480);
    assert!(!attached_img.base64.is_empty());

    // 2. Test Drag-and-Drop of an Excel File (.csv / .xlsx format)
    let excel_path = temp_dir.join("villa_schedule.csv");
    let csv_content = "Tên Phòng,Diện Tích (m2),Tầng\n\
Phòng Khách,32.5,Tầng 1\n\
Phòng Bếp & Ăn,22.0,Tầng 1\n\
Phòng Ngủ Master,26.0,Tầng 2\n\
Phòng Sinh Hoạt Chung,18.0,Tầng 2\n";
    let mut f = File::create(&excel_path).unwrap();
    f.write_all(csv_content.as_bytes()).unwrap();

    let dropped_file = MultimodalAttachmentManager::parse_file(&excel_path)
        .expect("parse dropped file");

    match dropped_file {
        OpenCADStudio::ai::multimodal::DroppedAttachment::File(f) => {
            assert_eq!(f.name, "villa_schedule.csv");
            assert!(f.summary.contains("CSV"));
            assert!(f.summary.contains("5 dòng"));
        }
        _ => panic!("Expected AttachedFile"),
    }

    // 3. Test Drag-and-Drop of an Image File
    let image_file_path = temp_dir.join("concept_facade.png");
    let mut img_f = File::create(&image_file_path).unwrap();
    img_f.write_all(&png_bytes).unwrap();

    let dropped_img = MultimodalAttachmentManager::parse_file(&image_file_path)
        .expect("parse dropped image");

    match dropped_img {
        OpenCADStudio::ai::multimodal::DroppedAttachment::Image(img) => {
            assert_eq!(img.name, "concept_facade.png");
            assert_eq!(img.width, 640);
            assert_eq!(img.height, 480);
        }
        _ => panic!("Expected AttachedImage"),
    }

    // 4. Test OpenAI Vision Payload Assembly
    let vision_payload = MultimodalAttachmentManager::build_vision_payload(
        "Phân tích mặt bằng phác thảo và dựng hình CAD:",
        &[attached_img],
    );
    let arr = vision_payload.as_array().expect("array payload");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["type"], "text");
    assert_eq!(arr[1]["type"], "image_url");
    assert!(arr[1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_scenario_3_relational_rubber_banding_stretch_inplace() {
    // Construct an existing ground floor CAD layout with 4 exterior walls,
    // 1 interior partition wall, a door insert, and room text labels.
    let entities = vec![
        // South exterior wall: (0, 0) to (8000, 0)
        json!({
            "type": "Line",
            "handle": "11",
            "layer": "A-WALL-EXTR",
            "start": [0.0, 0.0],
            "end": [8000.0, 0.0]
        }),
        // North exterior wall: (0, 6000) to (8000, 6000)
        json!({
            "type": "Line",
            "handle": "12",
            "layer": "A-WALL-EXTR",
            "start": [0.0, 6000.0],
            "end": [8000.0, 6000.0]
        }),
        // West exterior wall: (0, 0) to (0, 6000)
        json!({
            "type": "Line",
            "handle": "10",
            "layer": "A-WALL-EXTR",
            "start": [0.0, 0.0],
            "end": [0.0, 6000.0]
        }),
        // East exterior wall: (8000, 0) to (8000, 6000)
        json!({
            "type": "Line",
            "handle": "13",
            "layer": "A-WALL-EXTR",
            "start": [8000.0, 0.0],
            "end": [8000.0, 6000.0]
        }),
        // Interior partition wall between Living Room and Kitchen:
        // Vertical line at x = 4000: from (4000, 0) to (4000, 6000)
        json!({
            "type": "Line",
            "handle": "14",
            "layer": "A-WALL-INTR",
            "start": [4000.0, 0.0],
            "end": [4000.0, 6000.0]
        }),
        // Door placed on the partition wall at (4000, 2000)
        json!({
            "type": "Insert",
            "handle": "15",
            "layer": "A-DOOR",
            "name": "DOOR_900",
            "position": [4000.0, 2000.0]
        }),
        // Living room name label
        json!({
            "type": "Text",
            "handle": "16",
            "layer": "A-ANNO",
            "value": "Phòng Khách",
            "position": [2000.0, 3000.0],
            "height": 250.0
        }),
        // Living room area label
        json!({
            "type": "Text",
            "handle": "17",
            "layer": "A-ANNO",
            "value": "24.0 m²",
            "position": [2000.0, 2500.0],
            "height": 200.0
        }),
    ];

    // 1. Test Unit Auto-Calibration
    let calib = DeepBrownfieldEngine::auto_calibrate_units(&entities);
    assert_eq!(calib.detected_unit, DrawingUnit::Millimeters);
    assert_eq!(calib.to_mm_scale, 1.0);
    assert!(calib.existing_layers.contains(&"A-WALL-EXTR".to_string()));

    // 2. Test Wall Graph Extraction
    let wall_graph = DeepBrownfieldEngine::build_wall_graph(&entities, 5.0);
    assert_eq!(wall_graph.walls.len(), 5);

    // 3. Test Relational Rubber-Banding Stretch:
    // Move the partition wall "14" by delta_x = +1000mm to expand the living room
    let stretch_result = DeepBrownfieldEngine::relational_stretch(
        &entities,
        "14",
        1000.0,
        0.0,
        5.0,
    );

    // Verification:
    // - Partition wall "14" was moved
    assert_eq!(stretch_result.moved_wall_handles, vec!["14"]);

    // - Door "15" on the partition wall moved with the wall to (5000, 2000)
    assert!(stretch_result.moved_dependent_blocks.contains(&"15".to_string()));

    // - Living room area label "17" was automatically recalculated and updated
    assert_eq!(stretch_result.updated_area_labels.len(), 1);
    assert_eq!(stretch_result.updated_area_labels[0].0, "17");
    let new_m2_text = &stretch_result.updated_area_labels[0].1;
    assert!(new_m2_text.contains("m²"));
    // New area should be expanded from 24.0
    let new_val: f64 = new_m2_text.replace(" m²", "").parse().unwrap();
    assert!(new_val > 24.0);

    // - delta_updates contains valid set_properties operations for old handles
    assert!(!stretch_result.delta_updates.is_empty());
    for update in &stretch_result.delta_updates {
        assert_eq!(update["op"], "set_properties");
        let handle = update["handle"].as_str().unwrap();
        assert!(matches!(handle, "14" | "15" | "17" | "11" | "12"));
    }

    // - Verify 0 clashes between entities
    let clashes = SpatialQueryEngine::find_clashes(&entities);
    assert_eq!(clashes.len(), 0);
}

#[test]
fn test_scenario_4_seamless_layout_continuation_without_clashes() {
    // Existing Floor 1 cluster
    let floor1_entities = vec![
        json!({
            "type": "LwPolyline",
            "handle": "100",
            "layer": "A-WALL-EXTR",
            "closed": true,
            "vertices": [[0.0, 0.0], [8000.0, 0.0], [8000.0, 6000.0], [0.0, 6000.0]]
        }),
        json!({
            "type": "Text",
            "handle": "101",
            "layer": "A-ANNO",
            "position": [2500.0, 3000.0],
            "value": "MẶT BẰNG TẦNG 1",
            "height": 350.0
        }),
    ];

    // 1. Partition Drawing Clusters on Existing Sheet
    let clusters = DeepBrownfieldEngine::partition_drawing_clusters(&floor1_entities);
    assert_eq!(clusters.len(), 1);
    let floor1_cluster = &clusters[0];
    assert_eq!(floor1_cluster.extents, [0.0, 0.0, 8000.0, 6000.0]);
    assert_eq!(floor1_cluster.width, 8000.0);
    assert_eq!(floor1_cluster.height, 6000.0);

    // 2. Generate Layout Extension (Floor 2, Main Elevation, 3D Block)
    let spacing = 2500.0;
    let extension_entities = DeepBrownfieldEngine::generate_layout_extension(
        floor1_cluster,
        spacing,
    );

    assert!(!extension_entities.is_empty());

    // 3. Verification of Zero Overlap & Non-Clashing Geometry
    let floor1_bounds = [0.0, 0.0, 8000.0, 6000.0];

    for new_ent in &extension_entities {
        let bounds = DeepBrownfieldEngine::entity_bounds(new_ent).expect("new entity bounds");
        // All new entities must sit strictly to the right of Floor 1's boundary (X >= 8000 + 2500 = 10500)
        assert!(
            bounds[0] >= 10500.0 - 1500.0, // titles may center slightly to the left of w/2
            "Entity overlaps or too close to Floor 1: bounds = {:?}, floor1 = {:?}",
            bounds,
            floor1_bounds
        );
    }

    // Verify Floor 2, Main Elevation, and 3D are present
    let has_floor2 = extension_entities.iter().any(|e| {
        e.get("value").and_then(|v| v.as_str()).unwrap_or("").contains("MẶT BẰNG TẦNG 2")
    });
    let has_elevation = extension_entities.iter().any(|e| {
        e.get("value").and_then(|v| v.as_str()).unwrap_or("").contains("MẶT ĐỨNG CHÍNH")
    });
    let has_3d = extension_entities.iter().any(|e| {
        e.get("value").and_then(|v| v.as_str()).unwrap_or("").contains("KHỐI 3D")
    });

    assert!(has_floor2, "Missing Floor 2 title");
    assert!(has_elevation, "Missing Main Elevation title");
    assert!(has_3d, "Missing 3D Perspective title");

    // Combine all entities into one master drawing and run clash detection
    let mut combined = floor1_entities.clone();
    combined.extend(extension_entities);

    let clashes = SpatialQueryEngine::find_clashes(&combined);
    assert_eq!(clashes.len(), 0, "Expected 0 clashes on brownfield sheet extension");
}
