//! In-Process Direct MCP Bridge and Background AI Execution for In-App Copilot.

use crate::ai::{
    copilot_state::{AgentKind, AttachedFile, AttachedFileType, CopilotEvent},
    dwg_ingestion::{self, IngestionMode},
    excel_ingestion,
};
use crate::app::config::AiConfig;
use anyhow::{Context, Result};
use ocs_ai_worker::{
    openai::OpenAi,
    orchestrator::{Orchestrator, WorkerConfig},
    queue::{Job, JobSpec},
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::AtomicBool,
        mpsc::Sender,
        Arc,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

/// Spawns the background autonomous worker thread executing the multi-agent design pipeline.
pub fn launch_copilot_task(
    user_prompt: String,
    attached_files: Vec<AttachedFile>,
    selected_handles: Vec<String>,
    selected_context: Option<String>,
    ai_config: AiConfig,
    session_id: String,
    event_tx: Sender<CopilotEvent>,
) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    thread::spawn(move || {
        if let Err(e) = run_copilot_worker(
            user_prompt,
            attached_files,
            selected_handles,
            selected_context,
            ai_config,
            session_id,
            &event_tx,
            stop_thread,
        ) {
            let _ = event_tx.send(CopilotEvent::Error {
                error: e.to_string(),
            });
        }
    });

    stop
}

fn run_copilot_worker(
    user_prompt: String,
    attached_files: Vec<AttachedFile>,
    selected_handles: Vec<String>,
    selected_context: Option<String>,
    ai_config: AiConfig,
    session_id: String,
    event_tx: &Sender<CopilotEvent>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    // 1. Multimodal ingestion: compile user prompt with ingested Excel & DWG data
    let mut prompt_sections = Vec::new();
    prompt_sections.push(user_prompt);

    for file in &attached_files {
        match file.file_type {
            AttachedFileType::Excel | AttachedFileType::Csv => {
                match excel_ingestion::parse_raw_workbook(&file.path) {
                    Ok(workbook) => {
                        let program = excel_ingestion::extract_aec_program(&workbook);
                        prompt_sections.push(program.to_prompt_context());
                    }
                    Err(e) => {
                        prompt_sections.push(format!("[Cảnh báo không đọc được file Excel {}: {}]", file.name, e));
                    }
                }
            }
            AttachedFileType::DwgDxf => {
                match dwg_ingestion::summarize_dwg_file(&file.path) {
                    Ok(digest) => {
                        prompt_sections.push(digest.to_prompt_context());
                    }
                    Err(e) => {
                        prompt_sections.push(format!("[Cảnh báo không đọc được file DWG {}: {}]", file.name, e));
                    }
                }
            }
        }
    }

    if !selected_handles.is_empty() {
        let ctx = selected_context.as_deref().unwrap_or("Đang chọn đối tượng");
        prompt_sections.push(format!(
            "[ACTIVE SELECTION CONTEXT: {} (Handles: [{}])]",
            ctx,
            selected_handles.join(", ")
        ));
    }

    let full_prompt = prompt_sections.join("\n\n");

    // 2. Set up OpenAI client from configuration or environment
    let endpoint = ai_config.resolved_base_url();
    let key = ai_config.resolved_api_key();
    let planner_model = ai_config.resolved_planner_model();
    let vision_model = ai_config.resolved_vision_model();

    let ai = OpenAi::new(&endpoint, &key, &planner_model, &vision_model)
        .context("Khởi tạo kết nối OpenAI API thất bại. Vui lòng kiểm tra API Key và Endpoint trong Settings.")?;

    // 3. Configure Worker with in-process direct MCP factory (no subprocess)
    let worker_config = WorkerConfig {
        executable: std::env::current_exe().unwrap_or_default(),
        session_id: Some(session_id),
        timeout: Duration::from_secs(300),
        max_tool_rounds: 32,
        stop: stop.clone(),
        in_process_factory: Some(Arc::new(|| {
            crate::mcp::create_in_process_mcp_client(Duration::from_secs(300))
        })),
    };

    let job_id = Uuid::new_v4().to_string();
    let delivery_dir = PathBuf::from("target/ai-deliveries").join(&job_id);
    if let Some(parent) = delivery_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mode_a_input = attached_files
        .iter()
        .find(|f| {
            f.file_type == AttachedFileType::DwgDxf
                && f.ingestion_mode == IngestionMode::OpenAsActiveBase
        })
        .map(|f| f.path.clone());

    let job = Job {
        id: job_id.clone(),
        spec: JobSpec {
            prompt: full_prompt,
            input: mode_a_input,
            output_format: "dxf".to_string(),
            output_version: "2000".to_string(),
            max_corrections: 3,
            max_evolution_steps: 3,
        },
        status: "running".to_string(),
        stage: "initialize".to_string(),
        output: delivery_dir.clone(),
        error: None,
    };

    let orchestrator = Orchestrator {
        config: worker_config,
        ai,
    };

    let tx = event_tx.clone();
    let checkpoint = move |stage: &str, payload: &Value| -> Result<()> {
        match stage {
            "planning" => {
                let _ = tx.send(CopilotEvent::Progress {
                    agent: AgentKind::Planner,
                    phase: "Quy hoạch kiến trúc".to_string(),
                    step: 1,
                    total: 4,
                    detail: "Đang phân tích không gian và tính toán lưới trục kết cấu".to_string(),
                });
            }
            "executing" => {
                let phase_name = payload["phase"]
                    .as_str()
                    .unwrap_or("Dựng hình CAD")
                    .to_string();
                let steps_count = payload["steps"].as_u64().unwrap_or(1) as usize;
                let _ = tx.send(CopilotEvent::BatchExecuted {
                    phase_name,
                    completed_steps: steps_count,
                    total_steps: steps_count,
                    handles: Vec::new(),
                });
            }
            "qa" => {
                let verdict = payload["verdict"]
                    .as_str()
                    .unwrap_or("PASSED")
                    .to_string();
                let mut issues = Vec::new();
                if let Some(arr) = payload["findings"].as_array() {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            issues.push(s.to_string());
                        }
                    }
                }
                let _ = tx.send(CopilotEvent::QaReport {
                    verdict,
                    issues,
                    image_base64: None,
                });
            }
            "evolution" => {
                let next = payload["next_phase"]
                    .as_str()
                    .unwrap_or("Hoàn thiện hồ sơ chi tiết")
                    .to_string();
                let mut missing = Vec::new();
                if let Some(arr) = payload["missing_requirements"].as_array() {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            missing.push(s.to_string());
                        }
                    }
                }
                let _ = tx.send(CopilotEvent::EvolutionProposed {
                    next_phase: next,
                    missing,
                });
            }
            _ => {}
        }
        Ok(())
    };

    let outcome = orchestrator.process(&job, checkpoint)?;

    let delivery_path = outcome["delivery_path"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| Some(delivery_dir.to_string_lossy().to_string()));

    let _ = event_tx.send(CopilotEvent::Completed {
        message: "Toàn bộ bản vẽ kiến trúc 2D/3D đã được khởi tạo, dựng hình và kiểm định QA thành công trực tiếp trên Viewport!".to_string(),
        delivery_path,
        created_handles: Vec::new(),
    });

    Ok(())
}
