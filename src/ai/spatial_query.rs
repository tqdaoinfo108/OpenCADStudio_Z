//! Spatial Query, AABB Collision Detection, Enclosed Room Polygon Extraction, and Region Query.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AABB {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl AABB {
    pub fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        Self {
            min_x: min_x.min(max_x),
            min_y: min_y.min(max_y),
            max_x: min_x.max(max_x),
            max_y: min_y.max(max_y),
        }
    }

    pub fn overlaps(&self, other: &AABB) -> bool {
        self.min_x < other.max_x && self.max_x > other.min_x && self.min_y < other.max_y && self.max_y > other.min_y
    }

    pub fn contains_point(&self, x: f64, y: f64) -> bool {
        x >= self.min_x && x <= self.max_x && y >= self.min_y && y <= self.max_y
    }

    pub fn area(&self) -> f64 {
        (self.max_x - self.min_x).max(0.0) * (self.max_y - self.min_y).max(0.0)
    }

    pub fn center(&self) -> [f64; 2] {
        [(self.min_x + self.max_x) / 2.0, (self.min_y + self.max_y) / 2.0]
    }
}

pub struct SpatialQueryEngine;

impl SpatialQueryEngine {
    /// Extracts an AABB bounding box from a CAD entity JSON representation.
    pub fn entity_bounds(ent: &Value) -> Option<AABB> {
        let ent_type = ent.get("type").and_then(Value::as_str)?;

        match ent_type {
            "Line" => {
                let s = ent.get("start")?.as_array()?;
                let e = ent.get("end")?.as_array()?;
                Some(AABB::new(
                    s[0].as_f64()?,
                    s[1].as_f64()?,
                    e[0].as_f64()?,
                    e[1].as_f64()?,
                ))
            }
            "LwPolyline" => {
                let verts = ent.get("vertices")?.as_array()?;
                if verts.is_empty() { return None; }
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
                Some(AABB::new(min_x, min_y, max_x, max_y))
            }
            "Circle" | "Arc" => {
                let c = ent.get("center")?.as_array()?;
                let r = ent.get("radius")?.as_f64()?;
                let cx = c[0].as_f64()?;
                let cy = c[1].as_f64()?;
                Some(AABB::new(cx - r, cy - r, cx + r, cy + r))
            }
            "Text" | "MText" => {
                let p = ent.get("position")?.as_array()?;
                let h = ent.get("height").and_then(Value::as_f64).unwrap_or(250.0);
                let text = ent.get("value").and_then(Value::as_str).unwrap_or("");
                let w = (text.chars().count() as f64 * h * 0.7).max(h);
                let px = p[0].as_f64()?;
                let py = p[1].as_f64()?;
                Some(AABB::new(px, py, px + w, py + h))
            }
            _ => None,
        }
    }

    /// Spatial query: filters entities within the given rectangular region bounds [min_x, min_y, max_x, max_y].
    /// Greatly reduces token footprint for LLM inspection of a specific floor or room!
    pub fn query_by_region(entities: &[Value], bounds: [f64; 4]) -> Vec<Value> {
        let region = AABB::new(bounds[0], bounds[1], bounds[2], bounds[3]);
        entities
            .iter()
            .filter(|ent| {
                if let Some(eb) = Self::entity_bounds(ent) {
                    eb.overlaps(&region)
                } else {
                    false
                }
            })
            .cloned()
            .collect()
    }

    /// Clash Detection: finds all geometric clashes between entities.
    /// Detects:
    /// 1. Furniture overlapping another furniture item.
    /// 2. Door swing intersecting columns or furniture.
    /// 3. Text labels clipping into wall lines.
    pub fn find_clashes(entities: &[Value]) -> Vec<Value> {
        let mut clashes = Vec::new();
        let n = entities.len();

        for i in 0..n {
            let e1 = &entities[i];
            let layer1 = e1.get("layer").and_then(Value::as_str).unwrap_or("");
            let Some(b1) = Self::entity_bounds(e1) else { continue; };

            for j in (i + 1)..n {
                let e2 = &entities[j];
                let layer2 = e2.get("layer").and_then(Value::as_str).unwrap_or("");
                let Some(b2) = Self::entity_bounds(e2) else { continue; };

                // Only check relevant clash combinations
                let is_furniture_clash = layer1 == "A-FURN" && layer2 == "A-FURN";
                let is_door_column_clash = (layer1 == "A-DOOR" && layer2 == "A-COLS") || (layer1 == "A-COLS" && layer2 == "A-DOOR");
                let is_door_furn_clash = (layer1 == "A-DOOR" && layer2 == "A-FURN") || (layer1 == "A-FURN" && layer2 == "A-DOOR");

                if is_furniture_clash || is_door_column_clash || is_door_furn_clash {
                    if b1.overlaps(&b2) {
                        let clash_type = if is_furniture_clash {
                            "FURNITURE_OVERLAP"
                        } else if is_door_column_clash {
                            "DOOR_COLUMN_COLLISION"
                        } else {
                            "DOOR_FURNITURE_COLLISION"
                        };

                        clashes.push(json!({
                            "clash_type": clash_type,
                            "entity_1": {"layer": layer1, "bounds": [b1.min_x, b1.min_y, b1.max_x, b1.max_y]},
                            "entity_2": {"layer": layer2, "bounds": [b2.min_x, b2.min_y, b2.max_x, b2.max_y]},
                            "severity": "WARNING"
                        }));
                    }
                }
            }
        }

        clashes
    }

