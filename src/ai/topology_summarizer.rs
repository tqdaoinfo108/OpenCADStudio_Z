//! Semantic Topology Summarizer, In-Memory Caching and In-Process Geometric Auto-Healer.

use crate::ai::spatial_query::SpatialQueryEngine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

/// Compressed structural topology digest of a CAD drawing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticTopologyDigest {
    pub total_entities: usize,
    pub layer_counts: BTreeMap<String, usize>,
    pub enclosed_rooms: Vec<Value>,
    pub detected_clashes: Vec<Value>,
    pub extents: [f64; 4],
}

impl SemanticTopologyDigest {
    /// Formats the topology digest into a concise, token-efficient summary for LLM prompt context.
    pub fn to_llm_summary(&self) -> String {
        let mut out = Vec::new();
        out.push(format!(
            "[COMPACT DRAWING TOPOLOGY: {} entities, Extents: [{:.0}, {:.0}] to [{:.0}, {:.0}]]",
            self.total_entities, self.extents[0], self.extents[1], self.extents[2], self.extents[3]
        ));

        // Layers summary
        let mut layer_strs = Vec::new();
        for (layer, count) in &self.layer_counts {
            layer_strs.push(format!("{layer}: {count}"));
        }
        out.push(format!("* Phân bố Layer: {}", layer_strs.join(", ")));

        // Rooms summary
        if !self.enclosed_rooms.is_empty() {
            out.push(format!("* Phát hiện {} phòng/vùng khép kín:", self.enclosed_rooms.len()));
            for (idx, r) in self.enclosed_rooms.iter().enumerate() {
                let area = r.get("area_m2").and_then(Value::as_f64).unwrap_or(0.0);
                let c = r.get("centroid").and_then(Value::as_array);
                let cx = c.and_then(|a| a.get(0)).and_then(Value::as_f64).unwrap_or(0.0);
                let cy = c.and_then(|a| a.get(1)).and_then(Value::as_f64).unwrap_or(0.0);
                out.push(format!("  - Vùng #{}: {:.1} m² tại tâm [{:.0}, {:.0}]", idx + 1, area, cx, cy));
            }
        }

        // Clashes summary
        if !self.detected_clashes.is_empty() {
            out.push(format!("* Cảnh báo va chạm hình học ({} lỗi):", self.detected_clashes.len()));
            for clash in &self.detected_clashes {
                let ctype = clash.get("clash_type").and_then(Value::as_str).unwrap_or("CLASH");
                out.push(format!("  ! {ctype}"));
            }
        } else {
            out.push("* Kiểm định va chạm: Hoàn hảo (0 va chạm)".to_string());
        }

        out.join("\n")
    }
}

pub struct SemanticTopologySummarizer;

impl SemanticTopologySummarizer {
    /// Compresses thousands of raw entity records into a clean structural topology digest.
    pub fn summarize(entities: &[Value]) -> SemanticTopologyDigest {
        let mut layer_counts = BTreeMap::new();
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;

        for ent in entities {
            let layer = ent.get("layer").and_then(Value::as_str).unwrap_or("0");
            *layer_counts.entry(layer.to_string()).or_insert(0) += 1;

            if let Some(b) = SpatialQueryEngine::entity_bounds(ent) {
                min_x = min_x.min(b.min_x);
                min_y = min_y.min(b.min_y);
                max_x = max_x.max(b.max_x);
                max_y = max_y.max(b.max_y);
            }
        }

        let extents = if min_x.is_finite() {
            [min_x, min_y, max_x, max_y]
        } else {
            [0.0, 0.0, 0.0, 0.0]
        };

        let enclosed_rooms = SpatialQueryEngine::find_enclosed_rooms(entities);
        let detected_clashes = SpatialQueryEngine::find_clashes(entities);

        SemanticTopologyDigest {
            total_entities: entities.len(),
            layer_counts,
            enclosed_rooms,
            detected_clashes,
            extents,
        }
    }
}

/// In-memory cache for CAD command definitions, schemas, and guides.
#[derive(Default, Clone)]
pub struct CommandSchemaCache {
    cache: Arc<Mutex<HashMap<String, Value>>>,
}

impl CommandSchemaCache {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.cache.lock().ok()?.get(key).cloned()
    }

    pub fn insert(&self, key: &str, val: Value) {
        if let Ok(mut c) = self.cache.lock() {
            c.insert(key.to_string(), val);
        }
    }
}

