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

//! The deck as a PDF (slide ADR 720): its slides one to a page, handouts
//! (1, 2, 3, 4, 6 or 9 slides a page, in rows; three a page with lines
//! beside each slide for notes), or notes pages (the slide above its
//! speaker notes).
//!
//! The slides are images the host's renderer drew (the pixels the show
//! and the thumbnails show); this writer frames and places them. Text
//! (notes, page numbers, the deck's name) is set in Helvetica, the PDF
//! standard font every reader has, in WinAnsiEncoding; a character it
//! lacks is drawn as `?` and counted ([`Written::replaced`]).

use std::io::Write as _;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::Deserialize;

use crate::helvetica;

/// A slide image, deflated, ready to be an image XObject.
#[derive(Debug, Clone)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// zlib-deflated RGB rows (`/FlateDecode`).
    pub data: Vec<u8>,
}

/// Deflate straight-alpha RGBA pixels as RGB over white paper.
pub fn image_from_rgba(rgba: &[u8], width: u32, height: u32) -> Result<Image, String> {
    let n = width as usize * height as usize;
    if rgba.len() < n * 4 || n == 0 {
        return Err(format!(
            "an image of {width} × {height} needs {} bytes, got {}",
            n * 4,
            rgba.len()
        ));
    }
    let mut enc = ZlibEncoder::new(Vec::with_capacity(n / 4), Compression::new(6));
    let mut row = Vec::with_capacity(width as usize * 3);
    for y in 0..height as usize {
        row.clear();
        for px in rgba[y * width as usize * 4..(y + 1) * width as usize * 4]
            .as_chunks::<4>()
            .0
        {
            let a = px[3] as u32;
            for &c in &px[..3] {
                row.push(((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8);
            }
        }
        enc.write_all(&row).map_err(|e| e.to_string())?;
    }
    Ok(Image {
        width,
        height,
        data: enc.finish().map_err(|e| e.to_string())?,
    })
}

/// What the PDF holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Layout {
    /// One slide a page, at the slide's size.
    Slides,
    /// `per_page` slides a page on paper.
    Handouts,
    /// A slide and its speaker notes a page, on paper.
    Notes,
}

/// What a PDF is asked to be.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub layout: Layout,
    /// Handouts: 1, 2, 3, 4, 6 or 9.
    #[serde(default = "six")]
    pub per_page: u32,
    /// The paper for handouts and notes pages, pt (portrait).
    #[serde(default = "letter")]
    pub paper: (f64, f64),
    /// The slide's size, pt.
    pub slide_size: (f64, f64),
    /// The deck's name: the PDF's title and the handouts' header.
    #[serde(default)]
    pub title: String,
    /// A hairline frame around each slide (handouts and notes).
    #[serde(default = "yes")]
    pub frame: bool,
}

fn six() -> u32 {
    6
}
fn letter() -> (f64, f64) {
    (612.0, 792.0)
}
fn yes() -> bool {
    true
}

/// One slide to place.
#[derive(Debug, Clone)]
pub struct Slide {
    pub image: Image,
    /// Its number in the deck (the notes pages' and handouts' labels).
    pub number: u32,
    pub notes: String,
}

/// A written PDF.
#[derive(Debug, Clone)]
pub struct Written {
    pub bytes: Vec<u8>,
    pub pages: usize,
    /// Characters of notes or the title Helvetica cannot draw (drawn as `?`).
    pub replaced: usize,
}

/// A rectangle, pt, top-left origin.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

const MARGIN: f64 = 36.0;
const NOTES_SIZE: f64 = 12.0;
const NOTES_LEADING: f64 = 14.4;
const LINE_GAP: f64 = 24.0;

/// Columns and rows of a handout page.
pub fn handout_grid(per_page: u32) -> (u32, u32) {
    match per_page {
        1 => (1, 1),
        2 => (1, 2),
        3 => (1, 3),
        4 => (2, 2),
        9 => (3, 3),
        _ => (2, 3),
    }
}

/// A box of `aspect` (w / h) fitted into `r`, centred (or at its left).
fn fit(r: Rect, aspect: f64, left: bool) -> Rect {
    let (mut w, mut h) = (r.w, r.w / aspect);
    if h > r.h {
        h = r.h;
        w = h * aspect;
    }
    let x = if left { r.x } else { r.x + (r.w - w) / 2.0 };
    Rect {
        x,
        y: r.y + (r.h - h) / 2.0,
        w,
        h,
    }
}

