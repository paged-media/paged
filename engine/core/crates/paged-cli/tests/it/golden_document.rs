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

//! Goldens of the document commands: the root, `render`, `inspect`,
//! `export`, `script`, `package`, `new`, `gen`, `diff`, `place`, `set`,
//! `get`, `invoke`, `ops`, `query`, `describe` and `digest`.
//!
//! Each test is one command: its `--help`, a usage error (exit 2, clap's
//! message), an input error (exit 1, the CLI's own message) and its output
//! on a fixture, every one against a committed transcript
//! (`golden.rs` says what is normalised). Written files are checked for
//! structure — a PNG's size, a PDF's page count, a container's entries —
//! never for pixels: fidelity is the fidelity lane's job.

use paged_test_resources::covers;

use crate::golden::{assert_pdf, assert_png, zip_entries, Fx};

#[test]
fn root() {
    covers!("cli:paged");
    let fx = Fx::new("root");
    fx.help("paged");
    fx.run(&[]).code(2).golden("paged", "no-command");
    fx.run(&["frobnicate"])
        .code(2)
        .golden("paged", "unknown-command");
    fx.run(&["--version"]).code(0).golden("paged", "version");
    // `help <command>` is clap's spelling of `<command> --help`.
    let a = fx.run(&["help", "render"]).code(0);
    let b = fx.run(&["render", "--help"]).code(0);
    assert_eq!(
        a.stdout, b.stdout,
        "`paged help render` is `paged render --help`"
    );
}

#[test]
fn render() {
    covers!("cli:paged render");
    let fx = Fx::new("render");
    fx.help("paged render");
    fx.seeded("doc.paged");
    fx.run(&["render", "doc.paged"])
        .code(2)
        .golden("paged render", "usage-no-out");
    fx.run(&["render", "missing.paged", "-o", "p.png"])
        .code(1)
        .golden("paged render", "input-missing-doc");
    fx.run(&["render", "doc.paged", "--page", "2", "-o", "p.png"])
        .code(1)
        .golden("paged render", "input-page-out-of-range");
    fx.run(&["render", "doc.paged", "--page", "0", "-o", "p.png"])
        .code(1)
        .golden("paged render", "input-page-zero");
    fx.run(&["render", "doc.paged", "--page", "nope", "-o", "p.png"])
        .code(1)
        .golden("paged render", "input-no-such-page-id");

    fx.run(&["render", "doc.paged", "-o", "p.png"])
        .code(0)
        .golden("paged render", "page-1-144dpi");
    assert_png(&fx.read("p.png"), 1224, 1584);
    fx.run(&[
        "render",
        "doc.paged",
        "--page",
        "usp",
        "--dpi",
        "72",
        "-o",
        "id.png",
    ])
    .code(0)
    .golden("paged render", "page-id-72dpi");
    assert_png(&fx.read("id.png"), 612, 792);

    // `--all` into a directory, one file per page.
    fx.write(
        "two.js",
        "paged.insertPage(JSON.parse(paged.pages())[0].selfId);",
    );
    fx.run(&["script", "doc.paged", "two.js", "-o", "two.paged"])
        .code(0);
    std::fs::create_dir_all(fx.path("pages")).unwrap();
    fx.run(&["render", "two.paged", "--all", "--dpi", "36", "-o", "pages"])
        .code(0)
        .golden("paged render", "all-pages");
    assert_png(&fx.read("pages/page-001.png"), 306, 396);
    assert_png(&fx.read("pages/page-002.png"), 306, 396);
    fx.run(&["render", "two.paged", "--all", "-o", "not-a-dir.png"])
        .code(1)
        .golden("paged render", "input-all-needs-a-directory");
}

/// finding CLI-1 (fixed): `--all` promises "-o must then be a directory",
/// and a one-page document broke the promise both ways (an existing
/// directory refused, a new path written as a PNG file). It writes
/// `<dir>/page-001.png`, as it does for two pages.
#[test]
fn render_all_on_a_one_page_document() {
    covers!("cli:paged render");
    let fx = Fx::new("render-all-one");
    fx.seeded("doc.paged");
    std::fs::create_dir_all(fx.path("pages")).unwrap();
    fx.run(&["render", "doc.paged", "--all", "-o", "pages"])
        .code(0);
    assert_png(&fx.read("pages/page-001.png"), 1224, 1584);
    // A path that is not a directory is refused, as for two pages.
    fx.run(&["render", "doc.paged", "--all", "-o", "fresh"])
        .code(1);
    assert!(!fx.exists("fresh"), "no file named after the directory");
}

