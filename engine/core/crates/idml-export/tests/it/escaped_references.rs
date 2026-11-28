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

//! A name is text, and XML has to escape some of it. A style id, a
//! swatch, a font or a layer whose name holds `&`, `<`, `>`, `"` or `'`
//! is read into the model as that text and escaped once when written.
//! The model used to hold the escaped spelling and the writer escaped it
//! again, so `A &amp; B` left as `A &amp;amp; B` and the reference
//! pointed at nothing after one save.

use crate::pkg;

use idml_export::write_idml;

// The names as the model holds them.
const PARA_A: &str = "ParagraphStyle/A & B <x> \"q\" 's'";
const PARA_C: &str = "ParagraphStyle/C & D <y> \"r\" 't'";
const CHAR_A: &str = "CharacterStyle/Em & <b> \"q\" 's'";
const CHAR_C: &str = "CharacterStyle/Strong & <i> \"r\" 't'";
const COLOR_A: &str = "Color/R&D <1> \"red\" 'a'";
const COLOR_C: &str = "Color/R&D <2> \"blue\" 'b'";
const FONT_A: &str = "Font & Sons <Pro> \"A\" 'a'";
const FONT_C: &str = "Font & Daughters <Std> \"B\" 'b'";
const LAYER_A: &str = "u&<\"'a";
const LAYER_C: &str = "u&<\"'c";
const LAYER_A_NAME: &str = "Fore & <Back> \"q\" 's'";

/// `text` as it is spelled inside an attribute.
fn esc(text: &str) -> String {
    let settings = paged_fmt::xml::AttrEscape {
        apos: true,
        ..Default::default()
    };
    paged_fmt::xml::escape_attr_with(text, settings).into_owned()
}

/// The fixture as the writer leaves it. The hand-written package names
/// fonts and declares none, so its first save adds `Resources/Fonts.xml`;
/// every test starts from that settled package.
fn source() -> Vec<u8> {
    let raw = raw_source();
    let settled = write_idml(&pkg::open(&raw), &raw).expect("write");
    assert_well_formed(&settled);
    settled
}

fn raw_source() -> Vec<u8> {
    let pkg_ns = pkg::PKG;
    let designmap = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="20.0" Self="d1" {pkg_ns}>
<Layer Self="{}" Name="{}" Visible="true" Locked="false" Printable="true"/>
<Layer Self="{}" Name="Second" Visible="true" Locked="false" Printable="true"/>
<idPkg:Spread src="Spreads/Spread_s1.xml"/>
<idPkg:Story src="Stories/Story_st1.xml"/>
</Document>"#,
        esc(LAYER_A),
        esc(LAYER_A_NAME),
        esc(LAYER_C),
    );
    let styles = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles {pkg_ns} DOMVersion="20.0">
<RootCharacterStyleGroup Self="u9d"><CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/><CharacterStyle Self="{}" Name="Em"/><CharacterStyle Self="{}" Name="Strong"/></RootCharacterStyleGroup>
<RootParagraphStyleGroup Self="u9e"><ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/><ParagraphStyle Self="{}" Name="A"/><ParagraphStyle Self="{}" Name="C"/></RootParagraphStyleGroup>
</idPkg:Styles>"#,
        esc(CHAR_A),
        esc(CHAR_C),
        esc(PARA_A),
        esc(PARA_C),
    );
    let graphic = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic {pkg_ns} DOMVersion="20.0">
<Color Self="{}" Model="Process" Space="CMYK" ColorValue="0 100 100 0" Name="{}"/>
<Color Self="{}" Model="Process" Space="CMYK" ColorValue="100 100 0 0" Name="{}"/>
</idPkg:Graphic>"#,
        esc(COLOR_A),
        esc(&COLOR_A["Color/".len()..]),
        esc(COLOR_C),
        esc(&COLOR_C["Color/".len()..]),
    );
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread {pkg_ns} DOMVersion="20.0">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf1" ParentStory="st1" ItemLayer="{}" FillColor="{}" GeometricBounds="100 100 400 400" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
        esc(LAYER_A),
        esc(COLOR_A),
    );
    let story = pkg::story(&format!(
        r#"<ParagraphStyleRange AppliedParagraphStyle="{}"><CharacterStyleRange AppliedCharacterStyle="{}" AppliedFont="{}" FillColor="{}"><Content>Hello world</Content></CharacterStyleRange></ParagraphStyleRange>"#,
        esc(PARA_A),
        esc(CHAR_A),
        esc(FONT_A),
        esc(COLOR_A),
    ));
    pkg::package(&[
        ("designmap.xml", &designmap),
        ("Resources/Styles.xml", &styles),
        ("Resources/Graphic.xml", &graphic),
        ("Spreads/Spread_s1.xml", &spread),
        ("Stories/Story_st1.xml", &story),
    ])
}

/// The references of the fixture, as the model holds them:
/// `[paragraph style, character style, font, run fill, frame fill, frame layer]`.
fn references(doc: &paged_scene::Document) -> [Option<String>; 6] {
    let para = &doc.stories[0].story.paragraphs[0];
    let run = &para.runs[0];
    let frame = &doc.spreads[0].spread.text_frames[0];
    [
        para.paragraph_style.clone(),
        run.character_style.clone(),
        run.font.clone(),
        run.fill_color.clone(),
        frame.fill_color.clone(),
        frame.item_layer.clone(),
    ]
}

fn some(values: [&str; 6]) -> [Option<String>; 6] {
    values.map(|v| Some(v.to_string()))
}

