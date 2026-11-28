/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! `paged engine-serve`: the engine as a small HTTP service, for paged.server's
//! headless lane (a Cloudflare Container runs this binary; local development
//! runs it on a port). Stateless: each call brings the working document and
//! takes back what the engine made of it, so any instance can answer any call.
//!
//! `POST /run` with JSON `{file, template?, script?, render?: {page, dpi?},
//! export?, cmykProfile?}`: `file` is the `.paged` (or `.idml`) as base64;
//! the engine loads it, fills the template's fields, runs the script,
//! renders a page (1-based) and/or exports, and
//! answers `{output, error, png?, file?, format?, files?}` with bytes as
//! base64. `GET /healthz` answers `ok`. Nothing else is served, and nothing
//! is kept between calls.
//!
//! `export` is `true` (the `.paged`, as before), a format (`"paged"`,
//! `"pdf"`, `"idml"`), an object `{format, pdf?}` whose `pdf` is the PDF
//! options as the session protocol spells them (`standard: "pdfx4"`,
//! `pageFrom`, `outputIntentProfile`, …), or an array of those. One export
//! answers `file` + `format`; an array answers `files: [{format, file}]` in
//! order. A PDF/X export needs a CMYK output profile: the server's
//! `--cmyk-profile`, or the call's own `cmykProfile` (an ICC file as
//! base64), which wins for that call. Either must be an ICC profile whose
//! data colour space is CMYK: a call whose `cmykProfile` is not (empty,
//! not base64, an RGB profile) is answered 400 with a JSON error, and a
//! server whose `--cmyk-profile` is not refuses to start.
//!
//! `template` is `{values, role?}`: the session takes `role` (`filler` by
//! default) and sets the template's fields to `values` (`[{name, value}]`,
//! as `setTemplateFields` spells them) before the script runs, so the
//! engine checks them against the template's policy as the editor does. A
//! value that does not fit its field, or a refusal, answers 422 with the
//! problems; nothing is exported (editor plan F7).
//!
//! Each call's engine is opened with the server's font flags, as every
//! other command opens its documents: `--fonts` / `--font-family` register
//! faces, and the bundled fallback face (or `--font`; none with
//! `--no-default-font`) sets text no registered family answers for.
//!
//! Concurrency: `--workers` threads (default: the machine's parallelism)
//! each answer one call at a time, and every call gets its own engine
//! session and scratch directory, so concurrent calls share nothing. Calls
//! beyond the workers wait in a queue of `--queue` connections (default
//! 64); a call that finds the queue full is answered 503 at once, so a
//! caller can back off instead of hanging.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::options::DocumentOptions;
use crate::session::EngineSession;

/// Calls carry whole documents; anything larger is refused.
const BODY_MAX: usize = 256 * 1024 * 1024;

/// How long a worker waits on a silent caller before dropping it.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> Result<()> {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    )?;
    Ok(())
}

/// One export a call asks for: the format and, for PDF, its options.
struct ExportAsk {
    format: String,
    pdf: Option<Value>,
}

fn export_ask(v: &Value) -> Result<ExportAsk> {
    let ask = match v {
        Value::Bool(true) => ExportAsk {
            format: "paged".into(),
            pdf: None,
        },
        Value::String(f) => ExportAsk {
            format: f.clone(),
            pdf: None,
        },
        Value::Object(o) => ExportAsk {
            format: o
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or("paged")
                .to_string(),
            pdf: o.get("pdf").filter(|p| !p.is_null()).cloned(),
        },
        other => {
            return Err(anyhow!(
                "`export` is true, a format, {{format, pdf?}} or an array of those — not {other}"
            ))
        }
    };
    if !matches!(ask.format.as_str(), "paged" | "pdf" | "idml") {
        return Err(anyhow!(
            "`export` format \"{}\" is not paged | pdf | idml",
            ask.format
        ));
    }
    if ask.pdf.is_some() && ask.format != "pdf" {
        return Err(anyhow!("`export.pdf` options need format \"pdf\""));
    }
    Ok(ask)
}

/// A call the caller got wrong in a way no engine run can fix: answered
/// 400, where a call the engine could not carry out is 422.
#[derive(Debug)]
struct BadCall(String);

impl std::fmt::Display for BadCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BadCall {}

