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

//! The test harness: a host started in-process on an ephemeral port, a fake
//! `sd` (a shell script written at test time) and a tiny HTTP client.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use paged_ml_host::{start, Host, Options};
use serde_json::{json, Value};

pub struct Fake {
    /// Seconds the fake sleeps per step (`FAKE_SD_SLEEP` overrides).
    pub sleep: &'static str,
    /// Exit with status 1 after printing an error, writing no image.
    pub fail: bool,
    /// The host's `keep_finished`.
    pub keep_finished: usize,
}

impl Default for Fake {
    fn default() -> Self {
        Fake {
            sleep: "0.02",
            fail: false,
            keep_finished: paged_ml_host::jobs::KEEP_FINISHED,
        }
    }
}

pub struct TestHost {
    pub host: Option<Host>,
    pub dir: PathBuf,
    pub sd: PathBuf,
    pub config_path: PathBuf,
    pub log: PathBuf,
    pub pid_file: PathBuf,
    /// The bytes the fake writes as its result.
    pub result_png: Vec<u8>,
}

static N: AtomicUsize = AtomicUsize::new(0);

impl TestHost {
    pub fn new(fake: Fake) -> Self {
        Self::with_origins(fake, Vec::new())
    }

    pub fn with_origins(fake: Fake, allow_origins: Vec<String>) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "paged-ml-host-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let result_png = png(8, 8);
        fs::write(dir.join("result.png"), &result_png).unwrap();
        for f in ["dm.gguf", "te.gguf", "vae.safetensors"] {
            fs::write(dir.join(f), b"weights").unwrap();
        }
        let log = dir.join("argv.log");
        let pid_file = dir.join("sd.pid");
        let sd = dir.join("sd");
        fs::write(&sd, fake_script(&dir, &log, &pid_file, &fake)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&sd, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let config_path = dir.join("config").join("ml-host.json");
        let host = start(Options {
            port: 0,
            config_path: config_path.clone(),
            sd_binary: None,
            allow_origins,
            work_parent: Some(dir.join("work")),
            keep_finished: fake.keep_finished,
        })
        .unwrap();
        TestHost {
            host: Some(host),
            dir,
            sd,
            config_path,
            log,
            pid_file,
            result_png,
        }
    }

    pub fn addr(&self) -> SocketAddr {
        self.host.as_ref().unwrap().addr()
    }

    pub fn file(&self, name: &str) -> String {
        self.dir.join(name).display().to_string()
    }

    /// A complete, acknowledged config pointing at the fake.
    pub fn good_config(&self) -> Value {
        json!({
            "sdBinary": self.sd.display().to_string(),
            "model": {
                "id": "qwen-image-2.1",
                "licenceId": "qwen-research",
                "licenceAcknowledged": true,
                "diffusionModel": self.file("dm.gguf"),
                "textEncoder": self.file("te.gguf"),
                "vae": self.file("vae.safetensors"),
            },
            "extraArgs": ["--offload-to-cpu"],
        })
    }

    pub fn configure(&self) {
        let r = self.put("/api/ml/config", &self.good_config());
        assert_eq!(r.status, 200, "{}", r.text());
    }

    pub fn get(&self, path: &str) -> Resp {
        request(self.addr(), "GET", path, &[], None)
    }

    pub fn put(&self, path: &str, body: &Value) -> Resp {
        request(
            self.addr(),
            "PUT",
            path,
            &[],
            Some(body.to_string().as_bytes()),
        )
    }

    pub fn post(&self, path: &str, body: &Value) -> Resp {
        request(
            self.addr(),
            "POST",
            path,
            &[],
            Some(body.to_string().as_bytes()),
        )
    }

    pub fn delete(&self, path: &str) -> Resp {
        request(self.addr(), "DELETE", path, &[], None)
    }

    /// POSTs a job and returns its id.
    pub fn submit(&self, body: &Value) -> String {
        let r = self.post("/api/ml/jobs", body);
        assert_eq!(r.status, 202, "{}", r.text());
        let v = r.json();
        assert_eq!(v["state"], "queued");
        v["id"].as_str().unwrap().to_string()
    }

    pub fn job(&self, id: &str) -> Value {
        self.get(&format!("/api/ml/jobs/{id}")).json()
    }

