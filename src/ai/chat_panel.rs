//! In-App AI Copilot Panel UI (Iced View & Interactions).

use crate::ai::{
    copilot_state::{AttachedFileType, ChatMessage, CopilotState, MessageRole},
    dwg_ingestion::IngestionMode,
};
use crate::app::config::AiConfig;
use crate::app::Message;
use iced::widget::{
    button, column, container, row, scrollable, text, text_input, Space,
};
use iced::{Alignment, Background, Border, Color, Element, Fill, Length, Theme};

/// Messages emitted by the AI Copilot Panel UI.
#[derive(Debug, Clone)]
pub enum AiCopilotMsg {
    InputChanged(String),
    SendMessage,
    AttachFiles,
    RemoveAttachedFile(usize),
    ToggleDwgMode(usize),
    ClickHandle(String),
    UndoBatch,
    AuditAndFix,
    EvolveNext,
    ToggleQuickSettings,
    ApiKeyChanged(String),
    BaseUrlChanged(String),
    PlannerModelChanged(String),
    VisionModelChanged(String),
    PollTick,
}

/// Renders the complete In-App AI Copilot docked panel.
pub fn view_copilot_panel<'a>(
    state: &'a CopilotState,
    config: &'a AiConfig,
    width: f32,
) -> Element<'a, Message> {
    let mut root = column![].spacing(6).padding(8).width(width);

    // 1. Header bar
    let header = render_header(state);
    root = root.push(header);

    // 2. Quick Settings Section (if toggled open)
    if state.quick_settings_open {
        let settings_box = render_quick_settings(config);
        root = root.push(settings_box);
    }

    // 3. Live Agent Status Card (if running)
    if state.status.is_active {
        let status_card = render_agent_status_card(&state.status);
        root = root.push(status_card);
    }

    // 4. Conversation History
    let history_box = render_message_history(&state.messages);
    root = root.push(history_box);

    // 5. Active Selection Context Banner (if any entities selected)
    if let Some(ctx_text) = &state.selected_context_summary {
        let sel_banner = container(
            row![
                text("🎯").size(14),
                text(ctx_text).size(12).color(Color::from_rgb(0.2, 0.7, 0.9)),
            ]
            .spacing(6)
            .align_y(Alignment::Center),
        )
        .padding(6)
        .style(|_theme: &Theme| {
            container::Style {
                background: Some(Background::Color(Color::from_rgba(0.1, 0.3, 0.4, 0.3))),
                border: Border {
                    color: Color::from_rgb(0.2, 0.5, 0.7),
                    width: 1.0,
                    radius: 4.0.into(),
                },
                ..Default::default()
            }
        });
        root = root.push(sel_banner);
    }

    // 6. Attached Files Row (Chips)
    if !state.attached_files.is_empty() {
        let mut files_col = column![].spacing(4);
        for (idx, file) in state.attached_files.iter().enumerate() {
            let icon = match file.file_type {
                AttachedFileType::Excel => "📊",
                AttachedFileType::DwgDxf => "📐",
                AttachedFileType::Csv => "📄",
            };

            let mode_tag = match file.file_type {
                AttachedFileType::DwgDxf => {
                    let mode_str = match file.ingestion_mode {
                        IngestionMode::OpenAsActiveBase => "Mode A (Mở nền)",
                        IngestionMode::MergeIntoCurrent => "Mode B (Gộp Blocks)",
                    };
                    Some(
                        button(text(mode_str).size(10))
                            .on_press(Message::AiCopilot(AiCopilotMsg::ToggleDwgMode(idx)))
                            .padding([2, 4]),
                    )
                }
                _ => None,
            };

            let mut chip_row = row![
                text(icon).size(12),
                text(&file.name).size(11).width(Length::Fill),
            ]
            .spacing(4)
            .align_y(Alignment::Center);

            if let Some(m_btn) = mode_tag {
                chip_row = chip_row.push(m_btn);
            }

            let remove_btn = button(text("✕").size(10))
                .on_press(Message::AiCopilot(AiCopilotMsg::RemoveAttachedFile(idx)))
                .padding([2, 4]);

            chip_row = chip_row.push(remove_btn);

            let chip_card = container(chip_row)
                .padding([3, 6])
                .style(|_theme: &Theme| container::Style {
                    background: Some(Background::Color(Color::from_rgba(0.2, 0.25, 0.3, 0.5))),
                    border: Border {
                        color: Color::from_rgba(0.4, 0.5, 0.6, 0.4),
                        width: 1.0,
                        radius: 4.0.into(),
                    },
                    ..Default::default()
                });

            files_col = files_col.push(chip_card);
        }
        root = root.push(files_col);
    }

    // 7. Multimodal Input Bar
    let input_bar = render_input_bar(state);
    root = root.push(input_bar);

    container(root)
        .width(width)
        .height(Fill)
        .style(|_theme: &Theme| {
            container::Style {
                background: Some(Background::Color(Color::from_rgb(0.11, 0.13, 0.16))),
                ..Default::default()
            }
        })
        .into()
}

