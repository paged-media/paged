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

//! MEASURED IDML export losses — the twin diff behind
//! `CanvasModel::idml_export_losses`.
//!
//! # Why measured, not declared
//!
//! The loss list used to be a DECLARATION: it named the one construct
//! IDML cannot carry (opacity masks) and nothing else. Real InDesign
//! 2025 then opened a 134-page book the engine had authored and showed
//! empty frames where seven runtime tables and fourteen placed images
//! were, no sections, no guide, no hyperlinks — while the loss list was
//! empty and the harness's "no unexpected loss" gate was green. A
//! declaration is only as complete as the last person who edited it.
//!
//! So the list is now MEASURED: the document is exported through the
//! same writer a save uses, the bytes are re-parsed through the same
//! importer a load uses, and the re-parsed twin is compared against the
//! live scene construct by construct. Whatever the twin lacks is a loss,
//! named by element id, with the reason spelled out. When an exporter
//! lane lands (a `<Section>` emitter, say) the corresponding line simply
//! stops appearing — no ledger to keep in sync.
//!
//! The comparison is deliberately shallow: presence + the structural
//! shape a reader would notice (a table's rows×columns, a section's page
//! start, a condition's visibility) + the text (a story's paragraphs, a
//! table's cells). It is a save-time gate, not a fidelity oracle; pixel
//! parity is the fidelity harness's job.

use std::collections::{BTreeSet, HashMap, HashSet};

use paged_model::{
    GuideOrientation, HyperlinkDestinationKind, Paragraph, Section, Spread, Story, Table,
};
use paged_scene::{Document, ParsedStory};

/// What the export was asked for, so the diff can tell a loss from a
/// construct the caller has been handed the means to keep.
#[derive(Debug, Default, Clone)]
pub(crate) struct LossContext {
    /// The link base the export was made with (`None` ⇒ URIs as held).
    pub link_base: Option<String>,
    /// The `file_name`s of the [`idml_export::ExportedLink`]s that came
    /// back WITH bytes: a frame whose twin links one of these is not a
    /// loss — the caller writes the bytes and the link binds.
    pub handed_back: HashSet<String>,
    /// Every returned link's `source_uri` → `file_name`: the name the
    /// export rebased a model URI to, so a twin link spelled
    /// `file:<base>/<file_name>` is recognised as the model's link.
    pub rebased: HashMap<String, String>,
}

/// Diff `scene` against `twin` (the scene as re-parsed from its own IDML
/// export). One human-readable line per element the twin lacks or
/// misrepresents, sorted for determinism.
pub(crate) fn diff(scene: &Document, twin: &Document, ctx: &LossContext) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    diff_sections(scene, twin, &mut out);
    diff_guides(scene, twin, &mut out);
    diff_hyperlinks(scene, twin, &mut out);
    diff_conditions(scene, twin, &mut out);
    diff_stories(scene, twin, &mut out);
    diff_page_items(scene, twin, ctx, &mut out);
    diff_canvas_placement(scene, twin, &mut out);
    out.sort();
    out.dedup();
    out
}

// ---- canvas placement (engine ADR 1011) -----------------------------------

/// A page placed on the canvas (an artboard moved off the default stack)
/// has no IDML spelling: InDesign stacks its spreads and keeps a spread's
/// pages side by side. The export keeps the page order and every spread
/// as it is — an artboard alone in its spread stays its own spread, pages
/// that share one stay adjacent — and the page opens in its default slot.
fn diff_canvas_placement(scene: &Document, twin: &Document, out: &mut Vec<String>) {
    let twin_origin: HashMap<&str, Option<[f32; 2]>> = twin
        .spreads
        .iter()
        .flat_map(|p| p.spread.pages.iter())
        .filter_map(|p| Some((p.self_id.as_deref()?, p.canvas_origin)))
        .collect();
    for parsed in &scene.spreads {
        let pages = &parsed.spread.pages;
        for page in pages {
            let (Some(id), Some([x, y])) = (page.self_id.as_deref(), page.canvas_origin) else {
                continue;
            };
            if twin_origin.get(id).copied().flatten() == page.canvas_origin {
                continue;
            }
            let shared = if pages.len() > 1 {
                " and stays beside the other pages of its spread"
            } else {
                ""
            };
            out.push(format!(
                "page `{id}` is placed at [{x}, {y}] pt on the canvas (an artboard position) —                  IDML has no free page placement: InDesign stacks the spreads, so the page                  keeps its place in the page order{shared} and opens in its default slot",
            ));
        }
    }
}

// ---- sections -------------------------------------------------------------

fn diff_sections(scene: &Document, twin: &Document, out: &mut Vec<String>) {
    for s in &scene.designmap.sections {
        match twin
            .designmap
            .sections
            .iter()
            .find(|t| t.self_id == s.self_id)
        {
            None => out.push(format!(
                "section `{}` (PageStart `{}`) is missing from the exported designmap.xml — \
                 the IDML exporter does not yet serialise a <Section> the source archive lacks",
                s.self_id,
                s.page_start.as_deref().unwrap_or("?"),
            )),
            Some(t) => {
                let stale = section_differences(s, t);
                if !stale.is_empty() {
                    out.push(format!(
                        "section `{}` exports with stale attributes ({}) — the IDML exporter \
                         does not yet patch a changed <Section>",
                        s.self_id,
                        stale.join(", "),
                    ));
                }
            }
        }
    }
}

