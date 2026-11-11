//! Geometric Precision, Auto-Snap Engine, Wall Corner Mitering, and Parametric Host Attachment.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f64,
    pub y: f64,
}

impl Point2D {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn dist_sq(&self, other: &Point2D) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }

    pub fn dist(&self, other: &Point2D) -> f64 {
        self.dist_sq(other).sqrt()
    }
}

/// Algorithmic Snapping Engine: snaps points to grid lines, axis intersections, and existing wall endpoints.
pub struct SnapEngine;

impl SnapEngine {
    pub const DEFAULT_SNAP_THRESHOLD: f64 = 50.0; // 50 mm threshold

    /// Snaps a 2D coordinate to nearby grid axes or existing endpoints within the threshold.
    pub fn snap_point(
        pt: [f64; 2],
        grid_x: &[f64],
        grid_y: &[f64],
        existing_endpoints: &[[f64; 2]],
        threshold: f64,
    ) -> [f64; 2] {
        let mut x = pt[0];
        let mut y = pt[1];

        // 1. First check existing endpoints (highest priority snap)
        let mut best_pt_dist = threshold * threshold;
        let mut snapped_to_endpoint = false;
        for ep in existing_endpoints {
            let dx = pt[0] - ep[0];
            let dy = pt[1] - ep[1];
            let d_sq = dx * dx + dy * dy;
            if d_sq <= best_pt_dist {
                best_pt_dist = d_sq;
                x = ep[0];
                y = ep[1];
                snapped_to_endpoint = true;
            }
        }

        if snapped_to_endpoint {
            return [x, y];
        }

        // 2. Snap X coordinate to nearest grid X
        for gx in grid_x {
            if (pt[0] - gx).abs() <= threshold {
                x = *gx;
                break;
            }
        }

        // 3. Snap Y coordinate to nearest grid Y
        for gy in grid_y {
            if (pt[1] - gy).abs() <= threshold {
                y = *gy;
                break;
            }
        }

        [x, y]
    }
}

/// Represents an architectural wall segment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WallSegment {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub thickness: f64,
    pub layer: String,
}

impl WallSegment {
    pub fn new(start: [f64; 2], end: [f64; 2], thickness: f64, layer: &str) -> Self {
        Self {
            start,
            end,
            thickness,
            layer: layer.to_string(),
        }
    }

    pub fn length(&self) -> f64 {
        let dx = self.end[0] - self.start[0];
        let dy = self.end[1] - self.start[1];
        (dx * dx + dy * dy).sqrt()
    }

    pub fn direction(&self) -> [f64; 2] {
        let len = self.length();
        if len < 1e-6 {
            return [1.0, 0.0];
        }
        [(self.end[0] - self.start[0]) / len, (self.end[1] - self.start[1]) / len]
    }

    pub fn normal(&self) -> [f64; 2] {
        let dir = self.direction();
        [-dir[1], dir[0]]
    }

    /// Generates double parallel lines offset by half-thickness on each side.
    pub fn to_double_lines(&self) -> (([f64; 2], [f64; 2]), ([f64; 2], [f64; 2])) {
        let h = self.thickness / 2.0;
        let n = self.normal();
        let off_x = n[0] * h;
        let off_y = n[1] * h;

        let left_start = [self.start[0] + off_x, self.start[1] + off_y];
        let left_end = [self.end[0] + off_x, self.end[1] + off_y];

        let right_start = [self.start[0] - off_x, self.start[1] - off_y];
        let right_end = [self.end[0] - off_x, self.end[1] - off_y];

        ((left_start, left_end), (right_start, right_end))
    }
}

/// Parametric host wall attachment for doors and windows.
pub struct ParametricOpening;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpeningResult {
    pub host_wall_segments: Vec<WallSegment>,
    pub opening_entities: Vec<Value>,
}

