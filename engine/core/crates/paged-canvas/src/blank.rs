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

//! In-engine blank-document synthesis for File ▸ New.
//!
//! The wasm worker exposes no "new empty document" entry, and the only
//! IDML writer ([`idml_export::write_idml`]) *patches an existing
//! package* — so a brand-new document has nothing to patch. Rather than
//! hand-build the resolved [`paged_scene::Document`] graph (which would
//! also leave `source_idml` empty and break save-back), a blank document
//! is produced by emitting the smallest valid IDML *package* here — one
//! empty page at the requested size, with the default master / styles /
//! swatches a parsed IDML carries — and feeding it through the normal
//! [`crate::model::CanvasModel::load`] path. That reuses the real
//! parser and pipeline, so the document is well-formed and `source_idml`
//! is populated exactly as for an opened file.
//!
//! The package shape mirrors the editor's proven E2E fixture builder
//! (`tests/e2e/harness/build-min-idml.ts`) minus the page body. The ZIP
//! is assembled with the same `zip` crate the parser reads and the
//! writer emits — no hand-rolled archive.

/// IDML/OCF package mimetype. MUST be the first ZIP entry and STORED.
const MIME: &str = "application/vnd.adobe.indesign-idml-package";

const NS: &str = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging";

fn xml(body: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n{body}")
}

fn empty_pkg(tag: &str) -> String {
    xml(&format!(
        "<idPkg:{tag} xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\"/>"
    ))
}

fn container() -> String {
    xml(
        "<container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\" version=\"1.0\">\
<rootfiles><rootfile full-path=\"designmap.xml\" media-type=\"text/xml\"/></rootfiles></container>",
    )
}

fn graphic() -> String {
    xml(&format!(
        "<idPkg:Graphic xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\
<Color Self=\"Color/Black\" Model=\"Process\" Space=\"CMYK\" ColorValue=\"0 0 0 100\" Name=\"Black\"/>\
<Swatch Self=\"Swatch/None\" Name=\"None\"/></idPkg:Graphic>"
    ))
}

fn styles() -> String {
    xml(&format!(
        "<idPkg:Styles xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\
<RootCharacterStyleGroup Self=\"rcs\">\
<CharacterStyle Self=\"CharacterStyle/$ID/[No character style]\" Name=\"$ID/[No character style]\"/>\
</RootCharacterStyleGroup>\
<RootParagraphStyleGroup Self=\"rps\">\
<ParagraphStyle Self=\"ParagraphStyle/$ID/[No paragraph style]\" Name=\"$ID/[No paragraph style]\"/>\
</RootParagraphStyleGroup></idPkg:Styles>"
    ))
}

/// InDesign's default structure (engine ADR 1002): the `Root` tag, and the
/// back story's root element, so a new document is tag-ready the way one
/// made in InDesign is.
fn tags() -> String {
    xml(&format!(
        "<idPkg:Tags xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\
<XMLTag Self=\"XMLTag/Root\" Name=\"Root\"><Properties>\
<TagColor type=\"enumeration\">LightBlue</TagColor></Properties></XMLTag></idPkg:Tags>"
    ))
}

fn backing() -> String {
    xml(&format!(
        "<idPkg:BackingStory xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\
<XmlStory Self=\"backing\" UserText=\"true\">\
<ParagraphStyleRange AppliedParagraphStyle=\"ParagraphStyle/$ID/[No paragraph style]\">\
<CharacterStyleRange AppliedCharacterStyle=\"CharacterStyle/$ID/[No character style]\">\
<XMLElement Self=\"di2\" MarkupTag=\"XMLTag/Root\"/><Content>&#xFEFF;</Content>\
</CharacterStyleRange></ParagraphStyleRange></XmlStory></idPkg:BackingStory>"
    ))
}

fn designmap(name: &str, spread_ids: &[String]) -> String {
    let spreads: String = spread_ids
        .iter()
        .map(|id| format!("<idPkg:Spread src=\"Spreads/Spread_{id}.xml\"/>\n"))
        .collect();
    xml(&format!(
        "<?aid style=\"50\" type=\"document\" readerVersion=\"6.0\" featureSet=\"257\" product=\"20.0(32)\"?>\n\
<Document xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\" Self=\"d\" StoryList=\"\" Name=\"{name}\">\n\
<idPkg:Graphic src=\"Resources/Graphic.xml\"/>\n\
<idPkg:Fonts src=\"Resources/Fonts.xml\"/>\n\
<idPkg:Styles src=\"Resources/Styles.xml\"/>\n\
<idPkg:Preferences src=\"Resources/Preferences.xml\"/>\n\
<idPkg:Tags src=\"XML/Tags.xml\"/>\n\
<idPkg:MasterSpread src=\"MasterSpreads/MasterSpread_um.xml\"/>\n\
{spreads}<idPkg:BackingStory src=\"XML/BackingStory.xml\"/>\n\
</Document>"
    ))
}

