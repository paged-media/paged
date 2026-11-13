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

//! A picture's filter stack (engine ADR 1037) back as DrawingML: the
//! inverse of [`Mapper::picture_at`](crate::Mapper::picture_at), for the
//! save paths of paged.slide, paged.doc and paged.sheet.
//!
//! Each op the import makes is written as the element it came from, with
//! the values that read back to the same op; an op DrawingML has no element
//! for (exposure, levels, curves, recolor, sharpen, posterize, invert, a
//! channel mixer) is reported, one line each.

use paged_model::RasterOp;
use paged_ooxml::drawingml::resolved::ImageEffect;

use crate::{LossEntry, LossSeverity, BLUR_SIGMA_PER_RADIUS};

/// The six range weights that grey a picture with Office's luma weights
/// (0.3, 0.59, 0.11): what `a:grayscl` reads as.
pub const OFFICE_GREY: [f32; 6] = [0.3, 0.89, 0.59, 0.7, 0.11, 0.41];

/// The `a:blip` children [`splice_blip`] owns: the picture effects that
/// read as filter-stack ops. Everything else in the blip (`a:alphaModFix`,
/// the alpha effects, `a:tint`, the extension list with Office 2010's
/// image layer) is kept as written.
pub const OWNED: [&str; 8] = [
    "a:lum",
    "a:clrChange",
    "a:duotone",
    "a:grayscl",
    "a:biLevel",
    "a:clrRepl",
    "a:hsl",
    "a:blur",
];

/// The resolved picture effects `ops` write as, in order, and what has no
/// DrawingML form, as loss entries (engine ADR 1097; `dml.picture.*` codes,
/// the sentence as the message). `px_per_pt` is the picture's own pixels per
/// point as placed (a blur's radius is in pixels; without it a blur is
/// reported).
pub fn effects_of(ops: &[RasterOp], px_per_pt: Option<f64>) -> (Vec<ImageEffect>, Vec<LossEntry>) {
    let byte = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    let rgb = |c: [f32; 3]| c.map(byte);
    let mut out = Vec::new();
    let mut lost = Vec::new();
    for op in ops {
        match *op {
            RasterOp::BrightnessContrast {
                brightness,
                contrast,
            } => {
                // The inverse of the import's slope: +50 % doubles it,
                // −50 % halves it.
                let s = f64::from(contrast);
                let c = if s >= 1.0 { 1.0 - 1.0 / s } else { s - 1.0 };
                out.push(ImageEffect::Luminance {
                    bright: f64::from(brightness),
                    contrast: c,
                });
            }
            RasterOp::Duotone { shadow, highlight } if shadow == highlight => {
                out.push(ImageEffect::ColorReplace {
                    rgb: rgb(shadow),
                    alpha: 1.0,
                })
            }
            RasterOp::Duotone { shadow, highlight } => out.push(ImageEffect::Duotone {
                dark: rgb(shadow),
                light: rgb(highlight),
            }),
            RasterOp::BlackWhite {
                reds,
                yellows,
                greens,
                cyans,
                blues,
                magentas,
            } => {
                let w = [reds, yellows, greens, cyans, blues, magentas];
                if w.iter().zip(OFFICE_GREY).any(|(a, b)| (a - b).abs() > 1e-3) {
                    lost.push(LossEntry::new(
                        "dml.picture.grayWeights",
                        LossSeverity::Approximated,
                        "a black & white with its own range weights is saved as a:grayscl \
                         (Office's luma weights)",
                    ));
                }
                out.push(ImageEffect::Grayscale);
            }
            RasterOp::Threshold { level } => out.push(ImageEffect::BiLevel {
                threshold: f64::from(level),
            }),
            RasterOp::HueSaturation {
                hue,
                saturation,
                lightness,
                ranges,
                colorize,
            } => {
                if ranges.is_some() || colorize.is_some() {
                    lost.push(LossEntry::new(
                        "dml.picture.hslRanges",
                        LossSeverity::Dropped,
                        "a hue/saturation's colour ranges and colorize are not saved (a:hsl is \
                         the master row)",
                    ));
                }
                out.push(ImageEffect::Hsl {
                    hue: f64::from(hue).rem_euclid(360.0),
                    sat: f64::from(saturation),
                    lum: f64::from(lightness),
                });
            }
            RasterOp::ColorReplace {
                from,
                to,
                alpha,
                tolerance,
            } => {
                if tolerance > 0.0 {
                    lost.push(LossEntry::new(
                        "dml.picture.clrChangeTolerance",
                        LossSeverity::Approximated,
                        "a colour replace's tolerance is not saved (a:clrChange matches one \
                         colour)",
                    ));
                }
                out.push(ImageEffect::ColorChange {
                    from: rgb(from),
                    to: rgb(to),
                    to_alpha: f64::from(alpha),
                    use_alpha: false,
                });
            }
            RasterOp::Blur { radius } => match px_per_pt.filter(|s| s.is_finite() && *s > 0.0) {
                Some(scale) => out.push(ImageEffect::Blur {
                    radius: f64::from(radius) / (BLUR_SIGMA_PER_RADIUS * scale),
                    grow: true,
                }),
                None => lost.push(LossEntry::new(
                    "dml.picture.blurScale",
                    LossSeverity::Dropped,
                    "a picture blur is not saved (the picture's pixel size is not known)",
                )),
            },
            ref other => lost.push(LossEntry::new(
                "dml.picture.unsaved",
                LossSeverity::Dropped,
                format!(
                    "picture adjustment {} has no DrawingML form and is not saved",
                    other.name()
                ),
            )),
        }
    }
    (out, lost)
}

