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

//! `paged engine-serve` end to end: the real binary on a port, one stateless
//! call that loads a document, runs a script, renders and exports; PDF and
//! PDF/X exports; concurrent calls answered in parallel, each on its own
//! engine.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

fn call(port: u16, body: &Value) -> (u16, Value) {
    let text = body.to_string();
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "POST /run HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{text}", text.len()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status: u16 = out.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = out.split_once("\r\n\r\n").unwrap().1;
    (status, serde_json::from_str(body).unwrap())
}

#[test]
fn one_call_loads_scripts_renders_and_exports() {
    let dir = std::env::temp_dir().join(format!("paged-engine-serve-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let doc = dir.join("d.paged");
    assert!(Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["new", "--size", "a5", "--out", doc.to_str().unwrap()])
        .status()
        .unwrap()
        .success());
    let port = 20000 + (std::process::id() % 20000) as u16;
    let mut child = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["engine-serve", "--port", &port.to_string()])
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let file = b64.encode(std::fs::read(&doc).unwrap());
    let script = r#"
        const p = paged.pages(); const list = typeof p === "string" ? JSON.parse(p) : p;
        paged.insertTextFrame(list[0].selfId, [72, 72, 200, 300]);
        console.log("pages:" + list.length);
    "#;
    let (status, out) = call(
        port,
        &json!({ "file": file, "script": script, "render": { "page": 1 }, "export": true }),
    );
    assert_eq!(status, 200, "{out}");
    assert!(out["error"].is_null(), "{out}");
    assert!(out["output"].to_string().contains("pages:1"));
    assert!(b64
        .decode(out["png"].as_str().unwrap())
        .unwrap()
        .starts_with(b"\x89PNG"));
    let edited = b64.decode(out["file"].as_str().unwrap()).unwrap();
    assert!(edited.starts_with(b"PK"));
    assert_ne!(
        edited,
        std::fs::read(&doc).unwrap(),
        "the script's frame is in the export"
    );

    let (status, _) = call(port, &json!({ "script": "1" }));
    assert_eq!(status, 422, "a call without a document is refused");
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A server on its own port with `extra` flags, and a blank A5 document.
struct Served {
    child: std::process::Child,
    port: u16,
    dir: std::path::PathBuf,
    file: String,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn serve(tag: &str, offset: u16, extra: &[&str]) -> Served {
    let dir = std::env::temp_dir().join(format!("paged-engine-serve-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let doc = dir.join("d.paged");
    assert!(Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["new", "--size", "a5", "--out", doc.to_str().unwrap()])
        .status()
        .unwrap()
        .success());
    let port = 20000 + ((std::process::id() + u32::from(offset)) % 20000) as u16;
    let child = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["engine-serve", "--port", &port.to_string()])
        .args(extra)
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let file = base64::engine::general_purpose::STANDARD.encode(std::fs::read(&doc).unwrap());
    Served {
        child,
        port,
        dir,
        file,
    }
}

const TEXT_SCRIPT: &str = r#"
    const p = paged.pages(); const list = typeof p === "string" ? JSON.parse(p) : p;
    const f = paged.insertTextFrame(list[0].selfId, [72, 72, 200, 300]);
    console.log("frame:" + f);
"#;

#[test]
fn exports_pdf_alone_and_beside_the_paged() {
    let s = serve("pdf", 7, &[]);
    let b64 = base64::engine::general_purpose::STANDARD;
    let (status, out) = call(
        s.port,
        &json!({ "file": s.file, "script": TEXT_SCRIPT, "export": "pdf" }),
    );
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["format"], "pdf");
    let pdf = b64.decode(out["file"].as_str().unwrap()).unwrap();
    assert!(pdf.starts_with(b"%PDF-"), "a PDF comes back");

    let (status, out) = call(
        s.port,
        &json!({ "file": s.file, "export": [ "paged", { "format": "pdf", "pdf": { "standard": "pdf17" } } ] }),
    );
    assert_eq!(status, 200, "{out}");
    let files = out["files"]
        .as_array()
        .expect("an array of exports answers files");
    assert_eq!(files.len(), 2);
    assert_eq!(files[0]["format"], "paged");
    assert!(b64
        .decode(files[0]["file"].as_str().unwrap())
        .unwrap()
        .starts_with(b"PK"));
    assert_eq!(files[1]["format"], "pdf");
    assert!(b64
        .decode(files[1]["file"].as_str().unwrap())
        .unwrap()
        .starts_with(b"%PDF-"));

    let (status, out) = call(s.port, &json!({ "file": s.file, "export": "docx" }));
    assert_eq!(status, 422, "an unknown export format is refused: {out}");
    assert!(out["error"].as_str().unwrap().contains("docx"), "{out}");
}

#[test]
fn exports_pdf_x4_with_the_calls_own_profile() {
    let Some(icc) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        paged_test_resources::skip!(
            paged_test_resources::Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let s = serve("pdfx", 13, &[]);
    let b64 = base64::engine::general_purpose::STANDARD;
    let (status, out) = call(
        s.port,
        &json!({
            "file": s.file,
            "cmykProfile": b64.encode(&icc),
            "export": { "format": "pdf", "pdf": { "standard": "pdfx4" } },
        }),
    );
    assert_eq!(status, 200, "{out}");
    let pdf = b64.decode(out["file"].as_str().unwrap()).unwrap();
    let text = String::from_utf8_lossy(&pdf);
    assert!(
        text.contains("/OutputIntent"),
        "PDF/X-4 carries an output intent"
    );
    assert!(text.contains("PDF/X-4"), "and says it is PDF/X-4");
}

#[test]
fn concurrent_calls_each_run_on_an_engine_of_their_own() {
    let s = serve("conc", 19, &["--workers", "4"]);
    let b64 = base64::engine::general_purpose::STANDARD;
    let port = s.port;
    let base_script = r#"const t = paged.stories(); console.log("stories:" + (typeof t === "string" ? JSON.parse(t) : t).length);"#;
    let (status, out) = call(port, &json!({ "file": s.file, "script": base_script }));
    assert_eq!(status, 200, "{out}");
    let base: usize = out["output"]
        .to_string()
        .split("stories:")
        .nth(1)
        .and_then(|t| t.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no story count in {out}"));
    let calls: Vec<_> = (0..8)
        .map(|i| {
            let file = s.file.clone();
            std::thread::spawn(move || {
                // Each call adds a different number of frames; a shared
                // engine would leak one call's frames into another's count.
                let script = format!(
                    r#"
                    const p = paged.pages(); const list = typeof p === "string" ? JSON.parse(p) : p;
                    for (let k = 0; k < {n}; k++) paged.insertTextFrame(list[0].selfId, [72 + k, 72, 200 + k, 300]);
                    const t = paged.stories(); const stories = typeof t === "string" ? JSON.parse(t) : t;
                    console.log("stories:" + stories.length);
                "#,
                    n = i + 1
                );
                let (status, out) = call(port, &json!({ "file": file, "script": script, "export": "pdf" }));
                (i, status, out)
            })
        })
        .collect();
    for c in calls {
        let (i, status, out) = c.join().unwrap();
        assert_eq!(status, 200, "call {i}: {out}");
        assert!(out["error"].is_null(), "call {i}: {out}");
        assert!(
            out["output"]
                .to_string()
                .contains(&format!("stories:{}", base + i + 1)),
            "call {i} sees only its own frames: {out}"
        );
        assert!(b64
            .decode(out["file"].as_str().unwrap())
            .unwrap()
            .starts_with(b"%PDF-"));
    }
}

/// A blank A4 IDML, the shape `paged new --format idml` makes: no story,
/// so no run of the loaded document asks for any face.
fn blank_a4_idml(dir: &std::path::Path) -> String {
    let doc = dir.join("blank.idml");
    assert!(Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["new", "--size", "a4", "--format", "idml"])
        .args(["--out", doc.to_str().unwrap()])
        .status()
        .unwrap()
        .success());
    base64::engine::general_purpose::STANDARD.encode(std::fs::read(&doc).unwrap())
}

const FILL_SCRIPT: &str = r#"
    const page = JSON.parse(paged.pages())[0].selfId;
    paged.insertTextFrame(page, [72, 72, 200, 400]);
    const stories = JSON.parse(paged.stories());
    paged.insertText(stories[stories.length - 1].selfId, 0, "Desk lamp DL-300 49.00 EUR");
"#;

/// Text a call's script sets on a page that had none is set with the
/// fallback face: the PDF embeds it as a font (a text layer, not
/// outlines) and the PNG has ink inside the frame. Before the fix the
/// font table of a document loaded without text never held the fallback
/// face's bytes, so the exporter drew the glyphs as paths and no font
/// object was written.
#[test]
fn text_a_script_sets_on_a_blank_page_is_set_in_the_fallback_face() {
    let s = serve("text", 23, &[]);
    let b64 = base64::engine::general_purpose::STANDARD;
    let file = blank_a4_idml(&s.dir);
    let (status, out) = call(
        s.port,
        &json!({ "file": file, "script": FILL_SCRIPT, "render": { "page": 1, "dpi": 72 }, "export": "pdf" }),
    );
    assert_eq!(status, 200, "{out}");
    assert!(out["error"].is_null(), "{out}");
    let pdf = b64.decode(out["file"].as_str().unwrap()).unwrap();
    let text = String::from_utf8_lossy(&pdf);
    assert!(
        text.contains("/FontFile2") && text.contains("/ToUnicode"),
        "the text is set in an embedded font with a text layer, not drawn as outlines"
    );

    let png = image::load_from_memory(&b64.decode(out["png"].as_str().unwrap()).unwrap())
        .unwrap()
        .to_luma8();
    // The frame is [top 72, left 72, bottom 200, right 400] pt; at 72 dpi
    // a point is a pixel.
    let inked = (72..200)
        .flat_map(|y| (72..400).map(move |x| (x, y)))
        .filter(|&(x, y)| png.get_pixel(x, y).0[0] < 128)
        .count();
    assert!(inked > 100, "the frame has ink: {inked} dark pixels");

    // PDF/X-4 with the call's own profile sets the same text the same way.
    if let Some(icc) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR")) {
        let (status, out) = call(
            s.port,
            &json!({
                "file": file,
                "script": FILL_SCRIPT,
                "cmykProfile": b64.encode(&icc),
                "export": { "format": "pdf", "pdf": { "standard": "pdfx4" } },
            }),
        );
        assert_eq!(status, 200, "{out}");
        let pdf = b64.decode(out["file"].as_str().unwrap()).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("PDF/X-4") && text.contains("/FontFile2"));
    }
}

