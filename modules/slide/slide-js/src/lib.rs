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

//! The wasm-bindgen surface of paged.slide. One module serves import and
//! export; the TypeScript bundle never interprets PresentationML itself.
//!
//! Import (ADR 700): `importPptx` reads the deck, resolves its inheritance
//! and builds the native document the host opens (ADR 708), plus a JSON report
//! of what the bundle stores beside it (per-slide notes, transitions and
//! hidden flags by page id), the font families the deck uses and every
//! diagnostic.

pub mod anim;

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Read a `.pptx` and return the format-level IR as JSON (inspection).
#[wasm_bindgen(js_name = readPptx)]
pub fn read_pptx(bytes: &[u8]) -> Result<String, JsError> {
    let deck = pptx_import::import_pptx(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&deck).map_err(|e| JsError::new(&e.to_string()))
}

/// The result of [`import_pptx`]: the package, its report and the deck's
/// embedded faces.
#[wasm_bindgen]
pub struct Imported {
    paged: Vec<u8>,
    report: String,
    fonts: Vec<u8>,
    workbooks: Vec<u8>,
}

#[wasm_bindgen]
impl Imported {
    /// The `.paged` package for `host.nativeDocument.open`.
    #[wasm_bindgen(getter)]
    pub fn paged(&self) -> Vec<u8> {
        self.paged.clone()
    }

    /// [`Report`] as JSON.
    #[wasm_bindgen(getter)]
    pub fn report(&self) -> String {
        self.report.clone()
    }

    /// The decoded embedded faces, one after the other; each
    /// [`FaceReport`] in the report says where its bytes are.
    /// The chart workbooks, one after the other (see `ChartReport`).
    #[wasm_bindgen(getter)]
    pub fn workbooks(&self) -> Vec<u8> {
        self.workbooks.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn fonts(&self) -> Vec<u8> {
        self.fonts.clone()
    }
}

/// What an import produced beside the package.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Slide size in pt.
    pub width: f64,
    pub height: f64,
    pub slides: Vec<SlideReport>,
    /// Font families the deck's text uses (the host must have them).
    pub fonts: Vec<String>,
    /// The faces the deck embeds, and which of them the document may use.
    pub embedded_fonts: Vec<FaceReport>,
    /// The deck's charts and their workbooks (ADR 715).
    pub charts: Vec<ChartReport>,
    pub diagnostics: Vec<String>,
}

/// One embedded face: a style of a typeface the deck embeds.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceReport {
    /// The typeface the deck's text names.
    pub family: String,
    /// `Regular`, `Bold`, `Italic` or `Bold Italic` (a run's `FontStyle`).
    pub style: String,
    pub part: String,
    /// `editable` (the document uses it), or why it is not used:
    /// `previewAndPrint`, `restricted`, `bitmapOnly`, `sitesOnly`,
    /// `unreadable`, `missing`.
    #[serde(rename = "use")]
    pub use_: &'static str,
    /// OS/2 `fsType` (the embedding permissions), when the part was read.
    pub fs_type: Option<u16>,
    /// The face holds only the glyphs the deck uses.
    pub subset: bool,
    /// Where the decoded face sits in the fonts bytes (`length` 0 when it
    /// is not used).
    pub offset: usize,
    pub length: usize,
}

/// A deck's embedded faces as the report lists them, with their bytes.
fn face_reports(
    faces: pptx_import::fonts::EmbeddedFaces,
) -> (Vec<FaceReport>, Vec<u8>, Vec<String>) {
    let mut data = Vec::new();
    let reports = faces
        .faces
        .into_iter()
        .map(|f| {
            let offset = data.len();
            if let Some(sfnt) = &f.sfnt {
                data.extend_from_slice(sfnt);
            }
            FaceReport {
                family: f.typeface,
                style: f.style.to_string(),
                part: f.part,
                use_: f.use_.name(),
                fs_type: f.fs_type,
                subset: f.subset,
                offset,
                length: data.len() - offset,
            }
        })
        .collect();
    (reports, data, faces.diagnostics)
}