/// Field values the template refused: answered 422 with the engine's
/// problems or refusal.
#[derive(Debug)]
struct TemplateRefused(Value);

impl std::fmt::Display for TemplateRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the template refused the values: {}", self.0)
    }
}

impl std::error::Error for TemplateRefused {}

/// The call's own CMYK profile, held to the check the server's flag is.
fn call_cmyk_profile(icc: &str) -> Result<Vec<u8>> {
    let bytes = b64()
        .decode(icc)
        .map_err(|e| BadCall(format!("`cmykProfile` is not base64: {e}")))?;
    crate::options::check_cmyk_icc(&bytes).map_err(|e| BadCall(format!("`cmykProfile` {e}")))?;
    Ok(bytes)
}

/// One call: load, script, render, export, in a fresh session.
pub fn run_call(assets: &DocumentOptions, call: &Value) -> Result<Value> {
    let scratch = std::env::temp_dir().join(format!(
        "paged-engine-{}-{}",
        std::process::id(),
        call_suffix()
    ));
    std::fs::create_dir_all(&scratch)?;
    // Removed when the call ends, also when the engine panics in it.
    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Scratch(scratch.clone());
    let result = (|| -> Result<Value> {
        let bytes = b64().decode(
            call["file"]
                .as_str()
                .ok_or_else(|| anyhow!("`file` is required"))?,
        )?;
        // The exports are read before anything runs: a call that asks for
        // something the engine cannot make is refused before it costs a load.
        let (asks, many) = match call.get("export") {
            None | Some(Value::Null) | Some(Value::Bool(false)) => (Vec::new(), false),
            Some(Value::Array(list)) => (
                list.iter().map(export_ask).collect::<Result<Vec<_>>>()?,
                true,
            ),
            Some(one) => (vec![export_ask(one)?], false),
        };
        let ext = if bytes.starts_with(b"PK") {
            "paged"
        } else {
            "idml"
        };
        let input = scratch.join(format!("in.{ext}"));
        std::fs::write(&input, bytes)?;
        // The call's own CMYK profile wins over the server's for this call.
        let mut call_assets = assets.clone();
        if let Some(icc) = call.get("cmykProfile").filter(|v| !v.is_null()) {
            let icc = icc
                .as_str()
                .ok_or_else(|| BadCall("`cmykProfile` is an ICC profile as base64".into()))?;
            let path = scratch.join("output.icc");
            std::fs::write(&path, call_cmyk_profile(icc)?)?;
            call_assets.cmyk_profile = Some(path.to_string_lossy().into_owned());
        }
        let mut engine = EngineSession::new(call_assets);
        engine.request(json!({ "cmd": "load", "path": input }))?;
        if let Some(template) = call.get("template").filter(|t| !t.is_null()) {
            let values = template
                .get("values")
                .cloned()
                .ok_or_else(|| BadCall("`template` needs `values`".into()))?;
            let mut req = json!({ "cmd": "template", "values": values });
            if let Some(role) = template.get("role").filter(|r| !r.is_null()) {
                req["role"] = role.clone();
            }
            let r = engine
                .request(req)
                .map_err(|e| BadCall(format!("`template`: {e}")))?;
            if r["ok"] != json!(true) {
                return Err(TemplateRefused(r).into());
            }
        }
        let mut out = json!({ "output": [], "error": null });
        if let Some(source) = call["script"].as_str() {
            let r = engine.request(json!({ "cmd": "run-script", "source": source }))?;
            out["output"] = r["result"]["output"].clone();
            out["error"] = r["result"]["error"].clone();
        }
        if let Some(render) = call.get("render").filter(|r| r.is_object()) {
            let page = render["page"].as_u64().unwrap_or(1).max(1) - 1;
            let png = scratch.join("page.png");
            engine.request(json!({ "cmd": "render", "page": page, "dpi": render["dpi"].as_f64().unwrap_or(96.0), "out": png }))?;
            out["png"] = json!(b64().encode(std::fs::read(&png)?));
        }
        let mut files = Vec::new();
        for (i, ask) in asks.iter().enumerate() {
            let file = scratch.join(format!("out-{i}.{}", ask.format));
            let mut req = json!({ "cmd": "export", "format": ask.format, "out": file });
            if let Some(pdf) = &ask.pdf {
                req["options"] = pdf.clone();
            }
            engine
                .request(req)
                .with_context(|| format!("export {}", ask.format))?;
            files.push(json!({
                "format": ask.format,
                "file": b64().encode(std::fs::read(&file)?),
            }));
        }
        if many {
            out["files"] = Value::Array(files);
        } else if let Some(one) = files.pop() {
            out["file"] = one["file"].clone();
            out["format"] = one["format"].clone();
        }
        Ok(out)
    })();
    result
}

