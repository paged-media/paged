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

//! The structure reader (publish ADR 660): a PDF read back into the
//! document it was set from — text frames of live text threaded across
//! pages, paragraph and character styles, swatches, masters carrying the
//! page numbers, facing spreads, and pictures in frames with their crops.
//!
//! Pipeline: every page is read once by the engine's interpreter
//! ([`crate::vectors`]); its glyphs become lines, frames and paragraphs
//! ([`text`]); items that repeat at one place on many pages become master
//! items; frames whose text runs on become threads; paragraphs that look
//! alike share a style ([`styles`]); everything else on the page — paths,
//! pictures, shadings, masks — is lowered as place-as-vectors lowers it
//! ([`crate::lower`]). A [`Recipe`] supplies what the page cannot say:
//! the fonts to set it in, names, and fixes.

pub mod fonts;
pub mod recipe;
mod styles;
mod text;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use kurbo::Affine;
use paged_model::{
    Bounds, CharacterRun, CharacterStyleDef, DesignMap, FirstBaselineOffset, FrameRef,
    Justification, Page, Paragraph, ParagraphStyleDef, Section, Spread, SpreadRef, Story, StoryRef,
    TextFrame, AUTO_PAGE_NUMBER_MARKER,
};
use paged_scene::{Document, ParsedMasterSpread, ParsedSpread, ParsedStory};
use serde::Serialize;

use crate::lower::{IdGen, Lowering, Palette, TextMode, TextPlan, IDENTITY};
use crate::vectors::ir::{Item, Paint, VectorPage};
use crate::vectors::{self, ReadOptions};
use crate::Error;

pub use fonts::FontBook;
pub use recipe::Recipe;

use styles::{CharKey, ParaKey, Styles};
use text::{Block, Para};

/// One glyph where the page sets it, in spread points (y down).
#[derive(Debug, Clone)]
pub struct Glyph {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub adv: f32,
    /// `adv` is the font's own, not an estimate.
    pub has_adv: bool,
    pub size: f32,
    pub hscale: f32,
    /// Index into the document's font table.
    pub font: u32,
    pub color: [u8; 3],
    /// Paint order of its run on the page.
    pub order: u32,
    /// A lowercase letter drawn as a capital (`Some(true)`, InDesign's
    /// All Caps) or as itself (`Some(false)`); `None` when the glyph
    /// cannot say (a capital, a digit, a space).
    pub caps: Option<bool>,
}

/// The document and what became of it.
pub struct Reconstruction {
    pub document: Document,
    pub report: Report,
}

/// What the reader made of the PDF, for the person who checks it.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub pdf_pages: usize,
    pub pages: usize,
    pub spreads: usize,
    pub text_frames: usize,
    pub stories: usize,
    /// Links between frames (a story of n frames has n − 1).
    pub threads: usize,
    pub paragraphs: usize,
    pub paragraph_styles: Vec<StyleReport>,
    pub character_styles: Vec<String>,
    pub swatches: usize,
    pub masters: Vec<String>,
    /// Paragraphs carrying a local override of their style.
    pub paragraph_overrides: usize,
    pub fonts: Vec<FontReport>,
    /// What could not be carried exactly, by kind.
    pub losses: BTreeMap<String, u32>,
    /// Each document page's source: `[pdf page (1-based), x offset into
    /// it, width]` in points — what a comparison crops the PDF to.
    pub page_map: Vec<[f32; 3]>,
    /// Story id → per paragraph: the lines the PDF sets it in and its
    /// style's inferred name — what the engine's line breaks are held to.
    pub story_lines: BTreeMap<String, Vec<(u32, String, String)>>,
}

#[derive(Debug, Serialize)]
pub struct StyleReport {
    pub name: String,
    /// The name the reader gave it (what the recipe's `style_names` keys).
    pub inferred: String,
    /// Its first paragraph's opening words, and that paragraph's page.
    pub sample: String,
    pub page: usize,
    pub font: String,
    pub size: f32,
    pub leading: f32,
    pub tracking: f32,
    pub paragraphs: usize,
}

#[derive(Debug, Serialize)]
pub struct FontReport {
    pub postscript_name: String,
    pub family: String,
    pub style: String,
    /// The font book holds the family.
    pub available: bool,
    /// Characters the substitute has no glyph for.
    pub missing_chars: String,
    pub glyphs: usize,
}

/// Where a page sits.
#[derive(Debug, Clone)]
struct PagePlan {
    /// Left edge in spread coordinates.
    x: f32,
    w: f32,
    h: f32,
    left_side: bool,
}

#[derive(Debug, Clone)]
struct SpreadPlan {
    pages: Vec<PagePlan>,
    /// PDF pages drawn on this spread and the x offset from PDF page to
    /// spread coordinates.
    pdf: Vec<(usize, f32)>,
}

