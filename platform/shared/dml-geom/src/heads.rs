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
//! DrawingML's line ends (`a:headEnd` / `a:tailEnd`) at the format
//! boundary: their `type`, `w` and `len` mapped onto the engine's Office
//! line end ([`OfficeLineEnd`], engine ADR 1093, amendment 2) and back.
//! The head geometry itself is the engine's (`paged_preset_geom::heads`),
//! re-exported here with the DrawingML spelling its callers hold.

use paged_model::{OfficeHeadKind, OfficeHeadSize, OfficeLineEnd};
use paged_ooxml::drawingml::LineEnd;

pub use paged_preset_geom::heads::{Head, Outline};

fn size(s: Option<&str>) -> OfficeHeadSize {
    match s {
        Some("sm") => OfficeHeadSize::Sm,
        Some("lg") => OfficeHeadSize::Lg,
        _ => OfficeHeadSize::Med,
    }
}

fn size_name(s: OfficeHeadSize) -> &'static str {
    match s {
        OfficeHeadSize::Sm => "sm",
        OfficeHeadSize::Med => "med",
        OfficeHeadSize::Lg => "lg",
    }
}

/// A DrawingML line end as the engine's: `Ok(None)` for `none` (or no
/// type), `Err(type)` for a type Office does not define.
pub fn office_end(e: &LineEnd) -> Result<Option<OfficeLineEnd>, String> {
    let kind = match e.kind.as_str() {
        "none" | "" => return Ok(None),
        "triangle" => OfficeHeadKind::Triangle,
        "stealth" => OfficeHeadKind::Stealth,
        "diamond" => OfficeHeadKind::Diamond,
        "oval" => OfficeHeadKind::Oval,
        "arrow" => OfficeHeadKind::Arrow,
        other => return Err(other.to_string()),
    };
    Ok(Some(OfficeLineEnd {
        kind,
        w: size(e.w.as_deref()),
        len: size(e.len.as_deref()),
    }))
}

/// The engine's Office line end as DrawingML's (`type`, `w`, `len`).
pub fn line_end(e: &OfficeLineEnd) -> LineEnd {
    LineEnd {
        kind: match e.kind {
            OfficeHeadKind::Triangle => "triangle",
            OfficeHeadKind::Stealth => "stealth",
            OfficeHeadKind::Diamond => "diamond",
            OfficeHeadKind::Oval => "oval",
            OfficeHeadKind::Arrow => "arrow",
        }
        .to_string(),
        w: Some(size_name(e.w).to_string()),
        len: Some(size_name(e.len).to_string()),
    }
}

fn mapped(e: Option<&LineEnd>) -> Option<OfficeLineEnd> {
    e.and_then(|e| office_end(e).ok().flatten())
}

/// How far the stroke of a line stops short of its end under `e`
/// (`paged_preset_geom::heads::inset`); 0 for a type Office does not draw.
pub fn inset(e: &LineEnd, width_pt: f32) -> f32 {
    mapped(Some(e)).map_or(0.0, |o| paged_preset_geom::heads::inset(&o, width_pt))
}

/// `o`'s first open contour shortened under its heads
/// (`paged_preset_geom::heads::cut_under_heads`).
pub fn cut_under_heads(
    o: &mut Outline,
    head: Option<&LineEnd>,
    tail: Option<&LineEnd>,
    width_pt: f32,
) {
    paged_preset_geom::heads::cut_under_heads(
        o,
        mapped(head).as_ref(),
        mapped(tail).as_ref(),
        width_pt,
    );
}

/// The heads of `o`'s first open contour (`paged_preset_geom::heads::heads`)
/// and, by name, the types Office does not define.
pub fn heads(
    o: &Outline,
    head: Option<&LineEnd>,
    tail: Option<&LineEnd>,
    width_pt: f32,
) -> (Vec<Head>, Vec<String>) {
    let mut undrawn = Vec::new();
    let mut take = |e: Option<&LineEnd>| match e.map(office_end) {
        Some(Err(name)) => {
            if !undrawn.contains(&name) {
                undrawn.push(name);
            }
            None
        }
        Some(Ok(o)) => o,
        None => None,
    };
    let (h, t) = (take(head), take(tail));
    (
        paged_preset_geom::heads::heads(o, h.as_ref(), t.as_ref(), width_pt),
        undrawn,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drawingml_ends_map_onto_the_engines_and_back() {
        let e = LineEnd {
            kind: "stealth".into(),
            w: Some("lg".into()),
            len: Some("sm".into()),
        };
        let o = office_end(&e).unwrap().unwrap();
        assert_eq!(o.kind, OfficeHeadKind::Stealth);
        assert_eq!(line_end(&o), e);
        assert_eq!(
            office_end(&LineEnd {
                kind: "none".into(),
                w: None,
                len: None
            }),
            Ok(None)
        );
        assert_eq!(
            office_end(&LineEnd {
                kind: "zigzag".into(),
                w: None,
                len: None
            }),
            Err("zigzag".into())
        );
    }
}