/// Where the slides of one handout page go, in reading order (rows first,
/// PowerPoint's horizontal order), and for three a page the area of each
/// slide's note lines.
pub fn handout_cells(per_page: u32, paper: (f64, f64), aspect: f64) -> Vec<(Rect, Option<Rect>)> {
    let (cols, rows) = handout_grid(per_page);
    let area = Rect {
        x: MARGIN,
        y: MARGIN + 18.0,
        w: paper.0 - 2.0 * MARGIN,
        h: paper.1 - 2.0 * MARGIN - 36.0,
    };
    let (cw, ch) = (area.w / cols as f64, area.h / rows as f64);
    let pad = if per_page <= 2 { 18.0 } else { 9.0 };
    let mut out = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let cell = Rect {
                x: area.x + c as f64 * cw + pad,
                y: area.y + r as f64 * ch + pad,
                w: cw - 2.0 * pad,
                h: ch - 2.0 * pad,
            };
            if per_page == 3 {
                let half = Rect {
                    w: cell.w * 0.5,
                    ..cell
                };
                let slide = fit(half, aspect, true);
                let lines = Rect {
                    x: cell.x + cell.w * 0.56,
                    y: slide.y,
                    w: cell.w * 0.44,
                    h: slide.h,
                };
                out.push((slide, Some(lines)));
            } else {
                out.push((fit(cell, aspect, false), None));
            }
        }
    }
    out
}

/// Text broken into lines of at most `width` pt at `size` pt: paragraphs at
/// line breaks, words at spaces, a word wider than a line at characters.
pub fn wrap(text: &str, width: f64, size: f64) -> Vec<String> {
    let mut out = Vec::new();
    for para in text.split(['\n', '\u{2028}', '\u{2029}', '\u{b}']) {
        let mut line = String::new();
        for word in para.split(' ') {
            let cand = if line.is_empty() {
                word.to_string()
            } else {
                format!("{line} {word}")
            };
            if helvetica::width(&cand, size) <= width || line.is_empty() && word.is_empty() {
                line = cand;
                continue;
            }
            if !line.is_empty() {
                out.push(std::mem::take(&mut line));
            }
            // A word too wide for a line on its own is cut.
            let mut piece = String::new();
            for ch in word.chars() {
                if !piece.is_empty() && helvetica::width(&format!("{piece}{ch}"), size) > width {
                    out.push(std::mem::take(&mut piece));
                }
                piece.push(ch);
            }
            line = piece;
        }
        out.push(line);
    }
    // Trailing empty lines say nothing.
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    out
}

/// A PDF string literal of `s` in WinAnsiEncoding.
fn pdf_string(s: &str, replaced: &mut usize) -> String {
    let mut out = String::from("(");
    for c in s.chars() {
        let b = match helvetica::win_ansi(c) {
            Some(b) => b,
            None => {
                if !c.is_control() {
                    *replaced += 1;
                }
                if c.is_control() {
                    continue;
                }
                b'?'
            }
        };
        match b {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(b as char);
            }
            0x20..=0x7e => out.push(b as char),
            _ => out.push_str(&format!("\\{b:03o}")),
        }
    }
    out.push(')');
    out
}

/// One page's content stream and the images it draws.
struct Page {
    size: (f64, f64),
    ops: String,
    images: Vec<usize>,
}

impl Page {
    fn new(size: (f64, f64)) -> Self {
        Page {
            size,
            ops: String::new(),
            images: Vec::new(),
        }
    }
    /// Draw image `k` (its XObject `/Imk`) into `r`.
    fn image(&mut self, k: usize, r: Rect) {
        let y = self.size.1 - r.y - r.h;
        self.ops.push_str(&format!(
            "q {} 0 0 {} {} {} cm /Im{k} Do Q\n",
            f(r.w),
            f(r.h),
            f(r.x),
            f(y)
        ));
        self.images.push(k);
    }
    fn frame(&mut self, r: Rect) {
        let y = self.size.1 - r.y - r.h;
        self.ops.push_str(&format!(
            "q 0.5 w 0.6 G {} {} {} {} re S Q\n",
            f(r.x),
            f(y),
            f(r.w),
            f(r.h)
        ));
    }
    fn hline(&mut self, x0: f64, x1: f64, y: f64) {
        let y = self.size.1 - y;
        self.ops.push_str(&format!(
            "q 0.5 w 0.7 G {} {} m {} {} l S Q\n",
            f(x0),
            f(y),
            f(x1),
            f(y)
        ));
    }
    /// Text with its baseline at `y` from the top, starting at `x` (or
    /// ending there, `right`).
    fn text(&mut self, s: &str, x: f64, y: f64, size: f64, right: bool, replaced: &mut usize) {
        if s.is_empty() {
            return;
        }
        let x = if right {
            x - helvetica::width(s, size)
        } else {
            x
        };
        self.ops.push_str(&format!(
            "BT /F1 {} Tf 0.2 g {} {} Td {} Tj ET\n",
            f(size),
            f(x),
            f(self.size.1 - y),
            pdf_string(s, replaced)
        ));
    }
}