fn render_header<'a>(state: &'a CopilotState) -> Element<'a, Message> {
    let status_color = if state.is_busy {
        Color::from_rgb(0.2, 0.6, 1.0) // Pulsing blue
    } else {
        Color::from_rgb(0.3, 0.8, 0.3) // Ready green
    };

    let status_text = if state.is_busy {
        "Đang chạy Agent..."
    } else {
        "Sẵn sàng"
    };

    let title_row = row![
        text("🤖 AI Copilot").size(15),
        Space::new().width(Fill),
        container(row![
            text("●").size(10).color(status_color),
            text(status_text).size(11).color(status_color),
        ].spacing(4).align_y(Alignment::Center)).padding([2, 6]),
        button(text("⚙").size(14))
            .on_press(Message::AiCopilot(AiCopilotMsg::ToggleQuickSettings))
            .padding([2, 6]),
    ]
    .align_y(Alignment::Center)
    .spacing(6);

    container(title_row)
        .padding([4, 6])
        .style(|_theme: &Theme| {
            container::Style {
                background: Some(Background::Color(Color::from_rgb(0.16, 0.19, 0.23))),
                border: Border {
                    color: Color::from_rgb(0.24, 0.28, 0.34),
                    width: 1.0,
                    radius: 4.0.into(),
                },
                ..Default::default()
            }
        })
        .into()
}

fn render_quick_settings<'a>(config: &'a AiConfig) -> Element<'a, Message> {
    let _key_display = if config.api_key.is_empty() {
        "Dùng $OPENAI_API_KEY từ env".to_string()
    } else {
        format!("{}...{}", &config.api_key[..3.min(config.api_key.len())], &config.api_key[config.api_key.len().saturating_sub(4)..])
    };

    let settings_col = column![
        text("Cấu hình AI OpenAI / Custom API:").size(12),
        column![
            text("API Key:").size(10),
            text_input("Nhập OpenAI API Key...", &config.api_key)
                .on_input(|s| Message::AiCopilot(AiCopilotMsg::ApiKeyChanged(s)))
                .padding(4)
                .size(11),
        ].spacing(2),
        column![
            text("Endpoint Base URL:").size(10),
            text_input("https://api.openai.com/v1", &config.base_url)
                .on_input(|s| Message::AiCopilot(AiCopilotMsg::BaseUrlChanged(s)))
                .padding(4)
                .size(11),
        ].spacing(2),
        column![
            text("Planner Model:").size(10),
            text_input("gpt-4o", &config.planner_model)
                .on_input(|s| Message::AiCopilot(AiCopilotMsg::PlannerModelChanged(s)))
                .padding(4)
                .size(11),
        ].spacing(2),
        column![
            text("Vision QA Model:").size(10),
            text_input("gpt-4o", &config.vision_model)
                .on_input(|s| Message::AiCopilot(AiCopilotMsg::VisionModelChanged(s)))
                .padding(4)
                .size(11),
        ].spacing(2),
    ]
    .spacing(6);

    container(settings_col)
        .padding(8)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(Color::from_rgba(0.15, 0.2, 0.25, 0.7))),
            border: Border {
                color: Color::from_rgba(0.3, 0.5, 0.7, 0.5),
                width: 1.0,
                radius: 4.0.into(),
            },
            ..Default::default()
        })
        .into()
}

fn render_agent_status_card<'a>(
    status: &'a crate::ai::copilot_state::AgentExecutionStatus,
) -> Element<'a, Message> {
    let agent_badge = status.current_agent.badge_title();
    let card = column![
        row![
            text("⚡").size(12),
            text(agent_badge).size(12),
            Space::new().width(Fill),
            text(format!("{}/{} steps", status.completed_steps, status.total_steps)).size(11),
        ].align_y(Alignment::Center),
        text(&status.description).size(11).color(Color::from_rgb(0.7, 0.8, 0.9)),
    ]
    .spacing(4);

    container(card)
        .padding(8)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(Color::from_rgba(0.1, 0.3, 0.5, 0.4))),
            border: Border {
                color: Color::from_rgb(0.2, 0.6, 0.9),
                width: 1.5,
                radius: 6.0.into(),
            },
            ..Default::default()
        })
        .into()
}

