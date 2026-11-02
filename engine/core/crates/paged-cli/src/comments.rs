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

//! `paged comments` — the review comments a PDF carries (engine ADR 1055).
//!
//! Reads the annotations of a PDF (`paged-pdf-annots`) and prints the threads
//! Acrobat's Comment tool made, then what the PDF held that is not a
//! comment, one line per annotation type. The inverse of `paged export
//! --comments`. `--json` prints the whole report.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use paged_pdf_annots::{read_pdf_comments, ImportedAnchor, ImportedThread};

pub fn run(pdf: &Path, json: bool) -> Result<()> {
    let bytes = std::fs::read(pdf).with_context(|| format!("read {}", pdf.display()))?;
    let report = read_pdf_comments(&bytes).map_err(|e| anyhow!("{}: {e}", pdf.display()))?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    let pages = report
        .threads
        .iter()
        .map(|t| t.page_index)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    println!(
        "{} thread(s) on {pages} page(s), {} author(s)",
        report.threads.len(),
        report.authors().len()
    );
    for t in &report.threads {
        print_thread(t);
    }
    if !report.losses.is_empty() {
        println!("not imported:");
        for l in &report.losses {
            println!("  {l}");
        }
    }
    Ok(())
}

fn print_thread(t: &ImportedThread) {
    let place = match &t.anchor {
        ImportedAnchor::Point { at } => format!("at ({:.1}, {:.1})", at[0], at[1]),
        ImportedAnchor::Region { rect } => format!(
            "over ({:.1}, {:.1}, {:.1} x {:.1})",
            rect[0], rect[1], rect[2], rect[3]
        ),
    };
    let root = &t.comments[0];
    let mut flags = String::new();
    if root.resolved {
        flags.push_str(" resolved");
    } else if let Some(state) = root.review_state {
        flags.push_str(&format!(" {state:?}").to_lowercase());
    }
    println!(
        "page {} {place} {} {}{flags}",
        t.page_index + 1,
        t.subtype,
        t.id
    );
    for c in &t.comments {
        let indent = if c.parent.is_some() { "    " } else { "  " };
        println!(
            "{indent}{} {}: {}",
            c.author.as_deref().unwrap_or("(no author)"),
            c.date.as_deref().unwrap_or("(no date)"),
            c.text.replace('\n', " / ")
        );
    }
}
