use anyhow::{ensure, Context, Result};
use ocs_ai_worker::{
    bridge::CadSession,
    openai::OpenAi,
    orchestrator::file_sha256,
    queue::{JobSpec, Queue},
    spatial::{self, MasterArchitecturalPlan},
};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf, process::Command, time::Duration};
use uuid::Uuid;

fn executable() -> Result<PathBuf> {
    fs::canonicalize(
        env::var_os("OCS_EXECUTABLE")
            .context("set OCS_EXECUTABLE to the real native editor binary")?,
    )
    .context("resolve native editor")
}

#[test]
#[ignore = "requires a real desktop OpenCADStudio editor; creates a new drawing and verified DXF"]
fn mcp_batch_measure_render_audit_verified_save() -> Result<()> {
    let mut cad = CadSession::connect(
        &executable()?,
        Duration::from_secs(300),
        env::var("OCS_SESSION_ID").ok().as_deref(),
    )?;
    let dir = tempfile::tempdir()?;
    cad.execute(json!({"op":"new"}), &Uuid::new_v4().to_string())?;
    let id = Uuid::new_v4().to_string();
    let request = json!({"op":"batch","steps":[{"op":"run","cmd":"PLINE 0,0 6000,0 6000,8000 0,8000 C"},{"op":"run","cmd":"CIRCLE 3000,4000 500"}]});
    let result = cad.execute(request.clone(), &id)?;
    ensure!(
        result["completed_steps"] == 2,
        "real batch did not finish: {result}"
    );
    let repeated = cad.execute(request, &id)?;
    ensure!(result == repeated, "idempotent replay changed result");
    let page=cad.read("records",json!({"collection":"entities","type":"Circle","paths":["/center","/radius"],"where":[{"path":"/radius","op":"eq","value":500.0}],"limit":128}))?;
    ensure!(
        page["count"] == 1,
        "projected records did not find actual circle: {page}"
    );
    let handles: Vec<Value> = page["records"]
        .as_array()
        .context("no records")?
        .iter()
        .map(|e| e["handle"].clone())
        .collect();
    let measure = cad.read("measure", json!({"handles":handles}))?;
    let area = measure
        .pointer("/measurements/0/curve/area")
        .and_then(Value::as_f64)
        .context("kernel returned no circle area")?;
    ensure!(
        (area - std::f64::consts::PI * 500.0 * 500.0).abs() < 1e-3,
        "actual kernel area differs"
    );
    let png = cad.render_png(1200)?;
    ensure!(
        png.starts_with(b"\x89PNG\r\n\x1a\n"),
        "render did not return PNG"
    );
    fs::write(dir.path().join("render.png"), &png)?;
    let audit = cad.read(
        "audit",
        json!({"target_format":"dxf","target_version":"2000"}),
    )?;
    ensure!(
        audit["ok"] == true && audit["target"]["lossless"] == true,
        "real audit failed: {audit}"
    );
    let path = dir.path().join("verified.dxf");
    let saved=cad.execute(json!({"op":"save_verified","path":path,"target_format":"dxf","target_version":"2000","overwrite":false}),&Uuid::new_v4().to_string())?;
    ensure!(
        saved.get("result").unwrap_or(&saved)["verified"] == true,
        "actual save was not verified: {saved}"
    );
    ensure!(path.is_file(), "verified DXF is missing");
    Ok(())
}

#[test]
#[ignore = "calls the real configured OpenAI endpoint; consumes API tokens"]
fn openai_structured_output() -> Result<()> {
    let ai = OpenAi::from_env()?;
    let result:Value=ai.structured("live_check",json!({"type":"object","properties":{"ready":{"type":"boolean"}},"required":["ready"],"additionalProperties":false}),"Return ready=true for this real connectivity check.",json!("Test strict structured outputs."),false)?;
    ensure!(result["ready"] == true, "OpenAI did not confirm readiness");
    Ok(())
}

