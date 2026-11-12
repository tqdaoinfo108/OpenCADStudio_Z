//! AI Copilot UI State and Event Definitions.

use crate::ai::dwg_ingestion::IngestionMode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub timestamp: String,
    pub interactive_handles: Vec<String>,
    pub interactive_coords: Vec<[f64; 2]>,
    pub can_undo: bool,
    pub can_audit_fix: bool,
    pub can_evolve: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttachedFileType {
    Excel,
    DwgDxf,
    Csv,
    SiteImage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachedFile {
    pub path: PathBuf,
    pub name: String,
    pub file_type: AttachedFileType,
    pub summary: String,
    pub ingestion_mode: IngestionMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentKind {
    Idle,
    LeadOrchestrator,
    SiteSpecialist,
    SpatialPlanner,
    BimModeler,
    QaInspector,
    Planner,
    Execution,
    QaCritic,
    Evolution,
}

impl AgentKind {
    pub fn badge_title(&self) -> &'static str {
        match self {
            AgentKind::Idle => "Sẵn sàng",
            AgentKind::LeadOrchestrator => "[Lead Architect] Tổng công trình sư điều phối",
            AgentKind::SiteSpecialist => "[Site Specialist] Bóc tách khu đất & quy chuẩn",
            AgentKind::SpatialPlanner | AgentKind::Planner => "[Spatial Planner] Quy hoạch kết cấu & mặt bằng",
            AgentKind::BimModeler | AgentKind::Execution => "[BIM Modeler] Triển khai 2D/3D & Batch CAD",
            AgentKind::QaInspector | AgentKind::QaCritic => "[QA Inspector] Kiểm toán hình học & Vision QA",
            AgentKind::Evolution => "[Evolution] Đề xuất phát triển tiếp",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentExecutionStatus {
    pub current_agent: AgentKind,
    pub description: String,
    pub completed_steps: usize,
    pub total_steps: usize,
    pub is_active: bool,
}

impl Default for AgentExecutionStatus {
    fn default() -> Self {
        Self {
            current_agent: AgentKind::Idle,
            description: "Chưa có tác vụ AI đang chạy".to_string(),
            completed_steps: 0,
            total_steps: 0,
            is_active: false,
        }
    }
}

/// Progress and result events streaming from the background AI worker to the UI.
#[derive(Debug, Clone)]
pub enum CopilotEvent {
    Progress {
        agent: AgentKind,
        phase: String,
        step: usize,
        total: usize,
        detail: String,
    },
    PlanReady {
        summary: String,
        plan_json: Value,
    },
    BatchExecuted {
        phase_name: String,
        completed_steps: usize,
        total_steps: usize,
        handles: Vec<String>,
    },
    QaReport {
        verdict: String,
        issues: Vec<String>,
        image_base64: Option<String>,
    },
    EvolutionProposed {
        next_phase: String,
        missing: Vec<String>,
    },
    Completed {
        message: String,
        delivery_path: Option<String>,
        created_handles: Vec<String>,
    },
    Error {
        error: String,
    },
    Stopped,
}

/// Consolidated state of the In-App AI Copilot panel.
pub struct CopilotState {
    pub messages: Vec<ChatMessage>,
    pub attached_files: Vec<AttachedFile>,
    pub attached_images: Vec<crate::ai::multimodal::AttachedImage>,
    pub status: AgentExecutionStatus,
    pub input_content: iced::widget::text_editor::Content,
    pub input_prompt: String,
    pub is_busy: bool,
    pub is_drag_hovered: bool,
    pub selected_context_summary: Option<String>,
    pub selected_handles: Vec<String>,
    pub quick_settings_open: bool,
    pub event_rx: Option<std::sync::mpsc::Receiver<CopilotEvent>>,
    pub stop_signal: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl Default for CopilotState {
    fn default() -> Self {
        Self {
            messages: vec![
                ChatMessage {
                    id: "welcome".to_string(),
                    role: MessageRole::System,
                    text: "Xin chào! Tôi là OpenCADStudio AI Copilot đa phương thức. Bạn có thể nhập yêu cầu thiết kế văn bản, hoặc đính kèm/kéo-thả tệp .dwg/.dxf, bảng tính Excel (.xlsx) và dán ảnh mặt bằng/sketch (Ctrl+V) để tôi tự động đọc hiểu thông số, dựng hình 2D/3D và chỉnh sửa trực tiếp trên bản vẽ.".to_string(),
                    timestamp: "Vừa xong".to_string(),
                    interactive_handles: Vec::new(),
                    interactive_coords: Vec::new(),
                    can_undo: false,
                    can_audit_fix: false,
                    can_evolve: false,
                }
            ],
            attached_files: Vec::new(),
            attached_images: Vec::new(),
            status: AgentExecutionStatus::default(),
            input_content: iced::widget::text_editor::Content::new(),
            input_prompt: String::new(),
            is_busy: false,
            is_drag_hovered: false,
            selected_context_summary: None,
            selected_handles: Vec::new(),
            quick_settings_open: false,
            event_rx: None,
            stop_signal: None,
        }
    }
}

impl CopilotState {
    /// Returns the current prompt string from the multi-line editor or input prompt.
    pub fn current_prompt(&self) -> String {
        let text = self.input_content.text();
        if text.trim().is_empty() {
            self.input_prompt.clone()
        } else {
            text
        }
    }

    /// Clears both editor content and cached prompt string.
    pub fn clear_prompt(&mut self) {
        self.input_content = iced::widget::text_editor::Content::new();
        self.input_prompt.clear();
    }
    /// Polls for incoming background AI events and updates conversation / status.
    pub fn poll_events(&mut self) -> Option<CopilotEvent> {
        let rx = self.event_rx.as_ref()?;
        let mut latest_event = None;
        while let Ok(event) = rx.try_recv() {
            match &event {
                CopilotEvent::Progress { agent, phase, step, total, detail } => {
                    self.status.current_agent = *agent;
                    self.status.description = format!("{phase}: {detail}");
                    self.status.completed_steps = *step;
                    self.status.total_steps = *total;
                    self.status.is_active = true;
                }
                CopilotEvent::PlanReady { summary, .. } => {
                    self.messages.push(ChatMessage {
                        id: format!("plan-{}", self.messages.len()),
                        role: MessageRole::Assistant,
                        text: format!("📐 **Kế hoạch kiến trúc (Architect Planner):**\n{summary}"),
                        timestamp: "Đang xử lý".to_string(),
                        interactive_handles: Vec::new(),
                        interactive_coords: Vec::new(),
                        can_undo: false,
                        can_audit_fix: false,
                        can_evolve: false,
                    });
                }
                CopilotEvent::BatchExecuted { phase_name, completed_steps, total_steps, handles } => {
                    self.status.current_agent = AgentKind::Execution;
                    self.status.description = format!("Đang vẽ: {phase_name} ({completed_steps}/{total_steps})");
                    self.status.completed_steps = *completed_steps;
                    self.status.total_steps = *total_steps;

                    if !handles.is_empty() {
                        self.messages.push(ChatMessage {
                            id: format!("batch-{}", self.messages.len()),
                            role: MessageRole::Assistant,
                            text: format!("⚡ **Thực thi:** Hoàn thành `{phase_name}` ({} thực thể tạo mới).", handles.len()),
                            timestamp: "Vừa xong".to_string(),
                            interactive_handles: handles.clone(),
                            interactive_coords: Vec::new(),
                            can_undo: true,
                            can_audit_fix: true,
                            can_evolve: false,
                        });
                    }
                }
                CopilotEvent::QaReport { verdict, issues, .. } => {
                    self.status.current_agent = AgentKind::QaCritic;
                    let issue_text = if issues.is_empty() {
                        "Không phát hiện lỗi va chạm hay toàn vẹn hình học.".to_string()
                    } else {
                        format!("Phát hiện {} vấn đề:\n- {}", issues.len(), issues.join("\n- "))
                    };
                    self.messages.push(ChatMessage {
                        id: format!("qa-{}", self.messages.len()),
                        role: MessageRole::Assistant,
                        text: format!("🔍 **Kiểm định QA & Vision:** `{verdict}`\n{issue_text}"),
                        timestamp: "Vừa xong".to_string(),
                        interactive_handles: Vec::new(),
                        interactive_coords: Vec::new(),
                        can_undo: false,
                        can_audit_fix: true,
                        can_evolve: true,
                    });
                }
                CopilotEvent::EvolutionProposed { next_phase, missing } => {
                    self.status.current_agent = AgentKind::Evolution;
                    let missing_str = if missing.is_empty() {
                        "Đã thỏa mãn đầy đủ các yêu cầu cốt lõi.".to_string()
                    } else {
                        format!("Hạng mục đề xuất bổ sung: {}", missing.join(", "))
                    };
                    self.messages.push(ChatMessage {
                        id: format!("evolve-{}", self.messages.len()),
                        role: MessageRole::Assistant,
                        text: format!("🌱 **Bước tiến hóa tiếp theo (Evolution):**\nĐề xuất: `{next_phase}`\n{missing_str}"),
                        timestamp: "Vừa xong".to_string(),
                        interactive_handles: Vec::new(),
                        interactive_coords: Vec::new(),
                        can_undo: false,
                        can_audit_fix: false,
                        can_evolve: true,
                    });
                }
                CopilotEvent::Completed { message, created_handles, .. } => {
                    self.is_busy = false;
                    self.status.is_active = false;
                    self.status.current_agent = AgentKind::Idle;
                    self.status.description = "Hoàn thành quy trình thiết kế.".to_string();
                    self.stop_signal = None;
                    self.messages.push(ChatMessage {
                        id: format!("complete-{}", self.messages.len()),
                        role: MessageRole::Assistant,
                        text: format!("✅ **Hoàn thành:** {message}"),
                        timestamp: "Vừa xong".to_string(),
                        interactive_handles: created_handles.clone(),
                        interactive_coords: Vec::new(),
                        can_undo: true,
                        can_audit_fix: true,
                        can_evolve: true,
                    });
                }
                CopilotEvent::Error { error } => {
                    self.is_busy = false;
                    self.status.is_active = false;
                    self.status.current_agent = AgentKind::Idle;
                    self.status.description = format!("Lỗi: {error}");
                    self.stop_signal = None;
                    self.messages.push(ChatMessage {
                        id: format!("err-{}", self.messages.len()),
                        role: MessageRole::System,
                        text: format!("❌ **Lỗi thực thi:** {error}"),
                        timestamp: "Vừa xong".to_string(),
                        interactive_handles: Vec::new(),
                        interactive_coords: Vec::new(),
                        can_undo: false,
                        can_audit_fix: false,
                        can_evolve: false,
                    });
                }
                CopilotEvent::Stopped => {
                    self.is_busy = false;
                    self.status.is_active = false;
                    self.status.current_agent = AgentKind::Idle;
                    self.status.description = "Đã dừng tác vụ AI theo yêu cầu.".to_string();
                    self.stop_signal = None;
                    self.messages.push(ChatMessage {
                        id: format!("stop-{}", self.messages.len()),
                        role: MessageRole::System,
                        text: "⏹ **Đã dừng:** Tiến trình AI Copilot đã được dừng lại theo yêu cầu của bạn.".to_string(),
                        timestamp: "Vừa xong".to_string(),
                        interactive_handles: Vec::new(),
                        interactive_coords: Vec::new(),
                        can_undo: false,
                        can_audit_fix: false,
                        can_evolve: false,
                    });
                }
            }
            latest_event = Some(event);
        }
        latest_event
    }
}