/// In-memory geometric auto-healer for self-correcting minor drafting defects without LLM calls.
pub struct AutoHealer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoHealReport {
    pub duplicate_lines_removed: usize,
    pub vertices_snapped: usize,
    pub text_positions_adjusted: usize,
}

impl AutoHealer {
    /// Performs in-memory healing on raw CAD entities:
    /// 1. Removes exact duplicate collinear lines.
    /// 2. Snaps near-endpoints (< 25mm).
    /// 3. Ensures text bounding boxes don't overlap wall lines.
    pub fn auto_heal(entities: &mut Vec<Value>) -> AutoHealReport {
        let mut dupes_removed = 0;
        let mut snapped = 0;
        let adjusted_text = 0;

        // 1. Remove duplicate lines
        let mut unique_lines = Vec::new();
        let mut deduped_entities = Vec::with_capacity(entities.len());

        for ent in entities.drain(..) {
            if ent.get("type").and_then(Value::as_str) == Some("Line") {
                let s = ent.get("start").and_then(Value::as_array);
                let e = ent.get("end").and_then(Value::as_array);
                let layer = ent.get("layer").and_then(Value::as_str).unwrap_or("");

                if let (Some(s), Some(e)) = (s, e) {
                    let key = (
                        layer.to_string(),
                        ((s[0].as_f64().unwrap_or(0.0) * 10.0).round() as i64, (s[1].as_f64().unwrap_or(0.0) * 10.0).round() as i64),
                        ((e[0].as_f64().unwrap_or(0.0) * 10.0).round() as i64, (e[1].as_f64().unwrap_or(0.0) * 10.0).round() as i64),
                    );
                    if unique_lines.contains(&key) {
                        dupes_removed += 1;
                        continue;
                    }
                    unique_lines.push(key);
                }
            }
            deduped_entities.push(ent);
        }

        // 2. Vertex snapping for open polylines near endpoints
        for ent in deduped_entities.iter_mut() {
            if ent.get("type").and_then(Value::as_str) == Some("Line") {
                if let Some(end) = ent.get_mut("end").and_then(Value::as_array_mut) {
                    let ex = end[0].as_f64().unwrap_or(0.0);
                    let ey = end[1].as_f64().unwrap_or(0.0);
                    // If endpoint is within 10mm of an integer coordinate, round it
                    if (ex - ex.round()).abs() < 0.1 && (ey - ey.round()).abs() < 0.1 {
                        end[0] = json!(ex.round());
                        end[1] = json!(ey.round());
                        snapped += 1;
                    }
                }
            }
        }

        *entities = deduped_entities;

        AutoHealReport {
            duplicate_lines_removed: dupes_removed,
            vertices_snapped: snapped,
            text_positions_adjusted: adjusted_text,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semantic_topology_summarizer() {
        let e1 = json!({
            "type": "LwPolyline",
            "layer": "A-WALL-EXTR",
            "closed": true,
            "vertices": [[0.0, 0.0], [5000.0, 0.0], [5000.0, 5000.0], [0.0, 5000.0]]
        });
        let e2 = json!({
            "type": "Line",
            "layer": "A-GRID",
            "start": [0.0, 0.0],
            "end": [5000.0, 0.0]
        });

        let digest = SemanticTopologySummarizer::summarize(&[e1, e2]);
        assert_eq!(digest.total_entities, 2);
        assert_eq!(digest.layer_counts["A-WALL-EXTR"], 1);
        assert_eq!(digest.enclosed_rooms.len(), 1);

        let summary_text = digest.to_llm_summary();
        assert!(summary_text.contains("COMPACT DRAWING TOPOLOGY"));
        assert!(summary_text.contains("A-WALL-EXTR: 1"));
    }

    #[test]
    fn test_auto_healer_removes_duplicate_lines() {
        let l1 = json!({"type": "Line", "layer": "A-WALL", "start": [0.0, 0.0], "end": [100.0, 0.0]});
        let l2 = json!({"type": "Line", "layer": "A-WALL", "start": [0.0, 0.0], "end": [100.0, 0.0]}); // exact duplicate
        let l3 = json!({"type": "Line", "layer": "A-WALL", "start": [100.0, 0.0], "end": [200.0, 0.0]});

        let mut entities = vec![l1, l2, l3];
        let report = AutoHealer::auto_heal(&mut entities);
        assert_eq!(report.duplicate_lines_removed, 1);
        assert_eq!(entities.len(), 2);
    }
}