/// A server-level `--fonts` directory reaches every call's engine: a run
/// that names the family a registered face claims is set in that face.
#[test]
fn server_fonts_reach_every_call() {
    let fonts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts");
    let s = serve(
        "fonts",
        29,
        &["--fonts", fonts.to_str().unwrap(), "--no-default-font"],
    );
    let b64 = base64::engine::general_purpose::STANDARD;
    let file = blank_a4_idml(&s.dir);
    let script = format!(
        "{FILL_SCRIPT}
        const style = paged.createCharacterStyle({{ name: 'Face' }});
        paged.setStyleProperty('character', style, 'characterFontFamily', 'Inter');
        const st = JSON.parse(paged.stories());
        console.log('applied:' + paged.applyStyle(st[st.length - 1].selfId, 0, 26, style));"
    );
    let (status, out) = call(
        s.port,
        &json!({ "file": file, "script": script, "export": "pdf" }),
    );
    assert_eq!(status, 200, "{out}");
    let pdf = b64.decode(out["file"].as_str().unwrap()).unwrap();
    assert!(
        String::from_utf8_lossy(&pdf).contains("/FontFile2"),
        "the registered face sets the text without a fallback: {}",
        out["output"]
    );
}

/// A `cmykProfile` that is not an ICC CMYK profile is the caller's error,
/// answered 400 with a JSON error, never a PDF/X-4 with a broken output
/// intent.
#[test]
fn a_call_profile_that_is_not_icc_cmyk_is_refused() {
    let s = serve("badicc", 31, &[]);
    let b64 = base64::engine::general_purpose::STANDARD;
    let pdfx4 = json!({ "format": "pdf", "pdf": { "standard": "pdfx4" } });
    let mut rgb = vec![0u8; 128];
    rgb[16..20].copy_from_slice(b"RGB ");
    rgb[36..40].copy_from_slice(b"acsp");
    for (profile, says) in [
        (json!(""), "not an ICC profile"),
        (json!("%%% not base64"), "not base64"),
        (json!(b64.encode(b"hello")), "not an ICC profile"),
        (json!(b64.encode(&rgb)), "not CMYK"),
        (json!(42), "base64"),
    ] {
        let (status, out) = call(
            s.port,
            &json!({ "file": s.file, "cmykProfile": profile, "export": pdfx4 }),
        );
        assert_eq!(status, 400, "{profile}: {out}");
        let error = out["error"].as_str().unwrap();
        assert!(
            error.contains("cmykProfile") && error.contains(says),
            "{profile}: {error}"
        );
        assert!(out.get("file").is_none(), "no PDF comes back: {out}");
    }
}

