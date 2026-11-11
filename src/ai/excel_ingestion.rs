//! Native Excel (.xlsx, .xls, .csv) Multimodal Ingestion Engine for OpenCADStudio.
//!
//! Provides:
//! 1. Multi-sheet structural reading via `calamine`.
//! 2. AEC semantic extraction (Room schedules, Grid & Level specs, Door/Window schedules, Furniture).
//! 3. Excel-to-CAD diff & reconciliation against live drawing records.

use calamine::{open_workbook_auto, open_workbook_auto_from_rs, Data, Reader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Cursor,
    path::Path,
};

/// Strongly typed cell representation across all sheets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CellValue {
    Empty,
    String(String),
    Float(f64),
    Int(i64),
    Bool(bool),
}

impl CellValue {
    pub fn to_display_string(&self) -> String {
        match self {
            CellValue::Empty => String::new(),
            CellValue::String(s) => s.clone(),
            CellValue::Float(f) => format!("{f:.2}"),
            CellValue::Int(i) => i.to_string(),
            CellValue::Bool(b) => b.to_string(),
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            CellValue::Float(f) => Some(*f),
            CellValue::Int(i) => Some(*i as f64),
            CellValue::String(s) => {
                let cleaned = s.replace(',', ".").replace("mm", "").replace("m2", "").replace("m²", "").replace("m", "").trim().to_string();
                cleaned.parse::<f64>().ok()
            }
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            CellValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn is_empty(&self) -> bool {
        match self {
            CellValue::Empty => true,
            CellValue::String(s) => s.trim().is_empty(),
            _ => false,
        }
    }
}

/// Raw sheet representation preserving structure, headers, and rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSheet {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<CellValue>>,
    pub total_rows: usize,
    pub total_cols: usize,
}

/// Raw workbook containing all parsed sheets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawWorkbook {
    pub file_name: String,
    pub sheets: Vec<RawSheet>,
    pub sheet_count: usize,
    pub total_rows: usize,
}

impl RawWorkbook {
    pub fn summary(&self) -> String {
        let mut lines = Vec::new();
        lines.push(format!("Workbook '{}' contains {} sheet(s):", self.file_name, self.sheet_count));
        for sheet in &self.sheets {
            lines.push(format!(
                "- Sheet '{}': {} rows, {} cols; Headers: [{}]",
                sheet.name,
                sheet.total_rows,
                sheet.total_cols,
                sheet.headers.join(", ")
            ));
        }
        lines.join("\n")
    }
}

/// Reads an Excel/CSV file from disk into a [`RawWorkbook`].
pub fn read_excel_file(path: &Path) -> Result<RawWorkbook, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "csv" {
        return read_csv_file(path);
    }
    match open_workbook_auto(path) {
        Ok(mut workbook) => extract_from_reader(
            &mut workbook,
            path.file_name().and_then(|n| n.to_str()).unwrap_or("document.xlsx"),
        ),
        Err(e) => read_csv_file(path)
            .map_err(|_| format!("Failed to open workbook at {}: {e}", path.display())),
    }
}

/// Reads an Excel/CSV file from in-memory bytes into a [`RawWorkbook`].
pub fn read_excel_bytes(bytes: &[u8], file_name: &str) -> Result<RawWorkbook, String> {
    let cursor = Cursor::new(bytes);
    match open_workbook_auto_from_rs(cursor) {
        Ok(mut workbook) => extract_from_reader(&mut workbook, file_name),
        Err(e) => {
            if let Ok(text) = std::str::from_utf8(bytes) {
                read_csv_str(text, file_name)
            } else {
                Err(format!("Failed to parse workbook bytes for '{file_name}': {e}"))
            }
        }
    }
}

pub fn read_csv_file(path: &Path) -> Result<RawWorkbook, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read CSV at {}: {e}", path.display()))?;
    read_csv_str(
        &content,
        path.file_name().and_then(|n| n.to_str()).unwrap_or("document.csv"),
    )
}

