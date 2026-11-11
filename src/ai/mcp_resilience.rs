//! MCP Resilience, Transactional Rollback, Pre-Execution Validator and Concurrency Auto-Rebase.

use serde_json::{json, Value};

/// Pre-execution command and geometry validator / sanitizer.
pub struct CommandSanitizer;

impl CommandSanitizer {
    /// Sanitizes an AutoCAD/CAD interactive command string before execution.
    /// Trims excessive whitespace, normalizes coordinate separators, and validates finite numbers.
    pub fn sanitize_command(cmd: &str) -> Option<String> {
        let trimmed = cmd.trim();
        if trimmed.is_empty() {
            return None;
        }

        // Clean up multi-space sequences while preserving tokens
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.is_empty() {
            return None;
        }

        let mut sanitized_parts = Vec::with_capacity(parts.len());
        for part in parts {
            // Check if part is a coordinate pair or triplet (e.g. "1500.0,2000.0" or "0,0,0")
            if part.contains(',') {
                let coords: Vec<&str> = part.split(',').collect();
                let all_valid = coords.iter().all(|c| {
                    c.trim().parse::<f64>().map(|v| v.is_finite()).unwrap_or(false)
                });
                if all_valid {
                    // Normalize float formatting to at most 4 decimal places
                    let norm_coords: Vec<String> = coords
                        .iter()
                        .map(|c| {
                            let val = c.trim().parse::<f64>().unwrap();
                            if (val - val.round()).abs() < 1e-4 {
                                format!("{}", val.round() as i64)
                            } else {
                                format!("{:.2}", val)
                            }
                        })
                        .collect();
                    sanitized_parts.push(norm_coords.join(","));
                    continue;
                }
            }
            sanitized_parts.push(part.to_string());
        }

        Some(sanitized_parts.join(" "))
    }

    /// Validates and sanitizes a raw entity JSON structure before creation in `entities_create`.
    /// Rejects non-finite coordinates, eliminates zero-length lines, and auto-closes polylines when appropriate.
    pub fn validate_entity_geometry(entity: &mut Value) -> Result<(), String> {
        let ent_type = entity
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing entity type".to_string())?;

        match ent_type {
            "Line" => {
                let start = entity
                    .get("start")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "Missing line start".to_string())?;
                let end = entity
                    .get("end")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "Missing line end".to_string())?;

                if start.len() < 2 || end.len() < 2 {
                    return Err("Line endpoints must have at least 2 coordinates".to_string());
                }

                let x0 = start[0].as_f64().ok_or("Non-float x0")?;
                let y0 = start[1].as_f64().ok_or("Non-float y0")?;
                let x1 = end[0].as_f64().ok_or("Non-float x1")?;
                let y1 = end[1].as_f64().ok_or("Non-float y1")?;

                if !x0.is_finite() || !y0.is_finite() || !x1.is_finite() || !y1.is_finite() {
                    return Err("Line endpoints contain non-finite numbers (NaN/Inf)".to_string());
                }

                let dx = x1 - x0;
                let dy = y1 - y0;
                let len_sq = dx * dx + dy * dy;
                if len_sq < 1e-6 {
                    return Err("Degenerate zero-length line rejected".to_string());
                }
            }
            "LwPolyline" => {
                let vertices = entity
                    .get_mut("vertices")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Missing polyline vertices".to_string())?;

                if vertices.len() < 2 {
                    return Err("Polyline must have at least 2 vertices".to_string());
                }

                // Check finite coords
                for v in vertices.iter() {
                    let arr = v.as_array().ok_or("Vertex must be coordinate array")?;
                    if arr.len() < 2 || !arr[0].as_f64().unwrap_or(f64::NAN).is_finite() || !arr[1].as_f64().unwrap_or(f64::NAN).is_finite() {
                        return Err("Polyline vertex contains non-finite coordinates".to_string());
                    }
                }

                // If first and last vertex match within epsilon, set closed: true
                let n = vertices.len();
                let v0 = vertices[0].as_array().unwrap();
                let vn = vertices[n - 1].as_array().unwrap();
                let d0x = v0[0].as_f64().unwrap() - vn[0].as_f64().unwrap();
                let d0y = v0[1].as_f64().unwrap() - vn[1].as_f64().unwrap();
                if d0x * d0x + d0y * d0y < 1e-4 && n > 2 {
                    if let Some(obj) = entity.as_object_mut() {
                        obj.insert("closed".into(), Value::Bool(true));
                    }
                }
            }
            "Circle" => {
                let radius = entity
                    .get("radius")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "Missing circle radius".to_string())?;
                if !radius.is_finite() || radius <= 0.0 {
                    return Err("Circle radius must be positive and finite".to_string());
                }
            }
            "Arc" => {
                let radius = entity
                    .get("radius")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "Missing arc radius".to_string())?;
                if !radius.is_finite() || radius <= 0.0 {
                    return Err("Arc radius must be positive and finite".to_string());
                }
            }
            _ => {}
        }

        // Auto-assign default layer if empty
        if entity.get("layer").and_then(Value::as_str).is_none() {
            if let Some(obj) = entity.as_object_mut() {
                obj.insert("layer".into(), json!("0"));
            }
        }

        Ok(())
    }
}