#[test]
#[ignore = "full real Prompt-to-CAD worker E2E; requires desktop editor and real OpenAI Vision/tool support; consumes tokens"]
fn prompt_to_verified_cad_worker() -> Result<()> {
    let binary = env!("CARGO_BIN_EXE_ocs-ai-worker");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/ai-worker-e2e");
    fs::create_dir_all(&root)?;
    let directory = fs::canonicalize(root)?.join(Uuid::new_v4().to_string());
    fs::create_dir(&directory)?;
    let database = directory.join("jobs.sqlite");
    let queue = Queue::open(&database)?;
    let prompt=env::var("OCS_AI_E2E_PROMPT").unwrap_or_else(|_|"Design a simple one-storey 6000 by 8000 mm architectural concept in millimetres, split into a living room and kitchen by a partition, with one 900 mm external door and one 900 mm internal door. Use a 2 by 2 structural bay grid if necessary to support the room split, no furniture and no stairs. Include 200 mm exterior walls, 100 mm partitions, grid, columns, actual 3D floor slab/walls/flat roof, dimensions and room labels. Keep the first test compact.".into());
    let id = queue.enqueue(
        &JobSpec {
            prompt,
            input: None,
            output_format: "dxf".into(),
            output_version: "2000".into(),
            max_corrections: 2,
            max_evolution_steps: 2,
        },
        &directory,
    )?;
    eprintln!("Live E2E artifacts: {}", directory.display());
    let mut command = Command::new(binary);
    command
        .arg("--database")
        .arg(&database)
        .arg("daemon")
        .arg("--executable")
        .arg(executable()?)
        .arg("--once");

    if let Ok(session) = env::var("OCS_SESSION_ID") {
        command.arg("--session").arg(session);
    }
    let status = command.status()?;
    let job = queue.get(&id)?;
    ensure!(
        status.success() && job.status == "completed",
        "real worker did not complete: {}",
        job.error.unwrap_or_else(|| job.status.clone())
    );
    let report: Value = serde_json::from_slice(&fs::read(job.output.join("report.json"))?)?;
    ensure!(report["ok"] == true, "worker report failed");
    ensure!(
        report["sha256"].as_str().is_some_and(|s| s.len() == 64),
        "missing SHA-256"
    );
    ensure!(
        job.output.join("drawing.dxf").is_file(),
        "real output missing"
    );
    Ok(())
}

#[test]
#[ignore = "calls real OpenAI planner and validates/compiles its architectural plan; consumes tokens"]
fn openai_parametric_planner() -> Result<()> {
    let ai = OpenAi::from_env()?;
    let plan:MasterArchitecturalPlan=ai.structured("live_architectural_plan",spatial::plan_schema(),spatial::planning_constraints(),json!("Produce a simple single room 6000 x 6000 mm studio, ground level height 3000 mm, one 900mm south external door with sill 0 height 2200mm offset 1000mm, no furniture and no stairs. Include a real roof, slab and columns using the supported model."),false)?;
    spatial::validate(&plan)?;
    let phases = spatial::compile(&plan)?;
    ensure!(
        !phases.is_empty() && phases.iter().all(|p| !p.steps.is_empty()),
        "planner produced no executable phases"
    );
    Ok(())
}

#[test]
#[ignore = "real OpenAI function calling followed by a real MCP capability read"]
fn openai_function_call_reads_real_cad() -> Result<()> {
    let mut cad = CadSession::connect(
        &executable()?,
        Duration::from_secs(300),
        env::var("OCS_SESSION_ID").ok().as_deref(),
    )?;
    let ai = OpenAi::from_env()?;
    let tool = cad
        .client
        .tools()?
        .into_iter()
        .find(|t| t["name"] == "ocs_read")
        .context("server did not advertise ocs_read")?;
    let tools = vec![
        json!({"type":"function","function":{"name":tool["name"],"description":tool["description"],"parameters":tool["inputSchema"]}}),
    ];
    let message=ai.completion(&ai.model,&[json!({"role":"system","content":"You must call the supplied ocs_read function with op=capabilities. Do not answer from memory."}),json!({"role":"user","content":format!("Read real CAD capabilities from session {} now.",cad.session_id)})],None,&tools)?;
    let calls = message["tool_calls"]
        .as_array()
        .context("OpenAI did not call a function")?;
    ensure!(calls.len() == 1, "expected one read-only function call");
    ensure!(
        calls[0]["function"]["name"] == "ocs_read",
        "unexpected function"
    );
    let args: Value = serde_json::from_str(
        calls[0]["function"]["arguments"]
            .as_str()
            .context("missing function arguments")?,
    )?;
    ensure!(args["op"] == "capabilities", "unexpected read op");
    let result = cad.read("capabilities", json!({}))?;
    ensure!(result["ok"] != false, "actual MCP capabilities read failed");
    Ok(())
}

