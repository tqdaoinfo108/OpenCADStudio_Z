use anyhow::{bail, ensure, Context, Result};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{env, thread, time::Duration};

pub struct OpenAi {
    agent: ureq::Agent,
    endpoint: String,
    key: String,
    pub model: String,
    pub vision_model: String,
    pub max_completion_tokens: u32,
}

impl OpenAi {
    pub fn from_env() -> Result<Self> {
        let endpoint = completion_endpoint(
            &env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into()),
        )?;
        let key = env::var("OPENAI_API_KEY").context("OPENAI_API_KEY is required")?;
        ensure!(!key.trim().is_empty(), "OPENAI_API_KEY is empty");
        let model = env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into());
        let timeout = env::var("OCS_AI_HTTP_TIMEOUT_SECONDS")
            .unwrap_or_else(|_| "300".into())
            .parse::<u64>()?;
        ensure!(
            (10..=1800).contains(&timeout),
            "HTTP timeout must be 10..1800 seconds"
        );
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(timeout)))
            .http_status_as_error(false)
            .build();
        Ok(Self {
            agent: config.into(),
            endpoint,
            key,
            vision_model: env::var("OPENAI_VISION_MODEL").unwrap_or_else(|_| model.clone()),
            model,
            max_completion_tokens: env::var("OCS_AI_MAX_COMPLETION_TOKENS")
                .unwrap_or_else(|_| "12000".into())
                .parse()?,
        })
    }

    pub fn new(
        endpoint: &str,
        key: &str,
        model: &str,
        vision_model: &str,
    ) -> Result<Self> {
        let ep = completion_endpoint(endpoint)?;
        ensure!(!key.trim().is_empty(), "OpenAI API key cannot be empty");
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(300)))
            .http_status_as_error(false)
            .build();
        Ok(Self {
            agent: config.into(),
            endpoint: ep,
            key: key.trim().to_string(),
            model: model.to_string(),
            vision_model: vision_model.to_string(),
            max_completion_tokens: 12000,
        })
    }

    pub fn completion(
        &self,
        model: &str,
        messages: &[Value],
        response_format: Option<Value>,
        tools: &[Value],
    ) -> Result<Value> {
        let mut body = json!({"model":model,"messages":messages,"max_completion_tokens":self.max_completion_tokens});
        if let Some(format) = response_format {
            body["response_format"] = format;
        }
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
            body["parallel_tool_calls"] = json!(false);
        }
        for attempt in 0..6 {
            let response = self
                .agent
                .post(&self.endpoint)
                .header("Authorization", &format!("Bearer {}", self.key))
                .send_json(&body);
            match response {
                Ok(mut response) => {
                    let status = response.status().as_u16();
                    if (status == 408 || status == 429 || (500..600).contains(&status)) && attempt < 5 {
                        let delay = Duration::from_millis(1000 * (1 << attempt.min(4)));
                        thread::sleep(delay);
                        continue;
                    }
                    // Error bodies can echo credentials or drawing content; never include them in job logs.
                    ensure!(
                        (200..300).contains(&status),
                        "OpenAI endpoint returned HTTP {status}"
                    );
                    let value: Value = response
                        .body_mut()
                        .with_config()
                        .limit(16 * 1024 * 1024)
                        .read_json()
                        .context("invalid OpenAI response JSON")?;
                    let choice = value
                        .pointer("/choices/0")
                        .context("OpenAI response has no choice")?;
                    ensure!(
                        matches!(
                            choice["finish_reason"].as_str(),
                            Some("stop" | "tool_calls")
                        ),
                        "OpenAI completion incomplete: {}",
                        choice["finish_reason"]
                    );
                    let message = choice
                        .get("message")
                        .context("OpenAI response has no message")?;
                    ensure!(
                        message.get("refusal").is_none_or(Value::is_null),
                        "OpenAI refused this request"
                    );
                    return Ok(message.clone());
                }
                Err(_e) if attempt < 5 => {
                    let delay = Duration::from_millis(1000 * (1 << attempt.min(4)));
                    thread::sleep(delay);
                }
                Err(e) => bail!("OpenAI transport failed after retries: {e}"),
            }
        }
        bail!("OpenAI retry budget exhausted")
    }

    pub fn structured<T: DeserializeOwned>(
        &self,
        name: &str,
        schema: Value,
        system: &str,
        content: Value,
        vision: bool,
    ) -> Result<T> {
        let schema = strict_schema(schema)?;
        let messages = vec![
            json!({"role":"system","content":system}),
            json!({"role":"user","content":content}),
        ];
        let format =
            json!({"type":"json_schema","json_schema":{"name":name,"strict":true,"schema":schema}});
        let mut last_err = None;
        for attempt in 0..4 {
            let message = match self.completion(
                if vision {
                    &self.vision_model
                } else {
                    &self.model
                },
                &messages,
                Some(format.clone()),
                &[],
            ) {
                Ok(m) => m,
                Err(e) => {
                    last_err = Some(e);
                    thread::sleep(Duration::from_millis(500 * (1 << attempt.min(3))));
                    continue;
                }
            };
            let text = match message["content"].as_str() {
                Some(t) => t,
                None => {
                    last_err = Some(anyhow::anyhow!("OpenAI response has no text content"));
                    continue;
                }
            };
            let value: Value = match serde_json::from_str(text) {
                Ok(v) => v,
                Err(e) => {
                    last_err = Some(anyhow::anyhow!("OpenAI did not return valid structured JSON: {e}"));
                    continue;
                }
            };
            let validator = match jsonschema::validator_for(&format["json_schema"]["schema"]) {
                Ok(val) => val,
                Err(e) => return Err(anyhow::anyhow!("invalid local JSON schema: {e}")),
            };
            if !validator.is_valid(&value) {
                last_err = Some(anyhow::anyhow!("OpenAI response did not satisfy the requested JSON schema"));
                continue;
            }
            match serde_json::from_value(value) {
                Ok(parsed) => return Ok(parsed),
                Err(e) => {
                    last_err = Some(anyhow::anyhow!("decode OpenAI structured output: {e}"));
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("OpenAI structured completion failed after retries")))
    }
}