#[test]
fn inspect() {
    covers!("cli:paged inspect");
    let fx = Fx::new("inspect");
    fx.help("paged inspect");
    fx.run(&["inspect"])
        .code(2)
        .golden("paged inspect", "usage-no-doc");
    fx.run(&["inspect", "missing.idml"])
        .code(1)
        .golden("paged inspect", "input-missing-doc");
    fx.write("junk.idml", "not a zip");
    fx.run(&["inspect", "junk.idml"])
        .code(1)
        .golden("paged inspect", "input-not-a-package");
    fx.seeded("doc.paged");
    fx.run(&["inspect", "doc.paged"])
        .code(0)
        .golden("paged inspect", "table");
    let json = fx.run(&["inspect", "doc.paged", "--json"]).code(0);
    let v = json.json();
    assert_eq!(v["pageIds"], serde_json::json!(["usp"]));
    assert_eq!(v["stats"]["frames"], 5);
    json.golden("paged inspect", "json");
    // `--no-default-font`: nothing shapes, and the CLI says so.
    fx.run(&["inspect", "doc.paged", "--no-default-font"])
        .code(0)
        .golden("paged inspect", "no-default-font-warns");
}

#[test]
fn export() {
    covers!("cli:paged export");
    let fx = Fx::new("export");
    fx.help("paged export");
    fx.seeded("doc.paged");
    fx.run(&["export", "doc.paged"])
        .code(2)
        .golden("paged export", "usage-no-out");
    fx.run(&["export", "doc.paged", "--format", "docx", "-o", "x.docx"])
        .code(1)
        .golden("paged export", "input-unsupported-format");
    fx.run(&["export", "missing.paged", "-o", "x.pdf"])
        .code(1)
        .golden("paged export", "input-missing-doc");

    fx.run(&["export", "doc.paged", "-o", "out.pdf"])
        .code(0)
        .golden("paged export", "pdf-default");
    assert_pdf(&fx.read("out.pdf"), 1);
    fx.run(&["export", "doc.paged", "--format", "idml", "-o", "out.idml"])
        .code(0)
        .golden("paged export", "idml");
    let idml = zip_entries(&fx.read("out.idml"));
    assert_eq!(
        idml.first().map(String::as_str),
        Some("mimetype"),
        "IDML starts with its mimetype"
    );
    for part in [
        "designmap.xml",
        "Spreads/Spread_us.xml",
        "Stories/Story_Story_u0.xml",
    ] {
        assert!(idml.iter().any(|e| e == part), "{part} in {idml:?}");
    }
    fx.run(&[
        "export",
        "doc.paged",
        "--format",
        "paged",
        "-o",
        "out.paged",
    ])
    .code(0)
    .golden("paged export", "paged");
    let paged = zip_entries(&fx.read("out.paged"));
    assert!(
        paged.iter().any(|e| e == "paged/core/model/document.pgm"),
        "{paged:?}"
    );
    assert!(
        paged.iter().any(|e| e == "designmap.xml"),
        "a .paged is also an IDML package"
    );
    // The exported document opens again with the same content.
    fx.run(&["query", "out.paged", "frame"])
        .code(0)
        .golden("paged export", "paged-reopens");
    // A PDF option flag reaches the exporter.
    fx.run(&["export", "doc.paged", "--standard", "nope", "-o", "bad.pdf"])
        .code(1)
        .golden("paged export", "input-unknown-pdf-standard");
}