/// A deck's embedded faces: their report as JSON (`{ faces, diagnostics }`)
/// and their bytes.
#[wasm_bindgen]
pub struct DeckFonts {
    report: String,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl DeckFonts {
    #[wasm_bindgen(getter)]
    pub fn report(&self) -> String {
        self.report.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.data.clone()
    }
}

/// Decode the embedded faces of a `.pptx` without importing the deck: for a
/// document reopened from the source deck it keeps.
#[wasm_bindgen(js_name = embeddedFonts)]
pub fn embedded_fonts(bytes: &[u8]) -> Result<DeckFonts, JsError> {
    let faces = pptx_import::embedded_faces(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    let (faces, data, diagnostics) = face_reports(faces);
    #[derive(Serialize)]
    struct Out {
        faces: Vec<FaceReport>,
        diagnostics: Vec<String>,
    }
    Ok(DeckFonts {
        report: serde_json::to_string(&Out { faces, diagnostics })
            .map_err(|e| JsError::new(&e.to_string()))?,
        data,
    })
}

/// One slide, addressed by the page id it opens as.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideReport {
    pub page_id: String,
    /// The source slide part (`ppt/slides/slide3.xml`).
    pub part: String,
    pub hidden: bool,
    pub notes: Option<String>,
    pub transition: Option<pptx_core::Transition>,
    /// The slide's `p:timing` element as written, kept for export.
    pub timing_xml: Option<String>,
    /// Its top-level items, bottom to top.
    pub items: Vec<ItemReport>,
    /// Its review comments (modern and legacy), for the bundle's comments
    /// part (slide ADR 711).
    pub comments: Vec<pptx_core::Comment>,
}

/// A top-level item: the page element it became and where it sits.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemReport {
    pub name: String,
    /// Wire element kind (`polygon`, `rectangle`, `textFrame`, `group`).
    pub kind: String,
    /// The element's `Self` id.
    pub id: String,
    /// Page-space bounds of its outline (l, t, r, b), pt.
    pub bounds: [f64; 4],
    /// PowerPoint's `cNvPr id`.
    pub shape_id: u32,
    /// Placeholder type and idx, when it fills one.
    pub placeholder: Option<(String, Option<u32>)>,
}

/// Read a `.pptx` into the `.paged` package of its native slides.
#[wasm_bindgen(js_name = importPptx)]
pub fn import_pptx(bytes: &[u8], name: &str) -> Result<Imported, JsError> {
    let (paged, report, fonts, workbooks) =
        import_all(bytes, name).map_err(|e| JsError::new(&e))?;
    Ok(Imported {
        paged,
        workbooks,
        report: serde_json::to_string(&report).map_err(|e| JsError::new(&e.to_string()))?,
        fonts,
    })
}

/// [`import_pptx`] without the wasm types (native tests use this): the
/// package, the report and the embedded faces' bytes.
pub fn import(bytes: &[u8], name: &str) -> Result<(Vec<u8>, Report, Vec<u8>), String> {
    import_all(bytes, name).map(|(p, r, f, _)| (p, r, f))
}

/// An import: the package, the report, the embedded faces' bytes and the
/// chart workbooks' bytes.
pub type ImportedParts = (Vec<u8>, Report, Vec<u8>, Vec<u8>);

