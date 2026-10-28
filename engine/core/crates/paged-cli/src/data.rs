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
//! The other kinds are lowered by the engine (`paged-data-lower`) and
//! written here with the mutations the module's writers send
//! (`data-bundle/src/lower.ts`): a visibility binding is the
//! `elementVisible` property; a table is a native table in its text frame's
//! story, replacing the one an earlier apply put there; an image's local
//! file or inline bytes go into its frame with its fit; a barcode is one
//! filled path per dark module inside its frame, replacing the previous
//! symbol; a rule sets its cell or text style on what fired; a colour no
//! swatch has is minted as one first; a record flow is paginated into one
//! frame per page, on pages it adds, replacing the previous flow (core ADR
//! 1014, amendments 3 and 4). What no headless lane can write is reported
//! per binding, never skipped silently: remote images (the command line has
//! no network client) and document asset ids (no document keeps their
//! bytes).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use data_core::{
    Binding, BindingId, ColorIntent, ImageReference, ImageStatus, ImgFit, PropertyOutcome,
    StyleAction, TargetRef,
};
use data_session::core::{DataSession, LoweredOutput};
use data_session::labels::{
    document_recipe, label_data, restore_from_labels, sources_to_relink, ElementRef, HostFacts,
    LabelledElement, RestoredRecipe, DATA_LABEL_KEY,
};
use paged_canvas::channel::{MainToWorkerKind, MintedElement, Mutation, WorkerToMainKind};
use paged_mutate::{PropertyPath, Value as MutateValue};
use paged_wire::{Address, ElementId};
use serde::Serialize;
use serde_json::{json, Map, Value};

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
    let elements: Vec<LabelledElement> = addresses
        .iter()
        .filter_map(|a| a.split_once(':'))
        .map(|(kind, id)| LabelledElement {
            element: ElementRef {
                kind: kind.to_string(),
                id: id.to_string(),
            },
            label: label_of(session, id),
        })
        .collect();
    let recipe = session
        .model()?
        .scene()
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
        PropertyOutcome::Write { value, color } => match color {
            // A colour is written as the swatch it names, minted first when
            // a literal colour has none.
            Some(intent) => match swatch_for(session, intent) {
                Ok(self_id) => Value::String(self_id),
                Err(e) => {
                    return Applied {
                        outcome: "failed",
                        ..row
                    }
                    .because(e.to_string())
                }
            },
            None => serde_json::to_value(value).unwrap_or(Value::Null),
        },
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

// ── The lowered kinds (core ADR 1014, amendment 2026-10-28) ────────────────
//
// Each writer below is the headless twin of one of the module's
// (`data-bundle/src/lower.ts`): the engine has already resolved and lowered
// the binding (`paged-data-lower`), so what is left is shaping the same
// mutations and sending them through the one door, `Session::send`.

/// The raw value of the page item `id`'s [`DATA_LABEL_KEY`] label.
fn label_of(session: &Session, id: &str) -> Option<String> {
    let scene = session.model().ok()?.scene();
    scene.spreads.iter().find_map(|s| {
        s.spread
            .labels
            .get(id)
            .and_then(|l| l.iter().find(|(k, _)| k == DATA_LABEL_KEY))
            .map(|(_, v)| v.clone())
    })
}

/// Send one mutation; the elements it minted (a batch names them all).
fn mutate(session: &mut Session, mutation: Mutation) -> Result<Vec<MintedElement>> {
    match session.send(MainToWorkerKind::Mutate(mutation))? {
        WorkerToMainKind::MutationApplied {
            minted, created_id, ..
        } => Ok(if minted.is_empty() {
            created_id
                .map(|element| MintedElement {
                    handle: None,
                    element,
                    story_id: None,
                })
                .into_iter()
                .collect()
        } else {
            minted
        }),
        WorkerToMainKind::MutationFailed { error } => bail!("{error}"),
        other => bail!("the engine answered {other:?}"),
    }
}

/// Send `ops` (wire JSON, as the module writes them) as ONE batch.
fn batch(session: &mut Session, ops: Vec<Value>) -> Result<Vec<MintedElement>> {
    let ops = ops
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<Vec<Mutation>, _>>()
        .context("shape the batch")?;
    mutate(session, Mutation::Batch { ops })
}

/// The address of the page item whose `Self` is `raw` (`rectangle:u12`).
fn frame_address(session: &mut Session, raw: &str) -> Result<String> {
    query(session, &format!("frame:{raw}"))?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no page item {raw} in the document"))
}

/// JSON with every non-ASCII character as a `\uXXXX` escape, as the module
/// writes labels: an ASCII-only label comes back from InDesign byte-exact.
fn ascii_json(value: &Value) -> String {
    let text = value.to_string();
    let mut out = String::with_capacity(text.len());
    let mut units = [0u16; 2];
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            for u in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out
}

/// The label envelope the module stamps on what a lowering creates.
fn envelope(data: Value) -> String {
    ascii_json(&json!({ "v": 1, "data": data }))
}

/// The page items an earlier lowering of `binding` created, by the stamp on
/// their labels (`{ kind, binding }`, no `bind`: never a bound item itself).
fn lowered_by(session: &mut Session, kind: &str, binding: &str) -> Result<Vec<String>> {
    let addresses = query(session, &format!("frame[label={DATA_LABEL_KEY}]"))?;
    Ok(addresses
        .iter()
        .filter_map(|a| a.split_once(':').map(|(_, id)| id.to_string()))
        .filter(|id| {
            label_of(session, id)
                .as_deref()
                .and_then(label_data)
                .is_some_and(|d| {
                    !d.contains_key("bind")
                        && d.get("kind").and_then(Value::as_str) == Some(kind)
                        && d.get("binding").and_then(Value::as_str) == Some(binding)
                })
        })
        .collect())
}