#[test]
fn script() {
    covers!("cli:paged script");
    let fx = Fx::new("script");
    fx.help("paged script");
    fx.blank("doc.paged");
    fx.run(&["script", "doc.paged"])
        .code(2)
        .golden("paged script", "usage-no-script");
    fx.run(&["script", "doc.paged", "missing.js"])
        .code(1)
        .golden("paged script", "input-missing-script");
    fx.write("throws.js", "throw new Error('boom')");
    fx.run(&["script", "doc.paged", "throws.js"])
        .code(1)
        .golden("paged script", "input-script-throws");
    fx.write("nofn.js", "paged.noSuchFunction()");
    fx.run(&["script", "doc.paged", "nofn.js"])
        .code(1)
        .golden("paged script", "input-unknown-function");
    fx.write("loop.js", "while (true) {}");
    fx.run(&[
        "script",
        "doc.paged",
        "loop.js",
        "--max-loop-iterations",
        "1000",
    ])
    .code(1)
    .golden("paged script", "input-loop-budget");
    fx.run(&["script", "doc.paged", "loop.js", "--timeout", "soon"])
        .code(1)
        .golden("paged script", "input-bad-timeout");

    fx.write(
        "build.js",
        "const pid = JSON.parse(paged.pages())[0].selfId;\n\
         console.log('frame', paged.insertTextFrame(pid, [72, 72, 200, 300]));\n\
         console.warn('careful');\n",
    );
    fx.run(&[
        "script",
        "doc.paged",
        "build.js",
        "-o",
        "built.paged",
        "--render",
        "p.png",
        "--dpi",
        "36",
    ])
    .code(0)
    .golden("paged script", "author-save-render");
    assert_png(&fx.read("p.png"), 306, 396);
    fx.run(&["query", "built.paged", "textFrame"])
        .code(0)
        .golden("paged script", "saved-frame-reads-back");
    fx.run(&["script", "doc.paged", "build.js", "-o", "built.pdf"])
        .code(0)
        .golden("paged script", "author-to-pdf");
    assert_pdf(&fx.read("built.pdf"), 1);
}

#[test]
fn package() {
    covers!("cli:paged package");
    let fx = Fx::new("package");
    fx.help("paged package");
    fx.placed("doc.paged");
    fx.run(&["package", "doc.paged"])
        .code(2)
        .golden("paged package", "usage-no-out");
    fx.run(&["package", "missing.paged", "-o", "failed"])
        .code(1)
        .golden("paged package", "input-missing-doc");
    fx.write("full/x.txt", "x");
    fx.run(&["package", "doc.paged", "-o", "full"])
        .code(1)
        .golden("paged package", "input-out-not-empty");

    fx.run(&["package", "doc.paged", "-o", "pkg"])
        .code(0)
        .golden("paged package", "report-text");
    for f in [
        "pkg/doc.idml",
        "pkg/doc.paged",
        "pkg/Links/u5.png",
        "pkg/Instructions.txt",
        "pkg/doc Report.txt",
    ] {
        assert!(fx.exists(f), "{f} is in the package");
    }
    assert_png(&fx.read("pkg/Links/u5.png"), 612, 792);
    let json = fx
        .run(&[
            "package",
            "doc.paged",
            "-o",
            "pkg2",
            "--json",
            "--instructions",
            "Print on matte.",
        ])
        .code(0);
    assert_eq!(json.json()["links"][0]["status"], "written");
    json.golden("paged package", "report-json");
    let instructions = String::from_utf8(fx.read("pkg2/Instructions.txt")).unwrap();
    assert!(instructions.contains("Print on matte."), "{instructions}");
}

/// finding CLI-8 (fixed): a `paged package` that failed (here: the document
/// is missing) left the folder it started behind (`failed/Links/`), so the
/// retry with the right document was refused. A failed package leaves no
/// folder, and the retry into the same folder succeeds.
#[test]
fn a_failed_package_leaves_no_folder_behind() {
    covers!("cli:paged package");
    let fx = Fx::new("package-failed");
    fx.placed("doc.paged");
    fx.run(&["package", "missing.paged", "-o", "failed"])
        .code(1);
    assert!(!fx.exists("failed"), "no half-made folder is left");
    fx.run(&["package", "doc.paged", "-o", "failed"]).code(0);
    assert!(fx.path("failed/Links").is_dir());
    assert!(fx.exists("failed/doc.idml"));
}

