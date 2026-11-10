use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ocs_ai_worker::{
    bridge::CadSession,
    orchestrator::file_sha256,
    spatial::{self, MasterArchitecturalPlan, Phase},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Deserialize)]
struct View {
    name: String,
    bounds: [f64; 4],
}

fn write(path: &Path, value: &Value) -> Result<()> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn check(result: &Value) -> Result<()> {
    ensure!(result["ok"] != false, "CAD refused operation: {result}");
    ensure!(
        result["failed_steps"].as_u64().unwrap_or(0) == 0,
        "CAD batch failed: {result}"
    );
    ensure!(
        result["attention"].as_array().is_none_or(|v| v.is_empty()),
        "CAD batch requires attention: {result}"
    );
    ensure!(
        !["failed", "running", "waiting_input", "cancelled"]
            .contains(&result["status"].as_str().unwrap_or("")),
        "CAD operation incomplete: {result}"
    );
    if let Some(value) = result.get("result") {
        check(value)?;
    }
    Ok(())
}

fn execute(cad: &mut CadSession, request: Value, output: &Path, label: &str) -> Result<Value> {
    let id = format!("house-{}", Uuid::new_v4());
    write(
        &output.join(format!("{label}-prepared.json")),
        &json!({"request_id":id,"session_id":cad.session_id,"document_id":cad.document_id,"revision":cad.revision,"request":request}),
    )?;
    let result = cad.execute(request, &id).with_context(|| {
        format!("{label}: ambiguous or refused operation; DO NOT automatically replay")
    })?;
    write(&output.join(format!("{label}-result.json")), &result)?;
    check(&result)?;
    Ok(result)
}

fn capture(cad: &mut CadSession, output: &Path, name: &str, mut args: Value) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "unsafe view filename"
    );
    args["ocs_session_id"] = json!(cad.session_id);
    args["max_dimension"] = json!(2400);
    args["scope"] = json!("viewport");
    args["delivery"] = json!("inline");
    let result = cad.client.call_tool("ocs_render", args)?;
    ensure!(result["isError"] != true, "render failed: {result}");
    let encoded = result["content"]
        .as_array()
        .context("render has no content")?
        .iter()
        .find(|x| x["type"] == "image" && x["mimeType"] == "image/png")
        .and_then(|x| x["data"].as_str())
        .context("render returned no actual PNG")?;
    let bytes = STANDARD.decode(encoded)?;
    ensure!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "render is not PNG");
    fs::write(output.join(format!("{name}.png")), bytes)?;
    Ok(())
}