/// The modules of an editor-drawn symbol that carry no label. The data
/// module stamps only a symbol's LAST module, with the symbol's module count
/// (`modules`), and draws the others just before it; this walks back from that
/// stamp through the spread's paint order, taking unlabelled polygons until
/// the count is met. A symbol this writer drew has every module stamped, so it
/// adds nothing there.
fn unstamped_modules(session: &Session, stamped: &[String]) -> Vec<String> {
    let Ok(model) = session.model() else {
        return Vec::new();
    };
    let scene = model.scene();
    let mut found = Vec::new();
    for id in stamped {
        let Some(count) = label_of(session, id)
            .as_deref()
            .and_then(label_data)
            .and_then(|d| d.get("modules").and_then(Value::as_u64))
        else {
            continue;
        };
        let want = (count as usize).saturating_sub(stamped.len());
        if want == 0 {
            continue;
        }
        for s in &scene.spreads {
            let spread = &s.spread;
            let polygon_id = |r: &paged_model::FrameRef| match r {
                paged_model::FrameRef::Polygon(i) => spread.polygons.get(*i)?.self_id.clone(),
                _ => None,
            };
            let Some(at) = spread
                .frames_in_order
                .iter()
                .position(|r| polygon_id(r).as_deref() == Some(id.as_str()))
            else {
                continue;
            };
            for r in spread.frames_in_order[..at].iter().rev() {
                if found.len() >= want {
                    break;
                }
                let Some(pid) = polygon_id(r) else { break };
                if label_of(session, &pid).is_some() {
                    break;
                }
                found.push(pid);
            }
        }
    }
    found
}

/// A binding the user pinned or overrode keeps the document's content.
fn kept_by_sync(data: &DataSession, id: &BindingId) -> Option<Applied> {
    data.sync_state(id)
        .filter(|st| !st.accepts_refresh())
        .map(|st| {
            Applied::new(id.as_str(), "kept")
                .because(format!("the binding is {:?}", st.status).to_lowercase())
        })
}

fn failed(binding: &str, message: impl Into<String>) -> Applied {
    Applied::new(binding, "failed").because(message)
}

/// The story a text frame starts, by the frame's `Self`.
fn story_of_frame(session: &Session, raw: &str) -> Option<String> {
    let scene = session.model().ok()?.scene();
    scene
        .spreads
        .iter()
        .flat_map(|s| &s.spread.text_frames)
        .find(|f| f.self_id.as_deref() == Some(raw))
        .and_then(|f| f.parent_story.clone())
}

/// The ids of the tables in `story`, in story order.
fn tables_in(session: &mut Session, story: &str) -> Result<Vec<String>> {
    Ok(query(session, &format!("story:{story} > table"))?
        .into_iter()
        .filter_map(|a| a.strip_prefix("table:").map(str::to_string))
        .collect())
}

/// A table binding: a native table in the story of the text frame that
/// carries the binding (`lower.ts` `commitLoweredTable`, its `into` and
/// in-place paths), the cells filled in the same batch. The table an
/// earlier apply placed — its id is kept in the frame's label, under
/// `extra.<binding>.tableId` — is deleted in that batch, so applying again
/// replaces it rather than adding a second.
fn apply_table(
    session: &mut Session,
    data: &mut DataSession,
    id: &BindingId,
    record: usize,
    facts: &HostFacts,
) -> Applied {
    let binding = id.as_str();
    let table = match data.resolve_lowered_at(id, record) {
        Ok(LoweredOutput::Table(t)) => t,
        Ok(_) => return failed(binding, "not a table"),
        Err(e) => return failed(binding, e.to_string()),
    };
    let host = facts.lowered.get(binding);
    let raw = host.map_or_else(|| table.region.to_string(), |e| e.id.clone());
    let Some(story) = story_of_frame(session, &raw) else {
        return match host {
            Some(e) => failed(
                binding,
                format!("{}:{} carries the table but is not a text frame", e.kind, e.id),
            ),
            None => Applied::new(binding, "notHeadless").because(
                "no text frame carries this table binding (placing a fresh frame is the data module's)",
            ),
        };
    };
    let mut label = label_of(session, &raw)
        .as_deref()
        .and_then(label_data)
        .unwrap_or_default();
    let previous = label
        .get("extra")
        .and_then(|x| x.get(binding))
        .and_then(|x| x.get("tableId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tables = match tables_in(session, &story) {
        Ok(t) => t,
        Err(e) => return failed(binding, e.to_string()),
    };
    let replaced = previous.filter(|t| tables.contains(t));

    let header_rows = u32::from(table.rows.first().is_some_and(|r| r.header));
    let mut ops = Vec::new();
    if let Some(old) = &replaced {
        ops.push(json!({ "op": "deleteTable", "args": { "storyId": story, "tableId": old } }));
    }
    ops.push(json!({ "op": "insertTable", "args": {
        "storyId": story,
        "rows": table.rows.len(),
        "cols": table.columns.len(),
        "headerRows": header_rows,
        "columnWidths": table.columns.iter().map(|c| c.width_pt).collect::<Vec<_>>(),
    }}));
    ops.push(json!({ "op": "bindCreated", "args": { "handle": "table" } }));
    for (r, row) in table.rows.iter().enumerate() {
        for (c, text) in row.cells.iter().enumerate() {
            if text.is_empty() {
                continue;
            }
            ops.push(json!({ "op": "insertText", "args": {
                "storyId": story, "offset": 0, "text": text,
                "cell": { "tableId": "$h:table", "row": r, "col": c },
            }}));
        }
    }
    let minted = match batch(session, ops) {
        Ok(m) => m,
        Err(e) => return failed(binding, format!("the table batch was refused: {e}")),
    };
    let Some(table_id) = minted.iter().find_map(|m| match &m.element {
        ElementId::Table { table_id, .. } => Some(table_id.clone()),
        _ => None,
    }) else {
        return failed(binding, "the table batch applied but named no table");
    };
    // Where the table is now, for the next apply to replace it.
    let extra = label.entry("extra").or_insert_with(|| json!({}));
    if !extra.is_object() {
        *extra = json!({});
    }
    extra[binding] = json!({ "tableId": table_id });
    let stamp = Mutation::SetPluginMetadata {
        element_id: ElementId::TextFrame(raw.clone()),
        key: DATA_LABEL_KEY.to_string(),
        value: Some(ascii_json(&json!({ "v": 1, "data": Value::Object(label) }))),
        caller: None,
    };
    if let Err(e) = mutate(session, stamp) {
        return failed(binding, format!("the table was placed, its label not: {e}"));
    }
    let mut row = Applied::new(binding, "written");
    row.path = Some("table".into());
    row.targets = vec![format!("textFrame:{raw}")];
    row.value = Some(json!({
        "tableId": table_id,
        "rows": table.rows.len(),
        "cols": table.columns.len(),
    }));
    if let Some(old) = replaced {
        row.message = Some(format!("replaced table {old}"));
    }
    row
}

/// The IDML `FittingOnEmptyFrame` value an engine fit maps to (`idmlFit`).
fn idml_fit(fit: ImgFit) -> &'static str {
    match fit {
        ImgFit::Fit => "Proportionally",
        ImgFit::Fill => "FillProportionally",
        ImgFit::Crop => "FitContentToFrame",
    }
}

