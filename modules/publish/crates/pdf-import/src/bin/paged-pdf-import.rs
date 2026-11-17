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

//! `paged-pdf-import` — the structure reader (publish ADR 660) on the
//! command line:
//!
//! ```text
//! paged-pdf-import IN.pdf -o OUT.paged [--recipe R.json] [--fonts DIR]…
//!                  [--report REPORT.json] [--pages A-B]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut recipe: Option<PathBuf> = None;
    let mut report: Option<PathBuf> = None;
    let mut fonts: Vec<PathBuf> = Vec::new();
    let mut pages: Option<[usize; 2]> = None;
    let mut dump_fonts: Option<PathBuf> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "-o" | "--output" => output = args.next().map(PathBuf::from),
            "--recipe" => recipe = args.next().map(PathBuf::from),
            "--report" => report = args.next().map(PathBuf::from),
            "--fonts" => fonts.extend(args.next().map(PathBuf::from)),
            // Analysis: write the PDF's embedded font programs and stop.
            "--dump-fonts" => dump_fonts = args.next().map(PathBuf::from),
            "--pages" => {
                pages = args.next().and_then(|s| {
                    let (a, b) = s.split_once('-').unwrap_or((s.as_str(), s.as_str()));
                    Some([a.parse().ok()?, b.parse().ok()?])
                })
            }
            "-h" | "--help" => {
                eprintln!(
                    "paged-pdf-import IN.pdf -o OUT.paged [--recipe R.json] [--fonts DIR]... [--report R.json] [--pages A-B]"
                );
                return ExitCode::SUCCESS;
            }
            _ if input.is_none() => input = Some(PathBuf::from(a)),
            other => {
                eprintln!("unexpected argument: {other}");
                return ExitCode::from(2);
            }
        }
    }
    if let (Some(input), Some(dir)) = (&input, &dump_fonts) {
        let bytes = std::fs::read(input).unwrap_or_default();
        let reader = match pdf_import::vectors::Reader::open(&bytes) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        };
        let _ = std::fs::create_dir_all(dir);
        for (name, ext, data) in reader.font_programs() {
            let safe: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let _ = std::fs::write(dir.join(format!("{safe}.{ext}")), data);
            eprintln!("{name}.{ext}");
        }
        return ExitCode::SUCCESS;
    }
    let (Some(input), Some(output)) = (input, output) else {
        eprintln!("usage: paged-pdf-import IN.pdf -o OUT.paged [--recipe R.json] [--fonts DIR]...");
        return ExitCode::from(2);
    };
    let bytes = match std::fs::read(&input) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{}: {e}", input.display());
            return ExitCode::FAILURE;
        }
    };
    let mut recipe_v: pdf_import::reconstruct::Recipe = match &recipe {
        Some(p) => match std::fs::read_to_string(p)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{}: {e}", p.display());
                return ExitCode::FAILURE;
            }
        },
        None => Default::default(),
    };
    if pages.is_some() {
        recipe_v.pages = pages;
    }
    let book = pdf_import::reconstruct::FontBook::load(&fonts);
    let started = std::time::Instant::now();
    let r = match pdf_import::reconstruct::reconstruct(&bytes, &recipe_v, &book) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let dp = &r.document.designmap.document_preference;
    let (w, h) = dp.page_width.zip(dp.page_height).unwrap_or((612.0, 792.0));
    let name = recipe_v
        .name
        .clone()
        .unwrap_or_else(|| "Imported.pdf".into());
    let out = match paged_store::package::wrap_document(&r.document, &name, w, h) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("encode: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = std::fs::write(&output, out) {
        eprintln!("{}: {e}", output.display());
        return ExitCode::FAILURE;
    }
    let rep = serde_json::to_string_pretty(&r.report).unwrap_or_default();
    if let Some(p) = report {
        let _ = std::fs::write(p, &rep);
    }
    eprintln!(
        "{} pages, {} spreads, {} frames, {} stories, {} threads, {} paragraph styles, {} character styles, {} swatches, masters {:?} in {:.1}s",
        r.report.pages,
        r.report.spreads,
        r.report.text_frames,
        r.report.stories,
        r.report.threads,
        r.report.paragraph_styles.len(),
        r.report.character_styles.len(),
        r.report.swatches,
        r.report.masters,
        started.elapsed().as_secs_f32()
    );
    ExitCode::SUCCESS
}