/// Read `bytes` into a native document.
pub fn reconstruct(
    bytes: &[u8],
    recipe: &Recipe,
    book: &FontBook,
) -> Result<Reconstruction, Error> {
    let info = vectors::inspect(bytes).map_err(|e| Error::Build(format!("{}: {e}", e.code())))?;
    let n = info.pages.len();
    let (from, to) = match recipe.pages {
        Some([a, b]) => (a.max(1) - 1, b.min(n).max(1) - 1),
        None => (0, n.saturating_sub(1)),
    };
    let sizes: Vec<(usize, f32, f32)> = (from..=to)
        .map(|i| (i, info.pages[i].width_pt, info.pages[i].height_pt))
        .collect();
    let plan = plan_spreads(&sizes, recipe.layout);
    let mut report = Report {
        pdf_pages: sizes.len(),
        ..Report::default()
    };

    // Pass 1: read every page; its glyphs, in spread coordinates.
    let reader =
        vectors::Reader::open(bytes).map_err(|e| Error::Build(format!("{}: {e}", e.code())))?;
    // Words the document spells with a hyphen in mid-line: a hyphen at a
    // line's end inside one of them is a hard hyphen, not hyphenation.
    let mut hyphenated_words: BTreeSet<String> = BTreeSet::new();
    let mut fonts = FontTable {
        faces: reader.font_faces(),
        programs: reader.font_programs_by_key(),
        ..FontTable::default()
    };
    let mut read: HashMap<usize, VectorPage> = HashMap::new();
    // Per spread: its blocks (frames of text), each with its page.
    let mut spread_blocks: Vec<Vec<(usize, Block)>> = Vec::new();
    for sp in &plan {
        let mut blocks_here = Vec::new();
        for &(pdf, dx) in &sp.pdf {
            let page = match reader.page(pdf, &ReadOptions::default()) {
                Ok(p) => p,
                Err(e) => {
                    *report
                        .losses
                        .entry(format!("page.unreadable: {e}"))
                        .or_default() += 1;
                    continue;
                }
            };
            for l in &page.losses {
                *report.losses.entry(l.code.to_string()).or_default() += l.count as u32;
            }
            let mut page = page;
            if std::env::var("PAGED_PDF_DEBUG_ITEMS").ok() == Some((pdf + 1).to_string()) {
                dump_items(&page.items, 0);
            }
            if !recipe.outline_fonts.is_empty() {
                mark_outlined(&mut page.items, &fonts.faces, &recipe.outline_fonts);
            }
            bake_image_masks(&mut page.items);
            // Glyphs by reading direction (tenths of a degree; 0 upright),
            // each turned direction read in its own axes.
            let mut by_turn: BTreeMap<i32, Vec<Glyph>> = BTreeMap::new();
            let mut order = 0u32;
            collect_glyphs(&page.items, dx, &mut fonts, &mut by_turn, &mut order, false);
            for (turn_key, glyphs) in by_turn {
                let turn = turn_key as f32 / 1800.0 * std::f32::consts::PI;
                // Page edges: a line does not run across one (the spine).
                let cuts: Vec<f32> = if turn_key == 0 {
                    sp.pages.iter().flat_map(|p| [p.x, p.x + p.w]).collect()
                } else {
                    Vec::new()
                };
                let lines = text::lines(glyphs, &cuts);
                for line in &lines {
                    hyphenated_words.extend(mid_line_compounds(&line.text()));
                }
                for b in text::blocks(lines)
                    .into_iter()
                    .flat_map(text::split_display)
                    .flat_map(text::split_measures)
                {
                    let mut block = text::build_block(b);
                    block.turn = turn;
                    // The frame's centre on the spread (its axes turned back).
                    let (lx, ly) = (
                        0.5 * (block.frame[0] + block.frame[2]),
                        0.5 * (block.frame[1] + block.frame[3]),
                    );
                    let cx = lx * turn.cos() - ly * turn.sin();
                    let pi = sp
                        .pages
                        .iter()
                        .position(|p| cx >= p.x && cx < p.x + p.w)
                        .unwrap_or(if cx < 0.0 { 0 } else { sp.pages.len() - 1 });
                    blocks_here.push((pi, block));
                }
            }
            read.insert(pdf, page);
        }
        spread_blocks.push(blocks_here);
    }

    // Reading order (before anything keys on a block's index) within each spread: by page, then column, then top.
    for blocks in spread_blocks.iter_mut() {
        blocks.sort_by(|(pa, a), (pb, b)| {
            pa.cmp(pb)
                .then(
                    ((a.frame[0] / 24.0).floor() as i32).cmp(&((b.frame[0] / 24.0).floor() as i32)),
                )
                .then(
                    a.frame[1]
                        .partial_cmp(&b.frame[1])
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
        });
    }

    // One-line frames say nothing of their alignment; the page does.
    for (si, blocks) in spread_blocks.iter_mut().enumerate() {
        for (pi, b) in blocks.iter_mut() {
            let p = &plan[si].pages[*pi];
            if b.turn != 0.0 {
                continue;
            }
            text::place_single_line(b, p.x, p.w, p.left_side);
        }
    }

    // Line-end hyphens: kept where the word is a hyphenated compound.
    for blocks in spread_blocks.iter_mut() {
        for (_, b) in blocks.iter_mut() {
            for p in b.paras.iter_mut() {
                resolve_hyphens(p, &hyphenated_words);
            }
        }
    }

    // Masters: short text blocks that repeat at one place.
    let masters = if recipe.masters() {
        find_masters(&plan, &spread_blocks)
    } else {
        MasterPlan::default()
    };

    // Threads.
    let flat: Vec<(usize, usize)> = spread_blocks
        .iter()
        .enumerate()
        .flat_map(|(si, bs)| (0..bs.len()).map(move |bi| (si, bi)))
        .filter(|(si, bi)| !masters.is_master_block(*si, *bi))
        .collect();
    let mut next: HashMap<(usize, usize), (usize, usize)> = HashMap::new();
    if recipe.threads() {
        let mut taken: BTreeSet<(usize, usize)> = BTreeSet::new();
        for (k, &a) in flat.iter().enumerate() {
            let ba = &spread_blocks[a.0][a.1].1;
            if ba.turn != 0.0 {
                continue;
            }
            let Some(last) = ba.paras.last() else {
                continue;
            };
            if ba.lines.len() < 3 {
                continue;
            }
            let ka = ParaKey::of(last);
            for &b in flat.iter().skip(k + 1) {
                if b.0 > a.0 + 1 {
                    break;
                }
                if taken.contains(&b) {
                    continue;
                }
                let bb = &spread_blocks[b.0][b.1].1;
                if bb.turn != 0.0 {
                    continue;
                }
                let first = &bb.paras[0];
                let kb = ParaKey::of(first);
                let same = ka.font == kb.font
                    && ka.size == kb.size
                    && ka.color == kb.color
                    && (ka.leading == 0 || kb.leading == 0 || ka.leading == kb.leading);
                if !same {
                    continue;
                }
                // Later in reading order: on a later page, or right of it.
                let later_page = b.0 > a.0 || spread_blocks[b.0][b.1].0 > spread_blocks[a.0][a.1].0;
                let right_of = bb.frame[0] > ba.frame[2] - 2.0;
                let below = bb.frame[1] > ba.lines.last().map_or(ba.frame[3], |l| l.baseline);
                if !(later_page || right_of || below) {
                    continue;
                }
                // A paragraph that runs on shows it over two lines at least;
                // a one-line list item that ends unpunctuated does not.
                if last.open_end && last.n_lines >= 2 || first.open_start {
                    next.insert(a, b);
                    taken.insert(b);
                }
                break;
            }
        }
    }
    for [[pa, fa], [pb, fb]] in &recipe.links {
        if let (Some(a), Some(b)) = (
            ordinal(&plan, &spread_blocks, &masters, *pa, *fa),
            ordinal(&plan, &spread_blocks, &masters, *pb, *fb),
        ) {
            next.insert(a, b);
        }
    }
    for [[pa, fa], _] in &recipe.unlinks {
        if let Some(a) = ordinal(&plan, &spread_blocks, &masters, *pa, *fa) {
            next.remove(&a);
        }
    }
    let has_prev: BTreeSet<(usize, usize)> = next.values().copied().collect();

    // Styles over every paragraph (master items included).
    let all_blocks: Vec<&Block> = spread_blocks
        .iter()
        .flat_map(|bs| bs.iter().map(|(_, b)| b))
        .collect();
    let all_paras: Vec<&Para> = spread_blocks
        .iter()
        .flat_map(|bs| bs.iter().flat_map(|(_, b)| b.paras.iter()))
        .collect();
    // A style's name starts with its face's style ("Medium"), and with its
    // family too when the document sets more than one.
    let families: BTreeSet<String> = (0..fonts.names.len() as u32)
        .filter(|f| fonts.counts[*f as usize] > 0)
        .map(|f| fonts.choice(f, recipe).0)
        .collect();
    let font_style = |f: u32| {
        let (fam, sty) = fonts.choice(f, recipe);
        if families.len() > 1 {
            format!("{fam} {sty}")
        } else {
            sty
        }
    };
    let mut styles = styles::infer(&all_paras, &font_style);
    let mut char_uses: Vec<(CharKey, usize)> = Vec::new();
    for p in &all_paras {
        let pk = ParaKey::of(p);
        let key = styles.paragraph.get(&pk).map(|_| pk).unwrap_or(pk);
        for r in &p.runs {
            if let Some(ck) = CharKey::of(r, &key) {
                char_uses.push((ck, r.text.chars().count()));
            }
        }
    }
    styles.character = styles::infer_chars(&char_uses, &font_style);
    spacing(&mut styles, &all_blocks);
    // Tracking per style (the metric fit), before any story is built.
    let tracked: Vec<(ParaKey, f32)> = styles
        .paragraph
        .iter()
        .map(|(k, s)| {
            (
                *k,
                style_tracking(k, &s.name, &styles, &all_blocks, &fonts, recipe, book),
            )
        })
        .collect();
    for (k, t) in tracked {
        if let Some(s) = styles.paragraph.get_mut(&k) {
            s.tracking = recipe.tracking.get(&s.name).copied().unwrap_or(t);
        }
    }
    let metrics = MetricsCache::default();

    // Pass 2: build the document.
    let mut ids = IdGen::new();
    let mut palette = Palette::new();
    let mut stories: Vec<ParsedStory> = Vec::new();
    let mut spreads: Vec<ParsedSpread> = Vec::new();
    let mut page_ids: Vec<String> = Vec::new();
    let mut frame_ids: HashMap<(usize, usize), String> = HashMap::new();
    let mut story_of: HashMap<(usize, usize), usize> = HashMap::new();

    // Master spreads first: their ids are what pages name.
    let mut master_spreads: HashMap<String, ParsedMasterSpread> = HashMap::new();
    let mut master_ids: Vec<String> = Vec::new();
    for (mi, m) in masters.masters.iter().enumerate() {
        let id = format!("pdfm{}", mi + 1);
        let mut spread = Spread {
            self_id: Some(id.clone()),
            item_transform: Some(IDENTITY),
            ..Spread::default()
        };
        let sp = &plan[m.spread];
        for (k, p) in sp.pages.iter().enumerate() {
            spread.pages.push(page_of(&mut ids, p, k, None));
        }
        for &bi in &m.blocks {
            let block = &spread_blocks[m.spread][bi].1;
            let story = story_from(
                &[block],
                &styles,
                &fonts,
                recipe,
                book,
                &metrics,
                &mut palette,
                m.folios.get(&bi).map(Vec::as_slice),
            );
            let sid = ids.id("pdfs");
            let fid = ids.id("pdft");
            let tf = text_frame(&fid, &sid, block, false, 0.0);
            spread.text_frames.push(tf);
            spread
                .frames_in_order
                .push(FrameRef::TextFrame(spread.text_frames.len() - 1));
            stories.push(ParsedStory {
                src: format!("Stories/Story_{sid}.xml"),
                self_id: sid,
                story,
            });
        }
        let name = format!("{}-Master", (b'A' + mi as u8) as char);
        master_spreads.insert(
            id.clone(),
            ParsedMasterSpread {
                src: format!("MasterSpreads/MasterSpread_{id}.xml"),
                self_id: id.clone(),
                spread,
                name: Some(name.clone()),
            },
        );
        master_ids.push(id);
        report.masters.push(name);
    }

    let mut doc_page = 0usize;
    for (si, sp) in plan.iter().enumerate() {
        let sid = ids.id("spread");
        let mut spread = Spread {
            self_id: Some(sid),
            item_transform: Some(IDENTITY),
            ..Spread::default()
        };
        let master = masters
            .spread_master
            .get(&si)
            .map(|&m| master_ids[m].clone());
        for (k, p) in sp.pages.iter().enumerate() {
            doc_page += 1;
            // The PDF page under this page: the one whose span covers it.
            // The PDF page this page starts in: of those it starts at or
            // after, the nearest (a facing spread of two single PDF pages
            // takes the right page from the second, not an offset into the
            // first).
            if let Some(&(pdf, dx)) = sp
                .pdf
                .iter()
                .filter(|(_, dx)| p.x - dx >= -0.5 && p.x - dx < p.w * 1.5)
                .min_by(|a, b| {
                    (p.x - a.1)
                        .partial_cmp(&(p.x - b.1))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            {
                report.page_map.push([(pdf + 1) as f32, p.x - dx, p.w]);
            }
            let mut page = page_of(&mut ids, p, k, master.clone());
            page.name = Some(doc_page.to_string());
            page_ids.push(page.self_id.clone().unwrap_or_default());
            spread.pages.push(page);
        }
        // Graphics: lowered as place-as-vectors lowers them, text left out.
        for &(pdf, dx) in &sp.pdf {
            let Some(vp) = read.get(&pdf) else { continue };
            let items: Vec<Item> = vp
                .items
                .iter()
                .filter(|it| !masters.is_master_graphic(si, pdf, it))
                .cloned()
                .collect();
            let mut low = Lowering::new(
                &mut spread,
                &mut stories,
                &mut palette,
                &mut ids,
                Affine::translate((dx as f64, 0.0)),
                TextPlan {
                    frames: Vec::new(),
                    missing_fonts: Default::default(),
                    mode: TextMode::Skip,
                },
            );
            let roots = low.items(&items);
            for (code, n) in &low.losses {
                *report.losses.entry(code.to_string()).or_default() += n;
            }
            spread.frames_in_order.extend(roots);
        }
        // Text frames, on top.
        for (bi, (_, block)) in spread_blocks[si].iter().enumerate() {
            if masters.is_master_block(si, bi) {
                continue;
            }
            let fid = ids.id("pdft");
            let threaded_on = next.contains_key(&(si, bi));
            let story_ix = if has_prev.contains(&(si, bi)) {
                None
            } else {
                // Head of its story: build the whole chain's story.
                let mut chain = vec![(si, bi)];
                while let Some(n) = next.get(chain.last().unwrap()) {
                    if chain.contains(n) {
                        break;
                    }
                    chain.push(*n);
                }
                let blocks: Vec<&Block> = chain
                    .iter()
                    .map(|(s, b)| &spread_blocks[*s][*b].1)
                    .collect();
                let story = story_from(
                    &blocks,
                    &styles,
                    &fonts,
                    recipe,
                    book,
                    &metrics,
                    &mut palette,
                    None,
                );
                let lines_by_para = para_lines(&blocks, &styles);
                report.paragraphs += story.paragraphs.len();
                report.paragraph_overrides += story
                    .paragraphs
                    .iter()
                    .filter(|p| {
                        p.space_before.is_some()
                            || p.space_after.is_some()
                            || p.first_line_indent.is_some()
                    })
                    .count();
                let st = ids.id("pdfs");
                report.story_lines.insert(st.clone(), lines_by_para);
                stories.push(ParsedStory {
                    src: format!("Stories/Story_{st}.xml"),
                    self_id: st,
                    story,
                });
                let ix = stories.len() - 1;
                for c in &chain {
                    story_of.insert(*c, ix);
                }
                Some(ix)
            };
            let ix = story_ix.or_else(|| story_of.get(&(si, bi)).copied());
            let Some(ix) = ix else { continue };
            let story_id = stories[ix].self_id.clone();
            let page_h = plan[si].pages.first().map_or(0.0, |p| p.h);
            let room = room_below(&spread_blocks[si], bi, page_h);
            let tf = text_frame(&fid, &story_id, block, threaded_on, room);
            frame_ids.insert((si, bi), fid);
            spread.text_frames.push(tf);
            spread
                .frames_in_order
                .push(FrameRef::TextFrame(spread.text_frames.len() - 1));
            report.text_frames += 1;
        }
        spreads.push(ParsedSpread {
            src: format!(
                "Spreads/Spread_{}.xml",
                spread.self_id.clone().unwrap_or_default()
            ),
            spread,
        });
    }
    // Thread links: a frame names the next one.
    for ps in spreads.iter_mut() {
        for tf in ps.spread.text_frames.iter_mut() {
            let Some(id) = tf.self_id.clone() else {
                continue;
            };
            let key = frame_ids.iter().find(|(_, v)| **v == id).map(|(k, _)| *k);
            if let Some(k) = key {
                if let Some(n) = next.get(&k) {
                    tf.next_text_frame = frame_ids.get(n).cloned();
                }
            }
        }
    }
    report.threads = next.len();
    report.stories = stories.len();

    // Swatch names: InDesign's own spelling for an unnamed RGB colour,
    // unless the recipe names it.
    name_swatches(&mut palette, recipe);

    // Styles into the style sheet.
    let mut sheet = paged_model::StyleSheet::default();
    // Each style from its own key (one with a measured leading), not from
    // a one-line paragraph's key folded into it.
    let mut keyed: Vec<(&ParaKey, &styles::ParaStyle)> = styles.paragraph.iter().collect();
    keyed.sort_by_key(|(k, _)| k.leading == 0);
    for (k, s) in keyed {
        let id = format!("ParagraphStyle/{}", s.name);
        if sheet.paragraph_styles.contains_key(&id) {
            continue;
        }
        let name = recipe
            .style_names
            .get(&s.name)
            .cloned()
            .unwrap_or(s.name.clone());
        let (family, fstyle) = fonts.choice(k.font, recipe);
        let tracking = s.tracking;
        let hyphenate = all_paras.iter().any(|p| {
            p.hyphenated
                && styles
                    .paragraph
                    .get(&ParaKey::of(p))
                    .is_some_and(|ps| ps.name == s.name)
        });
        let (sample, page) = spread_blocks
            .iter()
            .enumerate()
            .find_map(|(si, bs)| {
                bs.iter().find_map(|(pi, b)| {
                    b.paras
                        .iter()
                        .find(|p| {
                            styles
                                .paragraph
                                .get(&ParaKey::of(p))
                                .is_some_and(|ps| ps.name == s.name)
                        })
                        .map(|p| {
                            let first_page: usize =
                                plan[..si].iter().map(|sp| sp.pages.len()).sum::<usize>() + pi + 1;
                            (
                                p.runs
                                    .iter()
                                    .map(|r| r.text.as_str())
                                    .collect::<String>()
                                    .chars()
                                    .take(60)
                                    .collect::<String>(),
                                first_page,
                            )
                        })
                })
            })
            .unwrap_or_default();
        report.paragraph_styles.push(StyleReport {
            name: name.clone(),
            inferred: s.name.clone(),
            sample,
            page,
            font: format!("{family} {fstyle}"),
            size: k.size_pt(),
            leading: s.leading,
            tracking,
            paragraphs: all_paras.iter().filter(|p| ParaKey::of(p) == *k).count(),
        });
        sheet.paragraph_styles.insert(
            id.clone(),
            ParagraphStyleDef {
                self_id: id,
                name: Some(name),
                font: Some(family),
                font_style: Some(fstyle),
                point_size: Some(k.size_pt()),
                leading: Some(s.leading),
                fill_color: Some(palette.color_id(rgb01(k.color))),
                tracking: Some(tracking),
                justification: Some(justification(k.align)),
                first_line_indent: Some(k.first_indent as f32 / 10.0),
                left_indent: Some(k.left_indent as f32 / 10.0),
                space_before: Some(s.space_before),
                space_after: Some(s.space_after),
                hyphenation: Some(hyphenate),
                horizontal_scale: {
                    let sc = fonts.scale(k.font, recipe);
                    (sc != 1.0).then_some(sc * 100.0)
                },
                capitalization: k.caps.then(|| "AllCaps".to_string()),
                ..Default::default()
            },
        );
    }
    for (k, name) in &styles.character {
        let id = format!("CharacterStyle/{name}");
        let (family, fstyle) = k.font.map(|f| fonts.choice(f, recipe)).unzip();
        report.character_styles.push(name.clone());
        sheet.character_styles.insert(
            id.clone(),
            CharacterStyleDef {
                self_id: id,
                name: Some(name.clone()),
                font: family,
                font_style: fstyle,
                point_size: k.size.map(|s| s as f32 / 10.0),
                fill_color: k.color.map(|c| palette.color_id(rgb01(c))),
                baseline_shift: k.shift.map(|s| s as f32 / 10.0),
                horizontal_scale: k.hscale.map(|h| h as f32).or_else(|| {
                    k.font
                        .map(|f| fonts.scale(f, recipe))
                        .filter(|s| *s != 1.0)
                        .map(|s| s * 100.0)
                }),
                capitalization: k
                    .caps
                    .map(|c| if c { "AllCaps" } else { "Normal" }.to_string()),
                ..Default::default()
            },
        );
    }
    name_swatches(&mut palette, recipe);
    report.swatches = palette.graphic.colors.len();
    report.fonts = fonts.report(recipe, book);

    // Sections: one, numbered as the folios say.
    let start = masters
        .page_offset
        .map(|o| (1 - o).max(1) as usize)
        .unwrap_or(1);
    let mut sections = vec![Section {
        self_id: "Section/pdf1".to_string(),
        page_start: page_ids.first().cloned(),
        continue_numbering: false,
        start_at: Some(1),
        numbering_style: paged_model::NumberingStyle::Arabic,
        section_prefix: None,
        marker: None,
        include_prefix: false,
    }];
    if start > 1 && start <= page_ids.len() {
        sections.push(Section {
            self_id: "Section/pdf2".to_string(),
            page_start: page_ids.get(start - 1).cloned(),
            continue_numbering: false,
            start_at: Some(1),
            numbering_style: paged_model::NumberingStyle::Arabic,
            section_prefix: None,
            marker: None,
            include_prefix: false,
        });
    }
    for (page, at) in &recipe.sections {
        if let Some(pid) = page_ids.get(page.saturating_sub(1)) {
            sections.retain(|s| s.page_start.as_deref() != Some(pid.as_str()));
            sections.push(Section {
                self_id: format!("Section/pdfr{page}"),
                page_start: Some(pid.clone()),
                continue_numbering: false,
                start_at: Some((*at).max(1) as u32),
                numbering_style: paged_model::NumberingStyle::Arabic,
                section_prefix: None,
                marker: None,
                include_prefix: false,
            });
        }
    }

    report.pages = page_ids.len();
    report.spreads = spreads.len();
    let first = plan.first().and_then(|s| s.pages.first()).cloned();
    let designmap = DesignMap {
        spreads: spreads
            .iter()
            .map(|s| SpreadRef { src: s.src.clone() })
            .collect(),
        stories: stories
            .iter()
            .map(|s| StoryRef { src: s.src.clone() })
            .collect(),
        master_spreads: master_spreads.values().map(|m| m.src.clone()).collect(),
        document_name: Some(recipe.name.clone().unwrap_or_else(|| "Imported PDF".into())),
        sections,
        document_preference: paged_model::DocumentPreference {
            page_width: first.as_ref().map(|p| p.w),
            page_height: first.as_ref().map(|p| p.h),
            facing_pages: Some(plan.iter().any(|s| s.pages.len() == 2)),
            ..Default::default()
        },
        ..Default::default()
    };
    let mut document = Document {
        designmap,
        palette: palette.graphic,
        spreads,
        stories,
        master_spreads,
        frame_for_story: HashMap::new(),
        text_frame_index: HashMap::new(),
        styles: sheet,
        anchors: Vec::new(),
        symbols: Vec::new(),
        comment_threads: Vec::new(),
        people: Vec::new(),
        theme: None,
    };
    compact_images(&mut document);
    document.rebuild_indexes();
    Ok(Reconstruction { document, report })
}

fn rgb01(c: [u8; 3]) -> [f32; 3] {
    [
        c[0] as f32 / 255.0,
        c[1] as f32 / 255.0,
        c[2] as f32 / 255.0,
    ]
}

fn justification(align: u8) -> Justification {
    match align {
        1 => Justification::CenterAlign,
        2 => Justification::RightAlign,
        3 => Justification::LeftJustified,
        _ => Justification::LeftAlign,
    }
}

fn page_of(ids: &mut IdGen, p: &PagePlan, _k: usize, master: Option<String>) -> Page {
    Page {
        self_id: Some(ids.id("page")),
        bounds: Bounds {
            top: 0.0,
            left: 0.0,
            bottom: p.h,
            right: p.w,
        },
        applied_master: master.clone(),
        item_transform: Some([1.0, 0.0, 0.0, 1.0, p.x, 0.0]),
        master_page_transform: master.as_ref().map(|_| IDENTITY),
        override_list: Vec::new(),
        name: None,
        show_master_items: Some(true),
        canvas_origin: None,
    }
}

/// How far below a block's last baseline its column is free of other text,
/// down to the page's foot: the room a story's last frame may take. Other
/// pictures do not count (a frame's text over a picture is how the page
/// sets a caption).
fn room_below(blocks: &[(usize, Block)], bi: usize, page_h: f32) -> f32 {
    let b = &blocks[bi].1;
    if b.turn != 0.0 {
        return 0.0;
    }
    let base = b.lines.last().map_or(0.0, |l| l.baseline);
    let [l, _, r, _] = b.frame;
    let mut room = page_h - base;
    for (j, (_, o)) in blocks.iter().enumerate() {
        let [ol, ot, or, _] = o.frame;
        if j == bi || o.turn != 0.0 || or <= l || ol >= r || ot < base - 0.1 {
            continue;
        }
        room = room.min(ot - base);
    }
    room.max(0.0)
}

/// A block's frame: its box, its first baseline fixed where the PDF has it.
fn text_frame(id: &str, story: &str, b: &Block, threaded_on: bool, room: f32) -> TextFrame {
    let [l, t, r, _] = b.frame;
    let last = b.lines.last().unwrap();
    let lead = b
        .paras
        .last()
        .and_then(|p| p.leading)
        .unwrap_or(1.2 * last.size);
    // A frame the story runs on from ends just under its last line, so
    // the next line goes on; a frame that ends its story keeps a line's
    // room, so a face a little wider than the original does not overset,
    // and up to three where the column below is free of other text.
    let bottom = if threaded_on {
        last.baseline + (0.5 * lead).max(0.3 * last.size)
    } else {
        let free = (room - 0.3 * last.size).min(3.0 * lead);
        last.baseline + (lead + 0.3 * last.size).max(free)
    };
    let (c, s) = (b.turn.cos(), b.turn.sin());
    TextFrame {
        // A turned frame: its bounds in its own axes, turned onto the
        // spread.
        item_transform: Some(if b.turn == 0.0 {
            IDENTITY
        } else {
            [c, s, -s, c, 0.0, 0.0]
        }),
        first_baseline_offset: Some(FirstBaselineOffset::FixedHeight),
        minimum_first_baseline_offset: Some(b.first_baseline),
        inset_spacing: Some([0.0; 4]),
        ..TextFrame::new(
            id.to_string(),
            Some(story.to_string()),
            Bounds {
                top: t,
                left: l,
                bottom,
                right: r,
            },
        )
    }
}

/// The story of a chain of blocks: their paragraphs, a paragraph cut by a
/// frame break joined back into one.
#[allow(clippy::too_many_arguments)]
fn story_from(
    blocks: &[&Block],
    styles: &Styles,
    fonts: &FontTable,
    recipe: &Recipe,
    book: &FontBook,
    metrics: &MetricsCache,
    palette: &mut Palette,
    folio: Option<&[usize]>,
) -> Story {
    let mut story = Story::default();
    // Optical margin alignment where the page hangs its punctuation, sized
    // like InDesign's (the body's point size).
    if let Some(b) = blocks.iter().find(|b| b.optical) {
        story.optical_margin_alignment = true;
        story.optical_margin_size = b.lines.first().map_or(12.0, |l| l.size);
    }
    let mut join_next = false;
    for b in blocks {
        for (pi, p) in b.paras.iter().enumerate() {
            let key = ParaKey::of(p);
            let style = styles.paragraph.get(&key);
            let mut runs: Vec<CharacterRun> = Vec::new();
            // Runs of digits counted across the paragraph's runs.
            let mut digit_k = 0usize;
            for r in &p.runs {
                let ck = CharKey::of(r, &key);
                let mut text = r.text.clone();
                if let Some(page_runs) = folio {
                    text = folio_text(&text, page_runs, &mut digit_k);
                }
                runs.push(CharacterRun {
                    character_style: ck
                        .and_then(|k| styles.character.get(&k))
                        .map(|n| format!("CharacterStyle/{n}")),
                    text,
                    ..Default::default()
                });
            }
            let _ = (fonts, recipe);
            if join_next && pi == 0 {
                if let Some(prev) = story.paragraphs.last_mut() {
                    if let Some(lr) = prev.runs.last_mut() {
                        if !lr.text.ends_with('-') && !lr.text.ends_with(' ') {
                            lr.text.push(' ');
                        }
                    }
                    // The paragraph's own tracking runs on with it.
                    let t = prev.runs.first().and_then(|r| r.tracking);
                    let mut runs = runs;
                    for r in runs.iter_mut() {
                        if r.tracking.is_none() {
                            r.tracking = t;
                        }
                    }
                    prev.runs.extend(runs);
                    continue;
                }
            }
            let mut para = Paragraph {
                paragraph_style: style.map(|s| format!("ParagraphStyle/{}", s.name)),
                runs,
                ..Default::default()
            };
            // A tabbed row takes its block's tab stops, measured from the
            // frame's left edge.
            if !b.tabs.is_empty() && para.runs.iter().any(|r| r.text.contains('\t')) {
                let fl = b.frame[0];
                para.tab_list = b
                    .tabs
                    .iter()
                    .map(|t| paged_model::TabStop {
                        position: (t.x - fl).max(0.0),
                        alignment: Some(
                            if t.right { "RightAlign" } else { "LeftAlign" }.to_string(),
                        ),
                        alignment_character: None,
                        leader: None,
                    })
                    .collect();
            }
            if let Some(s) = style {
                let mut sb = if pi == 0 { 0.0 } else { p.space_before };
                // A one-line paragraph closer to the one above than its
                // style's leading: the page set it on a tighter leading.
                if p.leading.is_none() {
                    if let Some(d) = p.from_prev {
                        if d < s.leading - 0.15 {
                            for r in para.runs.iter_mut() {
                                r.leading = Some(d);
                            }
                            sb = 0.0;
                        } else if pi > 0 {
                            sb = d - s.leading;
                        }
                    }
                }
                // The gap the styles give: the previous paragraph's space
                // after and this one's space before.
                let after_prev = if pi > 0 {
                    b.paras
                        .get(pi - 1)
                        .and_then(|q| styles.paragraph.get(&ParaKey::of(q)))
                        .map_or(0.0, |q| q.space_after)
                } else {
                    0.0
                };
                if pi > 0 && (sb - (after_prev + s.space_before)).abs() > 0.75 {
                    if sb + 0.75 < after_prev {
                        // Tighter than the paragraph above leaves: that
                        // paragraph's space after is what is local here.
                        if let Some(prev) = story.paragraphs.last_mut() {
                            prev.space_after = Some((sb - s.space_before).max(0.0));
                        }
                        if s.space_before > 0.0 && sb < s.space_before {
                            para.space_before = Some(0.0);
                        }
                    } else {
                        para.space_before = Some((sb - after_prev).max(0.0));
                    }
                }
                // A paragraph the recipe tracks on its own.
                let opening: String = para
                    .runs
                    .iter()
                    .map(|r| r.text.as_str())
                    .collect::<String>()
                    .chars()
                    .take(48)
                    .collect();
                let own = recipe.paragraph_tracking.get(&opening).copied();
                if let Some(t) = own {
                    for r in para.runs.iter_mut() {
                        r.tracking = Some(t);
                    }
                }
                // Display type tracked as its own line wants: a heading's
                // letters differ from the style's other headings', and one
                // style tracking cannot fit both (body text is held by the
                // line fit instead).
                if own.is_none() && p.dominant.1 >= 14.0 && recipe.metric_fit() {
                    if let Some(t) = metrics.para_fit(p, &key, fonts, recipe, book) {
                        if (t - s.tracking).abs() > 12.0 {
                            for r in para.runs.iter_mut() {
                                r.tracking = Some(t.round());
                            }
                        }
                    }
                }
                // One-line paragraphs keep the style's leading; a measured
                // leading that differs is local.
                if let Some(l) = p.leading {
                    if (l - s.leading).abs() > 0.15 {
                        for r in para.runs.iter_mut() {
                            r.leading = Some(l);
                        }
                    }
                }
            }
            let _ = palette.graphic.colors.len();
            story.paragraphs.push(para);
        }
        join_next = b.paras.last().is_some_and(|p| p.open_end);
    }
    story
}

/// The runs of digits in `t`, in order.
fn digit_runs(t: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_num = false;
    for ch in t.chars() {
        if ch.is_ascii_digit() {
            if !in_num {
                out.push(String::new());
                in_num = true;
            }
            out.last_mut().unwrap().push(ch);
        } else {
            in_num = false;
        }
    }
    out
}

/// A folio with its page number (the runs of digits `runs` names) as the
/// page-number marker; its other numbers stay.
/// `k` counts the runs of digits before `t` in its paragraph.
fn folio_text(t: &str, runs: &[usize], k: &mut usize) -> String {
    let mut out = String::new();
    let mut in_num = false;
    for ch in t.chars() {
        if ch.is_ascii_digit() {
            if !in_num {
                in_num = true;
                if runs.contains(k) {
                    out.push(AUTO_PAGE_NUMBER_MARKER);
                }
                *k += 1;
            }
            if !runs.contains(&(*k - 1)) {
                out.push(ch);
            }
        } else {
            in_num = false;
            out.push(ch);
        }
    }
    out
}

/// A style's tracking: the PDF's, plus what makes the substitute set the
/// style's lines where the PDF sets them. The mean fit matches the style's
/// text width overall; the line fit then keeps it inside what every line
/// allows — no line may run past its frame, and no soft break may close
/// up because the next word now fits.
fn style_tracking(
    k: &ParaKey,
    name: &str,
    styles: &Styles,
    blocks: &[&Block],
    fonts: &FontTable,
    recipe: &Recipe,
    book: &FontBook,
) -> f32 {
    let mine: Vec<(&Para, &Block)> = blocks
        .iter()
        .flat_map(|b| b.paras.iter().map(move |p| (p, *b)))
        .filter(|(p, _)| {
            styles
                .paragraph
                .get(&ParaKey::of(p))
                .is_some_and(|s| s.name == name)
        })
        .collect();
    let n: usize = mine.iter().map(|(p, _)| p.adv_n).sum();
    let orig: f32 = mine.iter().map(|(p, _)| p.adv_em).sum();
    // The PDF's tracking: its paragraphs' measured letter spacing,
    // weighted by their glyphs, to the nearest 5.
    let base = if n == 0 {
        0.0
    } else {
        let t: f32 = mine
            .iter()
            .map(|(p, _)| p.tracking * p.adv_n as f32)
            .sum::<f32>()
            / n as f32;
        (t / 5.0).round() * 5.0
    };
    if !recipe.metric_fit() || n == 0 {
        return base;
    }
    let (family, style) = fonts.choice(k.font, recipe);
    let caps = |s: &str| {
        if k.caps {
            s.to_uppercase()
        } else {
            s.to_string()
        }
    };
    let chars: String = caps(
        &mine
            .iter()
            .map(|(p, _)| p.chars.as_str())
            .collect::<String>(),
    );
    let all_line_chars: String = mine
        .iter()
        .flat_map(|(p, _)| {
            p.fit_lines
                .iter()
                .map(|l| caps(&l.text) + l.next_word.as_deref().unwrap_or(""))
        })
        .collect();
    let Some(m) = book.metrics(
        &family,
        &style,
        chars.chars().chain(all_line_chars.chars()).chain([' ']),
    ) else {
        return base;
    };
    let scale = fonts.scale(k.font, recipe);
    let sub: f32 = chars
        .chars()
        .map(|c| m.advance(c).unwrap_or(0.5))
        .sum::<f32>()
        * scale;
    let fit = base + (orig - sub) / n as f32 * 1000.0;
    // The other faces the style's lines mix in (a character style's), each
    // measured over the lines' text.
    let mut others: HashMap<u32, Option<fonts::Metrics>> = HashMap::new();
    for (p, _) in &mine {
        for l in &p.fit_lines {
            for (_, f) in &l.segments {
                if *f != k.font && !others.contains_key(f) {
                    let (fam, sty) = fonts.choice(*f, recipe);
                    let probe = all_line_chars.chars().chain([' ']);
                    others.insert(*f, book.metrics(&fam, &sty, probe));
                }
            }
        }
    }

    // The line fit: t ≤ hi (no line overruns its frame), t > lo (no soft
    // break closes up).
    let width_em = |l: &text::FitLine, extra: Option<&str>| -> (f32, usize) {
        let mut w = 0.0;
        let mut n = 0;
        for (seg, f) in &l.segments {
            let mm = if *f == k.font {
                Some(&m)
            } else {
                others.get(f).and_then(|o| o.as_ref())
            };
            let sc = fonts.scale(*f, recipe);
            for c in caps(seg).chars() {
                w += mm
                    .and_then(|mm| mm.advance(c))
                    .or_else(|| m.advance(c))
                    .unwrap_or(0.5)
                    * sc;
                n += 1;
            }
        }
        if let Some(e) = extra {
            for c in caps(e).chars() {
                w += m.advance(c).unwrap_or(0.5) * scale;
                n += 1;
            }
        }
        (w, n)
    };
    // Justified lines are set by the composer's spacing, not by their
    // natural width (a justified line squeezes its word spaces): they take
    // the mean fit alone. Ragged lines bound it — robustly, by the 3rd and
    // 97th percentile of what the lines allow, so one odd line (a frame
    // read too narrow) does not set a whole style's tracking.
    let mut his: Vec<f32> = Vec::new();
    let mut los: Vec<f32> = Vec::new();
    for (p, b) in &mine {
        if p.align == text::Align::Justify {
            continue;
        }
        let [fl, _, fr, _] = b.frame;
        for l in &p.fit_lines {
            let avail = match p.align {
                text::Align::Center => fr - fl,
                text::Align::Right => l.x1 - fl,
                _ => fr - l.x0,
            };
            let (w, cnt) = width_em(l, None);
            if cnt == 0 || l.size <= 0.0 {
                continue;
            }
            let per = cnt as f32 * l.size / 1000.0;
            his.push((avail - 0.75 - w * l.size) / per);
            if let Some(nw) = &l.next_word {
                let (w2, cnt2) = width_em(l, Some(&format!(" {nw}")));
                let per2 = cnt2 as f32 * l.size / 1000.0;
                los.push((avail + 0.75 - w2 * l.size) / per2);
            }
        }
    }
    let pct = |v: &mut Vec<f32>, q: f32| -> Option<f32> {
        if v.is_empty() {
            return None;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let i = ((v.len() - 1) as f32 * q).round() as usize;
        Some(v[i])
    };
    let hi = pct(&mut his, 0.03).unwrap_or(f32::MAX);
    let lo = pct(&mut los, 0.97).unwrap_or(f32::MIN);
    if std::env::var_os("PAGED_PDF_DEBUG_FIT").is_some() {
        eprintln!(
            "fit {:?} {family} {style} {}: base {base} fit {fit:.1} lo {lo:.1} hi {hi:.1}",
            k.size_pt(),
            k.caps
        );
    }
    let t = if hi == f32::MAX {
        fit
    } else if lo < hi {
        let margin = ((hi - lo) * 0.25).min(5.0);
        fit.clamp(lo + margin, hi - margin)
    } else {
        // No tracking satisfies every line: never run past a frame.
        hi
    };
    t.clamp(-150.0, 250.0).round()
}

fn name_swatches(palette: &mut Palette, recipe: &Recipe) {
    for (id, c) in palette.graphic.colors.iter_mut() {
        if c.name.is_some() {
            continue;
        }
        let key = id.trim_start_matches("Color/").to_string();
        let name = recipe.swatch_names.get(&key).cloned().unwrap_or_else(|| {
            let v = &c.value;
            format!("R={} G={} B={}", v[0] as u8, v[1] as u8, v[2] as u8)
        });
        c.name = Some(name);
    }
}

/// The fonts the page names, interned.
#[derive(Default)]
struct FontTable {
    /// The file's fonts by the interpreter's key.
    faces: HashMap<u128, vectors::ir::FontFace>,
    /// Embedded font programs by the same key, and the text their glyph
    /// names give (for glyphs the PDF maps to none), read once each.
    programs: HashMap<u128, Vec<u8>>,
    named: HashMap<(u128, u32), Option<String>>,
    names: Vec<String>,
    index: HashMap<String, u32>,
    counts: Vec<usize>,
    chars: Vec<BTreeSet<char>>,
}

impl FontTable {
    fn intern(&mut self, name: &str) -> u32 {
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        let i = self.names.len() as u32;
        self.names.push(name.to_string());
        self.index.insert(name.to_string(), i);
        self.counts.push(0);
        self.chars.push(BTreeSet::new());
        i
    }
    /// The family and style the recipe sets this font in, or what its
    /// PostScript name spells.
    fn choice(&self, f: u32, recipe: &Recipe) -> (String, String) {
        let ps = &self.names[f as usize];
        if let Some(c) = recipe.fonts.get(ps) {
            return (c.family.clone(), c.style.clone());
        }
        let (fam, sty) = match ps.split_once('-') {
            Some((a, b)) => (a.to_string(), b.to_string()),
            None => (ps.clone(), "Regular".to_string()),
        };
        let fam = fam.trim_end_matches("MT").trim_end_matches("PS");
        (split_camel(fam), split_camel(&sty))
    }
    /// The horizontal scale the recipe sets this font at (1 = 100 %).
    fn scale(&self, f: u32, recipe: &Recipe) -> f32 {
        recipe
            .fonts
            .get(&self.names[f as usize])
            .and_then(|c| c.scale)
            .map_or(1.0, |s| s / 100.0)
    }

    fn report(&self, recipe: &Recipe, book: &FontBook) -> Vec<FontReport> {
        let mut out = Vec::new();
        for (i, ps) in self.names.iter().enumerate() {
            let (family, style) = self.choice(i as u32, recipe);
            let available = book.has_family(&family);
            let missing = book
                .metrics(&family, &style, self.chars[i].iter().copied())
                .map(|m| m.missing.into_iter().collect::<String>())
                .unwrap_or_default();
            out.push(FontReport {
                postscript_name: ps.clone(),
                family,
                style,
                available,
                missing_chars: missing,
                glyphs: self.counts[i],
            });
        }
        out
    }
}

fn split_camel(s: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

/// Walk the page's items for its glyphs (not those inside a soft mask).
fn collect_glyphs(
    items: &[Item],
    dx: f32,
    fonts: &mut FontTable,
    out: &mut BTreeMap<i32, Vec<Glyph>>,
    order: &mut u32,
    in_mask: bool,
) {
    for it in items {
        match it {
            Item::Group(g) => {
                collect_glyphs(&g.items, dx, fonts, out, order, in_mask);
            }
            Item::Text(t) if !in_mask && (!t.rotated || t.turn.is_some()) && !t.outline => {
                let turn = if t.rotated {
                    t.turn.unwrap_or(0.0)
                } else {
                    0.0
                };
                let turn_key = (turn / std::f32::consts::PI * 1800.0).round() as i32;
                let turn = turn_key as f32 / 1800.0 * std::f32::consts::PI;
                let (cos, sin) = (turn.cos(), turn.sin());
                *order += 1;
                let face = t
                    .font_key
                    .and_then(|k| fonts.faces.get(&k).cloned())
                    .or_else(|| t.face.clone().filter(|f| !f.postscript_name.is_empty()));
                let name = face
                    .as_ref()
                    .map(|f| f.postscript_name.clone())
                    .or_else(|| t.font_name.clone().map(|n| vectors::strip_subset(&n)))
                    .unwrap_or_else(|| "Unknown".to_string());
                let font = fonts.intern(&name);
                let color = match &t.fill {
                    Some(Paint::Solid { rgb, .. }) => {
                        rgb.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
                    }
                    _ => [0, 0, 0],
                };
                for g in &t.glyphs {
                    fonts.counts[font as usize] += 1;
                    // No text from the PDF: the font program's name for the
                    // glyph (`s.sc` is an s).
                    let from_name = match (g.text.is_empty(), g.gid, t.font_key) {
                        (true, Some(gid), Some(key)) => {
                            let programs = &fonts.programs;
                            fonts
                                .named
                                .entry((key, gid))
                                .or_insert_with(|| {
                                    programs
                                        .get(&key)
                                        .and_then(|p| vectors::glyph_name_text(p, gid))
                                })
                                .clone()
                        }
                        _ => None,
                    };
                    // A "space" with ink is a symbol its font maps to a
                    // space (InDesign's separators): a small dot on the
                    // x-height's middle is a middle dot, a larger one a bullet.
                    let mut g = g.clone();
                    if let Some(t) = from_name {
                        g.text = t;
                    }
                    if !g.text.is_empty() && g.text.trim().is_empty() {
                        if let (Some(top), Some(bottom)) = (g.ink_top, g.ink_bottom) {
                            let h = top - bottom;
                            let mid = 0.5 * (top + bottom);
                            if h > 0.02 && (0.1..0.7).contains(&mid) {
                                g.text = if h < 0.3 { "·" } else { "•" }.to_string();
                            }
                        }
                    }
                    // x-height letters only: their ink says capital or not.
                    let caps = match (g.text.chars().next(), g.ink_top) {
                        (Some(c), Some(top))
                            if g.text.chars().count() == 1 && "acemnorsuvwxz".contains(c) =>
                        {
                            Some(top > 0.6)
                        }
                        _ => None,
                    };
                    for ch in g.text.chars() {
                        fonts.chars[font as usize].insert(ch);
                    }
                    // Into the run's own axes: along its reading direction
                    // and down its lines.
                    let (px, py) = (g.x + dx, g.y);
                    out.entry(turn_key).or_default().push(Glyph {
                        text: g.text.clone(),
                        x: px * cos + py * sin,
                        y: -px * sin + py * cos,
                        adv: g.advance.unwrap_or(0.5 * g.size),
                        has_adv: g.advance.is_some(),
                        size: g.size,
                        hscale: g.hscale,
                        font,
                        color,
                        order: *order,
                        caps,
                    });
                }
            }
            _ => {}
        }
    }
}

/// Pair the PDF's pages into spreads.
fn plan_spreads(sizes: &[(usize, f32, f32)], layout: recipe::Layout) -> Vec<SpreadPlan> {
    use recipe::Layout;
    let Some(&(_, w0, _)) = sizes.first() else {
        return Vec::new();
    };
    let page_w = sizes.iter().map(|s| s.1).fold(f32::MAX, f32::min);
    let wide = sizes.iter().filter(|s| s.1 > page_w * 1.8).count();
    let layout = match layout {
        Layout::Auto if wide * 2 >= sizes.len() && wide > 0 => Layout::Spreads,
        Layout::Auto => Layout::Single,
        l => l,
    };
    let _ = w0;
    let mut out = Vec::new();
    match layout {
        Layout::Spreads => {
            let last = sizes.len() - 1;
            for (k, &(pdf, w, h)) in sizes.iter().enumerate() {
                if w > page_w * 1.8 {
                    let half = 0.5 * w;
                    out.push(SpreadPlan {
                        pages: vec![
                            PagePlan {
                                x: -half,
                                w: half,
                                h,
                                left_side: true,
                            },
                            PagePlan {
                                x: 0.0,
                                w: half,
                                h,
                                left_side: false,
                            },
                        ],
                        pdf: vec![(pdf, -half)],
                    });
                } else if k == last && k > 0 {
                    out.push(SpreadPlan {
                        pages: vec![PagePlan {
                            x: -w,
                            w,
                            h,
                            left_side: true,
                        }],
                        pdf: vec![(pdf, -w)],
                    });
                } else {
                    out.push(SpreadPlan {
                        pages: vec![PagePlan {
                            x: 0.0,
                            w,
                            h,
                            left_side: false,
                        }],
                        pdf: vec![(pdf, 0.0)],
                    });
                }
            }
        }
        Layout::Facing => {
            let mut k = 0;
            while k < sizes.len() {
                let (pdf, w, h) = sizes[k];
                if k == 0 {
                    out.push(SpreadPlan {
                        pages: vec![PagePlan {
                            x: 0.0,
                            w,
                            h,
                            left_side: false,
                        }],
                        pdf: vec![(pdf, 0.0)],
                    });
                    k += 1;
                } else if k + 1 < sizes.len() {
                    let (pdf2, w2, h2) = sizes[k + 1];
                    out.push(SpreadPlan {
                        pages: vec![
                            PagePlan {
                                x: -w,
                                w,
                                h,
                                left_side: true,
                            },
                            PagePlan {
                                x: 0.0,
                                w: w2,
                                h: h2,
                                left_side: false,
                            },
                        ],
                        pdf: vec![(pdf, -w), (pdf2, 0.0)],
                    });
                    k += 2;
                } else {
                    out.push(SpreadPlan {
                        pages: vec![PagePlan {
                            x: -w,
                            w,
                            h,
                            left_side: true,
                        }],
                        pdf: vec![(pdf, -w)],
                    });
                    k += 1;
                }
            }
        }
        Layout::Single | Layout::Auto => {
            for &(pdf, w, h) in sizes {
                out.push(SpreadPlan {
                    pages: vec![PagePlan {
                        x: 0.0,
                        w,
                        h,
                        left_side: false,
                    }],
                    pdf: vec![(pdf, 0.0)],
                });
            }
        }
    }
    out
}

/// Which blocks and graphics are master items, and which master each
/// spread takes.
#[derive(Default)]
struct MasterPlan {
    masters: Vec<MasterDef>,
    /// Spread → master index.
    spread_master: HashMap<usize, usize>,
    /// (spread, block) pairs drawn by a master.
    blocks: BTreeSet<(usize, usize)>,
    /// Page number − document page index, as the folios say.
    page_offset: Option<i32>,
}

struct MasterDef {
    /// The spread whose blocks the master copies.
    spread: usize,
    blocks: Vec<usize>,
    /// Those of them that carry the page number, with which of their runs
    /// of digits it is (the run that changes from page to page); a number
    /// every page repeats (an issue, a year) stays text.
    folios: BTreeMap<usize, Vec<usize>>,
}

impl MasterPlan {
    fn is_master_block(&self, si: usize, bi: usize) -> bool {
        self.blocks.contains(&(si, bi))
    }
    fn is_master_graphic(&self, _si: usize, _pdf: usize, _it: &Item) -> bool {
        false
    }
}

/// A block's place-and-content signature: side, position, text with its
/// digits as `#`, face and size.
fn signature(page: &PagePlan, b: &Block) -> Option<String> {
    if b.lines.len() > 2 || b.paras.len() > 2 || b.turn != 0.0 {
        return None;
    }
    let t: String = b
        .lines
        .iter()
        .map(|l| l.text())
        .collect::<Vec<_>>()
        .join("|");
    if t.chars().count() > 80 || t.trim().is_empty() {
        return None;
    }
    let norm: String = t
        .chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .collect::<String>();
    // A run of digits is one number however many it has.
    let mut squashed = String::new();
    for c in norm.chars() {
        if c == '#' && squashed.ends_with('#') {
            continue;
        }
        squashed.push(c);
    }
    let (font, size, color) = b.lines[0].dominant();
    // Position relative to the page; folios that sit on the outside edge
    // move with their width, so a right-aligned folio is keyed on its right.
    let x = if t.chars().all(|c| c.is_ascii_digit() || c.is_whitespace()) && !page.left_side {
        b.lines[0].x1 - page.x
    } else {
        b.lines[0].x0 - page.x
    };
    Some(format!(
        "{}|{:.0}|{:.0}|{}|{}|{:.1}|{:?}",
        page.left_side as u8,
        (x / 8.0).round(),
        (b.lines[0].baseline / 8.0).round(),
        squashed,
        font,
        size,
        color
    ))
}

fn find_masters(plan: &[SpreadPlan], spread_blocks: &[Vec<(usize, Block)>]) -> MasterPlan {
    // How many pages carry each signature.
    let mut count: HashMap<String, usize> = HashMap::new();
    let mut sigs: Vec<Vec<(usize, String)>> = Vec::new();
    for (si, blocks) in spread_blocks.iter().enumerate() {
        let mut here = Vec::new();
        for (bi, (pi, b)) in blocks.iter().enumerate() {
            if let Some(s) = signature(&plan[si].pages[*pi], b) {
                here.push((bi, s));
            }
        }
        if std::env::var_os("PAGED_PDF_DEBUG").is_some() {
            for (bi, (pi, b)) in blocks.iter().enumerate() {
                eprintln!(
                    "spread {si} page {pi} block {bi} frame {:?} sig {:?} text {:?}",
                    b.frame.map(|v| v.round()),
                    here.iter().find(|(x, _)| *x == bi).map(|(_, s)| s),
                    b.lines
                        .iter()
                        .map(|l| l.text())
                        .collect::<Vec<_>>()
                        .join(" / ")
                        .chars()
                        .take(60)
                        .collect::<String>()
                );
            }
        }
        let uniq: BTreeSet<&String> = here.iter().map(|(_, s)| s).collect();
        for s in uniq {
            *count.entry(s.clone()).or_default() += 1;
        }
        sigs.push(here);
    }
    let n_spreads = plan.len().max(1);
    let threshold = (n_spreads as f32 * 0.2).ceil().max(3.0) as usize;
    let repeat: BTreeSet<String> = count
        .into_iter()
        .filter(|(_, c)| *c >= threshold)
        .map(|(s, _)| s)
        .collect();
    // Spreads grouped by the set of repeated items they carry.
    let mut variants: BTreeMap<Vec<String>, Vec<usize>> = BTreeMap::new();
    for (si, here) in sigs.iter().enumerate() {
        let mut set: Vec<String> = here
            .iter()
            .filter(|(_, s)| repeat.contains(s))
            .map(|(_, s)| s.clone())
            .collect();
        set.sort();
        set.dedup();
        if !set.is_empty() {
            variants.entry(set).or_default().push(si);
        }
    }
    let mut plan_out = MasterPlan::default();
    let mut ranked: Vec<(Vec<String>, Vec<usize>)> = variants.into_iter().collect();
    ranked.sort_by_key(|b| std::cmp::Reverse(b.1.len()));
    for (set, spreads) in ranked {
        if spreads.len() < 2 || plan_out.masters.len() >= 8 {
            continue;
        }
        // The master copies a spread with both pages when it can.
        let model = *spreads
            .iter()
            .max_by_key(|&&s| plan[s].pages.len())
            .unwrap();
        let blocks: Vec<usize> = sigs[model]
            .iter()
            .filter(|(_, s)| set.contains(s))
            .map(|(bi, _)| *bi)
            .collect();
        // A repeated item's number is a page number when it differs from
        // spread to spread.
        let numbers_of = |s: usize, sig: &str| -> Option<Vec<String>> {
            sigs[s].iter().find(|(_, x)| x == sig).and_then(|(bi, _)| {
                let runs = digit_runs(&spread_blocks[s][*bi].1.lines[0].text());
                (!runs.is_empty()).then_some(runs)
            })
        };
        let folios: BTreeMap<usize, Vec<usize>> = sigs[model]
            .iter()
            .filter(|(_, sig)| set.contains(sig))
            .filter_map(|(bi, sig)| {
                let all: Vec<Vec<String>> =
                    spreads.iter().filter_map(|&s| numbers_of(s, sig)).collect();
                let n = all.first()?.len();
                let varying: Vec<usize> = (0..n)
                    .filter(|&k| {
                        let values: BTreeSet<&String> =
                            all.iter().filter_map(|runs| runs.get(k)).collect();
                        values.len() >= 2
                    })
                    .collect();
                (!varying.is_empty()).then_some((*bi, varying))
            })
            .collect();
        let mi = plan_out.masters.len();
        plan_out.masters.push(MasterDef {
            spread: model,
            blocks,
            folios,
        });
        for &s in &spreads {
            plan_out.spread_master.insert(s, mi);
            for (bi, sig) in &sigs[s] {
                if set.contains(sig) {
                    plan_out.blocks.insert((s, *bi));
                }
            }
        }
    }
    // The folio's offset: the number a page shows minus its index.
    let mut offsets: HashMap<i32, usize> = HashMap::new();
    let mut doc_page = 0i32;
    for (si, sp) in plan.iter().enumerate() {
        for (pi, _) in sp.pages.iter().enumerate() {
            doc_page += 1;
            for (bi, (bpi, b)) in spread_blocks[si].iter().enumerate() {
                if *bpi != pi || !plan_out.blocks.contains(&(si, bi)) {
                    continue;
                }
                let t = b.lines[0].text();
                if let Ok(v) = t.trim().parse::<i32>() {
                    *offsets.entry(v - doc_page).or_default() += 1;
                }
            }
        }
    }
    plan_out.page_offset = offsets.into_iter().max_by_key(|(_, c)| *c).map(|(o, _)| o);
    plan_out
}

/// The block a recipe ordinal names: 1-based document page, 0-based frame
/// in reading order on it.
fn ordinal(
    plan: &[SpreadPlan],
    spread_blocks: &[Vec<(usize, Block)>],
    masters: &MasterPlan,
    page: usize,
    frame: usize,
) -> Option<(usize, usize)> {
    let mut doc_page = 0;
    for (si, sp) in plan.iter().enumerate() {
        for pi in 0..sp.pages.len() {
            doc_page += 1;
            if doc_page == page {
                return spread_blocks[si]
                    .iter()
                    .enumerate()
                    .filter(|(bi, (bpi, _))| *bpi == pi && !masters.is_master_block(si, *bi))
                    .nth(frame)
                    .map(|(bi, _)| (si, bi));
            }
        }
    }
    None
}

/// The gap a paragraph keeps above it beyond its leading, as the page shows
/// it (a one-line paragraph tighter than its style's leading keeps none).
fn effective_space(p: &Para, style_leading: f32) -> f32 {
    match (p.leading, p.from_prev) {
        (None, Some(d)) if d < style_leading - 0.15 => 0.0,
        (None, Some(d)) => d - style_leading,
        _ => p.space_before,
    }
}

/// Space before and after per style. A style's space before is the gap
/// between two of its paragraphs; a style that is never followed by
/// itself (a heading) leaves its air as space after: the gap to the next
/// paragraph beyond that one's space before.
fn spacing(styles: &mut Styles, blocks: &[&Block]) {
    let name_of = |p: &Para| {
        styles
            .paragraph
            .get(&ParaKey::of(p))
            .map(|s| s.name.clone())
    };
    let lead_of = |p: &Para| {
        styles
            .paragraph
            .get(&ParaKey::of(p))
            .map_or(1.2 * p.dominant.1, |s| s.leading)
    };
    let mut same: HashMap<String, Vec<f32>> = HashMap::new();
    for b in blocks {
        for w in b.paras.windows(2) {
            if let (Some(a), Some(c)) = (name_of(&w[0]), name_of(&w[1])) {
                if a == c {
                    same.entry(a)
                        .or_default()
                        .push(effective_space(&w[1], lead_of(&w[1])));
                }
            }
        }
    }
    let median = |mut v: Vec<f32>| -> f32 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v.get(v.len() / 2).copied().unwrap_or(0.0).max(0.0)
    };
    let before: HashMap<String, f32> = same
        .into_iter()
        .map(|(k, v)| (k, (median(v) * 4.0).round() / 4.0))
        .collect();
    let mut after: HashMap<String, Vec<f32>> = HashMap::new();
    for b in blocks {
        for w in b.paras.windows(2) {
            if let (Some(a), Some(c)) = (name_of(&w[0]), name_of(&w[1])) {
                if a != c && !before.contains_key(&a) {
                    let sb = before.get(&c).copied().unwrap_or(0.0);
                    after
                        .entry(a)
                        .or_default()
                        .push(effective_space(&w[1], lead_of(&w[1])) - sb);
                }
            }
        }
    }
    let after: HashMap<String, f32> = after
        .into_iter()
        .map(|(k, v)| (k, (median(v) * 4.0).round() / 4.0))
        .collect();
    // A style never set twice in a row (a sub-heading between paragraphs)
    // takes its space before from the gap above it, beyond what the
    // paragraph above leaves.
    let mut before2: HashMap<String, Vec<f32>> = HashMap::new();
    for b in blocks {
        for w in b.paras.windows(2) {
            if let (Some(a), Some(c)) = (name_of(&w[0]), name_of(&w[1])) {
                if a != c && !before.contains_key(&c) {
                    let sa = after.get(&a).copied().unwrap_or(0.0);
                    before2
                        .entry(c)
                        .or_default()
                        .push(effective_space(&w[1], lead_of(&w[1])) - sa);
                }
            }
        }
    }
    let mut before = before;
    for (k, v) in before2 {
        before.insert(k, (median(v) * 4.0).round() / 4.0);
    }
    for s in styles.paragraph.values_mut() {
        s.space_before = before.get(&s.name).copied().unwrap_or(0.0);
        s.space_after = after.get(&s.name).copied().unwrap_or(0.0);
    }
}

/// Opaque photographs as JPEG. The reader decodes an image the engine
/// cannot take as it stands (an ICC-based JPEG, a CMYK one) to a lossless
/// PNG; for a photograph that is several times the bytes for nothing the
/// eye sees. Images with transparency, and small ones (line art, icons),
/// stay PNG.
fn compact_images(doc: &mut Document) {
    fn compact(bytes: &mut Vec<u8>) {
        if bytes.len() < 48 * 1024 || !bytes.starts_with(b"\x89PNG") {
            return;
        }
        let Ok(img) = image::load_from_memory_with_format(bytes, image::ImageFormat::Png) else {
            return;
        };
        if img.width() * img.height() < 128 * 128 {
            return;
        }
        let rgb = if img.color().has_alpha() {
            let rgba = img.to_rgba8();
            if rgba.pixels().any(|p| p[3] != 255) {
                return;
            }
            image::DynamicImage::ImageRgba8(rgba).to_rgb8()
        } else {
            img.to_rgb8()
        };
        let mut out = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
        if rgb.write_with_encoder(enc).is_ok() && out.len() < bytes.len() {
            *bytes = out;
        }
    }
    for sp in doc.spreads.iter_mut() {
        for r in sp.spread.rectangles.iter_mut() {
            if let Some(b) = r.image_bytes.as_mut() {
                compact(b);
            }
        }
    }
}

/// The hyphenated compounds a line spells in its middle: `"a two-way
/// street"` → `two-way`.
fn mid_line_compounds(line: &str) -> Vec<String> {
    let words: Vec<&str> = line.split_whitespace().collect();
    let n = words.len();
    words
        .iter()
        .enumerate()
        .filter(|(i, w)| *i + 1 < n && w.contains('-') && !w.ends_with('-'))
        .map(|(_, w)| {
            w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-')
                .to_lowercase()
        })
        .filter(|w| w.chars().filter(|c| *c == '-').count() >= 1)
        .collect()
}

/// Resolve the line-end hyphen markers of a paragraph's runs: a hyphen
/// where the joined word is one the document spells hyphenated, nothing
/// (hyphenation) otherwise.
fn resolve_hyphens(p: &mut Para, compounds: &BTreeSet<String>) {
    let full: String = p.runs.iter().map(|r| r.text.as_str()).collect();
    if !full.contains(text::HYPHEN_JOIN) {
        return;
    }
    // Decide per marker on the whole text, then rewrite the runs.
    let chars: Vec<char> = full.chars().collect();
    let mut keep: Vec<bool> = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        if *c != text::HYPHEN_JOIN {
            continue;
        }
        let is_word = |c: &char| c.is_alphanumeric() || *c == '-' || *c == text::HYPHEN_JOIN;
        let mut a = i;
        while a > 0 && is_word(&chars[a - 1]) {
            a -= 1;
        }
        let mut b = i + 1;
        while b < chars.len() && is_word(&chars[b]) {
            b += 1;
        }
        let word: String = chars[a..b]
            .iter()
            .map(|c| if *c == text::HYPHEN_JOIN { '-' } else { *c })
            .collect::<String>()
            .to_lowercase();
        // A word the document hyphenates mid-line, or one already
        // hyphenated elsewhere in itself ("state-of-the-art"), keeps it.
        let other_hyphens = chars[a..b].contains(&'-');
        keep.push(compounds.contains(&word) || other_hyphens);
    }
    let mut k = 0;
    for r in p.runs.iter_mut() {
        if !r.text.contains(text::HYPHEN_JOIN) {
            continue;
        }
        let mut out = String::with_capacity(r.text.len());
        for c in r.text.chars() {
            if c == text::HYPHEN_JOIN {
                if keep.get(k).copied().unwrap_or(false) {
                    out.push('-');
                }
                k += 1;
            } else {
                out.push(c);
            }
        }
        r.text = out;
    }
}

/// Substitute faces' metrics per document font, measured once over every
/// character the document sets in that font.
#[derive(Default)]
struct MetricsCache {
    map: std::cell::RefCell<HashMap<u32, Option<std::rc::Rc<fonts::Metrics>>>>,
}

impl MetricsCache {
    fn get(
        &self,
        font: u32,
        fonts: &FontTable,
        recipe: &Recipe,
        book: &FontBook,
    ) -> Option<std::rc::Rc<fonts::Metrics>> {
        self.map
            .borrow_mut()
            .entry(font)
            .or_insert_with(|| {
                let (fam, sty) = fonts.choice(font, recipe);
                let chars: Vec<char> = fonts.chars[font as usize]
                    .iter()
                    .flat_map(|c| std::iter::once(*c).chain(c.to_uppercase()))
                    .chain([' '])
                    .collect();
                book.metrics(&fam, &sty, chars).map(std::rc::Rc::new)
            })
            .clone()
    }

    /// The tracking that sets this paragraph at its own width in the
    /// substitute face.
    fn para_fit(
        &self,
        p: &Para,
        k: &ParaKey,
        fonts: &FontTable,
        recipe: &Recipe,
        book: &FontBook,
    ) -> Option<f32> {
        if p.adv_n == 0 {
            return None;
        }
        let m = self.get(k.font, fonts, recipe, book)?;
        let chars = if k.caps {
            p.chars.to_uppercase()
        } else {
            p.chars.clone()
        };
        let sub: f32 = chars
            .chars()
            .map(|c| m.advance(c).unwrap_or(0.5))
            .sum::<f32>()
            * fonts.scale(k.font, recipe);
        let base = (p.tracking / 5.0).round() * 5.0;
        Some((base + (p.adv_em - sub) / p.adv_n as f32 * 1000.0).clamp(-150.0, 250.0))
    }
}

/// Mark the runs set in a font the recipe draws as outlines.
fn mark_outlined(
    items: &mut [Item],
    faces: &HashMap<u128, vectors::ir::FontFace>,
    outline: &[String],
) {
    for it in items.iter_mut() {
        match it {
            Item::Group(g) => mark_outlined(&mut g.items, faces, outline),
            Item::Text(t) => {
                let name = t
                    .font_key
                    .and_then(|k| faces.get(&k).map(|f| f.postscript_name.clone()))
                    .or_else(|| t.face.as_ref().map(|f| f.postscript_name.clone()))
                    .or_else(|| t.font_name.clone().map(|n| vectors::strip_subset(&n)));
                if name.is_some_and(|n| outline.contains(&n)) {
                    t.outline = true;
                }
            }
            _ => {}
        }
    }
}

/// Debug: the page's item tree, one line per item.
fn dump_items(items: &[Item], depth: usize) {
    for it in items {
        let pad = "  ".repeat(depth);
        match it {
            Item::Group(g) => {
                eprintln!(
                    "{pad}group clip={} opacity={} blend={:?} mask={} items={}",
                    g.clip.is_some(),
                    g.opacity,
                    g.blend,
                    g.mask.as_ref().map_or("none".to_string(), |m| format!(
                        "{} ({} items)",
                        m.mask_type,
                        m.items.len()
                    )),
                    g.items.len()
                );
                if let Some(m) = &g.mask {
                    eprintln!("{pad}  [mask]");
                    dump_items(&m.items, depth + 2);
                }
                dump_items(&g.items, depth + 1);
            }
            Item::Path(p) => eprintln!(
                "{pad}path fill={:?} opacity={} blend={:?}",
                p.fill.as_ref().map(|f| match f {
                    Paint::Solid { rgb, opacity } => format!("solid {rgb:?} a{opacity}"),
                    Paint::Linear { .. } => "linear".into(),
                    Paint::Radial { .. } => "radial".into(),
                    Paint::Mesh { .. } => "mesh".into(),
                }),
                p.opacity,
                p.blend
            ),
            Item::Image(i) => eprintln!(
                "{pad}image {}x{} opacity={} {:?}",
                i.width_px, i.height_px, i.opacity, i.transform
            ),
            Item::Text(t) => eprintln!(
                "{pad}text {:?}",
                t.text.chars().take(30).collect::<String>()
            ),
        }
    }
}

/// A solid rectangle seen through an image's luminosity (a soft glow or
/// fade behind a caption, as InDesign exports a feathered frame) as one
/// image: the rectangle's colour, the mask's luminance as its alpha,
/// clipped to the rectangle. Exact, and it renders wherever an image does.
fn bake_image_masks(items: &mut [Item]) {
    use crate::vectors::ir::{ClipIr, GroupItem, ImageItem};
    use base64::Engine as _;
    for it in items.iter_mut() {
        let Item::Group(g) = it else { continue };
        bake_image_masks(&mut g.items);
        let Some(mask) = &g.mask else { continue };
        if mask.mask_type != "luminosity" || mask.backdrop_rgb.is_some() || g.clip.is_some() {
            continue;
        }
        let ([Item::Image(mi)], [Item::Path(p)]) = (mask.items.as_slice(), g.items.as_slice())
        else {
            continue;
        };
        let Some(Paint::Solid { rgb, opacity: fo }) = &p.fill else {
            continue;
        };
        if p.stroke.is_some() || crate::lower::axis_rect(&p.contours).is_none() {
            continue;
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(mi.data_b64.as_bytes())
        else {
            continue;
        };
        let Ok(img) = image::load_from_memory(&bytes) else {
            continue;
        };
        let lum = img.to_luma8();
        let alpha_scale = fo * p.opacity * g.opacity;
        let [r, gg, b] = rgb.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
        let mut rgba = image::RgbaImage::new(lum.width(), lum.height());
        for (x, y, px) in lum.enumerate_pixels() {
            let a = (px[0] as f32 * alpha_scale).round().clamp(0.0, 255.0) as u8;
            rgba.put_pixel(x, y, image::Rgba([r, gg, b, a]));
        }
        let mut png = Vec::new();
        if image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .is_err()
        {
            continue;
        }
        let baked = Item::Image(ImageItem {
            transform: mi.transform,
            width_px: lum.width(),
            height_px: lum.height(),
            data_b64: base64::engine::general_purpose::STANDARD.encode(&png),
            mime: "image/png",
            opacity: 1.0,
            blend: p.blend.or(g.blend),
        });
        *it = Item::Group(GroupItem {
            items: vec![baked],
            clip: Some(ClipIr {
                contours: p.contours.clone(),
                fill_rule: "nonzero",
            }),
            opacity: 1.0,
            blend: None,
            isolated: false,
            knockout: false,
            mask: None,
        });
    }
}

/// A chain's paragraphs as the story holds them (a paragraph a frame break
/// cut is one), each with the lines the PDF sets it in and its style's
/// inferred name.
fn para_lines(blocks: &[&Block], styles: &Styles) -> Vec<(u32, String, String)> {
    let mut out: Vec<(u32, String, String)> = Vec::new();
    let mut join_next = false;
    for b in blocks {
        for (pi, p) in b.paras.iter().enumerate() {
            let name = styles
                .paragraph
                .get(&ParaKey::of(p))
                .map(|s| s.name.clone())
                .unwrap_or_default();
            if join_next && pi == 0 {
                if let Some(last) = out.last_mut() {
                    last.0 += p.n_lines as u32;
                    continue;
                }
            }
            let opening: String = p
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>()
                .chars()
                .take(48)
                .collect();
            out.push((p.n_lines as u32, name, opening));
        }
        join_next = b.paras.last().is_some_and(|p| p.open_end);
    }
    out
}
