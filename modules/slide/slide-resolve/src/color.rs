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

//! Colour resolution: scheme slots through the colour map and theme, then
//! the transform chain (`lumMod`, `tint`, `alpha`, …) in document order.
//!
//! The arithmetic is the shared DrawingML resolver's
//! (`paged_ooxml::drawingml::color`, slide ADR 722), which doc and sheet
//! resolve with too; this module says what a deck's scheme slots are: the
//! colour map, PowerPoint's default map entries, the theme, and `phClr`.
//! The PowerPoint oracle is the judge of each rule.

pub use paged_ooxml::drawingml::Rgba;
use paged_ooxml::drawingml::{self, SchemeColors};
use pptx_core::{Color, ColorMap, Theme};

/// What a colour resolves against.
pub struct ColorCtx<'a> {
    pub theme: Option<&'a Theme>,
    pub map: &'a ColorMap,
    /// `phClr` — the colour a style reference supplies.
    pub placeholder: Option<Rgba>,
    /// That colour's theme key, when it is a theme colour (slide ADR 713).
    pub placeholder_key: Option<String>,
    /// The theme, when it is not the deck's first (a key's prefix).
    pub theme_tag: Option<&'a str>,
}

impl SchemeColors for ColorCtx<'_> {
    /// Follow a scheme slot through the colour map to the theme's colour.
    fn scheme(&self, name: &str) -> Option<Rgba> {
        if name == "phClr" {
            return self.placeholder;
        }
        let mapped = self
            .map
            .entries
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .unwrap_or(match name {
                // A map without these entries: PowerPoint's defaults.
                "bg1" => "lt1",
                "tx1" => "dk1",
                "bg2" => "lt2",
                "tx2" => "dk2",
                other => other,
            });
        let (_, c) = self.theme?.colors.iter().find(|(k, _)| k == mapped)?;
        // A theme slot is itself a colour (srgb or sys) with no further mapping.
        Some(drawingml::resolve(c, &()))
    }

    /// A theme colour's key (`accent1 lumMod75000`): the slot through the
    /// colour map, with its transforms (slide ADR 713).
    fn theme_key(&self, c: &Color) -> Option<String> {
        crate::theme::key_of(c, self.map, self.placeholder_key.as_deref(), self.theme_tag)
    }
}

impl ColorCtx<'_> {
    /// [`SchemeColors::theme_key`] by name.
    pub fn key(&self, c: &Color) -> Option<String> {
        self.theme_key(c)
    }
}

/// Resolve a colour. An unresolvable scheme reference is black (and the
/// caller may report it).
pub fn resolve(c: &Color, ctx: &ColorCtx) -> Rgba {
    drawingml::resolve(c, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pptx_core::ColorBase;

    fn theme() -> Theme {
        Theme {
            colors: vec![
                (
                    "dk1".into(),
                    Color {
                        base: ColorBase::System {
                            name: "windowText".into(),
                            last: Some(0x000000),
                        },
                        transforms: vec![],
                    },
                ),
                (
                    "lt1".into(),
                    Color {
                        base: ColorBase::System {
                            name: "window".into(),
                            last: Some(0xffffff),
                        },
                        transforms: vec![],
                    },
                ),
                (
                    "accent1".into(),
                    Color {
                        base: ColorBase::Srgb(0x4472c4),
                        transforms: vec![],
                    },
                ),
            ],
            ..Default::default()
        }
    }

    fn c(base: ColorBase, t: &[(&str, i32)]) -> Color {
        Color {
            base,
            transforms: t.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    #[test]
    fn scheme_slots_follow_the_map() {
        let th = theme();
        let map = ColorMap {
            entries: vec![("tx1".into(), "dk1".into()), ("bg1".into(), "lt1".into())],
        };
        let ctx = ColorCtx {
            theme: Some(&th),
            map: &map,
            placeholder: None,
            placeholder_key: None,
            theme_tag: None,
        };
        assert_eq!(
            resolve(&c(ColorBase::Scheme("tx1".into()), &[]), &ctx).bytes(),
            [0, 0, 0]
        );
        assert_eq!(
            resolve(&c(ColorBase::Scheme("bg1".into()), &[]), &ctx).bytes(),
            [255, 255, 255]
        );
        assert_eq!(
            resolve(&c(ColorBase::Scheme("accent1".into()), &[]), &ctx).bytes(),
            [0x44, 0x72, 0xc4]
        );
    }

    #[test]
    fn lum_mod_and_off_work_in_hsl() {
        let th = theme();
        let map = ColorMap::default();
        let ctx = ColorCtx {
            theme: Some(&th),
            map: &map,
            placeholder: None,
            placeholder_key: None,
            theme_tag: None,
        };
        // White at 85 % luminance: PowerPoint's "Background 1, darker 15 %" = D9D9D9.
        let d = resolve(
            &c(ColorBase::Scheme("bg1".into()), &[("lumMod", 85_000)]),
            &ctx,
        );
        assert_eq!(d.bytes(), [0xd9, 0xd9, 0xd9]);
        // accent1 lighter 40 %: lumMod 60 % + lumOff 40 % = 8FAADC.
        let l = resolve(
            &c(
                ColorBase::Scheme("accent1".into()),
                &[("lumMod", 60_000), ("lumOff", 40_000)],
            ),
            &ctx,
        );
        assert_eq!(l.bytes(), [0x8f, 0xaa, 0xdc]);
    }

    #[test]
    fn alpha_is_kept_and_ph_clr_uses_the_style_colour() {
        let map = ColorMap::default();
        let ctx = ColorCtx {
            theme: None,
            map: &map,
            placeholder: Some(Rgba::from_hex(0xff0000)),
            placeholder_key: None,
            theme_tag: None,
        };
        let x = resolve(
            &c(ColorBase::Scheme("phClr".into()), &[("alpha", 50_000)]),
            &ctx,
        );
        assert_eq!(x.bytes(), [255, 0, 0]);
        assert!((x.a - 0.5).abs() < 1e-9);
    }
}
