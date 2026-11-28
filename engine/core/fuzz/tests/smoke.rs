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

//! The fuzz targets' bodies on the stable toolchain.
//!
//! `cargo test` here needs neither nightly nor cargo-fuzz: every target of
//! `engine_fuzz::TARGETS` runs over its `seeds/<target>/` files, over its
//! reproducers in `regressions/` (`<target>-*`), and over a fixed set of
//! truncations and byte flips of each. A panic names the input. A
//! reproducer listed in `regressions/KNOWN` is an open finding (a panic, or
//! a run that does not end in reasonable time): it is not run, and is
//! reported as open, until the parser is fixed and the line removed.
//!
//! `ENGINE_FUZZ_TARGET=<name>` runs one target; `ENGINE_FUZZ_KNOWN=1` runs
//! the open findings too (to see that one still reproduces).
//!
//! `cargo test -- --ignored write_hostile_seeds` writes the built seeds
//! (`engine_fuzz::hostile`) into `seeds/` again.

use std::collections::BTreeSet;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use engine_fuzz::{hostile, TARGETS};

/// libFuzzer calls a target on the main thread; a test thread's stack is a
/// quarter of that. The smoke run gives each target the main thread's.
const STACK_BYTES: usize = 8 << 20;

/// Mutations tried per seed: cuts and single-byte flips, evenly spread.
const CUTS: usize = 12;
const FLIPS: usize = 48;
/// Seeds past this size run as they are, without mutations.
const MUTATE_UP_TO: usize = 64 << 10;
/// Seeds that run as they are for another reason: their mutations reach an
/// open finding of `regressions/KNOWN`, which a debug build cannot sit out.
const AS_IT_IS: &[&str] = &[
    // dxf-empty-block-arrays.dxf: a block array's cells are not budgeted.
    "hostile-nested-arrays.dxf",
    // raster-avif-rav1d-unwrap.avif: the AV1 decoder unwraps a frame header
    // a damaged stream does not have.
    "bars-420-10bit.avif",
    "bars-lossless.avif",
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn files_in(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn seeds_of(target: &str) -> Vec<PathBuf> {
    files_in(&root().join("seeds").join(target))
}

fn regressions_of(target: &str) -> Vec<PathBuf> {
    let prefix = format!("{target}-");
    files_in(&root().join("regressions"))
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix))
        })
        .collect()
}