fn section_differences(s: &Section, t: &Section) -> Vec<String> {
    let mut d = Vec::new();
    if s.page_start != t.page_start {
        d.push(format!(
            "PageStart {:?} vs {:?}",
            s.page_start.as_deref().unwrap_or(""),
            t.page_start.as_deref().unwrap_or("")
        ));
    }
    if s.numbering_style != t.numbering_style {
        d.push(format!(
            "PageNumberStyle {:?} vs {:?}",
            s.numbering_style, t.numbering_style
        ));
    }
    if s.start_at != t.start_at {
        d.push(format!(
            "PageNumberStart {:?} vs {:?}",
            s.start_at, t.start_at
        ));
    }
    if s.continue_numbering != t.continue_numbering {
        d.push(format!(
            "ContinueNumbering {} vs {}",
            s.continue_numbering, t.continue_numbering
        ));
    }
    if s.section_prefix.as_deref().unwrap_or("") != t.section_prefix.as_deref().unwrap_or("") {
        d.push(format!(
            "SectionPrefix {:?} vs {:?}",
            s.section_prefix.as_deref().unwrap_or(""),
            t.section_prefix.as_deref().unwrap_or("")
        ));
    }
    if s.include_prefix != t.include_prefix {
        d.push(format!(
            "IncludeSectionPrefix {} vs {}",
            s.include_prefix, t.include_prefix
        ));
    }
    d
}

// ---- guides ---------------------------------------------------------------

fn twin_spread<'a>(twin: &'a Document, src: &str, self_id: Option<&str>) -> Option<&'a Spread> {
    twin.spreads
        .iter()
        .find(|p| p.src == src)
        .or_else(|| {
            self_id.and_then(|id| {
                twin.spreads
                    .iter()
                    .find(|p| p.spread.self_id.as_deref() == Some(id))
            })
        })
        .map(|p| &p.spread)
}

fn guide_key(g: &paged_model::RulerGuide) -> (u8, i64, u32) {
    let o = match g.orientation {
        GuideOrientation::Vertical => 0,
        GuideOrientation::Horizontal => 1,
    };
    // Compare at 1/1000 pt — the writer's `format_f32` precision.
    ((o), (g.location * 1000.0).round() as i64, g.page_index)
}

fn guide_label(g: &paged_model::RulerGuide) -> String {
    format!(
        "{:?} at {}pt, page index {}",
        g.orientation, g.location, g.page_index
    )
}

fn diff_guides(scene: &Document, twin: &Document, out: &mut Vec<String>) {
    for parsed in &scene.spreads {
        let Some(t) = twin_spread(twin, &parsed.src, parsed.spread.self_id.as_deref()) else {
            if !parsed.spread.guides.is_empty() {
                out.push(format!(
                    "spread `{}` is missing from the export — its {} guide(s) are lost with it",
                    parsed.src,
                    parsed.spread.guides.len()
                ));
            }
            continue;
        };
        // Multiset match: identical guides are indistinguishable, and the
        // model addresses guides by position only.
        let mut remaining: Vec<(u8, i64, u32)> = t.guides.iter().map(guide_key).collect();
        for g in &parsed.spread.guides {
            let key = guide_key(g);
            if let Some(pos) = remaining.iter().position(|k| *k == key) {
                remaining.swap_remove(pos);
            } else {
                out.push(format!(
                    "guide ({}) on spread `{}` is missing from the export — the IDML exporter \
                     does not yet serialise <Guide> elements the source spread lacks",
                    guide_label(g),
                    parsed.src
                ));
            }
        }
        for key in remaining {
            if let Some(g) = t.guides.iter().find(|g| guide_key(g) == key) {
                out.push(format!(
                    "guide ({}) on spread `{}` was removed from the model but the export still \
                     carries it — the IDML exporter does not yet drop deleted <Guide> elements",
                    guide_label(g),
                    parsed.src
                ));
            }
        }
    }
}

// ---- hyperlinks -----------------------------------------------------------

fn destination_label(k: &HyperlinkDestinationKind) -> String {
    match k {
        HyperlinkDestinationKind::Url(u) => format!("URL `{u}`"),
        HyperlinkDestinationKind::Page(p) => format!("page `{p}`"),
        HyperlinkDestinationKind::TextAnchor(t) => format!("text anchor `{t}`"),
    }
}

/// Every `hyperlink_source` id tagged on any run of `doc` (top-level
/// story paragraphs + table-cell paragraphs).
fn run_sources(doc: &Document) -> HashSet<String> {
    fn walk(paras: &[Paragraph], out: &mut HashSet<String>) {
        for p in paras {
            for r in &p.runs {
                if let Some(s) = &r.hyperlink_source {
                    out.insert(s.clone());
                }
            }
            if let Some(t) = &p.table {
                for c in &t.cells {
                    walk(&c.paragraphs, out);
                }
            }
        }
    }
    let mut out = HashSet::new();
    for s in &doc.stories {
        walk(&s.story.paragraphs, &mut out);
    }
    out
}

