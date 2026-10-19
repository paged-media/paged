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

//! The golden harness of the `paged` command line, and the gate that
//! every command has its goldens.
//!
//! A golden case runs the real binary in a fresh directory, with the
//! documents it reads given as RELATIVE names, and compares one
//! normalised transcript — the command line, the exit code, stdout and
//! stderr — with a committed file under `tests/golden/<command>/`
//! (`paged read layers` → `tests/golden/paged.read.layers/`). A
//! difference fails with both texts; `PAGED_UPDATE_GOLDEN=1` writes the
//! files instead, and the diff is then reviewed like any other change.
//!
//! What is normalised, and why each is not the command's behaviour:
//! the fixture directory (`<TMP>`) and the engine checkout (`<ENGINE>`);
//! the crate version (`paged <VERSION>`) and the wire protocol
//! (`<PROTOCOL>`); byte counts of written files (`<N> bytes` — a
//! compressed container's size moves with the deflate backend, which is
//! a dependency, not the CLI); the OS errno (`(os error <N>)`), a
//! panicking thread's id and a panic's source line; 16- and 64-digit hex
//! digests (`<DIGEST>`, `<HASH>`: the digest is the verification
//! oracle's job, not this file's); and in JSON output, keys sorted and
//! fractional numbers rounded to three decimals, so a last-ulp
//! difference between two platforms' maths libraries is not a failure.
//! Everything else — every word of `--help`, every error message, every
//! JSON key and value — is compared exactly.
//!
//! The gate ([`every_command_path_has_its_goldens`]) walks the clap tree
//! itself (`paged_cli::cli::surface()`, the source of `cli.json`), so a
//! command added without goldens fails here, and a golden left behind by
//! a removed command or case fails too.

use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

/// Set to `1` to write the golden files instead of comparing them.
pub const UPDATE_VAR: &str = "PAGED_UPDATE_GOLDEN";

pub fn updating() -> bool {
    matches!(
        std::env::var(UPDATE_VAR).as_deref(),
        Ok("1" | "true" | "yes")
    )
}

pub fn golden_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

/// `paged read layers` → `tests/golden/paged.read.layers`.
pub fn golden_dir(command: &str) -> PathBuf {
    golden_root().join(command.replace(' ', "."))
}

/// `engine/core`, where the committed fonts live.
pub fn engine_root() -> PathBuf {
    let raw = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    raw.canonicalize().unwrap_or(raw)
}

/// The license-clear face committed beside the engine (OFL).
pub fn inter() -> String {
    engine_root()
        .join("corpus/fonts/Inter.ttf")
        .to_string_lossy()
        .into_owned()
}

/// The document every read and write case starts from, authored through
/// `paged script` so the fixture is the product's own output: one page
/// (`usp`) with a text frame `textFrame:u1` holding "Hello world" in
/// `Story/u0`, a layer `Art`, a CMYK swatch `Color/u1` (Vermilion), a
/// gradient `Gradient/u0` (Dawn), two overlapping ovals `oval:u2` /
/// `oval:u3`, an open path `polygon:u4` and an empty graphic frame
/// `rectangle:u5`.
pub const SEED: &str = r#"const pid = JSON.parse(paged.pages())[0].selfId;
const A = (x, y) => ({ anchor: [x, y], left: [x, y], right: [x, y] });
paged.insertTextFrame(pid, [72, 72, 300, 400]);
const sid = JSON.parse(paged.stories())[0].selfId;
paged.insertText(sid, 0, 'Hello world');
paged.layerInsert(0, 'Art');
const sw = paged.createSwatch({ space: 'CMYK', value: [0, 100, 100, 0], name: 'Vermilion' });
paged.createGradient({ kind: 'Linear', name: 'Dawn', stops: [
  { stopColor: 'Color/Black', locationPct: 0 }, { stopColor: sw, locationPct: 100 } ] });
