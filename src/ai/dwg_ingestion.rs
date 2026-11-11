//! Native DWG/DXF Multimodal Chat Ingestion Engine for OpenCADStudio.
//!
//! Provides:
//! 1. Mode A (Open/Replace as Active Base Drawing) & Mode B (Merge/Import Blocks into Current).
//! 2. Spatial Context Summarizer (Architectural Semantic Digest) compressing thousands of entities
//!    into a structured, token-efficient digest for LLM planning.

use document::{
    entities::EntityType,
    Document,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

/// Intelligent DWG/DXF ingestion mode chosen by user or prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IngestionMode {
    /// Mode A: Open and set as the active base drawing for AI evolution.
    OpenAsActiveBase,
    /// Mode B: Merge block definitions, layers, and reference geometry into the active drawing.
    MergeIntoCurrent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerDigest {
    pub name: String,
    pub entity_count: usize,
    pub entity_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockDigest {
    pub name: String,
    pub instance_count: usize,
    pub sample_positions: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridAxisDigest {
    pub tag: String,
    pub coordinate: f64,
    pub orientation: String, // "X" (Vertical line, constant X) or "Y" (Horizontal line, constant Y)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnclosedRegionDigest {
    pub id: String,
    pub boundary_layer: String,
    pub bounding_box: [f64; 4], // [min_x, min_y, max_x, max_y]
    pub approx_area_m2: f64,
    pub room_name_labels: Vec<String>,
}

/// Compact architectural semantic digest created from a DWG/DXF file.
/// Safely feeds into LLM context window without overflowing token limits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitecturalSemanticDigest {
    pub source_name: String,
    pub total_entities: usize,
    pub extents: [f64; 4], // [min_x, min_y, max_x, max_y] in mm
    pub layers: Vec<LayerDigest>,
    pub blocks: Vec<BlockDigest>,
    pub grid_axes: Vec<GridAxisDigest>,
    pub enclosed_regions: Vec<EnclosedRegionDigest>,
    pub key_text_annotations: Vec<String>,
    pub summary_text: String,
}

impl ArchitecturalSemanticDigest {
    /// Formats the digest into a prompt-ready architectural summary string for LLM agents.
    pub fn to_prompt_context(&self) -> String {
        let mut out = Vec::new();
        out.push(format!("[INGESTED DWG/DXF DIGEST: {}]", self.source_name));
        out.push(format!(
            "- Extents: [{:.1}, {:.1}] đến [{:.1}, {:.1}] (Kích thước: {:.1}m x {:.1}m)",
            self.extents[0], self.extents[1], self.extents[2], self.extents[3],
            (self.extents[2] - self.extents[0]).abs() / 1000.0,
            (self.extents[3] - self.extents[1]).abs() / 1000.0,
        ));
        out.push(format!("- Tổng số thực thể: {} trên {} layers.", self.total_entities, self.layers.len()));
        if !self.layers.is_empty() {
            let layer_names: Vec<String> = self.layers.iter().map(|l| format!("{}({})", l.name, l.entity_count)).collect();
            out.push(format!("- Danh sách Layers: [{}]", layer_names.join(", ")));
        }

        if !self.grid_axes.is_empty() {
            let x_axes: Vec<String> = self.grid_axes.iter().filter(|a| a.orientation == "X").map(|a| format!("{} ({:.0}mm)", a.tag, a.coordinate)).collect();
            let y_axes: Vec<String> = self.grid_axes.iter().filter(|a| a.orientation == "Y").map(|a| format!("{} ({:.0}mm)", a.tag, a.coordinate)).collect();
            if !x_axes.is_empty() {
                out.push(format!("- Trục dọc nhận diện: [{}]", x_axes.join(", ")));
            }
            if !y_axes.is_empty() {
                out.push(format!("- Trục ngang nhận diện: [{}]", y_axes.join(", ")));
            }
        }

        if !self.blocks.is_empty() {
            let blk_str: Vec<String> = self.blocks.iter().map(|b| format!("{} (x{})", b.name, b.instance_count)).collect();
            out.push(format!("- Blocks ({}) : [{}]", self.blocks.len(), blk_str.join(", ")));
        }

        if !self.enclosed_regions.is_empty() {
            out.push(format!("- Vùng khép kín / Phòng nhận diện ({} vùng):", self.enclosed_regions.len()));
            for r in &self.enclosed_regions {
                let labels = if r.room_name_labels.is_empty() {
                    "Không có nhãn".to_string()
                } else {
                    r.room_name_labels.join(", ")
                };
                out.push(format!("  * [{}]: Diện tích ~{:.1} m² | Nhãn: '{}'", r.id, r.approx_area_m2, labels));
            }
        }

        if !self.key_text_annotations.is_empty() {
            let sample: Vec<String> = self.key_text_annotations.iter().take(15).cloned().collect();
            out.push(format!("- Các nhãn ghi chú chính: [{}]", sample.join("; ")));
        }

        out.join("\n")
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(json!({}))
    }
}

/// Parses DWG/DXF bytes and compiles an [`ArchitecturalSemanticDigest`].
pub fn summarize_dwg_bytes(bytes: &[u8], name: &str) -> Result<ArchitecturalSemanticDigest, String> {
    let doc = crate::io::load_bytes(name, bytes.to_vec())?;
    Ok(summarize_document(&doc, name))
}

/// Parses a DWG/DXF file from disk and compiles an [`ArchitecturalSemanticDigest`].
pub fn summarize_dwg_file(path: &Path) -> Result<ArchitecturalSemanticDigest, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read file {}: {e}", path.display()))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("drawing.dwg");
    summarize_dwg_bytes(&bytes, file_name)
}

/// Analyzes an in-memory [`Document`] to build an [`ArchitecturalSemanticDigest`].
pub fn summarize_document(doc: &Document, source_name: &str) -> ArchitecturalSemanticDigest {
    let mut total_entities = 0;
    let mut layer_map: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    let mut block_instances: BTreeMap<String, (usize, Vec<[f64; 2]>)> = BTreeMap::new();
    let mut text_annotations: Vec<(String, [f64; 2])> = Vec::new();
    let mut grid_axes = Vec::new();
    let mut polylines_closed: Vec<(String, Vec<[f64; 2]>, f64)> = Vec::new();

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;

    for entity in doc.entities() {
        total_entities += 1;
        match entity {
            EntityType::Line(line) => {
                let layer = line.common.layer.clone();
                let entry = layer_map.entry(layer.clone()).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("LINE".to_string());

                let x0 = line.start.x;
                let y0 = line.start.y;
                let x1 = line.end.x;
                let y1 = line.end.y;

                min_x = min_x.min(x0).min(x1);
                min_y = min_y.min(y0).min(y1);
                max_x = max_x.max(x0).max(x1);
                max_y = max_y.max(y0).max(y1);

                // Grid axis candidate: vertical or horizontal lines on grid/axis layers
                let norm_layer = layer.to_lowercase();
                if norm_layer.contains("grid") || norm_layer.contains("truc") || norm_layer.contains("axis") {
                    if (x0 - x1).abs() < 1e-3 && (y0 - y1).abs() > 2000.0 {
                        grid_axes.push(GridAxisDigest {
                            tag: format!("X_{:.0}", x0),
                            coordinate: x0,
                            orientation: "X".to_string(),
                        });
                    } else if (y0 - y1).abs() < 1e-3 && (x0 - x1).abs() > 2000.0 {
                        grid_axes.push(GridAxisDigest {
                            tag: format!("Y_{:.0}", y0),
                            coordinate: y0,
                            orientation: "Y".to_string(),
                        });
                    }
                }
            }
            EntityType::LwPolyline(poly) => {
                let layer = poly.common.layer.clone();
                let entry = layer_map.entry(layer.clone()).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("LWPOLYLINE".to_string());

                let mut pts = Vec::new();
                for v in &poly.vertices {
                    let px = v.location.x;
                    let py = v.location.y;
                    min_x = min_x.min(px);
                    min_y = min_y.min(py);
                    max_x = max_x.max(px);
                    max_y = max_y.max(py);
                    pts.push([px, py]);
                }

                if poly.is_closed && pts.len() >= 3 {
                    let area_mm2 = polygon_area(&pts);
                    let area_m2 = area_mm2 / 1_000_000.0;
                    if area_m2 > 1.0 && area_m2 < 10000.0 {
                        polylines_closed.push((layer, pts, area_m2));
                    }
                }
            }
            EntityType::Text(t) => {
                let layer = t.common.layer.clone();
                let entry = layer_map.entry(layer).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("TEXT".to_string());

                let px = t.insertion_point.x;
                let py = t.insertion_point.y;
                min_x = min_x.min(px);
                min_y = min_y.min(py);
                max_x = max_x.max(px);
                max_y = max_y.max(py);

                let txt = t.value.trim().to_string();
                if !txt.is_empty() {
                    text_annotations.push((txt, [px, py]));
                }
            }
            EntityType::MText(t) => {
                let layer = t.common.layer.clone();
                let entry = layer_map.entry(layer).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("MTEXT".to_string());

                let px = t.insertion_point.x;
                let py = t.insertion_point.y;
                min_x = min_x.min(px);
                min_y = min_y.min(py);
                max_x = max_x.max(px);
                max_y = max_y.max(py);

                let txt = t.value.trim().to_string();
                if !txt.is_empty() {
                    text_annotations.push((txt, [px, py]));
                }
            }
            EntityType::Insert(ins) => {
                let layer = ins.common.layer.clone();
                let entry = layer_map.entry(layer).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("INSERT".to_string());

                let px = ins.insert_point.x;
                let py = ins.insert_point.y;
                min_x = min_x.min(px);
                min_y = min_y.min(py);
                max_x = max_x.max(px);
                max_y = max_y.max(py);

                let bentry = block_instances.entry(ins.block_name.clone()).or_insert((0, Vec::new()));
                bentry.0 += 1;
                if bentry.1.len() < 3 {
                    bentry.1.push([px, py]);
                }
            }
            EntityType::Circle(c) => {
                let layer = c.common.layer.clone();
                let entry = layer_map.entry(layer).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("CIRCLE".to_string());

                let cx = c.center.x;
                let cy = c.center.y;
                let r = c.radius;
                min_x = min_x.min(cx - r);
                min_y = min_y.min(cy - r);
                max_x = max_x.max(cx + r);
                max_y = max_y.max(cy + r);
            }
            EntityType::Arc(a) => {
                let layer = a.common.layer.clone();
                let entry = layer_map.entry(layer).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("ARC".to_string());
            }
            EntityType::Hatch(h) => {
                let layer = h.common.layer.clone();
                let entry = layer_map.entry(layer).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
                entry.1.insert("HATCH".to_string());
            }
            _ => {
                let entry = layer_map.entry("0".to_string()).or_insert((0, BTreeSet::new()));
                entry.0 += 1;
            }
        }
    }

    if min_x > max_x {
        min_x = 0.0;
        min_y = 0.0;
        max_x = 0.0;
        max_y = 0.0;
    }

    // Sort and clean grid axes (deduplicate within 50mm)
    grid_axes.sort_by(|a, b| a.coordinate.partial_cmp(&b.coordinate).unwrap_or(std::cmp::Ordering::Equal));
    grid_axes.dedup_by(|a, b| a.orientation == b.orientation && (a.coordinate - b.coordinate).abs() < 50.0);

    // Correlate closed polylines with text labels located inside
    let mut enclosed_regions = Vec::new();
    for (idx, (layer, pts, area_m2)) in polylines_closed.into_iter().enumerate() {
        let mut p_min_x = f64::MAX;
        let mut p_min_y = f64::MAX;
        let mut p_max_x = f64::MIN;
        let mut p_max_y = f64::MIN;
        for &[px, py] in &pts {
            p_min_x = p_min_x.min(px);
            p_min_y = p_min_y.min(py);
            p_max_x = p_max_x.max(px);
            p_max_y = p_max_y.max(py);
        }

        let mut labels_inside = Vec::new();
        for (txt, [tx, ty]) in &text_annotations {
            if *tx >= p_min_x && *tx <= p_max_x && *ty >= p_min_y && *ty <= p_max_y {
                if point_in_polygon(*tx, *ty, &pts) {
                    labels_inside.push(txt.clone());
                }
            }
        }

        enclosed_regions.push(EnclosedRegionDigest {
            id: format!("REGION_{}", idx + 1),
            boundary_layer: layer,
            bounding_box: [p_min_x, p_min_y, p_max_x, p_max_y],
            approx_area_m2: area_m2,
            room_name_labels: labels_inside,
        });
    }

    let layers_vec: Vec<LayerDigest> = layer_map
        .into_iter()
        .map(|(name, (cnt, types))| LayerDigest {
            name,
            entity_count: cnt,
            entity_types: types.into_iter().collect(),
        })
        .collect();

    let blocks_vec: Vec<BlockDigest> = block_instances
        .into_iter()
        .map(|(name, (cnt, pos))| BlockDigest {
            name,
            instance_count: cnt,
            sample_positions: pos,
        })
        .collect();

    let key_texts: Vec<String> = text_annotations
        .into_iter()
        .map(|(t, _)| t)
        .take(50)
        .collect();

    let mut digest = ArchitecturalSemanticDigest {
        source_name: source_name.to_string(),
        total_entities,
        extents: [min_x, min_y, max_x, max_y],
        layers: layers_vec,
        blocks: blocks_vec,
        grid_axes,
        enclosed_regions,
        key_text_annotations: key_texts,
        summary_text: String::new(),
    };

    digest.summary_text = digest.to_prompt_context();
    digest
}

/// Computes the planar 2D polygon area using the Shoelace formula.
fn polygon_area(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        area += pts[i][0] * pts[j][1];
        area -= pts[j][0] * pts[i][1];
    }
    (area / 2.0).abs()
}