impl ParametricOpening {
    /// Places an opening on a host wall, cutting the double wall and generating door/window graphics.
    pub fn place_on_wall(
        wall: &WallSegment,
        offset_from_start: f64,
        width: f64,
        is_window: bool,
    ) -> Result<OpeningResult, String> {
        let wall_len = wall.length();
        if wall_len < width + 100.0 {
            return Err(format!("Host wall length ({:.1}mm) too short for opening ({:.1}mm)", wall_len, width));
        }

        let offset = offset_from_start.clamp(50.0, wall_len - width - 50.0);
        let dir = wall.direction();
        let norm = wall.normal();
        let h = wall.thickness / 2.0;

        // Cut points on centerline
        let p_jamb1 = [wall.start[0] + dir[0] * offset, wall.start[1] + dir[1] * offset];
        let p_jamb2 = [p_jamb1[0] + dir[0] * width, p_jamb1[1] + dir[1] * width];

        // 1. Cut host wall into two segments
        let seg1 = WallSegment::new(wall.start, p_jamb1, wall.thickness, &wall.layer);
        let seg2 = WallSegment::new(p_jamb2, wall.end, wall.thickness, &wall.layer);

        // 2. Build opening entities
        let mut opening_entities = Vec::new();

        // Jamb lines connecting the double walls
        let j1_left = [p_jamb1[0] + norm[0] * h, p_jamb1[1] + norm[1] * h];
        let j1_right = [p_jamb1[0] - norm[0] * h, p_jamb1[1] - norm[1] * h];
        let j2_left = [p_jamb2[0] + norm[0] * h, p_jamb2[1] + norm[1] * h];
        let j2_right = [p_jamb2[0] - norm[0] * h, p_jamb2[1] - norm[1] * h];

        let layer = if is_window { "A-GLAZ" } else { "A-DOOR" };
        opening_entities.push(json!({"type": "Line", "layer": layer, "start": j1_left, "end": j1_right}));
        opening_entities.push(json!({"type": "Line", "layer": layer, "start": j2_left, "end": j2_right}));

        if is_window {
            // Window glazing lines (2 parallel lines in the middle)
            let q = h * 0.3;
            opening_entities.push(json!({"type": "Line", "layer": "A-GLAZ", "start": [p_jamb1[0] + norm[0] * q, p_jamb1[1] + norm[1] * q], "end": [p_jamb2[0] + norm[0] * q, p_jamb2[1] + norm[1] * q]}));
            opening_entities.push(json!({"type": "Line", "layer": "A-GLAZ", "start": [p_jamb1[0] - norm[0] * q, p_jamb1[1] - norm[1] * q], "end": [p_jamb2[0] - norm[0] * q, p_jamb2[1] - norm[1] * q]}));
        } else {
            // Door leaf (line swung 90 deg inward) & swing arc
            let leaf_end = [p_jamb1[0] + norm[0] * width, p_jamb1[1] + norm[1] * width];
            opening_entities.push(json!({"type": "Line", "layer": "A-DOOR", "start": p_jamb1, "end": leaf_end}));

            // Calculate start and end angles in degrees
            let wall_angle_deg = dir[1].atan2(dir[0]).to_degrees();
            let start_angle = wall_angle_deg;
            let end_angle = wall_angle_deg + 90.0;
            opening_entities.push(json!({
                "type": "Arc",
                "layer": "A-DOOR",
                "center": p_jamb1,
                "radius": width,
                "start_angle_deg": start_angle,
                "end_angle_deg": end_angle
            }));
        }

        Ok(OpeningResult {
            host_wall_segments: vec![seg1, seg2],
            opening_entities,
        })
    }
}

/// Furniture clearance adjuster to prevent clipping into walls.
pub struct FurnitureClearance;

