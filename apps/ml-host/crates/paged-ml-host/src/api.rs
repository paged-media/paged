/*
 * This file is part of paged (https://paged.media): paged-ml-host, the local
 * generative-image host.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! The HTTP API v1 (`/api/ml/*`): routing, the loopback guards and the
//! handlers.

use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::config::{self, Config};
use crate::http::{self, ReadError, Request, Response};
use crate::jobs::{self, JobState, Shared};
use crate::sd::{self, Inputs, JobSpec, Kind};

/// The API version `health` reports.
pub const API_VERSION: u32 = 1;
const MAX_REFERENCES: usize = 10;
const KEEPALIVE: Duration = Duration::from_secs(15);

pub fn handle_connection(shared: &Shared, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let req = match http::read_request(&stream) {
        Ok(r) => r,
        Err(ReadError::Gone) => return,
        Err(ReadError::Malformed(m)) => {
            let _ = http::write_response(&stream, &Response::error(400, "bad_request", m));
            return;
        }
        Err(ReadError::TooLarge) => {
            let _ = http::write_response(
                &stream,
                &Response::error(
                    413,
                    "too_large",
                    format!("request bodies are capped at {} bytes", http::MAX_BODY),
                ),
            );
            return;
        }
    };
    if let Err(res) = guard(shared, &req) {
        let _ = http::write_response(&stream, &res);
        return;
    }
    let cors = cors_headers(&req);
    let path = req.path.trim_end_matches('/');
    let segs: Vec<&str> = path.split('/').skip(1).collect();
    // Event streams write as they go; everything else is one response.
    if let ["api", "ml", "jobs", id, "events"] = segs.as_slice() {
        if req.method == "GET" {
            events(shared, &stream, id, &cors);
            return;
        }
    }
    let mut res = route(shared, &req, &segs);
    res.headers.extend(cors);
    let _ = http::write_response(&stream, &res);
}

fn route(shared: &Shared, req: &Request, segs: &[&str]) -> Response {
    let m = req.method.as_str();
    if m == "OPTIONS" {
        let mut res = Response {
            status: 204,
            content_type: "text/plain",
            headers: Vec::new(),
            body: Vec::new(),
        };
        res.headers.push((
            "Access-Control-Allow-Methods",
            "GET, PUT, POST, DELETE, OPTIONS".into(),
        ));
        res.headers
            .push(("Access-Control-Allow-Headers", "Content-Type".into()));
        return res;
    }
    let not_allowed = || {
        Response::error(
            405,
            "method_not_allowed",
            format!("{m} is not allowed here"),
        )
    };
    match segs {
        ["api", "ml", "health"] => match m {
            "GET" => health(shared),
            _ => not_allowed(),
        },
        ["api", "ml", "config"] => match m {
            "GET" => Response::json(200, &config_json(&shared.lock().config)),
            "PUT" => put_config(shared, &req.body),
            _ => not_allowed(),
        },
        ["api", "ml", "jobs"] => match m {
            "POST" => post_job(shared, &req.body),
            _ => not_allowed(),
        },
        ["api", "ml", "jobs", id] => match m {
            "GET" => match shared.lock().jobs.get(*id) {
                Some(job) => Response::json(200, &job.to_json()),
                None => no_job(id),
            },
            "DELETE" => {
                let mut st = shared.lock();
                let res = match st.cancel(id) {
                    Some(v) => Response::json(200, &v),
                    None => no_job(id),
                };
                shared.changed.notify_all();
                res
            }
            _ => not_allowed(),
        },
        ["api", "ml", "jobs", id, "result"] => match m {
            "GET" => result(shared, id),
            _ => not_allowed(),
        },
        ["api", "ml", "jobs", _, "events"] => not_allowed(),
        _ => Response::error(404, "not_found", format!("no route {}", req.path)),
    }
}

fn no_job(id: &str) -> Response {
    Response::error(404, "no_job", format!("no job {id}"))
}

// --- guards -----------------------------------------------------------------

fn is_loopback_host(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inner, port))
                if port.is_empty() || port.strip_prefix(':').is_some_and(valid_port) =>
            {
                return inner == "::1";
            }
            _ => return false,
        }
    } else {
        match host.split_once(':') {
            Some((name, port)) if valid_port(port) => name,
            Some(_) => return false,
            None => host,
        }
    };
    name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost")
}

fn valid_port(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u16>().is_ok()
}

fn is_loopback_origin(origin: &str) -> bool {
    origin
        .strip_prefix("http://")
        .is_some_and(|rest| !rest.contains('/') && is_loopback_host(rest))
}

/// DNS rebinding (Host) and cross-site (Origin) guards.
fn guard(shared: &Shared, req: &Request) -> Result<(), Response> {
    let host = req.header("host").unwrap_or("");
    if !is_loopback_host(host) {
        return Err(Response::error(
            403,
            "forbidden_host",
            format!("Host {host:?} is not a loopback address"),
        ));
    }
    if let Some(origin) = req.header("origin") {
        let listed = shared
            .allow_origins
            .iter()
            .any(|o| o.trim_end_matches('/') == origin.trim_end_matches('/'));
        if !listed && !is_loopback_origin(origin) {
            return Err(Response::error(
                403,
                "forbidden_origin",
                format!("Origin {origin:?} is not allowed (see --allow-origin)"),
            ));
        }
    }
    Ok(())
}

/// An allowed Origin gets CORS headers back; same-origin requests need none.
fn cors_headers(req: &Request) -> Vec<(&'static str, String)> {
    match req.header("origin") {
        Some(o) => vec![
            ("Access-Control-Allow-Origin", o.to_string()),
            ("Vary", "Origin".into()),
        ],
        None => Vec::new(),
    }
}

// --- health and config ------------------------------------------------------

fn health(shared: &Shared) -> Response {
    let st = shared.lock();
    let (binary, found, ready) = shared.readiness(&st.config);
    let ready = ready.is_ok();
    let model = st.config.model.as_ref();
    Response::json(
        200,
        &json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "api": API_VERSION,
            "runtime": {
                "binary": binary.map(|p| p.display().to_string()),
                "found": found,
            },
            "model": {
                "id": model.map(|m| m.id.clone()),
                "configured": model.is_some(),
                "licenceAcknowledged": model.is_some_and(|m| m.acknowledged()),
            },
            "ready": ready,
            "capabilities": if ready { json!(["generate", "edit"]) } else { json!([]) },
            "queue": {
                "running": usize::from(st.running.is_some()),
                "queued": st.queue.len(),
            },
        }),
    )
}

fn config_json(c: &Config) -> Value {
    serde_json::to_value(c).unwrap_or(Value::Null)
}

fn put_config(shared: &Shared, body: &[u8]) -> Response {
    let config: Config = match serde_json::from_slice(body) {
        Ok(c) => c,
        Err(e) => return Response::error(400, "bad_request", format!("invalid config: {e}")),
    };
    if let Err((status, code, message)) = config.validate() {
        return Response::error(status, code, message);
    }
    if let Err(e) = config::save(&shared.config_path, &config) {
        return Response::error(
            500,
            "config_write_failed",
            format!("could not write {}: {e}", shared.config_path.display()),
        );
    }
    let v = config_json(&config);
    shared.lock().config = config;
    Response::json(200, &v)
}

// --- jobs -------------------------------------------------------------------

type Invalid = String;

fn decode_png(field: &str, v: &Value) -> Result<Vec<u8>, Invalid> {
    let s = v
        .as_str()
        .ok_or_else(|| format!("{field} must be a base64 PNG string"))?;
    // A data URL is accepted too.
    let s = match s.split_once(";base64,") {
        Some((prefix, rest)) if prefix.starts_with("data:") => rest,
        _ => s,
    };
    let s: String = s.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|e| format!("{field} is not valid base64: {e}"))?;
    if sd::png_size(&bytes).is_none() {
        return Err(format!("{field} is not a PNG image"));
    }
    Ok(bytes)
}

fn opt_u32(body: &Value, key: &str) -> Result<Option<u32>, Invalid> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| format!("{key} must be a non-negative integer")),
    }
}

fn opt_f64(body: &Value, key: &str) -> Result<Option<f64>, Invalid> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|f| f.is_finite())
            .map(Some)
            .ok_or_else(|| format!("{key} must be a number")),
    }
}

fn check_dim(key: &str, n: u32) -> Result<u32, Invalid> {
    if !(64..=4096).contains(&n) || !n.is_multiple_of(8) {
        return Err(format!(
            "{key} must be a multiple of 8 between 64 and 4096, got {n}"
        ));
    }
    Ok(n)
}

struct Parsed {
    spec: JobSpec,
    image: Option<Vec<u8>>,
    mask: Option<Vec<u8>>,
    references: Vec<Vec<u8>>,
}

fn parse_job(body: &Value) -> Result<Parsed, Invalid> {
    if !body.is_object() {
        return Err("the body must be a JSON object".into());
    }
    let kind = match body.get("kind").and_then(Value::as_str) {
        Some("generate") => Kind::Generate,
        Some("edit") => Kind::Edit,
        _ => return Err("kind must be \"generate\" or \"edit\"".into()),
    };
    let prompt = body
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("prompt is required")?
        .to_string();
    let negative_prompt = match body.get("negativePrompt") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("negativePrompt must be a string".into()),
    };
    let steps = opt_u32(body, "steps")?.unwrap_or(20);
    if !(1..=200).contains(&steps) {
        return Err(format!("steps must be between 1 and 200, got {steps}"));
    }
    let seed = match body.get("seed") {
        None | Some(Value::Null) => -1,
        Some(v) => v.as_i64().ok_or("seed must be an integer")?,
    };
    let cfg_scale = opt_f64(body, "cfgScale")?.unwrap_or(2.5);
    if !(0.0..=50.0).contains(&cfg_scale) {
        return Err(format!(
            "cfgScale must be between 0 and 50, got {cfg_scale}"
        ));
    }
    let strength = opt_f64(body, "strength")?.unwrap_or(0.75);
    if !(0.0..=1.0).contains(&strength) {
        return Err(format!("strength must be between 0 and 1, got {strength}"));
    }
    let width = opt_u32(body, "width")?;
    let height = opt_u32(body, "height")?;

    let (mut image, mut mask, mut references) = (None, None, Vec::new());
    let (width, height) = match kind {
        Kind::Generate => (
            check_dim("width", width.ok_or("width is required")?)?,
            check_dim("height", height.ok_or("height is required")?)?,
        ),
        Kind::Edit => {
            let img = decode_png("image", body.get("image").ok_or("image is required")?)?;
            let (iw, ih) = sd::png_size(&img).unwrap_or((0, 0));
            // The image's own size, rounded down to a multiple of 8, unless given.
            let w = check_dim("width", width.unwrap_or(iw - iw % 8))?;
            let h = check_dim("height", height.unwrap_or(ih - ih % 8))?;
            image = Some(img);
            mask = match body.get("mask") {
                None | Some(Value::Null) => None,
                Some(v) => Some(decode_png("mask", v)?),
            };
            match body.get("references") {
                None | Some(Value::Null) => {}
                Some(Value::Array(refs)) => {
                    if refs.len() > MAX_REFERENCES {
                        return Err(format!(
                            "at most {MAX_REFERENCES} references, got {}",
                            refs.len()
                        ));
                    }
                    for (k, r) in refs.iter().enumerate() {
                        references.push(decode_png(&format!("references[{k}]"), r)?);
                    }
                }
                Some(_) => return Err("references must be an array".into()),
            }
            (w, h)
        }
    };
    Ok(Parsed {
        spec: JobSpec {
            kind,
            prompt,
            negative_prompt,
            width,
            height,
            steps,
            seed,
            cfg_scale,
            strength,
        },
        image,
        mask,
        references,
    })
}

fn write_inputs(dir: &std::path::Path, p: &Parsed) -> std::io::Result<Inputs> {
    fs::create_dir_all(dir)?;
    let mut inputs = Inputs::default();
    let put = |name: String, bytes: &[u8]| -> std::io::Result<PathBuf> {
        let path = dir.join(name);
        fs::write(&path, bytes)?;
        Ok(path)
    };
    if let Some(b) = &p.image {
        inputs.image = Some(put("image.png".into(), b)?);
    }
    if let Some(b) = &p.mask {
        inputs.mask = Some(put("mask.png".into(), b)?);
    }
    for (k, b) in p.references.iter().enumerate() {
        inputs
            .references
            .push(put(format!("ref_{}.png", k + 1), b)?);
    }
    Ok(inputs)
}

fn post_job(shared: &Shared, body: &[u8]) -> Response {
    let id = {
        let mut st = shared.lock();
        if let (_, _, Err(missing)) = shared.readiness(&st.config) {
            return Response::error(503, "not_ready", missing);
        }
        st.new_id()
    };
    let body: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return Response::error(400, "bad_request", format!("invalid JSON: {e}")),
    };
    let parsed = match parse_job(&body) {
        Ok(p) => p,
        Err(m) => return Response::error(400, "bad_request", m),
    };
    let dir = shared.work_root.join(&id);
    let inputs = match write_inputs(&dir, &parsed) {
        Ok(i) => i,
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            return Response::error(500, "io_error", format!("could not stage the job: {e}"));
        }
    };
    let v = jobs::enqueue(shared, id, parsed.spec, inputs, dir);
    Response::json(202, &v)
}

fn result(shared: &Shared, id: &str) -> Response {
    let path = {
        let st = shared.lock();
        let Some(job) = st.jobs.get(id) else {
            return no_job(id);
        };
        if job.state != JobState::Done {
            return Response::error(
                409,
                "not_done",
                format!("job {id} is {}", job.state.as_str()),
            );
        }
        job.output()
    };
    match fs::read(&path) {
        Ok(body) => Response {
            status: 200,
            content_type: "image/png",
            headers: Vec::new(),
            body,
        },
        Err(e) => Response::error(500, "io_error", format!("could not read the result: {e}")),
    }
}

/// `GET /api/ml/jobs/{id}/events`: the job's current state, then every
/// change, then the terminal event; a finished job's stream is just that.
fn events(shared: &Shared, stream: &TcpStream, id: &str, cors: &[(&'static str, String)]) {
    if !shared.lock().jobs.contains_key(id) {
        let mut res = no_job(id);
        res.headers.extend(cors.iter().cloned());
        let _ = http::write_response(stream, &res);
        return;
    }
    if http::start_event_stream(stream, cors).is_err() {
        return;
    }
    let mut sent_state: Option<JobState> = None;
    let mut sent_progress: Option<(u32, u32)> = None;
    loop {
        let st = shared.lock();
        let Some(job) = st.jobs.get(id) else {
            return;
        };
        let (state, progress) = (job.state, (job.step, job.total));
        if state.is_terminal() {
            let snapshot = job.to_json();
            drop(st);
            let _ = http::write_event(stream, state.as_str(), &snapshot);
            return;
        }
        let new_state = sent_state != Some(state);
        let new_progress = state == JobState::Running && sent_progress != Some(progress);
        if new_state || new_progress {
            drop(st);
            let mut io = Ok(());
            if new_state {
                io = http::write_event(stream, "state", &json!({ "state": state.as_str() }));
                sent_state = Some(state);
            }
            if io.is_ok() && new_progress {
                io = http::write_event(
                    stream,
                    "progress",
                    &json!({ "step": progress.0, "total": progress.1 }),
                );
                sent_progress = Some(progress);
            }
            if io.is_err() {
                return;
            }
            continue;
        }
        let (st, timeout) = shared
            .changed
            .wait_timeout(st, KEEPALIVE)
            .unwrap_or_else(|p| p.into_inner());
        drop(st);
        if timeout.timed_out() && http::write_keepalive(stream).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts() {
        for ok in [
            "127.0.0.1",
            "127.0.0.1:7861",
            "localhost",
            "LOCALHOST:5173",
            "[::1]",
            "[::1]:7861",
        ] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in [
            "",
            "evil.example",
            "127.0.0.1.evil.example",
            "localhost.evil:80",
            "[::2]:1",
            "127.0.0.1:notaport",
            "0.0.0.0",
        ] {
            assert!(!is_loopback_host(bad), "{bad}");
        }
    }

    #[test]
    fn loopback_origins() {
        assert!(is_loopback_origin("http://localhost:5173"));
        assert!(is_loopback_origin("http://127.0.0.1"));
        assert!(is_loopback_origin("http://[::1]:3000"));
        assert!(!is_loopback_origin("https://localhost:5173"));
        assert!(!is_loopback_origin("http://evil.example"));
        assert!(!is_loopback_origin("null"));
    }
}