#[test]
fn new() {
    covers!("cli:paged new");
    let fx = Fx::new("new");
    fx.help("paged new");
    fx.run(&["new"]).code(2).golden("paged new", "usage-no-out");
    fx.run(&["new", "--size", "huge", "-o", "x.paged"])
        .code(1)
        .golden("paged new", "input-bad-size");
    fx.run(&["new", "--format", "pdf", "-o", "x.pdf"])
        .code(1)
        .golden("paged new", "input-bad-format");
    fx.run(&["new", "-o", "letter.paged"])
        .code(0)
        .golden("paged new", "letter-paged");
    fx.run(&["new", "--size", "a4", "--format", "idml", "-o", "a4.idml"])
        .code(0)
        .golden("paged new", "a4-idml");
    assert_eq!(
        zip_entries(&fx.read("a4.idml")).first().map(String::as_str),
        Some("mimetype")
    );
    fx.run(&["new", "--size", "200x100", "-o", "custom.paged"])
        .code(0)
        .golden("paged new", "custom-size");
    let v = fx
        .run(&["inspect", "custom.paged", "--json"])
        .code(0)
        .json();
    assert_eq!(v["pageSizesPt"], serde_json::json!([[200.0, 100.0]]));
}

#[test]
fn gen() {
    covers!("cli:paged gen");
    let fx = Fx::new("gen");
    fx.help("paged gen");
    fx.run(&["gen"])
        .code(2)
        .golden("paged gen", "usage-no-subcommand");
}

#[test]
fn gen_emit() {
    covers!("cli:paged gen emit");
    let fx = Fx::new("gen-emit");
    fx.help("paged gen emit");
    fx.run(&["gen", "emit"])
        .code(2)
        .golden("paged gen emit", "usage-no-sample");
    // The list of known samples is paged-gen's; asserted here, masked in
    // the golden so a new sample does not churn it.
    let unknown = fx
        .run(&["gen", "emit", "--sample", "nope", "--out", "g"])
        .code(1);
    assert!(
        unknown.stderr.contains(&format!(
            "known: {}",
            paged_gen::samples::SAMPLES.join(", ")
        )),
        "the error lists every sample: {}",
        unknown.stderr
    );
    unknown
        .map_stderr(|s| match s.split_once("known: ") {
            Some((head, _)) => format!("{head}known: <paged_gen::samples::SAMPLES>\n"),
            None => s.to_string(),
        })
        .golden("paged gen emit", "input-unknown-sample");
    fx.run(&["gen", "emit", "--sample", "geometry-groups", "--out", "g"])
        .code(0)
        .golden("paged gen emit", "geometry-groups");
    assert_eq!(
        zip_entries(&fx.read("g/geometry-groups.idml"))
            .first()
            .map(String::as_str),
        Some("mimetype")
    );
}

#[test]
fn gen_emit_all() {
    covers!("cli:paged gen emit-all");
    let fx = Fx::new("gen-emit-all");
    fx.help("paged gen emit-all");
    fx.run(&["gen", "emit-all", "--sample", "x"])
        .code(2)
        .golden("paged gen emit-all", "usage-unknown-flag");
    fx.write("taken", "a file, not a directory");
    fx.run(&["gen", "emit-all", "--out", "taken"])
        .code(1)
        .golden("paged gen emit-all", "input-out-is-a-file");
    let all = fx.run(&["gen", "emit-all", "--out", "g"]).code(0);
    let samples = paged_gen::samples::SAMPLES;
    for name in samples {
        assert!(fx.exists(&format!("g/{name}.idml")), "{name} emitted");
    }
    let lines: Vec<&str> = all.stdout.lines().collect();
    assert_eq!(
        lines.len(),
        samples.len() + 1,
        "one line per sample and a total"
    );
    for (line, name) in lines.iter().zip(samples) {
        assert!(line.starts_with(&format!("g/{name}.idml — ")), "{line}");
    }
    all.map_stdout(|s| {
        let first = s.lines().next().unwrap_or_default();
        let last = s.lines().last().unwrap_or_default();
        format!(
            "{first}\n<one line per sample>\n{}\n",
            last.replace(&samples.len().to_string(), "<SAMPLES>")
        )
    })
    .golden("paged gen emit-all", "emit-all");
}