/// `ops` as the `a:blip` children they write as (see [`effects_of`]).
pub fn blip_xml(ops: &[RasterOp], px_per_pt: Option<f64>) -> (String, Vec<LossEntry>) {
    let (effects, lost) = effects_of(ops, px_per_pt);
    (paged_ooxml::drawingml::write::blip_effects(&effects), lost)
}

/// The `a:blip` element `blip` (its XML as written, prefix `a:`) with its
/// [`OWNED`] children replaced by `ops`, written before the extension list;
/// every other child and attribute is kept byte for byte.
pub fn splice_blip(
    blip: &str,
    ops: &[RasterOp],
    px_per_pt: Option<f64>,
) -> (String, Vec<LossEntry>) {
    let (xml, lost) = blip_xml(ops, px_per_pt);
    let Some(open_end) = blip.find('>') else {
        return (blip.to_string(), lost);
    };
    let open = &blip[..=open_end];
    if open.ends_with("/>") {
        if xml.is_empty() {
            return (blip.to_string(), lost);
        }
        let head = open.trim_end_matches("/>").trim_end();
        return (format!("{head}>{xml}</a:blip>"), lost);
    }
    let Some(close) = blip.rfind("</a:blip>") else {
        return (blip.to_string(), lost);
    };
    let mut kept = String::new();
    let mut ext = String::new();
    for (name, text) in children(&blip[open_end + 1..close]) {
        if name == "a:extLst" {
            ext.push_str(text);
        } else if !OWNED.contains(&name) {
            kept.push_str(text);
        }
    }
    (format!("{open}{kept}{xml}{ext}</a:blip>"), lost)
}