/// The reproducers `regressions/KNOWN` lists: findings not fixed yet.
fn known() -> BTreeSet<String> {
    fs::read_to_string(root().join("regressions").join("KNOWN"))
        .unwrap_or_default()
        .lines()
        .map(|l| l.split('#').next().unwrap_or("").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn mutations(seed: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    if seed.is_empty() || seed.len() > MUTATE_UP_TO {
        return out;
    }
    for i in 0..CUTS {
        let cut = seed.len() * i / CUTS;
        out.push((format!("cut at {cut}"), seed[..cut].to_vec()));
    }
    for i in 0..FLIPS {
        let at = seed.len() * i / FLIPS;
        for mask in [0xFFu8, 0x01, 0x80] {
            let mut bytes = seed.to_vec();
            bytes[at] ^= mask;
            out.push((format!("byte {at} ^ {mask:#04x}"), bytes));
        }
    }
    out
}

fn message(panic: Box<dyn std::any::Any + Send>) -> String {
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "a panic without a message".to_string())
}

fn run_target(name: &'static str, body: fn(&[u8])) -> (usize, Vec<String>, Vec<String>) {
    let known = known();
    let mut ran = 0;
    let mut failures = Vec::new();
    let mut open = Vec::new();
    let mut inputs: Vec<(PathBuf, bool)> = seeds_of(name).into_iter().map(|p| (p, true)).collect();
    inputs.extend(regressions_of(name).into_iter().map(|p| (p, false)));
    for (path, mutate) in inputs {
        let file = path.file_name().unwrap().to_string_lossy().to_string();
        if known.contains(&file) && std::env::var_os("ENGINE_FUZZ_KNOWN").is_none() {
            open.push(format!("{name}: {file}: not run"));
            continue;
        }
        let bytes = fs::read(&path).unwrap();
        // Named before it runs: a stack overflow or an abort ends the
        // process, and the last line printed says where.
        eprintln!("{name}: {file} ({} bytes)", bytes.len());
        let mut cases = vec![("as it is".to_string(), bytes.clone())];
        if mutate && !AS_IT_IS.contains(&file.as_str()) {
            cases.extend(mutations(&bytes));
        }
        for (what, case) in cases {
            ran += 1;
            if let Err(panic) = catch_unwind(AssertUnwindSafe(|| body(&case))) {
                let line = format!("{name}: {file}, {what}: {}", message(panic));
                if known.contains(&file) {
                    open.push(line);
                } else {
                    failures.push(line);
                }
            }
        }
    }
    (ran, failures, open)
}

#[test]
fn every_target_survives_its_seeds_and_regressions() {
    let mut failures = Vec::new();
    let mut open = Vec::new();
    let only = std::env::var("ENGINE_FUZZ_TARGET").ok();
    for &(name, body) in TARGETS {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        assert!(
            !seeds_of(name).is_empty(),
            "{name} has no seeds (seeds/{name}/ is empty or missing)"
        );
        let (ran, failed, known) = std::thread::Builder::new()
            .name(name.to_string())
            .stack_size(STACK_BYTES)
            .spawn(move || run_target(name, body))
            .unwrap()
            .join()
            .unwrap();
        eprintln!(
            "{name}: {ran} inputs, {} panics, {} open",
            failed.len(),
            known.len()
        );
        failures.extend(failed);
        open.extend(known);
    }
    for line in &open {
        eprintln!("KNOWN (regressions/KNOWN): {line}");
    }
    assert!(
        failures.is_empty(),
        "{} inputs panicked:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// A target that only ever sees refusals fuzzes nothing: one sound seed of
/// each format is read by its parser.
#[test]
fn the_sound_seeds_are_read() {
    let seed = |path: &str| fs::read(root().join("seeds").join(path)).unwrap();

    let idml = seed("idml_import/join.idml");
    assert!(idml_import::import_idml_doc(&idml).is_ok(), "idml");
    let paged = seed("paged_container/postcard.paged");
    assert!(
        paged_store::package::read_document(&paged).is_ok(),
        "paged container"
    );
    assert!(
        paged_store::from_bytes(&seed("paged_model/postcard.bin")).is_ok(),
        "model part"
    );
    let psd = paged_psd::PsdFile::parse(&seed("psd/paths.psd")).expect("psd");
    assert!(psd.composite_rgba8().is_ok(), "psd composite");
    let eps = paged_ps::interpret(
        &seed("postscript/square.eps"),
        &paged_ps::Options::default(),
    );
    assert!(eps.is_ok(), "eps");
    let docx = seed("docx_import/two-columns.docx");
    assert!(paged_ooxml::OpcPackage::read(&docx).is_ok(), "opc");
    assert!(docx_import::import_docx(&docx).is_ok(), "docx");
    assert!(
        paged_ooxml::tree::parse(&seed("ooxml_xml/document.bin")).is_ok(),
        "xml tree"
    );
    assert!(
        pptx_import::import_pptx(&seed("pptx_import/effect-stack.pptx")).is_ok(),
        "pptx"
    );
    let expr = String::from_utf8(seed("data_expr/fields.txt")).unwrap();
    assert!(data_expr::parse(&expr).is_ok(), "expression");
    let dxf = draw_dxf::dxf_to_svg(&seed("dxf/entities.dxf")).expect("dxf");
    assert!(dxf.report.items > 0, "dxf drew nothing");
    let nested = draw_dxf::dxf_to_svg(&seed("dxf/hostile-nested-arrays.dxf")).expect("dxf");
    assert!(
        nested.report.get("insert.budget").is_some(),
        "dxf budget not reached"
    );
    let target = paged_svg::ImportTarget {
        page_id: paged_wire::PageId("page".to_string()),
        page_origin: [0.0, 0.0],
        page_size: [612.0, 792.0],
    };
    let plan = paged_svg::plan_import(
        &seed("svg_import/merge.svg"),
        &target,
        &paged_svg::SvgImportOptions::default(),
        &[],
        &(),
    );
    assert!(
        plan.error.is_none() && plan.mutation.is_some(),
        "svg: {:?}",
        plan.error
    );
    for raster in [
        "red.png",
        "tiny.png",
        "bars-lossless.avif",
        "bars-lossless.jxl",
        "showcase-cat.jpg",
        "layered.tif",
    ] {
        let decoded = paged_raster::decode_rgba8(&seed(&format!("raster/{raster}")), Some(64));
        assert!(decoded.is_ok(), "raster {raster}: {:?}", decoded.err());
    }
    for pdf in ["page.pdf", "report.pdf"] {
        let info = pdf_import::vectors::inspect(&seed(&format!("pdf_import/{pdf}")));
        assert!(info.is_ok_and(|i| !i.pages.is_empty()), "pdf {pdf}");
    }
}

#[test]
fn the_committed_hostile_seeds_are_the_built_ones() {
    for (target, name, bytes) in hostile::seeds() {
        let path = root().join("seeds").join(target).join(&name);
        let held = fs::read(&path).unwrap_or_else(|e| {
            panic!("seeds/{target}/{name}: {e} (cargo test -- --ignored write_hostile_seeds)")
        });
        assert!(
            held == bytes,
            "seeds/{target}/{name} differs from what hostile::seeds builds"
        );
    }
}

#[test]
fn every_seed_directory_and_reproducer_names_a_target() {
    let names: BTreeSet<&str> = TARGETS.iter().map(|t| t.0).collect();
    for entry in fs::read_dir(root().join("seeds")).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            let dir = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(names.contains(dir.as_str()), "seeds/{dir} names no target");
        }
    }
    for path in files_in(&root().join("regressions")) {
        let file = path.file_name().unwrap().to_string_lossy().to_string();
        if file == "KNOWN" {
            continue;
        }
        assert!(
            names.iter().any(|t| file.starts_with(&format!("{t}-"))),
            "regressions/{file} starts with no target's name"
        );
    }
    for file in known() {
        assert!(
            root().join("regressions").join(&file).is_file(),
            "regressions/KNOWN lists {file}, which is not there"
        );
    }
}

#[test]
#[ignore = "writes seeds/: run it to regenerate the built seeds"]
fn write_hostile_seeds() {
    for (target, name, bytes) in hostile::seeds() {
        let dir = root().join("seeds").join(target);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(name), bytes).unwrap();
    }
}
