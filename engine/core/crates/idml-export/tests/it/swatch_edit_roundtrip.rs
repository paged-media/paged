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

//! A swatch the source declares follows the model. `Resources/Graphic.xml`
//! used to pass every existing `<Color>` / `<Tint>` / `<Gradient>` through
//! verbatim, so a recoloured or renamed swatch, a changed tint and a
//! gradient's edited stops were all dropped on export and the document
//! reopened with the old colours. An edit is now written in place, with
//! the attributes nobody models left as they were; a swatch nobody edited
//! keeps its bytes.

use crate::pkg;

use idml_export::write_idml;
use idml_import::graphic::{ColorSpace, GradientKind, GradientStopRef};

const GRAPHIC: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
	<Color Self="Color/Brand" Model="Process" Space="CMYK" ColorValue="0 85.5 90 5" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Brand" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937"/>
	<Color Self="Color/Ink" Model="Spot" Space="CMYK" ColorValue="100 70 0 10" AlternateSpace="CMYK" AlternateColorValue="100 70 0 10" Name="Ink 286" SwatchCreatorID="7937"/>
	<Tint Self="Tint/Ink20" BaseColor="Color/Ink" TintValue="20" Name="Ink 20%" SwatchCreatorID="7937"/>
	<Gradient Self="Gradient/Fade" Type="Linear" Name="Fade" ColorEditable="true" SwatchCreatorID="7937">
		<GradientStop Self="u1" StopColor="Color/Brand" Location="0"/>
		<GradientStop Self="u2" StopColor="Color/Ink" Location="100" Midpoint="50"/>
	</Gradient>
</idPkg:Graphic>"#;

fn source() -> Vec<u8> {
    pkg::package(&[
        ("designmap.xml", &pkg::designmap("")),
        ("Resources/Styles.xml", pkg::STYLES),
        ("Resources/Graphic.xml", GRAPHIC),
        ("Spreads/Spread_s1.xml", pkg::SPREAD),
        ("Stories/Story_st1.xml", &pkg::story(pkg::STORY_BODY)),
    ])
}

fn graphic(package: &[u8]) -> String {
    pkg::entry(package, "Resources/Graphic.xml").expect("graphic part")
}

#[test]
fn untouched_swatches_keep_their_bytes() {
    let src = source();
    let doc = pkg::open(&src);
    // The tint reads its channels and its spot model from its base.
    let tint = &doc.palette.colors["Tint/Ink20"];
    assert_eq!(tint.value, vec![100.0, 70.0, 0.0, 10.0]);
    assert_eq!(tint.tint, Some(20.0));
    let out = write_idml(&doc, &src).expect("write");
    pkg::assert_same_package(&src, &out);
}

#[test]
fn an_edited_colour_is_written_in_place() {
    let src = source();
    let mut doc = pkg::open(&src);
    {
        let brand = doc.palette.colors.get_mut("Color/Brand").expect("brand");
        brand.space = ColorSpace::Rgb;
        brand.value = vec![12.0, 200.0, 64.5];
        brand.name = Some("Brand & Co".to_string());
        doc.palette.colors.get_mut("Tint/Ink20").expect("tint").tint = Some(35.0);
    }
    let out = write_idml(&doc, &src).expect("write");
    let xml = graphic(&out);
    // In place, in the source's attribute order, the rest untouched.
    assert!(
        xml.contains(r#"<Color Self="Color/Brand" Model="Process" Space="RGB" ColorValue="12 200 64.5" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Brand &amp; Co" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937"/>"#),
        "{xml}"
    );
    // The tint changes its value only: its channels are its base's.
    assert!(
        xml.contains(r#"<Tint Self="Tint/Ink20" BaseColor="Color/Ink" TintValue="35" Name="Ink 20%" SwatchCreatorID="7937"/>"#),
        "{xml}"
    );
    // The swatch nobody edited keeps its line.
    assert!(
        xml.contains(r#"<Color Self="Color/Ink" Model="Spot" Space="CMYK" ColorValue="100 70 0 10" AlternateSpace="CMYK" AlternateColorValue="100 70 0 10" Name="Ink 286" SwatchCreatorID="7937"/>"#),
        "{xml}"
    );
    assert_eq!(xml.matches("<Color ").count(), 2, "{xml}");
    assert_eq!(xml.matches("<Tint ").count(), 1, "{xml}");

    let back = pkg::open(&out);
    let brand = &back.palette.colors["Color/Brand"];
    assert_eq!(brand.space, ColorSpace::Rgb);
    assert_eq!(brand.value, vec![12.0, 200.0, 64.5]);
    assert_eq!(brand.name.as_deref(), Some("Brand & Co"));
    assert_eq!(back.palette.colors["Tint/Ink20"].tint, Some(35.0));
    let twice = write_idml(&back, &out).expect("write again");
    pkg::assert_same_package(&out, &twice);
}

#[test]
fn an_edited_gradient_is_written_in_place() {
    let src = source();
    let mut doc = pkg::open(&src);
    {
        let fade = doc
            .palette
            .gradients
            .get_mut("Gradient/Fade")
            .expect("fade");
        fade.kind = GradientKind::Radial;
        fade.stops = vec![
            GradientStopRef::swatch("Color/Ink".to_string(), 0.0, None),
            GradientStopRef::swatch("Color/Brand".to_string(), 40.0, Some(30.0)),
            GradientStopRef::swatch("Color/Ink".to_string(), 100.0, None),
        ];
    }
    let out = write_idml(&doc, &src).expect("write");
    let xml = graphic(&out);
    assert!(
        xml.contains(r#"<Gradient Self="Gradient/Fade" Type="Radial" Name="Fade" ColorEditable="true" SwatchCreatorID="7937">"#),
        "{xml}"
    );
    assert_eq!(xml.matches("<Gradient ").count(), 1, "{xml}");
    assert_eq!(xml.matches("<GradientStop ").count(), 3, "{xml}");
    assert_eq!(xml.matches("</Gradient>").count(), 1, "{xml}");

    let back = pkg::open(&out);
    let fade = &back.palette.gradients["Gradient/Fade"];
    assert_eq!(fade.kind, GradientKind::Radial);
    let stops: Vec<(&str, f32, Option<f32>)> = fade
        .stops
        .iter()
        .map(|s| (s.stop_color.as_str(), s.location_pct, s.midpoint_pct))
        .collect();
    assert_eq!(
        stops,
        vec![
            ("Color/Ink", 0.0, None),
            ("Color/Brand", 40.0, Some(30.0)),
            ("Color/Ink", 100.0, None),
        ]
    );
    // The colours beside it were not touched.
    assert!(xml.contains(r#"ColorValue="0 85.5 90 5""#), "{xml}");
    let twice = write_idml(&back, &out).expect("write again");
    pkg::assert_same_package(&out, &twice);
}

#[test]
fn a_renamed_gradient_keeps_its_stops_as_written() {
    let src = source();
    let mut doc = pkg::open(&src);
    doc.palette
        .gradients
        .get_mut("Gradient/Fade")
        .expect("fade")
        .name = Some("Fade <2>".to_string());
    let out = write_idml(&doc, &src).expect("write");
    let xml = graphic(&out);
    assert!(xml.contains(r#"Name="Fade &lt;2&gt;""#), "{xml}");
    // The stops keep the source's own spelling, `Self` ids included.
    assert!(
        xml.contains(
            r#"<GradientStop Self="u2" StopColor="Color/Ink" Location="100" Midpoint="50"/>"#
        ),
        "{xml}"
    );
}