/// Ray-casting point-in-polygon test.
fn point_in_polygon(x: f64, y: f64, pts: &[[f64; 2]]) -> bool {
    let n = pts.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let xi = pts[i][0];
        let yi = pts[i][1];
        let xj = pts[j][0];
        let yj = pts[j][1];

        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

// =========================================================================
// SECTION 2: MODE A & MODE B BATCH PREPARATION
// =========================================================================

/// Prepares Mode A command: Open/Replace as active base drawing.
pub fn prepare_mode_a_request(file_path: &Path) -> Value {
    json!({
        "op": "open",
        "path": file_path.to_string_lossy().to_string()
    })
}

/// Prepares Mode B command batch: Merges block definitions and layers from an attached DWG.
pub fn prepare_mode_b_merge_batch(
    doc: &Document,
    prefix: Option<&str>,
) -> Vec<Value> {
    let mut steps = Vec::new();
    let pfx = prefix.unwrap_or("REF_");

    // 1. Re-create layers
    for layer in doc.layers.iter() {
        let new_layer_name = format!("{}{}", pfx, layer.name);
        let aci = match &layer.color {
            document::types::Color::Index(idx) => *idx,
            _ => 7,
        };
        steps.push(json!({
            "op": "run",
            "cmd": format!("-LAYER M \"{}\" C {} \"{}\" ", new_layer_name, aci, new_layer_name)
        }));
    }

    // 2. Extract block definitions
    for block in doc.block_records.iter() {
        steps.push(json!({
            "op": "run",
            "cmd": format!("; Imported block {} handle {:X}", block.name, block.handle.value())
        }));
    }

    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_polygon_area_and_pip() {
        let square = vec![
            [0.0, 0.0],
            [10000.0, 0.0],
            [10000.0, 10000.0],
            [0.0, 10000.0],
        ];
        let area = polygon_area(&square);
        assert_eq!(area, 100_000_000.0); // 100 m²

        assert!(point_in_polygon(5000.0, 5000.0, &square));
        assert!(!point_in_polygon(15000.0, 5000.0, &square));
    }
}
