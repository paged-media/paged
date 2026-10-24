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

//! `paged data` — the bindings a document carries, read and applied by the
//! engine itself (core ADR 1014).
//!
//! paged.data writes every binding whose target is a page item into that
//! item's label, and the whole recipe into the document label (data ADR 559),
//! so a document keeps its bindings through an InDesign save. `bindings`
//! reads them back (`data_session::labels`, the Rust form of the bundle's
//! reader). `apply` imports the files the recipe's sources name into the
//! store, runs its queries through the query guard, resolves the bindings at
//! one record and writes the values with the same `Mutation::Set` the editor
//! and `paged set` send: property bindings on the objects their selectors
//! name, variable bindings on their text variables (`paged:<key>`).
//!
//! What the headless lane does not write yet is reported per binding, never
//! skipped silently: images, tables, barcodes, record flows and rules need
//! the module's lowering writers, and a colour no swatch has needs the
//! swatch minted first.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use data_core::{Binding, BindingId, PropertyOutcome, TargetRef};
use data_session::core::{DataSession, LoweredOutput};
use data_session::labels::{
    document_recipe, restore_from_labels, sources_to_relink, ElementRef, LabelledElement,
    RestoredRecipe, DATA_LABEL_KEY,
};
use paged_canvas::channel::{MainToWorkerKind, Mutation, WorkerToMainKind};
use paged_wire::Address;
use serde::Serialize;
use serde_json::{json, Value};

use crate::engine::Session;
use crate::export::PdfOptions;
use crate::options::DocumentOptions;

/// The addresses a selector names in the loaded document.
fn query(session: &mut Session, selector: &str) -> Result<Vec<String>> {
    match session.send(MainToWorkerKind::RequestQuery {
        selector: selector.to_string(),
    })? {
        WorkerToMainKind::QueryResult { error: Some(e), .. } => {
            bail!("selector {selector:?} does not parse: {}", e.message)
        }
        WorkerToMainKind::QueryResult { addresses, .. } => Ok(addresses),
        other => bail!("unexpected reply to a query: {other:?}"),
    }
}

/// Every page item that carries our label, and the document label's recipe.
fn read_recipe(session: &mut Session) -> Result<RestoredRecipe> {
    let addresses = query(session, &format!("frame[label={DATA_LABEL_KEY}]"))?;
    let scene = session.model()?.scene();
    let label_of = |id: &str| {
        scene.spreads.iter().find_map(|s| {
            s.spread
                .labels
                .get(id)
                .and_then(|l| l.iter().find(|(k, _)| k == DATA_LABEL_KEY))
                .map(|(_, v)| v.clone())
        })
    };
    let elements: Vec<LabelledElement> = addresses
        .iter()
        .filter_map(|a| a.split_once(':'))
        .map(|(kind, id)| LabelledElement {
            element: ElementRef {
                kind: kind.to_string(),
                id: id.to_string(),
            },
            label: label_of(id),
        })
        .collect();
    let recipe = scene
        .designmap
        .labels
        .iter()
        .find(|(k, _)| k == DATA_LABEL_KEY)
        .and_then(|(_, v)| document_recipe(v));
    Ok(restore_from_labels(&elements, recipe.as_ref()))
}

/// The days since 1970-01-01, the serial `TODAY()` reads.
fn today() -> i32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| (d.as_secs() / 86_400) as i32)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingRow {
    id: String,
    kind: String,
    query: Option<String>,
    /// The object it writes, as the document names it today.
    host: Option<String>,
}

fn kind_of(v: &Value) -> String {
    v.get("kind")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string()
}

fn rows(recipe: &RestoredRecipe) -> Vec<BindingRow> {
    let f = &recipe.facts;
    recipe.payload["bindings"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|b| {
            let id = b
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let host = f
                .host_elements
                .get(&id)
                .or_else(|| f.lowered.get(&id))
                .map(|e| format!("{}:{}", e.kind, e.id))
                .or_else(|| {
                    f.visibility
                        .get(&id)
                        .map(|v| format!("frame:{}", v.element_id))
                })
                .or_else(|| f.image.get(&id).map(|v| format!("frame:{}", v.element_id)))
                .or_else(|| {
                    f.barcode
                        .get(&id)
                        .map(|v| format!("frame:{}", v.element_id))
                })
                .or_else(|| {
                    f.story_hosted
                        .get(&id)
                        .map(|v| format!("frame:{}", v.frame))
                });
            BindingRow {
                kind: kind_of(b),
                query: b.get("query").and_then(Value::as_str).map(str::to_string),
                id,
                host,
            }
        })
        .collect()
}

