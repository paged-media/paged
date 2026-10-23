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

//! `paged package` — through the binary, asserting on the FOLDER it
//! leaves behind: the document re-pointed at `Links/`, the linked file
//! that exists copied there, the one that does not reported missing,
//! the used family's faces in `Document fonts/`, and the two text files;
//! and the document as `.paged`, carrying the module content IDML cannot.

use std::io::Read;
use std::path::PathBuf;
use std::process::Command;

fn dir(who: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("paged-package-{who}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("mkdir");
    d
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn package_collects_links_and_fonts_into_one_folder() {
    let work = dir("collect");
    // `images.idml` links `file:checker-128.png` (relative to the
    // document) and `file:photo.webp`, which is not beside it.
    let doc = work.join("images.idml");
    std::fs::copy(repo().join("corpus/generated/images.idml"), &doc).expect("copy fixture");
    std::fs::write(work.join("checker-128.png"), b"not decoded by a package").expect("link");
    let out = work.join("pkg");

    let run = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args([
            "package",
            doc.to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .args([
            "--fonts",
            repo().join("corpus/fonts").to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("run paged package");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&run.stdout).expect("report json");

    let link = |name: &str| {
        report["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["fileName"] == name)
            .unwrap_or_else(|| panic!("no link {name}: {report:#}"))
            .clone()
    };
    assert_eq!(link("checker-128.png")["status"], "copied");
    assert_eq!(link("photo.webp")["status"], "missing");
    assert_eq!(
        std::fs::read(out.join("Links/checker-128.png")).unwrap(),
        b"not decoded by a package"
    );

    let open_sans = report["fonts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["family"] == "Open Sans")
        .expect("Open Sans is used");
    assert_eq!(open_sans["status"], "copied");
    assert!(out.join("Document fonts/OpenSans.ttf").is_file());

    assert!(out.join("Instructions.txt").is_file());
    assert!(out.join("images Report.txt").is_file());

    // The packaged document points at its own Links folder.
    let file = std::fs::File::open(out.join("images.idml")).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let mut spreads = String::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        if entry.name().unwrap().starts_with("Spreads/") {
            entry.read_to_string(&mut spreads).unwrap();
        }
    }
    let links_dir = out.canonicalize().unwrap().join("Links");
    assert!(
        spreads.contains(&format!("file:{}/checker-128.png", links_dir.display())),
        "links not re-pointed"
    );
}

#[test]
fn package_refuses_a_folder_that_holds_files() {
    let work = dir("refuse");
    std::fs::write(work.join("keep.txt"), b"x").unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["package"])
        .arg(repo().join("corpus/generated/images.idml"))
        .args(["-o", work.to_str().unwrap()])
        .output()
        .expect("run paged package");
    assert!(!run.status.success());
    assert_eq!(std::fs::read(work.join("keep.txt")).unwrap(), b"x");
}

#[test]
fn package_keeps_module_content_in_the_paged_document() {
    let work = dir("module");
    let src = work.join("plain.paged");
    let run = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["export", "--format", "paged", "-o"])
        .arg(&src)
        .arg(repo().join("corpus/generated/images.idml"))
        .output()
        .expect("run paged export");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    // One module part, as a module's save writes it.
    const PART: &str = "paged/media.example.module/o1/spec.json";
    let spec = work.join("spec.json");
    std::fs::write(&spec, br#"{"cells":1}"#).unwrap();
    let doc = work.join("module.paged");
    let run = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["parts", "write"])
        .arg(&src)
        .arg(PART)
        .arg(&spec)
        .arg(format!("--save={}", doc.display()))
        .output()
        .expect("run paged parts write");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );

    let package = |out: &PathBuf, extra: &[&str]| {
        let run = Command::new(env!("CARGO_BIN_EXE_paged"))
            .arg("package")
            .arg(&doc)
            .arg("-o")
            .arg(out)
            .args(extra)
            .arg("--json")
            .output()
            .expect("run paged package");
        assert!(
            run.status.success(),
            "{}",
            String::from_utf8_lossy(&run.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&run.stdout).expect("report json")
    };

    let out = work.join("pkg");
    let report = package(&out, &[]);
    assert_eq!(report["moduleParts"], serde_json::json!([PART]));
    assert!(report["paged"].as_str().unwrap().ends_with("module.paged"));
    let mut zip = zip::ZipArchive::new(std::fs::File::open(out.join("module.paged")).unwrap())
        .expect("a .paged is a zip");
    let mut part = String::new();
    zip.by_name(PART)
        .expect("the part rides the .paged")
        .read_to_string(&mut part)
        .unwrap();
    assert_eq!(part, r#"{"cells":1}"#);
    let idml = zip::ZipArchive::new(std::fs::File::open(out.join("module.idml")).unwrap()).unwrap();
    assert!(
        idml.index_for_name(PART).is_none(),
        "the IDML carries no module part"
    );
    let text = std::fs::read_to_string(out.join("module Report.txt")).unwrap();
    assert!(
        text.contains("Module content: 1 part(s), in module.paged (IDML does not carry them)"),
        "{text}"
    );
    assert!(text.contains("Paged document: module.paged"), "{text}");

    let bare = work.join("bare");
    let report = package(&bare, &["--no-paged"]);
    assert!(report["paged"].is_null());
    assert!(!bare.join("module.paged").exists());
    let text = std::fs::read_to_string(bare.join("module Report.txt")).unwrap();
    assert!(
        text.contains("Module content not carried by IDML: 1 part(s) (left out: --no-paged)"),
        "{text}"
    );
}
