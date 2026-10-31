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

//! **Place as vectors** — the page reader (publish ADR 658).
//!
//! One page of a PDF (or of an Illustrator file, through the PDF it
//! carries) becomes the items it paints: paths with their fills and
//! strokes (exact Béziers, the fill rule, dashes, caps and joins), clips
//! as clip groups, transparency groups with their opacity, blend mode and
//! soft mask, axial and radial shadings as native ramps (anything else
//! sampled to an image and reported), images, and text runs with their
//! glyph outlines. The bundle lowers them to native page items in one
//! batch ([`ir`] is the contract).
//!
//! The page is walked by `hayro-interpret`, the interpreter the engine
//! draws a placed PDF with (engine ADR 154), so a placed PDF converted to
//! vectors comes out as the engine already showed it. The bundle's other
//! reader, PDFium (ADR 655), stays the reader of text and of page rasters:
//! its public API exposes no shading, blend mode or soft mask, which is
//! what this reader is for.

pub mod ir;

mod ai;
mod device;
mod encode;
mod paint;
mod tidy;

use hayro_interpret::hayro_syntax::object::dict::keys::{ART_BOX, BLEED_BOX, TRIM_BOX};
use hayro_interpret::hayro_syntax::object::Rect as PdfRect;
use hayro_interpret::hayro_syntax::page::Page;
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::{interpret_page, Context, InterpreterCache, InterpreterSettings};
use kurbo::Affine;

pub use ai::sniff as sniff_format;
use ir::{PageInfo, PdfInfo, VectorPage};

/// Which box of the page a read is cropped to and measured from: the
/// `<PDFAttribute PDFCrop>` vocabulary a placed PDF frame carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PageBox {
    #[default]
    Crop,
    Media,
    Trim,
    Bleed,
    Art,
}

impl PageBox {
    /// `"crop"`, `"media"`, `"trim"`, `"bleed"`, `"art"`; anything else is
    /// the crop box.
    pub fn parse(s: &str) -> PageBox {
        match s {
            "media" => PageBox::Media,
            "trim" => PageBox::Trim,
            "bleed" => PageBox::Bleed,
            "art" => PageBox::Art,
            _ => PageBox::Crop,
        }
    }
}

/// How a page is read.
#[derive(Debug, Clone, Copy)]
pub struct ReadOptions {
    pub page_box: PageBox,
    /// The resolution a shading that has no native form is sampled at.
    pub sample_ppi: f32,
    /// The most pixels one sampled shading may have; the resolution drops
    /// to fit.
    pub max_sample_pixels: u32,
    /// The most copies of a tiling pattern's cell a fill expands to;
    /// past it the fill takes the cell's colour.
    pub max_tiles: u32,
}

impl Default for ReadOptions {
    fn default() -> Self {
        ReadOptions {
            page_box: PageBox::Crop,
            sample_ppi: 150.0,
            max_sample_pixels: 4_000_000,
            max_tiles: 400,
        }
    }
}

/// Why a file or a page cannot be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadError {
    #[error("the file is not a PDF")]
    NotPdf,
    /// An Illustrator file with no PDF to read: saved without "Create PDF
    /// Compatible File", or a PostScript-era file (Illustrator 8 and
    /// earlier). Illustrator's own data (`AIPrivateData`) is not parsed.
    #[error("the Illustrator file was saved without PDF content: {0}")]
    AiWithoutPdf(&'static str),
    #[error("the PDF could not be opened")]
    Unreadable,
    #[error("page {page} does not exist (the file has {count})")]
    NoSuchPage { page: usize, count: usize },
}

impl ReadError {
    /// A stable code the bundle words.
    pub fn code(&self) -> &'static str {
        match self {
            ReadError::NotPdf => "notPdf",
            ReadError::AiWithoutPdf(_) => "aiWithoutPdf",
            ReadError::Unreadable => "unreadable",
            ReadError::NoSuchPage { .. } => "noSuchPage",
        }
    }
}

fn open(bytes: &[u8]) -> Result<Pdf, ReadError> {
    let format = ai::sniff(bytes);
    if let Some(reason) = format.refusal() {
        return Err(ReadError::AiWithoutPdf(reason));
    }
    if !format.is_pdf {
        return Err(ReadError::NotPdf);
    }
    Pdf::new(bytes.to_vec()).map_err(|_| ReadError::Unreadable)
}