paged.insertOval(pid, [400, 100, 500, 200]);
paged.insertOval(pid, [450, 150, 550, 250]);
paged.insertPath(pid, [A(100, 600), A(200, 600), A(200, 660)], true, false);
paged.insertFrame(pid, [300, 450, 500, 650], 'rectangle');
console.log('seeded');
"#;

/// A fresh working directory for one test. Commands run INSIDE it, so
/// the documents they read and write are relative names and the
/// transcript carries no machine path.
pub struct Fx {
    dir: PathBuf,
    real: PathBuf,
}

impl Fx {
    pub fn new(tag: &str) -> Fx {
        let dir = std::env::temp_dir().join(format!("paged-golden-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create the fixture directory");
        let real = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        Fx { dir, real }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn write(&self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        let path = self.path(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create a fixture subdirectory");
        }
        std::fs::write(&path, bytes).expect("write a fixture file");
        path
    }

    pub fn read(&self, name: &str) -> Vec<u8> {
        std::fs::read(self.path(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
    }

    pub fn exists(&self, name: &str) -> bool {
        self.path(name).exists()
    }

    /// The command with the environment a golden needs: nothing from the
    /// developer's shell that changes what the CLI prints. A profile in
    /// `PAGED_CMYK_PROFILE`, a backtrace variable (anyhow appends a stack
    /// to every error under `RUST_BACKTRACE`) or forced colour would each
    /// make the same command print something else on another machine;
    /// `HOME` is the fixture so the default library is never the real one.
    pub fn command(&self, bin: &str, args: &[&str]) -> Command {
        let mut c = Command::new(bin);
        c.args(args)
            .current_dir(&self.dir)
            .env_remove("PAGED_CMYK_PROFILE")
            .env_remove("PAGED_LIBRARY")
            .env_remove("RUST_BACKTRACE")
            .env_remove("RUST_LIB_BACKTRACE")
            .env_remove("CLICOLOR_FORCE")
            .env("NO_COLOR", "1")
            .env("HOME", &self.dir);
        c
    }

    pub fn run(&self, args: &[&str]) -> Run {
        self.run_stdin(args, None)
    }

    pub fn run_stdin(&self, args: &[&str], input: Option<&[u8]>) -> Run {
        self.run_bin("paged", env!("CARGO_BIN_EXE_paged"), args, input)
    }

    /// `name` is what the transcript calls the binary.
    pub fn run_bin(&self, name: &str, bin: &str, args: &[&str], input: Option<&[u8]>) -> Run {
        let mut cmd = self.command(bin, args);
        cmd.stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .unwrap_or_else(|e| panic!("spawn {name} {args:?}: {e}"));
        if let Some(bytes) = input {
            let mut stdin = child.stdin.take().expect("stdin");
            stdin.write_all(bytes).expect("write stdin");
        }
        let out = child.wait_with_output().expect("wait for the command");
        Run {
            argv: std::iter::once(name.to_string())
                .chain(args.iter().map(|a| a.to_string()))
                .collect(),
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            roots: vec![
                (self.real.to_string_lossy().into_owned(), "<TMP>"),
                (self.dir.to_string_lossy().into_owned(), "<TMP>"),
                (engine_root().to_string_lossy().into_owned(), "<ENGINE>"),
            ],
        }
    }

    /// `<command> --help`, exit 0, against `<command>/help.txt`.
    pub fn help(&self, command: &str) {
        let args: Vec<&str> = command
            .split(' ')
            .skip(1)
            .chain(std::iter::once("--help"))
            .collect();
        self.run(&args).code(0).golden(command, "help");
    }

    /// A blank Letter `.paged` document.
    pub fn blank(&self, name: &str) {
        self.run(&["new", "-o", name]).code(0);
    }

    /// The [`SEED`] document.
    pub fn seeded(&self, name: &str) {
        self.blank("seed-blank.paged");
        self.write("seed.js", SEED);
        self.run(&["script", "seed-blank.paged", "seed.js", "-o", name])
            .code(0);
    }

    /// The seeded document with a 612×792 PNG placed in `rectangle:u5`.
    pub fn placed(&self, name: &str) {
        self.seeded("placed-seed.paged");
        self.run(&[
            "render",
            "placed-seed.paged",
            "--dpi",
            "72",
            "-o",
            "placed-image.png",
        ])
        .code(0);
        self.run(&[
            "place",
            "placed-seed.paged",
            "rectangle:u5",
            "placed-image.png",
            "-o",
            name,
        ])
        .code(0);
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// One finished command.
pub struct Run {
    pub argv: Vec<String>,
    /// `None` when a signal ended it.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    roots: Vec<(String, &'static str)>,
}

impl Run {
    fn shown(&self) -> String {
        format!(
            "{}\n--- stdout\n{}\n--- stderr\n{}",
            self.argv.join(" "),
            self.stdout,
            self.stderr
        )
    }

    /// Asserts the exit code.
    pub fn code(self, want: i32) -> Run {
        assert_eq!(
            self.code,
            Some(want),
            "exit code of `{}`\n{}",
            self.argv.join(" "),
            self.shown()
        );
        self
    }

    /// stdout as JSON.
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.stdout).unwrap_or_else(|e| {
            panic!(
                "stdout of `{}` is not JSON ({e}):\n{}",
                self.argv.join(" "),
                self.stdout
            )
        })
    }

    /// Replace stdout before it is compared — for an output whose CONTENT
    /// a test asserts in code (the op list is the catalog's, the
    /// capability catalog is `catalog.json`), so the golden keeps only
    /// its shape and does not churn with every op the engine adds.
    pub fn map_stdout(mut self, f: impl FnOnce(&str) -> String) -> Run {
        self.stdout = f(&self.stdout);
        self
    }

    pub fn map_stderr(mut self, f: impl FnOnce(&str) -> String) -> Run {
        self.stderr = f(&self.stderr);
        self
    }

    /// Mask `text` (a port the test picked, say) as `mark` everywhere in
    /// the transcript, the command line included.
    pub fn mask(mut self, text: &str, mark: &'static str) -> Run {
        self.roots.push((text.to_string(), mark));
        self
    }

    /// The normalised transcript, as the golden file holds it.
    pub fn transcript(&self) -> String {
        let argv: Vec<String> = self.argv.iter().map(|a| self.text(&quote(a))).collect();
        let code = match self.code {
            Some(c) => c.to_string(),
            None => "signal".to_string(),
        };
        format!(
            "$ {}\n--- exit: {code}\n--- stdout\n{}--- stderr\n{}",
            argv.join(" "),
            block(&self.output(&self.stdout)),
            block(&self.text(&self.stderr)),
        )
    }

    /// Compare with (or, under `PAGED_UPDATE_GOLDEN=1`, write)
    /// `tests/golden/<command>/<case>.txt`.
    pub fn golden(self, command: &str, case: &str) -> Run {
        check_golden(
            &golden_dir(command).join(format!("{case}.txt")),
            &self.transcript(),
        );
        self
    }

    fn output(&self, text: &str) -> String {
        let trimmed = text.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                let pretty = serde_json::to_string_pretty(&canonical(&v, None))
                    .expect("serialise canonical JSON");
                return self.text(&format!("{pretty}\n"));
            }
            // NDJSON: one value per line.
            let lines: Option<Vec<String>> = trimmed
                .lines()
                .map(|l| {
                    serde_json::from_str::<Value>(l)
                        .ok()
                        .map(|v| serde_json::to_string(&canonical(&v, None)).unwrap())
                })
                .collect();
            if let Some(lines) = lines {
                return self.text(&(lines.join("\n") + "\n"));
            }
        }
        // Mixed output: a status line, then a JSON envelope (`paged read`
        // with `-o`, `paged package --json`).
        if let Some(at) = text.find("\n{") {
            let (head, tail) = text.split_at(at + 1);
            if let Ok(v) = serde_json::from_str::<Value>(tail.trim()) {
                let pretty = serde_json::to_string_pretty(&canonical(&v, None)).unwrap();
                return self.text(&format!("{head}{pretty}\n"));
            }
        }
        self.text(text)
    }

    fn text(&self, raw: &str) -> String {
        let mut s = raw.to_string();
        for (root, mark) in &self.roots {
            if !root.is_empty() {
                s = s.replace(root.as_str(), mark);
            }
        }
        s = s.replace(
            &format!("paged {}", env!("CARGO_PKG_VERSION")),
            "paged <VERSION>",
        );
        s = mask_after(&s, "(os error ", |c| c.is_ascii_digit(), "<N>");
        s = mask_after(&s, "thread 'main' (", |c| c.is_ascii_digit(), "<TID>");
        s = mask_rs_lines(&s);
        s = mask_before(&s, " bytes", "<N>");
        s = mask_hex(&s);
        s = mask_epoch_ms(&s);
        s = s
            .lines()
            .map(|line| {
                let proto = paged_canvas::channel::PROTOCOL_VERSION.0.to_string();
                if line.trim_start().starts_with("protocol") && line.contains(&proto) {
                    line.replace(&proto, "<PROTOCOL>")
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + if s.ends_with('\n') { "\n" } else { "" };
        s
    }
}

fn quote(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=,#@+%".contains(c))
    {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

fn block(text: &str) -> String {
    if text.is_empty() {
        "(empty)\n".to_string()
    } else if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n(no trailing newline)\n")
    }
}

/// Keys whose values are digests: masked whole.
const DIGEST_KEYS: &[&str] = &["combined", "pageDigests", "stateHash", "digest"];

/// Sorted keys, fractions rounded to three decimals, digests and the
/// protocol masked.
pub fn canonical(v: &Value, key: Option<&str>) -> Value {
    if let Some(k) = key {
        if DIGEST_KEYS.contains(&k) {
            return mask_leaves(v);
        }
        if k == "protocol" && v.as_u64() == Some(paged_canvas::channel::PROTOCOL_VERSION.0 as u64) {
            return Value::String("<PROTOCOL>".into());
        }
        if k == "version" && v.as_str() == Some(env!("CARGO_PKG_VERSION")) {
            return Value::String("<VERSION>".into());
        }
        if matches!(k, "createdAt" | "updatedAt") && v.is_number() {
            return Value::String("<TIME>".into());
        }
    }
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonical(&map[k], Some(k)));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|i| canonical(i, None)).collect()),
        Value::Number(n) if n.is_f64() => {
            let x = n.as_f64().unwrap();
            let r = (x * 1000.0).round() / 1000.0;
            let r = if r == 0.0 { 0.0 } else { r };
            serde_json::Number::from_f64(r).map_or(Value::Null, Value::Number)
        }
        other => other.clone(),
    }
}

fn mask_leaves(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), mask_leaves(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(mask_leaves).collect()),
        Value::Null => Value::Null,
        _ => Value::String("<DIGEST>".into()),
    }
}