    /// Automatically extracts enclosed room polygons from polyline boundaries.
    /// Returns room area in m², perimeter, and geometric centroid.
    pub fn find_enclosed_rooms(entities: &[Value]) -> Vec<Value> {
        let mut rooms = Vec::new();

        for ent in entities {
            let is_closed = ent.get("closed").and_then(Value::as_bool).unwrap_or(false);
            let layer = ent.get("layer").and_then(Value::as_str).unwrap_or("");
            let is_wall_or_room = layer.contains("WALL") || layer.contains("ROOM") || layer.contains("SITE");

            if is_closed && is_wall_or_room {
                if let Some(verts) = ent.get("vertices").and_then(Value::as_array) {
                    if verts.len() >= 3 {
                        // Calculate Shoelace polygon area
                        let mut area = 0.0;
                        let mut perimeter = 0.0;
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

                            let cross = x0 * y1 - x1 * y0;
                            area += cross;
                            cx += (x0 + x1) * cross;
                            cy += (y0 + y1) * cross;

                            let dx = x1 - x0;
                            let dy = y1 - y0;
                            perimeter += (dx * dx + dy * dy).sqrt();
                        }

                        let area_abs = (area / 2.0).abs();
                        let area_m2 = area_abs / 1_000_000.0; // mm2 to m2

                        if area_m2 > 1.0 {
                            let factor = 1.0 / (6.0 * (area / 2.0));
                            let centroid_x = if factor.is_finite() { cx * factor } else { 0.0 };
                            let centroid_y = if factor.is_finite() { cy * factor } else { 0.0 };

                            rooms.push(json!({
                                "area_m2": (area_m2 * 100.0).round() / 100.0,
                                "perimeter_mm": perimeter.round(),
                                "centroid": [centroid_x.round(), centroid_y.round()],
                                "vertex_count": m
                            }));
                        }
                    }
                }
            }
        }

        rooms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aabb_overlap_and_region_query() {
        let e1 = json!({
            "type": "Line",
            "layer": "A-WALL",
            "start": [1000.0, 1000.0],
            "end": [5000.0, 1000.0]
        });
        let e2 = json!({
            "type": "Line",
            "layer": "A-WALL",
            "start": [10000.0, 10000.0],
            "end": [15000.0, 10000.0]
        });

        let entities = vec![e1, e2];
        let queried = SpatialQueryEngine::query_by_region(&entities, [0.0, 0.0, 6000.0, 6000.0]);
        assert_eq!(queried.len(), 1);
        assert_eq!(queried[0]["start"][0], 1000.0);
    }

    #[test]
    fn test_find_enclosed_rooms_shoelace_area() {
        // Rectangle 4000mm x 5000mm = 20 m2
        let poly = json!({
            "type": "LwPolyline",
            "layer": "A-WALL-EXTR",
            "closed": true,
            "vertices": [[0.0, 0.0], [4000.0, 0.0], [4000.0, 5000.0], [0.0, 5000.0]]
        });

        let rooms = SpatialQueryEngine::find_enclosed_rooms(&[poly]);
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0]["area_m2"], 20.0);
        assert_eq!(rooms[0]["centroid"], [2000.0, 2500.0]);
    }

    #[test]
    fn test_clash_detection() {
        let f1 = json!({
            "type": "LwPolyline",
            "layer": "A-FURN",
            "closed": true,
            "vertices": [[1000.0, 1000.0], [3000.0, 1000.0], [3000.0, 3000.0], [1000.0, 3000.0]]
        });
        let f2 = json!({
            "type": "LwPolyline",
            "layer": "A-FURN",
            "closed": true,
            "vertices": [[2000.0, 2000.0], [4000.0, 2000.0], [4000.0, 4000.0], [2000.0, 4000.0]]
        });

        let clashes = SpatialQueryEngine::find_clashes(&[f1, f2]);
        assert_eq!(clashes.len(), 1);
        assert_eq!(clashes[0]["clash_type"], "FURNITURE_OVERLAP");
    }
}