    /// Polls until the job is in `state` (or 60 s pass).
    pub fn wait_state(&self, id: &str, state: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let j = self.job(id);
            if j["state"] == state {
                return j;
            }
            assert!(
                Instant::now() < deadline,
                "job {id} never reached {state}: {j}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Every sd invocation so far, each as its argv (without the program).
    pub fn invocations(&self) -> Vec<Vec<String>> {
        let text = fs::read_to_string(&self.log).unwrap_or_default();
        let mut calls = Vec::new();
        let mut cur = Vec::new();
        for line in text.lines() {
            if line == "---" {
                calls.push(std::mem::take(&mut cur));
            } else {
                cur.push(line.to_string());
            }
        }
        calls
    }
}

impl Drop for TestHost {
    fn drop(&mut self) {
        if let Some(h) = self.host.take() {
            h.shutdown();
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fake_script(dir: &Path, log: &Path, pid_file: &Path, fake: &Fake) -> String {
    format!(
        r#"#!/bin/sh
# A fake stable-diffusion.cpp CLI for the paged-ml-host tests.
LOG='{log}'
SLEEP="${{FAKE_SD_SLEEP:-{sleep}}}"
echo $$ > '{pid}'
out=""
total=1
prev=""
for a in "$@"; do
  printf '%s\n' "$a" >> "$LOG"
  case "$prev" in
    -o) out="$a" ;;
    --steps) total="$a" ;;
  esac
  prev="$a"
done
printf '%s\n' "---" >> "$LOG"
echo "[INFO ] loading model" >&2
printf '  |====>      | 812/1933 - 300.00it/s\r' >&2
printf '\n' >&2
if [ "{fail}" = "1" ]; then
  echo "[ERROR] the model file is corrupt" >&2
  exit 1
fi
i=1
while [ "$i" -le "$total" ]; do
  printf '  |=====>      | %d/%d - 0.10s/it\r' "$i" "$total" >&2
  sleep "$SLEEP"
  i=$((i + 1))
done
printf '\n' >&2
echo "[INFO ] save result image to '$out'"
cp '{result}' "$out"
"#,
        log = log.display(),
        pid = pid_file.display(),
        sleep = fake.sleep,
        fail = if fake.fail { "1" } else { "0" },
        result = dir.join("result.png").display(),
    )
}

// --- a tiny HTTP client --------------------------------------------------------

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The `error` code of an error body.
    pub fn code(&self) -> String {
        self.json()["error"].as_str().unwrap_or("").to_string()
    }
}

fn send(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> TcpStream {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("host")) {
        head.push_str(&format!("Host: {addr}\r\n"));
    }
    for (n, v) in headers {
        head.push_str(&format!("{n}: {v}\r\n"));
    }
    if let Some(b) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).unwrap();
    if let Some(b) = body {
        s.write_all(b).unwrap();
    }
    s
}

pub fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> Resp {
    let s = send(addr, method, path, headers, body);
    let mut r = BufReader::new(s);
    let (status, headers) = read_head(&mut r);
    let mut body = Vec::new();
    r.read_to_end(&mut body).unwrap();
    Resp {
        status,
        headers,
        body,
    }
}

/// Sends raw bytes and returns the status (for malformed or oversized input).
pub fn raw(addr: SocketAddr, bytes: &[u8]) -> Resp {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    s.write_all(bytes).unwrap();
    let mut r = BufReader::new(s);
    let (status, headers) = read_head(&mut r);
    let mut body = Vec::new();
    let _ = r.read_to_end(&mut body);
    Resp {
        status,
        headers,
        body,
    }
}

fn read_head(r: &mut impl BufRead) -> (u16, Vec<(String, String)>) {
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let status = line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("bad status line {line:?}"));
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        r.read_line(&mut h).unwrap();
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((n, v)) = h.split_once(':') {
            headers.push((n.trim().to_string(), v.trim().to_string()));
        }
    }
    (status, headers)
}

/// Reads a job's event stream to its end: `(event, data)` pairs.
pub fn events(addr: SocketAddr, id: &str) -> (Resp, Vec<(String, Value)>) {
    let s = send(addr, "GET", &format!("/api/ml/jobs/{id}/events"), &[], None);
    let mut r = BufReader::new(s);
    let (status, headers) = read_head(&mut r);
    let mut out = Vec::new();
    let mut event = String::new();
    let mut line = String::new();
    while r.read_line(&mut line).unwrap_or(0) > 0 {
        let l = line.trim_end_matches('\n');
        if let Some(e) = l.strip_prefix("event: ") {
            event = e.to_string();
        } else if let Some(d) = l.strip_prefix("data: ") {
            out.push((std::mem::take(&mut event), serde_json::from_str(d).unwrap()));
        }
        line.clear();
    }
    (
        Resp {
            status,
            headers,
            body: Vec::new(),
        },
        out,
    )
}

// --- PNG -------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
}

/// A valid grey `w`×`h` PNG (stored, uncompressed zlib).
pub fn png(w: u32, h: u32) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..h {
        raw.push(0);
        raw.extend((0..w).map(|x| ((x + y) % 256) as u8));
    }
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, b) in blocks.iter().enumerate() {
        z.push(u8::from(i + 1 == blocks.len()));
        let len = u16::try_from(b.len()).unwrap();
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(b);
    }
    let (mut a, mut bb) = (1u32, 0u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65521;
        bb = (bb + a) % 65521;
    }
    z.extend_from_slice(&((bb << 16) | a).to_be_bytes());
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The value after `flag` in an argv, if any.
pub fn arg_after<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.iter()
        .position(|a| a == flag)
        .and_then(|i| argv.get(i + 1))
        .map(String::as_str)
}

/// Every value after an occurrence of `flag`.
pub fn args_after<'a>(argv: &'a [String], flag: &str) -> Vec<&'a str> {
    argv.windows(2)
        .filter(|w| w[0] == flag)
        .map(|w| w[1].as_str())
        .collect()
}

pub fn process_alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