/// A server whose `--cmyk-profile` is not an ICC CMYK profile refuses to
/// start, rather than failing (or writing a broken output intent) on
/// every call.
#[test]
fn a_server_profile_that_is_not_icc_cmyk_refuses_to_start() {
    let dir =
        std::env::temp_dir().join(format!("paged-engine-serve-badflag-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let empty = dir.join("empty.icc");
    std::fs::write(&empty, b"").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args([
            "engine-serve",
            "--port",
            "0",
            "--cmyk-profile",
            empty.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!out.status.success(), "the server does not start");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("not an ICC profile"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Editor plan F7: a call fills a template's fields before its script and
/// export, as a filler the template's policy binds, and a value that does
/// not fit is answered 422 with the problem.
#[test]
fn a_call_fills_template_fields_as_a_filler() {
    let s = serve("template", 37, &[]);
    let port = s.port;
    // The author makes a text frame a field.
    let author = r#"
        const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
        const pages = parse(paged.pages());
        const before = new Set(parse(paged.stories()).map((s) => s.selfId));
        const frame = paged.insertTextFrame(pages[0].selfId, [72, 72, 200, 300]);
        const story = parse(paged.stories()).map((s) => s.selfId).find((s) => !before.has(s));
        paged.insertText(story, 0, "Old title");
        const ok = paged.setPluginMetadata(String(frame), "x-paged:template",
          JSON.stringify({ v: 1, data: { field: { name: "headline", kind: "text", constraints: { maxLength: 20 } } } }));
        console.log("field:" + ok);
    "#;
    let (status, made) = call(
        port,
        &json!({
            "file": s.file,
            "template": { "values": [], "role": "author" },
            "script": author,
            "export": true,
        }),
    );
    assert_eq!(status, 200, "{made}");
    assert!(made["output"].to_string().contains("field:true"), "{made}");
    let template = made["file"].as_str().unwrap().to_string();

    // A filler fills it; the script sees the value.
    let (status, filled) = call(
        port,
        &json!({
            "file": template,
            "template": { "values": [{ "name": "headline", "value": { "kind": "text", "text": "Ada Example" } }] },
            "script": "console.log(JSON.stringify(paged.stories()))",
            "export": "paged",
        }),
    );
    assert_eq!(status, 200, "{filled}");
    assert!(filled["file"].is_string());

    // A value longer than the field allows is refused, with the problem.
    let (status, refused) = call(
        port,
        &json!({
            "file": template,
            "template": { "values": [{ "name": "headline", "value": { "kind": "text", "text": "A title much longer than twenty" } }] },
            "export": "pdf",
        }),
    );
    assert_eq!(status, 422, "{refused}");
    assert_eq!(refused["problems"][0]["name"], "headline", "{refused}");
    assert!(refused.get("file").is_none());
}