/// The inner image transform `fit` resolves to in the Rectangle `raw`
/// (what `paged place --fit` writes; InDesign resolves a fit on place).
fn fitted(session: &Session, raw: &str, fit: &str, bytes: &[u8]) -> Option<[f32; 6]> {
    use paged_model::fitting::{fit_transform, FitMode};
    let mode = FitMode::from_idml(fit)?;
    let info = paged_raster::probe(bytes).ok()?;
    let model = session.model().ok()?;
    let rect = model
        .scene()
        .spreads
        .iter()
        .flat_map(|parsed| &parsed.spread.rectangles)
        .find(|r| r.self_id.as_deref() == Some(raw))?;
    let reference = rect
        .frame_fitting
        .as_ref()
        .and_then(|f| f.reference_point.as_deref());
    fit_transform(
        mode,
        reference,
        rect.bounds,
        info.width as f32,
        info.height as f32,
    )
}

/// An image binding: the picture's bytes into its frame
/// (`ReplaceImageBytes`, the lane `paged place` uses: a link would resolve
/// against a resolver this door never populates), then its fit. A local
/// path is read relative to the `--source` files' folders; a remote uri is
/// never fetched here.
fn apply_image(
    session: &mut Session,
    data: &mut DataSession,
    id: &BindingId,
    record: usize,
    facts: &HostFacts,
    source_dirs: &[PathBuf],
) -> Applied {
    let binding = id.as_str();
    let image = match data.resolve_lowered_at(id, record) {
        Ok(LoweredOutput::Image(i)) => i,
        Ok(_) => return failed(binding, "not an image"),
        Err(e) => return failed(binding, e.to_string()),
    };
    if image.status != ImageStatus::Present {
        return Applied::new(binding, "kept").because(format!(
            "the value is absent and the missing policy says {} — nothing placed",
            format!("{:?}", image.status).to_lowercase()
        ));
    }
    let Some(host) = facts.image.get(binding) else {
        return Applied::new(binding, "notHeadless")
            .because("no page item carries this image binding in its label");
    };
    let address = match frame_address(session, &host.element_id) {
        Ok(a) => a,
        Err(e) => return failed(binding, e.to_string()),
    };
    let (bytes, shown) = match &image.reference {
        ImageReference::Uri { uri } => {
            return Applied::new(binding, "notHeadless").because(format!(
                "{uri}: remote images need the editor's consented fetch (the command line \
                 has no network client and never fetches)"
            ))
        }
        ImageReference::AssetId { id: asset } => {
            return Applied::new(binding, "notHeadless").because(format!(
                "asset:{asset}: no asset store keeps an asset id's bytes — neither a \
                 .paged container part nor the editor maps the id to a picture"
            ))
        }
        ImageReference::None => {
            return Applied::new(binding, "kept").because("the value names no image")
        }
        ImageReference::Bytes { bytes } => (bytes.clone(), format!("<{} bytes>", bytes.len())),
        ImageReference::Path { path } => {
            let given = path.strip_prefix("file://").unwrap_or(path);
            let file = Path::new(given);
            let found = if file.is_absolute() {
                Some(file.to_path_buf())
            } else {
                source_dirs
                    .iter()
                    .map(|d| d.join(file))
                    .chain(std::iter::once(file.to_path_buf()))
                    .find(|p| p.is_file())
            };
            let Some(found) = found.filter(|p| p.is_file()) else {
                return failed(
                    binding,
                    format!("no image file {given} (relative paths are read next to the --source files)"),
                );
            };
            match std::fs::read(&found) {
                Ok(b) => (b, found.display().to_string()),
                Err(e) => return failed(binding, format!("read {}: {e}", found.display())),
            }
        }
    };
    if let Err(e) = paged_raster::probe(&bytes) {
        return failed(
            binding,
            format!("{shown}: not an image the engine decodes ({e})"),
        );
    }
    let placed = mutate(
        session,
        Mutation::ReplaceImageBytes {
            element_id: address.clone(),
            bytes: Some(bytes.clone().into()),
        },
    );
    if let Err(e) = placed {
        return failed(binding, format!("{address}: {e}"));
    }
    let fit = host
        .fit
        .clone()
        .unwrap_or_else(|| idml_fit(image.fit).to_string());
    let mut row = Applied::new(binding, "written");
    row.path = Some("image".into());
    row.targets = vec![address.clone()];
    row.value = Some(json!({ "image": shown, "fit": fit }));
    // Only a Rectangle carries a fitting (IDML `<FrameFittingOption>`).
    if let Some(element) = ElementId::parse(&address).filter(|_| address.starts_with("rectangle:"))
    {
        let set_fit = mutate(
            session,
            Mutation::SetElementProperty {
                element_id: element.clone(),
                path: PropertyPath::FrameFittingType,
                value: MutateValue::Text(fit.clone()),
            },
        );
        if let Err(e) = set_fit {
            return failed(binding, format!("the image was placed, its fit not: {e}"));
        }
        if let Some(t) = fitted(session, &host.element_id, &fit, &bytes) {
            let set_transform = mutate(
                session,
                Mutation::SetElementProperty {
                    element_id: element,
                    path: PropertyPath::ImageContentTransform,
                    value: MutateValue::Transform(Some(t)),
                },
            );
            if let Err(e) = set_transform {
                return failed(binding, format!("the image was placed, its fit not: {e}"));
            }
        }
    }
    row
}

