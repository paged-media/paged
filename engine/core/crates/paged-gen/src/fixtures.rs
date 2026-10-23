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

//! Small test packages built in code, for tests that need a document
//! shape no sample renders (they have no reference PDF and no page in the
//! fidelity corpus).

use std::io::Write;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const NS: &str = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging";

fn part(tag: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<idPkg:{tag} xmlns:idPkg=\"{NS}\" DOMVersion=\"20.0\">\n{body}\n</idPkg:{tag}>"
    )
}

fn story(id: &str, inner: &str) -> String {
    part(
        "Story",
        &format!(
            "<Story Self=\"{id}\" AppliedTOCStyle=\"n\">\n\
<StoryPreference OpticalMarginAlignment=\"false\" OpticalMarginSize=\"12\"/>\n{inner}\n</Story>"
        ),
    )
}

fn plain(text: &str) -> String {
    format!(
        "<ParagraphStyleRange AppliedParagraphStyle=\"ParagraphStyle/$ID/NormalParagraphStyle\">\
<CharacterStyleRange AppliedCharacterStyle=\"CharacterStyle/$ID/[No character style]\" PointSize=\"18\">\
<Content>{text}</Content></CharacterStyleRange></ParagraphStyleRange>"
    )
}

/// Engine ADR 1002 — a one-page document tagged the way a template made in
/// InDesign is: the story of the text frame `tfHead` tagged `Headline`
/// (attributes `label`, `maxLength`, `required` on the story's element),
/// the graphic frame `rPhoto` tagged `Photo` (attribute `label`), the story
/// of `tfBody` tagged `Letter` with two of its ranges tagged, `Name`
/// ("Ada", attribute `label`) and `Price` ("9.99", attribute `maxLength`),
/// a parent-page text frame's story tagged `Folio`, and the untagged
/// graphic frame `rLogo` named `logo`.
pub fn tagged_template_idml() -> Vec<u8> {
    let designmap = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<?aid style=\"50\" type=\"document\" readerVersion=\"6.0\" featureSet=\"257\" product=\"20.0(32)\"?>\n\
<Document xmlns:idPkg=\"http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging\" DOMVersion=\"20.0\" Self=\"d\" StoryList=\"sHead sBody sFolio\">\n\
<idPkg:Graphic src=\"Resources/Graphic.xml\"/>\n\
<idPkg:Styles src=\"Resources/Styles.xml\"/>\n\
<idPkg:Tags src=\"XML/Tags.xml\"/>\n\
<idPkg:MasterSpread src=\"MasterSpreads/MasterSpread_um.xml\"/>\n\
<idPkg:Spread src=\"Spreads/Spread_us.xml\"/>\n\
<idPkg:BackingStory src=\"XML/BackingStory.xml\"/>\n\
<idPkg:Story src=\"Stories/Story_sHead.xml\"/>\n\
<idPkg:Story src=\"Stories/Story_sBody.xml\"/>\n\
<idPkg:Story src=\"Stories/Story_sFolio.xml\"/>\n\
</Document>";
    let graphic = part(
        "Graphic",
        "<Color Self=\"Color/Black\" Model=\"Process\" Space=\"CMYK\" ColorValue=\"0 0 0 100\" Name=\"Black\"/>\n\
<Swatch Self=\"Swatch/None\" Name=\"None\"/>",
    );
    let styles = part(
        "Styles",
        "<RootCharacterStyleGroup Self=\"rcs\"><CharacterStyle Self=\"CharacterStyle/$ID/[No character style]\" Name=\"$ID/[No character style]\"/></RootCharacterStyleGroup>\n\
<RootParagraphStyleGroup Self=\"rps\"><ParagraphStyle Self=\"ParagraphStyle/$ID/NormalParagraphStyle\" Name=\"$ID/NormalParagraphStyle\"/></RootParagraphStyleGroup>",
    );
    let tags = part(
        "Tags",
        "<XMLTag Self=\"XMLTag/Root\" Name=\"Root\"><Properties><TagColor type=\"enumeration\">LightBlue</TagColor></Properties></XMLTag>\n\
<XMLTag Self=\"XMLTag/Headline\" Name=\"Headline\"><Properties><TagColor type=\"enumeration\">Red</TagColor></Properties></XMLTag>\n\
<XMLTag Self=\"XMLTag/Photo\" Name=\"Photo\"><Properties><TagColor type=\"enumeration\">Green</TagColor></Properties></XMLTag>\n\
<XMLTag Self=\"XMLTag/Letter\" Name=\"Letter\"/>\n\
<XMLTag Self=\"XMLTag/Name\" Name=\"Name\"/>\n\
<XMLTag Self=\"XMLTag/Price\" Name=\"Price\"/>\n\
<XMLTag Self=\"XMLTag/Folio\" Name=\"Folio\"/>",
    );
    let backing = part(
        "BackingStory",
        "<XmlStory Self=\"ub1\" UserText=\"true\">\
<ParagraphStyleRange AppliedParagraphStyle=\"ParagraphStyle/$ID/NormalParagraphStyle\">\
<CharacterStyleRange AppliedCharacterStyle=\"CharacterStyle/$ID/[No character style]\">\n\
<XMLElement Self=\"di2\" MarkupTag=\"XMLTag/Root\">\n\
<XMLElement Self=\"di2i3\" MarkupTag=\"XMLTag/Headline\" XMLContent=\"sHead\"/>\n\
<XMLElement Self=\"di2i4\" MarkupTag=\"XMLTag/Photo\" XMLContent=\"rPhoto\">\
<XMLAttribute Self=\"di2i4XMLAttributenlabel\" Name=\"label\" Value=\"Product photo\"/></XMLElement>\n\
<XMLElement Self=\"di2i5\" MarkupTag=\"XMLTag/Letter\" XMLContent=\"sBody\"/>\n\
<XMLElement Self=\"di2i6\" MarkupTag=\"XMLTag/Folio\" XMLContent=\"sFolio\"/>\n\
</XMLElement><Content>&#xFEFF;</Content></CharacterStyleRange></ParagraphStyleRange></XmlStory>",
    );
    let master = part(
        "MasterSpread",
        "<MasterSpread Self=\"um\" Name=\"A-Parent\" NamePrefix=\"A\" BaseName=\"Parent\" PageCount=\"1\" ItemTransform=\"1 0 0 1 0 0\">\n\
<Page Self=\"ump\" Name=\"A\" GeometricBounds=\"0 0 600 400\" ItemTransform=\"1 0 0 1 0 0\"/>\n\
<TextFrame Self=\"tfFolio\" ParentStory=\"sFolio\" ContentType=\"TextType\" ItemTransform=\"1 0 0 1 0 0\">\
<Properties><PathGeometry><GeometryPathType PathOpen=\"false\"><PathPointArray>\
<PathPointType Anchor=\"20 560\" LeftDirection=\"20 560\" RightDirection=\"20 560\"/>\
<PathPointType Anchor=\"20 590\" LeftDirection=\"20 590\" RightDirection=\"20 590\"/>\
<PathPointType Anchor=\"380 590\" LeftDirection=\"380 590\" RightDirection=\"380 590\"/>\
<PathPointType Anchor=\"380 560\" LeftDirection=\"380 560\" RightDirection=\"380 560\"/>\
</PathPointArray></GeometryPathType></PathGeometry></Properties></TextFrame>\n\
</MasterSpread>",
    );
    let frame = |kind: &str, attrs: &str, t: f32, l: f32, b: f32, r: f32| {
        format!(
            "<{kind} {attrs} ContentType=\"{content}\" ItemTransform=\"1 0 0 1 0 0\">\
<Properties><PathGeometry><GeometryPathType PathOpen=\"false\"><PathPointArray>\
<PathPointType Anchor=\"{l} {t}\" LeftDirection=\"{l} {t}\" RightDirection=\"{l} {t}\"/>\
<PathPointType Anchor=\"{l} {b}\" LeftDirection=\"{l} {b}\" RightDirection=\"{l} {b}\"/>\
<PathPointType Anchor=\"{r} {b}\" LeftDirection=\"{r} {b}\" RightDirection=\"{r} {b}\"/>\
<PathPointType Anchor=\"{r} {t}\" LeftDirection=\"{r} {t}\" RightDirection=\"{r} {t}\"/>\
</PathPointArray></GeometryPathType></PathGeometry></Properties></{kind}>",
            content = if kind == "TextFrame" {
                "TextType"
            } else {
                "GraphicType"
            },
        )
    };
    let spread = part(
        "Spread",
        &format!(
            "<Spread Self=\"us\" PageCount=\"1\" ItemTransform=\"1 0 0 1 0 0\">\n\
<Page Self=\"usp\" Name=\"1\" GeometricBounds=\"0 0 600 400\" ItemTransform=\"1 0 0 1 0 0\" AppliedMaster=\"um\"/>\n\
{}\n{}\n{}\n{}\n</Spread>",
            frame("TextFrame", "Self=\"tfHead\" ParentStory=\"sHead\"", 20.0, 20.0, 80.0, 380.0),
            frame("Rectangle", "Self=\"rPhoto\"", 100.0, 20.0, 300.0, 380.0),
            frame("TextFrame", "Self=\"tfBody\" ParentStory=\"sBody\"", 320.0, 20.0, 500.0, 380.0),
            frame("Rectangle", "Self=\"rLogo\" Name=\"logo\"", 510.0, 20.0, 550.0, 120.0),
        ),
    );
    let head = story(
        "sHead",
        &format!(
            "<XMLElement Self=\"di2i3\" MarkupTag=\"XMLTag/Headline\" XMLContent=\"sHead\">\
<XMLAttribute Self=\"di2i3XMLAttributenlabel\" Name=\"label\" Value=\"Headline\"/>\
<XMLAttribute Self=\"di2i3XMLAttributenmaxLength\" Name=\"maxLength\" Value=\"40\"/>\
<XMLAttribute Self=\"di2i3XMLAttributenrequired\" Name=\"required\" Value=\"true\"/>\n{}\n</XMLElement>",
            plain("Summer Sale")
        ),
    );
    let body = story(
        "sBody",
        "<XMLElement Self=\"di2i5\" MarkupTag=\"XMLTag/Letter\" XMLContent=\"sBody\">\n\
<ParagraphStyleRange AppliedParagraphStyle=\"ParagraphStyle/$ID/NormalParagraphStyle\">\
<CharacterStyleRange AppliedCharacterStyle=\"CharacterStyle/$ID/[No character style]\" PointSize=\"14\">\
<Content>Dear </Content>\
<XMLElement Self=\"di2i5i1\" MarkupTag=\"XMLTag/Name\">\
<XMLAttribute Self=\"di2i5i1XMLAttributenlabel\" Name=\"label\" Value=\"First name\"/>\
<Content>Ada</Content></XMLElement>\
<Content>, your price is </Content>\
<XMLElement Self=\"di2i5i2\" MarkupTag=\"XMLTag/Price\">\
<XMLAttribute Self=\"di2i5i2XMLAttributenmaxLength\" Name=\"maxLength\" Value=\"8\"/>\
<Content>9.99</Content></XMLElement>\
<Content> today.</Content></CharacterStyleRange></ParagraphStyleRange>\n</XMLElement>",
    );
    let folio = story(
        "sFolio",
        &format!(
            "<XMLElement Self=\"di2i6\" MarkupTag=\"XMLTag/Folio\" XMLContent=\"sFolio\">{}</XMLElement>",
            plain("Folio")
        ),
    );

    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(zip::DateTime::default());
    let deflated = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default());
    let mut put = |name: &str, body: &str, opts: SimpleFileOptions| {
        zip.start_file(name, opts).expect("zip start_file");
        zip.write_all(body.as_bytes()).expect("zip write_all");
    };
    put(
        "mimetype",
        "application/vnd.adobe.indesign-idml-package",
        stored,
    );
    put("designmap.xml", designmap, deflated);
    put("Resources/Graphic.xml", &graphic, deflated);
    put("Resources/Styles.xml", &styles, deflated);
    put("XML/Tags.xml", &tags, deflated);
    put("XML/BackingStory.xml", &backing, deflated);
    put("MasterSpreads/MasterSpread_um.xml", &master, deflated);
    put("Spreads/Spread_us.xml", &spread, deflated);
    put("Stories/Story_sHead.xml", &head, deflated);
    put("Stories/Story_sBody.xml", &body, deflated);
    put("Stories/Story_sFolio.xml", &folio, deflated);
    zip.finish().expect("zip finish").into_inner()
}
