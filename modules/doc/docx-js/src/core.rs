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

//! The plain-Rust engine core behind the wasm surface.
//!
//! `DocSession` holds a loaded `.docx` (its retained bytes for the preservation
//! invariant, its parsed semantic model, the lowering, and — for M2 edited
//! save-back — the retained OPC package + the native↔OOXML provenance bindings).
//! All real work lives here so it is native-testable; `lib.rs`'s
//! `#[wasm_bindgen]` layer is a pure forwarding shim.

use docx_core::DocxDocument;
use docx_export::{
    apply_edits, build_bindings, diff, overlay_cells_known, overlay_story_content_known,
    CellContentIn, CellRunEdit, DocxBindings, EditSet, RunEdit, StoryContentIn, StructuralEdit,
};
use docx_import::import_docx_with_package;
use docx_lower::ir::{LoweredBlock, LoweredDoc};
use docx_lower::{lower_with, LowerOptions};
use paged_ooxml::OpcPackage;
use serde::Deserialize;

/// A loaded Word document session.
pub struct DocSession {
    /// The original `.docx` bytes, retained for the preservation invariant
    /// (zero-edit save-back re-emits them verbatim).
    source: Vec<u8>,
    /// The parsed semantic model.
    model: DocxDocument,
    /// The retained OPC package — the save-back patch target (`set_part` +
    /// `write`, untouched parts re-emitted byte-identical).
    package: OpcPackage,
    /// The main document part name (e.g. `word/document.xml`).
    main_part: String,
    /// The native↔OOXML provenance map for edited save-back.
    bindings: DocxBindings,
    /// The styles part name (`word/styles.xml`), when the package has one:
    /// where style changes are written (doc ADR 610).
    styles_part: Option<String>,
    /// What the target engine can lay out (ADR 029: span/split columns for
    /// a mid-page column change). The lowering, the skeleton and the
    /// save-back baseline all use it, so they stay aligned.
    options: LowerOptions,
}

impl DocSession {
    /// Load a `.docx`/`.dotx` package. Returns a human-readable error string on a
    /// hard failure (unreadable container / unparseable main document).
    pub fn load(bytes: &[u8]) -> Result<DocSession, String> {
        let (model, package, main_part) =
            import_docx_with_package(bytes).map_err(|e| e.to_string())?;
        let bindings = build_bindings(&model);
        let styles_part = docx_import::styles_part(&package, &main_part);
        Ok(DocSession {
            styles_part,
            source: bytes.to_vec(),
            model,
            package,
            main_part,
            bindings,
            options: LowerOptions::default(),
        })
    }

    /// The Tier-0 lowering (the IR the host-model turns into mutations).
    pub fn lowered(&self) -> LoweredDoc {
        lower_with(&self.model, self.options)
    }

    /// Lower a mid-page column change to span/split columns (`true`, the
    /// default: protocol 64) or to a page break (`false`: an engine that
    /// refused the properties). Applies to every later lowering, skeleton
    /// and save-back.
    pub fn set_mid_page_columns(&mut self, on: bool) {
        self.options.mid_page_columns = on;
    }

    /// Whether the lowering uses span/split columns anywhere (the bundle
    /// only needs to probe the engine then).
    pub fn uses_mid_page_columns(&self) -> bool {
        let ir = self.lowered();
        ir.styles.iter().any(|s| {
            s.props
                .iter()
                .any(|p| p.path == docx_lower::SPAN_COLUMN_TYPE)
        })
    }

    /// The skeleton's story ids, in story order.
    pub fn skeleton_stories(&self) -> Vec<String> {
        docx_skeleton::story_ids_with(&self.model, self.options)
    }

    /// The lowering as a JSON string (the wasm boundary form).
    pub fn lowered_json(&self) -> String {
        serde_json::to_string(&self.lowered()).unwrap_or_else(|_| "null".to_string())
    }

    /// The parsed semantic model (exposed for tests / debugging).
    pub fn model(&self) -> &DocxDocument {
        &self.model
    }

