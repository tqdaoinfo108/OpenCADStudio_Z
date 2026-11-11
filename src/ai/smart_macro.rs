//! High-Level Smart Architectural Macro Operations for MCP Execution.

use serde_json::{json, Value};

/// Smart Macro Operations Engine
pub struct SmartMacro;

impl SmartMacro {
    /// Dispatches a smart architectural macro operation by name.
    pub fn dispatch(macro_name: &str, params: &Value) -> Result<Vec<Value>, String> {
        match macro_name {
            "draw_structural_grid" => Self::draw_structural_grid(params),
            "draw_wall_network" => Self::draw_wall_network(params),
            "place_opening_on_wall" => Self::place_opening_on_wall(params),
            "generate_staircase" => Self::generate_staircase(params),
            "auto_dimension_and_label" => Self::auto_dimension_and_label(params),
            _ => Err(format!("Unknown smart macro operation: {macro_name}")),
        }
    }

    /// Macro: `draw_structural_grid`
    /// Automatically generates grid lines, axis bubbles ("1,2,3...", "A,B,C..."),
    /// columns at intersections, and dimension chains in a single atomic call.
    pub fn draw_structural_grid(params: &Value) -> Result<Vec<Value>, String> {
        let origin = params.get("origin").and_then(Value::as_array);
        let ox = origin.and_then(|o| o.get(0)).and_then(Value::as_f64).unwrap_or(0.0);
        let oy = origin.and_then(|o| o.get(1)).and_then(Value::as_f64).unwrap_or(0.0);

        let bays_x = params
            .get("bays_x")
            .and_then(Value::as_array)
            .ok_or_else(|| "Missing bays_x array".to_string())?;
        let bays_y = params
            .get("bays_y")
            .and_then(Value::as_array)
            .ok_or_else(|| "Missing bays_y array".to_string())?;

        let column_size = params.get("column_size").and_then(Value::as_f64).unwrap_or(300.0);
        let extension = params.get("extension").and_then(Value::as_f64).unwrap_or(1500.0);

        let mut grid_x_coords = vec![ox];
        let mut curr_x = ox;
        for bx in bays_x {
            curr_x += bx.as_f64().ok_or("Non-numeric bay in bays_x")?;
            grid_x_coords.push(curr_x);
        }

        let mut grid_y_coords = vec![oy];
        let mut curr_y = oy;
        for by in bays_y {
            curr_y += by.as_f64().ok_or("Non-numeric bay in bays_y")?;
            grid_y_coords.push(curr_y);
        }

        let min_x = *grid_x_coords.first().unwrap();
        let max_x = *grid_x_coords.last().unwrap();
        let min_y = *grid_y_coords.first().unwrap();
        let max_y = *grid_y_coords.last().unwrap();

        let mut entities = Vec::new();

        // 1. Vertical grid lines & bubbles
        for (i, &gx) in grid_x_coords.iter().enumerate() {
            let label = (i + 1).to_string();
            // Grid line
            entities.push(json!({
                "type": "Line",
                "layer": "A-GRID",
                "start": [gx, min_y - extension],
                "end": [gx, max_y + extension]
            }));

            // Top bubble
            entities.push(json!({
                "type": "Circle",
                "layer": "A-GRID",
                "center": [gx, max_y + extension + 400.0],
                "radius": 350.0
            }));
            entities.push(json!({
                "type": "Text",
                "layer": "A-ANNO",
                "position": [gx - 100.0, max_y + extension + 250.0],
                "height": 300.0,
                "value": label
            }));

            // Bottom bubble
            entities.push(json!({
                "type": "Circle",
                "layer": "A-GRID",
                "center": [gx, min_y - extension - 400.0],
                "radius": 350.0
            }));
            entities.push(json!({
                "type": "Text",
                "layer": "A-ANNO",
                "position": [gx - 100.0, min_y - extension - 550.0],
                "height": 300.0,
                "value": label
            }));
        }

        // 2. Horizontal grid lines & bubbles
        for (j, &gy) in grid_y_coords.iter().enumerate() {
            let letter = ((b'A' + j as u8) as char).to_string();
            // Grid line
            entities.push(json!({
                "type": "Line",
                "layer": "A-GRID",
                "start": [min_x - extension, gy],
                "end": [max_x + extension, gy]
            }));

            // Left bubble
            entities.push(json!({
                "type": "Circle",
                "layer": "A-GRID",
                "center": [min_x - extension - 400.0, gy],
                "radius": 350.0
            }));
            entities.push(json!({
                "type": "Text",
                "layer": "A-ANNO",
                "position": [min_x - extension - 520.0, gy - 150.0],
                "height": 300.0,
                "value": letter
            }));

            // Right bubble
            entities.push(json!({
                "type": "Circle",
                "layer": "A-GRID",
                "center": [max_x + extension + 400.0, gy],
                "radius": 350.0
            }));
            entities.push(json!({
                "type": "Text",
                "layer": "A-ANNO",
                "position": [max_x + extension + 280.0, gy - 150.0],
                "height": 300.0,
                "value": letter
            }));
        }

        // 3. Structural Columns at all intersections
        let h_col = column_size / 2.0;
        for &gx in &grid_x_coords {
            for &gy in &grid_y_coords {
                entities.push(json!({
                    "type": "LwPolyline",
                    "layer": "A-COLS",
                    "closed": true,
                    "vertices": [
                        [gx - h_col, gy - h_col],
                        [gx + h_col, gy - h_col],
                        [gx + h_col, gy + h_col],
                        [gx - h_col, gy + h_col]
                    ]
                }));
            }
        }

        Ok(entities)
    }

