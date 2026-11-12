//! In-App AI Copilot update event handler.

use crate::ai::chat_panel::AiCopilotMsg;
use crate::ai::copilot_bridge;
use crate::ai::copilot_state::{AttachedFile, AttachedFileType, ChatMessage, MessageRole};
use crate::ai::dwg_ingestion::IngestionMode;
use crate::app::{Message, OpenCADStudio};
use iced::Task;

impl OpenCADStudio {
    pub(in crate::app) fn update_ai_copilot(&mut self, msg: AiCopilotMsg) -> Task<Message> {
        match msg {
            AiCopilotMsg::InputChanged(val) => {
                self.ai_copilot.input_prompt = val;
                Task::none()
            }
            AiCopilotMsg::TextEditorAction(action) => {
                match &action {
                    iced::widget::text_editor::Action::Edit(iced::widget::text_editor::Edit::Enter) => {
                        if self.shift_down {
                            // Shift + Enter: Insert newline in textarea
                            self.ai_copilot.input_content.perform(action);
                            self.ai_copilot.input_prompt = self.ai_copilot.input_content.text();
                        } else {
                            // Enter alone: Submit message
                            return self.update_ai_copilot(AiCopilotMsg::SendMessage);
                        }
                    }
                    _ => {
                        self.ai_copilot.input_content.perform(action);
                        self.ai_copilot.input_prompt = self.ai_copilot.input_content.text();
                    }
                }
                Task::none()
            }
            AiCopilotMsg::PasteClipboard => {
                match crate::ai::multimodal::MultimodalAttachmentManager::inspect_clipboard_paste() {
                    crate::ai::multimodal::ClipboardPasteOutcome::Image(img) => {
                        self.ai_copilot.attached_images.push(img);
                    }
                    crate::ai::multimodal::ClipboardPasteOutcome::CopiedFiles(paths) => {
                        for p in paths {
                            if let Ok(att) = crate::ai::multimodal::MultimodalAttachmentManager::parse_file(&p) {
                                match att {
                                    crate::ai::multimodal::DroppedAttachment::Image(img) => {
                                        self.ai_copilot.attached_images.push(img);
                                    }
                                    crate::ai::multimodal::DroppedAttachment::File(f) => {
                                        self.ai_copilot.attached_files.push(f);
                                    }
                                }
                            }
                        }
                    }
                    crate::ai::multimodal::ClipboardPasteOutcome::Text(txt) => {
                        self.ai_copilot.input_content.perform(iced::widget::text_editor::Action::Edit(
                            iced::widget::text_editor::Edit::Paste(std::sync::Arc::new(txt)),
                        ));
                        self.ai_copilot.input_prompt = self.ai_copilot.input_content.text();
                    }
                    crate::ai::multimodal::ClipboardPasteOutcome::Empty => {}
                }
                Task::none()
            }
            AiCopilotMsg::RemoveAttachedImage(idx) => {
                if idx < self.ai_copilot.attached_images.len() {
                    self.ai_copilot.attached_images.remove(idx);
                }
                Task::none()
            }
            AiCopilotMsg::FileDropped(path) => {
                self.ai_copilot.is_drag_hovered = false;
                if let Ok(att) = crate::ai::multimodal::MultimodalAttachmentManager::parse_file(&path) {
                    match att {
                        crate::ai::multimodal::DroppedAttachment::Image(img) => {
                            self.ai_copilot.attached_images.push(img);
                        }
                        crate::ai::multimodal::DroppedAttachment::File(f) => {
                            self.ai_copilot.attached_files.push(f);
                        }
                    }
                }
                Task::none()
            }
            AiCopilotMsg::DragHover(hovered) => {
                self.ai_copilot.is_drag_hovered = hovered;
                Task::none()
            }
            AiCopilotMsg::SendMessage => {
                let prompt = self.ai_copilot.current_prompt().trim().to_string();
                if prompt.is_empty()
                    && self.ai_copilot.attached_files.is_empty()
                    && self.ai_copilot.attached_images.is_empty()
                {
                    return Task::none();
                }

                let mut text_display = if prompt.is_empty() {
                    "Xử lý các tệp đính kèm theo quy hoạch kiến trúc chuẩn.".to_string()
                } else {
                    prompt.clone()
                };

                if !self.ai_copilot.attached_images.is_empty() {
                    text_display.push_str(&format!(" [📷 {} ảnh đính kèm]", self.ai_copilot.attached_images.len()));
                }

                self.ai_copilot.messages.push(ChatMessage {
                    id: format!("user-{}", self.ai_copilot.messages.len()),
                    role: MessageRole::User,
                    text: text_display,
                    timestamp: "Vừa xong".to_string(),
                    interactive_handles: Vec::new(),
                    interactive_coords: Vec::new(),
                    can_undo: false,
                    can_audit_fix: false,
                    can_evolve: false,
                });

                self.ai_copilot.clear_prompt();
                self.ai_copilot.is_busy = true;

                // Capture live selection from active tab
                let i = self.active_tab;
                let handles: Vec<String> = if let Some(tab) = self.tabs.get(i) {
                    tab.scene.selected.iter().map(|h| format!("{:X}", h.value())).collect()
                } else {
                    Vec::new()
                };

                let context_summary = if !handles.is_empty() {
                    Some(format!("Đang chọn {} đối tượng trên Viewport", handles.len()))
                } else {
                    None
                };

                let (tx, rx) = std::sync::mpsc::channel();
                self.ai_copilot.event_rx = Some(rx);

                let session_id = crate::app::control::session_id().to_string();

                let stop_flag = copilot_bridge::launch_copilot_task(
                    prompt,
                    self.ai_copilot.attached_files.clone(),
                    self.ai_copilot.attached_images.clone(),
                    handles,
                    context_summary,
                    self.ai_config.clone(),
                    session_id,
                    tx,
                );
                self.ai_copilot.stop_signal = Some(stop_flag);

                Task::none()
            }
            AiCopilotMsg::StopProcessing => {
                if let Some(stop) = self.ai_copilot.stop_signal.take() {
                    stop.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                self.ai_copilot.is_busy = false;
                self.ai_copilot.status.is_active = false;
                self.ai_copilot.status.current_agent = crate::ai::copilot_state::AgentKind::Idle;
                self.ai_copilot.status.description = "Đã dừng tác vụ AI theo yêu cầu.".to_string();
                self.ai_copilot.messages.push(ChatMessage {
                    id: format!("stop-{}", self.ai_copilot.messages.len()),
                    role: MessageRole::System,
                    text: "⏹ **Đã dừng:** Tiến trình AI Copilot đã được dừng lại theo yêu cầu của bạn.".to_string(),
                    timestamp: "Vừa xong".to_string(),
                    interactive_handles: Vec::new(),
                    interactive_coords: Vec::new(),
                    can_undo: false,
                    can_audit_fix: false,
                    can_evolve: false,
                });
                Task::none()
            }
            AiCopilotMsg::AttachFiles => {
                let files = rfd::FileDialog::new()
                    .add_filter(
                        "AEC Multimodal Files (*.xlsx, *.dwg, *.dxf, *.csv)",
                        &["xlsx", "xls", "dwg", "dxf", "csv"],
                    )
                    .pick_files();

                if let Some(paths) = files {
                    for path in paths {
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
                        let file_type = match ext.as_str() {
                            "xlsx" | "xls" => AttachedFileType::Excel,
                            "dwg" | "dxf" => AttachedFileType::DwgDxf,
                            "png" | "jpg" | "jpeg" | "bmp" | "webp" => AttachedFileType::SiteImage,
                            _ => AttachedFileType::Csv,
                        };

                        let summary = match file_type {
                            AttachedFileType::Excel | AttachedFileType::Csv => {
                                match crate::ai::excel_ingestion::parse_raw_workbook(&path) {
                                    Ok(wb) => format!(
                                        "Excel: {} sheets, {} rows",
                                        wb.sheets.len(),
                                        wb.sheets.iter().map(|s| s.rows.len()).sum::<usize>()
                                    ),
                                    Err(e) => format!("Lỗi đọc: {e}"),
                                }
                            }
                            AttachedFileType::DwgDxf => {
                                match crate::ai::dwg_ingestion::summarize_dwg_file(&path) {
                                    Ok(d) => format!(
                                        "DWG: {} entities, {} layers, {} blocks",
                                        d.total_entities,
                                        d.layers.len(),
                                        d.blocks.len()
                                    ),
                                    Err(e) => format!("Lỗi đọc: {e}"),
                                }
                            }
                            AttachedFileType::SiteImage => {
                                "Ảnh Sổ đỏ / Bản đồ khu đất".to_string()
                            }
                        };

                        self.ai_copilot.attached_files.push(AttachedFile {
                            path,
                            name,
                            file_type,
                            summary,
                            ingestion_mode: IngestionMode::MergeIntoCurrent,
                        });
                    }
                }
                Task::none()
            }
            AiCopilotMsg::RemoveAttachedFile(idx) => {
                if idx < self.ai_copilot.attached_files.len() {
                    self.ai_copilot.attached_files.remove(idx);
                }
                Task::none()
            }
            AiCopilotMsg::ToggleDwgMode(idx) => {
                if let Some(file) = self.ai_copilot.attached_files.get_mut(idx) {
                    file.ingestion_mode = match file.ingestion_mode {
                        IngestionMode::OpenAsActiveBase => IngestionMode::MergeIntoCurrent,
                        IngestionMode::MergeIntoCurrent => IngestionMode::OpenAsActiveBase,
                    };
                }
                Task::none()
            }
            AiCopilotMsg::ClickHandle(handle_str) => {
                let _ = self.dispatch_command(&format!("SELECT {handle_str}"));
                let _ = self.dispatch_command(&format!("ZOOM O {handle_str}"));
                Task::none()
            }
            AiCopilotMsg::UndoBatch => {
                let _ = self.dispatch_command("UNDO 1");
                Task::none()
            }
            AiCopilotMsg::AuditAndFix => {
                let _ = self.dispatch_command("AUDIT Y");
                Task::none()
            }
            AiCopilotMsg::EvolveNext => {
                self.ai_copilot.input_prompt = "Tiếp tục phát triển phương án thiết kế sang giai đoạn tiếp theo: bổ sung phòng ốc, nội thất, và khung bản vẽ kỹ thuật.".to_string();
                self.update_ai_copilot(AiCopilotMsg::SendMessage)
            }
            AiCopilotMsg::ToggleQuickSettings => {
                self.ai_copilot.quick_settings_open = !self.ai_copilot.quick_settings_open;
                Task::none()
            }
            AiCopilotMsg::ApiKeyChanged(k) => {
                self.ai_config.api_key = k;
                self.save_config();
                Task::none()
            }
            AiCopilotMsg::BaseUrlChanged(u) => {
                self.ai_config.base_url = u;
                self.save_config();
                Task::none()
            }
            AiCopilotMsg::PlannerModelChanged(m) => {
                self.ai_config.planner_model = m;
                self.save_config();
                Task::none()
            }
            AiCopilotMsg::VisionModelChanged(m) => {
                self.ai_config.vision_model = m;
                self.save_config();
                Task::none()
            }
            AiCopilotMsg::PollTick => {
                if let Some(ev) = self.ai_copilot.poll_events() {
                    if matches!(
                        ev,
                        crate::ai::copilot_state::CopilotEvent::BatchExecuted { .. }
                            | crate::ai::copilot_state::CopilotEvent::Completed { .. }
                    ) {
                        let i = self.active_tab;
                        if let Some(tab) = self.tabs.get_mut(i) {
                            tab.scene.bump_geometry();
                        }
                    }
                }
                let i = self.active_tab;
                if let Some(tab) = self.tabs.get(i) {
                    let count = tab.scene.selected.len();
                    self.ai_copilot.selected_context_summary = if count > 0 {
                        Some(format!("Đang chọn {count} đối tượng trên Viewport"))
                    } else {
                        None
                    };
                }
                Task::none()
            }
        }
    }
}