    /// ADR 029 — the page skeleton for standalone open: `.paged` bytes (a page,
    /// margin-box frame and empty story per Word section that starts a page;
    /// continuous sections can join the story before) plus the story ids, in
    /// order, for the grow rules and the pour.
    pub fn skeleton(&self, name: &str) -> Result<docx_skeleton::Skeleton, String> {
        docx_skeleton::skeleton_with(self.model(), name, self.options)
    }

    /// Number of top-level body blocks.
    pub fn block_count(&self) -> usize {
        self.model.body.len()
    }

    /// Zero-edit save-back: re-emit the retained source verbatim.
    pub fn save_verbatim(&self) -> Vec<u8> {
        self.source.clone()
    }

    /// M2 edited save-back: patch the given run edits into the retained package
    /// (only the changed `<w:t>`/`<w:rPr>` subtrees rewritten; every other part +
    /// untouched subtree byte-identical) and return the saved `.docx` bytes.
    /// Non-patchable edits are skipped. A cheap clone of the package keeps the
    /// session reusable for a subsequent save.
    ///
    /// DEFERRED (RFI DOC-03): the `EditSet` here is supplied by the caller
    /// (tests today). Wiring it from the LIVE editor needs a structured
    /// whole-document read door — `host.nativeDocument.readModel()` returns
    /// opaque core-native bytes this isolation-clean plugin cannot diff.
    pub fn save_edited(&self, edits: &EditSet) -> Result<(Vec<u8>, Vec<String>), String> {
        let mut package = self.package.clone();
        let skips = apply_edits(&mut package, &self.main_part, &self.bindings, edits)
            .map_err(|e| e.to_string())?;
        let bytes = package.write().map_err(|e| e.to_string())?;
        Ok((bytes, skips))
    }

    /// The object model's writes (the bundle's `run.text` and
    /// `mergeField.value`) as an [`EditSet`] over this document's lowering:
    /// a run edit sets one run's text; a merge-field edit sets the field's
    /// RESULT — its first result run takes the value, the others are emptied —
    /// and never touches the field code, so Word can still merge. A run or
    /// field names a body paragraph by its `block`, or a table cell's
    /// paragraph by its `block` (the table), `cell` (its index in the lowered
    /// cell list) and `para` (the paragraph in the cell); the cell writes
    /// become [`CellRunEdit`]s.
    pub fn object_edits(&self, edits: &ObjectEdits) -> Result<EditSet, String> {
        let ir = self.lowered();
        let paragraph = |block: usize| match ir.story.blocks.get(block) {
            Some(LoweredBlock::Paragraph(p)) => Ok(p),
            Some(LoweredBlock::Table(_)) => Err(format!(
                "block {block} is a table: name a cell and a paragraph in it"
            )),
            None => Err(format!("no block {block}")),
        };
        let located = |block: usize, at: Option<CellAt>| match at {
            None => paragraph(block),
            Some(CellAt { cell, para }) => match ir.story.blocks.get(block) {
                Some(LoweredBlock::Table(t)) if !t.flow.is_empty() => Err(format!(
                    "block {block} is a table poured as text: its cells cannot be written"
                )),
                Some(LoweredBlock::Table(t)) => t
                    .cells
                    .get(cell)
                    .ok_or_else(|| format!("block {block} has no cell {cell}"))?
                    .paragraphs
                    .get(para)
                    .ok_or_else(|| format!("cell {cell} of block {block} has no paragraph {para}")),
                Some(LoweredBlock::Paragraph(_)) => {
                    Err(format!("block {block} is a paragraph, not a table"))
                }
                None => Err(format!("no block {block}")),
            },
        };
        let mut set = EditSet::default();
        let mut push = |block: usize, at: Option<CellAt>, run: usize, text: String| match at {
            None => set.runs.push(RunEdit::text(block, run, text)),
            Some(CellAt { cell, para }) => set
                .cells
                .push(CellRunEdit::text(block, cell, para, run, text)),
        };
        for e in &edits.runs {
            let at = e.cell_at()?;
            let p = located(e.block, at)?;
            if e.run >= p.runs.len() {
                return Err(format!("block {} has no run {}", e.block, e.run));
            }
            push(e.block, at, e.run, e.text.clone());
        }
        for e in &edits.merge_fields {
            let at = e.cell_at()?;
            let p = located(e.block, at)?;
            let runs: Vec<usize> = p
                .runs
                .iter()
                .enumerate()
                .filter(|(_, r)| {
                    r.merge_field
                        .as_ref()
                        .is_some_and(|m| m.occurrence == e.occurrence)
                })
                .map(|(i, _)| i)
                .collect();
            let Some((&first, rest)) = runs.split_first() else {
                return Err(format!(
                    "block {} has no merge field #{}",
                    e.block, e.occurrence
                ));
            };
            push(e.block, at, first, e.value.clone());
            for &r in rest {
                push(e.block, at, r, String::new());
            }
        }
        for &block in &edits.delete_paragraphs {
            paragraph(block)?;
            set.structural
                .push(StructuralEdit::DeleteParagraph { block });
        }
        for e in &edits.clone_paragraphs {
            paragraph(e.source)?;
            paragraph(e.after)?;
            set.structural.push(StructuralEdit::CloneParagraph {
                source: e.source,
                after: e.after,
                text: e.text.clone(),
            });
        }
        Ok(set)
    }

