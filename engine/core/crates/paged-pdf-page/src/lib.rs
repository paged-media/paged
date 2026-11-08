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

//! One PDF page reader for the two places the engine's hayro interpreter is
//! driven (ADR 1058): a placed PDF drawn into the display list
//! (`paged-renderer`), and paged.publish's place-as-vectors (`pdf-import`).
//!
//! Each keeps its own `hayro_interpret::Device` (one writes display-list
//! commands, the other the bundle's vector IR; their paints and clips differ
//! by design), and both read what a device cannot decide: which box of the
//! page is shown and how PDF space maps onto it, and what a PDF blend mode
//! is. Those two were once copies "kept in step"; they are this crate.

use hayro_interpret::hayro_syntax::object::dict::keys::{ART_BOX, BLEED_BOX, TRIM_BOX};
use hayro_interpret::hayro_syntax::object::Rect as PdfRect;
use hayro_interpret::hayro_syntax::page::Page;
use hayro_interpret::BlendMode as HayroBlend;
use kurbo::{Affine, Point};
use paged_blend::BlendMode;

/// Which box of a PDF page a frame or an import shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageBox {
    Crop,
    Media,
    Trim,
    Bleed,
    Art,
}

/// A page's viewed box: the transform from the page's PDF space to the box's
/// top-left origin (y down), the box's size in points, and whether the box
/// is not the crop box (so what lies outside it is cropped away).
#[derive(Debug, Clone, Copy)]
pub struct Geometry {
    pub initial: Affine,
    pub width: f32,
    pub height: f32,
    pub boxed: bool,
}

/// The geometry of `page` for `chosen`. The crop box is hayro's own mapping,
/// rotation included; another box is that mapping with the box's corners as
/// its extent (a page rotates by quarter turns, so the box stays
/// axis-aligned), cropped to the media box as PDF 32000 section 14.11.2 asks.
/// A box with no area falls back to the crop box (engine ADR 1003).
pub fn geometry(page: &Page<'_>, chosen: PageBox) -> Geometry {
    let base = Affine::new(page.initial_transform(true).as_coeffs());
    let (w, h) = page.render_dimensions();
    let plain = Geometry {
        initial: base,
        width: w,
        height: h,
        boxed: false,
    };
    let raw = page.raw();
    let crop_box = page.intersected_crop_box();
    let b = match chosen {
        PageBox::Crop => return plain,
        PageBox::Media => page.media_box(),
        PageBox::Trim => raw.get::<PdfRect>(TRIM_BOX).unwrap_or(crop_box),
        PageBox::Bleed => raw.get::<PdfRect>(BLEED_BOX).unwrap_or(crop_box),
        PageBox::Art => raw.get::<PdfRect>(ART_BOX).unwrap_or(crop_box),
    }
    .intersect(page.media_box());
    if b.width() < 1e-3 || b.height() < 1e-3 {
        return plain;
    }
    let same = |a: f64, c: f64| (a - c).abs() < 1e-3;
    if same(b.x0, crop_box.x0)
        && same(b.y0, crop_box.y0)
        && same(b.x1, crop_box.x1)
        && same(b.y1, crop_box.y1)
    {
        return plain;
    }
    let corners = [(b.x0, b.y0), (b.x1, b.y0), (b.x0, b.y1), (b.x1, b.y1)]
        .map(|(x, y)| base * Point::new(x, y));
    let min_x = corners.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let min_y = corners.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|p| p.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = corners
        .iter()
        .map(|p| p.y)
        .fold(f64::NEG_INFINITY, f64::max);
    Geometry {
        initial: Affine::translate((-min_x, -min_y)) * base,
        width: (max_x - min_x) as f32,
        height: (max_y - min_y) as f32,
        boxed: true,
    }
}

/// hayro's blend mode as the engine's (`paged_blend::BlendMode`, ADR 1034);
/// one hayro does not name is `Normal`.
pub fn blend(b: HayroBlend) -> BlendMode {
    match b {
        HayroBlend::Multiply => BlendMode::Multiply,
        HayroBlend::Screen => BlendMode::Screen,
        HayroBlend::Overlay => BlendMode::Overlay,
        HayroBlend::Darken => BlendMode::Darken,
        HayroBlend::Lighten => BlendMode::Lighten,
        HayroBlend::ColorDodge => BlendMode::ColorDodge,
        HayroBlend::ColorBurn => BlendMode::ColorBurn,
        HayroBlend::HardLight => BlendMode::HardLight,
        HayroBlend::SoftLight => BlendMode::SoftLight,
        HayroBlend::Difference => BlendMode::Difference,
        HayroBlend::Exclusion => BlendMode::Exclusion,
        HayroBlend::Hue => BlendMode::Hue,
        HayroBlend::Saturation => BlendMode::Saturation,
        HayroBlend::Color => BlendMode::Color,
        HayroBlend::Luminosity => BlendMode::Luminosity,
        _ => BlendMode::Normal,
    }
}