fn diff_hyperlinks(scene: &Document, twin: &Document, out: &mut Vec<String>) {
    let scene_sources = run_sources(scene);
    let twin_sources = run_sources(twin);
    for d in &scene.designmap.hyperlink_destinations {
        if !twin
            .designmap
            .hyperlink_destinations
            .iter()
            .any(|t| t.self_id == d.self_id)
        {
            out.push(format!(
                "hyperlink destination `{}` ({}) is missing from the exported designmap.xml — \
                 the IDML exporter does not yet serialise a <Hyperlink*Destination> the source \
                 archive lacks",
                d.self_id,
                destination_label(&d.kind)
            ));
        }
    }
    for h in &scene.designmap.hyperlinks {
        match twin
            .designmap
            .hyperlinks
            .iter()
            .find(|t| t.self_id == h.self_id)
        {
            None => out.push(format!(
                "hyperlink `{}` (source `{}`, destination `{}`) is missing from the exported \
                 designmap.xml — the IDML exporter does not yet serialise a <Hyperlink> the \
                 source archive lacks",
                h.self_id,
                h.source.as_deref().unwrap_or("?"),
                h.destination.as_deref().unwrap_or("?"),
            )),
            Some(t) => {
                if h.destination != t.destination {
                    out.push(format!(
                        "hyperlink `{}` exports pointing at `{}` instead of `{}` — the IDML \
                         exporter does not yet patch a changed <Hyperlink>",
                        h.self_id,
                        t.destination.as_deref().unwrap_or(""),
                        h.destination.as_deref().unwrap_or(""),
                    ));
                }
            }
        }
        if let Some(src) = &h.source {
            if scene_sources.contains(src) && !twin_sources.contains(src) {
                out.push(format!(
                    "hyperlink `{}`'s text source `{}` wraps no run in the exported stories — \
                     the IDML exporter does not yet serialise <HyperlinkTextSource> around the \
                     linked run",
                    h.self_id, src
                ));
            }
        }
    }
}

// ---- conditions -----------------------------------------------------------

fn diff_conditions(scene: &Document, twin: &Document, out: &mut Vec<String>) {
    for (id, c) in &scene.styles.conditions {
        match twin.styles.conditions.get(id) {
            None => out.push(format!(
                "condition `{}` (`{}`) is missing from the export — the IDML exporter does not \
                 yet serialise a <Condition> the source archive lacks",
                id,
                c.name.as_deref().unwrap_or("")
            )),
            Some(t) => {
                let want = c.visible.unwrap_or(true);
                let got = t.visible.unwrap_or(true);
                if want != got {
                    out.push(format!(
                        "condition `{id}` exports Visible=\"{got}\" but the model says \
                         Visible=\"{want}\" — the IDML exporter does not yet patch a changed \
                         <Condition>"
                    ));
                }
            }
        }
    }
    for id in scene.styles.condition_sets.keys() {
        if !twin.styles.condition_sets.contains_key(id) {
            out.push(format!(
                "condition set `{id}` is missing from the export — the IDML exporter does not \
                 yet serialise a <ConditionSet> the source archive lacks"
            ));
        }
    }
}

// ---- stories: tables ------------------------------------------------------

/// The twin story for a scene story. A story minted post-parse is named
/// `Story/u<n>`; its entry is `Stories/Story_Story_u<n>.xml`, and
/// `derive_story_id` hands the reopened story the SANITIZED id
/// `Story_u<n>` — so the twin is matched on either spelling.
fn twin_story<'a>(twin: &'a Document, id: &str) -> Option<&'a ParsedStory> {
    let sanitized = id.replace('/', "_");
    twin.stories
        .iter()
        .find(|s| s.self_id == id)
        .or_else(|| twin.stories.iter().find(|s| s.self_id == sanitized))
}