#[test]
fn diff() {
    covers!("cli:paged diff");
    let fx = Fx::new("diff");
    fx.help("paged diff");
    fx.blank("blank.paged");
    fx.seeded("doc.paged");
    fx.run(&["render", "blank.paged", "--dpi", "36", "-o", "blank.png"])
        .code(0);
    fx.run(&["render", "doc.paged", "--dpi", "36", "-o", "doc.png"])
        .code(0);
    fx.run(&["render", "doc.paged", "--dpi", "72", "-o", "big.png"])
        .code(0);
    fx.run(&["diff", "doc.png"])
        .code(2)
        .golden("paged diff", "usage-one-image");
    fx.run(&["diff", "missing.png", "doc.png"])
        .code(1)
        .golden("paged diff", "input-missing-reference");
    fx.run(&["diff", "doc.png", "big.png"])
        .code(1)
        .golden("paged diff", "input-size-mismatch");
    fx.run(&["diff", "doc.png", "doc.png"])
        .code(0)
        .golden("paged diff", "identical");
    fx.run(&["diff", "doc.png", "doc.png", "--json"])
        .code(0)
        .golden("paged diff", "identical-json");
    // Beyond the budget is an ANSWER, exit 1, not an error: the verdict
    // still prints.
    let differs = fx
        .run(&[
            "diff",
            "blank.png",
            "doc.png",
            "--json",
            "--heatmap",
            "heat.png",
        ])
        .code(1);
    assert_eq!(differs.json()["passes"], false);
    assert_png(&fx.read("heat.png"), 306, 396);
    differs
        .map_stdout(|s| {
            // The ΔE numbers measure rasterised text: the shape and the
            // verdict are the golden's, the values the fidelity lane's.
            let v: serde_json::Value = serde_json::from_str(s).unwrap();
            let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
            format!("keys {keys:?}, passes {}\n", v["passes"])
        })
        .golden("paged diff", "beyond-budget");
}

#[test]
fn place() {
    covers!("cli:paged place");
    let fx = Fx::new("place");
    fx.help("paged place");
    fx.seeded("doc.paged");
    fx.run(&["render", "doc.paged", "--dpi", "36", "-o", "pic.png"])
        .code(0);
    fx.run(&["place", "doc.paged", "rectangle:u5"])
        .code(2)
        .golden("paged place", "usage-no-image");
    fx.write("pic.idml", "not an image");
    fx.run(&["place", "doc.paged", "rectangle:u5", "pic.idml"])
        .code(1)
        .golden("paged place", "input-not-an-image");
    fx.run(&[
        "place",
        "doc.paged",
        "rectangle:u5",
        "pic.png",
        "--transform",
        "1,2,3",
    ])
    .code(1)
    .golden("paged place", "input-bad-transform");
    fx.run(&["place", "doc.paged", "rectangle:u5", "missing.png"])
        .code(1)
        .golden("paged place", "input-missing-image");

    fx.run(&[
        "place",
        "doc.paged",
        "rectangle:u5",
        "pic.png",
        "--fit",
        "FillProportionally",
        "-o",
        "placed.paged",
    ])
    .code(0)
    .golden("paged place", "fit-and-save");
    fx.run(&["read", "element-geometry", "placed.paged", "rectangle:u5"])
        .code(0)
        .golden("paged place", "placed-frame-has-an-image");
    fx.run(&[
        "place",
        "doc.paged",
        "rectangle:u5",
        "pic.png",
        "--transform",
        "1,0,0,1,10,20",
        "-o",
        "moved.pdf",
    ])
    .code(0)
    .golden("paged place", "transform-to-pdf");
    assert_pdf(&fx.read("moved.pdf"), 1);
}

/// Finding CLI-5 (fixed): a write to an object that does not exist says
/// the target does not exist (notFound), as the read twin `get` does —
/// not "not implemented".
#[test]
fn writes_to_a_missing_object() {
    covers!("cli:paged place", "cli:paged set");
    let fx = Fx::new("missing-object");
    fx.seeded("doc.paged");
    fx.run(&["render", "doc.paged", "--dpi", "36", "-o", "pic.png"])
        .code(0);
    let place = fx
        .run(&["place", "doc.paged", "oval:u77", "pic.png"])
        .code(1)
        .golden("paged place", "missing-frame");
    assert!(
        place
            .stderr
            .contains("oval:u77: the target does not exist (notFound)"),
        "{}",
        place.stderr
    );
    let set = fx
        .run(&["set", "doc.paged", "oval:u99", "frameFillColor", "Color/u1"])
        .code(1)
        .golden("paged set", "missing-target");
    assert!(
        set.stderr
            .contains("oval:u99: the target does not exist (notFound)"),
        "{}",
        set.stderr
    );
}