fn main() -> Result<()> {
    let source = fs::canonicalize(
        env::args_os()
            .nth(1)
            .context("usage: execute_phases <plan-directory>")?,
    )?;
    let plan: MasterArchitecturalPlan =
        serde_json::from_slice(&fs::read(source.join("plan.json"))?)?;
    spatial::validate(&plan)?;
    let phases: Vec<Phase> = serde_json::from_slice(&fs::read(source.join("phases.json"))?)?;
    let compiled = spatial::compile(&plan)?;
    ensure!(
        phases.len() >= compiled.len(),
        "phase file is missing compiled geometry"
    );
    ensure!(
        serde_json::to_value(&phases[..compiled.len()])? == serde_json::to_value(&compiled)?,
        "phase prefix does not match validated deterministic plan"
    );
    let views: Vec<View> = serde_json::from_slice(&fs::read(source.join("views.json"))?)?;
    let executable =
        fs::canonicalize(env::var_os("OCS_EXECUTABLE").context("OCS_EXECUTABLE required")?)?;
    let session =
        env::var("OCS_SESSION_ID").context("explicit dedicated OCS_SESSION_ID required")?;
    let output = source.join("actual");
    let finalize = env::args().nth(2).as_deref() == Some("--finalize");
    if finalize {
        ensure!(output.is_dir(), "no prior execution artifacts");
    } else {
        fs::create_dir(&output)
            .context("output exists; inspect prior artifacts instead of replaying a drawing")?;
    }
    let start = Instant::now();
    let mut cad = CadSession::connect(&executable, Duration::from_secs(900), Some(&session))?;
    if finalize {
        let mut expected_doc = None;
        let mut expected_revision = None;
        for (index, phase) in phases.iter().enumerate() {
            let prepared: Value = serde_json::from_slice(&fs::read(
                output.join(format!("phase-{index:03}-prepared.json")),
            )?)?;
            let result: Value = serde_json::from_slice(&fs::read(
                output.join(format!("phase-{index:03}-result.json")),
            )?)?;
            check(&result)?;
            ensure!(
                prepared["session_id"] == cad.session_id
                    && prepared["request"]["steps"] == json!(phase.steps),
                "prior execution does not match current session/plan"
            );
            ensure!(
                result["completed_steps"].as_u64() == Some(phase.steps.len() as u64),
                "cannot finalize incomplete batch"
            );
            expected_doc = prepared["document_id"].as_u64();
            expected_revision = result
                .pointer("/state/revision")
                .and_then(Value::as_u64)
                .or_else(|| result["revision"].as_u64());
        }
        ensure!(
            expected_doc.is_some() && cad.document_id == expected_doc,
            "active document differs from acknowledged execution"
        );
        let state = cad.read("state", json!({}))?;
        ensure!(
            state["command"].is_null() && state["operation"].is_null(),
            "prior CAD command still active"
        );
        if let Some(revision) = expected_revision {
            ensure!(
                state["revision"].as_u64() == Some(revision),
                "document changed after acknowledged batch"
            );
        }
        println!("Finalizing acknowledged geometry only: no drawing mutation is replayed.");
    } else {
        execute(&mut cad, json!({"op":"new"}), &output, "initialize")?;
        for (index, phase) in phases.iter().enumerate() {
            println!(
                "[{}/{}] {}: {} actual CAD steps; elapsed {:.1}s",
                index + 1,
                phases.len(),
                phase.name,
                phase.steps.len(),
                start.elapsed().as_secs_f64()
            );
            let result = execute(
                &mut cad,
                json!({"op":"batch","steps":phase.steps}),
                &output,
                &format!("phase-{index:03}"),
            )?;
            ensure!(
                result["completed_steps"].as_u64() == Some(phase.steps.len() as u64),
                "actual batch has incomplete steps"
            );
        }
    }
    let mut solids = Vec::new();
    for layer in ["A-3D-SLAB", "A-3D-WALL", "A-3D-ROOF"] {
        let entities = cad.read(
            "query",
            json!({"layer":layer,"type":"3D Solid","detail":"full","fields":["handle","type","bounds"],"limit":128}),
        )?;
        write(&output.join(format!("{layer}-query.json")), &entities)?;
        ensure!(
            entities["next_offset"].is_null(),
            "solid query requires pagination"
        );
        for entity in entities["entities"]
            .as_array()
            .context("query has no entities")?
        {
            solids.push(entity["handle"].clone());
        }
    }
    ensure!(!solids.is_empty(), "no actual building solids");
    let measured = cad.read("measure", json!({"handles":solids}))?;
    write(&output.join("building-kernel-measurements.json"), &measured)?;
    for entity in measured["measurements"]
        .as_array()
        .context("missing building measurements")?
    {
        ensure!(
            entity
                .pointer("/mesh/volume")
                .and_then(Value::as_f64)
                .is_some_and(|v| v.is_finite() && v > 0.0),
            "building component has no positive actual BREP volume"
        );
    }
    let audit = cad.audit(json!({"target_format":"dwg","target_version":"2000"}))?;
    write(&output.join("audit.json"), &audit)?;
    ensure!(
        audit["ok"] == true && audit.pointer("/target/lossless") == Some(&json!(true)),
        "actual CAD audit failed: {audit}"
    );
    execute(
        &mut cad,
        json!({"op":"run","cmd":"UCS WORLD"}),
        &output,
        "world",
    )?;
    execute(
        &mut cad,
        json!({"op":"run","cmd":"PLAN WORLD"}),
        &output,
        "top-view",
    )?;
    capture(&mut cad, &output, "all-drawings", json!({"view":"extents"}))?;
    for view in views {
        ensure!(
            view.bounds.iter().all(|n| n.is_finite())
                && view.bounds[0] < view.bounds[2]
                && view.bounds[1] < view.bounds[3],
            "invalid view bounds"
        );
        capture(
            &mut cad,
            &output,
            &view.name,
            json!({"view":"region","bounds":view.bounds}),
        )?;
    }
    execute(
        &mut cad,
        json!({"op":"action","name":"view_home"}),
        &output,
        "isometric",
    )?;
    capture(
        &mut cad,
        &output,
        "building-3d",
        json!({"view":"selection","focus_handles":solids}),
    )?;
    execute(
        &mut cad,
        json!({"op":"run","cmd":"PLAN WORLD"}),
        &output,
        "restore-top",
    )?;
    let mut deliveries = Vec::new();
    for format in ["dwg", "dxf"] {
        let path = output.join(format!("nha-4-tang-10x15m.{format}"));
        let saved = execute(
            &mut cad,
            json!({"op":"save_verified","path":path,"target_format":format,"target_version":"2000","overwrite":false}),
            &output,
            &format!("delivery-{format}"),
        )?;
        let result = saved.get("result").unwrap_or(&saved);
        ensure!(result["verified"] == true, "delivery not verified");
        let hash = file_sha256(&path)?;
        ensure!(
            result["sha256"].as_str() == Some(&hash),
            "independent output SHA-256 mismatch"
        );
        deliveries.push(
            json!({"path":path,"bytes":fs::metadata(&path)?.len(),"sha256":hash,"verified":true}),
        );
    }
    write(
        &output.join("report.json"),
        &json!({"ok":true,"session_id":cad.session_id,"document_id":cad.document_id,"floors":plan.levels.len(),"footprint_mm":[plan.grid.x.last(),plan.grid.y.last()],"phases":phases.len(),"elapsed_seconds":start.elapsed().as_secs_f64(),"deliveries":deliveries,"professional_review_required":true}),
    )?;
    println!(
        "Actual four-storey building measured, audited and saved: {}",
        output.display()
    );
    Ok(())
}