/// A barcode binding: the symbol encoded and scaled into the frame's box by
/// the engine, drawn as one closed filled path per dark module with the
/// lowering's paint, each stamped `{ kind: "barcode", binding }` (`lower.ts`
/// `commitLoweredBarcode`, `barcode.ts` `barcodeToMutations`). The previous
/// symbol's stamped modules are removed in the same batch, after the new
/// ones are drawn (core refuses inserts that follow deletes of the same
/// spread's items). The modules go through the frame's own transform, so a
/// rotated or scaled frame carries its symbol.
fn apply_barcode(
    session: &mut Session,
    data: &mut DataSession,
    id: &BindingId,
    record: usize,
    facts: &HostFacts,
) -> Applied {
    let binding = id.as_str();
    let Some(host) = facts.barcode.get(binding) else {
        return Applied::new(binding, "notHeadless")
            .because("no page item carries this barcode binding in its label");
    };
    let address = match frame_address(session, &host.element_id) {
        Ok(a) => a,
        Err(e) => return failed(binding, e.to_string()),
    };
    let Some(element) = ElementId::parse(&address) else {
        return failed(binding, format!("{address} is not a page item"));
    };
    let item = match session.send(MainToWorkerKind::RequestElementGeometry { ids: vec![element] }) {
        Ok(WorkerToMainKind::ElementGeometry { items }) => items.into_iter().next(),
        Ok(other) => return failed(binding, format!("the engine answered {other:?}")),
        Err(e) => return failed(binding, e.to_string()),
    };
    let Some(item) = item else {
        return failed(binding, format!("{address} has no geometry"));
    };
    let Some(page_id) = item.page_id.clone() else {
        return failed(
            binding,
            format!("{address} sits on the pasteboard, on no page"),
        );
    };
    let [top, left, bottom, right] = item.bounds.map(f64::from);
    let symbol = match data.lower_barcode_at(id, record, right - left, bottom - top) {
        Ok(b) => b,
        Err(e) => return failed(binding, e.to_string()),
    };
    let mut old = match lowered_by(session, "barcode", binding) {
        Ok(o) => o,
        Err(e) => return failed(binding, e.to_string()),
    };
    old.extend(unstamped_modules(session, &old));
    if symbol.modules.is_empty() && old.is_empty() {
        return Applied::new(binding, "kept")
            .because("the value is empty (its missing policy) — nothing drawn");
    }
    let [a, b, c, d, tx, ty] = item
        .item_transform
        .map_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], |t| t.map(f64::from));
    let at = |x: f64, y: f64| {
        let p = [a * x + c * y + tx, b * x + d * y + ty];
        json!({ "anchor": p, "left": p, "right": p })
    };
    let stamp = envelope(json!({
        "binding": binding,
        "kind": "barcode",
        "target": symbol.target.to_string(),
        "symbology": symbol.symbology,
    }));
    // The lowering always carries its paint; the constants are its own.
    let mut paint: Vec<(String, Value)> = symbol
        .paint
        .iter()
        .map(|p| {
            (
                p.path.clone(),
                serde_json::to_value(&p.value).unwrap_or(Value::Null),
            )
        })
        .collect();
    if paint.is_empty() {
        paint = vec![
            ("frameFillColor".into(), json!("Color/Black")),
            ("frameStrokeColor".into(), json!("Swatch/None")),
        ];
    }
    let mut ops = Vec::new();
    for m in &symbol.modules {
        let (x, y) = (left + m.x_pt, top + m.y_pt);
        ops.push(json!({ "op": "insertPath", "args": {
            "pageId": page_id,
            "anchors": [at(x, y), at(x + m.w_pt, y), at(x + m.w_pt, y + m.h_pt), at(x, y + m.h_pt)],
            "open": false,
        }}));
        for (path, value) in &paint {
            ops.push(json!({ "op": "setElementProperty", "args": {
                "elementId": { "kind": "polygon", "id": "$created" },
                "path": path,
                "value": { "type": "colorRef", "value": value },
            }}));
        }
        ops.push(json!({ "op": "setPluginMetadata", "args": {
            "elementId": { "kind": "polygon", "id": "$created" },
            "key": DATA_LABEL_KEY,
            "value": stamp,
        }}));
    }
    for frame in &old {
        ops.push(json!({ "op": "deleteFrame", "args": { "frameId": frame } }));
    }
    if let Err(e) = batch(session, ops) {
        return failed(binding, format!("the barcode batch was refused: {e}"));
    }
    let mut row = Applied::new(binding, "written");
    row.path = Some("barcode".into());
    row.targets = vec![address];
    row.value = Some(json!({
        "symbology": symbol.symbology,
        "modules": symbol.modules.len(),
        "text": symbol.text,
    }));
    if !old.is_empty() {
        row.message = Some(format!(
            "replaced {} module(s) of the previous symbol",
            old.len()
        ));
    }
    row
}

// ── Record flows (`flow-writer.ts` `commitRecordFlow`, `relower.ts`) ────────

