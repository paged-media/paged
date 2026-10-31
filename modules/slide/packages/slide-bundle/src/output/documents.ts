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

// The deck's printed and text outputs (slide ADR 720): PDF slides,
// handouts and notes pages, and the outline as RTF or text.
//
// The PDF is laid out and written by the engine (slide-output, Rust) over
// images of the slides the host's renderer draws (`render.snapshot`, the
// pixels the show and thumbnails show). The host's own PDF export writes
// the open document's pages as they are and offers a plugin no door to
// impose them, and a temporary document of handout pages would have to
// replace the open one; so the slides are rasters here, at `dpi`, and File
// ▸ Export PDF stays the vector export of the slides one to a page.

import type { BundleHost } from "@paged-media/plugin-api";

import {
  exportOutline,
  pdfBuilder,
  type PdfOptions,
  type SlideEngine,
} from "../engine.js";
import type { Slide } from "../slides-model.js";

export type PdfLayout = "slides" | "handouts" | "notes";
export const HANDOUT_COUNTS = [1, 2, 3, 4, 6, 9] as const;

/** Paper sizes, pt, portrait. */
export const PAPER = {
  letter: [612, 792],
  a4: [595.28, 841.89],
} as const;
export type Paper = keyof typeof PAPER;

/** US Letter where it is the custom (the Americas' Letter countries), A4
 *  elsewhere. */
export function paperFor(locale: string | undefined): Paper {
  const region = (locale ?? "").split(/[-_]/)[1]?.toUpperCase() ?? "";
  return ["US", "CA", "MX", "PH", "CL", "CO", "VE", "GT", "PR"].includes(region)
    ? "letter"
    : "a4";
}

export interface PdfRequest {
  layout: PdfLayout;
  perPage?: number;
  paper?: Paper;
  /** Pixels per inch of the slide images (default 150). */
  dpi?: number;
  /** Print hidden slides too (PowerPoint's "Print Hidden Slides"). */
  includeHidden?: boolean;
  /** 1-based slide numbers to print (absent: all). */
  slides?: readonly number[];
  title?: string;
}

export interface Exported {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

/** The slides a request covers, in deck order. */
export function chosenSlides(
  slides: readonly Slide[],
  opts: { includeHidden?: boolean; slides?: readonly number[] },
): Slide[] {
  const only =
    opts.slides && opts.slides.length > 0 ? new Set(opts.slides) : null;
  return slides.filter(
    (s) =>
      (only ? only.has(s.number) : true) &&
      (opts.includeHidden || !s.state.hidden),
  );
}

/** A slide's pixels (straight-alpha RGBA) at `dpi`. */
async function pixels(
  host: BundleHost,
  pageId: string,
  dpi: number,
): Promise<{ rgba: Uint8Array; width: number; height: number } | null> {
  if (host.supports("render.snapshot@2")) {
    const r = await host.render.snapshot(pageId, { dpi, format: "rgba" });
    if (r?.rgba) return { rgba: r.rgba, width: r.widthPx, height: r.heightPx };
  }
  const r = await host.render.snapshot(pageId, { dpi });
  if (
    !r ||
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas === "undefined"
  )
    return null;
  const bmp = await createImageBitmap(
    new Blob([r.png as Uint8Array<ArrayBuffer>], { type: "image/png" }),
  );
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  return {
    rgba: new Uint8Array(d.data.buffer),
    width: c.width,
    height: c.height,
  };
}

export interface WrittenPdfExport extends Exported {
  pages: number;
  replaced: number;
}

/** The PDF of `slides` as `req` asks. */
export async function exportPdf(
  host: BundleHost,
  engine: SlideEngine,
  slides: readonly Slide[],
  req: PdfRequest,
  hooks: {
    onProgress?(done: number, total: number): void;
    signal?: AbortSignal;
  } = {},
): Promise<WrittenPdfExport> {
  const chosen = chosenSlides(slides, req);
  if (chosen.length === 0) throw new Error("no slide to print");
  const size = chosen[0]!.sizePt;
  const options: PdfOptions = {
    layout: req.layout,
    perPage: req.perPage ?? 6,
    paper: [...PAPER[req.paper ?? "letter"]] as [number, number],
    slideSize: [size[0], size[1]],
    title: req.title ?? "",
    frame: true,
  };
  if (
    req.layout === "handouts" &&
    !HANDOUT_COUNTS.includes(options.perPage as 1)
  )
    throw new Error(
      `handouts take 1, 2, 3, 4, 6 or 9 slides a page, not ${options.perPage}`,
    );
  const pdf = pdfBuilder(engine, options);
  try {
    for (const [i, s] of chosen.entries()) {
      if (hooks.signal?.aborted)
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      const px = await pixels(host, s.pageId, req.dpi ?? 150);
      if (!px) throw new Error(`slide ${s.number} could not be drawn`);
      pdf.addSlide(px.rgba, px.width, px.height, s.number, s.state.notes ?? "");
      hooks.onProgress?.(i + 1, chosen.length);
    }
    const out = pdf.finish();
    const suffix =
      req.layout === "slides"
        ? ""
        : req.layout === "notes"
          ? " (notes)"
          : " (handouts)";
    return {
      bytes: out.bytes,
      pages: out.pages,
      replaced: out.replaced,
      fileName: `${req.title || "presentation"}${suffix}.pdf`,
      mimeType: "application/pdf",
    };
  } finally {
    pdf.dispose();
  }
}

/** The outline of the deck as RTF or text, read by the engine from the
 *  document's `.paged` serialization. */
export async function exportOutlineFile(
  host: BundleHost,
  engine: SlideEngine,
  slides: readonly Slide[],
  format: "rtf" | "txt",
  title: string,
): Promise<Exported> {
  if (!host.supports("documents.exportPaged@1"))
    throw new Error("this host cannot hand the document to the outline export");
  const doc = await host.documents.exportPaged();
  const bytes = exportOutline(
    engine,
    doc,
    slides.map((s) => s.pageId),
    format,
  );
  return {
    bytes,
    fileName: `${title || "presentation"}.${format}`,
    mimeType: format === "rtf" ? "application/rtf" : "text/plain;charset=utf-8",
  };
}