/// A scratch name no other call in this process has: concurrent calls start
/// in the same nanosecond often enough to collide on a clock alone.
fn call_suffix() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    format!("{nanos}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// What answers one call: [`run_call`], or a test's stand-in.
type Runner = fn(&DocumentOptions, &Value) -> Result<Value>;

/// What a panic carried, as text.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("no message")
}

/// One call, with a panic inside the engine turned into an error. Every
/// call has its own engine session and scratch directory, so nothing the
/// panic left half-done is seen by the next call; the worker lives on.
fn run_guarded(run: Runner, assets: &DocumentOptions, call: &Value) -> Result<Value, CallFailed> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(assets, call))) {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(CallFailed::Refused(e)),
        Err(payload) => {
            // The server's log names it; the caller is told only that the
            // engine failed, not what its internals said.
            eprintln!("engine call panicked: {}", panic_text(payload.as_ref()));
            Err(CallFailed::Panicked)
        }
    }
}

/// How a call that gave no result ended.
enum CallFailed {
    /// The call was wrong, or the engine could not carry it out.
    Refused(anyhow::Error),
    /// The engine panicked: its fault, not the caller's.
    Panicked,
}

fn handle(mut stream: TcpStream, assets: &DocumentOptions, run: Runner) -> Result<()> {
    // A caller that stops sending must not hold a worker forever.
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let mut length = 0usize;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().context("content-length")?;
            }
        }
    }
    match (method, path) {
        ("GET", "/healthz") => respond(&mut stream, 200, &json!("ok")),
        ("POST", "/run") => {
            if length > BODY_MAX {
                return respond(
                    &mut stream,
                    413,
                    &json!({ "error": "the document is too large" }),
                );
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body)?;
            // CLI-9: a body that is not JSON is the caller's error, said
            // as one (400 with a JSON error body), not a dropped connection.
            let call: Value = match serde_json::from_slice(&body) {
                Ok(call) => call,
                Err(e) => {
                    return respond(
                        &mut stream,
                        400,
                        &json!({ "error": format!("the request body is not JSON: {e}") }),
                    );
                }
            };
            match run_guarded(run, assets, &call) {
                Ok(out) => respond(&mut stream, 200, &out),
                Err(CallFailed::Panicked) => respond(
                    &mut stream,
                    500,
                    &json!({ "error": "the engine failed on this call (an internal error)" }),
                ),
                Err(CallFailed::Refused(e)) => {
                    if let Some(TemplateRefused(r)) = e.downcast_ref::<TemplateRefused>() {
                        let mut body = json!({ "error": "the template refused the values" });
                        if let Some(p) = r.get("problems") {
                            body["problems"] = p.clone();
                        }
                        if let Some(err) = r.get("error") {
                            body["refusal"] = err.clone();
                        }
                        return respond(&mut stream, 422, &body);
                    }
                    let status = if e.is::<BadCall>() { 400 } else { 422 };
                    respond(&mut stream, status, &json!({ "error": format!("{e:#}") }))
                }
            }
        }
        _ => respond(
            &mut stream,
            404,
            &json!({ "error": "POST /run or GET /healthz" }),
        ),
    }
}

/// How the server spreads calls: `workers` threads, each answering one call
/// at a time with its own engine session, behind a queue of `queue`
/// connections.
#[derive(Debug, Clone, Copy)]
pub struct Concurrency {
    pub workers: usize,
    pub queue: usize,
}

impl Concurrency {
    /// `workers` absent: one per core the machine reports.
    pub fn new(workers: Option<usize>, queue: usize) -> Concurrency {
        let workers = workers
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
            .max(1);
        Concurrency { workers, queue }
    }
}