/// Every table in a story, outermost first, nested (cell) tables after.
fn tables_of(story: &Story) -> Vec<&Table> {
    fn walk<'a>(paras: &'a [Paragraph], out: &mut Vec<&'a Table>) {
        for p in paras {
            if let Some(t) = &p.table {
                out.push(t);
            }
        }
        for p in paras {
            if let Some(t) = &p.table {
                for c in &t.cells {
                    walk(&c.paragraphs, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&story.paragraphs, &mut out);
    out
}

/// Each paragraph's text, as [`diff_stories`] compares a story with its
/// re-read export.
///
/// Empty paragraphs are left out: the parser drops a paragraph with
/// neither text nor table on read, so one the model still holds (a
/// frame's initial empty paragraph) is a read-side asymmetry, not lost
/// text.
///
/// A paragraph holding a table compares without one trailing "\n". A
/// table with no anchor after text means "the text is a paragraph of its
/// own and the table follows it" (idml-export `inline_objects`), and the
/// writer spells that `text<Br/><Table/>`; the reader keeps that mark as
/// a "\n" in the host paragraph (idml-import, the `Table` arm). The same
/// mark, implied on one side and spelled on the other: the showcase's
/// DOCX manuscript story was reported as exporting different text for it.
fn paragraph_texts(paras: &[Paragraph]) -> Vec<String> {
    paras
        .iter()
        .map(|p| {
            let mut text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
            if p.table.is_some() && text.ends_with('\n') {
                text.pop();
            }
            text
        })
        .filter(|t| !t.is_empty())
        .collect()
}

fn table_shape(t: &Table) -> (usize, usize) {
    let rows = if t.rows.is_empty() {
        (t.header_row_count + t.body_row_count + t.footer_row_count) as usize
    } else {
        t.rows.len()
    };
    let cols = if t.columns.is_empty() {
        t.column_count as usize
    } else {
        t.columns.len()
    };
    (rows, cols)
}

fn diff_stories(scene: &Document, twin: &Document, out: &mut Vec<String>) {
    // The writer drops a story no frame references (InDesign discards
    // one on open — measured), so the twin lacks it BY DESIGN; the loss
    // line says so, loudly, instead of reporting it as an exporter gap.
    // An orphan with neither text nor a table (a frame minted and
    // deleted before anything was typed) is dropped silently.
    let placed = idml_export::placed_story_ids(scene);
    for s in &scene.stories {
        let scene_tables = tables_of(&s.story);
        if !idml_export::story_is_placed(&placed, &s.self_id) {
            let text_chars: usize = s
                .story
                .paragraphs
                .iter()
                .flat_map(|p| p.runs.iter())
                .map(|r| r.text.chars().count())
                .sum();
            if text_chars > 0 || !scene_tables.is_empty() {
                out.push(format!(
                    "story `{}` ({} chars, {} tables) is referenced by no frame — dropped from \
                     the export; delete it or place it",
                    s.self_id,
                    text_chars,
                    scene_tables.len()
                ));
            }
            continue;
        }
        let Some(t) = twin_story(twin, &s.self_id) else {
            let text_chars: usize = s
                .story
                .paragraphs
                .iter()
                .flat_map(|p| p.runs.iter())
                .map(|r| r.text.chars().count())
                .sum();
            out.push(format!(
                "story `{}` is missing from the export entirely ({} characters, {} table(s)) — \
                 its text, tables and links are all lost",
                s.self_id,
                text_chars,
                scene_tables.len()
            ));
            continue;
        };
        let minted = s.src.is_empty();
        // The text itself, paragraph by paragraph: a run the exporter
        // re-serialised from the wrong model run, or a mark it dropped,
        // shows up here as a character-count / paragraph-count mismatch.
        let scene_paras = paragraph_texts(&s.story.paragraphs);
        let twin_paras = paragraph_texts(&t.story.paragraphs);
        if scene_paras != twin_paras {
            let scene_chars: usize = scene_paras.iter().map(|p| p.chars().count()).sum();
            let twin_chars: usize = twin_paras.iter().map(|p| p.chars().count()).sum();
            out.push(format!(
                "story `{}` exports with different text: {} paragraph(s) / {} character(s) in \
                 the model, {} / {} in the export — the IDML exporter re-serialised a run it \
                 could not match (a split run, a lost paragraph mark)",
                s.self_id,
                scene_paras.len(),
                scene_chars,
                twin_paras.len(),
                twin_chars
            ));
        }
        let twin_tables = tables_of(&t.story);
        let mut twin_by_id: HashMap<&str, &Table> = HashMap::new();
        for tt in &twin_tables {
            if let Some(id) = tt.self_id.as_deref() {
                twin_by_id.insert(id, tt);
            }
        }
        for (i, st) in scene_tables.iter().enumerate() {
            let id = st.self_id.clone().unwrap_or_else(|| format!("#{i}"));
            let (rows, cols) = table_shape(st);
            // By id when it has one; the i-th table otherwise.
            let twin_table = match st.self_id.as_deref() {
                Some(id) => twin_by_id.get(id).copied(),
                None => twin_tables.get(i).copied(),
            };
            match twin_table {
                None => out.push(format!(
                    "table `{}` ({}×{}) in story `{}` is missing from the export — the IDML \
                     exporter does not yet serialise a table inside a {}",
                    id,
                    rows,
                    cols,
                    s.self_id,
                    if minted {
                        "minted story"
                    } else {
                        "source story that does not carry it"
                    }
                )),
                Some(tt) => {
                    let (tr, tc) = table_shape(tt);
                    if (tr, tc) != (rows, cols) {
                        out.push(format!(
                            "table `{}` in story `{}` exports as {}×{} but the model has {}×{} \
                             — the IDML exporter does not yet patch table structure",
                            id, s.self_id, tr, tc, rows, cols
                        ));
                    } else if let Some(line) = cell_text_loss(&id, &s.self_id, st, tt) {
                        out.push(line);
                    }
                }
            }
        }
    }
}

/// A table whose id and shape survived but whose cells export text the
/// model does not hold — the content written is an older one (a part
/// replayed from a checkpoint, a cell the writer could not match). Cells
/// are paired by their `col:row` name (by position, column-major, when
/// the model never named one); a cell's text is its paragraphs' text
/// with empty paragraphs left out, as for a story.
fn cell_text_loss(id: &str, story: &str, scene: &Table, twin: &Table) -> Option<String> {
    let texts = |t: &Table| -> HashMap<(u32, u32), Vec<String>> {
        let rows = table_shape(t).0.max(1);
        t.cells
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let at = c.coords().unwrap_or(((i / rows) as u32, (i % rows) as u32));
                let text = c
                    .paragraphs
                    .iter()
                    .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                    .filter(|t| !t.is_empty())
                    .collect();
                (at, text)
            })
            .collect()
    };
    let (want, got) = (texts(scene), texts(twin));
    let mut differing: Vec<(u32, u32)> = want
        .iter()
        .filter(|(at, text)| got.get(*at).map_or(!text.is_empty(), |g| g != *text))
        .map(|(at, _)| *at)
        .collect();
    differing.sort_unstable();
    let first = *differing.first()?;
    Some(format!(
        "table `{}` in story `{}` exports {} cell(s) with text the model does not hold \
         (cell {}:{} reads {:?}, the model {:?}) — the IDML exporter wrote stale cell content",
        id,
        story,
        differing.len(),
        first.0,
        first.1,
        got.get(&first).map(|t| t.join("\n")).unwrap_or_default(),
        want.get(&first).map(|t| t.join("\n")).unwrap_or_default(),
    ))
}

// ---- page items: placed images + groups -----------------------------------

/// The image lanes of one graphic frame, whatever its shape.
struct ImageFrame<'a> {
    id: &'a str,
    bytes: Option<usize>,
    link: Option<&'a str>,
    has_image_element: bool,
}