/// A number as PDF writes it: three decimals, no trailing zeros.
fn f(v: f64) -> String {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

/// Lay the slides out as `opts` asks and write the PDF.
pub fn write(slides: &[Slide], opts: &Options) -> Result<Written, String> {
    if slides.is_empty() {
        return Err("there are no slides to write".into());
    }
    let (sw, sh) = opts.slide_size;
    if !(sw > 0.0 && sh > 0.0) {
        return Err("the slide size is not set".into());
    }
    let aspect = sw / sh;
    let mut replaced = 0usize;
    let mut pages: Vec<Page> = Vec::new();
    match opts.layout {
        Layout::Slides => {
            for (k, _) in slides.iter().enumerate() {
                let mut p = Page::new((sw, sh));
                p.image(
                    k,
                    Rect {
                        x: 0.0,
                        y: 0.0,
                        w: sw,
                        h: sh,
                    },
                );
                pages.push(p);
            }
        }
        Layout::Handouts => {
            let per = match opts.per_page {
                1 | 2 | 3 | 4 | 6 | 9 => opts.per_page,
                n => {
                    return Err(format!(
                        "handouts take 1, 2, 3, 4, 6 or 9 slides a page, not {n}"
                    ))
                }
            };
            let cells = handout_cells(per, opts.paper, aspect);
            for (pi, chunk) in slides.chunks(per as usize).enumerate() {
                let mut p = Page::new(opts.paper);
                p.text(&opts.title, MARGIN, MARGIN, 10.0, false, &mut replaced);
                for (j, _) in chunk.iter().enumerate() {
                    let (r, lines) = cells[j];
                    p.image(pi * per as usize + j, r);
                    if opts.frame {
                        p.frame(r);
                    }
                    if let Some(l) = lines {
                        let mut y = l.y + LINE_GAP;
                        while y <= l.y + l.h + 0.01 {
                            p.hline(l.x, l.x + l.w, y);
                            y += LINE_GAP;
                        }
                    }
                }
                p.text(
                    &format!("{}", pi + 1),
                    opts.paper.0 - MARGIN,
                    opts.paper.1 - MARGIN + 10.0,
                    10.0,
                    true,
                    &mut replaced,
                );
                pages.push(p);
            }
        }
        Layout::Notes => {
            let (pw, ph) = opts.paper;
            let inner = pw - 2.0 * 72.0;
            for (k, s) in slides.iter().enumerate() {
                let mut p = Page::new(opts.paper);
                let slide_box = fit(
                    Rect {
                        x: 72.0,
                        y: 54.0,
                        w: inner,
                        h: ph * 0.42 - 54.0,
                    },
                    aspect,
                    false,
                );
                p.image(k, slide_box);
                if opts.frame {
                    p.frame(slide_box);
                }
                let top = slide_box.y + slide_box.h + 36.0;
                let bottom = ph - 72.0;
                let lines = wrap(&s.notes, inner, NOTES_SIZE);
                let fits = ((bottom - top) / NOTES_LEADING).floor().max(1.0) as usize;
                let full = ((bottom - 72.0) / NOTES_LEADING).floor().max(1.0) as usize;
                let footer = |p: &mut Page, replaced: &mut usize| {
                    p.text(
                        &format!("{}", s.number),
                        pw - 72.0,
                        ph - 36.0,
                        10.0,
                        true,
                        replaced,
                    );
                };
                let mut rest: &[String] = &lines;
                let (first, after) = rest.split_at(rest.len().min(fits));
                for (i, l) in first.iter().enumerate() {
                    p.text(
                        l,
                        72.0,
                        top + NOTES_SIZE + i as f64 * NOTES_LEADING,
                        NOTES_SIZE,
                        false,
                        &mut replaced,
                    );
                }
                footer(&mut p, &mut replaced);
                pages.push(p);
                rest = after;
                // Notes longer than the page continue on pages of their own.
                while !rest.is_empty() {
                    let mut q = Page::new(opts.paper);
                    let (now, after) = rest.split_at(rest.len().min(full));
                    for (i, l) in now.iter().enumerate() {
                        q.text(
                            l,
                            72.0,
                            72.0 + NOTES_SIZE + i as f64 * NOTES_LEADING,
                            NOTES_SIZE,
                            false,
                            &mut replaced,
                        );
                    }
                    footer(&mut q, &mut replaced);
                    pages.push(q);
                    rest = after;
                }
            }
        }
    }
    Ok(Written {
        bytes: serialize(&pages, slides, &opts.title, &mut replaced),
        pages: pages.len(),
        replaced,
    })
}

/// The PDF file: catalog, page tree, font, info, the images, then each
/// page and its content stream, with the cross-reference table.
fn serialize(pages: &[Page], slides: &[Slide], title: &str, replaced: &mut usize) -> Vec<u8> {
    // Object numbers: 1 catalog, 2 pages, 3 font, 4 info, 5.. images, then
    // two per page (the page, its content).
    let img0 = 5;
    let page0 = img0 + slides.len();
    let count = page0 + 2 * pages.len();
    let mut out: Vec<u8> = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = vec![0usize; count];
    let mut obj = |out: &mut Vec<u8>, n: usize, body: &[u8]| {
        offsets[n] = out.len();
        out.extend_from_slice(format!("{n} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    obj(&mut out, 1, b"<< /Type /Catalog /Pages 2 0 R >>");
    let kids: Vec<String> = (0..pages.len())
        .map(|i| format!("{} 0 R", page0 + 2 * i))
        .collect();
    obj(
        &mut out,
        2,
        format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        )
        .as_bytes(),
    );
    obj(
        &mut out,
        3,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    obj(
        &mut out,
        4,
        format!(
            "<< /Title {} /Producer (paged.slide) >>",
            pdf_string(title, replaced)
        )
        .as_bytes(),
    );
    for (k, s) in slides.iter().enumerate() {
        let mut body = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {} >>\nstream\n",
            s.image.width,
            s.image.height,
            s.image.data.len()
        )
        .into_bytes();
        body.extend_from_slice(&s.image.data);
        body.extend_from_slice(b"\nendstream");
        obj(&mut out, img0 + k, &body);
    }
    for (i, p) in pages.iter().enumerate() {
        let n = page0 + 2 * i;
        let xobjects: String = p
            .images
            .iter()
            .map(|k| format!("/Im{k} {} 0 R ", img0 + k))
            .collect();
        obj(
            &mut out,
            n,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /Font << /F1 3 0 R >> /XObject << {xobjects}>> >> /Contents {} 0 R >>",
                f(p.size.0),
                f(p.size.1),
                n + 1
            )
            .as_bytes(),
        );
        let mut body = format!("<< /Length {} >>\nstream\n", p.ops.len()).into_bytes();
        body.extend_from_slice(p.ops.as_bytes());
        body.extend_from_slice(b"\nendstream");
        obj(&mut out, n + 1, &body);
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {count}\n0000000000 65535 f \n").as_bytes());
    for o in offsets.iter().skip(1) {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {count} /Root 1 0 R /Info 4 0 R >>\nstartxref\n{xref}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slides(n: u32, notes: &str) -> Vec<Slide> {
        (1..=n)
            .map(|i| Slide {
                image: image_from_rgba(&[200, 10, 10, 255].repeat(4 * 3), 4, 3).unwrap(),
                number: i,
                notes: notes.to_string(),
            })
            .collect()
    }

    fn opts(layout: Layout, per_page: u32) -> Options {
        Options {
            layout,
            per_page,
            paper: (612.0, 792.0),
            slide_size: (960.0, 540.0),
            title: "Deck (draft)".into(),
            frame: true,
        }
    }

    /// The page count the file's page tree declares, and its objects
    /// against the cross-reference table.
    fn check(bytes: &[u8]) -> usize {
        let find = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).rposition(|w| w == needle);
        let sx = find(bytes, b"startxref\n").unwrap() + 10;
        let tail = std::str::from_utf8(&bytes[sx..]).unwrap();
        let at: usize = tail.lines().next().unwrap().parse().unwrap();
        assert!(bytes[at..].starts_with(b"xref\n"));
        let table = std::str::from_utf8(&bytes[at..]).unwrap();
        let lines: Vec<&str> = table.lines().collect();
        let count: usize = lines[1].split(' ').nth(1).unwrap().parse().unwrap();
        for (n, l) in lines[3..2 + count].iter().enumerate() {
            let off: usize = l[..10].parse().unwrap();
            assert!(
                bytes[off..].starts_with(format!("{} 0 obj", n + 1).as_bytes()),
                "object {} at {off}",
                n + 1
            );
        }
        let c = find(bytes, b"/Type /Pages").unwrap();
        let tree = String::from_utf8_lossy(&bytes[c..c + 4000.min(bytes.len() - c)]);
        let k = tree.find("/Count ").unwrap() + 7;
        tree[k..].split(' ').next().unwrap().parse().unwrap()
    }

    #[test]
    fn handouts_fill_pages_of_n() {
        for (per, want) in [(1, 10), (2, 5), (3, 4), (4, 3), (6, 2), (9, 2)] {
            let w = write(&slides(10, ""), &opts(Layout::Handouts, per)).unwrap();
            assert_eq!(w.pages, want, "{per} a page");
            assert_eq!(check(&w.bytes), want);
        }
        assert!(write(&slides(2, ""), &opts(Layout::Handouts, 5)).is_err());
    }

    #[test]
    fn three_a_page_have_note_lines_and_handout_cells_do_not_overlap() {
        let cells = handout_cells(3, (612.0, 792.0), 16.0 / 9.0);
        assert_eq!(cells.len(), 3);
        for (s, l) in &cells {
            let l = l.unwrap();
            assert!(l.x > s.x + s.w, "the lines are beside the slide");
            assert!((s.w / s.h - 16.0 / 9.0).abs() < 1e-6);
        }
        for per in [1, 2, 4, 6, 9] {
            let cells = handout_cells(per, (595.28, 841.89), 4.0 / 3.0);
            assert_eq!(cells.len() as u32, per);
            for (i, (a, _)) in cells.iter().enumerate() {
                assert!(a.x >= 0.0 && a.x + a.w <= 595.28 && a.y + a.h <= 841.89);
                for (b, _) in &cells[i + 1..] {
                    let apart = a.x + a.w <= b.x
                        || b.x + b.w <= a.x
                        || a.y + a.h <= b.y
                        || b.y + b.h <= a.y;
                    assert!(apart, "{per} a page: {a:?} overlaps {b:?}");
                }
            }
        }
        let w = write(&slides(3, ""), &opts(Layout::Handouts, 3)).unwrap();
        let s = String::from_utf8_lossy(&w.bytes);
        assert!(s.matches(" l S Q").count() >= 3 * 4, "lines for notes");
    }

    #[test]
    fn slides_are_a_page_each_at_the_slide_size() {
        let w = write(&slides(3, ""), &opts(Layout::Slides, 1)).unwrap();
        assert_eq!(w.pages, 3);
        assert_eq!(check(&w.bytes), 3);
        let s = String::from_utf8_lossy(&w.bytes);
        assert_eq!(s.matches("/MediaBox [0 0 960 540]").count(), 3);
        assert_eq!(s.matches("/Subtype /Image /Width 4 /Height 3").count(), 3);
    }

    #[test]
    fn notes_pages_carry_the_notes_and_continue_when_long() {
        let w = write(
            &slides(2, "Say (hello) to Zoë — and Ω."),
            &opts(Layout::Notes, 1),
        )
        .unwrap();
        assert_eq!(w.pages, 2);
        let s = String::from_utf8_lossy(&w.bytes);
        assert!(s.contains("(Say \\(hello\\) to Zo\\353 \\227 and ?.) Tj"));
        // Ω twice (once per slide).
        assert_eq!(w.replaced, 2);
        let long = "word ".repeat(4000);
        let w = write(&slides(1, &long), &opts(Layout::Notes, 1)).unwrap();
        assert!(w.pages > 1);
        assert_eq!(check(&w.bytes), w.pages);
    }

    #[test]
    fn images_are_rgb_over_white() {
        let img = image_from_rgba(&[0, 0, 0, 0, 255, 0, 0, 255], 2, 1).unwrap();
        let mut d = flate2::read::ZlibDecoder::new(&img.data[..]);
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut d, &mut raw).unwrap();
        assert_eq!(raw, vec![255, 255, 255, 255, 0, 0]);
        assert!(image_from_rgba(&[0; 3], 1, 1).is_err());
    }

    #[test]
    fn wrapping_breaks_at_spaces_and_cuts_long_words() {
        let l = wrap("one two three four five six", 60.0, 12.0);
        assert!(l.len() > 1);
        for x in &l {
            assert!(helvetica::width(x, 12.0) <= 60.0 + 1e-9, "{x}");
        }
        assert_eq!(l.join(" "), "one two three four five six");
        assert_eq!(wrap("a\nb\n\n", 100.0, 12.0), vec!["a", "b"]);
        assert!(wrap(&"x".repeat(100), 30.0, 12.0).len() > 3);
    }
}