/// The child elements of an element's content, as (qualified name, text).
/// Text between them (whitespace) is dropped.
fn children(content: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut i = 0;
    let b = content.as_bytes();
    while let Some(off) = content[i..].find('<') {
        let start = i + off;
        let name_end = content[start + 1..]
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .map_or(content.len(), |e| start + 1 + e);
        let name = &content[start + 1..name_end];
        // The element's end: its own `/>`, or the matching close tag at
        // the same depth.
        let mut depth = 0usize;
        let mut j = start;
        let mut end = content.len();
        while j < b.len() {
            let Some(lt) = content[j..].find('<') else {
                break;
            };
            let at = j + lt;
            let gt = content[at..].find('>').map_or(content.len(), |g| at + g);
            let tag = &content[at..=gt.min(content.len() - 1)];
            if tag.starts_with("</") {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    end = gt + 1;
                    break;
                }
            } else if tag.ends_with("/>") {
                if depth == 0 {
                    end = gt + 1;
                    break;
                }
            } else {
                depth += 1;
            }
            j = gt + 1;
        }
        out.push((name, &content[start..end.min(content.len())]));
        i = end.min(content.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_ooxml::drawingml::{self, resolved};
    use paged_ooxml::tree::parse;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

    /// What a blip's effects map to on import, at `px_per_pt`.
    fn read(blip: &str, px_per_pt: Option<f64>) -> Vec<RasterOp> {
        let el = parse(blip.as_bytes()).unwrap();
        let pic = resolved::picture(&drawingml::blip(&el, &|_| None), &());
        crate::Mapper::default()
            .picture_at(&pic, px_per_pt)
            .adjustments
    }

    #[test]
    fn the_ops_drawingml_holds_round_trip() {
        let ops = vec![
            RasterOp::BrightnessContrast {
                brightness: 0.2,
                contrast: 2.0,
            },
            RasterOp::BrightnessContrast {
                brightness: -0.1,
                contrast: 0.5,
            },
            RasterOp::Duotone {
                shadow: [0.0, 0.0, 0.2],
                highlight: [1.0, 0.8, 0.6],
            },
            RasterOp::BlackWhite {
                reds: 0.3,
                yellows: 0.89,
                greens: 0.59,
                cyans: 0.7,
                blues: 0.11,
                magentas: 0.41,
            },
            RasterOp::Threshold { level: 0.4 },
            RasterOp::hue_saturation(30.0, 0.25, -0.1),
            RasterOp::ColorReplace {
                from: [1.0, 1.0, 1.0],
                to: [1.0, 1.0, 1.0],
                alpha: 0.0,
                tolerance: 0.0,
            },
            RasterOp::Blur { radius: 4.0 },
        ];
        let (xml, lost) = blip_xml(&ops, Some(2.0));
        assert!(lost.is_empty(), "{lost:?}");
        let back = read(
            &format!(r#"<a:blipFill {NS}><a:blip r:embed="r1">{xml}</a:blip></a:blipFill>"#),
            Some(2.0),
        );
        assert_eq!(back.len(), ops.len());
        for (a, b) in back.iter().zip(&ops) {
            let (ja, jb) = (
                serde_json::to_value(a).unwrap(),
                serde_json::to_value(b).unwrap(),
            );
            for (k, v) in jb.as_object().unwrap() {
                match (v.as_f64(), ja[k].as_f64()) {
                    (Some(x), Some(y)) => assert!((x - y).abs() < 1e-3, "{k}: {ja} vs {jb}"),
                    _ => assert_eq!(&ja[k], v, "{k}"),
                }
            }
        }
    }

    #[test]
    fn an_op_without_an_element_is_reported() {
        let (xml, lost) = blip_xml(&[RasterOp::Invert, RasterOp::Blur { radius: 1.0 }], None);
        assert!(xml.is_empty());
        assert_eq!(lost.len(), 2, "{lost:?}");
        assert_eq!(lost[0].code, "dml.picture.unsaved");
        assert!(lost[0].message.contains("invert"), "{lost:?}");
        assert_eq!(lost[1].code, "dml.picture.blurScale");
    }

    #[test]
    fn a_splice_keeps_what_it_does_not_own() {
        let blip = r#"<a:blip r:embed="rId2" cstate="print"><a:alphaModFix amt="50000"/><a:lum bright="10000" contrast="0"/><a:tint hue="0" amt="1000"/><a:extLst><a:ext uri="x"><b:y/></a:ext></a:extLst></a:blip>"#;
        let (out, lost) = splice_blip(blip, &[RasterOp::Threshold { level: 0.5 }], None);
        assert!(lost.is_empty());
        assert_eq!(
            out,
            r#"<a:blip r:embed="rId2" cstate="print"><a:alphaModFix amt="50000"/><a:tint hue="0" amt="1000"/><a:biLevel thresh="50000"/><a:extLst><a:ext uri="x"><b:y/></a:ext></a:extLst></a:blip>"#
        );
        let (cleared, _) = splice_blip(blip, &[], None);
        assert!(!cleared.contains("a:lum"), "{cleared}");
        let (open, _) = splice_blip(
            r#"<a:blip r:embed="rId2"/>"#,
            &[RasterOp::Threshold { level: 0.5 }],
            None,
        );
        assert_eq!(
            open,
            r#"<a:blip r:embed="rId2"><a:biLevel thresh="50000"/></a:blip>"#
        );
    }
}
