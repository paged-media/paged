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
//! `POST /run` with JSON `{file, script?, render?: {page, dpi?}, export?,
//! cmykProfile?}`: `file` is the `.paged` (or `.idml`) as base64; the engine
//! loads it, runs the script, renders a page (1-based) and/or exports, and
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
//! base64), which wins for that call.
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

/// One call: load, script, render, export, in a fresh session.
pub fn run_call(assets: &DocumentOptions, call: &Value) -> Result<Value> {
    let scratch = std::env::temp_dir().join(format!(
        "paged-engine-{}-{}",
        std::process::id(),
        call_suffix()
    ));
    std::fs::create_dir_all(&scratch)?;
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
        if let Some(icc) = call.get("cmykProfile").and_then(Value::as_str) {
            let path = scratch.join("output.icc");
            std::fs::write(
                &path,
                b64().decode(icc).context("`cmykProfile` is not base64")?,
            )?;
            call_assets.cmyk_profile = Some(path.to_string_lossy().into_owned());
        }
        let mut engine = EngineSession::new(call_assets);
        engine.request(json!({ "cmd": "load", "path": input }))?;
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
    let _ = std::fs::remove_dir_all(&scratch);
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

fn handle(mut stream: TcpStream, assets: &DocumentOptions) -> Result<()> {
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
            match run_call(assets, &call) {
                Ok(out) => respond(&mut stream, 200, &out),
                Err(e) => respond(&mut stream, 422, &json!({ "error": e.to_string() })),
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

fn worker(rx: Arc<Mutex<Receiver<TcpStream>>>, assets: Arc<DocumentOptions>) {
    loop {
        // The lock is held only to take the next connection, not while
        // answering it, so the workers answer in parallel.
        let next = rx.lock().map(|r| r.recv());
        match next {
            Ok(Ok(stream)) => {
                if let Err(e) = handle(stream, &assets) {
                    eprintln!("engine call failed: {e}");
                }
            }
            _ => return,
        }
    }
}

pub fn run(port: u16, bind: &str, assets: DocumentOptions, conc: Concurrency) -> Result<()> {
    let listener =
        TcpListener::bind((bind, port)).with_context(|| format!("binding {bind}:{port}"))?;
    eprintln!("paged engine on {bind}:{port}");
    eprintln!("{} worker(s), queue {}", conc.workers, conc.queue);
    let (tx, rx) = sync_channel::<TcpStream>(conc.queue);
    let rx = Arc::new(Mutex::new(rx));
    let assets = Arc::new(assets);
    for _ in 0..conc.workers {
        let (rx, assets) = (rx.clone(), assets.clone());
        std::thread::spawn(move || worker(rx, assets));
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