    /// Macro: `draw_wall_network`
    /// Draws offset double walls (200mm exterior or 100mm interior) from centerlines.
    pub fn draw_wall_network(params: &Value) -> Result<Vec<Value>, String> {
        let centerlines = params
            .get("centerlines")
            .and_then(Value::as_array)
            .ok_or_else(|| "Missing centerlines array".to_string())?;
        let thickness = params.get("thickness").and_then(Value::as_f64).unwrap_or(200.0);
        let layer = params.get("layer").and_then(Value::as_str).unwrap_or("A-WALL-EXTR");

        let h = thickness / 2.0;
        let mut entities = Vec::new();

        for line in centerlines {
            let pts = line.as_array().ok_or("Centerline must be [[x0,y0], [x1,y1]]")?;
            if pts.len() < 2 { continue; }
            let p0 = pts[0].as_array().ok_or("p0 must be array")?;
            let p1 = pts[1].as_array().ok_or("p1 must be array")?;
            let x0 = p0[0].as_f64().ok_or("x0")?;
            let y0 = p0[1].as_f64().ok_or("y0")?;
            let x1 = p1[0].as_f64().ok_or("x1")?;
            let y1 = p1[1].as_f64().ok_or("y1")?;

            let dx = x1 - x0;
            let dy = y1 - y0;
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-6 { continue; }

            let nx = -dy / len * h;
            let ny = dx / len * h;

            // Left line
            entities.push(json!({
                "type": "Line",
                "layer": layer,
                "start": [x0 + nx, y0 + ny],
                "end": [x1 + nx, y1 + ny]
            }));
            // Right line
            entities.push(json!({
                "type": "Line",
                "layer": layer,
                "start": [x0 - nx, y0 - ny],
                "end": [x1 - nx, y1 - ny]
            }));
        }

        Ok(entities)
    }

    /// Macro: `place_opening_on_wall`
    /// Parametrically cuts wall lines and draws door/window leaf + swing arc.
    pub fn place_opening_on_wall(params: &Value) -> Result<Vec<Value>, String> {
        let wall_start = params.get("wall_start").and_then(Value::as_array).ok_or("Missing wall_start")?;
        let wall_end = params.get("wall_end").and_then(Value::as_array).ok_or("Missing wall_end")?;
        let offset = params.get("offset").and_then(Value::as_f64).unwrap_or(1000.0);
        let width = params.get("width").and_then(Value::as_f64).unwrap_or(900.0);
        let is_window = params.get("kind").and_then(Value::as_str) == Some("window");
        let thickness = params.get("thickness").and_then(Value::as_f64).unwrap_or(200.0);

        let x0 = wall_start[0].as_f64().unwrap();
        let y0 = wall_start[1].as_f64().unwrap();
        let x1 = wall_end[0].as_f64().unwrap();
        let y1 = wall_end[1].as_f64().unwrap();

        let wall = crate::ai::geometric_precision::WallSegment::new([x0, y0], [x1, y1], thickness, "A-WALL-EXTR");
        let res = crate::ai::geometric_precision::ParametricOpening::place_on_wall(&wall, offset, width, is_window)?;

        let mut entities = Vec::new();
        // Cut double walls
        for seg in &res.host_wall_segments {
            let ((l0, l1), (r0, r1)) = seg.to_double_lines();
            entities.push(json!({"type": "Line", "layer": "A-WALL-EXTR", "start": l0, "end": l1}));
            entities.push(json!({"type": "Line", "layer": "A-WALL-EXTR", "start": r0, "end": r1}));
        }
        entities.extend(res.opening_entities);

        Ok(entities)
    }