/// `prefix` followed by a run of `keep` chars → `prefix` + `mark`.
fn mask_after(s: &str, prefix: &str, keep: impl Fn(char) -> bool, mark: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find(prefix) {
        let after = &rest[at + prefix.len()..];
        let run: usize = after
            .chars()
            .take_while(|c| keep(*c))
            .map(char::len_utf8)
            .sum();
        out.push_str(&rest[..at + prefix.len()]);
        if run > 0 {
            out.push_str(mark);
        }
        rest = &after[run..];
    }
    out.push_str(rest);
    out
}

/// A run of digits directly before `suffix` → `mark`.
fn mask_before(s: &str, suffix: &str, mark: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find(suffix) {
        let head = &rest[..at];
        let digits = head.len() - head.trim_end_matches(|c: char| c.is_ascii_digit()).len();
        out.push_str(&head[..head.len() - digits]);
        if digits > 0 {
            out.push_str(mark);
        }
        out.push_str(suffix);
        rest = &rest[at + suffix.len()..];
    }
    out.push_str(rest);
    out
}

/// `file.rs:484:34` → `file.rs:<LINE>`: a panic's location moves with
/// every edit above it.
fn mask_rs_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find(".rs:") {
        let after = &rest[at + 4..];
        let run: usize = after
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ':')
            .map(char::len_utf8)
            .sum();
        out.push_str(&rest[..at + 4]);
        if run > 0 && after.starts_with(|c: char| c.is_ascii_digit()) {
            out.push_str("<LINE>");
            let tail = &after[..run];
            // Keep a trailing ':' that ends a sentence ("at x.rs:1:2:").
            if tail.ends_with(':') && tail.matches(':').count() > 1 {
                out.push(':');
            }
            rest = &after[run..];
        } else {
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// A free-standing run of exactly 13 digits → `<TIME>`: an epoch in
/// milliseconds (a library's `createdAt`, also inside JSON carried as text).
fn mask_epoch_ms(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() && (i == 0 || !chars[i - 1].is_ascii_alphanumeric()) {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            let bounded =
                j == chars.len() || !(chars[j].is_ascii_alphanumeric() || chars[j] == '.');
            if j - i == 13 && bounded {
                out.push_str("<TIME>");
            } else {
                out.extend(&chars[i..j]);
            }
            i = j;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Free-standing 16- and 64-digit lowercase hex tokens → digests.
fn mask_hex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let boundary_before = i == 0 || !chars[i - 1].is_ascii_alphanumeric();
        let lower_hex = |c: char| c.is_ascii_digit() || ('a'..='f').contains(&c);
        if boundary_before && lower_hex(chars[i]) {
            let mut j = i;
            while j < chars.len() && lower_hex(chars[j]) {
                j += 1;
            }
            let boundary_after = j == chars.len() || !chars[j].is_ascii_alphanumeric();
            let len = j - i;
            let has_letter = chars[i..j].iter().any(|c| c.is_ascii_alphabetic());
            if boundary_after && has_letter && (len == 16 || len == 64) {
                out.push_str(if len == 16 { "<DIGEST>" } else { "<HASH>" });
                i = j;
                continue;
            }
            out.extend(&chars[i..j]);
            i = j;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Compare `actual` with the file at `path`, or write it when updating.
pub fn check_golden(path: &Path, actual: &str) {
    let shown = path
        .strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")))
        .unwrap_or(path)
        .display()
        .to_string();
    if updating() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create the golden directory");
        }
        if std::fs::read_to_string(path).ok().as_deref() != Some(actual) {
            std::fs::write(path, actual).expect("write the golden file");
            eprintln!("golden: wrote {shown}");
        }
        return;
    }
    let Ok(expected) = std::fs::read_to_string(path) else {
        panic!(
            "no golden file {shown}. A new command or case needs one: run \
             `{UPDATE_VAR}=1 cargo nextest run -p paged-cli` and review the new file.\n\
             actual:\n{actual}"
        );
    };
    if expected != actual {
        let first = expected
            .lines()
            .zip(actual.lines())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| expected.lines().count().min(actual.lines().count()));
        panic!(
            "{shown} differs from the command's output (first at line {}).\n\
             If the change is intended, run `{UPDATE_VAR}=1 cargo nextest run -p paged-cli` \
             and review the diff.\n--- expected\n{expected}\n--- actual\n{actual}",
            first + 1
        );
    }
}

// ── assertions on written files ─────────────────────────────────────

/// A PNG of exactly `w`×`h` pixels (read off the IHDR, no decoder).
pub fn assert_png(bytes: &[u8], w: u32, h: u32) {
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "not a PNG");
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    assert_eq!((width, height), (w, h), "PNG size");
}