#[test]
#[ignore = "real two-level EXTRUDE/SUBTRACT, stair-void kernel volume, PNG and verified DWG; no OpenAI calls"]
fn multilevel_compiler_real_stair_void() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/ai-worker-e2e");
    fs::create_dir_all(&root)?;
    let output = fs::canonicalize(root)?.join(format!("stair-{}", Uuid::new_v4()));
    fs::create_dir(&output)?;
    eprintln!("Real stair verification artifacts: {}", output.display());
    let mut plan: Value = serde_json::from_str(
        spatial::planning_constraints()
            .lines()
            .find(|s| s.starts_with("{\"name\""))
            .context("planner contract has no example")?,
    )?;
    plan["grid"] = json!({"x":[0,9000],"y":[0,9000]});
    plan["levels"] = json!([{"name":"Ground","elevation":0,"height":2975},{"name":"Upper","elevation":2975,"height":2975}]);
    plan["rooms"] = json!([{"id":"lower","name":"Lower stair","level":0,"rect":{"x0":0,"y0":0,"x1":1,"y1":1},"kind":"stair","wet_stack":null},{"id":"upper","name":"Upper stair","level":1,"rect":{"x0":0,"y0":0,"x1":1,"y1":1},"kind":"stair","wet_stack":null}]);
    plan["openings"] = json!([{"room":"lower","side":"south","kind":"door","offset":7000,"width":900,"sill":0,"height":2200,"hinge_end":false},{"room":"lower","side":"west","kind":"window","offset":6000,"width":1200,"sill":900,"height":1200,"hinge_end":false}]);
    plan["furniture"] = json!([]);
    plan["stairs"] = json!([{"lower_room":"lower","upper_room":"upper","x":500,"y":2000,"width":1000,"risers":17,"direction":"east"}]);
    let plan: MasterArchitecturalPlan = serde_json::from_value(plan)?;
    spatial::validate(&plan)?;
    let phases = spatial::compile(&plan)?;
    fs::write(
        output.join("phases.json"),
        serde_json::to_vec_pretty(&phases)?,
    )?;
    let mut cad = CadSession::connect(
        &executable()?,
        Duration::from_secs(300),
        env::var("OCS_SESSION_ID").ok().as_deref(),
    )?;
    cad.execute(json!({"op":"new"}), &Uuid::new_v4().to_string())?;
    for (index, phase) in phases.iter().enumerate() {
        let result = cad.execute(
            json!({"op":"batch","steps":phase.steps}),
            &Uuid::new_v4().to_string(),
        )?;
        fs::write(
            output.join(format!("batch-{index}.json")),
            serde_json::to_vec_pretty(&result)?,
        )?;
        ensure!(
            result["completed_steps"].as_u64() == Some(phase.steps.len() as u64)
                && result["failed_steps"] == 0
                && result["attention"].as_array().is_some_and(|a| a.is_empty()),
            "actual compiled batch incomplete: {result}"
        );
    }
    let slabs=cad.read("query",json!({"layer":"A-3D-SLAB","detail":"full","fields":["handle","type","bounds"],"limit":128}))?;
    let handles: Vec<Value> = slabs["entities"]
        .as_array()
        .context("missing actual slab entities")?
        .iter()
        .map(|e| e["handle"].clone())
        .collect();
    ensure!(!handles.is_empty(), "no actual slab solids");
    let measurements = cad.read("measure", json!({"handles":handles}))?;
    fs::write(
        output.join("slab-measurements.json"),
        serde_json::to_vec_pretty(&measurements)?,
    )?;
    let mut volume = 0.0;
    for measurement in measurements["measurements"]
        .as_array()
        .context("missing actual slab measurements")?
    {
        volume += measurement
            .pointer("/mesh/volume")
            .and_then(Value::as_f64)
            .context("slab is not a measured BREP solid")?;
    }
    let expected = 2.0 * 9300.0 * 9300.0 * 200.0 - 4000.0 * 1000.0 * 200.0;
    ensure!(
        (volume - expected).abs() < expected * 1e-6,
        "actual Boolean stair-void volume {volume}, expected {expected}"
    );
    let audit = cad.audit(json!({"target_format":"dwg","target_version":"2000"}))?;
    ensure!(audit["ok"] == true, "real multilevel audit failed: {audit}");
    fs::write(
        output.join("audit.json"),
        serde_json::to_vec_pretty(&audit)?,
    )?;
    fs::write(output.join("drawing.png"), cad.render_png(1600)?)?;
    let saved=cad.execute(json!({"op":"save_verified","path":output.join("drawing.dwg"),"target_format":"dwg","target_version":"2000","overwrite":false}),&Uuid::new_v4().to_string())?;
    let delivery = saved.get("result").unwrap_or(&saved);
    ensure!(
        delivery["verified"] == true,
        "actual multilevel verified save failed: {saved}"
    );
    ensure!(
        file_sha256(&output.join("drawing.dwg"))?
            == delivery["sha256"]
                .as_str()
                .context("missing verified hash")?,
        "independent multilevel hash mismatch"
    );
    fs::write(
        output.join("save-verified.json"),
        serde_json::to_vec_pretty(&saved)?,
    )?;
    cad.execute(
        json!({"op":"close","discard":true}),
        &Uuid::new_v4().to_string(),
    )?;
    Ok(())
}