/// Optimistic concurrency and auto-rebase helper.
pub struct ConcurrencyRebase;

impl ConcurrencyRebase {
    /// Determines whether an incoming mutation request can be safely auto-rebased
    /// against the current document revision without risking race-condition conflicts.
    pub fn can_auto_rebase(request: &Value, active_selection_handles: &[String]) -> bool {
        let op = request.get("op").and_then(Value::as_str).unwrap_or("");

        // Read operations and system variable queries are always rebaseable
        if matches!(op, "state" | "query" | "records" | "measure" | "audit" | "sysvar") {
            return true;
        }

        // Entity creation adds new handles, never modifying existing handles: safe to auto-rebase
        if op == "entities_create" {
            return true;
        }

        // Batches that only create entities or run general commands are safe
        if op == "batch" {
            if let Some(steps) = request.get("steps").and_then(Value::as_array) {
                let only_adds_or_cmds = steps.iter().all(|s| {
                    let sop = s.get("op").and_then(Value::as_str).unwrap_or("");
                    matches!(sop, "entities_create" | "run" | "sysvar" | "block_define")
                });
                if only_adds_or_cmds {
                    return true;
                }
            }
        }

        // If mutation targets specific handles, check if any overlap with the user's active selection
        if let Some(handles) = request.get("handles").and_then(Value::as_array) {
            let target_handles: Vec<&str> = handles.iter().filter_map(Value::as_str).collect();
            let has_conflict = target_handles
                .iter()
                .any(|h| active_selection_handles.iter().any(|sel| sel.eq_ignore_ascii_case(h)));
            return !has_conflict;
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_command_formatting() {
        let raw = "   PLINE   0.00000,0.00000    15000.12345,0.00000    15000,24000    C   ";
        let sanitized = CommandSanitizer::sanitize_command(raw).unwrap();
        assert_eq!(sanitized, "PLINE 0,0 15000.12,0 15000,24000 C");
    }

    #[test]
    fn test_validate_entity_geometry_rejects_nan_and_zero_len() {
        let mut zero_line = json!({
            "type": "Line",
            "start": [100.0, 200.0],
            "end": [100.0, 200.0]
        });
        assert!(CommandSanitizer::validate_entity_geometry(&mut zero_line).is_err());

        let mut nan_line = json!({
            "type": "Line",
            "start": [f64::NAN, 200.0],
            "end": [500.0, 200.0]
        });
        assert!(CommandSanitizer::validate_entity_geometry(&mut nan_line).is_err());

        let mut valid_line = json!({
            "type": "Line",
            "start": [0.0, 0.0],
            "end": [5000.0, 0.0]
        });
        assert!(CommandSanitizer::validate_entity_geometry(&mut valid_line).is_ok());
        assert_eq!(valid_line["layer"], "0"); // Auto layer assignment
    }

    #[test]
    fn test_concurrency_auto_rebase_rules() {
        let create_req = json!({
            "op": "entities_create",
            "entities": [{"type": "Line", "start": [0,0], "end": [10,10]}]
        });
        assert!(ConcurrencyRebase::can_auto_rebase(&create_req, &[]));

        let delete_req = json!({
            "op": "entities_delete",
            "handles": ["2A", "2B"]
        });
        assert!(ConcurrencyRebase::can_auto_rebase(&delete_req, &["3C".to_string()]));
        assert!(!ConcurrencyRebase::can_auto_rebase(&delete_req, &["2A".to_string()]));
    }
}