/// [`import`] with the chart workbooks' bytes (`ChartReport` offsets).
pub fn import_all(bytes: &[u8], name: &str) -> Result<ImportedParts, String> {
    let deck = pptx_import::import_pptx(bytes).map_err(|e| e.to_string())?;
    let pkg = paged_ooxml::OpcPackage::read(bytes).map_err(|e| e.to_string())?;
    // Live charts (ADR 715): every chart's workbook; a chart slide-chart
    // does not lay out is drawn by paged.sheet from its cells.
    let (mut charts, chart_diagnostics) = slide_sheet::DeckCharts::open(&pkg, &deck);
    let resolved = slide_resolve::resolve_with(&deck, &|p, w, h| charts.draw(p, w, h));
    let mut workbooks = Vec::new();
    let mut chart_reports = Vec::new();
    for (part, book) in charts.books.iter_mut() {
        let embedded = slide_sheet::embedded_part(&pkg, part);
        let xlsx = match (&embedded, book.origin()) {
            (Some((_, b)), slide_sheet::Origin::Embedded) => b.clone(),
            _ => book.save_xlsx()?,
        };
        let offset = workbooks.len();
        workbooks.extend_from_slice(&xlsx);
        chart_reports.push(ChartReport {
            part: part.clone(),
            origin: book.origin(),
            embedded_part: embedded.map(|(p, _)| p),
            drawn_by: if charts.slide_drawn.contains(part) {
                "slide"
            } else {
                "sheet"
            },
            offset,
            length: xlsx.len(),
        });
    }
    let (embedded_fonts, fonts, font_diagnostics) =
        face_reports(pptx_import::fonts::faces(&pkg, &deck.embedded_fonts));
    let images = |part: &str| pkg.part(part).map(|b| b.to_vec());
    let written = slide_native::write(&resolved, &images, name)?;
    let report = Report {
        width: resolved.width,
        height: resolved.height,
        slides: resolved
            .slides
            .iter()
            .map(|s| SlideReport {
                page_id: s.id.clone(),
                part: s.part.clone(),
                hidden: s.hidden,
                notes: s.notes.clone(),
                transition: s.transition.clone(),
                timing_xml: s.timing_xml.clone(),
                comments: deck
                    .slides
                    .iter()
                    .find(|x| x.part == s.part)
                    .map(|x| x.comments.clone())
                    .unwrap_or_default(),
                items: s
                    .items
                    .iter()
                    .filter_map(|it| {
                        let (kind, id) = written.elements.get(&it.id)?;
                        Some(ItemReport {
                            name: it.name.clone(),
                            kind: kind.to_string(),
                            id: id.clone(),
                            bounds: bounds(it),
                            shape_id: it.meta.shape_id,
                            placeholder: it.meta.placeholder.clone(),
                        })
                    })
                    .collect(),
            })
            .collect(),
        fonts: resolved.fonts.clone(),
        embedded_fonts,
        charts: chart_reports,
        diagnostics: deck
            .diagnostics
            .iter()
            .chain(&font_diagnostics)
            .chain(&resolved.diagnostics)
            .chain(&written.diagnostics)
            .chain(&chart_diagnostics)
            .cloned()
            .collect(),
    };
    Ok((written.paged, report, fonts, workbooks))
}

/// Page-space bounds of an item's drawn outline (a group: its members').
fn bounds(it: &slide_resolve::model::Item) -> [f64; 4] {
    use slide_resolve::model::ItemKind;
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut add = |m: &[f64; 6], x: f64, y: f64| {
        let (px, py) = (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
        b = [b[0].min(px), b[1].min(py), b[2].max(px), b[3].max(py)];
    };
    match &it.kind {
        ItemKind::Group { children } => {
            for c in children {
                let cb = bounds(c);
                add(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], cb[0], cb[1]);
                add(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], cb[2], cb[3]);
            }
        }
        // A filled shape's polygon carries its filled subpaths (the writer
        // puts stroke-only detail paths on a second polygon).
        ItemKind::Shape { outline, fill, .. } if !outline.is_empty() => {
            let filled = !matches!(fill, slide_resolve::model::Paint::None);
            for sp in outline.iter().filter(|s| s.filled || !filled) {
                for p in &sp.points {
                    add(&it.transform, p.anchor.0, p.anchor.1);
                }
            }
        }
        ItemKind::Picture { outline, .. } if !outline.is_empty() => {
            for sp in outline {
                for p in &sp.points {
                    add(&it.transform, p.anchor.0, p.anchor.1);
                }
            }
        }
        _ => {
            for (x, y) in [(0.0, 0.0), (it.w, 0.0), (it.w, it.h), (0.0, it.h)] {
                add(&it.transform, x, y);
            }
        }
    }
    b
}

/// The result of [`export_pptx`]: the deck and what it could not carry.
#[wasm_bindgen]
pub struct ExportedDeck {
    bytes: Vec<u8>,
    diagnostics: Vec<String>,
    not_exported: Vec<String>,
    rasters_needed: Vec<(String, f64)>,
}

#[wasm_bindgen]
impl ExportedDeck {
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    /// One message per thing the export could not carry, as JSON.
    #[wasm_bindgen(getter)]
    pub fn diagnostics(&self) -> String {
        serde_json::to_string(&self.diagnostics).unwrap_or_else(|_| "[]".into())
    }