/// A PDF with `pages` page objects.
pub fn assert_pdf(bytes: &[u8], pages: usize) {
    assert!(bytes.starts_with(b"%PDF-"), "not a PDF");
    let text = String::from_utf8_lossy(bytes);
    let count = text
        .match_indices("/Type /Page")
        .filter(|(i, _)| !text[i + "/Type /Page".len()..].starts_with('s'))
        .count();
    assert_eq!(count, pages, "PDF page objects");
    assert!(text.trim_end().ends_with("%%EOF"), "the PDF is complete");
}

/// The entry names of a ZIP container, in archive order.
pub fn zip_entries(bytes: &[u8]) -> Vec<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("a ZIP container");
    (0..archive.len())
        .map(|i| {
            archive
                .by_index(i)
                .expect("entry")
                .name()
                .expect("entry name")
                .to_string()
        })
        .collect()
}

// ── the gate ────────────────────────────────────────────────────────

/// Every command path the parser defines, `paged` first, each with
/// whether it is a leaf (a command that runs) or a group.
pub fn command_paths() -> Vec<(String, bool)> {
    fn walk(cmd: &Value, prefix: &str, out: &mut Vec<(String, bool)>) {
        let path = format!("{prefix} {}", cmd["name"].as_str().expect("name"));
        let subs = cmd["subcommands"].as_array().cloned().unwrap_or_default();
        out.push((path.clone(), subs.is_empty()));
        for sub in &subs {
            walk(sub, &path, out);
        }
    }
    let surface = paged_cli::cli::surface();
    let mut out = vec![("paged".to_string(), false)];
    for cmd in surface["commands"].as_array().expect("commands") {
        walk(cmd, "paged", &mut out);
    }
    out
}

