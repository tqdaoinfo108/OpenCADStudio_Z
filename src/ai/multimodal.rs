//! Multimodal Attachment Manager for OpenCADStudio In-App Copilot.
//!
//! Provides:
//! 1. Clipboard image reading (Ctrl+V / Paste Image) converting system RGBA buffer to PNG in memory.
//! 2. Drag-and-drop file detection and multi-sheet reading for Excel (.xlsx, .csv), DWG/DXF, and images.
//! 3. Vision API payload compilation with Base64 encoding.

use crate::ai::{
    copilot_state::{AttachedFile, AttachedFileType},
    dwg_ingestion::IngestionMode,
    excel_ingestion,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachedImage {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[serde(skip)]
    pub bytes: Vec<u8>,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcelSheetSummary {
    pub name: String,
    pub row_count: usize,
    pub column_count: usize,
    pub headers: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum DroppedAttachment {
    Image(AttachedImage),
    File(AttachedFile),
}

pub struct MultimodalAttachmentManager;

impl MultimodalAttachmentManager {
    /// Reads an image from the OS clipboard (Ctrl+V / Paste), encoding it to memory-resident PNG.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_clipboard_image() -> Option<AttachedImage> {
        let mut clipboard = arboard::Clipboard::new().ok()?;
        let img_data = clipboard.get_image().ok()?;
        let width = img_data.width as u32;
        let height = img_data.height as u32;
        let rgba_bytes = img_data.bytes.into_owned();
        let img_buffer = image::RgbaImage::from_raw(width, height, rgba_bytes)?;

        let mut png_bytes = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut png_bytes);
        img_buffer.write_to(&mut cursor, image::ImageFormat::Png).ok()?;

        let b64 = STANDARD.encode(&png_bytes);
        let id = uuid::Uuid::new_v4().to_string();
        let name = format!("pasted_{}x{}_{}.png", width, height, &id[..6]);

        Some(AttachedImage {
            id,
            name,
            width,
            height,
            bytes: png_bytes,
            base64: b64,
        })
    }

    #[cfg(target_arch = "wasm32")]
    pub fn read_clipboard_image() -> Option<AttachedImage> {
        None
    }

    /// Reads text from the OS clipboard.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_clipboard_text() -> Option<String> {
        let mut clipboard = arboard::Clipboard::new().ok()?;
        let txt = clipboard.get_text().ok()?;
        if txt.trim().is_empty() {
            None
        } else {
            Some(txt)
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn read_clipboard_text() -> Option<String> {
        None
    }

    /// Inspects clipboard content for copied file paths or images or text.
    pub fn inspect_clipboard_paste() -> ClipboardPasteOutcome {
        // 1. First priority: Check if clipboard has image data
        if let Some(img) = Self::read_clipboard_image() {
            return ClipboardPasteOutcome::Image(img);
        }

        // 2. Check text or copied file paths
        if let Some(text) = Self::read_clipboard_text() {
            let lines: Vec<&str> = text.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
            let mut valid_paths = Vec::new();
            for line in &lines {
                let p = Path::new(line);
                if p.exists() && p.is_file() {
                    valid_paths.push(p.to_path_buf());
                }
            }
            if !valid_paths.is_empty() {
                return ClipboardPasteOutcome::CopiedFiles(valid_paths);
            }
            return ClipboardPasteOutcome::Text(text);
        }

        ClipboardPasteOutcome::Empty
    }

    /// Processes a dropped or picked file path into an AttachedFile or AttachedImage.
    pub fn parse_file(path: &Path) -> Result<DroppedAttachment, String> {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();

        match ext.as_str() {
            "png" | "jpg" | "jpeg" | "webp" | "bmp" => {
                let img = image::open(path).map_err(|e| format!("Lỗi mở tệp ảnh {}: {}", name, e))?;
                let width = img.width();
                let height = img.height();

                let mut png_bytes = Vec::new();
                let mut cursor = std::io::Cursor::new(&mut png_bytes);
                img.write_to(&mut cursor, image::ImageFormat::Png)
                    .map_err(|e| format!("Lỗi mã hóa PNG: {}", e))?;

                let b64 = STANDARD.encode(&png_bytes);
                let id = uuid::Uuid::new_v4().to_string();

                Ok(DroppedAttachment::Image(AttachedImage {
                    id,
                    name,
                    width,
                    height,
                    bytes: png_bytes,
                    base64: b64,
                }))
            }
            "xlsx" | "xls" => {
                match excel_ingestion::parse_raw_workbook(path) {
                    Ok(wb) => {
                        let total_rows: usize = wb.sheets.iter().map(|s| s.rows.len()).sum();
                        let sheet_names: Vec<String> = wb.sheets.iter().map(|s| s.name.clone()).collect();
                        let summary = format!(
                            "Excel: {} sheets [{}], {} dòng",
                            wb.sheets.len(),
                            sheet_names.join(", "),
                            total_rows
                        );
                        Ok(DroppedAttachment::File(AttachedFile {
                            path: path.to_path_buf(),
                            name,
                            file_type: AttachedFileType::Excel,
                            summary,
                            ingestion_mode: IngestionMode::MergeIntoCurrent,
                        }))
                    }
                    Err(e) => Err(format!("Lỗi đọc file Excel {}: {}", name, e)),
                }
            }
            "csv" => {
                let content = std::fs::read_to_string(path)
                    .map_err(|e| format!("Lỗi đọc file CSV: {}", e))?;
                let lines: Vec<&str> = content.lines().collect();
                let rows = lines.len();
                let cols = lines.first().map(|l| l.split(',').count()).unwrap_or(0);
                let summary = format!("CSV: {} cột, {} dòng", cols, rows);
                Ok(DroppedAttachment::File(AttachedFile {
                    path: path.to_path_buf(),
                    name,
                    file_type: AttachedFileType::Csv,
                    summary,
                    ingestion_mode: IngestionMode::MergeIntoCurrent,
                }))
            }
            "dwg" | "dxf" => {
                match crate::ai::dwg_ingestion::summarize_dwg_file(path) {
                    Ok(d) => {
                        let summary = format!(
                            "DWG: {} thực thể, {} layers, {} blocks",
                            d.total_entities,
                            d.layers.len(),
                            d.blocks.len()
                        );
                        Ok(DroppedAttachment::File(AttachedFile {
                            path: path.to_path_buf(),
                            name,
                            file_type: AttachedFileType::DwgDxf,
                            summary,
                            ingestion_mode: IngestionMode::MergeIntoCurrent,
                        }))
                    }
                    Err(e) => Err(format!("Lỗi phân tích file DWG: {}", e)),
                }
            }
            _ => Err(format!("Định dạng tệp .{} không được hỗ trợ", ext)),
        }
    }

    /// Compiles OpenAI Vision user message payload with attached images.
    pub fn build_vision_payload(prompt: &str, images: &[AttachedImage]) -> Value {
        let mut content = Vec::new();
        content.push(json!({
            "type": "text",
            "text": prompt
        }));

        for img in images {
            content.push(json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:image/png;base64,{}", img.base64),
                    "detail": "high"
                }
            }));
        }

        json!(content)
    }
}

pub enum ClipboardPasteOutcome {
    Image(AttachedImage),
    CopiedFiles(Vec<PathBuf>),
    Text(String),
    Empty,
}