    /// What is on the slides that could not round-trip, one line each, as
    /// JSON.
    #[wasm_bindgen(getter, js_name = notExported)]
    pub fn not_exported(&self) -> String {
        serde_json::to_string(&self.not_exported).unwrap_or_else(|_| "[]".into())
    }

    /// The pictures that need a PNG the host renders (an SVG's fallback, a
    /// format PowerPoint does not open), as JSON `[{id, dpi}]`. Export again
    /// with them in the plan's `rasters`.
    #[wasm_bindgen(getter, js_name = rastersNeeded)]
    pub fn rasters_needed(&self) -> String {
        let v: Vec<serde_json::Value> = self
            .rasters_needed
            .iter()
            .map(|(id, dpi)| serde_json::json!({ "id": id, "dpi": dpi }))
            .collect();
        serde_json::to_string(&v).unwrap_or_else(|_| "[]".into())
    }
}

/// Write a `.pptx` from the deck the document was imported from, the
/// document's slide plan (`pptx_export::ExportPlan` as JSON) and, when the
/// host can serialize it, the document itself (`.paged` bytes): what is on
/// the slides is then written from it (ADR 704, ADR 711).
#[wasm_bindgen(js_name = exportPptx)]
pub fn export_pptx(
    original: &[u8],
    plan: &str,
    document: Option<Vec<u8>>,
) -> Result<ExportedDeck, JsError> {
    let plan: pptx_export::ExportPlan =
        serde_json::from_str(plan).map_err(|e| JsError::new(&format!("plan: {e}")))?;
    let out = pptx_export::export_with(original, &plan, document.as_deref())
        .map_err(|e| JsError::new(&e))?;
    Ok(ExportedDeck {
        bytes: out.bytes,
        diagnostics: out.diagnostics,
        not_exported: out.not_exported,
        rasters_needed: out.rasters_needed,
    })
}

// ── live charts (ADR 715) ───────────────────────────────────────────────────

/// One chart part of an imported deck: its workbook, kept by the bundle as
/// a container part, and the frames that draw it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartReport {
    pub part: String,
    pub origin: slide_sheet::Origin,
    /// The embedded workbook's part, when the chart has one.
    pub embedded_part: Option<String>,
    /// `slide` (PowerPoint's layout from the values) or `sheet` (paged.sheet's
    /// chart engine).
    pub drawn_by: &'static str,
    /// Where the workbook sits in the workbooks bytes.
    pub offset: usize,
    pub length: usize,
}

/// The live charts of a deck document (ADR 715): its chart workbooks,
/// opened as the user edits them, and the redrawing of a chart frame from
/// its workbook as a page-item snippet.
#[wasm_bindgen]
pub struct LiveCharts {
    deck: pptx_core::Presentation,
    charts: slide_sheet::DeckCharts,
}

#[wasm_bindgen]
impl LiveCharts {
    /// The deck's charts, from the source deck the document keeps.
    #[wasm_bindgen(constructor)]
    pub fn new(pptx: &[u8]) -> Result<LiveCharts, JsError> {
        let deck = pptx_import::import_pptx(pptx).map_err(|e| JsError::new(&e.to_string()))?;
        let pkg = paged_ooxml::OpcPackage::read(pptx).map_err(|e| JsError::new(&e.to_string()))?;
        let (charts, _) = slide_sheet::DeckCharts::open(&pkg, &deck);
        Ok(LiveCharts { deck, charts })
    }

    /// Open a chart's workbook from the document's copy (`origin`:
    /// `embedded` or `synthesized`); without one, the deck's. Answers its
    /// grid (JSON).
    pub fn open(
        &mut self,
        part: &str,
        workbook: Option<Vec<u8>>,
        origin: &str,
    ) -> Result<String, JsError> {
        if let Some(bytes) = workbook {
            let origin = match origin {
                "synthesized" => slide_sheet::Origin::Synthesized,
                _ => slide_sheet::Origin::Embedded,
            };
            let xml = self
                .chart_xml(part)
                .ok_or_else(|| JsError::new(&format!("no chart part {part}")))?;
            let book = slide_sheet::ChartBook::reopen(&bytes, &xml, origin)
                .map_err(|e| JsError::new(&e))?;
            self.charts.books.insert(part.to_string(), book);
        }
        self.grid(part)
    }