    /// [`Self::object_edits`], saved: the edited `.docx` bytes plus the
    /// patcher's refusal ledger.
    pub fn save_object_edits(&self, edits: &ObjectEdits) -> Result<(Vec<u8>, Vec<String>), String> {
        self.save_edited(&self.object_edits(edits)?)
    }

    /// M2 edited save-back, driven by the DOC-03 structured read: overlay the
    /// host's read-back `StoryContent` onto the import baseline lowering, diff to
    /// an `EditSet`, and save. This is the LIVE end-to-end path (the bundle reads
    /// `host.document.storyContent(storyId)` and forwards it here) — the seam that
    /// makes edited save-back run without a hand-authored `EditSet`.
    pub fn save_edited_from_content(
        &self,
        content: &StoryContentIn,
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        self.save_edited_from_content_and_cells(content, &[])
    }

    /// [`Self::save_edited_from_content`] with the native tables' cells read
    /// back too (`cells`, the engine's cell `text`): their edits are patched
    /// into the cells' `<w:t>`s (`overlay_cells`), and what the cell patcher
    /// leaves joins the refusal ledger.
    pub fn save_edited_from_content_and_cells(
        &self,
        content: &StoryContentIn,
        cells: &[CellContentIn],
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        self.save_edited_from_content_cells_and_tables(content, cells, &[], &Default::default())
    }

    /// [`Self::save_edited_from_content_and_cells`], plus the tables whose
    /// rows were added or removed on the canvas, read back whole
    /// ([`docx_export::overlay_tables`]), and the colours of the swatches
    /// the canvas made ([`docx_export::add_canvas_colors`]).
    pub fn save_edited_from_content_cells_and_tables(
        &self,
        content: &StoryContentIn,
        cells: &[CellContentIn],
        tables: &[docx_export::TableContentIn],
        colors: &std::collections::BTreeMap<String, String>,
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        self.save_edited_full(content, cells, tables, colors, &[])
    }