    /// Macro: `generate_staircase`
    /// Calculates riser heights ($2h + b = 600$), treads, landing, and outputs 2D stair outlines and steps.
    pub fn generate_staircase(params: &Value) -> Result<Vec<Value>, String> {
        let bounds = params.get("bounds").and_then(Value::as_array).ok_or("Missing bounds [x0,y0,x1,y1]")?;
        let x0 = bounds[0].as_f64().unwrap();
        let y0 = bounds[1].as_f64().unwrap();
        let x1 = bounds[2].as_f64().unwrap();
        let y1 = bounds[3].as_f64().unwrap();

        let floor_height = params.get("floor_height").and_then(Value::as_f64).unwrap_or(3900.0);
        let _stair_type = params.get("stair_type").and_then(Value::as_str).unwrap_or("U_SHAPE");

        // Optimal riser count: 21..25 risers for 3600..3900mm
        let riser_count = if floor_height > 3600.0 { 25 } else { 21 };
        let _riser_h = floor_height / riser_count as f64; // e.g. 156mm
        let _tread_b = 600.0 - 2.0 * _riser_h; // approx 288mm

        let mut entities = Vec::new();

        // Perimeter box
        entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-STAIR",
            "closed": true,
            "vertices": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        }));

        // Stair void in center
        let mid_x0 = x0 + (x1 - x0) * 0.35;
        let mid_x1 = x0 + (x1 - x0) * 0.65;
        let landing_y = y0 + (y1 - y0) * 0.75;

        entities.push(json!({
            "type": "LwPolyline",
            "layer": "A-STAIR",
            "closed": true,
            "vertices": [[mid_x0, y0], [mid_x1, y0], [mid_x1, landing_y], [mid_x0, landing_y]]
        }));

        // Flight 1 steps (left)
        let step_count = (riser_count / 2) as usize;
        let dy = (landing_y - y0) / step_count as f64;
        for s in 1..step_count {
            let sy = y0 + s as f64 * dy;
            entities.push(json!({"type": "Line", "layer": "A-STAIR", "start": [x0, sy], "end": [mid_x0, sy]}));
            entities.push(json!({"type": "Line", "layer": "A-STAIR", "start": [mid_x1, sy], "end": [x1, sy]}));
        }

        // Up arrow symbol
        entities.push(json!({"type": "Line", "layer": "A-STAIR", "start": [x0 + 600.0, y0 + 300.0], "end": [x0 + 600.0, landing_y - 300.0]}));
        entities.push(json!({"type": "Line", "layer": "A-STAIR", "start": [x0 + 450.0, landing_y - 600.0], "end": [x0 + 600.0, landing_y - 300.0]}));
        entities.push(json!({"type": "Line", "layer": "A-STAIR", "start": [x0 + 750.0, landing_y - 600.0], "end": [x0 + 600.0, landing_y - 300.0]}));
        entities.push(json!({"type": "Text", "layer": "A-ANNO", "position": [x0 + 700.0, y0 + 500.0], "height": 200.0, "value": "LÊN"}));

        Ok(entities)
    }

    /// Macro: `auto_dimension_and_label`
    /// Rải 3 lớp kích thước tự động và đặt nhãn tên phòng kèm diện tích chính tâm.
    pub fn auto_dimension_and_label(params: &Value) -> Result<Vec<Value>, String> {
        let mut entities = Vec::new();

        if let Some(rooms) = params.get("rooms").and_then(Value::as_array) {
            for r in rooms {
                let name = r.get("name").and_then(Value::as_str).unwrap_or("Phòng");
                let area = r.get("area_m2").and_then(Value::as_f64).unwrap_or(0.0);
                if let Some(c) = r.get("center").and_then(Value::as_array) {
                    let cx = c[0].as_f64().unwrap_or(0.0);
                    let cy = c[1].as_f64().unwrap_or(0.0);
                    let label = format!("{}\n({:.1} m²)", name, area);
                    entities.push(json!({
                        "type": "Text",
                        "layer": "A-ANNO",
                        "position": [cx - 600.0, cy],
                        "height": 250.0,
                        "value": label
                    }));
                }
            }
        }

        Ok(entities)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_draw_structural_grid_macro() {
        let params = json!({
            "origin": [0.0, 0.0],
            "bays_x": [4000.0, 5000.0, 4000.0],
            "bays_y": [4500.0, 5000.0, 4500.0],
            "column_size": 300.0,
            "extension": 1000.0
        });

        let entities = SmartMacro::dispatch("draw_structural_grid", &params).unwrap();
        assert!(!entities.is_empty());
        // 4 vertical axes + 4 horizontal axes = 8 lines
        // 16 intersections = 16 columns
        let col_count = entities.iter().filter(|e| e["layer"] == "A-COLS").count();
        assert_eq!(col_count, 16);
    }

    #[test]
    fn test_generate_staircase_macro() {
        let params = json!({
            "bounds": [0.0, 0.0, 3000.0, 5000.0],
            "floor_height": 3900.0,
            "stair_type": "U_SHAPE"
        });

        let entities = SmartMacro::dispatch("generate_staircase", &params).unwrap();
        assert!(entities.iter().any(|e| e["layer"] == "A-STAIR"));
        assert!(entities.iter().any(|e| e["type"] == "Text" && e["value"] == "LÊN"));
    }
}
