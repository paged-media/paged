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

//! A placed PDF's `<PDFAttribute>`: the page a frame shows (`PageNumber`)
//! and the box it is cropped to (`PDFCrop`), engine ADR 1003.
//!
//! InDesign writes the element inside the `<PDF>`, after its
//! `<Properties>` and before its `<Link>`. A source element is patched in
//! place and keeps the bytes of every value it already says; a `<PDF>`
//! without one gains one when the model holds a value. Only frames the
//! model gives a `<PDFAttribute>` are touched (the importer reads every
//! one there is), so an unchanged import writes back byte for byte. A
//! frame whose picture is an `<Image>` (a PDF placed from bytes) has no
//! element to carry it: its page lives in the `.paged` model part only.

use std::collections::HashMap;
use std::io::Cursor;

use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::{Reader, Writer};

use idml_import::Spread;
use paged_model::PlacedPdf;

use crate::rewrite::{attr_value, emit_empty_with_attrs, patch_start, Patch};

fn is_host_name(name: &[u8]) -> bool {
    matches!(name, b"Rectangle" | b"Oval" | b"Polygon")
}

/// The attributes the model holds, in InDesign's order.
fn wanted(p: &PlacedPdf) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if let Some(n) = p.page_number {
        out.push(("PageNumber", n.to_string()));
    }
    if let Some(c) = &p.crop {
        out.push(("PDFCrop", c.clone()));
    }
    out
}

/// A source `<PDFAttribute>` brought in line with the model: a value it
/// spells differently is set, one the model clears is dropped, one it
/// lacks is appended. Verbatim when they agree.
fn patch(e: &BytesStart, p: &PlacedPdf) -> Result<BytesStart<'static>, quick_xml::Error> {
    let page_agrees = match (p.page_number, attr_value(e, b"PageNumber")) {
        (Some(n), Some(raw)) => raw.trim().parse::<u32>().ok() == Some(n),
        (None, None) => true,
        _ => false,
    };
    let crop_agrees = attr_value(e, b"PDFCrop") == p.crop;
    if page_agrees && crop_agrees {
        return Ok(e.clone().into_owned());
    }
    patch_start(
        e,
        |k, _| match k {
            b"PageNumber" if !page_agrees => Some(match p.page_number {
                Some(n) => Patch::Set(n.to_string()),
                None => Patch::Remove,
            }),
            b"PDFCrop" if !crop_agrees => Some(match &p.crop {
                Some(c) => Patch::Set(c.clone()),
                None => Patch::Remove,
            }),
            _ => None,
        },
        &wanted(p),
    )
}

fn write_new(writer: &mut Writer<Cursor<Vec<u8>>>, p: &PlacedPdf) -> Result<(), quick_xml::Error> {
    let attrs = wanted(p);
    if attrs.is_empty() {
        return Ok(());
    }
    emit_empty_with_attrs(writer, "PDFAttribute", &attrs)
}

