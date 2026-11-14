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

//! The Typography Debugger's evidence (engine ADR 1308): every composed
//! line says what the composer had (the measure, the natural width, the
//! settings) and what it decided (the ratio, the spacing, the break, the
//! hyphen, the grid). A preview builds a copy and leaves the document, its
//! build, its history and its revision as they were.

use std::io::{Cursor, Write};

use paged_canvas::channel::Mutation;
use paged_canvas::line_evidence::{BreakKind, LineEvidenceQuery, LineEvidenceReport, Tightness};
use paged_canvas::{CanvasModel, CanvasOptions, ElementId};
use paged_mutate::{PropertyPath, Value};

const PKG: &str = r#"xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging""#;

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
  <RootCharacterStyleGroup Self="rc">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>
  </RootCharacterStyleGroup>
  <RootParagraphStyleGroup Self="rp">
    <ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]" PointSize="10" Leading="12" AppliedLanguage="$ID/English: USA"/>
    <ParagraphStyle Self="ParagraphStyle/Just" Name="Just" PointSize="10" Leading="12" Justification="LeftJustified" Hyphenation="true" AppliedLanguage="$ID/English: USA"/>
    <ParagraphStyle Self="ParagraphStyle/Grid" Name="Grid" PointSize="10" Leading="13" GridAlignment="AlignBaseline" AppliedLanguage="$ID/English: USA"/>
  </RootParagraphStyleGroup>
</idPkg:Styles>"#;

/// Justified, in a narrow frame, long words: loose lines and hyphens.
const JUSTIFIED: &str = "Typographers internationalize characteristically extraordinary paragraphs with considerable responsibility, and a narrow column makes every decision visible to the reader.";

fn story(id: &str, style: &str, text: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story {PKG} DOMVersion="20.0">
<Story Self="{id}"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/{style}"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>{text}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#
    )
}