/// A paginated frame's text (`flowFrameText`): one paragraph per header,
/// record field line and footer; a re-emitted header is marked continued.
/// The blocks are the paginator's own JSON (`FlowBlock`), read as the
/// module reads them.
fn flow_frame_text(blocks: &[Value]) -> String {
    let cells = |b: &Value| -> Vec<String> {
        b["cells"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|c| c.as_str().unwrap_or("").to_string())
            .collect()
    };
    let mut lines: Vec<String> = Vec::new();
    for b in blocks {
        match b["block"].as_str() {
            Some("groupHeader") => {
                let text = b["text"].as_str().unwrap_or("");
                lines.push(if b["continued"] == json!(true) {
                    format!("{text} (continued)")
                } else {
                    text.to_string()
                });
            }
            Some("record") => lines.extend(cells(b)),
            Some("groupFooter") => lines.push(cells(b).join("\t")),
            _ => {}
        }
    }
    lines.join("\n")
}

/// The rows of the result a paginated frame shows (editor ADR 291's record
/// markers), as its label carries them.
fn flow_records(blocks: &[Value]) -> Vec<u64> {
    blocks
        .iter()
        .filter(|b| b["block"] == "record")
        .filter_map(|b| b["record"].as_u64())
        .collect()
}

/// One frame of `height_pt` per entry of `frames`, as the paginator takes
/// a chain (`FrameCapacity`).
fn chain(frames: usize, height_pt: f64) -> Value {
    Value::Array(
        (0..frames)
            .map(|i| json!({ "frame": format!("f{i}"), "page": format!("p{i}"), "heightPt": height_pt }))
            .collect(),
    )
}

/// Paginate a record flow the way the module places it
/// (`paginateOverPages`): one frame of `height_pt` per page, as many as the
/// flow needs — a chain long enough for every block to take a frame of its
/// own, with the binding's own header options. The paginated flow comes
/// back as its JSON (`PaginatedFlow`).
fn paginate_over_pages(data: &mut DataSession, id: &BindingId, height_pt: f64) -> Result<Value> {
    let opts = data.flow_layout(id).unwrap_or_default();
    let mut lower = |chain: Value| -> Result<Value> {
        let chain = serde_json::from_value(chain).context("shape the frame chain")?;
        let flow = data
            .lower_record_flow(id, chain, opts)
            .map_err(|e| anyhow!("{e}"))?;
        Ok(serde_json::to_value(flow)?)
    };
    let probe = lower(json!([{ "frame": "all", "page": "all", "heightPt": f64::from(u32::MAX) }]))?;
    let blocks: usize = probe["frames"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|f| f["blocks"].as_array().map_or(0, Vec::len))
        .sum();
    lower(chain(blocks.max(1), height_pt))
}

/// The document's pages in order: `(selfId, page-local margin box)`.
fn pages(session: &mut Session) -> Result<Vec<(String, [f32; 4])>> {
    let items = match session.send(MainToWorkerKind::RequestCollection {
        name: paged_canvas::channel::CollectionName::Pages,
    })? {
        WorkerToMainKind::CollectionReply { items, .. } => items,
        other => bail!("the engine answered {other:?}"),
    };
    let num = |p: &Value, k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32;
    Ok(items
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|p| {
            let id = p.get("selfId")?.as_str()?.to_string();
            let size = p.get("sizePt")?.as_array()?;
            let (w, h) = (
                size.first()?.as_f64()? as f32,
                size.get(1)?.as_f64()? as f32,
            );
            // A margin the page does not report counts as none (`marginBox`).
            let margin_box = [
                num(p, "marginTopPt"),
                num(p, "marginLeftPt"),
                h - num(p, "marginBottomPt"),
                w - num(p, "marginRightPt"),
            ];
            Some((id, margin_box))
        })
        .collect())
}

/// The page each of `addresses` sits on (`None` on the pasteboard).
fn pages_of(session: &mut Session, addresses: &[String]) -> Result<Vec<Option<String>>> {
    let ids: Vec<ElementId> = addresses
        .iter()
        .filter_map(|a| ElementId::parse(a))
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    match session.send(MainToWorkerKind::RequestElementGeometry { ids })? {
        WorkerToMainKind::ElementGeometry { items } => {
            Ok(items.into_iter().map(|i| i.page_id.map(|p| p.0)).collect())
        }
        other => bail!("the engine answered {other:?}"),
    }
}

/// The frames an earlier lowering of record flow `binding` placed, by the
/// stamp on their labels (`{ kind: "recordFlow", binding, frame }`), with
/// their label data. The first one also carries the binding itself
/// (`bind`) once the editor has synced its labels.
fn flow_frames(session: &mut Session, binding: &str) -> Result<Vec<(String, Map<String, Value>)>> {
    let addresses = query(session, &format!("frame[label={DATA_LABEL_KEY}]"))?;
    Ok(addresses
        .into_iter()
        .filter_map(|a| {
            let data = label_of(session, a.split_once(':')?.1)
                .as_deref()
                .and_then(label_data)?;
            (data.get("kind").and_then(Value::as_str) == Some("recordFlow")
                && data.get("binding").and_then(Value::as_str) == Some(binding))
            .then_some((a, data))
        })
        .collect())
}