/// The golden test sources, read for the literals the gate looks for.
fn sources() -> String {
    [
        include_str!("golden.rs"),
        include_str!("golden_document.rs"),
        include_str!("golden_read.rs"),
        include_str!("golden_hosts.rs"),
    ]
    .concat()
}

/// Leaf commands with no input a user can get wrong, so no exit-1 case:
/// each with why.
const NO_INPUT_ERROR: &[(&str, &str)] = &[
    (
        "paged ops",
        "reads nothing but the engine's own catalog, so the only wrong input is a wrong flag, which is the usage error",
    ),
    (
        "paged describe",
        "reads nothing but the engine's own catalog, so the only wrong input is a wrong flag, which is the usage error",
    ),
    (
        "paged session",
        "a bad request is answered on the protocol (`{\"ok\":false,…}`) and the session goes on; the exit code is not where a session reports it",
    ),
    (
        "paged mcp",
        "a bad call is answered on the protocol (a JSON-RPC error or `isError`) and the server goes on; the exit code is not where it reports it",
    ),
];

/// Leaf commands that never exit on their own, so no exit-0 transcript:
/// each with why, and the golden that stands in for it.
const NO_EXIT_ZERO: &[(&str, &str)] = &[(
    "paged engine-serve",
    "serves until it is killed, so its success golden is the HTTP exchange (`call.txt`): the greeting, a call answered, two refused",
)];

