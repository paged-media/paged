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

//! `paged template` (editor plan F6): a template's fields, filling them as a
//! filler, and checking a submission, with the engine messages the editor's
//! form sends (engine ADR 1001). The Node CLI's `paged-node template` is the
//! same over its own session; this one needs no Node.
//!
//! `fill` takes the filler role, so a value the template does not permit is
//! refused here as in the browser. `check` refills the template with the
//! submission's own values and compares the two documents page by page (the
//! display lists) and as a whole (the model's state hash): any other
//! difference is a change the template did not allow.

use std::path::Path;

use anyhow::{anyhow, bail, Context as _, Result};
use paged_canvas::channel::{MainToWorkerKind, WorkerToMainKind};
use paged_canvas::template::{FieldValue, TemplateFieldSummary, TemplateFieldValue};
use serde_json::{json, Value};

use crate::engine::Session;
use crate::export::{export_bytes, format_for, PdfOptions};
use crate::options::DocumentOptions;

fn open(doc: &Path, opts: &DocumentOptions) -> Result<Session> {
    let mut session = Session::new();
    opts.open(&mut session, doc)?;
    Ok(session)
}

fn fields_of(session: &Session) -> Result<Vec<TemplateFieldSummary>> {
    Ok(session.model()?.template_fields())
}

/// `paged template fields <doc>`.
pub fn fields(doc: &Path, opts: &DocumentOptions, json_out: bool) -> Result<()> {
    let session = open(doc, opts)?;
    let rows = fields_of(&session)?;
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "fields": rows }))?
        );
    } else if rows.is_empty() {
        println!("no fields");
    } else {
        for r in &rows {
            println!(
                "{}\t{}\t{}",
                r.field.name,
                serde_json::to_value(r.field.kind)?
                    .as_str()
                    .unwrap_or_default(),
                serde_json::to_string(&r.value)?
            );
        }
    }
    Ok(())
}

/// The values a `--values` argument names: a JSON list of `{name, value}`,
/// or an object of name → text | boolean | value, inline or in a file.
pub fn read_values(arg: &str) -> Result<Vec<TemplateFieldValue>> {
    let text = if arg.trim_start().starts_with(['[', '{']) {
        arg.to_string()
    } else {
        std::fs::read_to_string(arg).with_context(|| format!("read {arg}"))?
    };
    let parsed: Value = serde_json::from_str(&text).context("--values is not JSON")?;
    match parsed {
        Value::Array(_) => Ok(serde_json::from_value(parsed)?),
        Value::Object(map) => map
            .into_iter()
            .map(|(name, v)| {
                let value: FieldValue = match v {
                    Value::String(text) => FieldValue::Text { text },
                    Value::Bool(visible) => FieldValue::Visible { visible },
                    other => serde_json::from_value(other)?,
                };
                Ok(TemplateFieldValue { name, value })
            })
            .collect(),
        _ => bail!("--values is a list of {{name, value}} or an object of name → value"),
    }
}

/// Fills `values` in a filler session; an error names what was refused.
fn fill_session(session: &mut Session, values: Vec<TemplateFieldValue>) -> Result<()> {
    let policy = paged_template::SessionPolicy {
        role: paged_template::Role::Filler,
        overrides: vec![],
    };
    match session.send(MainToWorkerKind::SetSessionPolicy { policy })? {
        WorkerToMainKind::SessionPolicyApplied { .. } => {}
        other => bail!("the engine did not take the filler role: {other:?}"),
    }
    match session.send(MainToWorkerKind::SetTemplateFields { values })? {
        WorkerToMainKind::MutationApplied { .. } => Ok(()),
        WorkerToMainKind::TemplateFieldsRefused { problems } => Err(anyhow!(
            "values do not fit their fields: {}",
            serde_json::to_string(&problems)?
        )),
        WorkerToMainKind::MutationFailed { error } => {
            Err(anyhow!("fill refused: {}", serde_json::to_string(&error)?))
        }
        other => Err(anyhow!("fill: the engine answered {other:?}")),
    }
}

/// `paged template fill <template> --values … -o <out>`.
pub fn fill(
    template: &Path,
    opts: &DocumentOptions,
    values: &str,
    out: &Path,
    pdf: &PdfOptions,
) -> Result<()> {
    let format = format_for(out)?;
    let mut session = open(template, opts)?;
    fill_session(&mut session, read_values(values)?)?;
    let bytes = export_bytes(&mut session, format, pdf)?;
    std::fs::write(out, &bytes).with_context(|| format!("write {}", out.display()))?;
    println!("{} — {format}, {} bytes", out.display(), bytes.len());
    Ok(())
}

/// The values a filled document holds, as `fill` takes them.
fn values_of(rows: &[TemplateFieldSummary]) -> Vec<TemplateFieldValue> {
    rows.iter()
        .filter_map(|r| {
            r.value.clone().map(|value| TemplateFieldValue {
                name: r.field.name.clone(),
                value,
            })
        })
        .collect()
}

/// `paged template check <template> <filled>`: true when only the fields
/// differ.
pub fn check(
    template: &Path,
    filled: &Path,
    opts: &DocumentOptions,
    json_out: bool,
) -> Result<bool> {
    let submitted = open(filled, opts)?;
    let values = values_of(&fields_of(&submitted)?);
    let mut expected = open(template, opts)?;
    fill_session(&mut expected, values.clone())?;
    let (want, got) = (expected.model()?, submitted.model()?);
    let mut pages = Vec::new();
    let ids: Vec<paged_canvas::PageId> = want.page_ids().chain(got.page_ids()).cloned().collect();
    for page in &ids {
        let a = want.display_list_for_page(page).map(|d| d.digest());
        let b = got.display_list_for_page(page).map(|d| d.digest());
        if a != b && !pages.contains(&page.0) {
            pages.push(page.0.clone());
        }
    }
    let state = want.current_state_hash() != got.current_state_hash();
    let ok = pages.is_empty() && !state;
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "ok": ok,
                "values": values,
                "pagesThatDiffer": pages,
                "documentDiffers": state,
            }))?
        );
    } else if ok {
        println!("ok: only the template's fields differ");
    } else if pages.is_empty() {
        println!(
            "changed outside the template's fields, in nothing a page draws (an empty frame, a style, a label or a setting)"
        );
    } else {
        println!(
            "changed outside the template's fields on page(s): {}",
            pages.join(", ")
        );
    }
    Ok(ok)
}