fn render_message_history<'a>(messages: &'a [ChatMessage]) -> Element<'a, Message> {
    let mut msg_list = column![].spacing(8);

    for msg in messages {
        let (bg, border_color) = match msg.role {
            MessageRole::User => (
                Color::from_rgba(0.2, 0.35, 0.5, 0.4),
                Color::from_rgba(0.3, 0.5, 0.7, 0.6),
            ),
            MessageRole::Assistant => (
                Color::from_rgba(0.15, 0.2, 0.25, 0.6),
                Color::from_rgba(0.25, 0.4, 0.55, 0.5),
            ),
            MessageRole::System => (
                Color::from_rgba(0.12, 0.15, 0.18, 0.8),
                Color::from_rgba(0.3, 0.3, 0.3, 0.5),
            ),
        };

        let mut msg_col = column![
            row![
                text(match msg.role {
                    MessageRole::User => "👤 Bạn",
                    MessageRole::Assistant => "🤖 AI Architect",
                    MessageRole::System => "⚙️ Hệ thống",
                }).size(11),
                Space::new().width(Fill),
                text(&msg.timestamp).size(10).color(Color::from_rgb(0.5, 0.5, 0.5)),
            ].align_y(Alignment::Center),
            text(&msg.text).size(12),
        ]
        .spacing(4);

        // Interactive Handle Buttons
        if !msg.interactive_handles.is_empty() {
            let mut handles_row = row![text("Chọn đối tượng:").size(10)].spacing(4).align_y(Alignment::Center);
            for h in msg.interactive_handles.iter().take(6) {
                let h_btn = button(text(format!("#{h}")).size(10))
                    .on_press(Message::AiCopilot(AiCopilotMsg::ClickHandle(h.clone())))
                    .padding([2, 5]);
                handles_row = handles_row.push(h_btn);
            }
            msg_col = msg_col.push(handles_row);
        }

        // Quick Action Buttons
        if msg.can_undo || msg.can_audit_fix || msg.can_evolve {
            let mut actions_row = row![].spacing(6).align_y(Alignment::Center);
            if msg.can_undo {
                actions_row = actions_row.push(
                    button(text("↩ Undo Batch").size(10))
                        .on_press(Message::AiCopilot(AiCopilotMsg::UndoBatch))
                        .padding([3, 6]),
                );
            }
            if msg.can_audit_fix {
                actions_row = actions_row.push(
                    button(text("🔍 Audit & Fix").size(10))
                        .on_press(Message::AiCopilot(AiCopilotMsg::AuditAndFix))
                        .padding([3, 6]),
                );
            }
            if msg.can_evolve {
                actions_row = actions_row.push(
                    button(text("🌱 Tiến hóa tiếp").size(10))
                        .on_press(Message::AiCopilot(AiCopilotMsg::EvolveNext))
                        .padding([3, 6]),
                );
            }
            msg_col = msg_col.push(actions_row);
        }

        let msg_card = container(msg_col)
            .padding(8)
            .width(Fill)
            .style(move |_theme: &Theme| container::Style {
                background: Some(Background::Color(bg)),
                border: Border {
                    color: border_color,
                    width: 1.0,
                    radius: 6.0.into(),
                },
                ..Default::default()
            });

        msg_list = msg_list.push(msg_card);
    }

    scrollable(msg_list)
        .height(Fill)
        .into()
}

fn render_input_bar<'a>(state: &'a CopilotState) -> Element<'a, Message> {
    let text_inp = text_input("Nhập prompt hoặc kéo-thả tệp .xlsx/.dwg...", &state.input_prompt)
        .on_input(|s| Message::AiCopilot(AiCopilotMsg::InputChanged(s)))
        .on_submit(Message::AiCopilot(AiCopilotMsg::SendMessage))
        .padding(8)
        .size(12)
        .width(Fill);

    let attach_btn = button(text("📎 Đính kèm").size(12))
        .on_press(Message::AiCopilot(AiCopilotMsg::AttachFiles))
        .padding([6, 8]);

    let send_btn = if state.is_busy {
        button(text("Đang chạy...").size(12)).padding([6, 12])
    } else {
        button(text("Gửi ▶").size(12))
            .on_press(Message::AiCopilot(AiCopilotMsg::SendMessage))
            .padding([6, 12])
    };

    let bar = row![
        attach_btn,
        text_inp,
        send_btn,
    ]
    .spacing(6)
    .align_y(Alignment::Center);

    container(bar)
        .padding(4)
        .into()
}