fn golden_files(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("txt") {
            let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
            out.push((stem, std::fs::read_to_string(&path).unwrap_or_default()));
        }
    }
    out
}

#[test]
fn every_command_path_has_its_goldens() {
    paged_test_resources::covers!("cli:paged");
    let paths = command_paths();
    assert!(
        paths.len() >= 45,
        "only {} command paths walked out of the parser — the walker is broken, not the CLI",
        paths.len()
    );
    let src = sources();
    let excused: BTreeSet<&str> = NO_INPUT_ERROR.iter().map(|(p, _)| *p).collect();
    let never_exits: BTreeSet<&str> = NO_EXIT_ZERO.iter().map(|(p, _)| *p).collect();
    let mut problems = Vec::new();
    for (path, leaf) in &paths {
        if !src.contains(&format!("covers!(\"cli:{path}\")")) {
            problems.push(format!("{path}: no test says covers!(\"cli:{path}\")"));
        }
        let dir = golden_dir(path);
        let files = golden_files(&dir);
        if !files.iter().any(|(stem, _)| stem == "help") {
            problems.push(format!("{path}: no help golden ({})", dir.display()));
        }
        let exits: BTreeSet<String> = files
            .iter()
            .filter_map(|(_, body)| {
                body.lines()
                    .find_map(|l| l.strip_prefix("--- exit: "))
                    .map(str::to_string)
            })
            .collect();
        if !exits.contains("2") {
            problems.push(format!("{path}: no usage-error golden (exit 2)"));
        }
        if *leaf {
            if !exits.contains("0") && !never_exits.contains(path.as_str()) {
                problems.push(format!("{path}: no success golden (exit 0)"));
            }
            if !exits.contains("1") && !excused.contains(path.as_str()) {
                problems.push(format!(
                    "{path}: no input-error golden (exit 1), and NO_INPUT_ERROR does not say why"
                ));
            }
        }
    }
    assert!(
        problems.is_empty(),
        "commands without their goldens:\n{}",
        problems.join("\n")
    );

    // The half that rots: goldens nothing produces any more.
    let known: BTreeSet<String> = paths.iter().map(|(p, _)| p.replace(' ', ".")).collect();
    let mut stale = Vec::new();
    for entry in std::fs::read_dir(golden_root())
        .expect("tests/golden")
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !known.contains(&name) {
            stale.push(format!("{name}/ (no such command)"));
            continue;
        }
        for (stem, _) in golden_files(&entry.path()) {
            if !src.contains(&format!("\"{stem}\"")) && !src.contains(&format!("\"{stem}.txt\"")) {
                stale.push(format!("{name}/{stem}.txt (no case of that name)"));
            }
        }
    }
    assert!(
        stale.is_empty(),
        "stale goldens — delete them:\n{}",
        stale.join("\n")
    );

    for (path, reason) in NO_INPUT_ERROR.iter().chain(NO_EXIT_ZERO) {
        assert!(
            paths.iter().any(|(p, leaf)| p == path && *leaf),
            "NO_INPUT_ERROR names {path}, which is not a command"
        );
        assert!(reason.len() >= 60, "{path}: say why in a sentence");
    }
}

