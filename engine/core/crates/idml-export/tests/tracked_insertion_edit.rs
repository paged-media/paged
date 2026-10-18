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

//! A story carrying tracked changes takes edits (D-01).
//!
//! InDesign 20.0.1 writes a tracked insertion as a `<Change
//! ChangeType="InsertedText">` around its `<Content>` inside the character
//! range, and a deletion as a `<Change ChangeType="DeletedText">` holding
//! its own ranges (core `track-changes-probe`; this story is its export).
//! The parser reads the inserted text as the story's and keeps the deleted
//! text out. The writer treated the insertion's wrapper as foreign markup
//! and replayed the range verbatim, so an edit anywhere in it was lost on
//! save. Now the wrapper's start and end ride the run as pieces at their
//! character offsets: the edit is written, the inserted text stays
//! wrapped, and the deletion stays where it stood. InDesign reads the
//! saved package as format!("ZZ Alpha beta INSERTED {D}delta.") with both changes.

use idml_export::rewrite::rewrite_story;
use idml_import::parse_story;

/// The deletion's place in the model's text (D-01).
const D: char = paged_model::TRACKED_DELETION_MARKER;

const SRC: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
	<Story Self="udf">
		<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
			<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
				<Content>Alpha beta</Content>
				<Change Date="2026-10-18T05:38:08" ChangeType="InsertedText" UserName="$ID/Unknown User Name" AppliedDocumentUser="dDocumentUser0">
					<Content> INSERTED</Content>
				</Change>
				<Content> </Content>
				<Change Date="2026-10-18T05:38:08" ChangeType="DeletedText" UserName="$ID/Unknown User Name" AppliedDocumentUser="dDocumentUser0">
					<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
						<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
							<Content>gamma </Content>
						</CharacterStyleRange>
					</ParagraphStyleRange>
				</Change>
				<Content>delta.</Content>
			</CharacterStyleRange>
		</ParagraphStyleRange>
	</Story>
</idPkg:Story>"#;

/// The story with its single run's text replaced, saved and read back.
fn save_with(text: &str) -> String {
    let mut st = parse_story(SRC.as_bytes()).expect("parse");
    assert_eq!(
        st.paragraphs[0].runs[0].text,
        format!("Alpha beta INSERTED {D}delta.")
    );
    st.paragraphs[0].runs[0].text = text.replace('|', &D.to_string());
    String::from_utf8(rewrite_story(SRC.as_bytes(), &st).expect("rewrite")).expect("utf-8")
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn an_unmutated_save_is_identical() {
    let st = parse_story(SRC.as_bytes()).expect("parse");
    let out = rewrite_story(SRC.as_bytes(), &st).expect("rewrite");
    assert_eq!(String::from_utf8(out).unwrap(), SRC);
}

#[test]
fn an_edit_before_the_insertion_is_written_and_the_changes_stay() {
    let out = save_with("ZZ Alpha beta INSERTED |delta.");
    let flat = squash(&out);
    assert!(flat.contains("<Content>ZZ Alpha beta</Content>"), "{out}");
    assert!(
        flat.contains(r#"ChangeType="InsertedText" UserName="$ID/Unknown User Name" AppliedDocumentUser="dDocumentUser0"><Content> INSERTED</Content></Change>"#),
        "the insertion stays wrapped: {out}"
    );
    assert!(
        flat.contains("<Content>gamma </Content>"),
        "the deletion stays: {out}"
    );
    let back = parse_story(out.as_bytes()).expect("reparse");
    assert_eq!(
        back.paragraphs[0].runs[0].text,
        format!("ZZ Alpha beta INSERTED {D}delta.")
    );
}

#[test]
fn an_edit_inside_the_insertion_stays_inside_it() {
    let out = save_with("Alpha beta INSXERTED |delta.");
    let flat = squash(&out);
    assert!(
        flat.contains("<Content> INSXERTED</Content></Change>"),
        "{out}"
    );
    let back = parse_story(out.as_bytes()).expect("reparse");
    assert_eq!(
        back.paragraphs[0].runs[0].text,
        format!("Alpha beta INSXERTED {D}delta.")
    );
}

#[test]
fn removing_the_inserted_text_is_written() {
    // Which space the wrapper keeps is the diff's choice; the text and
    // the deletion are what must hold.
    let out = save_with("Alpha beta |delta.");
    assert!(!out.contains("INSERTED"), "{out}");
    assert!(out.contains("DeletedText"), "the deletion stays: {out}");
    let back = parse_story(out.as_bytes()).expect("reparse");
    assert_eq!(
        back.paragraphs[0].runs[0].text,
        format!("Alpha beta {D}delta.")
    );
}

#[test]
fn a_deletion_is_read_with_its_change() {
    let st = parse_story(SRC.as_bytes()).expect("parse");
    let d = &st.paragraphs[0].tracked_deletions;
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].change_type, "DeletedText");
    assert_eq!(d[0].user_name.as_deref(), Some("$ID/Unknown User Name"));
    assert_eq!(d[0].date.as_deref(), Some("2026-10-18T05:38:08"));
    assert_eq!(d[0].document_user.as_deref(), Some("dDocumentUser0"));
    assert_eq!(d[0].deleted_text.as_deref(), Some("gamma "));
}

#[test]
fn an_edit_writes_the_deletion_back_as_it_was() {
    let out = save_with("Alpha beta INSERTED |delta. More.");
    let source_change = &SRC[SRC
        .find(r#"<Change Date="2026-10-18T05:38:08" ChangeType="DeletedText""#)
        .unwrap()..];
    let source_change = &source_change[..source_change.find("</Change>").unwrap() + 9];
    assert!(out.contains(source_change), "{out}");
    let back = parse_story(out.as_bytes()).expect("reparse");
    assert_eq!(back.paragraphs[0].tracked_deletions.len(), 1);
}

#[test]
fn a_deletion_removed_from_the_model_is_not_written() {
    let mut st = parse_story(SRC.as_bytes()).expect("parse");
    st.paragraphs[0].runs[0].text = "Alpha beta INSERTED delta.".to_string();
    st.paragraphs[0].tracked_deletions.clear();
    let out = String::from_utf8(rewrite_story(SRC.as_bytes(), &st).expect("rewrite")).unwrap();
    assert!(!out.contains("DeletedText"), "{out}");
    assert!(!out.contains("gamma"), "{out}");
}