#[test]
fn set() {
    covers!("cli:paged set");
    let fx = Fx::new("set");
    fx.help("paged set");
    fx.seeded("doc.paged");
    fx.run(&["set", "doc.paged", "oval:u2", "frameFillColor"])
        .code(2)
        .golden("paged set", "usage-no-value");
    fx.run(&["set", "doc.paged", "oval:u2", "nope", "1"])
        .code(1)
        .golden("paged set", "input-unknown-path");
    fx.run(&[
        "set",
        "doc.paged",
        "not an address",
        "frameFillColor",
        "Color/u1",
    ])
    .code(1)
    .golden("paged set", "input-bad-address");
    fx.run(&[
        "set",
        "doc.paged",
        "oval:u2",
        "frameFillColor",
        "Color/u1",
        "-o",
        "red.paged",
    ])
    .code(0)
    .golden("paged set", "colour-and-save");
    fx.run(&["get", "red.paged", "oval:u2", "frameFillColor"])
        .code(0)
        .golden("paged set", "reads-back");
    fx.run(&[
        "set",
        "doc.paged",
        "rectangle:u5",
        "frameStrokeWeight",
        "3mm",
    ])
    .code(0)
    .golden("paged set", "length-coerced");
}

#[test]
fn get() {
    covers!("cli:paged get");
    let fx = Fx::new("get");
    fx.help("paged get");
    fx.seeded("doc.paged");
    fx.run(&["get", "doc.paged", "oval:u2"])
        .code(2)
        .golden("paged get", "usage-no-path");
    fx.run(&["get", "doc.paged", "oval:u99", "frameFillColor"])
        .code(1)
        .golden("paged get", "input-missing-target");
    fx.run(&["get", "doc.paged", "oval:u2", "nope"])
        .code(1)
        .golden("paged get", "input-unknown-path");
    fx.run(&["get", "missing.paged", "doc", "pageCount"])
        .code(1)
        .golden("paged get", "input-missing-doc");
    fx.run(&["get", "doc.paged", "layer:Layer/u0", "layerName"])
        .code(0)
        .golden("paged get", "layer-name");
    fx.run(&["get", "doc.paged", "oval:u2", "frameFillColor"])
        .code(0)
        .golden("paged get", "unset-colour");
}