fn image_frames(spread: &Spread) -> Vec<ImageFrame<'_>> {
    let mut out = Vec::new();
    for r in &spread.rectangles {
        if let Some(id) = r.self_id.as_deref() {
            out.push(ImageFrame {
                id,
                bytes: r.image_bytes.as_ref().map(|b| b.len()),
                link: r.image_link.as_deref(),
                has_image_element: r.has_image_element,
            });
        }
    }
    for o in &spread.ovals {
        if let Some(id) = o.self_id.as_deref() {
            out.push(ImageFrame {
                id,
                bytes: o.image_bytes.as_ref().map(|b| b.len()),
                link: o.image_link.as_deref(),
                has_image_element: o.has_image_element,
            });
        }
    }
    for p in &spread.polygons {
        if let Some(id) = p.self_id.as_deref() {
            out.push(ImageFrame {
                id,
                bytes: p.image_bytes.as_ref().map(|b| b.len()),
                link: p.image_link.as_deref(),
                has_image_element: p.has_image_element,
            });
        }
    }
    out
}

fn diff_page_items(scene: &Document, twin: &Document, ctx: &LossContext, out: &mut Vec<String>) {
    for parsed in &scene.spreads {
        let Some(t) = twin_spread(twin, &parsed.src, parsed.spread.self_id.as_deref()) else {
            continue;
        };
        let twin_frames: HashMap<&str, ImageFrame<'_>> =
            image_frames(t).into_iter().map(|f| (f.id, f)).collect();
        for f in image_frames(&parsed.spread) {
            if f.bytes.is_none() && f.link.is_none() {
                continue; // no image on this frame: nothing to lose
            }
            let Some(tf) = twin_frames.get(f.id) else {
                out.push(format!(
                    "page item `{}` on spread `{}` is missing from the export — the placed \
                     image it carried is lost with it",
                    f.id, parsed.src
                ));
                continue;
            };
            if let Some(n) = f.bytes {
                // With a link base, the export handed the bytes back
                // under the name its `<Link>` points at: the caller
                // writes that file and InDesign reads exactly these
                // pixels — nothing is lost.
                let handed_back = tf
                    .link
                    .map(|l| {
                        ctx.handed_back
                            .contains(&idml_export::images::link_file_name(l))
                    })
                    .unwrap_or(false);
                if tf.bytes.is_none() && !handed_back {
                    match (f.link, tf.link) {
                        (Some(uri), Some(_)) => out.push(format!(
                            "image bytes on `{}` ({} bytes) are not in the export — IDML cannot \
                             embed pixels; the frame links to `{}` instead, so InDesign re-reads \
                             the asset and any edit to the pixels is lost. Export with a link \
                             base to have the bytes written beside the package, or save as \
                             `.paged` to keep them",
                            f.id, n, uri
                        )),
                        _ => out.push(format!(
                            "image placed from bytes on `{}` ({} bytes) is not in the export — an \
                             image placed from bytes has no IDML link to point at (IDML cannot embed \
                             pixels), so the frame exports empty. Export with a link base to have \
                             the bytes written as a file the frame links to{}, or save as `.paged` \
                             to keep it",
                            f.id,
                            n,
                            match &ctx.link_base {
                                Some(_) => " (the bytes are in no format InDesign places)",
                                None => "",
                            }
                        )),
                    }
                }
            }
            if let Some(uri) = f.link {
                // The twin carries the link when it spells the model's
                // URI, or — with a link base — the file the export
                // rebased that URI to.
                let carried = match tf.link {
                    Some(t) if t == uri => true,
                    Some(t) => ctx
                        .rebased
                        .get(uri)
                        .is_some_and(|name| *name == idml_export::images::link_file_name(t)),
                    None => false,
                };
                if !(carried || (tf.has_image_element && tf.bytes.is_some())) {
                    out.push(format!(
                        "image link `{}` on `{}` is missing from the export — the IDML exporter \
                         does not yet serialise <Image>/<Link> for a placed image",
                        uri, f.id
                    ));
                }
            }
        }
        // Groups.
        let twin_groups: BTreeSet<&str> = t
            .groups
            .iter()
            .filter_map(|g| g.self_id.as_deref())
            .collect();
        for g in &parsed.spread.groups {
            let Some(id) = g.self_id.as_deref() else {
                continue;
            };
            if !twin_groups.contains(id) {
                out.push(format!(
                    "group `{}` ({} member(s)) on spread `{}` is missing from the export — the \
                     IDML exporter does not yet serialise <Group> on a minted spread",
                    id,
                    g.members.len(),
                    parsed.src
                ));
            }
        }
    }
}