/// A record flow: paginated by the engine over margin-box frames, one text
/// frame per paginated frame, the first on the start page and the rest on
/// pages added after it (`flow-writer.ts` `commitRecordFlow`). Each frame
/// holds exactly the blocks the paginator put there, so its breaks are the
/// engine's; the frames are not threaded (a thread would let the text
/// re-break). Every frame is stamped `{ kind: "recordFlow", binding, frame,
/// records }` (`createdPage` on the added pages' frames), so the next apply
/// removes the previous frames, and the pages it added once nothing else is
/// on them (`relower.ts` `planRelower`), in the batch that places the new
/// ones. The start page is the page of the frame whose label carries the
/// binding (the editor uses its active page), else the first page. A flow
/// places every record, so `--record` does not apply to it.
fn apply_record_flow(
    session: &mut Session,
    data: &mut DataSession,
    id: &BindingId,
    facts: &HostFacts,
) -> Applied {
    let binding = id.as_str();
    let mut row = Applied::new(binding, "written");
    row.path = Some("recordFlow".into());
    let previous = match flow_frames(session, binding) {
        Ok(p) => p,
        Err(e) => return failed(binding, e.to_string()),
    };
    let doc_pages = match pages(session) {
        Ok(p) if !p.is_empty() => p,
        Ok(_) => return failed(binding, "the document has no page"),
        Err(e) => return failed(binding, e.to_string()),
    };
    let host = facts
        .lowered
        .get(binding)
        .map(|e| format!("{}:{}", e.kind, e.id));
    let start = host
        .as_ref()
        .and_then(|h| pages_of(session, std::slice::from_ref(h)).ok())
        .and_then(|p| p.into_iter().next().flatten())
        .filter(|p| doc_pages.iter().any(|(id, _)| id == p))
        .unwrap_or_else(|| doc_pages[0].0.clone());
    let margin_box = doc_pages
        .iter()
        .find(|(id, _)| *id == start)
        .map_or(doc_pages[0].1, |(_, b)| *b);
    let flow = match paginate_over_pages(data, id, f64::from(margin_box[2] - margin_box[0])) {
        Ok(f) => f,
        Err(e) => return failed(binding, e.to_string()),
    };
    let frames_of = flow["frames"].as_array().cloned().unwrap_or_default();
    let (placed, total) = (
        flow["placed"].as_u64().unwrap_or(0),
        flow["total"].as_u64().unwrap_or(0),
    );
    let overflow = flow["overflow"] == json!(true);
    let mut notes = Vec::new();
    if overflow {
        notes.push(format!(
            "{} record(s) did not fit",
            total.saturating_sub(placed)
        ));
    }

    // What the previous apply placed: its frames, and the pages it added
    // that hold nothing else once those are gone.
    let old: Vec<String> = previous.iter().map(|(a, _)| a.clone()).collect();
    let old_pages = match pages_of(session, &old) {
        Ok(p) => p,
        Err(e) => return failed(binding, e.to_string()),
    };
    let mut created: Vec<String> = Vec::new();
    for ((_, d), page) in previous.iter().zip(&old_pages) {
        if let Some(p) = page
            .as_ref()
            .filter(|_| d.get("createdPage") == Some(&json!(true)))
        {
            if !created.contains(p) && *p != start {
                created.push(p.clone());
            }
        }
    }
    if !created.is_empty() {
        let everything = match query(session, "frame") {
            Ok(a) => a,
            Err(e) => return failed(binding, e.to_string()),
        };
        let others: Vec<String> = everything
            .into_iter()
            .filter(|a| !old.contains(a))
            .collect();
        let theirs = match pages_of(session, &others) {
            Ok(p) => p,
            Err(e) => return failed(binding, e.to_string()),
        };
        created.retain(|p| !theirs.iter().any(|t| t.as_deref() == Some(p)));
    }
    let mut clear: Vec<Value> = old
        .iter()
        .filter_map(|a| a.split_once(':').map(|(_, raw)| raw.to_string()))
        .map(|raw| json!({ "op": "deleteFrame", "args": { "frameId": raw } }))
        .collect();
    clear.extend(
        created
            .iter()
            .map(|p| json!({ "op": "deletePage", "args": { "pageId": p } })),
    );
    // The binding's own copy rides the first frame: when the frame that
    // carried it is one this apply removes, its persistence keys move to
    // the new first frame, or the binding would leave the document with it.
    let carried: Map<String, Value> = previous
        .iter()
        .find(|(a, d)| Some(a) == host.as_ref() && d.contains_key("bind"))
        .map(|(_, d)| {
            d.iter()
                .filter(|(k, _)| {
                    ["oid", "bind", "queries", "sources", "extra"].contains(&k.as_str())
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();

    let used = frames_of.len();
    row.value = Some(json!({
        "frames": used,
        "placed": placed,
        "total": total,
        "overflow": overflow,
    }));
    if used == 0 {
        if !clear.is_empty() {
            if let Err(e) = batch(session, clear) {
                return failed(
                    binding,
                    format!("removing the previous flow was refused: {e}"),
                );
            }
            row.message = Some(format!(
                "no records: removed the previous {} frame(s)",
                old.len()
            ));
            return row;
        }
        return Applied::new(binding, "kept").because("the flow has no records — nothing placed");
    }

    // Pages first (a page minted in a batch cannot be named in it), then the
    // frames. The old frames and pages are removed after the new frames are
    // placed, in the frames' batch: core refuses inserts that follow deletes
    // of the same spread's items.
    if used > 1 {
        let ops = (1..used)
            .map(|_| json!({ "op": "insertPage", "args": { "afterPageId": start, "masterId": null } }))
            .collect();
        if let Err(e) = batch(session, ops) {
            return failed(binding, format!("adding pages was refused: {e}"));
        }
    }
    let after = match pages(session) {
        Ok(p) => p,
        Err(e) => return failed(binding, e.to_string()),
    };
    let at = after.iter().position(|(p, _)| *p == start).unwrap_or(0);
    let out: Vec<String> = after
        .iter()
        .skip(at)
        .take(used)
        .map(|(p, _)| p.clone())
        .collect();
    if out.len() != used {
        return failed(binding, "the added pages are not where expected");
    }
    let mut ops = Vec::new();
    for (i, f) in frames_of.iter().enumerate() {
        let h = format!("flow{i}");
        let blocks = f["blocks"].as_array().map_or(&[][..], Vec::as_slice);
        let text = flow_frame_text(blocks);
        ops.push(
            json!({ "op": "insertTextFrame", "args": { "pageId": out[i], "bounds": margin_box } }),
        );
        ops.push(json!({ "op": "bindCreated", "args": { "handle": h } }));
        if !text.is_empty() {
            ops.push(json!({ "op": "insertText", "args": {
                "storyId": format!("$h:{h}"), "offset": 0, "text": text,
            }}));
        }
        let mut stamp = if i == 0 { carried.clone() } else { Map::new() };
        stamp.insert("kind".into(), json!("recordFlow"));
        stamp.insert("binding".into(), json!(binding));
        stamp.insert("frame".into(), json!(i));
        let records = flow_records(blocks);
        if !records.is_empty() {
            stamp.insert("records".into(), json!(records));
        }
        if i > 0 {
            stamp.insert("createdPage".into(), json!(true));
        }
        ops.push(json!({ "op": "setPluginMetadata", "args": {
            "elementId": { "kind": "textFrame", "id": format!("$h:{h}") },
            "key": DATA_LABEL_KEY,
            "value": envelope(Value::Object(stamp)),
        }}));
    }
    ops.extend(clear);
    let minted = match batch(session, ops) {
        Ok(m) => m,
        Err(e) => return failed(binding, format!("the frame batch was refused: {e}")),
    };
    let frames: Vec<&MintedElement> = minted
        .iter()
        .filter(|m| matches!(m.element, ElementId::TextFrame(_)))
        .collect();
    // The paginator measures with the template's line height; the engine's
    // own layout says whether a frame's text really fits (the editor's
    // overset issue over the same frames).
    let mut overset = Vec::new();
    for (i, m) in frames.iter().enumerate() {
        let Some(story) = &m.story_id else { continue };
        if let Ok(WorkerToMainKind::FrameChainResult { links }) =
            session.send(MainToWorkerKind::RequestFrameChain {
                story_id: story.clone(),
            })
        {
            if links.iter().any(|l| l.overflow) {
                overset.push(i);
            }
        }
    }
    if !overset.is_empty() {
        notes.push(format!("{} frame(s) overset", overset.len()));
    }
    row.targets = frames
        .iter()
        .map(|m| match &m.element {
            ElementId::TextFrame(raw) => format!("textFrame:{raw}"),
            other => format!("{other:?}"),
        })
        .collect();
    row.value = Some(json!({
        "frames": frames.len(),
        "pages": out,
        "addedPages": used - 1,
        "placed": placed,
        "total": total,
        "overflow": overflow,
        "overset": overset,
    }));
    if !old.is_empty() {
        let pages = if created.is_empty() {
            String::new()
        } else {
            format!(" and {} added page(s)", created.len())
        };
        notes.insert(
            0,
            format!(
                "replaced {} frame(s){pages} of the previous flow",
                old.len()
            ),
        );
    }
    if !notes.is_empty() {
        row.message = Some(notes.join("; "));
    }
    row
}

/// The character ranges of a story's paragraphs, in core's offset space (a
/// paragraph break is not a character; `paragraphRanges` in the module).
fn paragraph_ranges(session: &mut Session, story: &str) -> Result<Vec<(u32, u32)>> {
    let content = match session.send(MainToWorkerKind::RequestStoryContent {
        story_id: story.to_string(),
    })? {
        WorkerToMainKind::StoryContentResult { content } => {
            content.ok_or_else(|| anyhow!("no story {story}"))?
        }
        other => bail!("the engine answered {other:?}"),
    };
    let mut at = 0u32;
    Ok(content
        .paragraphs
        .iter()
        .map(|p| {
            let len: usize = p.runs.iter().map(|r| r.text.chars().count()).sum();
            let range = (at, at + len as u32);
            at += len as u32;
            range
        })
        .collect())
}

/// A rule: evaluated over the query its label names, its style written on
/// the target the label records (`lower.ts` `commitRule`): a cell style on
/// the fired rows of a table column (the style created when the document
/// has none by that name), a paragraph or character style on a story range
/// or on the fired records' paragraphs. A rule fires over every record, so
/// `--record` does not apply to it.
fn apply_rule(
    session: &mut Session,
    data: &mut DataSession,
    id: &BindingId,
    facts: &HostFacts,
) -> Applied {
    let binding = id.as_str();
    let hosted = facts.story_hosted.get(binding);
    let extra = hosted.and_then(|h| h.extra.as_ref());
    let query_id = extra.and_then(|x| x.get("query")).and_then(Value::as_str);
    let target = extra.and_then(|x| x.get("target"));
    let (Some(hosted), Some(query_id), Some(target)) = (hosted, query_id, target) else {
        return Applied::new(binding, "notHeadless").because(
            "the rule's label records no target and query (they are chosen in the Bindings panel)",
        );
    };
    let Some(story) = story_of_frame(session, &hosted.frame) else {
        return failed(binding, format!("{} is not a text frame", hosted.frame));
    };
    let result = match data.evaluate_rule(id, &data_core::QueryId::new(query_id)) {
        Ok(r) => r,
        Err(e) => return failed(binding, e.to_string()),
    };
    let (path, style) = result.apply.property();
    let num = |k: &str| target.get(k).and_then(Value::as_u64).map(|n| n as u32);
    let kind = target.get("kind").and_then(Value::as_str).unwrap_or("");
    let mut row = Applied::new(binding, "written");
    row.path = Some(path.to_string());
    row.value = Some(json!({ "style": style, "fired": result.fires.len(), "of": result.total }));
    let scope = match &result.apply {
        StyleAction::ParagraphStyle { .. } => "paragraph",
        StyleAction::CharacterStyle { .. } => "character",
        StyleAction::TableStyle { .. } => "cell",
    };
    match (kind, scope) {
        ("tableColumn", "cell") => {
            let tables = match tables_in(session, &story) {
                Ok(t) => t,
                Err(e) => return failed(binding, e.to_string()),
            };
            let index = num("tableIndex").unwrap_or(0) as usize;
            let Some(table) = target
                .get("tableId")
                .and_then(Value::as_str)
                .filter(|t| tables.iter().any(|x| x == t))
                .map(str::to_string)
                .or_else(|| tables.get(index).cloned())
            else {
                return failed(binding, format!("story {story} has no table {index}"));
            };
            let (Some(col), header) = (num("col"), num("headerRows").unwrap_or(0)) else {
                return failed(binding, "the rule's target names no column");
            };
            if result.fires.is_empty() {
                return Applied::new(binding, "kept").because("the rule fired on no record");
            }
            let self_id = match cell_style(session, style) {
                Ok(s) => s,
                Err(e) => return failed(binding, e.to_string()),
            };
            let mut targets = Vec::new();
            for r in &result.fires {
                let cell = format!("cell:{table}/{},{col}", *r as u32 + header);
                if let Err(e) = set(session, &cell, path, &json!(self_id)) {
                    return failed(binding, format!("{cell}: {e}"));
                }
                targets.push(cell);
            }
            row.targets = targets;
            row
        }
        ("storyRange" | "storyParagraphs", "paragraph" | "character") => {
            let ranges = if kind == "storyRange" {
                match (num("start"), num("end")) {
                    (Some(s), Some(e)) if !result.fires.is_empty() => vec![(s, e)],
                    (Some(_), Some(_)) => Vec::new(),
                    _ => return failed(binding, "the rule's story range is incomplete"),
                }
            } else {
                let paragraphs = match paragraph_ranges(session, &story) {
                    Ok(p) => p,
                    Err(e) => return failed(binding, e.to_string()),
                };
                let first = num("firstParagraph").unwrap_or(0) as usize;
                result
                    .fires
                    .iter()
                    .filter_map(|r| paragraphs.get(first + r).copied())
                    .collect()
            };
            if ranges.is_empty() {
                return Applied::new(binding, "kept")
                    .because("the rule fired on nothing its target holds");
            }
            let ops = ranges
                .iter()
                .map(|(start, end)| {
                    json!({ "op": "applyStyle", "args": {
                        "storyId": story, "start": start, "end": end,
                        "style": style, "scope": scope,
                    }})
                })
                .collect();
            if let Err(e) = batch(session, ops) {
                return failed(binding, format!("the style batch was refused: {e}"));
            }
            row.targets = ranges
                .iter()
                .map(|(s, e)| format!("storyRange:{story}@{s}..{e}"))
                .collect();
            row
        }
        _ => Applied::new(binding, "kept")
            .because(format!("a {scope} style does not apply to a {kind} target")),
    }
}

/// The `Self` of the cell style `name` names, created when the document has
/// none by that name (read first: minting is idempotent by name, and a
/// second create would add a duplicate).
fn cell_style(session: &mut Session, name: &str) -> Result<String> {
    let bare = name.strip_prefix("CellStyle/").unwrap_or(name);
    let self_id = format!("CellStyle/{bare}");
    let styles = session.model()?.cell_styles();
    if let Some(s) = styles
        .iter()
        .find(|s| s.self_id == name || s.self_id == self_id || s.name == name)
    {
        return Ok(s.self_id.clone());
    }
    mutate(
        session,
        Mutation::CreateCellStyle {
            self_id: Some(self_id.clone()),
            name: Some(bare.to_string()),
            based_on: None,
        },
    )?;
    Ok(self_id)
}

/// The swatch a colour value names, minted when a literal colour has none
/// (`property.ts` `findSwatch` / `mintSwatch`): by `Self`, by name, or as
/// `Color/<name>`. The swatches are read first, so applying again finds the
/// one an earlier apply minted rather than minting a second.
fn swatch_for(session: &mut Session, intent: &ColorIntent) -> Result<String> {
    let swatches = session.model()?.swatches();
    let named = format!("Color/{}", intent.name);
    if let Some(s) = swatches
        .iter()
        .find(|s| s.self_id == intent.name)
        .or_else(|| swatches.iter().find(|s| s.name == intent.name))
        .or_else(|| swatches.iter().find(|s| s.self_id == named))
    {
        return Ok(s.self_id.clone());
    }
    let Some(spec) = &intent.spec else {
        bail!("no swatch named \"{}\" in this document", intent.name);
    };
    mutate(
        session,
        Mutation::CreateSwatch {
            spec: paged_mutate::SwatchSpec {
                self_id: Some(named.clone()),
                name: Some(intent.name.clone()),
                space: spec.space.clone(),
                value: spec.value.iter().map(|v| *v as f32).collect(),
                model: Some("Process".into()),
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
            },
        },
    )
    .map_err(|e| anyhow!("mint the swatch {named}: {e}"))?;
    Ok(named)
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
    let source_dirs: Vec<PathBuf> = given
        .iter()
        .filter_map(|(_, file)| file.parent().map(Path::to_path_buf))
        .collect();
    let facts = &recipe.facts;
    let mut rules = Vec::new();
    for (id, binding) in &defs {
        let lowered = matches!(
            binding,
            Binding::Table { .. }
                | Binding::Image { .. }
                | Binding::Barcode { .. }
                | Binding::Rule { .. }
                | Binding::RecordFlow { .. }
        );
        if let Some(kept) = lowered.then(|| kept_by_sync(&data, id)).flatten() {
            applied.push(kept);
            continue;
        }
        match binding {
            // Written above: `resolve_properties_at` resolves a visibility
            // binding as the `elementVisible` property it is (ADR 558 §4).
            Binding::Property { .. } | Binding::Visibility { .. } => {}
            Binding::Table { .. } => {
                applied.push(apply_table(&mut session, &mut data, id, record, facts))
            }
            Binding::Image { .. } => applied.push(apply_image(
                &mut session,
                &mut data,
                id,
                record,
                facts,
                &source_dirs,
            )),
            Binding::Barcode { .. } => {
                applied.push(apply_barcode(&mut session, &mut data, id, record, facts))
            }
            // After everything else: a rule styles content (a table's cells)
            // that this apply may just have replaced.
            Binding::Rule { .. } => rules.push(id),
            // Places every record, so `--record` does not restrict it.
            Binding::RecordFlow { .. } => {
                applied.push(apply_record_flow(&mut session, &mut data, id, facts))
            }
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
        }
    }
    for id in rules {
        applied.push(apply_rule(&mut session, &mut data, id, facts));
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