/// Bring every `<PDF>`'s `<PDFAttribute>` in line with its frame's
/// [`PlacedPdf`].
pub(crate) fn rewrite_pdf_attributes(
    original: &[u8],
    spread: &Spread,
) -> Result<Vec<u8>, quick_xml::Error> {
    let mut specs: HashMap<&str, &PlacedPdf> = HashMap::new();
    let hosts = spread
        .rectangles
        .iter()
        .map(|r| (r.self_id.as_deref(), r.placed_pdf.as_ref()))
        .chain(
            spread
                .ovals
                .iter()
                .map(|o| (o.self_id.as_deref(), o.placed_pdf.as_ref())),
        )
        .chain(
            spread
                .polygons
                .iter()
                .map(|p| (p.self_id.as_deref(), p.placed_pdf.as_ref())),
        );
    for (id, placed) in hosts {
        if let (Some(id), Some(placed)) = (id, placed) {
            specs.insert(id, placed);
        }
    }
    if specs.is_empty() {
        return Ok(original.to_vec());
    }
    let mut reader = Reader::from_reader(original);
    let config = reader.config_mut();
    config.expand_empty_elements = false;
    config.trim_text(false);
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();
    let mut depth = 0usize;
    // The open host: its depth and the model's attribute.
    let mut host: Option<(usize, &PlacedPdf)> = None;
    // Inside the host's `<PDF>`: whether its `<PDFAttribute>` was written.
    let mut pdf_written: Option<bool> = None;
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Eof => break,
            Event::Start(e) => {
                depth += 1;
                let name = e.name().as_ref().to_vec();
                match (host, pdf_written) {
                    (None, _) if is_host_name(&name) => {
                        host = attr_value(&e, b"Self")
                            .and_then(|id| specs.get(id.as_str()).copied())
                            .map(|p| (depth, p));
                        writer.write_event(Event::Start(e.into_owned()))?;
                    }
                    (Some((d, _)), None) if name == b"PDF" && depth == d + 1 => {
                        pdf_written = Some(false);
                        writer.write_event(Event::Start(e.into_owned()))?;
                    }
                    (Some((d, p)), Some(false)) if depth == d + 2 => {
                        if name == b"PDFAttribute" {
                            pdf_written = Some(true);
                            writer.write_event(Event::Start(patch(&e, p)?))?;
                        } else {
                            if name == b"Link" {
                                write_new(&mut writer, p)?;
                                pdf_written = Some(true);
                            }
                            writer.write_event(Event::Start(e.into_owned()))?;
                        }
                    }
                    _ => writer.write_event(Event::Start(e.into_owned()))?,
                }
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_vec();
                match (host, pdf_written) {
                    (Some((d, p)), None) if name == b"PDF" && depth == d => {
                        // A self-closed `<PDF/>`: opened around its attribute.
                        let attrs = wanted(p);
                        if attrs.is_empty() {
                            writer.write_event(Event::Empty(e.into_owned()))?;
                        } else {
                            writer.write_event(Event::Start(e.borrow()))?;
                            write_new(&mut writer, p)?;
                            writer.write_event(Event::End(BytesEnd::new("PDF")))?;
                        }
                    }
                    (Some((d, p)), Some(false)) if depth == d + 1 => {
                        if name == b"PDFAttribute" {
                            pdf_written = Some(true);
                            writer.write_event(Event::Empty(patch(&e, p)?))?;
                        } else {
                            if name == b"Link" {
                                write_new(&mut writer, p)?;
                                pdf_written = Some(true);
                            }
                            writer.write_event(Event::Empty(e.into_owned()))?;
                        }
                    }
                    _ => writer.write_event(Event::Empty(e.into_owned()))?,
                }
            }
            Event::End(e) => {
                if let Some((d, p)) = host {
                    if pdf_written.is_some() && depth == d + 1 && e.name().as_ref() == b"PDF" {
                        if pdf_written == Some(false) {
                            write_new(&mut writer, p)?;
                        }
                        pdf_written = None;
                    } else if depth == d && is_host_name(e.name().as_ref()) {
                        host = None;
                        pdf_written = None;
                    }
                }
                depth = depth.saturating_sub(1);
                writer.write_event(Event::End(e))?;
            }
            other => writer.write_event(other)?,
        }
        buf.clear();
    }
    Ok(writer.into_inner().into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spread_with(xml: &str, placed: Option<PlacedPdf>) -> (Vec<u8>, Spread) {
        let mut spread = Spread::default();
        let mut r = paged_model::Rectangle::new(
            "r1",
            idml_import::Bounds {
                top: 0.0,
                left: 0.0,
                bottom: 10.0,
                right: 10.0,
            },
        );
        r.placed_pdf = placed;
        spread.rectangles.push(r);
        (xml.as_bytes().to_vec(), spread)
    }

    const WITH: &str = r#"<Spread><Rectangle Self="r1"><PDF Self="p1"><Properties><GraphicBounds Left="0"/></Properties><PDFAttribute PageNumber="1" PDFCrop="CropMedia" TransparentBackground="true"/><Link Self="l1"/></PDF></Rectangle></Spread>"#;
    const WITHOUT: &str = r#"<Spread><Rectangle Self="r1"><PDF Self="p1"><Properties><GraphicBounds Left="0"/></Properties><Link Self="l1"/></PDF></Rectangle></Spread>"#;

    fn page(n: Option<u32>, crop: Option<&str>) -> Option<PlacedPdf> {
        Some(PlacedPdf {
            page_number: n,
            crop: crop.map(str::to_string),
        })
    }

    #[test]
    fn an_unchanged_attribute_writes_back_byte_for_byte() {
        let (xml, spread) = spread_with(WITH, page(Some(1), Some("CropMedia")));
        assert_eq!(rewrite_pdf_attributes(&xml, &spread).unwrap(), xml);
        let (xml, spread) = spread_with(WITHOUT, None);
        assert_eq!(rewrite_pdf_attributes(&xml, &spread).unwrap(), xml);
    }

    #[test]
    fn a_changed_page_is_patched_in_place() {
        let (xml, spread) = spread_with(WITH, page(Some(2), Some("CropMedia")));
        let out = String::from_utf8(rewrite_pdf_attributes(&xml, &spread).unwrap()).unwrap();
        assert_eq!(out, WITH.replace(r#"PageNumber="1""#, r#"PageNumber="2""#));
    }

    #[test]
    fn a_cleared_page_drops_the_attribute() {
        let (xml, spread) = spread_with(WITH, page(None, Some("CropMedia")));
        let out = String::from_utf8(rewrite_pdf_attributes(&xml, &spread).unwrap()).unwrap();
        assert_eq!(out, WITH.replace(r#" PageNumber="1""#, ""));
    }

    #[test]
    fn a_pdf_without_one_gains_it_before_its_link() {
        let (xml, spread) = spread_with(WITHOUT, page(Some(3), None));
        let out = String::from_utf8(rewrite_pdf_attributes(&xml, &spread).unwrap()).unwrap();
        assert_eq!(
            out,
            WITHOUT.replace(
                r#"<Link Self="l1"/>"#,
                r#"<PDFAttribute PageNumber="3"/><Link Self="l1"/>"#
            )
        );
        // A model with nothing to say inserts nothing.
        let (xml, spread) = spread_with(WITHOUT, page(None, None));
        assert_eq!(rewrite_pdf_attributes(&xml, &spread).unwrap(), xml);
    }
}