    fn chart_xml(&self, part: &str) -> Option<Vec<u8>> {
        // The chart part as the deck has it, which every book keeps.
        self.charts
            .books
            .get(part)
            .map(|b| b.original_xml().to_vec())
    }

    fn book(&mut self, part: &str) -> Result<&mut slide_sheet::ChartBook, JsError> {
        self.charts
            .books
            .get_mut(part)
            .ok_or_else(|| JsError::new(&format!("chart {part} is not live")))
    }

    /// The chart's workbook as the data grid shows it (JSON
    /// `{ sheets: GridSheet[], origin }`).
    pub fn grid(&mut self, part: &str) -> Result<String, JsError> {
        let book = self.book(part)?;
        let v = serde_json::json!({ "sheets": book.grid(), "origin": book.origin() });
        Ok(v.to_string())
    }

    /// Enter `input` into a cell of the chart's workbook (`=…` a formula).
    /// Answers the grid.
    pub fn enter(
        &mut self,
        part: &str,
        sheet: &str,
        row: u32,
        col: u32,
        input: &str,
    ) -> Result<String, JsError> {
        self.book(part)?
            .enter(sheet, row, col, input)
            .map_err(|e| JsError::new(&e))?;
        self.grid(part)
    }

    /// The chart's workbook as an `.xlsx`.
    pub fn workbook(&mut self, part: &str) -> Result<Vec<u8>, JsError> {
        self.book(part)?.save_xlsx().map_err(|e| JsError::new(&e))
    }

    /// The chart frame `shapeId` of `slidePart` redrawn from its workbook,
    /// in the box `x, y, w, h` (pt, page space), as a page-item snippet
    /// for the engine's `pasteElements`.
    #[allow(clippy::too_many_arguments)] // a flat wasm signature
    pub fn snippet(
        &self,
        part: &str,
        slide_part: &str,
        shape_id: u32,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<String, JsError> {
        live_snippet(
            &self.deck,
            &self.charts,
            part,
            slide_part,
            shape_id,
            (x, y, w, h),
        )
        .map_err(|e| JsError::new(&e))
    }
}

/// [`LiveCharts::snippet`] without the wasm types.
pub fn live_snippet(
    deck: &pptx_core::Presentation,
    charts: &slide_sheet::DeckCharts,
    part: &str,
    slide_part: &str,
    shape_id: u32,
    frame: (f64, f64, f64, f64),
) -> Result<String, String> {
    let mut deck = deck.clone();
    if let (Some(book), Some(chart)) = (charts.books.get(part), deck.charts.get_mut(part)) {
        book.apply(chart);
    }
    let si = deck
        .slides
        .iter()
        .position(|s| s.part == slide_part)
        .ok_or_else(|| format!("no slide {slide_part}"))?;
    // The frame where the document has it now.
    const EMU: f64 = 12700.0;
    let found = deck.slides[si].shapes.iter_mut().find_map(|s| match s {
        pptx_core::Shape::Frame(f) if f.nv.id == shape_id => Some(f),
        _ => None,
    });
    let f = found.ok_or_else(|| format!("no chart frame {shape_id} on {slide_part}"))?;
    if let Some(x) = f.xfrm.as_mut() {
        x.off = (
            (frame.0 * EMU).round() as i64,
            (frame.1 * EMU).round() as i64,
        );
        x.ext = (
            (frame.2 * EMU).round() as i64,
            (frame.3 * EMU).round() as i64,
        );
    }
    let resolved = slide_resolve::resolve_with(&deck, &|p, w, h| charts.draw(p, w, h));
    let slide = resolved
        .slides
        .iter()
        .position(|s| s.part == slide_part)
        .ok_or_else(|| format!("{slide_part} did not resolve"))?;
    let item = resolved.slides[slide]
        .items
        .iter()
        .find(|i| i.meta.shape_id == shape_id && i.meta.chart.as_deref() == Some(part))
        .ok_or_else(|| format!("chart frame {shape_id} did not resolve"))?;
    slide_native::snippet(&resolved, slide, item)
}
/// The deck's outline (slide ADR 720) from the document's `.paged`
/// serialization: the titles and body paragraphs of `pages` (a JSON array
/// of page ids, in order) as `rtf` or `txt` (UTF-8) bytes.
#[wasm_bindgen(js_name = exportOutline)]
pub fn export_outline(document: &[u8], pages: &str, format: &str) -> Result<Vec<u8>, JsError> {
    outline_bytes(document, pages, format).map_err(|e| JsError::new(&e))
}

/// [`export_outline`] without the wasm boundary.
pub fn outline_bytes(document: &[u8], pages: &str, format: &str) -> Result<Vec<u8>, String> {
    let pages: Vec<String> = serde_json::from_str(pages).map_err(|e| format!("pages: {e}"))?;
    let o = pptx_export::outline::outline(document, &pages)?;
    match format {
        "rtf" => Ok(slide_output::outline_rtf(&o).into_bytes()),
        "txt" => Ok(slide_output::outline_txt(&o).into_bytes()),
        other => Err(format!("unknown outline format {other:?}")),
    }
}

/// A PDF of the deck's slides, handouts or notes pages (slide ADR 720),
/// built one slide at a time so a long deck never holds every image
/// uncompressed: each slide's pixels are deflated as they arrive.
#[wasm_bindgen]
pub struct PdfWriter {
    options: slide_output::pdf::Options,
    slides: Vec<slide_output::pdf::Slide>,
}

#[wasm_bindgen]
impl PdfWriter {
    /// `options`: `slide_output::pdf::Options` as JSON.
    #[wasm_bindgen(constructor)]
    pub fn new(options: &str) -> Result<PdfWriter, JsError> {
        let options =
            serde_json::from_str(options).map_err(|e| JsError::new(&format!("options: {e}")))?;
        Ok(PdfWriter {
            options,
            slides: Vec::new(),
        })
    }