/// `paged data bindings DOC`.
pub fn bindings(doc: &Path, assets: &DocumentOptions, json: bool) -> Result<()> {
    let mut session = Session::new();
    assets.open(&mut session, doc)?;
    let recipe = read_recipe(&mut session)?;
    let rows = rows(&recipe);
    let sources = sources_to_relink(&recipe.payload);
    if json {
        let out = json!({
            "bindings": rows,
            "sources": sources,
            "queries": recipe.payload["queries"],
            "fromElements": recipe.from_elements,
        });
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("no bindings (no {DATA_LABEL_KEY} label in the document)");
        return Ok(());
    }
    for r in &rows {
        println!(
            "{}\t{}\t{}\t{}",
            r.id,
            r.kind,
            r.query.as_deref().unwrap_or("-"),
            r.host.as_deref().unwrap_or("-")
        );
    }
    for s in &sources {
        let how = match (&s.file, s.remote) {
            (Some(f), _) => format!("--source {}={f}", s.id),
            (None, true) => format!("--source {}=<a local copy> (remote)", s.id),
            (None, false) => format!("--source {}=<file>", s.id),
        };
        eprintln!("source {}: {how}", s.id);
    }
    Ok(())
}

/// What `apply` did with one binding.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub binding: String,
    /// `written`, `kept`, `failed` or `notHeadless`.
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Applied {
    fn new(binding: &str, outcome: &'static str) -> Self {
        Self {
            binding: binding.to_string(),
            outcome,
            targets: Vec::new(),
            path: None,
            value: None,
            message: None,
        }
    }
    fn because(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

/// Parse `--source ID=FILE`.
pub fn parse_source(spec: &str) -> Result<(String, PathBuf)> {
    let (id, file) = spec
        .split_once('=')
        .ok_or_else(|| anyhow!("{spec:?} is not ID=FILE"))?;
    Ok((id.to_string(), PathBuf::from(file)))
}

fn format_of(source: &Value, file: &Path) -> Result<data_store::Format> {
    let declared = source
        .get("kind")
        .and_then(|k| k.get("format"))
        .and_then(Value::as_str)
        .map(|f| if f == "excel" { "xlsx" } else { f });
    let by_name = file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    declared
        .and_then(data_store::Format::parse)
        .or_else(|| by_name.as_deref().and_then(data_store::Format::parse))
        .ok_or_else(|| anyhow!("{}: no csv/tsv/json/parquet/xlsx format", file.display()))
}

fn set(session: &mut Session, address: &str, path: &str, value: &Value) -> Result<()> {
    let address = Address::parse(address).map_err(|e| anyhow!("{address}: {e}"))?;
    let resolved = session
        .model()?
        .target_of(&address)
        .map_err(|e| anyhow!(e))?;
    let schema = crate::object::schema_of(&resolved, path)?;
    let value =
        paged_introspect::schema::from_json(&schema, value).map_err(|e| anyhow!("{path}: {e}"))?;
    match session.send(MainToWorkerKind::Mutate(Mutation::Set {
        address,
        path: path.to_string(),
        value,
    }))? {
        WorkerToMainKind::MutationApplied { .. } => Ok(()),
        WorkerToMainKind::MutationFailed { error } => bail!("{error}"),
        other => bail!("the engine answered {other:?}"),
    }
}

fn apply_property(
    session: &mut Session,
    binding: &str,
    target: &TargetRef,
    path: &str,
    outcome: &PropertyOutcome,
) -> Applied {
    let mut row = Applied::new(binding, "written");
    row.path = Some(path.to_string());
    let value = match outcome {
        PropertyOutcome::Keep { reason } => {
            return Applied {
                outcome: "kept",
                ..row
            }
            .because(reason.clone())
        }
        PropertyOutcome::Fail { message } => {
            return Applied {
                outcome: "failed",
                ..row
            }
            .because(message.clone())
        }
        PropertyOutcome::Write { value, .. } => serde_json::to_value(value).unwrap_or(Value::Null),
    };
    row.value = Some(value.clone());
    let selector = match target {
        TargetRef::Selector(s) => s.clone(),
        TargetRef::Host => {
            return Applied {
                outcome: "failed",
                ..row
            }
            .because("a host target outside a label")
        }
    };
    let targets = match query(session, &selector) {
        Ok(t) if !t.is_empty() => t,
        Ok(_) => {
            return Applied {
                outcome: "failed",
                ..row
            }
            .because(format!("{selector} names nothing"))
        }
        Err(e) => {
            return Applied {
                outcome: "failed",
                ..row
            }
            .because(e.to_string())
        }
    };
    for t in &targets {
        if let Err(e) = set(session, t, path, &value) {
            return Applied {
                outcome: "failed",
                targets: targets.clone(),
                ..row
            }
            .because(format!("{t}: {e}"));
        }
    }
    row.targets = targets;
    row
}

fn apply_variable(session: &mut Session, binding: &str, key: &str, text: &str) -> Applied {
    let mut row = Applied::new(binding, "written");
    row.path = Some("textVariableContents".into());
    row.value = Some(Value::String(text.to_string()));
    let name = format!("paged:{key}");
    let targets = match query(session, &format!("textVariable[name=\"{name}\"]")) {
        Ok(t) if !t.is_empty() => t,
        Ok(_) => {
            return Applied {
                outcome: "notHeadless",
                ..row
            }
            .because(format!(
                "no text variable {name} (a placeholder field is written by the module)"
            ))
        }
        Err(e) => {
            return Applied {
                outcome: "failed",
                ..row
            }
            .because(e.to_string())
        }
    };
    for t in &targets {
        if let Err(e) = set(session, t, "textVariableContents", &json!(text)) {
            return Applied {
                outcome: "failed",
                ..row
            }
            .because(format!("{t}: {e}"));
        }
    }
    row.targets = targets;
    row
}

/// `paged data apply DOC --source ID=FILE … [--record N] [-o OUT]`.
pub fn apply(
    doc: &Path,
    assets: &DocumentOptions,
    sources: &[String],
    record: usize,
    out: Option<&PathBuf>,
    pdf: &PdfOptions,
    json: bool,
) -> Result<()> {
    let mut session = Session::new();
    assets.open(&mut session, doc)?;
    let recipe = read_recipe(&mut session)?;
    let payload = recipe.document_payload().context("the document's recipe")?;
    if payload.bindings.is_empty() {
        bail!("no bindings (no {DATA_LABEL_KEY} label in the document)");
    }
    let mut data = DataSession::from_payload(payload, today());

    let given: Vec<(String, PathBuf)> = sources
        .iter()
        .map(|s| parse_source(s))
        .collect::<Result<_>>()?;
    let declared = recipe.payload["sources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for (id, file) in &given {
        let source = declared
            .iter()
            .find(|s| s.get("id").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| anyhow!("the document has no source {id:?}"))?;
        let bytes = std::fs::read(file).with_context(|| format!("read {}", file.display()))?;
        data.store_import(id, format_of(source, file)?, &bytes, None)
            .map_err(|e| anyhow!("import {id}: {e}"))?;
    }
    let missing: Vec<String> = sources_to_relink(&recipe.payload)
        .into_iter()
        .filter(|s| !given.iter().any(|(id, _)| *id == s.id))
        .map(|s| s.id)
        .collect();

    let mut report: Vec<Value> = Vec::new();
    for run in data.refresh_queries() {
        if let Err(message) = &run.outcome {
            report.push(
                json!({ "query": run.query.to_string(), "outcome": "failed", "message": message }),
            );
        }
    }

    let mut applied = Vec::new();
    for p in data.resolve_properties_at(record, true, None) {
        applied.push(apply_property(
            &mut session,
            &p.binding,
            &p.property.target,
            &p.property.path,
            &p.property.outcome,
        ));
    }
    let defs: Vec<(BindingId, Binding)> = data
        .payload()
        .bindings
        .into_iter()
        .map(|d| (d.id, d.binding))
        .collect();
    for (id, binding) in &defs {
        match binding {
            Binding::Property { .. } | Binding::Visibility { .. } => {}
            Binding::Variable { .. } => match data.resolve_lowered_at(id, record) {
                Ok(LoweredOutput::Variable(v)) => applied.push(apply_variable(
                    &mut session,
                    id.as_str(),
                    &v.target.to_string(),
                    &v.text,
                )),
                Ok(_) => {
                    applied.push(Applied::new(id.as_str(), "failed").because("not a variable"))
                }
                Err(e) => applied.push(Applied::new(id.as_str(), "failed").because(e.to_string())),
            },
            other => applied.push(Applied::new(id.as_str(), "notHeadless").because(format!(
                "{} bindings are written by the data module",
                kind_of(&serde_json::to_value(other).unwrap_or(Value::Null))
            ))),
        }
    }

    if let Some(dest) = out {
        let format = crate::export::format_for(dest)?;
        let bytes = crate::export::export_bytes(&mut session, format, pdf)?;
        std::fs::write(dest, &bytes).with_context(|| format!("write {}", dest.display()))?;
    }
    let written = applied.iter().filter(|a| a.outcome == "written").count();
    if json {
        let outj = json!({
            "record": record,
            "applied": applied,
            "queries": report,
            "missingSources": missing,
            "saved": out.map(|p| p.display().to_string()),
        });
        println!("{}", serde_json::to_string_pretty(&outj)?);
    } else {
        for a in &applied {
            println!(
                "{}\t{}\t{}\t{}",
                a.binding,
                a.outcome,
                a.targets.join(","),
                a.message
                    .clone()
                    .or_else(|| a.value.as_ref().map(Value::to_string))
                    .unwrap_or_default()
            );
        }
        for q in &report {
            eprintln!(
                "query {}: {}",
                q["query"].as_str().unwrap_or("?"),
                q["message"].as_str().unwrap_or("")
            );
        }
        for id in &missing {
            eprintln!("source {id}: not given (--source {id}=FILE)");
        }
        if out.is_none() {
            eprintln!("{written} binding(s) written in the loaded document. Nothing saved — pass -o to write the result.");
        }
    }
    Ok(())
}

/// The data a `paged script` run reads as `paged.data.*` (PM-0015): the
/// document's recipe, its sources imported from `--source` files, its
/// queries run through the guard.
pub struct ScriptDataSession {
    data: DataSession,
    /// What each of the recipe's queries did when the run began.
    runs: Vec<data_session::core::QueryRun>,
}

/// Build the run's data from the document's binding labels and `--source`
/// files, as `apply` does. A `--source` the recipe does not declare is
/// imported under its id by the file's extension, so a script can read a
/// file into a document that binds nothing yet. `None` when there is
/// neither a label nor a `--source`: the run gets no data door.
pub fn script_data(session: &mut Session, sources: &[String]) -> Result<Option<ScriptDataSession>> {
    let recipe = read_recipe(session)?;
    let payload = recipe.document_payload().context("the document's recipe")?;
    let labelled = recipe.from_elements > 0
        || !payload.sources.is_empty()
        || !payload.queries.is_empty()
        || !payload.bindings.is_empty();
    if !labelled && sources.is_empty() {
        return Ok(None);
    }
    let mut data = DataSession::from_payload(payload, today());
    let declared = recipe.payload["sources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for spec in sources {
        let (id, file) = parse_source(spec)?;
        let source = declared
            .iter()
            .find(|s| s.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .cloned()
            .unwrap_or(Value::Null);
        let bytes = std::fs::read(&file).with_context(|| format!("read {}", file.display()))?;
        data.store_import(&id, format_of(&source, &file)?, &bytes, None)
            .map_err(|e| anyhow!("import {id}: {e}"))?;
    }
    let runs = data.refresh_queries();
    Ok(Some(ScriptDataSession { data, runs }))
}

impl paged_script::ScriptData for ScriptDataSession {
    fn tables(&mut self) -> Result<Value, String> {
        let tables = self.data.store_tables().map_err(|e| e.to_string())?;
        let payload = self.data.payload();
        let sources: Vec<Value> = payload
            .sources
            .iter()
            .map(|s| {
                let id = s.id.as_str();
                json!({ "id": id, "imported": tables.iter().any(|t| t == id) })
            })
            .collect();
        let queries: Vec<Value> = payload
            .queries
            .iter()
            .map(|q| {
                let mut row = json!({
                    "id": q.id.as_str(),
                    "sql": q.sql,
                    "rowCount": self.data.query_record_count(&q.id),
                });
                if let Some(Err(e)) = self
                    .runs
                    .iter()
                    .find(|r| r.query == q.id)
                    .map(|r| &r.outcome)
                {
                    row["error"] = json!(e);
                }
                row
            })
            .collect();
        Ok(json!({ "sources": sources, "queries": queries, "tables": tables }))
    }

    fn records(
        &mut self,
        table: &str,
        offset: usize,
        limit: Option<usize>,
    ) -> Result<Value, String> {
        self.data
            .store_records(table, offset, limit)
            .map_err(|e| e.to_string())
    }

    fn query(&mut self, sql: &str) -> Result<Value, String> {
        // A script's SQL is held to the rule a document's queries are.
        data_store::guard::check_query(sql).map_err(|e| format!("not run: {e}"))?;
        self.data
            .store_query_records(data_store::guard::trim_sql(sql))
            .map_err(|e| e.to_string())
    }

    fn evaluate(&mut self, query: &str, expr: &str, record: usize) -> Result<Value, String> {
        let preview = self
            .data
            .evaluate_at(&data_core::QueryId::new(query), expr, record);
        serde_json::to_value(preview).map_err(|e| e.to_string())
    }
}