pub fn read_csv_str(content: &str, file_name: &str) -> Result<RawWorkbook, String> {
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Ok(RawWorkbook {
            file_name: file_name.to_string(),
            sheets: Vec::new(),
            sheet_count: 0,
            total_rows: 0,
        });
    }

    let first = lines[0];
    let delimiter = if first.contains('\t') {
        '\t'
    } else if first.contains(';') && !first.contains(',') {
        ';'
    } else {
        ','
    };

    let mut rows = Vec::new();
    let mut headers = Vec::new();
    let mut total_cols = 0;

    for (row_idx, line) in lines.iter().enumerate() {
        let parts: Vec<&str> = line.split(delimiter).map(|s| s.trim()).collect();
        total_cols = total_cols.max(parts.len());
        if row_idx == 0 {
            headers = parts.iter().map(|s| s.to_string()).collect();
        } else {
            let mut row_cells = Vec::new();
            for &val in &parts {
                let cell = if let Ok(num) = val.parse::<f64>() {
                    CellValue::Float(num)
                } else if let Ok(int_val) = val.parse::<i64>() {
                    CellValue::Int(int_val)
                } else if val.eq_ignore_ascii_case("true") {
                    CellValue::Bool(true)
                } else if val.eq_ignore_ascii_case("false") {
                    CellValue::Bool(false)
                } else if val.is_empty() {
                    CellValue::Empty
                } else {
                    CellValue::String(val.to_string())
                };
                row_cells.push(cell);
            }
            rows.push(row_cells);
        }
    }

    let total_rows = rows.len();
    let sheet = RawSheet {
        name: "Sheet1".to_string(),
        headers,
        rows,
        total_rows,
        total_cols,
    };

    Ok(RawWorkbook {
        file_name: file_name.to_string(),
        sheets: vec![sheet],
        sheet_count: 1,
        total_rows,
    })
}

pub fn extract_from_reader<RS, R>(workbook: &mut R, file_name: &str) -> Result<RawWorkbook, String>
where
    RS: std::io::Read + std::io::Seek,
    R: Reader<RS>,
{
    let sheet_names = workbook.sheet_names().to_vec();
    let mut sheets = Vec::new();
    let mut total_all_rows = 0;

    for name in sheet_names {
        if let Ok(range) = workbook.worksheet_range(&name) {
            let height = range.height();
            let width = range.width();
            if height == 0 || width == 0 {
                continue;
            }

            // Find header row: look for row with most non-empty string cells
            let mut header_row_idx = 0;
            for r in 0..height.min(5) {
                let string_count = (0..width)
                    .filter(|&c| {
                        range.get((r, c))
                            .map(|cell| matches!(cell, Data::String(_)))
                            .unwrap_or(false)
                    })
                    .count();
                if string_count >= 2 {
                    header_row_idx = r;
                    break;
                }
            }

            let mut headers = Vec::new();
            for c in 0..width {
                if let Some(cell) = range.get((header_row_idx, c)) {
                    let h = cell_to_string(cell).trim().to_string();
                    if h.is_empty() {
                        headers.push(format!("Col_{c}"));
                    } else {
                        headers.push(h);
                    }
                } else {
                    headers.push(format!("Col_{c}"));
                }
            }

            let mut data_rows = Vec::new();
            for r in (header_row_idx + 1)..height {
                let mut row = Vec::new();
                let mut is_all_empty = true;
                for c in 0..width {
                    let val = match range.get((r, c)) {
                        Some(Data::Empty) | None => CellValue::Empty,
                        Some(Data::String(s)) => {
                            if !s.trim().is_empty() {
                                is_all_empty = false;
                            }
                            CellValue::String(s.trim().to_string())
                        }
                        Some(Data::Float(f)) => {
                            is_all_empty = false;
                            CellValue::Float(*f)
                        }
                        Some(Data::Int(i)) => {
                            is_all_empty = false;
                            CellValue::Int(*i)
                        }
                        Some(Data::Bool(b)) => {
                            is_all_empty = false;
                            CellValue::Bool(*b)
                        }
                        Some(Data::DateTime(dt)) => {
                            is_all_empty = false;
                            CellValue::Float(dt.as_f64())
                        }
                        Some(Data::DateTimeIso(iso)) => {
                            is_all_empty = false;
                            CellValue::String(iso.clone())
                        }
                        Some(Data::DurationIso(iso)) => {
                            is_all_empty = false;
                            CellValue::String(iso.clone())
                        }
                        Some(Data::Error(e)) => {
                            CellValue::String(format!("Error: {e:?}"))
                        }
                    };
                    row.push(val);
                }
                if !is_all_empty {
                    data_rows.push(row);
                }
            }

            total_all_rows += data_rows.len();
            sheets.push(RawSheet {
                name,
                headers,
                total_rows: data_rows.len(),
                total_cols: width,
                rows: data_rows,
            });
        }
    }

    Ok(RawWorkbook {
        file_name: file_name.to_string(),
        sheet_count: sheets.len(),
        total_rows: total_all_rows,
        sheets,
    })
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::String(s) => s.clone(),
        Data::Float(f) => format!("{f}"),
        Data::Int(i) => format!("{i}"),
        Data::Bool(b) => format!("{b}"),
        Data::DateTime(d) => format!("{}", d.as_f64()),
        Data::DateTimeIso(s) => s.clone(),
        _ => String::new(),
    }
}