fn package() -> Vec<u8> {
    let designmap = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="20.0" Self="d" {PKG}>
<idPkg:Styles src="Resources/Styles.xml"/>
<GridPreference BaselineStart="36" BaselineDivision="13" BaselineGridRelativeOption="TopOfPageOfBaselineGridRelativeOption"/>
<Layer Self="l1" Name="Layer 1" Visible="true" Locked="false" Printable="true"/>
<idPkg:Spread src="Spreads/Spread_s1.xml"/>
<idPkg:Story src="Stories/Story_sj.xml"/>
<idPkg:Story src="Stories/Story_sf.xml"/>
<idPkg:Story src="Stories/Story_ss.xml"/>
<idPkg:Story src="Stories/Story_so.xml"/>
<idPkg:Story src="Stories/Story_sg.xml"/>
</Document>"#
    );
    let frame = |id: &str, story: &str, bounds: &str| {
        format!(
            r#"<TextFrame Self="{id}" ParentStory="{story}" GeometricBounds="{bounds}" ItemTransform="1 0 0 1 0 0"/>"#
        )
    };
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread {PKG} DOMVersion="20.0">
<Spread Self="s1" PageCount="1" BindingLocation="0" ItemTransform="1 0 0 1 0 0">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
{}
{}
{}
{}
{}
</Spread></idPkg:Spread>"#,
        frame("fj", "sj", "36 36 400 126"),
        frame("ff", "sf", "36 160 200 400"),
        frame("fs", "ss", "36 440 200 490"),
        frame("fo", "so", "420 36 450 200"),
        frame("fg", "sg", "420 260 700 500"),
    );
    let sj = story("sj", "Just", JUSTIFIED);
    let sf = story(
        "sf",
        "$ID/[No paragraph style]",
        "First line\u{2028}second line",
    );
    let ss = story(
        "ss",
        "$ID/[No paragraph style]",
        "Donau\u{00AD}dampf\u{00AD}schiff\u{00AD}fahrt",
    );
    let so = story(
        "so",
        "$ID/[No paragraph style]",
        &"Overset text keeps going past the frame. ".repeat(8),
    );
    let sg = story(
        "sg",
        "Grid",
        "Lines on the baseline grid stand on it, one grid step apart.",
    );
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/vnd.adobe.indesign-idml-package")
            .unwrap();
        for (name, body) in [
            ("designmap.xml", designmap.as_str()),
            ("Resources/Styles.xml", STYLES),
            ("Spreads/Spread_s1.xml", spread.as_str()),
            ("Stories/Story_sj.xml", sj.as_str()),
            ("Stories/Story_sf.xml", sf.as_str()),
            ("Stories/Story_ss.xml", ss.as_str()),
            ("Stories/Story_so.xml", so.as_str()),
            ("Stories/Story_sg.xml", sg.as_str()),
        ] {
            zip.start_file(name, deflated).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

fn model() -> CanvasModel {
    CanvasModel::load(
        "typography",
        &package(),
        CanvasOptions {
            fonts: vec![include_bytes!("../../../../corpus/fonts/Inter.ttf").to_vec()],
            ..Default::default()
        },
    )
    .expect("load")
}

fn evidence(m: &CanvasModel, story: &str) -> LineEvidenceReport {
    m.line_evidence(&LineEvidenceQuery {
        story: story.into(),
        frame: None,
        range: None,
        preview: None,
    })
}

#[test]
fn a_justified_line_reports_its_measure_ratio_and_spacing() {
    let m = model();
    let r = evidence(&m, "sj");
    assert!(r.found && !r.preview);
    assert!(r.lines.len() > 3, "{:#?}", r.lines);
    let body = &r.lines[..r.lines.len() - 1];
    for line in &r.lines {
        assert!(line.justified, "{line:?}");
        assert_eq!(line.composer, "paragraph");
        // The measure is the frame's width (no insets, no indents).
        assert!((line.available - 90.0).abs() < 0.01, "{line:?}");
        assert!(line.natural > 0.0 && line.right > line.left);
    }
    // A justified line other than the last fills the measure: its spaces
    // were stretched past their natural width, the breaker's ratio says so.
    let stretched: Vec<_> = body
        .iter()
        .filter(|l| l.word_spacing.is_some_and(|w| w > 100.5))
        .collect();
    assert!(!stretched.is_empty(), "{body:#?}");
    for l in &stretched {
        assert!(l.ratio > 0.0, "{l:?}");
        assert!(l.natural < l.available, "{l:?}");
        assert!(
            matches!(
                l.tightness,
                Tightness::Normal | Tightness::Loose | Tightness::VeryLoose
            ),
            "{l:?}"
        );
    }
    // The paragraph's settings, as the composer read them.
    let p = &r.paragraphs[0];
    assert_eq!(p.justification, "LeftJustified");
    assert!(p.hyphenation);
    assert_eq!(p.word_spacing, [80.0, 100.0, 133.0]);
    // The story's last line ends it.
    assert_eq!(r.lines.last().unwrap().break_kind, BreakKind::StoryEnd);
    assert!(r.overset.is_none());
}

#[test]
fn a_hyphenated_break_names_its_word_and_the_points_it_had() {
    let m = model();
    let r = evidence(&m, "sj");
    let hyphenated: Vec<_> = r
        .lines
        .iter()
        .filter(|l| l.break_kind == BreakKind::Hyphen)
        .collect();
    assert!(!hyphenated.is_empty(), "{:#?}", r.lines);
    for line in hyphenated {
        let h = line.hyphenation.as_ref().expect("hyphenation evidence");
        let used = h.used.expect("the point used");
        assert!(h.points.contains(&used), "{h:?}");
        assert_eq!(used, line.end, "the line ends where the word broke");
        assert!(h.word_start < used);
        assert!(h.hyphenation_on);
    }
    // A word-space break names the next word's points, none used.
    let spaced = r
        .lines
        .iter()
        .find(|l| l.break_kind == BreakKind::WordSpace && l.hyphenation.is_some())
        .expect("a word-space break");
    assert_eq!(spaced.hyphenation.as_ref().unwrap().used, None);
}

#[test]
fn a_forced_break_and_a_discretionary_hyphen_are_named() {
    let m = model();
    let r = evidence(&m, "sf");
    assert_eq!(
        r.lines[0].break_kind,
        BreakKind::ForcedLineBreak,
        "{:#?}",
        r.lines
    );
    assert!(!r.lines[0].justified);
    assert_eq!(r.lines[0].ratio, 0.0);
    let r = evidence(&m, "ss");
    let soft = r
        .lines
        .iter()
        .find(|l| l.break_kind == BreakKind::DiscretionaryHyphen)
        .unwrap_or_else(|| panic!("{:#?}", r.lines));
    let h = soft.hyphenation.as_ref().unwrap();
    assert_eq!(h.word, "Donaudampfschifffahrt");
    assert!(h.points.contains(&h.used.unwrap()));
}

#[test]
fn an_overset_story_says_where_its_text_stops() {
    let m = model();
    let r = evidence(&m, "so");
    let last = r.lines.last().expect("lines");
    assert!(last.overset_after, "{last:?}");
    let overset = r.overset.as_ref().expect("overset");
    assert!(overset.characters > 0);
    assert!(overset.from >= last.end);
}

#[test]
fn a_line_on_the_baseline_grid_says_how_far_it_moved() {
    let m = model();
    let r = evidence(&m, "sg");
    assert!(!r.lines.is_empty());
    assert!(
        r.lines.iter().all(|l| l.grid_shift.is_some()),
        "{:#?}",
        r.lines
    );
    assert_eq!(r.paragraphs[0].grid_alignment, "AlignBaseline");
    let j = evidence(&m, "sj");
    assert!(j.lines.iter().all(|l| l.grid_shift.is_none()));
}

#[test]
fn a_frame_and_a_range_narrow_the_lines() {
    let m = model();
    let all = evidence(&m, "sj");
    let some = m.line_evidence(&LineEvidenceQuery {
        story: "sj".into(),
        frame: Some("fj".into()),
        range: Some((0, 20)),
        preview: None,
    });
    assert!(!some.lines.is_empty());
    assert!(some.lines.len() < all.lines.len());
    assert!(some.lines.iter().all(|l| l.start <= 20));
    let none = m.line_evidence(&LineEvidenceQuery {
        story: "nope".into(),
        frame: None,
        range: None,
        preview: None,
    });
    assert!(!none.found && none.lines.is_empty());
}

fn tracking(value: f32) -> Mutation {
    Mutation::SetElementProperty {
        element_id: ElementId::StoryRange {
            story_id: "sj".into(),
            start: 0,
            end: JUSTIFIED.chars().count() as u32,
            cell: None,
            paragraph: None,
        },
        path: PropertyPath::CharacterTracking,
        value: Value::Length(Some(value)),
    }
}

#[test]
fn a_preview_recomposes_a_copy_and_changes_nothing() {
    let m = model();
    let before = evidence(&m, "sj");
    let state = (
        m.current_state_hash(),
        m.applied_log_len(),
        m.document_revision(),
    );
    let preview = m.line_evidence(&LineEvidenceQuery {
        story: "sj".into(),
        frame: None,
        range: None,
        preview: Some(tracking(-60.0)),
    });
    assert!(preview.preview, "{:?}", preview.refused);
    assert_eq!(preview.refused, None);
    // Tighter tracking sets the same text narrower: the lines change.
    let widths = |r: &LineEvidenceReport| r.lines.iter().map(|l| l.end).collect::<Vec<_>>();
    assert_ne!(widths(&preview), widths(&before), "{:#?}", preview.lines);
    // The document, its history and its revision are as they were, and so
    // is the evidence read from it.
    assert_eq!(
        state,
        (
            m.current_state_hash(),
            m.applied_log_len(),
            m.document_revision()
        )
    );
    assert_eq!(evidence(&m, "sj"), before);
    // Applying the write is an ordinary write: one undo step, and the
    // document's evidence is then the preview's.
    let mut m = m;
    m.apply_mutation(&tracking(-60.0)).expect("apply");
    assert_eq!(m.applied_log_len(), state.1 + 1);
    let applied = evidence(&m, "sj");
    assert_eq!(widths(&applied), widths(&preview));
}

#[test]
fn a_write_that_is_not_a_property_is_not_previewed() {
    let m = model();
    let r = m.line_evidence(&LineEvidenceQuery {
        story: "sj".into(),
        frame: None,
        range: None,
        preview: Some(Mutation::InsertText {
            story_id: "sj".into(),
            offset: 0,
            text: "x".into(),
            cell: None,
        }),
    });
    assert!(!r.preview);
    assert_eq!(r.refused.as_deref(), Some("unsupported"));
    assert!(!r.lines.is_empty(), "the document's own lines");
}