/// The opacity-mask lines — the one construct IDML genuinely cannot
/// carry. Text kept verbatim from the declared-loss era: the harness
/// matches on it.
pub(crate) fn opacity_mask_losses(scene: &Document) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for parsed in &scene.spreads {
        let mut ids: Vec<(&String, &paged_model::OpacityMask)> =
            parsed.spread.opacity_masks.iter().collect();
        // HashMap iteration order is not stable; sort so the
        // reported list is deterministic across runs.
        ids.sort_by(|a, b| a.0.cmp(b.0));
        for (target, mask) in ids {
            out.push(format!(
                "opacity mask on `{target}` (artwork `{}`) is a paged-native construct — \
                 IDML has no opacity-mask element, so the mask is dropped and its artwork \
                 exports as an ordinary item. Save as `.paged` to keep it.",
                mask.mask_item
            ));
        }
    }
    out
}

/// Engine ADR 1006 — the even-odd outlines IDML cannot carry. IDML fills
/// non-zero and has no attribute for another rule; the writer re-winds an
/// even-odd outline whose contours cross neither themselves nor each
/// other (the same area fills), and these are the rest: their contours
/// cross, so InDesign fills them non-zero (a star's middle fills). Declared
/// from the model, like the opacity masks, because the twin cannot tell
/// a re-wound outline from one that never was even-odd.
pub(crate) fn fill_rule_losses(scene: &Document) -> Vec<String> {
    use paged_model::FillRule;
    let mut out = Vec::new();
    let mut check = |kind: &str,
                     id: Option<&str>,
                     rule: FillRule,
                     anchors: &[paged_model::PathAnchor],
                     starts: &[usize],
                     open: &[bool]| {
        if rule == FillRule::EvenOdd
            && !paged_model::winding::even_odd_is_expressible(anchors, starts, open)
        {
            out.push(format!(
                "even-odd fill rule on {kind} `{}` is a paged-native property — IDML fills \
                 non-zero and its contours cross, so no re-winding fills the same area; it \
                 exports filled non-zero. Save as `.paged` to keep it.",
                id.unwrap_or("?")
            ));
        }
    };
    for parsed in &scene.spreads {
        let sp = &parsed.spread;
        for f in &sp.text_frames {
            let id = f.self_id.as_deref();
            check(
                "text frame",
                id,
                f.fill_rule,
                &f.anchors,
                &f.subpath_starts,
                &f.subpath_open,
            );
        }
        for r in &sp.rectangles {
            let id = r.self_id.as_deref();
            check(
                "rectangle",
                id,
                r.fill_rule,
                &r.anchors,
                &r.subpath_starts,
                &r.subpath_open,
            );
        }
        for p in &sp.polygons {
            let id = p.self_id.as_deref();
            check(
                "polygon",
                id,
                p.fill_rule,
                &p.anchors,
                &p.subpath_starts,
                &p.subpath_open,
            );
        }
        for l in &sp.graphic_lines {
            let id = l.self_id.as_deref();
            check(
                "line",
                id,
                l.fill_rule,
                &l.anchors,
                &l.subpath_starts,
                &l.subpath_open,
            );
        }
    }
    out
}

/// Engine ADR 1047 — the live shapes IDML cannot keep live. A pie oval
/// exports its wedge as the `<Oval>`'s path, which InDesign draws, and its
/// angles in the item's `paged:liveShape` label, which InDesign keeps and
/// a paged reader lifts back; in InDesign it is a plain path. A live
/// polygon is not listed: InDesign keeps no polygon's sides either, and
/// its anchors are exact. Declared from the model, like the opacity masks.
pub(crate) fn live_shape_losses(scene: &Document) -> Vec<String> {
    let mut out = Vec::new();
    for parsed in &scene.spreads {
        for o in &parsed.spread.ovals {
            if let Some(pie) = paged_model::live_shape::cut_pie(o) {
                out.push(format!(
                    "pie angles ({}° to {}°) on oval `{}` are a paged-native live shape — IDML \
                     draws the wedge as the oval's path, and the angles ride its \
                     `paged:liveShape` label: InDesign shows the pie but cannot edit its angles.",
                    pie.start,
                    pie.end,
                    o.self_id.as_deref().unwrap_or("?")
                ));
            }
        }
    }
    out
}