/// The normalisers themselves: a mask that stopped matching would let a
/// machine path or a digest into a golden, and the next machine fails.
#[test]
fn the_normalisers_mask_what_they_say() {
    assert_eq!(
        mask_before("wrote 7681 bytes, 3 bytes", " bytes", "<N>"),
        "wrote <N> bytes, <N> bytes"
    );
    assert_eq!(
        mask_after(
            "Is a directory (os error 21)",
            "(os error ",
            |c| c.is_ascii_digit(),
            "<N>"
        ),
        "Is a directory (os error <N>)"
    );
    assert_eq!(
        mask_rs_lines("panicked at crates/x/src/read.rs:484:34:\nindex"),
        "panicked at crates/x/src/read.rs:<LINE>:\nindex"
    );
    assert_eq!(
        mask_hex("page 1 usp ab892e7cce5deb35 x"),
        "page 1 usp <DIGEST> x"
    );
    assert_eq!(
        mask_hex("1234567890123456"),
        "1234567890123456",
        "an all-digit number is not a digest"
    );
    assert_eq!(
        mask_hex("Error: ABC def"),
        "Error: ABC def",
        "uppercase hex is text, and the scan moves on"
    );
    let v: Value = serde_json::from_str(
        r#"{"b":422.39062,"a":{"stateHash":"ff","pageDigests":{"usp":1}},"protocol":74}"#,
    )
    .unwrap();
    let c = canonical(&v, None);
    assert_eq!(c["b"], serde_json::json!(422.391));
    assert_eq!(c["a"]["stateHash"], "<DIGEST>");
    assert_eq!(c["a"]["pageDigests"]["usp"], "<DIGEST>");
    if paged_canvas::channel::PROTOCOL_VERSION.0 == 74 {
        assert_eq!(c["protocol"], "<PROTOCOL>");
    }
    assert_eq!(
        mask_epoch_ms("\"createdAt\": 1792379086468,"),
        "\"createdAt\": <TIME>,"
    );
    assert_eq!(
        mask_epoch_ms("12345678901234 1234567890123.5"),
        "12345678901234 1234567890123.5"
    );
    assert_eq!(quote("a b"), "'a b'");
    assert_eq!(quote("page:#2"), "page:#2");
}