pub fn completion_endpoint(base: &str) -> Result<String> {
    let base = base.trim_end_matches('/');
    ensure!(
        base.starts_with("https://")
            || base.starts_with("http://127.0.0.1:")
            || base.starts_with("http://localhost:"),
        "OpenAI endpoint must use HTTPS or loopback HTTP"
    );
    ensure!(
        !base.contains('?') && !base.contains('#') && !base.contains('@'),
        "endpoint must not contain credentials, query or fragment"
    );
    Ok(if base.ends_with("/chat/completions") {
        base.into()
    } else {
        format!("{base}/chat/completions")
    })
}

pub fn strict_schema(mut schema: Value) -> Result<Value> {
    fn walk(value: &mut Value) {
        if let Some(obj) = value.as_object_mut() {
            obj.remove("$schema");
            obj.remove("default");
            if obj.get("type").and_then(Value::as_str) == Some("object")
                || obj.contains_key("properties")
            {
                obj.insert("additionalProperties".into(), json!(false));
                if let Some(props) = obj.get("properties").and_then(Value::as_object) {
                    let names: Vec<String> = props.keys().cloned().collect();
                    obj.insert("required".into(), json!(names));
                }
            }
            for v in obj.values_mut() {
                walk(v);
            }
        } else if let Some(items) = value.as_array_mut() {
            for v in items {
                walk(v);
            }
        }
    }
    walk(&mut schema);
    ensure!(
        schema.get("type").and_then(Value::as_str) == Some("object"),
        "structured response root must be object"
    );
    Ok(schema)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_accepts_full_completion_url_without_duplication() -> Result<()> {
        assert_eq!(
            completion_endpoint("http://127.0.0.1:55790/v1/chat/completions")?,
            "http://127.0.0.1:55790/v1/chat/completions"
        );
        assert_eq!(
            completion_endpoint("https://api.openai.com/v1/")?,
            "https://api.openai.com/v1/chat/completions"
        );
        assert!(completion_endpoint("http://untrusted.test/v1").is_err());
        Ok(())
    }
    #[test]
    fn nested_objects_are_strict() -> Result<()> {
        let schema = strict_schema(
            json!({"type":"object","properties":{"x":{"type":"object","properties":{"y":{"type":"number"}}}},"$defs":{"Thing":{"type":"object","properties":{}}}}),
        )?;
        assert_eq!(schema["properties"]["x"]["additionalProperties"], false);
        assert_eq!(schema["properties"]["x"]["required"], json!(["y"]));
        assert_eq!(schema["$defs"]["Thing"]["additionalProperties"], false);
        Ok(())
    }
}
