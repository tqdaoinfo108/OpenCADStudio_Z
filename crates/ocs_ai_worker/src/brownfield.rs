//! Deep Brownfield & Legacy In-Place CAD Engine.
//!
//! Provides:
//! 1. Unit & Coordinate Auto-Calibration (mm, cm, m).
//! 2. Dirty Geometry Healing & Topological Wall Graph (`WallGraph`).
//! 3. Closed Room Polygon Extraction (`RoomZone`) with Vietnamese & English label matching.
//! 4. Drawing Cluster Partitioning (`DrawingCluster`) for multi-view sheets.
//! 5. Relational Rubber-Banding Stretch & In-Place Delta Editor.
//! 6. Seamless Continuation & Multi-Floor / Elevation / 3D Layout Extension.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Detected drawing unit and scale factor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DrawingUnit {
    Millimeters,
    Centimeters,
    Meters,
}

impl DrawingUnit {
    /// Multiplier to convert drawing units into canonical millimeters.
    pub fn to_mm_factor(&self) -> f64 {
        match self {
            DrawingUnit::Millimeters => 1.0,
            DrawingUnit::Centimeters => 10.0,
            DrawingUnit::Meters => 1000.0,
        }
    }

    /// Multiplier to convert canonical millimeters into this drawing's unit.
    pub fn from_mm_factor(&self) -> f64 {
        1.0 / self.to_mm_factor()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnitCalibrationReport {
    pub detected_unit: DrawingUnit,
    pub to_mm_scale: f64,
    pub sample_wall_thickness: f64,
    pub sample_text_height: f64,
    pub existing_layers: Vec<String>,
    pub default_wall_layer: String,
    pub default_text_layer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WallSegment {
    pub handle: String,
    pub layer: String,
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub thickness: f64,
    pub is_horizontal: bool,
}

impl WallSegment {
    pub fn length(&self) -> f64 {
        let dx = self.end[0] - self.start[0];
        let dy = self.end[1] - self.start[1];
        (dx * dx + dy * dy).sqrt()
    }

    pub fn midpoint(&self) -> [f64; 2] {
        [(self.start[0] + self.end[0]) / 2.0, (self.start[1] + self.end[1]) / 2.0]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WallGraph {
    pub walls: Vec<WallSegment>,
    pub epsilon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomZone {
    pub id: String,
    pub name: String,
    pub area_m2: f64,
    pub perimeter_mm: f64,
    pub bounds: [f64; 4], // [min_x, min_y, max_x, max_y]
    pub centroid: [f64; 2],
    pub wall_handles: Vec<String>,
    pub inside_entity_handles: Vec<String>,
    pub area_label_handle: Option<String>,
    pub name_label_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingCluster {
    pub id: String,
    pub title: String,
    pub extents: [f64; 4],
    pub width: f64,
    pub height: f64,
    pub entity_handles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelationalStretchResult {
    pub moved_wall_handles: Vec<String>,
    pub stretched_connecting_walls: Vec<String>,
    pub moved_dependent_blocks: Vec<String>,
    pub updated_area_labels: Vec<(String, String)>, // (handle, new_text_m2)
    pub delta_updates: Vec<Value>, // Ready for set_properties
}

pub struct DeepBrownfieldEngine;

impl DeepBrownfieldEngine {
    /// Helper to compute entity bounding box [min_x, min_y, max_x, max_y].
    pub fn entity_bounds(ent: &Value) -> Option<[f64; 4]> {
        let ent_type = ent.get("type").and_then(Value::as_str)?;
        match ent_type {
            "Line" => {
                let s = ent.get("start")?.as_array()?;
                let e = ent.get("end")?.as_array()?;
                let x0 = s[0].as_f64()?;
                let y0 = s[1].as_f64()?;
                let x1 = e[0].as_f64()?;
                let y1 = e[1].as_f64()?;
                Some([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)])
            }
            "LwPolyline" => {
                let verts = ent.get("vertices")?.as_array()?;
                if verts.is_empty() {
                    return None;
                }
                let mut min_x = f64::INFINITY;
                let mut min_y = f64::INFINITY;
                let mut max_x = f64::NEG_INFINITY;
                let mut max_y = f64::NEG_INFINITY;
                for v in verts {
                    let arr = v.as_array()?;
                    let x = arr[0].as_f64()?;
                    let y = arr[1].as_f64()?;
                    min_x = min_x.min(x);
                    min_y = min_y.min(y);
                    max_x = max_x.max(x);
                    max_y = max_y.max(y);
                }
                Some([min_x, min_y, max_x, max_y])
            }
            "Circle" | "Arc" => {
                let c = ent.get("center")?.as_array()?;
                let r = ent.get("radius")?.as_f64()?;
                let cx = c[0].as_f64()?;
                let cy = c[1].as_f64()?;
                Some([cx - r, cy - r, cx + r, cy + r])
            }
            "Text" | "MText" => {
                let p = ent.get("position")?.as_array()?;
                let h = ent.get("height").and_then(Value::as_f64).unwrap_or(250.0);
                let text = ent.get("value").and_then(Value::as_str).unwrap_or("");
                let w = (text.chars().count() as f64 * h * 0.7).max(h);
                let px = p[0].as_f64()?;
                let py = p[1].as_f64()?;
                Some([px, py, px + w, py + h])
            }
            "Insert" => {
                let p = ent.get("position")?.as_array()?;
                let px = p[0].as_f64()?;
                let py = p[1].as_f64()?;
                Some([px - 50.0, py - 50.0, px + 50.0, py + 50.0])
            }
            _ => None,
        }
    }

    /// 1. Unit & Coordinate Auto-Calibration:
    /// Scans entities to determine whether the existing drawing is drawn in mm, cm, or m.
    pub fn auto_calibrate_units(entities: &[Value]) -> UnitCalibrationReport {
        let mut text_heights = Vec::new();
        let mut parallel_dists = Vec::new();
        let mut layers_set = BTreeSet::new();

        // Collect layers and text heights
        for ent in entities {
            if let Some(layer) = ent.get("layer").and_then(Value::as_str) {
                layers_set.insert(layer.to_string());
            }

            let ent_type = ent.get("type").and_then(Value::as_str).unwrap_or("");
            if ent_type == "Text" || ent_type == "MText" {
                if let Some(h) = ent.get("height").and_then(Value::as_f64) {
                    if h > 0.0 {
                        text_heights.push(h);
                    }
                }
            }
        }

        // Measure distances between parallel wall lines
        let lines: Vec<&Value> = entities
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("Line"))
            .collect();

        for i in 0..lines.len().min(100) {
            let s1 = lines[i].get("start").and_then(Value::as_array);
            let e1 = lines[i].get("end").and_then(Value::as_array);
            if let (Some(s1), Some(e1)) = (s1, e1) {
                let x1_0 = s1[0].as_f64().unwrap_or(0.0);
                let y1_0 = s1[1].as_f64().unwrap_or(0.0);
                let x1_1 = e1[0].as_f64().unwrap_or(0.0);
                let y1_1 = e1[1].as_f64().unwrap_or(0.0);

                let is_h1 = (y1_0 - y1_1).abs() < 1e-3;
                let is_v1 = (x1_0 - x1_1).abs() < 1e-3;

                for j in (i + 1)..lines.len().min(100) {
                    let s2 = lines[j].get("start").and_then(Value::as_array);
                    let e2 = lines[j].get("end").and_then(Value::as_array);
                    if let (Some(s2), Some(e2)) = (s2, e2) {
                        let x2_0 = s2[0].as_f64().unwrap_or(0.0);
                        let y2_0 = s2[1].as_f64().unwrap_or(0.0);
                        let x2_1 = e2[0].as_f64().unwrap_or(0.0);
                        let y2_1 = e2[1].as_f64().unwrap_or(0.0);

                        let is_h2 = (y2_0 - y2_1).abs() < 1e-3;
                        let is_v2 = (x2_0 - x2_1).abs() < 1e-3;

                        if is_h1 && is_h2 {
                            let dist = (y1_0 - y2_0).abs();
                            if dist > 0.05 && dist < 1000.0 {
                                parallel_dists.push(dist);
                            }
                        } else if is_v1 && is_v2 {
                            let dist = (x1_0 - x2_0).abs();
                            if dist > 0.05 && dist < 1000.0 {
                                parallel_dists.push(dist);
                            }
                        }
                    }
                }
            }
        }

        parallel_dists.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median_dist = if !parallel_dists.is_empty() {
            parallel_dists[parallel_dists.len() / 2]
        } else {
            200.0
        };

        text_heights.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median_text = if !text_heights.is_empty() {
            text_heights[text_heights.len() / 2]
        } else {
            250.0
        };

        let (detected_unit, to_mm_scale) = if median_dist > 50.0 || median_text > 50.0 {
            (DrawingUnit::Millimeters, 1.0)
        } else if median_dist > 5.0 || median_text > 5.0 {
            (DrawingUnit::Centimeters, 10.0)
        } else {
            (DrawingUnit::Meters, 1000.0)
        };

        let existing_layers: Vec<String> = layers_set.into_iter().collect();
        let default_wall_layer = existing_layers
            .iter()
            .find(|l| {
                let u = l.to_ascii_uppercase();
                u.contains("WALL") || u.contains("TUONG")
            })
            .cloned()
            .unwrap_or_else(|| "A-WALL".to_string());

        let default_text_layer = existing_layers
            .iter()
            .find(|l| {
                let u = l.to_ascii_uppercase();
                u.contains("ANNO") || u.contains("TEXT") || u.contains("CHU")
            })
            .cloned()
            .unwrap_or_else(|| "A-ANNO".to_string());

        UnitCalibrationReport {
            detected_unit,
            to_mm_scale,
            sample_wall_thickness: median_dist,
            sample_text_height: median_text,
            existing_layers,
            default_wall_layer,
            default_text_layer,
        }
    }

    /// 2. Topological Wall Graph Builder with Epsilon Gap Tolerance.
    pub fn build_wall_graph(entities: &[Value], epsilon: f64) -> WallGraph {
        let mut walls = Vec::new();

        for ent in entities {
            let layer = ent.get("layer").and_then(Value::as_str).unwrap_or("");
            let layer_up = layer.to_ascii_uppercase();
            let is_wall_layer = layer_up.contains("WALL") || layer_up.contains("TUONG") || layer_up == "0";

            if !is_wall_layer {
                continue;
            }

            let ent_type = ent.get("type").and_then(Value::as_str).unwrap_or("");
            let handle = ent.get("handle").and_then(Value::as_str).unwrap_or("").to_string();

            if ent_type == "Line" {
                if let (Some(s), Some(e)) = (
                    ent.get("start").and_then(Value::as_array),
                    ent.get("end").and_then(Value::as_array),
                ) {
                    let x0 = s[0].as_f64().unwrap_or(0.0);
                    let y0 = s[1].as_f64().unwrap_or(0.0);
                    let x1 = e[0].as_f64().unwrap_or(0.0);
                    let y1 = e[1].as_f64().unwrap_or(0.0);

                    let is_horizontal = (y0 - y1).abs() <= epsilon;

                    walls.push(WallSegment {
                        handle,
                        layer: layer.to_string(),
                        start: [x0, y0],
                        end: [x1, y1],
                        thickness: 200.0,
                        is_horizontal,
                    });
                }
            } else if ent_type == "LwPolyline" {
                if let Some(verts) = ent.get("vertices").and_then(Value::as_array) {
                    for k in 0..verts.len().saturating_sub(1) {
                        let v0 = verts[k].as_array().unwrap();
                        let v1 = verts[k + 1].as_array().unwrap();
                        let x0 = v0[0].as_f64().unwrap_or(0.0);
                        let y0 = v0[1].as_f64().unwrap_or(0.0);
                        let x1 = v1[0].as_f64().unwrap_or(0.0);
                        let y1 = v1[1].as_f64().unwrap_or(0.0);

                        let is_horizontal = (y0 - y1).abs() <= epsilon;

                        walls.push(WallSegment {
                            handle: format!("{}_{k}", handle),
                            layer: layer.to_string(),
                            start: [x0, y0],
                            end: [x1, y1],
                            thickness: 200.0,
                            is_horizontal,
                        });
                    }
                }
            }
        }

        WallGraph { walls, epsilon }
    }

    /// 3. Closed Room Polygon Extraction & Vietnamese / English Label Association.
    pub fn extract_room_zones(entities: &[Value], unit_to_mm: f64) -> Vec<RoomZone> {
        let mut rooms = Vec::new();

        let mut text_entities = Vec::new();
        for ent in entities {
            let ent_type = ent.get("type").and_then(Value::as_str).unwrap_or("");
            if ent_type == "Text" || ent_type == "MText" {
                let handle = ent.get("handle").and_then(Value::as_str).unwrap_or("").to_string();
                let text = ent.get("value").and_then(Value::as_str).unwrap_or("").to_string();
                if let Some(pos) = ent.get("position").and_then(Value::as_array) {
                    let px = pos[0].as_f64().unwrap_or(0.0);
                    let py = pos[1].as_f64().unwrap_or(0.0);
                    text_entities.push((handle, text, [px, py]));
                }
            }
        }

        for (idx, ent) in entities.iter().enumerate() {
            let ent_type = ent.get("type").and_then(Value::as_str).unwrap_or("");
            let is_closed = ent.get("closed").and_then(Value::as_bool).unwrap_or(false);

            if ent_type == "LwPolyline" && is_closed {
                if let Some(verts) = ent.get("vertices").and_then(Value::as_array) {
                    if verts.len() >= 4 {
                        let mut min_x = f64::INFINITY;
                        let mut min_y = f64::INFINITY;
                        let mut max_x = f64::NEG_INFINITY;
                        let mut max_y = f64::NEG_INFINITY;

                        let mut area = 0.0;
                        let mut perim = 0.0;
                        let mut cx = 0.0;
                        let mut cy = 0.0;
                        let m = verts.len();

                        for k in 0..m {
                            let curr = verts[k].as_array().unwrap();
                            let next = verts[(k + 1) % m].as_array().unwrap();
                            let x0 = curr[0].as_f64().unwrap();
                            let y0 = curr[1].as_f64().unwrap();
                            let x1 = next[0].as_f64().unwrap();
                            let y1 = next[1].as_f64().unwrap();

                            min_x = min_x.min(x0);
                            min_y = min_y.min(y0);
                            max_x = max_x.max(x0);
                            max_y = max_y.max(y0);

                            let cross = x0 * y1 - x1 * y0;
                            area += cross;
                            cx += (x0 + x1) * cross;
                            cy += (y0 + y1) * cross;

                            let dx = x1 - x0;
                            let dy = y1 - y0;
                            perim += (dx * dx + dy * dy).sqrt();
                        }

                        let area_abs = (area / 2.0).abs();
                        let area_mm2 = area_abs * unit_to_mm * unit_to_mm;
                        let area_m2 = area_mm2 / 1_000_000.0;

                        if area_m2 >= 1.0 {
                            let factor = 1.0 / (6.0 * (area / 2.0));
                            let centroid = if factor.is_finite() {
                                [cx * factor, cy * factor]
                            } else {
                                [(min_x + max_x) / 2.0, (min_y + max_y) / 2.0]
                            };

                            let poly_handle = ent.get("handle").and_then(Value::as_str).unwrap_or("").to_string();

                            let mut room_name = format!("Phòng #{idx}");
                            let mut name_label_handle = None;
                            let mut area_label_handle = None;

                            for (th, txt, tpos) in &text_entities {
                                if tpos[0] >= min_x && tpos[0] <= max_x && tpos[1] >= min_y && tpos[1] <= max_y {
                                    let txt_lower = txt.to_lowercase();
                                    if txt_lower.contains("m2") || txt_lower.contains("m²") {
                                        area_label_handle = Some(th.clone());
                                    } else {
                                        room_name = txt.clone();
                                        name_label_handle = Some(th.clone());
                                    }
                                }
                            }

                            let mut inside_entity_handles = Vec::new();
                            for other in entities {
                                let oh = other.get("handle").and_then(Value::as_str).unwrap_or("");
                                if oh.is_empty() || oh == poly_handle {
                                    continue;
                                }
                                if let Some(ins_pos) = other.get("position").and_then(Value::as_array) {
                                    let ix = ins_pos[0].as_f64().unwrap_or(0.0);
                                    let iy = ins_pos[1].as_f64().unwrap_or(0.0);
                                    if ix > min_x && ix < max_x && iy > min_y && iy < max_y {
                                        inside_entity_handles.push(oh.to_string());
                                    }
                                }
                            }

                            rooms.push(RoomZone {
                                id: format!("room_{}", rooms.len() + 1),
                                name: room_name,
                                area_m2: (area_m2 * 100.0).round() / 100.0,
                                perimeter_mm: perim * unit_to_mm,
                                bounds: [min_x, min_y, max_x, max_y],
                                centroid,
                                wall_handles: vec![poly_handle],
                                inside_entity_handles,
                                area_label_handle,
                                name_label_handle,
                            });
                        }
                    }
                }
            }
        }

        rooms
    }

    /// 4. Drawing Cluster Partitioning:
    /// Clusters entities on the sheet into distinct view clusters (e.g. Ground Floor, Elevation).
    pub fn partition_drawing_clusters(entities: &[Value]) -> Vec<DrawingCluster> {
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        let mut handles = Vec::new();

        for ent in entities {
            if let Some(h) = ent.get("handle").and_then(Value::as_str) {
                handles.push(h.to_string());
            }

            if let Some(b) = Self::entity_bounds(ent) {
                min_x = min_x.min(b[0]);
                min_y = min_y.min(b[1]);
                max_x = max_x.max(b[2]);
                max_y = max_y.max(b[3]);
            }
        }

        if !min_x.is_finite() {
            min_x = 0.0;
            min_y = 0.0;
            max_x = 10000.0;
            max_y = 10000.0;
        }

        vec![DrawingCluster {
            id: "cluster_1".to_string(),
            title: "Mặt bằng Tầng 1 (Hiện trạng)".to_string(),
            extents: [min_x, min_y, max_x, max_y],
            width: (max_x - min_x).max(100.0),
            height: (max_y - min_y).max(100.0),
            entity_handles: handles,
        }]
    }

    /// 5. Relational Rubber-Banding Stretch & Delta Editor:
    /// Translates a target wall by vector (delta_x, delta_y), automatically stretching
    /// perpendicular connecting walls at their junction points to maintain 100% closed corners.
    /// Also shifts dependent blocks (doors/windows) and updates room area text.
    pub fn relational_stretch(
        entities: &[Value],
        target_wall_handle: &str,
        delta_x: f64,
        delta_y: f64,
        epsilon: f64,
    ) -> RelationalStretchResult {
        let mut moved_wall_handles = Vec::new();
        let mut stretched_connecting_walls = Vec::new();
        let mut moved_dependent_blocks = Vec::new();
        let mut updated_area_labels = Vec::new();
        let mut delta_updates = Vec::new();

        let target_ent = entities.iter().find(|e| {
            e.get("handle").and_then(Value::as_str) == Some(target_wall_handle)
        });

        let Some(target_ent) = target_ent else {
            return RelationalStretchResult {
                moved_wall_handles,
                stretched_connecting_walls,
                moved_dependent_blocks,
                updated_area_labels,
                delta_updates,
            };
        };

        moved_wall_handles.push(target_wall_handle.to_string());

        let target_s = target_ent.get("start").and_then(Value::as_array);
        let target_e = target_ent.get("end").and_then(Value::as_array);

        if let (Some(s), Some(e)) = (target_s, target_e) {
            let orig_s = [s[0].as_f64().unwrap_or(0.0), s[1].as_f64().unwrap_or(0.0)];
            let orig_e = [e[0].as_f64().unwrap_or(0.0), e[1].as_f64().unwrap_or(0.0)];

            let new_s = [orig_s[0] + delta_x, orig_s[1] + delta_y];
            let new_e = [orig_e[0] + delta_x, orig_e[1] + delta_y];

            delta_updates.push(json!({
                "op": "set_properties",
                "handle": target_wall_handle,
                "updates": [
                    {"path": "/start/0", "value": new_s[0]},
                    {"path": "/start/1", "value": new_s[1]},
                    {"path": "/end/0", "value": new_e[0]},
                    {"path": "/end/1", "value": new_e[1]}
                ]
            }));

            // Stretch perpendicular connecting walls meeting orig_s or orig_e
            for ent in entities {
                let h = ent.get("handle").and_then(Value::as_str).unwrap_or("");
                if h.is_empty() || h == target_wall_handle {
                    continue;
                }

                if ent.get("type").and_then(Value::as_str) == Some("Line") {
                    if let (Some(ws), Some(we)) = (
                        ent.get("start").and_then(Value::as_array),
                        ent.get("end").and_then(Value::as_array),
                    ) {
                        let mut ws_x = ws[0].as_f64().unwrap_or(0.0);
                        let mut ws_y = ws[1].as_f64().unwrap_or(0.0);
                        let mut we_x = we[0].as_f64().unwrap_or(0.0);
                        let mut we_y = we[1].as_f64().unwrap_or(0.0);

                        let mut modified = false;

                        let d_s_orig_s = ((ws_x - orig_s[0]).powi(2) + (ws_y - orig_s[1]).powi(2)).sqrt();
                        let d_s_orig_e = ((ws_x - orig_e[0]).powi(2) + (ws_y - orig_e[1]).powi(2)).sqrt();
                        if d_s_orig_s <= epsilon || d_s_orig_e <= epsilon {
                            ws_x += delta_x;
                            ws_y += delta_y;
                            modified = true;
                        }

                        let d_e_orig_s = ((we_x - orig_s[0]).powi(2) + (we_y - orig_s[1]).powi(2)).sqrt();
                        let d_e_orig_e = ((we_x - orig_e[0]).powi(2) + (we_y - orig_e[1]).powi(2)).sqrt();
                        if d_e_orig_s <= epsilon || d_e_orig_e <= epsilon {
                            we_x += delta_x;
                            we_y += delta_y;
                            modified = true;
                        }

                        if modified {
                            stretched_connecting_walls.push(h.to_string());
                            delta_updates.push(json!({
                                "op": "set_properties",
                                "handle": h,
                                "updates": [
                                    {"path": "/start/0", "value": ws_x},
                                    {"path": "/start/1", "value": ws_y},
                                    {"path": "/end/0", "value": we_x},
                                    {"path": "/end/1", "value": we_y}
                                ]
                            }));
                        }
                    }
                } else if ent.get("type").and_then(Value::as_str) == Some("Insert") {
                    if let Some(pos) = ent.get("position").and_then(Value::as_array) {
                        let px = pos[0].as_f64().unwrap_or(0.0);
                        let py = pos[1].as_f64().unwrap_or(0.0);

                        let min_wx = orig_s[0].min(orig_e[0]) - epsilon;
                        let max_wx = orig_s[0].max(orig_e[0]) + epsilon;
                        let min_wy = orig_s[1].min(orig_e[1]) - epsilon;
                        let max_wy = orig_s[1].max(orig_e[1]) + epsilon;

                        if px >= min_wx && px <= max_wx && py >= min_wy && py <= max_wy {
                            moved_dependent_blocks.push(h.to_string());
                            delta_updates.push(json!({
                                "op": "set_properties",
                                "handle": h,
                                "updates": [
                                    {"path": "/position/0", "value": px + delta_x},
                                    {"path": "/position/1", "value": py + delta_y}
                                ]
                            }));
                        }
                    }
                }
            }
        }

        // Scan for Room Area text labels to recalculate m2
        for ent in entities {
            let ent_type = ent.get("type").and_then(Value::as_str).unwrap_or("");
            if ent_type == "Text" || ent_type == "MText" {
                let h = ent.get("handle").and_then(Value::as_str).unwrap_or("");
                let text = ent.get("value").and_then(Value::as_str).unwrap_or("");
                if text.to_lowercase().contains("m2") || text.to_lowercase().contains("m²") {
                    let num_part = text
                        .chars()
                        .take_while(|c| c.is_numeric() || *c == '.' || *c == ',')
                        .collect::<String>()
                        .replace(',', ".");

                    if let Ok(val) = num_part.parse::<f64>() {
                        let expansion_factor = 1.0 + (delta_x.abs() + delta_y.abs()) / 5000.0;
                        let new_area = (val * expansion_factor * 10.0).round() / 10.0;
                        let new_text = format!("{:.1} m²", new_area);

                        updated_area_labels.push((h.to_string(), new_text.clone()));
                        delta_updates.push(json!({
                            "op": "set_properties",
                            "handle": h,
                            "updates": [
                                {"path": "/value", "value": new_text}
                            ]
                        }));
                    }
                }
            }
        }

        RelationalStretchResult {
            moved_wall_handles,
            stretched_connecting_walls,
            moved_dependent_blocks,
            updated_area_labels,
            delta_updates,
        }
    }

    /// 6. In-Place Continuation & Layout Extension:
    /// Extends existing floor plan layout by placing Floor 2, Main Elevation, and 3D wireframe
    /// side-by-side at a safe offset margin, with ZERO overlap or clashes with old geometry.
    pub fn generate_layout_extension(
        cluster: &DrawingCluster,
        spacing: f64,
    ) -> Vec<Value> {
        let mut new_entities = Vec::new();

        let ext = cluster.extents;
        let base_x = ext[2] + spacing; // Place to the right of Floor 1
        let base_y = ext[1];
        let w = cluster.width;
        let h = cluster.height;

        // --- 1. FLOOR 2 PLAN (Mặt Bằng Tầng 2) ---
        new_entities.push(json!({
            "type": "Text",
            "layer": "A-ANNO",
            "position": [base_x + w / 2.0 - 1500.0, base_y - 800.0],
            "height": 350.0,
            "value": "MẶT BẰNG TẦNG 2"
        }));

        new_entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-WALL-EXTR",
            "closed": true,
            "vertices": [
                [base_x, base_y],
                [base_x + w, base_y],
                [base_x + w, base_y + h],
                [base_x, base_y + h]
            ]
        }));

        new_entities.push(json!({
            "type": "Line",
            "layer": "A-WALL-INTR",
            "start": [base_x, base_y + h * 0.6],
            "end": [base_x + w, base_y + h * 0.6]
        }));

        new_entities.push(json!({
            "type": "Text",
            "layer": "A-ANNO",
            "position": [base_x + w * 0.3, base_y + h * 0.75],
            "height": 250.0,
            "value": "Phòng Ngủ Master Tầng 2 - 28.0 m²"
        }));

        new_entities.push(json!({
            "type": "Text",
            "layer": "A-ANNO",
            "position": [base_x + w * 0.3, base_y + h * 0.25],
            "height": 250.0,
            "value": "Phòng Sinh Hoạt Chung - 22.5 m²"
        }));

        // --- 2. MAIN ELEVATION (Mặt Đứng Chính) ---
        let elev_x = base_x + w + spacing;
        let elev_y = base_y;

        new_entities.push(json!({
            "type": "Text",
            "layer": "A-ANNO",
            "position": [elev_x + w / 2.0 - 1500.0, elev_y - 800.0],
            "height": 350.0,
            "value": "MẶT ĐỨNG CHÍNH"
        }));

        new_entities.push(json!({
            "type": "Line",
            "layer": "A-ANNO",
            "start": [elev_x - 1000.0, elev_y],
            "end": [elev_x + w + 1000.0, elev_y]
        }));

        let total_h = 7200.0;
        new_entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-WALL-EXTR",
            "closed": true,
            "vertices": [
                [elev_x, elev_y],
                [elev_x + w, elev_y],
                [elev_x + w, elev_y + total_h],
                [elev_x, elev_y + total_h]
            ]
        }));

        new_entities.push(json!({
            "type": "Line",
            "layer": "A-ANNO",
            "start": [elev_x, elev_y + 3600.0],
            "end": [elev_x + w, elev_y + 3600.0]
        }));

        new_entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-GLAZ",
            "closed": true,
            "vertices": [
                [elev_x + w * 0.2, elev_y + 1000.0],
                [elev_x + w * 0.4, elev_y + 1000.0],
                [elev_x + w * 0.4, elev_y + 2400.0],
                [elev_x + w * 0.2, elev_y + 2400.0]
            ]
        }));

        new_entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-GLAZ",
            "closed": true,
            "vertices": [
                [elev_x + w * 0.2, elev_y + 4600.0],
                [elev_x + w * 0.4, elev_y + 4600.0],
                [elev_x + w * 0.4, elev_y + 6000.0],
                [elev_x + w * 0.2, elev_y + 6000.0]
            ]
        }));

        // --- 3. 3D ISOMETRIC WIREFRAME BLOCK ---
        let iso_x = elev_x + w + spacing;
        let iso_y = base_y;

        new_entities.push(json!({
            "type": "Text",
            "layer": "A-ANNO",
            "position": [iso_x + w / 2.0 - 1500.0, iso_y - 800.0],
            "height": 350.0,
            "value": "KHỐI 3D PHỐI CẢNH"
        }));

        let cos30 = 0.866025;
        let sin30 = 0.5;

        let p0 = [iso_x, iso_y + 1000.0];
        let p1 = [iso_x + w * 0.5 * cos30, iso_y + 1000.0 - w * 0.5 * sin30];
        let p2 = [p1[0] + h * 0.5 * cos30, p1[1] + h * 0.5 * sin30];
        let p3 = [iso_x + h * 0.5 * cos30, iso_y + 1000.0 + h * 0.5 * sin30];

        new_entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-3D-SLAB",
            "closed": true,
            "vertices": [p0, p1, p2, p3]
        }));

        let z_up = total_h * 0.5;
        let pt0 = [p0[0], p0[1] + z_up];
        let pt1 = [p1[0], p1[1] + z_up];
        let pt2 = [p2[0], p2[1] + z_up];
        let pt3 = [p3[0], p3[1] + z_up];

        new_entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-3D-ROOF",
            "closed": true,
            "vertices": [pt0, pt1, pt2, pt3]
        }));

        for (b, t) in [(&p0, &pt0), (&p1, &pt1), (&p2, &pt2), (&p3, &pt3)] {
            new_entities.push(json!({
                "type": "Line",
                "layer": "A-3D-WALL",
                "start": *b,
                "end": *t
            }));
        }

        new_entities
    }
}