/// Engine ADR 1042 — the live vector effects IDML cannot say. Every
/// item with an enabled vector entry is written BAKED (its effected
/// outline; an oval as a polygon, a group with a Pathfinder effect as one
/// polygon), the source and the stack kept in labels a paged reader
/// restores; InDesign shows the outline, not the effect. A group whose
/// members a Pathfinder effect cannot be written over (a text frame, a
/// nested group, a symbol instance) is written as its members.
pub(crate) fn vector_effect_losses(scene: &Document) -> Vec<String> {
    use paged_model::effect_stack::{vector_entries, EffectEntry};
    let mut out = Vec::new();
    let mut unwritten = Vec::new();
    let mut check = |kind: &str, id: Option<&str>, stack: &[EffectEntry]| {
        let kinds: Vec<&str> = vector_entries(stack)
            .map(|e| e.effect.kind_name())
            .collect();
        if kinds.is_empty() {
            return;
        }
        out.push(format!(
            "vector effect{} {} on {kind} `{}` has no IDML form — written baked (the \
             effected outline{}), the source and the live stack kept in the item's \
             `paged:vectorSource` and `paged:effectStack` labels, which a paged reader \
             restores; InDesign shows the outline, not the effect.",
            if kinds.len() > 1 { "s" } else { "" },
            kinds
                .iter()
                .map(|k| format!("`{k}`"))
                .collect::<Vec<_>>()
                .join(", "),
            id.unwrap_or("?"),
            match kind {
                "oval" => ", as a polygon",
                "group" => ", as one polygon in the group's place",
                _ => "",
            }
        ));
    };
    for parsed in &scene.spreads {
        let sp = &parsed.spread;
        for f in &sp.text_frames {
            check("text frame", f.self_id.as_deref(), &f.effect_stack);
        }
        for f in &sp.rectangles {
            check("rectangle", f.self_id.as_deref(), &f.effect_stack);
        }
        for f in &sp.ovals {
            check("oval", f.self_id.as_deref(), &f.effect_stack);
        }
        for f in &sp.polygons {
            check("polygon", f.self_id.as_deref(), &f.effect_stack);
        }
        for g in &sp.groups {
            let readable = g.members.iter().all(|m| {
                matches!(
                    m,
                    paged_model::FrameRef::Rectangle(_)
                        | paged_model::FrameRef::Oval(_)
                        | paged_model::FrameRef::Polygon(_)
                        | paged_model::FrameRef::GraphicLine(_)
                )
            });
            if readable {
                check("group", g.self_id.as_deref(), &g.effect_stack);
            } else if vector_entries(&g.effect_stack).next().is_some() {
                unwritten.push(format!(
                    "the Pathfinder effect on group `{}` is not written — the group holds a \
                     text frame, a group or a symbol instance, which IDML cannot replace by \
                     one outline; it is written as its members, the stack kept in its label \
                     is not (InDesign draws the members).",
                    g.self_id.as_deref().unwrap_or("?")
                ));
            }
        }
    }
    out.extend(unwritten);
    out
}

/// Engine ADR 1008 — what an item's effect stack says that IDML cannot:
/// an effect InDesign does not have (it rides the item's
/// `paged:effectStack` label, which InDesign keeps and does not draw, so a
/// paged reader restores it), and an order of InDesign's own effects that
/// differs from the fixed one InDesign draws them in. Declared from the
/// model: the twin reads the label back, so it cannot see the loss.
pub(crate) fn effect_stack_losses(scene: &Document) -> Vec<String> {
    use paged_model::effect_stack::{EffectBearing, EffectTarget};
    let mut out = Vec::new();
    let mut check = |kind: &str, id: Option<&str>, item: &dyn EffectBearing| {
        let id = id.unwrap_or("?");
        for target in EffectTarget::ALL {
            let slots = item.effect_slots(target);
            let on = match target {
                EffectTarget::Object => "",
                EffectTarget::Fill => " (fill)",
                EffectTarget::Stroke => " (stroke)",
                EffectTarget::Content => " (content)",
            };
            for e in slots.stack.iter().filter(|e| e.enabled) {
                // Vector effects are reported (and baked) by
                // `vector_effect_losses`.
                if e.effect.indesign().is_none() && !e.effect.is_vector() {
                    out.push(format!(
                        "effect `{}` on {kind} `{id}`{on} has no IDML form — InDesign has its \
                         nine effects only; it is kept in the item's `paged:effectStack` label, \
                         which InDesign preserves and does not draw. Save as `.paged` to keep \
                         it visible everywhere.",
                        e.effect.kind_name()
                    ));
                }
            }
            if slots.indesign_order_differs() {
                out.push(format!(
                    "the order of the InDesign effects on {kind} `{id}`{on} differs from \
                     InDesign's fixed order — InDesign draws them in its own; the order is \
                     kept in the item's `paged:effectStack` label."
                ));
            }
        }
    };
    for parsed in &scene.spreads {
        let sp = &parsed.spread;
        for f in &sp.text_frames {
            check("text frame", f.self_id.as_deref(), f);
        }
        for f in &sp.rectangles {
            check("rectangle", f.self_id.as_deref(), f);
        }
        for f in &sp.ovals {
            check("oval", f.self_id.as_deref(), f);
        }
        for f in &sp.polygons {
            check("polygon", f.self_id.as_deref(), f);
        }
    }
    // Engine ADR 1045 — an anchored frame carries the same stacks.
    fn anchored<'a>(
        frames: &'a [paged_model::AnchoredFrame],
        out: &mut Vec<&'a paged_model::AnchoredFrame>,
    ) {
        for f in frames {
            out.push(f);
            anchored(&f.children, out);
        }
    }
    let mut frames = Vec::new();
    for parsed in &scene.stories {
        for p in &parsed.story.paragraphs {
            anchored(&p.anchored_frames, &mut frames);
        }
    }
    for f in frames {
        check("anchored frame", f.self_id.as_deref(), f);
    }
    out
}