fn worker(rx: Arc<Mutex<Receiver<TcpStream>>>, assets: Arc<DocumentOptions>, run: Runner) {
    loop {
        // The lock is held only to take the next connection, not while
        // answering it, so the workers answer in parallel.
        let next = rx.lock().map(|r| r.recv());
        match next {
            Ok(Ok(stream)) => {
                // The call itself is guarded in `handle`; this catches a
                // panic in the reading and answering around it, so a worker
                // never ends on one connection.
                let answered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle(stream, &assets, run)
                }));
                match answered {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => eprintln!("engine call failed: {e}"),
                    Err(payload) => {
                        eprintln!("engine worker panicked: {}", panic_text(payload.as_ref()))
                    }
                }
            }
            _ => return,
        }
    }
}

pub fn run(port: u16, bind: &str, assets: DocumentOptions, conc: Concurrency) -> Result<()> {
    // The flags every call's engine opens with are checked once, here:
    // a bad profile or an unreadable fallback face is the operator's
    // error, and a server that starts with one fails every call.
    assets.check_cmyk_profile()?;
    assets.fallback_font()?;
    let listener =
        TcpListener::bind((bind, port)).with_context(|| format!("binding {bind}:{port}"))?;
    eprintln!("paged engine on {bind}:{port}");
    eprintln!("{} worker(s), queue {}", conc.workers, conc.queue);
    let (tx, rx) = sync_channel::<TcpStream>(conc.queue);
    let rx = Arc::new(Mutex::new(rx));
    let assets = Arc::new(assets);
    for _ in 0..conc.workers {
        let (rx, assets) = (rx.clone(), assets.clone());
        std::thread::spawn(move || worker(rx, assets, run_call));
    }
    for stream in listener.incoming() {
        match stream {
            Ok(s) => match tx.try_send(s) {
                Ok(()) => {}
                Err(TrySendError::Full(mut s)) => {
                    let _ = respond(
                        &mut s,
                        503,
                        &json!({ "error": "every engine worker is busy and the queue is full; retry later" }),
                    );
                }
                Err(TrySendError::Disconnected(_)) => {
                    return Err(anyhow!("every engine worker has stopped"));
                }
            },
            Err(e) => eprintln!("accept failed: {e}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assets() -> DocumentOptions {
        DocumentOptions {
            fonts: Vec::new(),
            font_family: Vec::new(),
            font: None,
            no_default_font: true,
            cmyk_profile: None,
        }
    }

    /// Stands in for the engine: panics when the call says so.
    fn runner(_: &DocumentOptions, call: &Value) -> Result<Value> {
        if call["panic"] == json!(true) {
            panic!("the engine hit a bug");
        }
        Ok(json!({ "echo": call["n"] }))
    }

    fn post(port: u16, body: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write!(
            s,
            "POST /run HTTP/1.1\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        )
        .expect("send");
        let mut answer = String::new();
        s.read_to_string(&mut answer).expect("an answer");
        answer
    }

    /// One worker, so a worker lost to a panic would leave nobody to answer
    /// the next call: the panicking call is answered 500 and the server
    /// answers the calls after it.
    #[test]
    fn a_panicking_call_is_answered_and_the_worker_lives_on() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = sync_channel::<TcpStream>(8);
        let rx = Arc::new(Mutex::new(rx));
        let only_worker = std::thread::spawn(move || worker(rx, Arc::new(assets()), runner));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if tx.send(stream).is_err() {
                    return;
                }
            }
        });

        for round in 0..3 {
            let answer = post(port, r#"{"panic":true}"#);
            assert!(
                answer.starts_with("HTTP/1.1 500 Internal Server Error\r\n"),
                "round {round}: {answer}"
            );
            assert!(
                answer.contains("the engine failed on this call"),
                "{answer}"
            );
            assert!(
                !answer.contains("hit a bug"),
                "the panic's text stays in the server's log: {answer}"
            );
            let answer = post(port, &format!(r#"{{"n":{round}}}"#));
            assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
            assert!(
                answer.ends_with(&format!(r#"{{"echo":{round}}}"#)),
                "{answer}"
            );
        }
        assert!(
            !only_worker.is_finished(),
            "the worker must still be running"
        );
    }

    #[test]
    fn a_guarded_call_reports_a_panic_as_one() {
        assert!(matches!(
            run_guarded(runner, &assets(), &json!({ "panic": true })),
            Err(CallFailed::Panicked)
        ));
        assert!(matches!(
            run_guarded(runner, &assets(), &json!({ "n": 1 })),
            Ok(v) if v == json!({ "echo": 1 })
        ));
    }
}