fn master_spread(bounds: &str) -> String {
    xml(&format!(
        "<idPkg:MasterSpread xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\
<MasterSpread Self=\"um\" Name=\"A\">\
<Page Self=\"ump\" Name=\"A\" GeometricBounds=\"{bounds}\" ItemTransform=\"1 0 0 1 0 0\"/>\
</MasterSpread></idPkg:MasterSpread>"
    ))
}

/// One page of a blank spread: its id, its name (the folio) and its x in
/// the spread (`-width` for a left-hand page, IDML's spine at x = 0).
struct BlankPage {
    id: String,
    name: u32,
    x: f32,
}

/// An empty spread of `pages` — the blank canvas. No page items. `y` is
/// where it sits on the pasteboard.
fn spread(id: &str, pages: &[BlankPage], bounds: &str, y: f32) -> String {
    let body: String = pages
        .iter()
        .map(|p| {
            format!(
                "<Page Self=\"{}\" Name=\"{}\" GeometricBounds=\"{bounds}\" \
ItemTransform=\"1 0 0 1 {} 0\" AppliedMaster=\"um\"/>\n",
                p.id, p.name, p.x
            )
        })
        .collect();
    xml(&format!(
        "<idPkg:Spread xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\n\
<Spread Self=\"{id}\" PageCount=\"{}\" ItemTransform=\"1 0 0 1 0 {y}\">\n\
{body}</Spread></idPkg:Spread>",
        pages.len()
    ))
}

/// The gap between two blank spreads on the pasteboard, pt (the one
/// `InsertPage` stacks a new spread with).
const SPREAD_GAP_PT: f32 = 72.0;

/// The spreads of a blank document of `pages` pages (engine ADR 1307): one
/// page per spread, or, with `facing`, page 1 alone as a right-hand page
/// and then left/right pairs, as InDesign lays out a facing-pages
/// document. Ids: `us`/`usp` for the first spread and page (as before),
/// `us<n>`/`usp<n>` for the others.
fn blank_spreads(width_pt: f32, pages: u32, facing: bool) -> Vec<(String, Vec<BlankPage>)> {
    let page = |n: u32, x: f32| BlankPage {
        id: if n == 1 {
            "usp".to_string()
        } else {
            format!("usp{n}")
        },
        name: n,
        x,
    };
    let spread_id = |k: usize| {
        if k == 0 {
            "us".to_string()
        } else {
            format!("us{}", k + 1)
        }
    };
    let mut out: Vec<(String, Vec<BlankPage>)> = Vec::new();
    let pages = pages.max(1);
    if !facing {
        for n in 1..=pages {
            out.push((spread_id(out.len()), vec![page(n, 0.0)]));
        }
        return out;
    }
    out.push((spread_id(0), vec![page(1, 0.0)]));
    let mut n = 2;
    while n <= pages {
        let mut pair = vec![page(n, -width_pt)];
        if n < pages {
            pair.push(page(n + 1, 0.0));
        }
        out.push((spread_id(out.len()), pair));
        n += 2;
    }
    out
}

/// Build the bytes of a blank single-page IDML package sized
/// `width_pt` × `height_pt` (points).
///
/// `GeometricBounds` is InDesign's "y0 x0 y1 x1" order, so a
/// `[width, height]` page is `0 0 height width`. The returned bytes
/// parse through [`paged_scene::Document::open`] like any opened file.
pub fn blank_idml(width_pt: f32, height_pt: f32) -> Vec<u8> {
    blank_idml_layout(width_pt, height_pt, 1, false)
}