#[test]
fn invoke() {
    covers!("cli:paged invoke");
    let fx = Fx::new("invoke");
    fx.help("paged invoke");
    fx.seeded("doc.paged");
    fx.run(&["invoke", "doc.paged"])
        .code(2)
        .golden("paged invoke", "usage-no-op");
    let verbs = paged_cli::invoke::invokable().len();
    let possible = |s: &str| match s.split_once("[possible values: ") {
        Some((head, tail)) => {
            let listed = tail
                .split(']')
                .next()
                .unwrap_or_default()
                .split(", ")
                .count();
            assert_eq!(listed, verbs, "clap lists every invokable op");
            let after = tail.split_once(']').map(|(_, a)| a).unwrap_or_default();
            format!("{head}[possible values: <paged_cli::invoke::invokable()>]{after}")
        }
        None => s.to_string(),
    };
    fx.run(&["invoke", "doc.paged", "noSuchOp"])
        .code(2)
        .map_stderr(possible)
        .golden("paged invoke", "usage-unknown-op");
    fx.run(&["invoke", "doc.paged", "bindCreated", "{}"])
        .code(2)
        .map_stderr(possible)
        .golden("paged invoke", "usage-batch-only-op");
    fx.run(&["invoke", "doc.paged", "insertOval", "{bad"])
        .code(1)
        .golden("paged invoke", "input-args-not-json");
    fx.run(&["invoke", "doc.paged", "insertOval", r#"{"pageId":"usp"}"#])
        .code(1)
        .golden("paged invoke", "input-args-missing-field");

    fx.run(&[
        "invoke",
        "doc.paged",
        "insertOval",
        r#"{"pageId":"usp","bounds":[0,0,10,10]}"#,
        "-o",
        "inline.paged",
    ])
    .code(0)
    .golden("paged invoke", "inline-args");
    fx.write("args.json", r#"{"pageId":"usp","bounds":[20,20,40,40]}"#);
    fx.run(&["invoke", "doc.paged", "insertOval", "args.json"])
        .code(0)
        .golden("paged invoke", "args-from-file");
    fx.run_stdin(
        &["invoke", "doc.paged", "insertOval", "-"],
        Some(br#"{"pageId":"usp","bounds":[50,50,60,60]}"#),
    )
    .code(0)
    .golden("paged invoke", "args-from-stdin");
    fx.run(&["query", "inline.paged", "oval"])
        .code(0)
        .golden("paged invoke", "saved-oval-reads-back");
}

#[test]
fn ops() {
    covers!("cli:paged ops");
    let fx = Fx::new("ops");
    fx.help("paged ops");
    fx.run(&["ops", "--compact"])
        .code(2)
        .golden("paged ops", "usage-unknown-flag");
    let ops = paged_introspect::catalog::api_catalog().operations;
    let text = fx.run(&["ops"]).code(0);
    let listed: Vec<&str> = text
        .stdout
        .lines()
        .map(|l| l.split_whitespace().next().unwrap_or_default())
        .collect();
    assert_eq!(
        listed,
        ops.iter().map(String::as_str).collect::<Vec<_>>(),
        "one line per catalog op, in catalog order"
    );
    // Keep the shape and the excused ops; the list itself is the catalog's.
    text.map_stdout(|s| {
        let excused: Vec<&str> = s.lines().filter(|l| l.contains("  (")).collect();
        format!("<one catalog op per line>\n{}\n", excused.join("\n"))
    })
    .golden("paged ops", "text");
    let json = fx.run(&["ops", "--json"]).code(0);
    let rows = json.json();
    assert_eq!(rows.as_array().map(Vec::len), Some(ops.len()));
    json.map_stdout(|s| {
        let rows: serde_json::Value = serde_json::from_str(s).unwrap();
        let excused: Vec<&serde_json::Value> = rows
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["invokable"] == false)
            .collect();
        format!(
            "first: {}\nnot invokable: {}\n",
            rows[0],
            serde_json::to_string_pretty(&excused).unwrap()
        )
    })
    .golden("paged ops", "json");
}

#[test]
fn query() {
    covers!("cli:paged query");
    let fx = Fx::new("query");
    fx.help("paged query");
    fx.seeded("doc.paged");
    fx.run(&["query", "doc.paged"])
        .code(2)
        .golden("paged query", "usage-no-selector");
    fx.run(&["query", "doc.paged", "frame["])
        .code(1)
        .golden("paged query", "input-unclosed-filter");
    fx.run(&["query", "doc.paged", "nope"])
        .code(1)
        .golden("paged query", "input-unknown-kind");
    fx.run(&["query", "missing.paged", "*"])
        .code(1)
        .golden("paged query", "input-missing-doc");
    fx.run(&["query", "doc.paged", "*"])
        .code(0)
        .golden("paged query", "everything");
    fx.run(&["query", "doc.paged", "page:#1 > oval"])
        .code(0)
        .golden("paged query", "child-of-page");
    fx.run(&["query", "doc.paged", "swatch[name=Vermilion]", "--json"])
        .code(0)
        .golden("paged query", "filter-json");
}

#[test]
fn describe() {
    covers!("cli:paged describe");
    let fx = Fx::new("describe");
    fx.help("paged describe");
    fx.run(&["describe", "doc.paged"])
        .code(2)
        .golden("paged describe", "usage-unexpected-argument");
    let pretty = fx.run(&["describe"]).code(0);
    let compact = fx.run(&["describe", "--compact"]).code(0);
    assert_eq!(
        compact.stdout.trim_end().lines().count(),
        1,
        "--compact is one line"
    );
    assert_eq!(pretty.json(), compact.json(), "the same catalog either way");
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../../paged-introspect/catalog.json")).unwrap();
    assert_eq!(
        pretty.json()["catalog"],
        catalog,
        "describe prints catalog.json"
    );
    pretty
        .map_stdout(|s| {
            let v: serde_json::Value = serde_json::from_str(s).unwrap();
            let sections: Vec<&String> = v["catalog"].as_object().unwrap().keys().collect();
            format!(
                "top-level keys: {:?}\ncatalog sections: {sections:?}\nprotocol: {}\n",
                v.as_object().unwrap().keys().collect::<Vec<_>>(),
                if v["protocol"] == paged_canvas::channel::PROTOCOL_VERSION.0 {
                    "<PROTOCOL>"
                } else {
                    "WRONG"
                },
            )
        })
        .golden("paged describe", "catalog-shape");
}

/// finding CLI-3 (fixed): a command whose output a pipe stops reading
/// (`paged describe | head`) panicked, "failed printing to stdout: Broken
/// pipe", exit 101. It ends quietly with the broken-pipe status.
#[test]
fn a_closed_pipe_ends_quietly() {
    covers!("cli:paged describe");
    use std::io::Read as _;
    let fx = Fx::new("broken-pipe");
    let mut child = fx
        .command(env!("CARGO_BIN_EXE_paged"), &["describe"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn paged describe");
    let mut head = [0u8; 1024];
    child
        .stdout
        .take()
        .expect("stdout")
        .read_exact(&mut head)
        .expect("the catalog is longer than 1 KiB");
    // The read end is closed here, with ~200 KB still to write.
    let out = child.wait_with_output().expect("wait");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(141), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
    assert!(!stderr.contains("failed printing to stdout"), "{stderr}");
}

#[test]
fn digest() {
    covers!("cli:paged digest");
    let fx = Fx::new("digest");
    fx.help("paged digest");
    fx.run(&["digest"])
        .code(2)
        .golden("paged digest", "usage-no-doc");
    fx.run(&["digest", "missing.paged"])
        .code(1)
        .golden("paged digest", "input-missing-doc");
    fx.seeded("doc.paged");
    let pretty = fx.run(&["digest", "doc.paged"]).code(0);
    let compact = fx.run(&["digest", "doc.paged", "--compact"]).code(0);
    assert_eq!(pretty.json(), compact.json());
    let v = pretty.json();
    assert!(
        v["pageDigests"]["usp"].is_u64(),
        "one digest per page id: {v}"
    );
    assert_eq!(
        v["stateHash"].as_str().map(str::len),
        Some(64),
        "a sha-256 state hash"
    );
    pretty.golden("paged digest", "pretty");
    compact.golden("paged digest", "compact");
    // The verification oracle: the same document digests the same, and a
    // change changes it.
    let again = fx.run(&["digest", "doc.paged"]).code(0).json();
    assert_eq!(again, v, "deterministic");
    fx.run(&[
        "set",
        "doc.paged",
        "oval:u2",
        "frameFillColor",
        "Color/u1",
        "-o",
        "red.paged",
    ])
    .code(0);
    let red = fx.run(&["digest", "red.paged"]).code(0).json();
    assert_ne!(
        red["pageDigests"], v["pageDigests"],
        "a fill change moves the page digest"
    );
}

/// Finding CLI-6 (fixed): `paged digest`'s `stateHash`, "a second and
/// independent equality signal", hashes every serialized field of the
/// document, so an oval's fill change moves it (it once hashed only story
/// text, rectangle geometry and anchors).
#[test]
fn digest_state_hash_follows_a_fill_change() {
    covers!("cli:paged digest");
    let fx = Fx::new("digest-state-hash");
    fx.seeded("doc.paged");
    fx.run(&[
        "set",
        "doc.paged",
        "oval:u2",
        "frameFillColor",
        "Color/u1",
        "-o",
        "red.paged",
    ])
    .code(0);
    fx.run(&["get", "red.paged", "oval:u2", "frameFillColor"])
        .code(0)
        .golden("paged digest", "the-fill-is-written");
    let before = fx.run(&["digest", "doc.paged"]).code(0).json();
    let after = fx.run(&["digest", "red.paged"]).code(0).json();
    assert_ne!(
        before["pageDigests"], after["pageDigests"],
        "the pages differ"
    );
    assert_ne!(
        before["stateHash"], after["stateHash"],
        "the state hash follows the fill"
    );
}