/// What a file is: its pages and, for an Illustrator file, how it reads.
pub fn inspect(bytes: &[u8]) -> Result<PdfInfo, ReadError> {
    let format = ai::sniff(bytes);
    if let Some(reason) = format.refusal() {
        return Err(ReadError::AiWithoutPdf(reason));
    }
    let pdf = open(bytes)?;
    let pages: Vec<PageInfo> = pdf
        .pages()
        .iter()
        .map(|p| {
            let (_, w, h, _) = geometry(p, PageBox::Crop);
            PageInfo {
                width_pt: w,
                height_pt: h,
            }
        })
        .collect();
    let ai = format.ai.then(|| ir::AiInfo {
        pdf_compatible: true,
        has_private_data: format.has_private_data,
        creator: pdf
            .metadata()
            .creator
            .as_deref()
            .map(|c| String::from_utf8_lossy(c).into_owned()),
    });
    // Illustrator writes a stand-in page when it saved no PDF content:
    // the file opens, and shows only that sentence.
    if ai.is_some() {
        read_page(bytes, 0, &ReadOptions::default())?;
    }
    Ok(PdfInfo {
        format: if format.ai { "ai" } else { "pdf" },
        pages,
        ai,
    })
}

/// Read page `page_index` (0-based) of `bytes` as vector items.
pub fn read_page(
    bytes: &[u8],
    page_index: usize,
    opts: &ReadOptions,
) -> Result<VectorPage, ReadError> {
    let format = ai::sniff(bytes);
    let pdf = open(bytes)?;
    let pages = pdf.pages();
    let page = pages.get(page_index).ok_or(ReadError::NoSuchPage {
        page: page_index,
        count: pages.len(),
    })?;
    let (initial, w, h, boxed) = geometry(page, opts.page_box);
    let page_rect = kurbo::Rect::new(0.0, 0.0, w as f64, h as f64);
    let cache = InterpreterCache::new();
    let mut ctx = Context::new(
        initial,
        page_rect,
        &cache,
        pdf.xref(),
        InterpreterSettings::default(),
    );
    let mut collector = device::Collector::new(page_rect, *opts);
    if boxed {
        // A box other than the crop box crops: what lies outside it does
        // not show (engine ADR 1003's rule for a placed PDF).
        collector.push_box_clip(page_rect);
    }
    interpret_page(page, &mut ctx, &mut collector);
    let (items, mut losses) = collector.finish();
    let items = tidy::tidy(items, page_rect);
    if format.ai && format.has_private_data && ai::is_stand_in(page, &items) {
        return Err(ReadError::AiWithoutPdf(ai::STAND_IN));
    }
    losses.sort_by(|a, b| a.code.cmp(b.code));
    Ok(VectorPage {
        page_index,
        width_pt: w,
        height_pt: h,
        items,
        losses,
    })
}

/// The transform from the page's PDF space to the chosen box's top-left
/// origin (y down), and the box's size. The engine's placed-PDF geometry
/// (`paged-renderer`'s `pipeline/placed_pdf.rs`, engine ADR 1003), kept in
/// step with it so a converted frame lands where it was drawn: the crop
/// box is hayro's own mapping, rotation included; another box is that
/// mapping with the box's corners as its extent, cropped to the media
/// box. The flag says the box is not the crop box, so what lies outside
/// it is cropped away.
fn geometry(page: &Page<'_>, chosen: PageBox) -> (Affine, f32, f32, bool) {
    let base = Affine::new(page.initial_transform(true).as_coeffs());
    let (w, h) = page.render_dimensions();
    let raw = page.raw();
    let crop_box = page.intersected_crop_box();
    let b = match chosen {
        PageBox::Crop => return (base, w, h, false),
        PageBox::Media => page.media_box(),
        PageBox::Trim => raw.get::<PdfRect>(TRIM_BOX).unwrap_or(crop_box),
        PageBox::Bleed => raw.get::<PdfRect>(BLEED_BOX).unwrap_or(crop_box),
        PageBox::Art => raw.get::<PdfRect>(ART_BOX).unwrap_or(crop_box),
    }
    .intersect(page.media_box());
    if b.width() < 1e-3 || b.height() < 1e-3 {
        return (base, w, h, false);
    }
    let same = |a: f64, c: f64| (a - c).abs() < 1e-3;
    if same(b.x0, crop_box.x0)
        && same(b.y0, crop_box.y0)
        && same(b.x1, crop_box.x1)
        && same(b.y1, crop_box.y1)
    {
        return (base, w, h, false);
    }
    let corners = [(b.x0, b.y0), (b.x1, b.y0), (b.x0, b.y1), (b.x1, b.y1)]
        .map(|(x, y)| base * kurbo::Point::new(x, y));
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
    (
        Affine::translate((-min_x, -min_y)) * base,
        (max_x - min_x) as f32,
        (max_y - min_y) as f32,
        true,
    )
}