/// [`blank_idml`] with `pages` pages (at least one), laid out as facing
/// spreads when `facing` (engine ADR 1307): `FacingPages="true"` in the
/// document's preferences, page 1 alone as a right-hand page, then
/// left/right pairs — each page binding on the spine between them.
pub fn blank_idml_layout(width_pt: f32, height_pt: f32, pages: u32, facing: bool) -> Vec<u8> {
    let bounds = format!("0 0 {height_pt} {width_pt}");
    let spreads = blank_spreads(width_pt, pages, facing);
    let ids: Vec<String> = spreads.iter().map(|(id, _)| id.clone()).collect();
    let designmap = designmap("Untitled.indd", &ids);
    let master = master_spread(&bounds);
    let page_count = spreads.iter().map(|(_, p)| p.len()).sum::<usize>();

    // mimetype first + STORED (OCF convention). In-memory writes are
    // infallible; `expect` documents that invariant rather than threading
    // a Result through a deterministic builder.
    let mut zip = paged_ocf::OcfZip::new(MIME.as_bytes()).expect("zip mimetype");
    let mut put = |name: &str, body: &str, stored_entry: bool| {
        zip.put(name, body.as_bytes(), stored_entry)
            .expect("zip part");
    };
    put("designmap.xml", &designmap, false);
    put("META-INF/container.xml", &container(), false);
    put("Resources/Graphic.xml", &graphic(), false);
    put("Resources/Fonts.xml", &empty_pkg("Fonts"), false);
    put("Resources/Styles.xml", &styles(), false);
    // The document's setup in InDesign's spelling (A-33): without a
    // `<DocumentPreference>` InDesign opens the blank with ITS default
    // document size (Letter, measured on 20.0.1) beside the page's own
    // 400 x 300 pt, so every page added there came out Letter. Single
    // pages or facing spreads as asked (engine ADR 1307; the master is one
    // page either way), no bleed. Then the one text
    // preference the engine composes under: no optical sizing
    // (InDesign's application default re-instances variable fonts by
    // point size — see `paged_gen::builders::resources::preferences_xml`).
    put(
        "Resources/Preferences.xml",
        &xml(&format!(
            "<idPkg:Preferences xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\
<DocumentPreference PageHeight=\"{height_pt}\" PageWidth=\"{width_pt}\" PagesPerDocument=\"{page_count}\" \
FacingPages=\"{facing}\" DocumentBleedTopOffset=\"0\" DocumentBleedBottomOffset=\"0\" \
DocumentBleedInsideOrLeftOffset=\"0\" DocumentBleedOutsideOrRightOffset=\"0\" \
DocumentBleedUniformSize=\"true\" SlugTopOffset=\"0\" SlugBottomOffset=\"0\" \
SlugInsideOrLeftOffset=\"0\" SlugRightOrOutsideOffset=\"0\" DocumentSlugUniformSize=\"false\" \
PageBinding=\"LeftToRight\" ColumnDirection=\"Horizontal\" Intent=\"PrintIntent\"/>\
<TextPreference UseOpticalSize=\"false\"/></idPkg:Preferences>"
        )),
        false,
    );
    put("MasterSpreads/MasterSpread_um.xml", &master, false);
    for (k, (id, pages)) in spreads.iter().enumerate() {
        let y = k as f32 * (height_pt + SPREAD_GAP_PT);
        put(
            &format!("Spreads/Spread_{id}.xml"),
            &spread(id, pages, &bounds, y),
            false,
        );
    }
    put("XML/Tags.xml", &tags(), false);
    put("XML/BackingStory.xml", &backing(), false);

    zip.finish().expect("zip finish")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_idml_parses_to_one_page() {
        let bytes = blank_idml(612.0, 792.0);
        let doc = idml_import::import_idml(&bytes)
            .expect("blank IDML must parse")
            .0;
        // One spread, one page, no stories (truly empty body).
        assert_eq!(doc.spreads.len(), 1);
        assert_eq!(doc.spreads[0].spread.pages.len(), 1);
        assert!(doc.stories.is_empty());
    }

    /// Engine ADR 1002 — InDesign's default structure: the `Root` tag and
    /// the root element.
    #[test]
    fn blank_idml_is_tag_ready() {
        let doc = idml_import::import_idml(&blank_idml(612.0, 792.0))
            .unwrap()
            .0;
        assert_eq!(doc.designmap.xml_tags.len(), 1);
        assert_eq!(doc.designmap.xml_tags[0].name, "Root");
        let root = doc.designmap.xml_root.as_ref().unwrap();
        assert_eq!(root.tag, "XMLTag/Root");
        assert!(root.children.is_empty());
    }

    /// A-33 — the document's setup is the page's: InDesign reads the
    /// document size and single pages from `<DocumentPreference>`.
    #[test]
    fn blank_idml_states_its_document_setup() {
        let doc = idml_import::import_idml(&blank_idml(400.0, 300.0))
            .expect("blank IDML must parse")
            .0;
        let dp = &doc.designmap.document_preference;
        assert_eq!(dp.page_width, Some(400.0));
        assert_eq!(dp.page_height, Some(300.0));
        assert_eq!(dp.facing_pages, Some(false));
    }

    /// Engine ADR 1307 — a facing-pages blank: page 1 alone on the right
    /// of the spine, then left/right pairs, each spread below the last on
    /// the pasteboard, and `FacingPages="true"`.
    #[test]
    fn a_facing_blank_lays_its_pages_out_in_spreads() {
        let doc = idml_import::import_idml(&blank_idml_layout(400.0, 300.0, 4, true))
            .expect("blank IDML must parse")
            .0;
        assert_eq!(doc.designmap.document_preference.facing_pages, Some(true));
        let spreads: Vec<Vec<(String, f32)>> = doc
            .spreads
            .iter()
            .map(|s| {
                s.spread
                    .pages
                    .iter()
                    .map(|p| {
                        let x = p.item_transform.map_or(0.0, |m| m[4]) + p.bounds.left;
                        (p.self_id.clone().unwrap_or_default(), x)
                    })
                    .collect()
            })
            .collect();
        assert_eq!(
            spreads,
            vec![
                vec![("usp".to_string(), 0.0)],
                vec![("usp2".to_string(), -400.0), ("usp3".to_string(), 0.0)],
                vec![("usp4".to_string(), -400.0)],
            ]
        );
        // Single pages: one spread each, as InsertPage makes them.
        let single = idml_import::import_idml(&blank_idml_layout(400.0, 300.0, 3, false))
            .unwrap()
            .0;
        assert_eq!(single.spreads.len(), 3);
        assert_eq!(
            single.designmap.document_preference.facing_pages,
            Some(false)
        );
    }
}