    /// The tokens of the document's Word styles in paged, paragraph and
    /// character: the styles the host reads back (`styleProperties`) so a
    /// change made to one in paged is written into `styles.xml`.
    pub fn style_tokens(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .bindings
            .para_token_to_style_id
            .keys()
            .chain(self.bindings.char_token_to_style_id.keys())
            .cloned()
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// [`Self::save_edited_from_content_cells_and_tables`], plus the
    /// document's styles as the host reads them (`styles`, doc ADR 610):
    /// a Word style modified in paged is spliced into `styles.xml` in place,
    /// a style created in paged is appended with its `w:basedOn`, and the
    /// paragraphs and runs in a created style name it. A paragraph style
    /// applied on the canvas is written as the paragraph's `w:pStyle`.
    pub fn save_edited_full(
        &self,
        content: &StoryContentIn,
        cells: &[CellContentIn],
        tables: &[docx_export::TableContentIn],
        colors: &std::collections::BTreeMap<String, String>,
        styles: &[docx_export::StyleIn],
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        let baseline = self.lowered();
        let mut coloured = baseline.clone();
        docx_export::add_canvas_colors(&mut coloured, colors);
        let plan =
            docx_export::plan_styles(&self.model, &baseline, &coloured, &self.bindings, styles);
        // The created styles' tokens name their new Word ids.
        let mut bindings = self.bindings.clone();
        for (token, id) in plan.created_ids(true) {
            bindings
                .para_token_to_style_id
                .insert(token.to_string(), id.to_string());
        }
        for (token, id) in plan.created_ids(false) {
            bindings
                .char_token_to_style_id
                .insert(token.to_string(), id.to_string());
        }
        let created = |t: &str| bindings.para_token_to_style_id.contains_key(t);
        let mut edited = overlay_story_content_known(&baseline, content, &created);
        docx_export::add_canvas_colors(&mut edited, colors);
        let mut skips = docx_export::overlay_tables(&mut edited, tables);
        skips.extend(overlay_cells_known(&mut edited, cells, &created));
        let edits = diff(&baseline, &edited, &bindings);
        let mut package = self.package.clone();
        skips.extend(
            apply_edits(&mut package, &self.main_part, &bindings, &edits)
                .map_err(|e| e.to_string())?,
        );
        skips.extend(
            docx_export::apply_style_plan(&mut package, self.styles_part.as_deref(), &plan)
                .map_err(|e| e.to_string())?,
        );
        let bytes = package.write().map_err(|e| e.to_string())?;
        Ok((bytes, skips))
    }
}

/// The object model's writes, addressed in lowered story coordinates (the
/// bundle's `run` and `mergeField` objects).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEdits {
    #[serde(default)]
    pub runs: Vec<RunTextEdit>,
    #[serde(default)]
    pub merge_fields: Vec<MergeFieldEdit>,
    /// Body paragraph blocks to remove whole (a list item taken away).
    #[serde(default)]
    pub delete_paragraphs: Vec<usize>,
    /// Paragraphs to add: each a copy of a body paragraph's properties
    /// carrying new text (a list item added to its list).
    #[serde(default)]
    pub clone_paragraphs: Vec<CloneParagraphEdit>,
}

/// Add a paragraph after body block `after`, like body block `source` (its
/// paragraph properties and first run's look) with `text`.
#[derive(Debug, Clone, Deserialize)]
pub struct CloneParagraphEdit {
    pub source: usize,
    pub after: usize,
    pub text: String,
}

/// A paragraph inside a table block: the lowered cell index and the
/// paragraph's index in that cell.
#[derive(Debug, Clone, Copy)]
struct CellAt {
    cell: usize,
    para: usize,
}

/// `cell` and `para` name a cell's paragraph together, or neither is given.
fn cell_at(cell: Option<usize>, para: Option<usize>) -> Result<Option<CellAt>, String> {
    match (cell, para) {
        (None, None) => Ok(None),
        (Some(cell), Some(para)) => Ok(Some(CellAt { cell, para })),
        _ => Err("a table cell's paragraph is named by both `cell` and `para`".into()),
    }
}

/// Set one run's text: a body paragraph's (`block`), or a table cell
/// paragraph's (`block` the table, `cell`, `para`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunTextEdit {
    pub block: usize,
    #[serde(default)]
    pub cell: Option<usize>,
    #[serde(default)]
    pub para: Option<usize>,
    pub run: usize,
    pub text: String,
}

impl RunTextEdit {
    fn cell_at(&self) -> Result<Option<CellAt>, String> {
        cell_at(self.cell, self.para)
    }
}

/// Set a merge field's result: the `occurrence`-th merge field of a body
/// paragraph block, or of a table cell's paragraph (`cell`, `para`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MergeFieldEdit {
    pub block: usize,
    #[serde(default)]
    pub cell: Option<usize>,
    #[serde(default)]
    pub para: Option<usize>,
    pub occurrence: u32,
    pub value: String,
}

impl MergeFieldEdit {
    fn cell_at(&self) -> Result<Option<CellAt>, String> {
        cell_at(self.cell, self.para)
    }
}