    /// Add the next slide: its straight-alpha RGBA pixels, its number in
    /// the deck and its speaker notes.
    #[wasm_bindgen(js_name = addSlide)]
    pub fn add_slide(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
        number: u32,
        notes: &str,
    ) -> Result<(), JsError> {
        let image = slide_output::pdf::image_from_rgba(rgba, width, height)
            .map_err(|e| JsError::new(&e))?;
        self.slides.push(slide_output::pdf::Slide {
            image,
            number,
            notes: notes.to_string(),
        });
        Ok(())
    }

    /// Lay the slides out and write the file.
    pub fn finish(&self) -> Result<PdfOut, JsError> {
        let w =
            slide_output::pdf::write(&self.slides, &self.options).map_err(|e| JsError::new(&e))?;
        Ok(PdfOut {
            bytes: w.bytes,
            pages: w.pages as u32,
            replaced: w.replaced as u32,
        })
    }
}

/// A written PDF: its bytes, its page count and how many characters of
/// text the PDF's standard font could not draw.
#[wasm_bindgen]
pub struct PdfOut {
    bytes: Vec<u8>,
    pages: u32,
    replaced: u32,
}

#[wasm_bindgen]
impl PdfOut {
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn pages(&self) -> u32 {
        self.pages
    }
    #[wasm_bindgen(getter)]
    pub fn replaced(&self) -> u32 {
        self.replaced
    }
}

/// Live presets and connectors (slide ADR 717): one JSON request, one JSON
/// answer. `op` is
/// - `follow` (`elements`): what an edit to those page elements asks of
///   the live presets and connectors on them (`slide_native::live::follow`),
/// - `handles` (`element`): a preset's adjust handles on the page,
/// - `adjust` (`elements`, `target`, `index`, `point`): the writes a drag of
///   that handle to that page point makes,
/// - `newShape` (`prst`, `w`, `h`, `key`): a preset drawn as new elements,
/// - `gallery`: every preset by Insert ▸ Shapes category with a thumbnail,
/// - `picture` (`head`, base64): a picture's format and pixel size,
/// - `pictureFormats`: every picture format the engine reads.
#[wasm_bindgen(js_name = live)]
pub fn live(request: &str) -> Result<String, JsError> {
    live_json(request).map_err(|e| JsError::new(&e))
}

/// [`live`] without the wasm boundary.
pub fn live_json(request: &str) -> Result<String, String> {
    use slide_native::live as l;
    let v: serde_json::Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let field = |k: &str| v.get(k).cloned().unwrap_or(serde_json::Value::Null);
    let elements = || -> Result<Vec<l::Element>, String> {
        serde_json::from_value(field("elements")).map_err(|e| format!("elements: {e}"))
    };
    let out = match op {
        "follow" => serde_json::to_value(l::follow(&elements()?)),
        "handles" => {
            let e: l::Element =
                serde_json::from_value(field("element")).map_err(|e| format!("element: {e}"))?;
            serde_json::to_value(l::handles(&e))
        }
        "adjust" => {
            let target = v.get("target").and_then(|t| t.as_str()).unwrap_or("");
            let index = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            let point: [f64; 2] =
                serde_json::from_value(field("point")).map_err(|e| format!("point: {e}"))?;
            serde_json::to_value(l::adjust(&elements()?, target, index, point))
        }
        "newShape" => {
            let prst = v.get("prst").and_then(|p| p.as_str()).unwrap_or("");
            let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
            let key = v.get("key").and_then(|k| k.as_str()).unwrap_or("new:1");
            serde_json::to_value(l::new_shape(prst, num("w"), num("h"), key))
        }
        "gallery" => serde_json::to_value(l::gallery()),
        "picture" => {
            // A picture's format and pixel size from its first bytes
            // (base64; the header is enough, an SVG's root tag included).
            use base64::Engine;
            let head = v.get("head").and_then(|h| h.as_str()).unwrap_or("");
            let b = base64::engine::general_purpose::STANDARD
                .decode(head)
                .map_err(|e| format!("head: {e}"))?;
            Ok(match pptx_core::media::sniff(&b) {
                Some(f) => {
                    let size = pptx_core::media::pixel_size(&b);
                    serde_json::json!({
                        "format": f.extension(),
                        "mime": f.mime(),
                        "inDeck": f.in_deck(),
                        "width": size.map(|s| s.0),
                        "height": size.map(|s| s.1),
                    })
                }
                None => serde_json::Value::Null,
            })
        }
        "pictureFormats" => Ok(serde_json::json!(pptx_core::media::PicFormat::ALL
            .iter()
            .map(|f| serde_json::json!({ "format": f.extension(), "mime": f.mime() }))
            .collect::<Vec<_>>())),
        other => return Err(format!("unknown live op {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(out.to_string())
}

/// The live theme (slide ADR 713): one JSON request, one JSON answer.
/// `op` is
/// - `gallery`: the Design gallery's themes, each with its four variants,
/// - `variants` (`theme`): a theme's variants,
/// - `swatches` (`theme`, `ids`): the colour each theme swatch among `ids`
///   takes under `theme`, with its name (`[{id, name, rgb}]`),
/// - `read` (`data`, base64): the themes of a `.thmx`, `.potx` or `.pptx`,
///   as gallery themes (a `.thmx`'s own variants as its variants).
#[wasm_bindgen(js_name = theme)]
pub fn theme(request: &str) -> Result<String, JsError> {
    theme_json(request).map_err(|e| JsError::new(&e))
}

/// [`theme`] without the wasm boundary.
pub fn theme_json(request: &str) -> Result<String, String> {
    use slide_resolve::theme as th;
    let v: serde_json::Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let theme_arg = || -> Result<th::ThemeIr, String> {
        serde_json::from_value(v.get("theme").cloned().unwrap_or_default())
            .map_err(|e| format!("theme: {e}"))
    };
    let out = match op {
        "gallery" => serde_json::to_value(th::gallery()),
        "variants" => serde_json::to_value(th::variants(&theme_arg()?)),
        "swatches" => {
            let ids: Vec<String> =
                serde_json::from_value(v.get("ids").cloned().unwrap_or_default())
                    .map_err(|e| format!("ids: {e}"))?;
            Ok(serde_json::Value::Array(
                th::swatch_values(&theme_arg()?, &ids)
                    .into_iter()
                    .map(|(id, rgb)| {
                        let name = th::Key::of_swatch(&id).map(|k| k.name());
                        serde_json::json!({ "id": id, "name": name, "rgb": rgb })
                    })
                    .collect(),
            ))
        }
        "read" => {
            use base64::Engine;
            let data = v.get("data").and_then(|d| d.as_str()).unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| format!("data: {e}"))?;
            let themes = pptx_import::themes_in(&bytes).map_err(|e| e.to_string())?;
            serde_json::to_value(read_gallery(&themes))
        }
        other => return Err(format!("unknown theme op {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(out.to_string())
}

/// A package's themes as gallery themes: a theme under `themeVariants/` is
/// a variant of the main theme before it (a `.thmx`); every other theme is
/// a gallery theme of its own with the derived variants.
fn read_gallery(themes: &[pptx_core::Theme]) -> Vec<slide_resolve::theme::GalleryTheme> {
    use slide_resolve::theme as th;
    let mut out: Vec<th::GalleryTheme> = Vec::new();
    let mut own_variants: Vec<Vec<th::ThemeIr>> = Vec::new();
    for t in themes {
        let ir = th::ThemeIr::of(t);
        if t.part.contains("themeVariants/") {
            if let Some(v) = own_variants.last_mut() {
                let name = format!("Variant {}", v.len() + 1);
                v.push(th::ThemeIr {
                    variant: Some(name),
                    ..ir
                });
                continue;
            }
        }
        if out.iter().any(|g| g.theme == ir) {
            continue;
        }
        out.push(th::GalleryTheme {
            id: format!("file:{}", out.len() + 1),
            name: ir.name.clone(),
            variants: th::variants(&ir),
            theme: ir.clone(),
        });
        own_variants.push(vec![th::ThemeIr {
            variant: Some("Original".into()),
            ..ir
        }]);
    }
    for (g, own) in out.iter_mut().zip(own_variants) {
        if own.len() > 1 {
            g.variants = own;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::live_json;

    #[test]
    fn the_theme_door_lists_the_gallery_recolours_and_reads_a_decks_themes() {
        use super::theme_json;
        let g: serde_json::Value =
            serde_json::from_str(&theme_json(r#"{"op":"gallery"}"#).unwrap()).unwrap();
        assert!(g.as_array().unwrap().len() >= 6);
        let dark = g[2]["variants"][1].clone();
        let req = serde_json::json!({
            "op": "swatches",
            "theme": dark,
            "ids": ["Color/lt1", "Color/accent1 lumMod75000", "Color/R000000"],
        });
        let s: serde_json::Value =
            serde_json::from_str(&theme_json(&req.to_string()).unwrap()).unwrap();
        assert_eq!(s.as_array().unwrap().len(), 2);
        assert_eq!(s[1]["name"], "Accent 1, Darker 25%");
        let deck = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../slide-conformance/fixtures/text.pptx"),
        )
        .unwrap();
        use base64::Engine;
        let req = serde_json::json!({
            "op": "read",
            "data": base64::engine::general_purpose::STANDARD.encode(deck),
        });
        let r: serde_json::Value =
            serde_json::from_str(&theme_json(&req.to_string()).unwrap()).unwrap();
        // The deck's two masters share one theme.
        assert_eq!(r.as_array().unwrap().len(), 1);
        assert_eq!(r[0]["theme"]["major"], "Aptos Display");
        assert_eq!(r[0]["variants"].as_array().unwrap().len(), 4);
        assert!(theme_json(r#"{"op":"nope"}"#).unwrap_err().contains("nope"));
    }

    #[test]
    fn the_live_door_answers_json_and_names_an_unknown_op() {
        let g: serde_json::Value =
            serde_json::from_str(&live_json(r#"{"op":"gallery"}"#).unwrap()).unwrap();
        assert_eq!(g.as_array().unwrap().len(), 187);
        let s: serde_json::Value = serde_json::from_str(
            &live_json(r#"{"op":"newShape","prst":"roundRect","w":100,"h":50,"key":"new:1"}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(s["elements"], 1);
        assert_eq!(live_json(r#"{"op":"follow","elements":[]}"#).unwrap(), "[]");
        assert!(live_json(r#"{"op":"nope"}"#).unwrap_err().contains("nope"));
    }
}