/// Every XML part of `package` reads to its end with every attribute
/// well formed, and nothing in it is escaped twice.
fn assert_well_formed(package: &[u8]) {
    for name in pkg::names(package) {
        if !name.ends_with(".xml") {
            continue;
        }
        let body = pkg::entry(package, &name).expect("entry");
        for twice in [
            "&amp;amp;",
            "&amp;lt;",
            "&amp;gt;",
            "&amp;quot;",
            "&amp;apos;",
        ] {
            assert!(!body.contains(twice), "{name} holds {twice}:\n{body}");
        }
        let mut reader = quick_xml::Reader::from_str(&body);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Eof) => break,
                Ok(quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e)) => {
                    for a in e.attributes() {
                        let a = a.unwrap_or_else(|err| panic!("{name}: {err}\n{body}"));
                        a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .unwrap_or_else(|err| panic!("{name}: {err}\n{body}"));
                    }
                }
                Ok(_) => {}
                Err(err) => panic!("{name}: {err}\n{body}"),
            }
        }
    }
}

#[test]
fn names_with_markup_characters_are_read_as_text() {
    // Before a save and after one.
    for package in [raw_source(), source()] {
        names_are_text(&pkg::open(&package));
    }
    // The fonts part the first save wrote names the family as text too.
    let fonts = pkg::entry(&source(), "Resources/Fonts.xml").expect("fonts part");
    assert!(
        fonts.contains(&format!(r#"FontFamily="{}""#, esc(FONT_A))),
        "{fonts}"
    );
}

fn names_are_text(doc: &paged_scene::Document) {
    assert_eq!(
        references(doc),
        some([PARA_A, CHAR_A, FONT_A, COLOR_A, COLOR_A, LAYER_A])
    );
    assert!(doc.styles.paragraph_styles.contains_key(PARA_A));
    assert!(doc.styles.character_styles.contains_key(CHAR_C));
    assert!(doc.palette.colors.contains_key(COLOR_C));
    let layer = &doc.designmap.layers[0];
    assert_eq!(layer.self_id, LAYER_A);
    assert_eq!(layer.name.as_deref(), Some(LAYER_A_NAME));
}

#[test]
fn an_untouched_document_keeps_its_bytes() {
    let src = source();
    let out = write_idml(&pkg::open(&src), &src).expect("write");
    pkg::assert_same_package(&src, &out);
}

#[test]
fn an_edited_reference_is_escaped_once_and_reads_back() {
    let src = source();
    let mut doc = pkg::open(&src);
    {
        let para = &mut doc.stories[0].story.paragraphs[0];
        para.paragraph_style = Some(PARA_C.to_string());
        let run = &mut para.runs[0];
        run.character_style = Some(CHAR_C.to_string());
        run.font = Some(FONT_C.to_string());
        run.fill_color = Some(COLOR_C.to_string());
        let frame = &mut doc.spreads[0].spread.text_frames[0];
        frame.fill_color = Some(COLOR_C.to_string());
        frame.item_layer = Some(LAYER_C.to_string());
    }
    let edited = some([PARA_C, CHAR_C, FONT_C, COLOR_C, COLOR_C, LAYER_C]);
    let out = write_idml(&doc, &src).expect("write");
    assert_well_formed(&out);

    let story = pkg::entry(&out, "Stories/Story_st1.xml").expect("story part");
    assert!(
        story.contains(&format!(r#"AppliedParagraphStyle="{}""#, esc(PARA_C))),
        "{story}"
    );
    assert!(
        story.contains(&format!(r#"AppliedFont="{}""#, esc(FONT_C))),
        "{story}"
    );

    let back = pkg::open(&out);
    assert_eq!(references(&back), edited);
    // The definitions the references name are still there under the
    // same ids, and so are the ones nobody touched.
    for id in [PARA_A, PARA_C] {
        assert!(back.styles.paragraph_styles.contains_key(id), "{id}");
    }
    for id in [CHAR_A, CHAR_C] {
        assert!(back.styles.character_styles.contains_key(id), "{id}");
    }
    for id in [COLOR_A, COLOR_C] {
        assert!(back.palette.colors.contains_key(id), "{id}");
    }
    assert_eq!(back.designmap.layers[1].self_id, LAYER_C);

    // A second save of the reopened document changes nothing.
    let twice = write_idml(&back, &out).expect("write again");
    pkg::assert_same_package(&out, &twice);
}

#[test]
fn a_reference_the_source_spells_another_way_keeps_that_spelling() {
    // `&#38;` and a bare `'` are the same text as `&amp;` and `&apos;`;
    // a save that touches nothing must not respell them.
    let src = source();
    let respelled = {
        let story = pkg::entry(&src, "Stories/Story_st1.xml").expect("story");
        let story = story.replace(
            &format!(r#"AppliedFont="{}""#, esc(FONT_A)),
            r#"AppliedFont="Font &#38; Sons &lt;Pro&gt; &quot;A&quot; 'a'""#,
        );
        assert!(story.contains("&#38;"), "{story}");
        let mut parts: Vec<(String, String)> = pkg::names(&src)
            .into_iter()
            .filter(|n| n != "mimetype")
            .map(|n| {
                let body = pkg::entry(&src, &n).expect("entry");
                (n, body)
            })
            .collect();
        for (name, body) in &mut parts {
            if name == "Stories/Story_st1.xml" {
                *body = story.clone();
            }
        }
        let refs: Vec<(&str, &str)> = parts
            .iter()
            .map(|(n, b)| (n.as_str(), b.as_str()))
            .collect();
        pkg::package(&refs)
    };
    let doc = pkg::open(&respelled);
    assert_eq!(
        doc.stories[0].story.paragraphs[0].runs[0].font.as_deref(),
        Some(FONT_A)
    );
    let out = write_idml(&doc, &respelled).expect("write");
    pkg::assert_same_package(&respelled, &out);
}