pub fn parse_raw_workbook(path: &Path) -> Result<RawWorkbook, String> {
    read_excel_file(path)
}

pub fn parse_raw_workbook_from_bytes(bytes: &[u8], name: &str) -> Result<RawWorkbook, String> {
    let cursor = Cursor::new(bytes);
    let mut workbook = open_workbook_auto_from_rs(cursor)
        .map_err(|e| format!("Failed to parse workbook bytes: {e}"))?;
    extract_from_reader(&mut workbook, name)
}

// =========================================================================
// SECTION 2: AEC SEMANTIC EXTRACTOR
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AecSiteSpec {
    pub width_mm: f64,
    pub depth_mm: f64,
    pub setback_front_mm: f64,
    pub setback_rear_mm: f64,
    pub setback_left_mm: f64,
    pub setback_right_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridAxis {
    pub tag: String,
    pub position_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AecGridSpec {
    pub x_axes: Vec<GridAxis>,
    pub y_axes: Vec<GridAxis>,
    pub bay_x_mm: Vec<f64>,
    pub bay_y_mm: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AecLevelSpec {
    pub index: usize,
    pub name: String,
    pub elevation_z_mm: f64,
    pub floor_height_mm: f64,
    pub clear_height_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AecRoomSpec {
    pub id: String,
    pub name: String,
    pub level_name: String,
    pub level_index: usize,
    pub target_area_m2: f64,
    pub width_mm: Option<f64>,
    pub length_mm: Option<f64>,
    pub is_wet: bool,
    pub function_category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AecOpeningSpec {
    pub tag: String,
    pub kind: String, // "door", "window", "sliding_door"
    pub width_mm: f64,
    pub height_mm: f64,
    pub sill_mm: f64,
    pub room_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AecFurnitureSpec {
    pub room_name: String,
    pub item_name: String,
    pub kind: String, // "bed", "sofa", "table", "toilet", "sink", "altar", etc.
    pub width_mm: f64,
    pub length_mm: f64,
    pub clearance_mm: f64,
}

/// Consolidated AEC Architectural Project Program extracted from Excel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AecProjectProgram {
    pub project_title: String,
    pub site: Option<AecSiteSpec>,
    pub grid: Option<AecGridSpec>,
    pub levels: Vec<AecLevelSpec>,
    pub rooms: Vec<AecRoomSpec>,
    pub openings: Vec<AecOpeningSpec>,
    pub furniture: Vec<AecFurnitureSpec>,
    pub notes: Vec<String>,
}

impl AecProjectProgram {
    /// Formats the extracted program into a detailed prompt addition for the PM / Architect Planner.
    pub fn to_prompt_context(&self) -> String {
        let mut out = Vec::new();
        out.push(format!("[INGESTED EXCEL PROGRAM: {}]", self.project_title));

        if let Some(site) = &self.site {
            out.push(format!(
                "- Lô đất: {}mm x {}mm. Lùi trước: {}mm, Lùi sau: {}mm, Lùi bên: {}mm / {}mm.",
                site.width_mm, site.depth_mm, site.setback_front_mm, site.setback_rear_mm, site.setback_left_mm, site.setback_right_mm
            ));
        }

        if let Some(grid) = &self.grid {
            let x_str: Vec<String> = grid.x_axes.iter().map(|a| format!("{} ({}mm)", a.tag, a.position_mm)).collect();
            let y_str: Vec<String> = grid.y_axes.iter().map(|a| format!("{} ({}mm)", a.tag, a.position_mm)).collect();
            out.push(format!("- Hệ lưới trục X: [{}]", x_str.join(", ")));
            out.push(format!("- Hệ lưới trục Y: [{}]", y_str.join(", ")));
        }

        if !self.levels.is_empty() {
            let lvl_str: Vec<String> = self.levels.iter().map(|l| {
                format!("{}: Z={}mm (cao tầng {}mm, thông thủy {}mm)", l.name, l.elevation_z_mm, l.floor_height_mm, l.clear_height_mm)
            }).collect();
            out.push(format!("- Cao độ các tầng: {}", lvl_str.join("; ")));
        }

        if !self.rooms.is_empty() {
            out.push(format!("- Danh mục {} phòng chức năng:", self.rooms.len()));
            for r in &self.rooms {
                let wet_tag = if r.is_wet { " [WET/ƯỚT]" } else { "" };
                let dim_str = match (r.width_mm, r.length_mm) {
                    (Some(w), Some(l)) => format!(", kích thước: {}x{}mm", w, l),
                    _ => String::new(),
                };
                out.push(format!(
                    "  * [{}] {}: {} m2{} (Phân loại: {}){}",
                    r.level_name, r.name, r.target_area_m2, wet_tag, r.function_category, dim_str
                ));
            }
        }

        if !self.openings.is_empty() {
            out.push(format!("- Thống kê {} cửa:", self.openings.len()));
            for op in &self.openings {
                out.push(format!(
                    "  * {} ({}) - Rộng: {}mm, Cao: {}mm, Bậu/Sill: {}mm{}",
                    op.tag, op.kind, op.width_mm, op.height_mm, op.sill_mm,
                    op.room_name.as_ref().map(|rn| format!(" (phòng: {rn})")).unwrap_or_default()
                ));
            }
        }

        if !self.furniture.is_empty() {
            out.push(format!("- Thiết bị/Nội thất: {} mục:", self.furniture.len()));
            for f in &self.furniture {
                out.push(format!("  * {} ({}) tại {}: {}x{}mm (Clearance {}mm)", f.item_name, f.kind, f.room_name, f.width_mm, f.length_mm, f.clearance_mm));
            }
        }

        out.join("\n")
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(json!({}))
    }
}

/// Normalizes header strings: lowercases, removes diacritics / accents, strips punctuation.
fn normalize_header(s: &str) -> String {
    let lower = s.trim().to_lowercase();
    let mut normalized = String::new();
    for c in lower.chars() {
        match c {
            'à' | 'á' | 'ạ' | 'ả' | 'ã' | 'â' | 'ầ' | 'ấ' | 'ậ' | 'ẩ' | 'ẫ' | 'ă' | 'ằ' | 'ắ' | 'ặ' | 'ẳ' | 'ẵ' => normalized.push('a'),
            'è' | 'é' | 'ẹ' | 'ẻ' | 'ẽ' | 'ê' | 'ề' | 'ế' | 'ệ' | 'ể' | 'ễ' => normalized.push('e'),
            'ì' | 'í' | 'ị' | 'ỉ' | 'ĩ' => normalized.push('i'),
            'ò' | 'ó' | 'ọ' | 'ỏ' | 'õ' | 'ô' | 'ồ' | 'ố' | 'ộ' | 'ổ' | 'ỗ' | 'ơ' | 'ờ' | 'ớ' | 'ợ' | 'ở' | 'ỡ' => normalized.push('o'),
            'ù' | 'ú' | 'ụ' | 'ủ' | 'ũ' | 'ư' | 'ừ' | 'ứ' | 'ự' | 'ử' | 'ữ' => normalized.push('u'),
            'ỳ' | 'ý' | 'ỵ' | 'ỷ' | 'ỹ' => normalized.push('y'),
            'đ' => normalized.push('d'),
            _ if c.is_alphanumeric() || c.is_whitespace() => normalized.push(c),
            _ => normalized.push(' '),
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extracts semantic AEC information from a [`RawWorkbook`].
pub fn extract_aec_program(workbook: &RawWorkbook) -> AecProjectProgram {
    let mut program = AecProjectProgram {
        project_title: workbook.file_name.replace(".xlsx", "").replace(".xls", "").replace(".csv", ""),
        site: None,
        grid: None,
        levels: Vec::new(),
        rooms: Vec::new(),
        openings: Vec::new(),
        furniture: Vec::new(),
        notes: Vec::new(),
    };

    for sheet in &workbook.sheets {
        let norm_sheet = normalize_header(&sheet.name);

        // Classify sheet by purpose
        if norm_sheet.contains("khu dat") || norm_sheet.contains("site") || norm_sheet.contains("dat") {
            parse_site_sheet(sheet, &mut program);
        } else if norm_sheet.contains("luoi truc") || norm_sheet.contains("grid") || norm_sheet.contains("truc") || norm_sheet.contains("cao do") || norm_sheet.contains("level") {
            parse_grid_and_level_sheet(sheet, &mut program);
        } else if norm_sheet.contains("cua") || norm_sheet.contains("door") || norm_sheet.contains("window") || norm_sheet.contains("opening") {
            parse_openings_sheet(sheet, &mut program);
        } else if norm_sheet.contains("noi that") || norm_sheet.contains("furniture") || norm_sheet.contains("thiet bi") {
            parse_furniture_sheet(sheet, &mut program);
        } else {
            // General or Room schedule sheet
            parse_rooms_sheet(sheet, &mut program);
        }
    }

    // Default levels if not explicitly defined
    if program.levels.is_empty() {
        let mut level_names = Vec::new();
        for r in &program.rooms {
            if !level_names.contains(&r.level_name) {
                level_names.push(r.level_name.clone());
            }
        }
        if level_names.is_empty() {
            level_names.push("Tầng 1".to_string());
        }
        let mut curr_z = 0.0;
        for (i, name) in level_names.into_iter().enumerate() {
            let height = if i == 0 { 4350.0 } else { 3900.0 };
            let clear = if i == 0 { 3900.0 } else { 3600.0 };
            program.levels.push(AecLevelSpec {
                index: i,
                name,
                elevation_z_mm: curr_z,
                floor_height_mm: height,
                clear_height_mm: clear,
            });
            curr_z += height;
        }
    }

    program
}

fn parse_site_sheet(sheet: &RawSheet, program: &mut AecProjectProgram) {
    let mut width = 15000.0;
    let mut depth = 25000.0;
    let mut front = 5000.0;
    let mut rear = 3000.0;
    let mut left = 1500.0;
    let mut right = 1500.0;

    for row in &sheet.rows {
        if row.len() >= 2 {
            let key = row[0].to_display_string().to_lowercase();
            let val = row[1].as_f64().unwrap_or(0.0);
            if val > 0.0 {
                let norm = normalize_header(&key);
                if norm.contains("rong") || norm.contains("mat tien") || norm.contains("width") {
                    width = if val < 100.0 { val * 1000.0 } else { val };
                } else if norm.contains("sau") || norm.contains("dai") || norm.contains("depth") {
                    depth = if val < 100.0 { val * 1000.0 } else { val };
                } else if norm.contains("lui truoc") || norm.contains("front") {
                    front = if val < 100.0 { val * 1000.0 } else { val };
                } else if norm.contains("lui sau") || norm.contains("rear") {
                    rear = if val < 100.0 { val * 1000.0 } else { val };
                } else if norm.contains("lui trai") || norm.contains("left") {
                    left = if val < 100.0 { val * 1000.0 } else { val };
                } else if norm.contains("lui phai") || norm.contains("right") {
                    right = if val < 100.0 { val * 1000.0 } else { val };
                }
            }
        }
    }

    program.site = Some(AecSiteSpec {
        width_mm: width,
        depth_mm: depth,
        setback_front_mm: front,
        setback_rear_mm: rear,
        setback_left_mm: left,
        setback_right_mm: right,
    });
}

fn parse_grid_and_level_sheet(sheet: &RawSheet, program: &mut AecProjectProgram) {
    let norm_headers: Vec<String> = sheet.headers.iter().map(|h| normalize_header(h)).collect();
    let mut x_axes = Vec::new();
    let mut y_axes = Vec::new();
    let mut bay_x = Vec::new();
    let mut bay_y = Vec::new();

    let tag_col = norm_headers.iter().position(|h| h.contains("truc") || h.contains("tag") || h.contains("axis"));
    let pos_col = norm_headers.iter().position(|h| h.contains("vi tri") || h.contains("toa do") || h.contains("position") || h.contains("nhip") || h.contains("khoang cach"));
    let dir_col = norm_headers.iter().position(|h| h.contains("huong") || h.contains("loai") || h.contains("direction") || h.contains("x y"));

    if let (Some(t_idx), Some(p_idx)) = (tag_col, pos_col) {
        for row in &sheet.rows {
            if row.len() > t_idx && row.len() > p_idx {
                let tag = row[t_idx].to_display_string();
                if let Some(pos) = row[p_idx].as_f64() {
                    let pos_mm = if pos < 100.0 { pos * 1000.0 } else { pos };
                    let dir = dir_col.and_then(|d| row.get(d)).map(|c| c.to_display_string().to_lowercase()).unwrap_or_default();
                    if dir.contains('x') || tag.chars().any(|c| c.is_numeric()) {
                        x_axes.push(GridAxis { tag: tag.clone(), position_mm: pos_mm });
                    } else {
                        y_axes.push(GridAxis { tag: tag.clone(), position_mm: pos_mm });
                    }
                }
            }
        }
    }

    if !x_axes.is_empty() || !y_axes.is_empty() {
        for w in x_axes.windows(2) {
            bay_x.push(w[1].position_mm - w[0].position_mm);
        }
        for w in y_axes.windows(2) {
            bay_y.push(w[1].position_mm - w[0].position_mm);
        }
        program.grid = Some(AecGridSpec {
            x_axes,
            y_axes,
            bay_x_mm: bay_x,
            bay_y_mm: bay_y,
        });
    }
}

fn parse_rooms_sheet(sheet: &RawSheet, program: &mut AecProjectProgram) {
    let norm_headers: Vec<String> = sheet.headers.iter().map(|h| normalize_header(h)).collect();

    let name_col = norm_headers.iter().position(|h| h.contains("ten phong") || h.contains("phong") || h.contains("room") || h.contains("space") || h.contains("chuc nang"));
    let area_col = norm_headers.iter().position(|h| h.contains("dien tich") || h.contains("dt") || h.contains("area") || h.contains("m2") || h.contains("sqm"));
    let level_col = norm_headers.iter().position(|h| h.contains("tang") || h.contains("level") || h.contains("floor"));
    let width_col = norm_headers.iter().position(|h| h.contains("rong") || h.contains("width") || h.contains("b"));
    let length_col = norm_headers.iter().position(|h| h.contains("dai") || h.contains("length") || h.contains("l"));

    let Some(n_idx) = name_col else { return; };
    let a_idx = area_col.unwrap_or(n_idx + 1);

    for (r_idx, row) in sheet.rows.iter().enumerate() {
        if row.len() <= n_idx {
            continue;
        }
        let room_name = row[n_idx].to_display_string().trim().to_string();
        if room_name.is_empty() || room_name.to_lowercase().starts_with("tong") {
            continue;
        }

        let area_m2 = row.get(a_idx).and_then(|c| c.as_f64()).unwrap_or(20.0);
        let level_name = level_col
            .and_then(|l| row.get(l))
            .map(|c| c.to_display_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                // Infer level from room name or default
                let lower = room_name.to_lowercase();
                if lower.contains("tum") || lower.contains("mai") || lower.contains("tho") || lower.contains("gym") {
                    "Tầng Tum".to_string()
                } else if lower.contains("master") || lower.contains("con") || lower.contains("sinh hoat chung") {
                    "Tầng 2".to_string()
                } else {
                    "Tầng 1".to_string()
                }
            });

        let level_index = match level_name.as_str() {
            s if s.contains('1') => 0,
            s if s.contains('2') => 1,
            s if s.contains("tum") || s.contains('3') => 2,
            _ => 0,
        };

        let width_mm = width_col.and_then(|w| row.get(w)).and_then(|c| c.as_f64()).map(|v| if v < 100.0 { v * 1000.0 } else { v });
        let length_mm = length_col.and_then(|l| row.get(l)).and_then(|c| c.as_f64()).map(|v| if v < 100.0 { v * 1000.0 } else { v });

        let norm_name = normalize_header(&room_name);
        let is_wet = norm_name.contains("wc") || norm_name.contains("ve sinh") || norm_name.contains("tam") || norm_name.contains("bath") || norm_name.contains("bep") || norm_name.contains("kitchen");

        let function_category = if norm_name.contains("khach") || norm_name.contains("living") {
            "Living".to_string()
        } else if norm_name.contains("bep") || norm_name.contains("an") || norm_name.contains("kitchen") || norm_name.contains("dining") {
            "Kitchen_Dining".to_string()
        } else if norm_name.contains("master") {
            "Master_Bedroom".to_string()
        } else if norm_name.contains("ngu") || norm_name.contains("bedroom") {
            "Bedroom".to_string()
        } else if is_wet {
            "Bathroom".to_string()
        } else if norm_name.contains("tho") || norm_name.contains("altar") {
            "Altar".to_string()
        } else if norm_name.contains("gym") || norm_name.contains("giai tri") {
            "Gym_Entertainment".to_string()
        } else if norm_name.contains("thang") || norm_name.contains("stair") {
            "Stair".to_string()
        } else if norm_name.contains("sanh") || norm_name.contains("lounge") || norm_name.contains("sinh hoat chung") {
            "Lounge".to_string()
        } else if norm_name.contains("san") || norm_name.contains("terrace") || norm_name.contains("balcony") || norm_name.contains("ban cong") {
            "Terrace_Balcony".to_string()
        } else {
            "General".to_string()
        };

        program.rooms.push(AecRoomSpec {
            id: format!("R_{}_{}", level_index + 1, r_idx + 1),
            name: room_name,
            level_name,
            level_index,
            target_area_m2: area_m2,
            width_mm,
            length_mm,
            is_wet,
            function_category,
        });
    }
}

fn parse_openings_sheet(sheet: &RawSheet, program: &mut AecProjectProgram) {
    let norm_headers: Vec<String> = sheet.headers.iter().map(|h| normalize_header(h)).collect();
    let tag_col = norm_headers.iter().position(|h| h.contains("ky hieu") || h.contains("ma") || h.contains("tag") || h.contains("code"));
    let type_col = norm_headers.iter().position(|h| h.contains("loai") || h.contains("type") || h.contains("kind"));
    let w_col = norm_headers.iter().position(|h| h.contains("rong") || h.contains("width") || h.contains("w") || h.contains("b"));
    let h_col = norm_headers.iter().position(|h| h.contains("cao") || h.contains("height") || h.contains("h"));
    let sill_col = norm_headers.iter().position(|h| h.contains("bau") || h.contains("sill") || h.contains("do"));
    let room_col = norm_headers.iter().position(|h| h.contains("phong") || h.contains("room") || h.contains("vi tri"));

    let Some(t_idx) = tag_col.or(type_col) else { return; };
    for row in &sheet.rows {
        if row.len() <= t_idx { continue; }
        let tag = row[t_idx].to_display_string();
        if tag.is_empty() { continue; }

        let kind = type_col.and_then(|tc| row.get(tc)).map(|c| c.to_display_string().to_lowercase()).unwrap_or_else(|| {
            if tag.to_uppercase().starts_with('D') { "door".to_string() } else { "window".to_string() }
        });

        let width = w_col.and_then(|wc| row.get(wc)).and_then(|c| c.as_f64()).unwrap_or(900.0);
        let height = h_col.and_then(|hc| row.get(hc)).and_then(|c| c.as_f64()).unwrap_or(2200.0);
        let sill = sill_col.and_then(|sc| row.get(sc)).and_then(|c| c.as_f64()).unwrap_or(if kind.contains("door") { 0.0 } else { 900.0 });
        let room_name = room_col.and_then(|rc| row.get(rc)).map(|c| c.to_display_string());

        program.openings.push(AecOpeningSpec {
            tag,
            kind,
            width_mm: if width < 100.0 { width * 1000.0 } else { width },
            height_mm: if height < 100.0 { height * 1000.0 } else { height },
            sill_mm: if sill < 100.0 && sill > 0.0 { sill * 1000.0 } else { sill },
            room_name,
        });
    }
}

fn parse_furniture_sheet(sheet: &RawSheet, program: &mut AecProjectProgram) {
    let norm_headers: Vec<String> = sheet.headers.iter().map(|h| normalize_header(h)).collect();
    let item_col = norm_headers.iter().position(|h| h.contains("ten") || h.contains("item") || h.contains("thiet bi") || h.contains("noi that"));
    let room_col = norm_headers.iter().position(|h| h.contains("phong") || h.contains("room"));
    let w_col = norm_headers.iter().position(|h| h.contains("rong") || h.contains("width") || h.contains("w"));
    let l_col = norm_headers.iter().position(|h| h.contains("dai") || h.contains("length") || h.contains("l") || h.contains("d"));

    let Some(i_idx) = item_col else { return; };
    for row in &sheet.rows {
        if row.len() <= i_idx { continue; }
        let item_name = row[i_idx].to_display_string();
        if item_name.is_empty() { continue; }

        let room_name = room_col.and_then(|rc| row.get(rc)).map(|c| c.to_display_string()).unwrap_or_else(|| "Chung".to_string());
        let width = w_col.and_then(|wc| row.get(wc)).and_then(|c| c.as_f64()).unwrap_or(1200.0);
        let length = l_col.and_then(|lc| row.get(lc)).and_then(|c| c.as_f64()).unwrap_or(2000.0);

        let norm_item = normalize_header(&item_name);
        let kind = if norm_item.contains("giuong") || norm_item.contains("bed") {
            "bed"
        } else if norm_item.contains("sofa") || norm_item.contains("salon") {
            "sofa"
        } else if norm_item.contains("ban") || norm_item.contains("table") || norm_item.contains("desk") {
            "table"
        } else if norm_item.contains("bon cau") || norm_item.contains("toilet") || norm_item.contains("wc") {
            "toilet"
        } else if norm_item.contains("lavabo") || norm_item.contains("sink") || norm_item.contains("chau rua") {
            "sink"
        } else if norm_item.contains("tu") || norm_item.contains("cabinet") || norm_item.contains("wardrobe") {
            "cabinet"
        } else {
            "general"
        };

        program.furniture.push(AecFurnitureSpec {
            room_name,
            item_name,
            kind: kind.to_string(),
            width_mm: if width < 100.0 { width * 1000.0 } else { width },
            length_mm: if length < 100.0 { length * 1000.0 } else { length },
            clearance_mm: 600.0,
        });
    }
}

// =========================================================================
// SECTION 3: EXCEL-TO-CAD DIFF & RECONCILIATION
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AreaDeviation {
    pub room_name: String,
    pub excel_target_m2: f64,
    pub cad_actual_m2: f64,
    pub delta_m2: f64,
    pub deviation_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcelCadReconciliation {
    pub matched_rooms_count: usize,
    pub missing_rooms: Vec<AecRoomSpec>,
    pub area_deviations: Vec<AreaDeviation>,
    pub missing_openings: Vec<AecOpeningSpec>,
    pub summary: String,
    pub suggested_cad_actions: Vec<Value>,
}

/// Reconciles an [`AecProjectProgram`] from Excel with live CAD drawing records.
///
/// Looks through `cad_records` (obtained from `ocs_read op: "records"` or `entities` query)
/// to find existing rooms (from text annotations, polylines, hatches), compare areas,
/// and produce actionable CAD mutations to reconcile the differences.
pub fn reconcile_excel_with_cad(
    program: &AecProjectProgram,
    cad_records: &Value,
) -> ExcelCadReconciliation {
    let mut missing_rooms = Vec::new();
    let mut area_deviations = Vec::new();
    let mut matched_count = 0;
    let mut suggested_actions = Vec::new();

    // Extract existing text labels and area records from CAD
    let mut cad_room_labels: BTreeMap<String, f64> = BTreeMap::new();
    if let Some(records) = cad_records.get("records").and_then(Value::as_array).or_else(|| cad_records.get("entities").and_then(Value::as_array)) {
        for rec in records {
            let ent_type = rec["type"].as_str().unwrap_or("");
            if ent_type.eq_ignore_ascii_case("TEXT") || ent_type.eq_ignore_ascii_case("MTEXT") {
                if let Some(text_val) = rec["properties"]["text"].as_str().or_else(|| rec["text"].as_str()) {
                    let norm = normalize_header(text_val);
                    // Check if text has an area format: e.g. "Phòng khách - 35m2" or area stored in xdata/properties
                    let area_val = rec["properties"]["area"].as_f64().unwrap_or(0.0);
                    cad_room_labels.insert(norm, area_val);
                }
            }
        }
    }

    for room in &program.rooms {
        let norm_target = normalize_header(&room.name);
        let found = cad_room_labels.iter().find(|(k, _)| k.contains(&norm_target) || norm_target.contains(k.as_str()));

        if let Some((_cad_name, &cad_area)) = found {
            matched_count += 1;
            if cad_area > 0.0 {
                let delta = cad_area - room.target_area_m2;
                let pct = (delta.abs() / room.target_area_m2) * 100.0;
                if pct > 10.0 {
                    area_deviations.push(AreaDeviation {
                        room_name: room.name.clone(),
                        excel_target_m2: room.target_area_m2,
                        cad_actual_m2: cad_area,
                        delta_m2: delta,
                        deviation_pct: pct,
                    });
                }
            }
        } else {
            missing_rooms.push(room.clone());
            // Suggest creating text annotation and boundary for missing room
            suggested_actions.push(json!({
                "op": "entities_create",
                "entities": [{
                    "type": "MTEXT",
                    "layer": "A-ANNO",
                    "text": format!("{}\n{:.1} m²", room.name, room.target_area_m2),
                    "height": 250.0
                }]
            }));
        }
    }

    let summary = format!(
        "Reconciliation completed: {}/{} rooms matched. {} missing rooms to create, {} area deviations (>10%).",
        matched_count, program.rooms.len(), missing_rooms.len(), area_deviations.len()
    );

    ExcelCadReconciliation {
        matched_rooms_count: matched_count,
        missing_rooms,
        area_deviations,
        missing_openings: Vec::new(),
        summary,
        suggested_cad_actions: suggested_actions,
    }
}
