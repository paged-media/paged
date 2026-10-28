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

//! # docx-import — Tier-0 `.docx` → `docx-core`
//!
//! Reads the OPC package (`paged-ooxml`), resolves the main document + styles
//! parts through the `_rels` graph, parses them with the `ooxmlsdk` typed DOM,
//! and maps the enum-vector trees into the clean `docx-core` model. A **scanner,
//! not a validator**: a missing styles part yields an empty catalog; a body it
//! cannot fully understand yields the runs it can; only an unreadable container or
//! an unparseable main document part is a hard error.

use docx_core::{
    Block, BodyHeld, BreakKind, CellPath, DocxDocument, Float, FloatPosition, FloatWrap,
    HeaderFooter, HeaderFooterKind, HeaderFooterRef, HeaderFooterSet, Image, Justification,
    LineRule, LineSpacing, ListKind, ListMarker, MergeField, Note, NoteProps, NoteRestart,
    ParaProps, Paragraph, ParagraphHeld, PictureLook, PositionalTab, PtabAlignment, PtabBase, Run,
    RunBreak, RunProps, RunSource, RunSymbol, Section, SectionKind, Style, StyleCatalog, StyleKind,
    TabStop, VertAlign, LINE_BREAK, SOFT_HYPHEN,
};
use paged_ooxml::ooxmlsdk::schemas::schemas_microsoft_com_office_word as w10;
use paged_ooxml::ooxmlsdk::schemas::schemas_microsoft_com_vml as vml;
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_drawingml_2006_main as aml;
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_drawingml_2006_wordprocessing_drawing as wp;
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_wordprocessingml_2006_main as wml;
use paged_ooxml::ooxmlsdk::simple_type::{
    DecimalNumberOrPercentValue, HpsMeasureValue, MeasurementOrPercentValue, OnOffValue,
    SignedHpsMeasureValue, SignedTwipsMeasureValue, TwipsMeasureValue,
};
use paged_ooxml::{parse_root, part_dir, rels, resolve_target, OoxmlError, OpcPackage};

mod theme;
use docx_core::Theme;

/// Import context threaded through the body mapping: the numbering resolver and
/// the image (media-part) resolver.
struct ImportCtx<'a> {
    numbering: NumberingTable,
    images: ImageResolver<'a>,
    /// Paragraph styles' own `w:numPr` and `basedOn`, for a paragraph whose
    /// list comes from its style (Word applies a style's numbering).
    style_lists: StyleLists,
    /// Legacy VML drawings (`w:pict`) that are not an inline picture, and so
    /// are not placed (floating shapes, text boxes, org charts…).
    unplaced_vml: std::cell::Cell<u32>,
    /// Tracked changes, hidden runs and content controls met so far (the
    /// body's are what the document reports).
    held: std::cell::Cell<BodyHeld>,
    /// Character styles that hide their text (`w:vanish` on, through
    /// `basedOn`).
    hidden_styles: std::collections::HashSet<String>,
    /// The document theme, for theme colours and fonts (doc ADR 609).
    theme: Option<Theme>,
    /// The DrawingML look of the pictures of the part being mapped, by
    /// `wp:docPr/@id`, in document order (doc ADR 618): read once through
    /// the shared DrawingML reader, which works on the element tree.
    looks: std::cell::RefCell<Looks>,
}

/// Pictures' looks by `wp:docPr/@id`, each id's in document order (an id
/// Word should keep unique may repeat in a hand-made file).
type Looks = std::collections::HashMap<u32, std::collections::VecDeque<Option<PictureLook>>>;

impl ImportCtx<'_> {
    /// Read the looks of the pictures in `part` (the part about to be
    /// mapped), replacing the previous part's.
    fn load_looks(&self, part: &[u8]) {
        *self.looks.borrow_mut() = picture_looks(part);
    }

    /// The look of the next picture whose `wp:docPr` is `id`.
    fn take_look(&self, id: u32) -> Option<Box<PictureLook>> {
        let look = self.looks.borrow_mut().get_mut(&id)?.pop_front()??;
        Some(Box::new(look))
    }

    fn bump(&self, f: impl FnOnce(&mut BodyHeld)) {
        let mut h = self.held.get();
        f(&mut h);
        self.held.set(h);
    }

    /// Whether a run is hidden text: its own `w:vanish`, else its character
    /// style's.
    fn hidden(&self, r: &wml::Run, style_id: Option<&str>) -> bool {
        let own = r.run_properties.as_deref().and_then(|p| {
            p.run_properties_choice.iter().find_map(|c| match c {
                wml::RunPropertiesChoice::Vanish(v) => Some(on(&v.val)),
                _ => None,
            })
        });
        own.unwrap_or_else(|| style_id.is_some_and(|id| self.hidden_styles.contains(id)))
    }
}

/// The character styles whose text is hidden: `w:vanish` on in the style or,
/// where the style says nothing, in the style it is based on.
fn hidden_styles(styles: &wml::Styles) -> std::collections::HashSet<String> {
    let mut own = std::collections::HashMap::new();
    for s in &styles.style {
        if !matches!(s.r#type, Some(wml::StyleValues::Character)) {
            continue;
        }
        let Some(id) = s.style_id.clone() else {
            continue;
        };
        let vanish = s
            .style_run_properties
            .as_deref()
            .and_then(|r| r.vanish.as_ref())
            .map(|v| on(&v.val));
        own.insert(id, (vanish, s.based_on.as_ref().map(|b| b.val.clone())));
    }
    own.keys()
        .filter(|id| {
            let mut at = Some((*id).clone());
            // `basedOn` chains are short; the bound stops a cycle.
            for _ in 0..16 {
                let Some((vanish, based_on)) = at.as_ref().and_then(|a| own.get(a)) else {
                    return false;
                };
                if let Some(v) = vanish {
                    return *v;
                }
                at = based_on.clone();
            }
            false
        })
        .cloned()
        .collect()
}

/// A paragraph style's own `w:numPr` (`numId`, `ilvl`) and its `basedOn`.
type StyleList = (Option<(i32, u8)>, Option<String>);

/// Per paragraph style: its [`StyleList`], plus the document's default
/// paragraph style (`w:default="1"`).
#[derive(Default)]
struct StyleLists {
    styles: std::collections::HashMap<String, StyleList>,
    default_style: Option<String>,
}

impl StyleLists {
    fn from_styles(styles: &wml::Styles) -> Self {
        let mut out = StyleLists::default();
        for s in &styles.style {
            if !matches!(s.r#type, Some(wml::StyleValues::Paragraph) | None) {
                continue;
            }
            let Some(id) = s.style_id.clone() else {
                continue;
            };
            if s.default.is_some() && on(&s.default) {
                out.default_style = Some(id.clone());
            }
            let num = s
                .style_paragraph_properties
                .as_deref()
                .and_then(|pp| pp.numbering_properties.as_deref())
                .and_then(|np| {
                    let id = np.numbering_id.as_ref()?.val;
                    let lvl = np
                        .numbering_level_reference
                        .as_ref()
                        .map_or(0, |l| l.val as u8);
                    Some((id, lvl))
                });
            out.styles
                .insert(id, (num, s.based_on.as_ref().map(|b| b.val.clone())));
        }
        out
    }

    /// The numbering a paragraph in `style` inherits: the nearest style in
    /// its chain (the default paragraph style when it names none) with a
    /// `w:numPr`. `numId` 0 there means "no list" and ends the walk.
    fn inherited(&self, style: Option<&str>) -> Option<(i32, u8)> {
        let mut next = style.or(self.default_style.as_deref());
        for _ in 0..32 {
            let (num, based_on) = self.styles.get(next?)?;
            if let Some(n) = num {
                return (n.0 != 0).then_some(*n);
            }
            next = based_on.as_deref();
        }
        None
    }
}

impl ImportCtx<'_> {
    /// A `w:hyperlink`'s target: the external URL its `r:id` resolves to, or
    /// `#anchor` for an internal bookmark.
    fn hyperlink_target(&self, h: &wml::Hyperlink) -> Option<String> {
        if let Some(id) = &h.id {
            if let Some(rel) = self.images.rels.by_id(id) {
                return Some(rel.target.clone());
            }
        }
        h.anchor.as_ref().map(|a| format!("#{a}"))
    }
}

/// Resolves a drawing's `r:embed` rel id to its media bytes + MIME type.
struct ImageResolver<'a> {
    /// The main document part's relationships (where `r:embed` ids resolve).
    rels: rels::Relationships,
    /// The OPC package (holds the `word/media/…` byte parts).
    package: &'a OpcPackage,
    /// The directory of the main document part (for resolving media targets).
    base_dir: String,
}

impl ImageResolver<'_> {
    fn resolve(&self, embed_id: &str) -> Option<(Vec<u8>, String)> {
        let rel = self.rels.by_id(embed_id)?;
        if rel
            .target_mode
            .as_deref()
            .is_some_and(|m| m.eq_ignore_ascii_case("External"))
        {
            return None; // external (linked) images aren't embedded bytes
        }
        let target = resolve_target(&self.base_dir, &rel.target);
        let bytes = self.package.part(&target)?.to_vec();
        Some((bytes, mime_for(&target)))
    }
}