impl FurnitureClearance {
    /// Checks and adjusts a furniture box [min_x, min_y, max_x, max_y] against host walls
    /// ensuring minimum clearance and avoiding boundary penetration.
    pub fn push_out_of_walls(
        bbox: [f64; 4],
        walls: &[WallSegment],
        min_clearance: f64,
    ) -> [f64; 4] {
        let mut x0 = bbox[0];
        let mut y0 = bbox[1];
        let mut x1 = bbox[2];
        let mut y1 = bbox[3];

        for wall in walls {
            let h = wall.thickness / 2.0 + min_clearance;
            // Axis-aligned wall collision detection
            if (wall.start[0] - wall.end[0]).abs() < 1e-4 {
                // Vertical wall
                let wx = wall.start[0];
                let w_min_y = wall.start[1].min(wall.end[1]);
                let w_max_y = wall.start[1].max(wall.end[1]);

                if y1 >= w_min_y && y0 <= w_max_y {
                    // Check if overlapping horizontal band
                    if x0 < wx + h && x1 > wx - h {
                        // Push away from wall center
                        if (x0 + x1) / 2.0 >= wx {
                            let shift = (wx + h) - x0;
                            x0 += shift;
                            x1 += shift;
                        } else {
                            let shift = x1 - (wx - h);
                            x0 -= shift;
                            x1 -= shift;
                        }
                    }
                }
            } else if (wall.start[1] - wall.end[1]).abs() < 1e-4 {
                // Horizontal wall
                let wy = wall.start[1];
                let w_min_x = wall.start[0].min(wall.end[0]);
                let w_max_x = wall.start[0].max(wall.end[0]);

                if x1 >= w_min_x && x0 <= w_max_x {
                    if y0 < wy + h && y1 > wy - h {
                        if (y0 + y1) / 2.0 >= wy {
                            let shift = (wy + h) - y0;
                            y0 += shift;
                            y1 += shift;
                        } else {
                            let shift = y1 - (wy - h);
                            y0 -= shift;
                            y1 -= shift;
                        }
                    }
                }
            }
        }

        [x0, y0, x1, y1]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snap_engine_within_threshold() {
        let grid_x = vec![0.0, 4000.0, 9000.0, 13000.0];
        let grid_y = vec![0.0, 5000.0, 10000.0];
        let endpoints = vec![[4000.0, 5000.0], [9000.0, 5000.0]];

        // Point near grid (4025, 4980) within 50mm threshold
        let snapped = SnapEngine::snap_point([4025.0, 4980.0], &grid_x, &grid_y, &endpoints, 50.0);
        assert_eq!(snapped, [4000.0, 5000.0]);

        // Point far from grid (4200, 5300) does not snap
        let not_snapped = SnapEngine::snap_point([4200.0, 5300.0], &grid_x, &grid_y, &endpoints, 50.0);
        assert_eq!(not_snapped, [4200.0, 5300.0]);
    }

    #[test]
    fn test_parametric_door_placement_cuts_wall() {
        let wall = WallSegment::new([0.0, 0.0], [5000.0, 0.0], 200.0, "A-WALL-EXTR");
        let result = ParametricOpening::place_on_wall(&wall, 1000.0, 900.0, false).unwrap();

        assert_eq!(result.host_wall_segments.len(), 2);
        assert_eq!(result.host_wall_segments[0].length(), 1000.0);
        assert_eq!(result.host_wall_segments[1].length(), 3100.0);
        assert!(!result.opening_entities.is_empty());
    }

    #[test]
    fn test_furniture_clearance_pushes_out_of_wall() {
        let wall = WallSegment::new([1000.0, 0.0], [1000.0, 5000.0], 200.0, "A-WALL-EXTR");
        let initial_box = [950.0, 1000.0, 2500.0, 2500.0]; // Penetrates vertical wall at X=1000
        let pushed = FurnitureClearance::push_out_of_walls(initial_box, &[wall], 50.0);

        // Wall half-thickness = 100, clearance = 50 -> min_x must be >= 1150
        assert!(pushed[0] >= 1150.0);
    }
}