/// Engine ADR 1043 — an item's appearance has no IDML form: the writer
/// bakes it to a group of single-paint items and keeps the source in the
/// carrier's `paged:appearance` label. Declared from the model: the twin
/// reads the label back, so it cannot see the loss.
pub(crate) fn appearance_losses(scene: &Document) -> Vec<String> {
    scene
        .spreads
        .iter()
        .flat_map(|p| paged_model::appearance::interchange::losses(&p.spread))
        .collect()
}

/// Engine ADR 1037 — the image filter stacks IDML cannot carry. InDesign
/// has no adjustment on a placed picture, so it shows the picture as it
/// is; the export keeps each stack in the frame's label, which paged reads
/// back on reopen. Declared from the model, like the opacity masks: the
/// twin reads the label back and so cannot tell the loss.
pub(crate) fn image_adjustment_losses(scene: &Document) -> Vec<String> {
    let mut out = Vec::new();
    let mut check = |kind: &str, id: Option<&str>, ops: &[paged_model::RasterOp]| {
        if ops.is_empty() {
            return;
        }
        let names: Vec<&str> = ops.iter().map(|op| op.name()).collect();
        out.push(format!(
            "image filter stack on {kind} `{}` ({}) is a paged-native construct — IDML has \
             no adjustment on a placed picture, so InDesign shows it unadjusted; the stack \
             rides the frame's `{}` label and comes back when paged reopens the file. \
             Save as `.paged` to keep it.",
            id.unwrap_or("?"),
            names.join(", "),
            paged_model::image_adjust::IMAGE_ADJUSTMENTS_LABEL,
        ));
    };
    for parsed in &scene.spreads {
        let sp = &parsed.spread;
        for r in &sp.rectangles {
            check("rectangle", r.self_id.as_deref(), &r.image_adjustments);
        }
        for o in &sp.ovals {
            check("oval", o.self_id.as_deref(), &o.image_adjustments);
        }
        for p in &sp.polygons {
            check("polygon", p.self_id.as_deref(), &p.image_adjustments);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_model::{CharacterRun, TableCell, TableRow};

    fn table(texts: &[&str], named: bool) -> Table {
        Table {
            self_id: Some("t1".into()),
            body_row_count: texts.len() as u32,
            column_count: 1,
            rows: texts.iter().map(|_| TableRow::default()).collect(),
            cells: texts
                .iter()
                .enumerate()
                .map(|(r, text)| TableCell {
                    name: named.then(|| format!("0:{r}")),
                    paragraphs: vec![Paragraph {
                        runs: vec![CharacterRun {
                            text: text.to_string(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }],
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    /// The table's id and shape match; the text in a cell does not. The
    /// model's cells may be unnamed (paired by position), the export's
    /// are named.
    #[test]
    fn stale_cell_text_is_a_loss() {
        let scene = table(&["Opening", "1,200", "Closing"], false);
        let twin = table(&["Opening", "980", ""], true);
        let line = cell_text_loss("t1", "Story/u849", &scene, &twin).expect("a loss");
        assert!(
            line.starts_with(
                "table `t1` in story `Story/u849` exports 2 cell(s) with text the model does \
                 not hold (cell 0:1 reads \"980\", the model \"1,200\")"
            ),
            "{line}"
        );
        assert!(cell_text_loss(
            "t1",
            "Story/u849",
            &scene,
            &table(&["Opening", "1,200", "Closing"], true)
        )
        .is_none());
    }

    fn paragraph(text: &str, with_table: bool) -> Paragraph {
        Paragraph {
            runs: vec![CharacterRun {
                text: text.to_string(),
                ..Default::default()
            }],
            table: with_table.then(|| table(&["Cell"], true)),
            ..Default::default()
        }
    }

    /// The model's paragraph holds "Lead" and an unanchored table; the
    /// re-read export holds "Lead\n" and the table. Only that mark is
    /// forgiven: changed text still differs, and a trailing newline in a
    /// paragraph without a table is text.
    #[test]
    fn a_table_after_text_compares_without_its_spelled_mark() {
        assert_eq!(
            paragraph_texts(&[paragraph("Lead", true)]),
            paragraph_texts(&[paragraph("Lead\n", true)])
        );
        assert_ne!(
            paragraph_texts(&[paragraph("Lead", true)]),
            paragraph_texts(&[paragraph("Lead.\n", true)])
        );
        assert_ne!(
            paragraph_texts(&[paragraph("Lead", false)]),
            paragraph_texts(&[paragraph("Lead\n", false)])
        );
    }
}