/// A media part name -> MIME type (by extension).
fn mime_for(part_name: &str) -> String {
    let ext = part_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Import a `.docx`/`.dotx` package into the semantic model.
pub fn import_docx(bytes: &[u8]) -> Result<DocxDocument, OoxmlError> {
    import_docx_with_package(bytes).map(|(doc, _pkg, _main)| doc)
}

/// Import a `.docx`/`.dotx` and ALSO return the retained [`OpcPackage`] and the
/// main-document part name — the two things M2 edited save-back needs to patch
/// `word/document.xml` in place and re-emit every other part verbatim. The plain
/// [`import_docx`] discards both.
pub fn import_docx_with_package(
    bytes: &[u8],
) -> Result<(DocxDocument, OpcPackage, String), OoxmlError> {
    let pkg = OpcPackage::read(bytes)?;

    // Resolve the main document part via the root relationships.
    let main_part = main_document_part(&pkg).unwrap_or_else(|| "word/document.xml".to_string());
    let doc_bytes = pkg.require(&main_part)?;
    let wml_doc: wml::Document = parse_root(&main_part, doc_bytes)?;

    // Body mapping borrows the package (image resolution); scope the borrow so
    // the package can be moved into the return value once mapping is done.
    // settings.xml (optional): even/odd headers and the document-wide note
    // numbering.
    let settings = settings_part(&pkg, &main_part)
        .and_then(|name| pkg.part(&name).map(|b| (name, b)))
        .and_then(|(name, b)| parse_root::<wml::Settings>(&name, b).ok());
    // The theme part (optional), with settings' colour mapping (doc ADR
    // 609): theme colours and fonts resolve through it everywhere below.
    let theme = theme::theme_part(&pkg, &main_part)
        .and_then(|name| pkg.part(&name))
        .and_then(theme::parse_theme)
        .map(|mut t| {
            if let Some(m) = settings
                .as_ref()
                .and_then(|s| s.color_scheme_mapping.as_ref())
            {
                t.mapping = theme::color_mapping(m);
            }
            t
        });

    // The styles part is optional.
    let wml_styles = styles_part(&pkg, &main_part)
        .and_then(|name| pkg.part(&name).map(|b| (name, b)))
        .and_then(|(name, b)| parse_root::<wml::Styles>(&name, b).ok());
    let styles = wml_styles
        .as_ref()
        .map(|w| map_styles(w, theme.as_ref()))
        .unwrap_or_default();
    let style_lists = wml_styles
        .as_ref()
        .map(StyleLists::from_styles)
        .unwrap_or_default();

    // numbering.xml (optional) -> a resolver from (numId, level) to a marker.
    let numbering = numbering_part(&pkg, &main_part)
        .and_then(|name| pkg.part(&name).map(|b| (name, b)))
        .and_then(|(name, b)| parse_root::<wml::Numbering>(&name, b).ok())
        .map(|n| NumberingTable::from_numbering(&n))
        .unwrap_or_default();

    let even_and_odd_headers = settings
        .as_ref()
        .and_then(|s| s.even_and_odd_headers.as_ref())
        .is_some_and(|e| on(&e.val));
    let footnote_props = settings
        .as_ref()
        .and_then(|s| s.footnote_document_wide_properties.as_deref())
        .map(|f| {
            note_props(
                f.footnote_position.as_ref().map(|p| p.val.to_string()),
                f.numbering_format.as_ref(),
                f.numbering_start.as_ref(),
                f.numbering_restart.as_ref(),
            )
        })
        .unwrap_or_default();
    let endnote_props = settings
        .as_ref()
        .and_then(|s| s.endnote_document_wide_properties.as_deref())
        .map(|e| {
            note_props(
                e.endnote_position.as_ref().map(|p| p.val.to_string()),
                e.numbering_format.as_ref(),
                e.numbering_start.as_ref(),
                e.numbering_restart.as_ref(),
            )
        })
        .unwrap_or_default();

    let add_paragraph_spacing = settings.as_ref().is_some_and(|s| {
        s.compatibility.iter().any(|c| {
            c.do_not_use_html_paragraph_auto_spacing
                .as_ref()
                .is_some_and(|f| on(&f.val))
        })
    });
    let auto_hyphenation = settings
        .as_ref()
        .and_then(|s| s.auto_hyphenation.as_ref())
        .is_some_and(|a| on(&a.val));

    let (body, sections, notes, headers_footers, unplaced_vml, held) = {
        let doc_rels = pkg
            .part(&rels::rels_part_name(&main_part))
            .map(rels::Relationships::parse)
            .unwrap_or_default();
        let ctx = ImportCtx {
            numbering,
            style_lists,
            unplaced_vml: std::cell::Cell::new(0),
            held: std::cell::Cell::new(BodyHeld::default()),
            hidden_styles: wml_styles.as_ref().map(hidden_styles).unwrap_or_default(),
            theme: theme.clone(),
            looks: std::cell::RefCell::new(picture_looks(doc_bytes)),
            images: ImageResolver {
                rels: doc_rels,
                package: &pkg,
                base_dir: part_dir(&main_part).to_string(),
            },
        };
        let (body, mut sections, refs) = wml_doc
            .body
            .as_deref()
            .map(|b| map_body(b, &ctx))
            .unwrap_or_default();
        // The body's held constructs (notes and headers are not placed).
        let held = ctx.held.get();
        let notes = map_notes(&pkg, &main_part, &ctx);
        let headers_footers = map_headers_footers(&pkg, &main_part, &mut sections, &refs, &ctx);
        (
            body,
            sections,
            notes,
            headers_footers,
            ctx.unplaced_vml.get(),
            held,
        )
    };

    let doc = DocxDocument {
        notes,
        headers_footers,
        even_and_odd_headers,
        footnote_props,
        endnote_props,
        body,
        styles,
        sections,
        auto_hyphenation,
        add_paragraph_spacing,
        unplaced_vml,
        held,
        theme,
    };
    Ok((doc, pkg, main_part))
}

/// Parse the footnotes + endnotes parts (both optional) into `docx-core` notes.
/// Word ships two SEPARATOR pseudo-notes (`w:type` separator /
/// continuationSeparator, conventionally ids -1 and 0) that carry no real
/// content — those are skipped.
fn map_notes(pkg: &OpcPackage, main_part: &str, ctx: &ImportCtx) -> Vec<Note> {
    fn is_separator(t: &Option<wml::FootnoteEndnoteValues>) -> bool {
        matches!(
            t,
            Some(wml::FootnoteEndnoteValues::Separator)
                | Some(wml::FootnoteEndnoteValues::ContinuationSeparator)
                | Some(wml::FootnoteEndnoteValues::ContinuationNotice)
        )
    }
    let mut out = Vec::new();

    if let Some(name) = note_part(pkg, main_part, "/footnotes") {
        if let Some(parsed) = pkg.part(&name).and_then(|b| {
            ctx.load_looks(b);
            parse_root::<wml::Footnotes>(&name, b).ok()
        }) {
            for f in &parsed.footnote {
                if is_separator(&f.r#type) {
                    continue;
                }
                out.push(Note {
                    id: f.id,
                    endnote: false,
                    paragraphs: note_paragraphs(&f.footnote_choice, ctx),
                });
            }
        }
    }
    if let Some(name) = note_part(pkg, main_part, "/endnotes") {
        if let Some(parsed) = pkg.part(&name).and_then(|b| {
            ctx.load_looks(b);
            parse_root::<wml::Endnotes>(&name, b).ok()
        }) {
            for e in &parsed.endnote {
                if is_separator(&e.r#type) {
                    continue;
                }
                out.push(Note {
                    id: e.id,
                    endnote: true,
                    paragraphs: endnote_paragraphs(&e.endnote_choice, ctx),
                });
            }
        }
    }
    out
}

/// A footnote's body paragraphs. Cell provenance is `None` and the body ordinal
/// is 0: note content lives in its own part, so it is not save-back patchable.
fn note_paragraphs(choices: &[wml::FootnoteChoice], ctx: &ImportCtx) -> Vec<Paragraph> {
    choices
        .iter()
        .filter_map(|c| match c {
            wml::FootnoteChoice::Paragraph(p) => Some(map_paragraph(p, ctx, 0, None)),
            _ => None,
        })
        .collect()
}

/// An endnote's body paragraphs (the endnote choice is a distinct generated enum).
fn endnote_paragraphs(choices: &[wml::EndnoteChoice], ctx: &ImportCtx) -> Vec<Paragraph> {
    choices
        .iter()
        .filter_map(|c| match c {
            wml::EndnoteChoice::Paragraph(p) => Some(map_paragraph(p, ctx, 0, None)),
            _ => None,
        })
        .collect()
}

/// One `w:headerReference` / `w:footerReference`: footer?, kind, `r:id`.
type HeaderFooterRefIn = (bool, HeaderFooterKind, String);

/// A section's header/footer references, as written.
fn section_refs(sp: &wml::SectionProperties) -> Vec<HeaderFooterRefIn> {
    fn kind(v: wml::HeaderFooterValues) -> HeaderFooterKind {
        match v {
            wml::HeaderFooterValues::Default => HeaderFooterKind::Default,
            wml::HeaderFooterValues::First => HeaderFooterKind::First,
            wml::HeaderFooterValues::Even => HeaderFooterKind::Even,
        }
    }
    sp.section_properties_choice
        .iter()
        .map(|c| match c {
            wml::SectionPropertiesChoice::HeaderReference(h) => {
                (false, kind(h.r#type), h.id.clone())
            }
            wml::SectionPropertiesChoice::FooterReference(f) => {
                (true, kind(f.r#type), f.id.clone())
            }
        })
        .collect()
}

/// Parse every header/footer part ANY section references (thoughts ADR 033;
/// each section's references live on its own `sectPr`), once per part, and
/// record on each section which part it shows per kind. A section without a
/// reference of a kind shows the previous section's (Word's rule, ECMA-376
/// §17.10.5); in the first section that is a blank one.
fn map_headers_footers(
    pkg: &OpcPackage,
    main_part: &str,
    sections: &mut [Section],
    refs: &[Vec<HeaderFooterRefIn>],
    ctx: &ImportCtx,
) -> Vec<HeaderFooter> {
    let rels = pkg
        .part(&rels::rels_part_name(main_part))
        .map(rels::Relationships::parse)
        .unwrap_or_default();
    let base = part_dir(main_part);
    let mut out: Vec<HeaderFooter> = Vec::new();
    let mut prev = (HeaderFooterSet::default(), HeaderFooterSet::default());
    for (k, section) in sections.iter_mut().enumerate() {
        // Inherited unless the section says otherwise.
        let inherit = |r: Option<HeaderFooterRef>| {
            r.map(|r| HeaderFooterRef {
                inherited: true,
                ..r
            })
        };
        let mut headers = HeaderFooterSet {
            default: inherit(prev.0.default),
            first: inherit(prev.0.first),
            even: inherit(prev.0.even),
        };
        let mut footers = HeaderFooterSet {
            default: inherit(prev.1.default),
            first: inherit(prev.1.first),
            even: inherit(prev.1.even),
        };
        for (footer, kind, id) in refs.get(k).map(Vec::as_slice).unwrap_or_default() {
            let Some(rel) = rels.by_id(id) else { continue };
            let name = resolve_target(base, &rel.target);
            let index = match out.iter().position(|h| h.part == name) {
                Some(i) => i,
                None => {
                    let Some(bytes) = pkg.part(&name) else {
                        continue;
                    };
                    out.push(HeaderFooter {
                        footer: *footer,
                        kind: Some(
                            match kind {
                                HeaderFooterKind::Default => "default",
                                HeaderFooterKind::First => "first",
                                HeaderFooterKind::Even => "even",
                            }
                            .to_string(),
                        ),
                        part: name.clone(),
                        section: k,
                        paragraphs: header_footer_paragraphs(*footer, &name, bytes, ctx),
                    });
                    out.len() - 1
                }
            };
            let set = if *footer { &mut footers } else { &mut headers };
            let slot = match kind {
                HeaderFooterKind::Default => &mut set.default,
                HeaderFooterKind::First => &mut set.first,
                HeaderFooterKind::Even => &mut set.even,
            };
            *slot = Some(HeaderFooterRef {
                index,
                inherited: false,
            });
        }
        section.headers = headers;
        section.footers = footers;
        prev = (headers, footers);
    }
    out
}

/// A header (`w:hdr`) or footer (`w:ftr`) part's paragraphs. Not save-back
/// patchable yet (the body ordinal is 0, no cell provenance).
fn header_footer_paragraphs(
    footer: bool,
    name: &str,
    bytes: &[u8],
    ctx: &ImportCtx,
) -> Vec<Paragraph> {
    ctx.load_looks(bytes);
    if footer {
        parse_root::<wml::Footer>(name, bytes)
            .ok()
            .map(|f| {
                f.footer_choice
                    .iter()
                    .filter_map(|c| match c {
                        wml::FooterChoice::Paragraph(p) => Some(map_paragraph(p, ctx, 0, None)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        parse_root::<wml::Header>(name, bytes)
            .ok()
            .map(|h| {
                h.header_choice
                    .iter()
                    .filter_map(|c| match c {
                        wml::HeaderChoice::Paragraph(p) => Some(map_paragraph(p, ctx, 0, None)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// The settings part name (via the main document's `.rels`).
fn settings_part(pkg: &OpcPackage, main_part: &str) -> Option<String> {
    let rels_bytes = pkg.part(&rels::rels_part_name(main_part))?;
    let rels = rels::Relationships::parse(rels_bytes);
    let r = rels.by_type_suffix("/settings")?;
    Some(resolve_target(part_dir(main_part), &r.target))
}

/// `w:footnotePr` / `w:endnotePr` children -> [`NoteProps`].
fn note_props(
    pos: Option<String>,
    fmt: Option<&wml::NumberingFormat>,
    start: Option<&wml::NumberingStart>,
    restart: Option<&wml::NumberingRestart>,
) -> NoteProps {
    NoteProps {
        num_fmt: fmt.map(|f| f.val.to_string()),
        num_start: start.map(|s| u32::from(s.val)),
        num_restart: restart.map(|r| match r.val {
            wml::RestartNumberValues::Continuous => NoteRestart::Continuous,
            wml::RestartNumberValues::EachSection => NoteRestart::EachSection,
            wml::RestartNumberValues::EachPage => NoteRestart::EachPage,
        }),
        pos,
    }
}

/// A notes part name (via the main document's `.rels`), by relationship suffix.
fn note_part(pkg: &OpcPackage, main_part: &str, suffix: &str) -> Option<String> {
    let rels_bytes = pkg.part(&rels::rels_part_name(main_part))?;
    let rels = rels::Relationships::parse(rels_bytes);
    let r = rels.by_type_suffix(suffix)?;
    Some(resolve_target(part_dir(main_part), &r.target))
}

/// The numbering part name (via the main document's `.rels`).
fn numbering_part(pkg: &OpcPackage, main_part: &str) -> Option<String> {
    let rels_bytes = pkg.part(&rels::rels_part_name(main_part))?;
    let rels = rels::Relationships::parse(rels_bytes);
    let r = rels.by_type_suffix("/numbering")?;
    Some(resolve_target(part_dir(main_part), &r.target))
}

/// The main document part name (via `_rels/.rels` `officeDocument`).
pub fn main_document_part(pkg: &OpcPackage) -> Option<String> {
    let root_rels = pkg.part("_rels/.rels")?;
    let rels = rels::Relationships::parse(root_rels);
    let r = rels.by_type_suffix("/officeDocument")?;
    Some(resolve_target("", &r.target))
}

/// The styles part name (via the main document's `.rels`).
pub fn styles_part(pkg: &OpcPackage, main_part: &str) -> Option<String> {
    let rels_name = rels::rels_part_name(main_part);
    let rels_bytes = pkg.part(&rels_name)?;
    let rels = rels::Relationships::parse(rels_bytes);
    let r = rels.by_type_suffix("/styles")?;
    Some(resolve_target(part_dir(main_part), &r.target))
}

// ---------------------------------------------------------------------------
// Body

/// A resolver from a paragraph's `(numId, ilvl)` to a [`ListMarker`], built once
/// from `numbering.xml`. `numId -> abstractNumId -> level -> (numFmt, lvlText)`.
#[derive(Default)]
struct NumberingTable {
    /// numId -> abstractNumId.
    num_to_abstract: std::collections::HashMap<i32, i32>,
    /// abstractNumId -> (level -> (format, lvlText, the level's w:ind)).
    abstract_levels: std::collections::HashMap<i32, std::collections::HashMap<u8, Level>>,
}

/// One numbering level: its format, `w:lvlText`, indents, and its marker's
/// face and size (half-points).
type Level = (
    wml::NumberFormatValues,
    Option<String>,
    LevelIndent,
    (Option<String>, Option<u32>),
);

/// A numbering level's own `w:pPr/w:ind` (twips): left, first line, hanging.
type LevelIndent = (Option<i32>, Option<i32>, Option<i32>);

impl NumberingTable {
    fn from_numbering(n: &wml::Numbering) -> Self {
        let mut t = NumberingTable::default();
        for a in &n.abstract_num {
            let mut levels = std::collections::HashMap::new();
            for lvl in &a.level {
                let ilvl = lvl.level_index as u8;
                let fmt = lvl
                    .numbering_format
                    .as_ref()
                    .map(|f| f.val)
                    .unwrap_or(wml::NumberFormatValues::Decimal);
                let text = lvl.level_text.as_ref().and_then(|t| t.val.clone());
                let indent = lvl
                    .previous_paragraph_properties
                    .as_deref()
                    .and_then(|pp| pp.indentation.as_ref())
                    .map_or((None, None, None), |ind| {
                        (
                            ind.left.as_ref().or(ind.start.as_ref()).and_then(stwips),
                            ind.first_line.as_ref().and_then(twips_u),
                            ind.hanging.as_ref().and_then(stwips),
                        )
                    });
                let face =
                    lvl.numbering_symbol_run_properties
                        .as_deref()
                        .map_or((None, None), |rp| {
                            (
                                rp.run_fonts.first().and_then(|f| f.ascii.clone()),
                                rp.font_size.as_ref().and_then(|s| hps(&s.val)),
                            )
                        });
                levels.insert(ilvl, (fmt, text, indent, face));
            }
            t.abstract_levels.insert(a.abstract_number_id, levels);
        }
        for inst in &n.numbering_instance {
            t.num_to_abstract
                .insert(inst.number_id, inst.abstract_num_id.val);
        }
        t
    }

    fn resolve(&self, num_id: i32, level: u8) -> Option<ListMarker> {
        let abstract_id = self.num_to_abstract.get(&num_id)?;
        let (fmt, text, (left, first, hanging), (marker_font, marker_half_pts)) =
            self.abstract_levels.get(abstract_id)?.get(&level)?;
        let marker = |kind, bullet_char, number_format| ListMarker {
            kind,
            num_id,
            level,
            bullet_char,
            number_format,
            left_indent: *left,
            first_line_indent: *first,
            hanging_indent: *hanging,
            marker_font: marker_font.clone(),
            marker_half_pts: *marker_half_pts,
        };
        Some(match fmt {
            wml::NumberFormatValues::Bullet => marker(
                ListKind::Bullet,
                Some(normalize_bullet(text.as_deref())),
                None,
            ),
            wml::NumberFormatValues::None => {
                marker(ListKind::Bullet, Some("\u{2022}".into()), None)
            }
            other => marker(
                ListKind::Numbered,
                None,
                Some(numbering_sample(other).to_string()),
            ),
        })
    }
}

/// Normalize a `w:lvlText` bullet glyph to a renderable Unicode character.
/// Word bullets are usually Symbol/Wingdings code points; map the common ones to
/// their Unicode equivalents so they render in the paragraph font.
fn normalize_bullet(text: Option<&str>) -> String {
    let first = text.and_then(|s| s.chars().next());
    match first {
        Some('\u{F0B7}') | Some('\u{2022}') | None => "\u{2022}".into(), // •
        Some('\u{F0A7}') | Some('\u{25AA}') => "\u{25AA}".into(),        // ▪
        Some('\u{F06E}') | Some('\u{25A0}') => "\u{25A0}".into(),        // ■
        Some('o') | Some('\u{25E6}') => "\u{25E6}".into(),               // ◦
        Some('\u{F0D8}') | Some('\u{2023}') => "\u{2023}".into(),        // ‣
        Some(c) if (c as u32) >= 0xF000 => "\u{2022}".into(),            // other symbol-font glyph
        Some(c) => c.to_string(),
    }
}

/// Word `w:numFmt` -> the IDML numbering-format sample the engine's
/// `format_number` reads (it keys off the head before the first comma).
fn numbering_sample(fmt: &wml::NumberFormatValues) -> &'static str {
    use wml::NumberFormatValues as F;
    match fmt {
        F::UpperRoman => "I, II, III, IV...",
        F::LowerRoman => "i, ii, iii, iv...",
        F::UpperLetter => "A, B, C, D...",
        F::LowerLetter => "a, b, c, d...",
        _ => "1, 2, 3, 4...",
    }
}

/// The body's blocks, its sections, and each section's header/footer
/// references (parallel to the sections).
type MappedBody = (Vec<Block>, Vec<Section>, Vec<Vec<HeaderFooterRefIn>>);

fn map_body(body: &wml::Body, ctx: &ImportCtx) -> MappedBody {
    let mut walk = BodyWalk {
        ctx,
        blocks: Vec::new(),
        para_ord: 0,
        table_ord: 0,
        sections: Vec::new(),
        refs: Vec::new(),
        section_start: 0,
        pending_bookmarks: Vec::new(),
    };
    for choice in &body.body_choice {
        match choice {
            wml::BodyChoice::BookmarkStart(b) => walk.pending_bookmarks.push(b.name.clone()),
            wml::BodyChoice::Paragraph(p) => walk.paragraph(p, false),
            wml::BodyChoice::Table(t) => walk.table(t),
            wml::BodyChoice::SdtBlock(sdt) => walk.content_control(sdt),
            _ => {}
        }
    }
    if let Some(sp) = body.section_properties.as_deref() {
        let mut section = map_section(sp);
        section.first_block = walk.section_start;
        walk.sections.push(section);
        walk.refs.push(section_refs(sp));
    }
    (walk.blocks, walk.sections, walk.refs)
}

/// The body walk: blocks in reading order, with the ordinals the save-back
/// patcher locates on.
struct BodyWalk<'c, 'a> {
    ctx: &'c ImportCtx<'a>,
    blocks: Vec<Block>,
    // Ordinal among the direct `<w:p>` children of `<w:body>` — the save-back
    // patcher's paragraph key. Only body paragraphs advance it (tables, a
    // paragraph inside a content control and any dropped body child do not),
    // matching "the Nth `<w:p>` under `<w:body>`".
    para_ord: u32,
    // Ordinal among the body-level `<w:tbl>`s (cell provenance): a direct child
    // of `<w:body>`, or one inside a body-level block content control, which
    // the patcher counts alike.
    table_ord: u32,
    // ADR 029 — a paragraph whose `pPr` carries a `sectPr` ENDS a section
    // (that `sectPr` describes the section it closes); the body-level
    // `sectPr` describes the last one.
    sections: Vec<Section>,
    refs: Vec<Vec<HeaderFooterRefIn>>,
    section_start: usize,
    // Bookmarks started between paragraphs belong to the next one.
    pending_bookmarks: Vec<String>,
}

impl BodyWalk<'_, '_> {
    fn paragraph(&mut self, p: &wml::Paragraph, in_content_control: bool) {
        let mut para = map_paragraph(p, self.ctx, self.para_ord, None);
        para.held.in_content_control = in_content_control;
        if !in_content_control {
            self.para_ord += 1;
        }
        if !self.pending_bookmarks.is_empty() {
            self.pending_bookmarks.append(&mut para.bookmarks);
            para.bookmarks = std::mem::take(&mut self.pending_bookmarks);
        }
        let sect = p
            .paragraph_properties
            .as_deref()
            .and_then(|pp| pp.section_properties.as_deref());
        if mark_deleted(p) {
            // A tracked deletion of the paragraph mark joins the paragraph to
            // the next one once accepted. With nothing left in it, accepting
            // removes it: so is it here (its bytes stay in the source). One
            // that keeps content stays a paragraph of its own.
            if sect.is_none() && !para.runs.iter().any(run_has_content) {
                self.pending_bookmarks = std::mem::take(&mut para.bookmarks);
                return;
            }
            self.ctx.bump(|h| h.deleted_marks_kept += 1);
        }
        self.blocks.push(Block::Paragraph(para));
        if let Some(sp) = sect {
            let mut section = map_section(sp);
            section.first_block = self.section_start;
            self.sections.push(section);
            self.refs.push(section_refs(sp));
            self.section_start = self.blocks.len();
        }
    }

    fn table(&mut self, t: &wml::Table) {
        self.blocks
            .push(Block::Table(map_table(t, self.ctx, self.table_ord)));
        self.table_ord += 1;
    }

    /// A block-level content control (`w:sdt`): its content is shown as plain
    /// content — a Word table of contents is one, holding its cached
    /// entries. Its paragraphs are not on the patcher's path; its tables are.
    fn content_control(&mut self, sdt: &wml::SdtBlock) {
        self.ctx.bump(|h| h.content_controls += 1);
        for c in sdt
            .sdt_content_block
            .iter()
            .flat_map(|c| &c.sdt_content_block_choice)
        {
            match c {
                wml::SdtContentBlockChoice::BookmarkStart(b) => {
                    self.pending_bookmarks.push(b.name.clone())
                }
                wml::SdtContentBlockChoice::Paragraph(p) => self.paragraph(p, true),
                wml::SdtContentBlockChoice::Table(t) => self.table(t),
                wml::SdtContentBlockChoice::SdtBlock(inner) => self.content_control(inner),
                _ => {}
            }
        }
    }
}

/// Whether a paragraph's mark is a tracked deletion (`w:pPr/w:rPr/w:del` or
/// `w:moveFrom`).
fn mark_deleted(p: &wml::Paragraph) -> bool {
    p.paragraph_properties
        .as_deref()
        .and_then(|pp| pp.paragraph_mark_run_properties.as_deref())
        .is_some_and(|m| m.deleted.is_some() || m.move_from.is_some())
}

/// Whether a run puts anything on the page.
fn run_has_content(r: &Run) -> bool {
    !r.text.is_empty() || !r.images.is_empty() || r.other_drawings > 0 || r.note_ref.is_some()
}

fn map_paragraph(
    p: &wml::Paragraph,
    ctx: &ImportCtx,
    para_ord: u32,
    source_cell: Option<CellPath>,
) -> Paragraph {
    let (style_id, props) = match p.paragraph_properties.as_deref() {
        Some(pp) => (
            pp.paragraph_style_id.as_ref().map(|s| s.val.clone()),
            para_props(
                &pp.justification,
                &pp.indentation,
                &pp.spacing_between_lines,
                Keeps {
                    next: pp.keep_next.as_ref().map(|v| on(&v.val)),
                    lines: pp.keep_lines.as_ref().map(|v| on(&v.val)),
                    widow_control: pp.widow_control.as_ref().map(|v| on(&v.val)),
                    contextual_spacing: pp.contextual_spacing.as_ref().map(|v| on(&v.val)),
                },
                pp.page_break_before.as_ref().map(|v| on(&v.val)),
                &pp.tabs,
            ),
        ),
        None => (None, ParaProps::default()),
    };

    // Resolve w:numPr -> a list marker through numbering.xml. With no numPr
    // of its own the paragraph takes its style chain's (Word applies a
    // paragraph style's numbering); its own numPr, even `numId` 0, wins.
    let own_num = p
        .paragraph_properties
        .as_deref()
        .and_then(|pp| pp.numbering_properties.as_deref());
    let list = match own_num {
        Some(np) => np.numbering_id.as_ref().and_then(|id| {
            let level = np
                .numbering_level_reference
                .as_ref()
                .map(|l| l.val as u8)
                .unwrap_or(0);
            ctx.numbering.resolve(id.val, level)
        }),
        None => ctx
            .style_lists
            .inherited(
                p.paragraph_properties
                    .as_deref()
                    .and_then(|pp| pp.paragraph_style_id.as_ref())
                    .map(|s| s.val.as_str()),
            )
            .and_then(|(id, level)| ctx.numbering.resolve(id, level)),
    };

    let mut walk = ParaWalk {
        ctx,
        runs: Vec::new(),
        fields: Vec::new(),
        wrun_ord: 0,
        link_ord: 0,
        field_ord: 0,
        merge_ord: 0,
        bookmarks: Vec::new(),
        unshown: 0,
    };
    walk.items(
        p.paragraph_choice.iter().map(inline_of_paragraph).collect(),
        Path::Direct,
        &Stamp::default(),
    );
    let ParaWalk {
        runs,
        bookmarks,
        unshown,
        ..
    } = walk;
    let tracked_ppr = p.paragraph_properties.as_deref().is_some_and(|pp| {
        let mark = pp.paragraph_mark_run_properties.as_deref();
        let changes = [
            pp.paragraph_properties_change.is_some(),
            mark.is_some_and(|m| m.inserted.is_some() || m.move_to.is_some()),
            mark.is_some_and(|m| m.deleted.is_some() || m.move_from.is_some()),
            mark.is_some_and(|m| m.paragraph_mark_run_properties_change.is_some()),
        ];
        let n = changes.iter().filter(|c| **c).count() as u32;
        if n > 0 {
            ctx.bump(|h| h.tracked_changes += n);
        }
        n > 0
    });

    // The paragraph mark's own face (`w:pPr/w:rPr`).
    let mark = p
        .paragraph_properties
        .as_deref()
        .and_then(|pp| pp.paragraph_mark_run_properties.as_deref());
    let (mut mark_font, mut mark_half_pts) = (None, None);
    for choice in mark
        .iter()
        .flat_map(|m| &m.paragraph_mark_run_properties_choice2)
    {
        match choice {
            wml::ParagraphMarkRunPropertiesChoice2::RunFonts(f) => {
                mark_font = theme::latin_font(f, ctx.theme.as_ref())
            }
            wml::ParagraphMarkRunPropertiesChoice2::FontSize(s) => mark_half_pts = hps(&s.val),
            _ => {}
        }
    }

    Paragraph {
        style_id,
        props,
        runs,
        list,
        mark_font,
        mark_half_pts,
        source_para_ord: para_ord,
        source_cell,
        bookmarks,
        held: ParagraphHeld {
            in_content_control: false,
            unshown_runs: unshown,
            tracked_ppr,
        },
    }
}

/// One piece of paragraph content, from any of the run containers ooxmlsdk
/// gives an enum of its own (`w:p`, `w:hyperlink`, `w:fldSimple`,
/// `w:sdtContent`, `w:ins`, `w:moveTo`); their variants share names.
enum Inline<'a> {
    Run(&'a wml::Run),
    Hyperlink(&'a wml::Hyperlink),
    Field(&'a wml::SimpleField),
    /// A run-level content control (`w:sdt`).
    ContentControl(&'a wml::SdtRun),
    /// A tracked insertion or move to here (`w:ins` / `w:moveTo`).
    Inserted(Vec<Inline<'a>>),
    /// A tracked deletion or move away (`w:del` / `w:moveFrom`).
    Deleted,
    Bookmark(&'a str),
    Other,
}

fn inline_of_paragraph(c: &wml::ParagraphChoice) -> Inline<'_> {
    use wml::ParagraphChoice as C;
    match c {
        C::WRun(r) => Inline::Run(r),
        C::Hyperlink(h) => Inline::Hyperlink(h),
        C::SimpleField(f) => Inline::Field(f),
        C::SdtRun(s) => Inline::ContentControl(s),
        C::InsertedRun(i) => Inline::Inserted(
            i.inserted_run_choice
                .iter()
                .map(inline_of_inserted)
                .collect(),
        ),
        C::MoveToRun(m) => {
            Inline::Inserted(m.move_to_run_choice.iter().map(inline_of_move_to).collect())
        }
        C::DeletedRun(_) | C::MoveFromRun(_) => Inline::Deleted,
        C::BookmarkStart(b) => Inline::Bookmark(&b.name),
        _ => Inline::Other,
    }
}

fn inline_of_hyperlink(c: &wml::HyperlinkChoice) -> Inline<'_> {
    use wml::HyperlinkChoice as C;
    match c {
        C::WRun(r) => Inline::Run(r),
        C::Hyperlink(h) => Inline::Hyperlink(h),
        C::SimpleField(f) => Inline::Field(f),
        C::SdtRun(s) => Inline::ContentControl(s),
        C::InsertedRun(i) => Inline::Inserted(
            i.inserted_run_choice
                .iter()
                .map(inline_of_inserted)
                .collect(),
        ),
        C::MoveToRun(m) => {
            Inline::Inserted(m.move_to_run_choice.iter().map(inline_of_move_to).collect())
        }
        C::DeletedRun(_) | C::MoveFromRun(_) => Inline::Deleted,
        _ => Inline::Other,
    }
}

fn inline_of_field(c: &wml::SimpleFieldChoice) -> Inline<'_> {
    use wml::SimpleFieldChoice as C;
    match c {
        C::WRun(r) => Inline::Run(r),
        C::Hyperlink(h) => Inline::Hyperlink(h),
        C::SimpleField(f) => Inline::Field(f),
        C::SdtRun(s) => Inline::ContentControl(s),
        C::InsertedRun(i) => Inline::Inserted(
            i.inserted_run_choice
                .iter()
                .map(inline_of_inserted)
                .collect(),
        ),
        C::MoveToRun(m) => {
            Inline::Inserted(m.move_to_run_choice.iter().map(inline_of_move_to).collect())
        }
        C::DeletedRun(_) | C::MoveFromRun(_) => Inline::Deleted,
        _ => Inline::Other,
    }
}

fn inline_of_content_control(c: &wml::SdtContentRunChoice) -> Inline<'_> {
    use wml::SdtContentRunChoice as C;
    match c {
        C::WRun(r) => Inline::Run(r),
        C::Hyperlink(h) => Inline::Hyperlink(h),
        C::SimpleField(f) => Inline::Field(f),
        C::SdtRun(s) => Inline::ContentControl(s),
        C::InsertedRun(i) => Inline::Inserted(
            i.inserted_run_choice
                .iter()
                .map(inline_of_inserted)
                .collect(),
        ),
        C::MoveToRun(m) => {
            Inline::Inserted(m.move_to_run_choice.iter().map(inline_of_move_to).collect())
        }
        C::DeletedRun(_) | C::MoveFromRun(_) => Inline::Deleted,
        C::BookmarkStart(b) => Inline::Bookmark(&b.name),
        _ => Inline::Other,
    }
}

fn inline_of_inserted(c: &wml::InsertedRunChoice) -> Inline<'_> {
    use wml::InsertedRunChoice as C;
    match c {
        C::WRun(r) => Inline::Run(r),
        C::SdtRun(s) => Inline::ContentControl(s),
        C::InsertedRun(i) => Inline::Inserted(
            i.inserted_run_choice
                .iter()
                .map(inline_of_inserted)
                .collect(),
        ),
        C::MoveToRun(m) => {
            Inline::Inserted(m.move_to_run_choice.iter().map(inline_of_move_to).collect())
        }
        C::DeletedRun(_) | C::MoveFromRun(_) => Inline::Deleted,
        C::BookmarkStart(b) => Inline::Bookmark(&b.name),
        _ => Inline::Other,
    }
}

fn inline_of_move_to(c: &wml::MoveToRunChoice) -> Inline<'_> {
    use wml::MoveToRunChoice as C;
    match c {
        C::WRun(r) => Inline::Run(r),
        C::SdtRun(s) => Inline::ContentControl(s),
        C::InsertedRun(i) => Inline::Inserted(
            i.inserted_run_choice
                .iter()
                .map(inline_of_inserted)
                .collect(),
        ),
        C::MoveToRun(m) => {
            Inline::Inserted(m.move_to_run_choice.iter().map(inline_of_move_to).collect())
        }
        C::DeletedRun(_) | C::MoveFromRun(_) => Inline::Deleted,
        C::BookmarkStart(b) => Inline::Bookmark(&b.name),
        _ => Inline::Other,
    }
}

/// Where the runs being walked sit in the XML, which decides the address a
/// run gets (the save-back patcher's locator, `docx-export/src/splice.rs`).
#[derive(Clone, Copy)]
enum Path {
    /// Direct children of the `<w:p>`: each `<w:r>` takes the next run
    /// ordinal, each `<w:hyperlink>` / `<w:fldSimple>` the next wrapper
    /// ordinal.
    Direct,
    /// Inside the n-th `<w:hyperlink>` child.
    Hyperlink(u32),
    /// Inside the n-th `<w:fldSimple>` child.
    Field(u32),
    /// Anywhere else (a tracked change, a content control, a wrapper inside
    /// a wrapper): every run carries this source, never an ordinal.
    Locked(Option<RunSource>),
}

/// What a wrapper stamps on the runs inside it.
#[derive(Default, Clone)]
struct Stamp {
    hyperlink: Option<String>,
    field: Option<String>,
    merge: Option<MergeField>,
}

/// One paragraph's inline walk.
struct ParaWalk<'c, 'a> {
    ctx: &'c ImportCtx<'a>,
    runs: Vec<Run>,
    // Complex-field state: a stack so (rare) nested fields resolve correctly.
    // A run bearing a `fldChar`/`instrText` is a control run (no display text);
    // runs in an active HYPERLINK field's result become links.
    fields: Vec<FieldFrame>,
    // Ordinal of the source `<w:r>` among the paragraph's DIRECT children — the
    // key the save-back patcher locates on. EVERY direct `<w:r>` consumes one
    // (control/field-char and hidden runs included), so the count tracks the
    // real XML `<w:r>` child index.
    wrun_ord: u32,
    // Ordinals of the WRAPPER children (`<w:hyperlink>` / `<w:fldSimple>`), so a
    // wrapped run keeps a locatable address of its own.
    link_ord: u32,
    field_ord: u32,
    // Ordinal of the next MERGEFIELD in this paragraph (both field forms).
    merge_ord: u32,
    bookmarks: Vec<String>,
    // Runs left out: tracked deletions and hidden runs.
    unshown: u32,
}

impl<'a> ParaWalk<'_, 'a> {
    // Items arrive collected: a generic iterator would instantiate this
    // recursive walk once per nesting level, without end.
    fn items(&mut self, items: Vec<Inline<'a>>, path: Path, stamp: &Stamp) {
        // The run ordinal inside a hyperlink / fldSimple wrapper: every
        // `<w:r>` child counts, as in the patcher.
        let mut inner = 0u32;
        for item in items {
            match item {
                Inline::Bookmark(name) => self.bookmarks.push(name.to_string()),
                Inline::Run(r) => {
                    let source = match path {
                        Path::Direct => {
                            self.wrun_ord += 1;
                            Some(RunSource::DirectRun(self.wrun_ord - 1))
                        }
                        Path::Hyperlink(link_ord) => {
                            inner += 1;
                            Some(RunSource::Hyperlink {
                                link_ord,
                                run_ord: inner - 1,
                            })
                        }
                        Path::Field(field_ord) => {
                            inner += 1;
                            Some(RunSource::Field {
                                field_ord,
                                run_ord: inner - 1,
                            })
                        }
                        Path::Locked(source) => source,
                    };
                    self.run(r, source, stamp);
                }
                Inline::Hyperlink(h) => {
                    let inner_path = match path {
                        Path::Direct => {
                            self.link_ord += 1;
                            Path::Hyperlink(self.link_ord - 1)
                        }
                        other => nested(other),
                    };
                    let stamp = Stamp {
                        hyperlink: self.ctx.hyperlink_target(h),
                        ..stamp.clone()
                    };
                    self.items(
                        h.hyperlink_choice.iter().map(inline_of_hyperlink).collect(),
                        inner_path,
                        &stamp,
                    );
                }
                // `w:fldSimple` — the single-element field form. If it's a
                // HYPERLINK, its inner display runs become links.
                Inline::Field(fs) => {
                    let inner_path = match path {
                        Path::Direct => {
                            self.field_ord += 1;
                            Path::Field(self.field_ord - 1)
                        }
                        other => nested(other),
                    };
                    let merge = parse_merge_field(&fs.instruction, self.merge_ord);
                    if merge.is_some() {
                        self.merge_ord += 1;
                    }
                    let stamp = Stamp {
                        hyperlink: parse_hyperlink_instr(&fs.instruction)
                            .or_else(|| stamp.hyperlink.clone()),
                        field: field_name(&fs.instruction),
                        merge,
                    };
                    self.items(
                        fs.simple_field_choice.iter().map(inline_of_field).collect(),
                        inner_path,
                        &stamp,
                    );
                }
                // A run-level content control: its runs are shown; the
                // control itself stays in the source.
                Inline::ContentControl(sdt) => {
                    self.ctx.bump(|h| h.content_controls += 1);
                    let inner_path = match path {
                        Path::Locked(Some(s)) => Path::Locked(Some(s)),
                        _ => Path::Locked(Some(RunSource::ContentControl)),
                    };
                    self.items(
                        sdt.sdt_content_run
                            .iter()
                            .flat_map(|c| &c.sdt_content_run_choice)
                            .map(inline_of_content_control)
                            .collect(),
                        inner_path,
                        stamp,
                    );
                }
                // A tracked insertion: shown as accepted.
                Inline::Inserted(children) => {
                    self.ctx.bump(|h| h.tracked_changes += 1);
                    let inner_path = match path {
                        Path::Locked(Some(s)) => Path::Locked(Some(s)),
                        _ => Path::Locked(Some(RunSource::Tracked)),
                    };
                    self.items(children, inner_path, stamp);
                }
                // A tracked deletion: not shown, as once accepted. Its bytes
                // stay in the source.
                Inline::Deleted => {
                    self.ctx.bump(|h| h.tracked_changes += 1);
                    self.unshown += 1;
                }
                Inline::Other => {}
            }
        }
    }

    fn run(&mut self, r: &wml::Run, source: Option<RunSource>, stamp: &Stamp) {
        if let Some(kind) = run_field_char(r) {
            match kind {
                wml::FieldCharValues::Begin => self.fields.push(FieldFrame::default()),
                wml::FieldCharValues::Separate => {
                    if let Some(f) = self.fields.last_mut() {
                        f.result_url = parse_hyperlink_instr(&f.instruction);
                        f.result_field = field_name(&f.instruction);
                        f.merge = parse_merge_field(&f.instruction, self.merge_ord);
                        if f.merge.is_some() {
                            self.merge_ord += 1;
                        }
                        f.separated = true;
                    }
                }
                wml::FieldCharValues::End => {
                    self.fields.pop();
                }
            }
            return;
        }
        if let Some(instr) = run_instr_text(r) {
            if let Some(f) = self.fields.last_mut() {
                f.instruction.push_str(&instr);
            }
            return;
        }
        if r.run_properties
            .as_deref()
            .is_some_and(|p| p.run_properties_change.is_some())
        {
            self.ctx.bump(|h| h.tracked_changes += 1);
        }
        let mut run = map_run(r, self.ctx);
        // Hidden text (`w:vanish`): not shown, as in Word with hidden text
        // off. The run keeps its ordinal, so the runs around it stay
        // addressable, and its bytes stay in the source.
        if self.ctx.hidden(r, run.style_id.as_deref()) {
            if run_has_content(&run) {
                self.ctx.bump(|h| h.hidden_runs += 1);
                self.unshown += 1;
            }
            return;
        }
        run.source = source;
        run.hyperlink = stamp.hyperlink.clone();
        run.field = stamp.field.clone();
        run.merge_field = stamp.merge.clone();
        if let Some(f) = self.fields.last() {
            if f.separated {
                if let Some(url) = &f.result_url {
                    run.hyperlink = Some(url.clone());
                }
                if f.result_field.is_some() {
                    run.field = f.result_field.clone();
                }
                if f.merge.is_some() {
                    run.merge_field = f.merge.clone();
                }
            }
        }
        self.runs.push(run);
    }
}

/// The path of a wrapper met on `path` other than as a direct paragraph
/// child: its runs are not on the patcher's path.
fn nested(path: Path) -> Path {
    match path {
        Path::Locked(s) => Path::Locked(s),
        _ => Path::Locked(None),
    }
}

fn map_table(t: &wml::Table, ctx: &ImportCtx, table_ord: u32) -> docx_core::Table {
    let column_widths = t
        .table_grid
        .as_deref()
        .map(|g| {
            g.grid_column
                .iter()
                .filter_map(|c| c.width.as_ref().and_then(twips_u))
                .collect()
        })
        .unwrap_or_default();

    let mut rows = Vec::new();
    // Ordinals among the DIRECT `<w:tr>` / `<w:tc>` children, as the patcher
    // counts them; a row or cell inside a content control takes none.
    let mut row_ord = 0u32;
    let mut content_control_rows = false;
    let mut table_rows: Vec<(&wml::TableRow, bool)> = Vec::new();
    for tc in &t.table_choice2 {
        match tc {
            wml::TableChoice2::TableRow(tr) => table_rows.push((tr, false)),
            wml::TableChoice2::SdtRow(sdt) => {
                content_control_rows = true;
                sdt_rows(sdt, ctx, &mut table_rows);
            }
            _ => {}
        }
    }
    for (tr, row_in_control) in table_rows {
        {
            let mut cell_ord = 0u32;
            let mut table_cells: Vec<(&wml::TableCell, bool)> = Vec::new();
            for rc in &tr.table_row_choice {
                match rc {
                    wml::TableRowChoice::TableCell(c) => table_cells.push((c, row_in_control)),
                    wml::TableRowChoice::SdtCell(sdt) => {
                        content_control_rows = true;
                        sdt_cells(sdt, ctx, &mut table_cells);
                    }
                    _ => {}
                }
            }
            let mut cells = Vec::new();
            for (c, in_control) in table_cells {
                let path_cell = if in_control { u32::MAX } else { cell_ord };
                let mut cell = map_cell(c, ctx, table_ord, row_ord, path_cell);
                if in_control {
                    for p in &mut cell.paragraphs {
                        p.held.in_content_control = true;
                    }
                } else {
                    cell_ord += 1;
                }
                cells.push(cell);
            }
            let is_header = tr.table_row_properties.as_deref().is_some_and(|p| {
                p.table_row_properties_choice1.iter().any(|c| {
                    matches!(c, wml::TableRowPropertiesChoice::TableHeader(h)
                        if h.val.is_none() || on(&h.val))
                })
            });
            let height = tr.table_row_properties.as_deref().and_then(|p| {
                p.table_row_properties_choice1.iter().find_map(|c| match c {
                    wml::TableRowPropertiesChoice::TableRowHeight(h) => {
                        h.val.as_ref().and_then(twips_u)
                    }
                    _ => None,
                })
            });
            rows.push(docx_core::TableRow {
                cells,
                is_header,
                height,
            });
            if !row_in_control {
                row_ord += 1;
            }
        }
    }
    let cell_margins = t
        .table_properties
        .as_deref()
        .and_then(|p| p.table_cell_margin_default.as_deref())
        .map(|m| docx_core::CellMargins {
            top: m.top_margin.as_ref().and_then(|x| margin_twips(&x.width)),
            left: m
                .table_cell_left_margin
                .as_ref()
                .and_then(|x| margin_twips(&x.width))
                .or_else(|| m.start_margin.as_ref().and_then(|x| margin_twips(&x.width))),
            bottom: m
                .bottom_margin
                .as_ref()
                .and_then(|x| margin_twips(&x.width)),
            right: m
                .table_cell_right_margin
                .as_ref()
                .and_then(|x| margin_twips(&x.width))
                .or_else(|| m.end_margin.as_ref().and_then(|x| margin_twips(&x.width))),
        })
        .unwrap_or_default();
    docx_core::Table {
        column_widths,
        rows,
        cell_margins,
        content_control_rows,
    }
}

/// The rows of a row-level content control, nested ones included; each
/// marked as inside one.
fn sdt_rows<'a>(sdt: &'a wml::SdtRow, ctx: &ImportCtx, out: &mut Vec<(&'a wml::TableRow, bool)>) {
    ctx.bump(|h| h.content_controls += 1);
    for c in sdt
        .sdt_content_row
        .iter()
        .flat_map(|c| &c.sdt_content_row_choice)
    {
        match c {
            wml::SdtContentRowChoice::TableRow(tr) => out.push((tr, true)),
            wml::SdtContentRowChoice::SdtRow(inner) => sdt_rows(inner, ctx, out),
            _ => {}
        }
    }
}

/// The cells of a cell-level content control, as [`sdt_rows`].
fn sdt_cells<'a>(
    sdt: &'a wml::SdtCell,
    ctx: &ImportCtx,
    out: &mut Vec<(&'a wml::TableCell, bool)>,
) {
    ctx.bump(|h| h.content_controls += 1);
    for c in sdt
        .sdt_content_cell
        .iter()
        .flat_map(|c| &c.sdt_content_cell_choice)
    {
        match c {
            wml::SdtContentCellChoice::TableCell(tc) => out.push((tc, true)),
            wml::SdtContentCellChoice::SdtCell(inner) => sdt_cells(inner, ctx, out),
            _ => {}
        }
    }
}

fn map_cell(
    c: &wml::TableCell,
    ctx: &ImportCtx,
    table_ord: u32,
    row: u32,
    cell: u32,
) -> docx_core::TableCell {
    let props = c.table_cell_properties.as_deref();
    let grid_span = props
        .and_then(|p| p.grid_span.as_ref())
        .map(|g| g.val.max(1) as u32)
        .unwrap_or(1);
    let v_merge = match props.and_then(|p| p.vertical_merge.as_ref()) {
        None => docx_core::VMerge::None,
        // A `w:vMerge` with `val="restart"` starts a span; anything else
        // (`val="continue"` or an absent val) continues it.
        Some(vm) => match vm.val {
            Some(wml::MergedCellValues::Restart) => docx_core::VMerge::Restart,
            _ => docx_core::VMerge::Continue,
        },
    };
    // Cell paragraphs carry a `CellPath` (tbl/tr/tc/p ordinals) so save-back can
    // locate them; `source_para_ord` is meaningless here.
    let mut paragraphs = Vec::new();
    let mut para = 0u32;
    for cc in &c.table_cell_choice {
        match cc {
            wml::TableCellChoice::Paragraph(p) => {
                let path = CellPath {
                    table_ord,
                    row,
                    cell,
                    para,
                };
                paragraphs.push(map_paragraph(p, ctx, 0, Some(path)));
                para += 1;
            }
            // A block-level content control in the cell: its paragraphs are
            // shown, but they are not the cell's `<w:p>` children the
            // patcher counts.
            wml::TableCellChoice::SdtBlock(sdt) => {
                let path = CellPath {
                    table_ord,
                    row,
                    cell,
                    para,
                };
                cell_content_control(sdt, ctx, path, &mut paragraphs);
            }
            _ => {}
        }
    }
    let margins = props
        .and_then(|p| p.table_cell_margin.as_deref())
        .map(|m| docx_core::CellMargins {
            top: m.top_margin.as_ref().and_then(|x| margin_twips(&x.width)),
            left: m
                .left_margin
                .as_ref()
                .and_then(|x| margin_twips(&x.width))
                .or_else(|| m.start_margin.as_ref().and_then(|x| margin_twips(&x.width))),
            bottom: m
                .bottom_margin
                .as_ref()
                .and_then(|x| margin_twips(&x.width)),
            right: m
                .right_margin
                .as_ref()
                .and_then(|x| margin_twips(&x.width))
                .or_else(|| m.end_margin.as_ref().and_then(|x| margin_twips(&x.width))),
        })
        .unwrap_or_default();
    let v_align = props
        .and_then(|p| p.table_cell_vertical_alignment.as_ref())
        .map(|v| match v.val {
            wml::TableVerticalAlignmentValues::Top => docx_core::CellVAlign::Top,
            wml::TableVerticalAlignmentValues::Center => docx_core::CellVAlign::Center,
            wml::TableVerticalAlignmentValues::Bottom => docx_core::CellVAlign::Bottom,
        });
    docx_core::TableCell {
        margins,
        v_align,
        paragraphs,
        grid_span,
        v_merge,
    }
}

/// The paragraphs of a block-level content control inside a table cell,
/// nested controls included, each marked as inside one.
///
/// They carry the cell's path (the table's ordinal is what the bindings
/// read from it); being marked, they are never addressed by it.
fn cell_content_control(
    sdt: &wml::SdtBlock,
    ctx: &ImportCtx,
    path: CellPath,
    out: &mut Vec<Paragraph>,
) {
    ctx.bump(|h| h.content_controls += 1);
    for c in sdt
        .sdt_content_block
        .iter()
        .flat_map(|c| &c.sdt_content_block_choice)
    {
        match c {
            wml::SdtContentBlockChoice::Paragraph(p) => {
                let mut para = map_paragraph(p, ctx, 0, Some(path));
                para.held.in_content_control = true;
                out.push(para);
            }
            wml::SdtContentBlockChoice::SdtBlock(inner) => {
                cell_content_control(inner, ctx, path, out)
            }
            _ => {}
        }
    }
}

/// One frame of a complex field (`w:fldChar begin … instrText … separate …
/// result … end`). Instruction text accumulates between `begin` and `separate`;
/// runs between `separate` and `end` are the field result.
#[derive(Default)]
struct FieldFrame {
    instruction: String,
    separated: bool,
    /// The resolved external URL if this is a `HYPERLINK` field (else `None`).
    result_url: Option<String>,
    /// The field's NAME (instruction's first token, upper-cased) — `PAGE`,
    /// `DATE`, `REF`, … Stamped on the result runs so lowering can report which
    /// field kinds became frozen text.
    result_field: Option<String>,
    /// The parsed field when it is a `MERGEFIELD` (stamped on its result runs).
    merge: Option<MergeField>,
}

/// The `w:fldChar` type carried by a run, if any (a control run — no display text).
fn run_field_char(r: &wml::Run) -> Option<wml::FieldCharValues> {
    r.run_choice.iter().find_map(|c| match c {
        wml::RunChoice::FieldChar(fc) => Some(fc.field_char_type),
        _ => None,
    })
}

/// The concatenated `w:instrText` (field-code) text carried by a run, if any.
fn run_instr_text(r: &wml::Run) -> Option<String> {
    let mut s = String::new();
    for c in &r.run_choice {
        if let wml::RunChoice::FieldCode(fc) = c {
            if let Some(t) = &fc.0.xml_content {
                s.push_str(t);
            }
        }
    }
    (!s.is_empty()).then_some(s)
}

/// Parse a field instruction and return the EXTERNAL URL when it is a
/// `HYPERLINK "url"` field. An internal `HYPERLINK \l "bookmark"` link returns
/// `None` (styled-only, mirroring the `#anchor` case — the core hyperlink door
/// registers URL destinations, not text anchors). Word splits the instruction
/// across several `w:instrText` runs, so this parses the accumulated string.
/// A field instruction's NAME: its first whitespace-separated token, upper-cased
/// (`" PAGE  \\* MERGEFORMAT "` → `PAGE`). `None` for an empty instruction.
fn field_name(instr: &str) -> Option<String> {
    instr
        .split_whitespace()
        .next()
        .map(|t| t.to_ascii_uppercase())
        .filter(|t| !t.is_empty())
}

/// The tokens of a field instruction: whitespace-separated words, a
/// double-quoted argument as one token (quotes removed, `\"` unescaped), and
/// each backslash switch as its own token (`\*`, `\b`).
fn instruction_tokens(instr: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut chars = instr.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c == '"' {
            chars.next();
            let mut t = String::new();
            while let Some(c) = chars.next() {
                match c {
                    '\\' if chars.peek() == Some(&'"') => t.push(chars.next().unwrap_or('"')),
                    '"' => break,
                    c => t.push(c),
                }
            }
            out.push((t, true));
        } else {
            let mut t = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() || (c == '"' && !t.is_empty()) {
                    break;
                }
                t.push(c);
                chars.next();
            }
            out.push((t, false));
        }
    }
    out
}

/// Parse a `MERGEFIELD` instruction (Word mail merge); `None` for any other
/// field or a MERGEFIELD without a name. `occurrence` is the field's ordinal
/// among the paragraph's merge fields.
pub fn parse_merge_field(instr: &str, occurrence: u32) -> Option<MergeField> {
    let tokens = instruction_tokens(instr);
    let (head, _) = tokens.first()?;
    if !head.eq_ignore_ascii_case("MERGEFIELD") {
        return None;
    }
    let mut field = MergeField {
        instruction: instr.to_string(),
        occurrence,
        ..Default::default()
    };
    let mut i = 1;
    while i < tokens.len() {
        let (t, quoted) = &tokens[i];
        let switch = !quoted && t.starts_with('\\');
        let arg = tokens.get(i + 1).map(|(a, _)| a.clone());
        match (switch, t.to_ascii_lowercase().as_str()) {
            (true, "\\b") => {
                field.before = arg;
                i += 1;
            }
            (true, "\\f") => {
                field.after = arg;
                i += 1;
            }
            (true, "\\*") => {
                field.format.extend(arg);
                i += 1;
            }
            (true, "\\m") => field.mapped = true,
            (true, "\\v") => field.vertical = true,
            (true, _) => {}
            (false, _) if field.name.is_empty() => field.name = t.clone(),
            (false, _) => {}
        }
        i += 1;
    }
    (!field.name.is_empty()).then_some(field)
}

fn parse_hyperlink_instr(instr: &str) -> Option<String> {
    let rest = instr.trim().strip_prefix("HYPERLINK")?;
    let quote = rest.find('"')?;
    // A `\l` switch BEFORE the first quoted argument means an internal
    // bookmark target (no external URL); skip it.
    if rest[..quote].split_whitespace().any(|t| t == "\\l") {
        return None;
    }
    let after = &rest[quote + 1..];
    let end = after.find('"')?;
    let url = &after[..end];
    (!url.is_empty()).then(|| url.to_string())
}

fn map_run(r: &wml::Run, ctx: &ImportCtx) -> Run {
    let mut props = RunProps::default();
    let mut style_id = None;
    if let Some(rpr) = r.run_properties.as_deref() {
        for c in &rpr.run_properties_choice {
            apply_run_property_choice(c, &mut props, &mut style_id, ctx.theme.as_ref());
        }
    }
    let mut text = String::new();
    let mut breaks = Vec::new();
    let mut images = Vec::new();
    let mut other_drawings = 0u32;
    let mut note_ref = None;
    let mut ptabs = Vec::new();
    let mut symbols = Vec::new();
    for c in &r.run_choice {
        match c {
            wml::RunChoice::Text(t) => {
                if let Some(s) = &t.0.xml_content {
                    text.push_str(s);
                }
            }
            wml::RunChoice::TabChar => text.push('\t'),
            // ADR 028/029 — a page or column break is a pagination
            // instruction, not text: it is recorded at its char offset. A
            // typeless or `textWrapping` break (and `w:cr`) is a line break
            // WITHIN the paragraph: U+2028, the engine's forced line break
            // (one char in the contiguous style space, 3 UTF-8 bytes in
            // insertText's), never `\n`, which would split the paragraph.
            wml::RunChoice::Break(b) => match b.r#type {
                Some(wml::BreakValues::Page) => breaks.push(RunBreak {
                    at: text.chars().count(),
                    kind: BreakKind::Page,
                }),
                Some(wml::BreakValues::Column) => breaks.push(RunBreak {
                    at: text.chars().count(),
                    kind: BreakKind::Column,
                }),
                _ => text.push(LINE_BREAK),
            },
            wml::RunChoice::CarriageReturn => text.push(LINE_BREAK),
            wml::RunChoice::NoBreakHyphen => text.push('\u{2011}'),
            // Word's optional hyphen: the one place its word may break.
            wml::RunChoice::SoftHyphen => text.push(SOFT_HYPHEN),
            // A symbol-font character: its Unicode equivalent, where it has
            // one; recorded either way, so the lowering can say what it
            // drew in the run's font and what it could not carry.
            wml::RunChoice::SymbolChar(sym) | wml::RunChoice::SymbolCharExt(sym) => {
                let code = sym.char.clone().unwrap_or_default();
                let font = sym.font.clone();
                let ch = docx_core::symbol_char(font.as_deref(), &code);
                symbols.push(RunSymbol {
                    at: text.chars().count(),
                    font,
                    code,
                    char: ch,
                });
                if let Some(ch) = ch {
                    text.push(ch);
                }
            }
            // An absolute-position tab: a tab in the text, with where it goes
            // kept for the lowering.
            wml::RunChoice::PositionalTab(p) => {
                use wml::AbsolutePositionTabAlignmentValues as A;
                use wml::AbsolutePositionTabLeaderCharValues as L;
                use wml::AbsolutePositionTabPositioningBaseValues as B;
                ptabs.push(PositionalTab {
                    at: text.chars().count(),
                    alignment: match p.alignment {
                        A::Left => PtabAlignment::Left,
                        A::Center => PtabAlignment::Center,
                        A::Right => PtabAlignment::Right,
                    },
                    relative_to: match p.relative_to {
                        B::Margin => PtabBase::Margin,
                        B::Indent => PtabBase::Indent,
                    },
                    leader: match p.leader {
                        L::None => None,
                        L::Dot => Some(".".into()),
                        L::Hyphen => Some("-".into()),
                        L::Underscore => Some("_".into()),
                        L::MiddleDot => Some("\u{00B7}".into()),
                    },
                });
                text.push('\t');
            }
            // Every picture in the run; anything else a drawing can be
            // (shape, text box, chart) is counted, not carried.
            wml::RunChoice::Drawing(d) => match map_drawing(d, ctx) {
                Some(img) => images.push(img),
                None => other_drawings += 1,
            },
            // A legacy VML picture (`w:pict`): a picture where Word gives it
            // room in the flow, else counted as not placed.
            wml::RunChoice::Picture(p) => match map_pict(p, ctx) {
                Some(img) => images.push(img),
                None => ctx.unplaced_vml.set(ctx.unplaced_vml.get() + 1),
            },
            // A footnote/endnote reference mark — the run carries no text; the
            // note body lives in the notes part, keyed by this id.
            wml::RunChoice::FootnoteReference(f) => note_ref = Some(f.id),
            wml::RunChoice::EndnoteReference(e) => note_ref = Some(e.id),
            _ => {}
        }
    }
    Run {
        style_id,
        props,
        text,
        breaks,
        ptabs,
        symbols,
        images,
        other_drawings,
        hyperlink: None,
        // The caller (map_paragraph) stamps the real provenance from context.
        source: None,
        note_ref,
        field: None,
        merge_field: None,
    }
}

/// Extract an [`Image`] from a `w:drawing`: the intrinsic extent + the picture
/// blip's `r:embed` rel id, walked typed (Inline/Anchor → a:graphic →
/// graphicData → pic:pic → blipFill → blip@embed), resolved to media bytes.
/// (Typed navigation avoids linking `ooxmlsdk`'s serializer, keeping the wasm
/// lean — `to_xml()` would pull in the whole schema's `write_to` codegen.)
fn map_drawing(d: &wml::Drawing, ctx: &ImportCtx) -> Option<Image> {
    let (width_emu, height_emu, graphic, float, doc_pr) = match d.drawing_choice.as_ref()? {
        wml::DrawingChoice::Inline(i) => (
            i.extent.cx,
            i.extent.cy,
            &i.graphic,
            None,
            Some(i.doc_properties.id),
        ),
        wml::DrawingChoice::Anchor(a) => (
            a.extent.cx,
            a.extent.cy,
            &a.graphic,
            Some(map_float(a)),
            a.doc_properties.as_ref().map(|p| p.id),
        ),
    };
    // The look is taken before anything can fail, so a drawing that is not
    // placed still consumes its own.
    let look = doc_pr.and_then(|id| ctx.take_look(id));
    let embed_id = blip_embed(graphic)?;
    let (bytes, mime) = ctx.images.resolve(embed_id)?;
    Some(Image {
        bytes,
        mime,
        width_emu,
        height_emu,
        float,
        band_offset_emu: None,
        look,
    })
}

/// The WordprocessingML drawing namespace (`wp:`).
const NS_WP: &[u8] = b"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

/// Every DrawingML picture's look in a part (doc ADR 618), by its
/// `wp:docPr/@id`: `pic:spPr` (fill, outline, effect list) and the
/// `a:blip` (alpha, picture effects), read by the shared DrawingML reader
/// over the `wp:inline` / `wp:anchor` subtrees alone. A drawing that is not
/// a picture, or a plain one, holds `None`.
fn picture_looks(part: &[u8]) -> Looks {
    use paged_ooxml::drawingml;
    use paged_ooxml::tree::{self, Ns};
    let mut out = Looks::new();
    let Ok(drawings) = tree::subtrees(part, |uri, local| {
        uri == NS_WP && (local == "inline" || local == "anchor")
    }) else {
        return out;
    };
    let no_rels = |_: &str| None;
    for d in &drawings {
        let Some(id) = d
            .children
            .iter()
            .find(|c| c.local == "docPr")
            .and_then(|p| p.attr_u32("id"))
        else {
            continue;
        };
        let pic = d
            .path(&[(Ns::A, "graphic"), (Ns::A, "graphicData")])
            .and_then(|g| g.children.iter().find(|c| c.local == "pic"));
        let look = pic.map(|pic| PictureLook {
            shape: pic
                .children
                .iter()
                .find(|c| c.local == "spPr")
                .map(|sp| drawingml::shape_properties(sp, &no_rels))
                .unwrap_or_default(),
            blip: pic
                .children
                .iter()
                .find(|c| c.local == "blipFill")
                .map(|b| drawingml::blip(b, &no_rels))
                .unwrap_or_default(),
        });
        out.entry(id)
            .or_default()
            .push_back(look.filter(|l| !l.is_plain()));
    }
    out
}

/// A `wp:anchor`'s position and wrap (thoughts ADR 035), as written.
fn map_float(a: &wp::Anchor) -> Float {
    let mut f = Float {
        dist_top: i64::from(a.distance_from_top.unwrap_or(0)),
        dist_bottom: i64::from(a.distance_from_bottom.unwrap_or(0)),
        dist_left: i64::from(a.distance_from_left.unwrap_or(0)),
        dist_right: i64::from(a.distance_from_right.unwrap_or(0)),
        behind_doc: a.behind_doc.as_bool(),
        allow_overlap: a.allow_overlap.as_bool(),
        layout_in_cell: a.layout_in_cell.as_bool(),
        locked: a.locked.as_bool(),
        relative_height: a.relative_height.unwrap_or(0),
        ..Float::default()
    };
    if a.simple_pos.is_some_and(|b| b.as_bool()) {
        f.simple_pos = a
            .simple_position
            .as_ref()
            .map(|p| (coordinate(&p.x), coordinate(&p.y)));
    }
    f.horizontal = a.horizontal_position.as_deref().map(|h| {
        use wp::HorizontalPositionChoice as C;
        let mut p = FloatPosition {
            relative_from: h.relative_from.to_string(),
            offset: None,
            align: None,
            percent: None,
        };
        match &h.horizontal_position_choice {
            Some(C::HorizontalAlignment(v)) => p.align = Some(v.to_string()),
            Some(C::PositionOffset(v)) => p.offset = Some(i64::from(*v)),
            Some(C::PercentagePositionHeightOffset(v)) => p.percent = percent(&v.to_string()),
            None => {}
        }
        p
    });
    f.vertical = a.vertical_position.as_deref().map(|v| {
        use wp::VerticalPositionChoice as C;
        let mut p = FloatPosition {
            relative_from: v.relative_from.to_string(),
            offset: None,
            align: None,
            percent: None,
        };
        match &v.vertical_position_choice {
            Some(C::VerticalAlignment(a)) => p.align = Some(a.to_string()),
            Some(C::PositionOffset(o)) => p.offset = Some(i64::from(*o)),
            Some(C::PercentagePositionVerticalOffset(o)) => p.percent = percent(&o.to_string()),
            None => {}
        }
        p
    });
    use wp::AnchorChoice as W;
    match &a.anchor_choice {
        None | Some(W::WrapNone) => f.wrap = FloatWrap::None,
        Some(W::WrapSquare(w)) => {
            f.wrap = FloatWrap::Square;
            f.wrap_text = Some(w.wrap_text.to_string());
            if let Some(v) = w.distance_from_top {
                f.dist_top = i64::from(v);
            }
            if let Some(v) = w.distance_from_bottom {
                f.dist_bottom = i64::from(v);
            }
            if let Some(v) = w.distance_from_left {
                f.dist_left = i64::from(v);
            }
            if let Some(v) = w.distance_from_right {
                f.dist_right = i64::from(v);
            }
        }
        Some(W::WrapTight(w)) => {
            f.wrap = FloatWrap::Tight;
            f.wrap_text = Some(w.wrap_text.to_string());
            if let Some(v) = w.distance_from_left {
                f.dist_left = i64::from(v);
            }
            if let Some(v) = w.distance_from_right {
                f.dist_right = i64::from(v);
            }
        }
        Some(W::WrapThrough(w)) => {
            f.wrap = FloatWrap::Through;
            f.wrap_text = Some(w.wrap_text.to_string());
            if let Some(v) = w.distance_from_left {
                f.dist_left = i64::from(v);
            }
            if let Some(v) = w.distance_from_right {
                f.dist_right = i64::from(v);
            }
        }
        Some(W::WrapTopBottom(w)) => {
            f.wrap = FloatWrap::TopAndBottom;
            if let Some(v) = w.distance_from_top {
                f.dist_top = i64::from(v);
            }
            if let Some(v) = w.distance_from_bottom {
                f.dist_bottom = i64::from(v);
            }
        }
    }
    f
}

/// A DrawingML coordinate as EMU (its XML text is an integer, or a
/// universal measure we do not expect in `wp:simplePos`).
fn coordinate<T: std::fmt::Display>(v: &T) -> i64 {
    v.to_string().trim().parse().unwrap_or(0)
}

/// A `wp14:pctPos*Offset` (thousandths of a percent) as written.
fn percent(s: &str) -> Option<i64> {
    s.trim().trim_end_matches('%').parse().ok()
}

/// An [`Image`] from a legacy VML picture (`w:pict` → `v:shape` →
/// `v:imagedata r:id`), Word 97–2003's picture: its size is the shape's CSS
/// `width`/`height`. An inline picture lowers, and so does a floating one
/// whose text wraps top and bottom (`w10:wrap type="topAndBottom"`): Word
/// gives it a band of its own, so the text resumes below it, as after an
/// inline picture (`fixtures/real-docx.word.json`, F01). Any other floating
/// VML, or VML that is not a picture, returns `None` and is counted as
/// unplaced.
fn map_pict(p: &wml::Picture, ctx: &ImportCtx) -> Option<Image> {
    p.picture_choice.iter().find_map(|c| {
        let wml::PictureChoice::Shape(shape) = c else {
            return None;
        };
        let style = shape.style.as_deref().unwrap_or("");
        let css = |key: &str| {
            style.split(';').find_map(|decl| {
                let (k, v) = decl.split_once(':')?;
                (k.trim() == key).then(|| v.trim())
            })
        };
        let own_band = shape.shape_choice.iter().any(|sc| {
            matches!(sc, vml::ShapeChoice::TextWrap(w)
                if matches!(w.r#type, Some(w10::WrapValues::TopAndBottom) | None))
        });
        if css("position") == Some("absolute") && !own_band {
            return None;
        }
        let rel_id = shape.shape_choice.iter().find_map(|sc| match sc {
            vml::ShapeChoice::ImageData(d) => d.relationship_id.as_deref(),
            _ => None,
        })?;
        let width_emu = css_length_emu(css("width")?)?;
        let height_emu = css_length_emu(css("height")?)?;
        let (bytes, mime) = ctx.images.resolve(rel_id)?;
        // Inline in the flow, as Word lays both kinds (a floating one's band
        // is its own line's worth of room).
        let band_offset_emu = (css("position") == Some("absolute"))
            .then(|| css("margin-top").and_then(css_length_emu).unwrap_or(0));
        Some(Image {
            bytes,
            mime,
            width_emu,
            height_emu,
            float: None,
            band_offset_emu,
            look: None,
        })
    })
}

/// A VML/CSS length (`481.1pt`, `2in`, `3cm`, `20mm`, `96px`) in EMU.
fn css_length_emu(v: &str) -> Option<i64> {
    let split = v
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let n: f64 = num.parse().ok()?;
    use paged_ooxml::units::{EMU_PER_CM, EMU_PER_INCH, EMU_PER_PT};
    let per = match unit.trim() {
        "pt" => EMU_PER_PT,
        "in" => EMU_PER_INCH as f64,
        "cm" => EMU_PER_CM as f64,
        "mm" => EMU_PER_CM as f64 / 10.0,
        // A CSS pixel is 1/96 inch.
        "px" | "" => EMU_PER_INCH as f64 / 96.0,
        _ => return None,
    };
    Some((n * per).round() as i64)
}

/// The `r:embed` rel id of the first picture blip in a DrawingML graphic.
fn blip_embed(graphic: &aml::Graphic) -> Option<&str> {
    for choice in &graphic.graphic_data.graphic_data_choice {
        if let aml::GraphicDataChoice::Picture(pic) = choice {
            let blip = pic.blip_fill.as_deref()?.blip.as_deref()?;
            return blip.embed.as_deref();
        }
    }
    None
}

/// Apply one `w:rPr` child (the run's choice-vector form) to [`RunProps`].
fn apply_run_property_choice(
    c: &wml::RunPropertiesChoice,
    props: &mut RunProps,
    style_id: &mut Option<String>,
    theme: Option<&Theme>,
) {
    use wml::RunPropertiesChoice as C;
    match c {
        C::RunStyle(s) => *style_id = Some(s.val.clone()),
        C::RunFonts(f) => theme::apply_fonts(f, theme, props),
        C::Shading(s) => props.shading = theme::shading(s, theme),
        C::Bold(b) => props.bold = Some(on(&b.val)),
        C::Italic(i) => props.italic = Some(on(&i.val)),
        C::Caps(v) => props.caps = Some(on(&v.val)),
        C::SmallCaps(v) => props.small_caps = Some(on(&v.val)),
        C::Strike(v) => props.strike = Some(on(&v.val)),
        C::Color(col) => theme::apply_color(col, theme, props),
        C::FontSize(sz) => props.size_half_pts = hps(&sz.val),
        C::Underline(u) => props.underline = Some(underline_on(u)),
        C::VerticalTextAlignment(v) => props.vert_align = Some(vert_align(&v.val)),
        C::Position(p) => props.baseline_half_pts = signed_hps(&p.val),
        C::Spacing(sp) => props.spacing_twips = Some(sp.val),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Styles

fn map_styles(styles: &wml::Styles, theme: Option<&Theme>) -> StyleCatalog {
    let mut out = StyleCatalog::default();
    if let Some(dd) = styles.doc_defaults.as_deref() {
        // docDefaults — the document-wide base run/paragraph properties (Word's
        // Normal defaults: font, size, spacing). `docx-lower` turns a non-empty
        // Defaults into a base style every un-based style inherits from.
        if let Some(rpd) = dd.run_properties_default.as_deref() {
            if let Some(base) = rpd.run_properties_base_style.as_deref() {
                out.doc_defaults.run = run_props_base(base, theme);
            }
        }
        if let Some(ppd) = dd.paragraph_properties_default.as_deref() {
            if let Some(base) = ppd.paragraph_properties_base_style.as_deref() {
                out.doc_defaults.para = para_props(
                    &base.justification,
                    &base.indentation,
                    &base.spacing_between_lines,
                    Keeps {
                        next: None,
                        lines: None,
                        widow_control: base.widow_control.as_ref().map(|v| on(&v.val)),
                        contextual_spacing: None,
                    },
                    None,
                    &None,
                );
            }
        }
    }
    for s in &styles.style {
        if let Some(style) = map_style(s, theme) {
            out.styles.push(style);
        }
    }
    out
}

/// Read the docDefaults run base style (`w:rPrDefault/w:rPr`) — a named-field
/// shape carrying the subset of run properties Word emits as defaults.
fn run_props_base(rpr: &wml::RunPropertiesBaseStyle, theme: Option<&Theme>) -> RunProps {
    let mut props = RunProps::default();
    if let Some(f) = &rpr.run_fonts {
        theme::apply_fonts(f, theme, &mut props);
    }
    if let Some(s) = &rpr.shading {
        props.shading = theme::shading(s, theme);
    }
    if let Some(b) = &rpr.bold {
        props.bold = Some(on(&b.val));
    }
    if let Some(i) = &rpr.italic {
        props.italic = Some(on(&i.val));
    }
    if let Some(c) = &rpr.color {
        theme::apply_color(c, theme, &mut props);
    }
    if let Some(sz) = &rpr.font_size {
        props.size_half_pts = hps(&sz.val);
    }
    if let Some(u) = &rpr.underline {
        props.underline = Some(underline_on(u));
    }
    props
}

fn map_style(s: &wml::Style, theme: Option<&Theme>) -> Option<Style> {
    let style_id = s.style_id.clone()?;
    let kind = match s.r#type {
        Some(wml::StyleValues::Paragraph) => StyleKind::Paragraph,
        Some(wml::StyleValues::Character) => StyleKind::Character,
        Some(wml::StyleValues::Table) => StyleKind::Table,
        Some(wml::StyleValues::Numbering) => StyleKind::Numbering,
        _ => StyleKind::Paragraph,
    };
    let para = s
        .style_paragraph_properties
        .as_deref()
        .map(|pp| {
            para_props(
                &pp.justification,
                &pp.indentation,
                &pp.spacing_between_lines,
                Keeps {
                    next: pp.keep_next.as_ref().map(|v| on(&v.val)),
                    lines: pp.keep_lines.as_ref().map(|v| on(&v.val)),
                    widow_control: pp.widow_control.as_ref().map(|v| on(&v.val)),
                    contextual_spacing: pp.contextual_spacing.as_ref().map(|v| on(&v.val)),
                },
                pp.page_break_before.as_ref().map(|v| on(&v.val)),
                &pp.tabs,
            )
        })
        .unwrap_or_default();
    let run = s
        .style_run_properties
        .as_deref()
        .map(|r| run_props_named(r, theme))
        .unwrap_or_default();

    Some(Style {
        style_id,
        name: s.style_name.as_ref().map(|n| n.val.clone()),
        kind,
        based_on: s.based_on.as_ref().map(|b| b.val.clone()),
        is_default: s.default.is_some() && on(&s.default),
        para,
        run,
    })
}

/// Read a style's `w:rPr` (the *named-field* form) into [`RunProps`].
fn run_props_named(rpr: &wml::StyleRunProperties, theme: Option<&Theme>) -> RunProps {
    let mut props = RunProps::default();
    if let Some(f) = &rpr.run_fonts {
        theme::apply_fonts(f, theme, &mut props);
    }
    if let Some(s) = &rpr.shading {
        props.shading = theme::shading(s, theme);
    }
    if let Some(b) = &rpr.bold {
        props.bold = Some(on(&b.val));
    }
    if let Some(i) = &rpr.italic {
        props.italic = Some(on(&i.val));
    }
    if let Some(v) = &rpr.caps {
        props.caps = Some(on(&v.val));
    }
    if let Some(v) = &rpr.small_caps {
        props.small_caps = Some(on(&v.val));
    }
    if let Some(v) = &rpr.strike {
        props.strike = Some(on(&v.val));
    }
    if let Some(c) = &rpr.color {
        theme::apply_color(c, theme, &mut props);
    }
    if let Some(sz) = &rpr.font_size {
        props.size_half_pts = hps(&sz.val);
    }
    if let Some(u) = &rpr.underline {
        props.underline = Some(underline_on(u));
    }
    if let Some(v) = &rpr.vertical_text_alignment {
        props.vert_align = Some(vert_align(&v.val));
    }
    if let Some(p) = &rpr.position {
        props.baseline_half_pts = signed_hps(&p.val);
    }
    if let Some(sp) = &rpr.spacing {
        props.spacing_twips = Some(sp.val);
    }
    props
}

// ---------------------------------------------------------------------------
// Paragraph properties (shared by w:pPr and w:style/w:pPr — same field types)

/// A paragraph's `w:keepNext`, `w:keepLines` and `w:widowControl`, each
/// `None` when absent and its `w:val` when present (`w:val="0"` turns an
/// inherited one off).
struct Keeps {
    next: Option<bool>,
    lines: Option<bool>,
    widow_control: Option<bool>,
    /// `w:contextualSpacing` (it rides here to keep `para_props` short).
    contextual_spacing: Option<bool>,
}

fn para_props(
    justification: &Option<wml::Justification>,
    indentation: &Option<wml::Indentation>,
    spacing: &Option<wml::SpacingBetweenLines>,
    keeps: Keeps,
    page_break_before: Option<bool>,
    tabs: &Option<wml::Tabs>,
) -> ParaProps {
    let mut p = ParaProps::default();
    if let Some(j) = justification {
        p.justification = map_justification(&j.val);
    }
    if let Some(ind) = indentation {
        p.left_indent = ind.left.as_ref().or(ind.start.as_ref()).and_then(stwips);
        p.right_indent = ind.right.as_ref().or(ind.end.as_ref()).and_then(stwips);
        p.first_line_indent = ind.first_line.as_ref().and_then(twips_u);
        p.hanging_indent = ind.hanging.as_ref().and_then(stwips);
    }
    if let Some(sp) = spacing {
        p.space_before = sp.before.as_ref().and_then(stwips);
        p.space_after = sp.after.as_ref().and_then(stwips);
        if let Some(value) = sp.line.as_ref().and_then(stwips) {
            use wml::LineSpacingRuleValues as R;
            p.line_spacing = Some(LineSpacing {
                value,
                rule: match sp.line_rule {
                    Some(R::Exact) => LineRule::Exact,
                    Some(R::AtLeast) => LineRule::AtLeast,
                    _ => LineRule::Auto,
                },
            });
        }
    }
    if keeps.next == Some(true) {
        p.keep_next = Some(true);
    }
    p.keep_lines = keeps.lines;
    p.widow_control = keeps.widow_control;
    p.contextual_spacing = keeps.contextual_spacing;
    p.page_break_before = page_break_before;
    if let Some(t) = tabs {
        for ts in &t.tab_stop {
            // A "clear" stop (alignment `None`) removes the inherited stop at
            // its position; the lowering merges the chain.
            if let Some(position) = stwips(&ts.position) {
                p.tabs.push(TabStop {
                    position,
                    alignment: tab_alignment(&ts.val),
                    leader: ts.leader.as_ref().and_then(tab_leader),
                });
            }
        }
    }
    p
}

fn map_section(sp: &wml::SectionProperties) -> Section {
    let mut s = Section::default();
    if let Some(t) = &sp.section_type {
        use wml::SectionMarkValues as M;
        s.kind = match t.val {
            M::NextPage => SectionKind::NextPage,
            M::Continuous => SectionKind::Continuous,
            M::EvenPage => SectionKind::EvenPage,
            M::OddPage => SectionKind::OddPage,
            M::NextColumn => SectionKind::NextColumn,
        };
    }
    if let Some(ps) = &sp.page_size {
        if let Some(w) = ps.width.as_ref().and_then(twips_u) {
            s.page_width = w;
        }
        if let Some(h) = ps.height.as_ref().and_then(twips_u) {
            s.page_height = h;
        }
    }
    if let Some(pm) = &sp.page_margin {
        if let Some(v) = pm.top.as_ref().and_then(stwips) {
            s.margin_top = v;
        }
        if let Some(v) = pm.bottom.as_ref().and_then(stwips) {
            s.margin_bottom = v;
        }
        if let Some(v) = pm.left.as_ref().and_then(twips_u) {
            s.margin_left = v;
        }
        if let Some(v) = pm.right.as_ref().and_then(twips_u) {
            s.margin_right = v;
        }
        s.header_distance = pm.header.as_ref().and_then(twips_u);
        s.footer_distance = pm.footer.as_ref().and_then(twips_u);
    }
    s.title_page = sp.title_page.as_ref().is_some_and(|t| on(&t.val));
    if let Some(n) = &sp.page_number_type {
        s.page_number_start = n.start;
        s.page_number_format = n.format.map(|f| f.to_string());
    }
    if let Some(f) = sp.footnote_properties.as_deref() {
        s.footnote_props = note_props(
            f.footnote_position.as_ref().map(|p| p.val.to_string()),
            f.numbering_format.as_ref(),
            f.numbering_start.as_ref(),
            f.numbering_restart.as_ref(),
        );
    }
    if let Some(e) = sp.endnote_properties.as_deref() {
        s.endnote_props = note_props(
            e.endnote_position.as_ref().map(|p| p.val.to_string()),
            e.numbering_format.as_ref(),
            e.numbering_start.as_ref(),
            e.numbering_restart.as_ref(),
        );
    }
    if let Some(cols) = &sp.columns {
        if let Some(n) = cols.column_count {
            s.columns = (n as u32).max(1);
        }
        if let Some(v) = cols.space.as_ref().and_then(twips_u) {
            s.column_space = v;
        }
        let equal = cols.equal_width.is_none() || on(&cols.equal_width);
        if !equal && !cols.column.is_empty() {
            s.column_widths = cols
                .column
                .iter()
                .map(|c| {
                    (
                        c.width.as_ref().and_then(stwips).unwrap_or(0),
                        c.space.as_ref().and_then(stwips).unwrap_or(0),
                    )
                })
                .collect();
            s.columns = s.column_widths.len() as u32;
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Value helpers

/// An `OnOff` toggle: absent `val` on a present element means "on".
fn on(v: &Option<OnOffValue>) -> bool {
    match v {
        Some(o) => matches!(
            o,
            OnOffValue::True | OnOffValue::On | OnOffValue::One | OnOffValue::Empty
        ),
        None => true,
    }
}

fn hps(v: &HpsMeasureValue) -> Option<u32> {
    match v {
        HpsMeasureValue::HalfPoints(n) => Some(*n as u32),
        HpsMeasureValue::UniversalMeasure(_) => None,
    }
}

/// Signed half-points (`w:position`), or `None` for a universal measure.
fn signed_hps(v: &SignedHpsMeasureValue) -> Option<i32> {
    match v {
        SignedHpsMeasureValue::HalfPoints(n) => Some(*n as i32),
        SignedHpsMeasureValue::UniversalMeasure(_) => None,
    }
}

fn stwips(v: &SignedTwipsMeasureValue) -> Option<i32> {
    match v {
        SignedTwipsMeasureValue::Twips(n) => Some(*n as i32),
        SignedTwipsMeasureValue::UniversalMeasure(_) => None,
    }
}

/// A cell margin (`w:tblCellMar` / `w:tcMar` child) in twips. Word writes
/// these as plain numbers with `w:type="dxa"`; a percentage or a
/// unit-suffixed measure is not carried.
fn margin_twips(v: &Option<MeasurementOrPercentValue>) -> Option<i32> {
    match v.as_ref()? {
        MeasurementOrPercentValue::DecimalNumberOrPercent(
            DecimalNumberOrPercentValue::DecimalNumber(n),
        ) => Some(*n as i32),
        _ => None,
    }
}

fn twips_u(v: &TwipsMeasureValue) -> Option<i32> {
    match v {
        TwipsMeasureValue::Twips(n) => Some(*n as i32),
        TwipsMeasureValue::UniversalMeasure(_) => None,
    }
}

/// `w:u` is "on" unless it explicitly says `val="none"`. A present `<w:u/>` with
/// no `val`, or any real underline style (single/double/…), reads as on.
fn underline_on(u: &wml::Underline) -> bool {
    !matches!(u.val, Some(wml::UnderlineValues::None))
}

/// `w:tab/@w:val` -> a paged tab alignment string, or `None` for `clear`.
fn tab_alignment(v: &wml::TabStopValues) -> Option<String> {
    use wml::TabStopValues as T;
    Some(
        match v {
            T::Left | T::Start | T::Number => "left",
            T::Center => "center",
            T::Right | T::End => "right",
            T::Decimal => "decimal",
            T::Bar => "bar",
            T::Clear => return None,
        }
        .to_string(),
    )
}

/// `w:tab/@w:leader` as the native leader string.
fn tab_leader(v: &wml::TabStopLeaderCharValues) -> Option<String> {
    use wml::TabStopLeaderCharValues as L;
    Some(
        match v {
            L::None => return None,
            L::Dot => ".",
            L::Hyphen => "-",
            L::Underscore | L::Heavy => "_",
            L::MiddleDot => "\u{B7}",
        }
        .to_string(),
    )
}

fn vert_align(v: &wml::VerticalPositionValues) -> VertAlign {
    match v {
        wml::VerticalPositionValues::Superscript => VertAlign::Superscript,
        wml::VerticalPositionValues::Subscript => VertAlign::Subscript,
        wml::VerticalPositionValues::Baseline => VertAlign::Baseline,
    }
}

fn map_justification(v: &wml::JustificationValues) -> Option<Justification> {
    use wml::JustificationValues as J;
    Some(match v {
        J::Left => Justification::Left,
        J::Start => Justification::Start,
        J::Center => Justification::Center,
        J::Right => Justification::Right,
        J::End => Justification::End,
        J::Both => Justification::Both,
        J::Distribute | J::ThaiDistribute => Justification::Distribute,
        _ => return None,
    })
}
