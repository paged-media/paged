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

// The typed engine facade. The Rust wasm (slide-js) does all the PPTX work:
// OPC and PresentationML reading, inheritance, geometry, the native document.
// This file only boots it and types its JSON report (CLAUDE.md hard rule:
// no PresentationML semantics in TypeScript).
//
// Boot: the artifact is the wasm-bindgen `--target web` glue
// (bin/slide_js.js + bin/slide_js_bg.wasm, built by scripts/build-wasm.sh).
// It is loaded in the bundle's realm through @paged-media/wasm-boot, once per
// realm, browser or Node; until it is built the dynamic import rejects and
// boot says so.

import { bytesToBase64 } from "@paged-media/helpers";
import {
  wasmBindgenModule,
  type WasmBindgenGlue,
} from "@paged-media/wasm-boot";

import type {
  EffectList,
  GalleryPreset,
  PlayerEvent,
  PlayerFrame,
  PlayerInput,
  Timing,
  TimingEdit,
} from "./anim/model.js";

const ENGINE_NOT_BUILT =
  "paged.slide engine wasm not built: run scripts/build-wasm.sh";

/** A theme as data (slide-resolve `ThemeIr`, slide ADR 713): its name, the
 *  twelve slots as `RRGGBB` (`dk1`, `lt1`, `dk2`, `lt2`, `accent1`–`6`,
 *  `hlink`, `folHlink`), the major and minor Latin fonts. */
export interface ThemeIr {
  name: string;
  colors: [string, string][];
  major: string;
  minor: string;
  /** The variant applied, by name. */
  variant?: string;
}

/** One theme of the Design gallery, with its variants. */
export interface GalleryTheme {
  id: string;
  name: string;
  theme: ThemeIr;
  variants: ThemeIr[];
}

/** A theme swatch's colour under a theme (0–255 channels). */
export interface ThemeSwatch {
  id: string;
  name: string | null;
  rgb: [number, number, number];
}

/** A DrawingML transition as the deck wrote it (pptx-core `Transition`). */
export interface Transition {
  xml: string;
  kind: string | null;
  dir: string | null;
  speed: string | null;
  duration_ms: number | null;
  advance_on_click: boolean | null;
  advance_after_ms: number | null;
}

/** A slide's top-level item: the page element it became. */
export interface ItemReport {
  name: string;
  kind: "polygon" | "rectangle" | "textFrame" | "group";
  id: string;
  /** Page-space bounds of its outline (l, t, r, b), pt. */
  bounds: [number, number, number, number];
  shapeId: number;
  placeholder: [string, number | null] | null;
}

/** One slide, by the page id it opened as. */
export interface SlideReport {
  pageId: string;
  part: string;
  hidden: boolean;
  notes: string | null;
  transition: Transition | null;
  timingXml: string | null;
  items: ItemReport[];
  /** The slide's comments, threaded and legacy (pptx-core `Comment`). */
  comments?: SlideComment[];
}

/** A reply in a comment's thread (pptx-core `CommentReply`). */
export interface CommentReply {
  id: string;
  authorId: string;
  author: string;
  initials: string;
  /** As the deck wrote it (ISO 8601), or null. */
  created: string | null;
  /** Plain text; paragraphs joined with a line break. */
  text: string;
}

/** A comment on a slide (pptx-core `Comment`): PowerPoint's modern threaded
 *  comment, or a legacy one (`legacy`, converted to a threaded comment
 *  when its slide's comments are written). */
export interface SlideComment extends CommentReply {
  /** Where it sits on the slide, pt; null when it is the slide's. */
  x: number | null;
  y: number | null;
  /** The `cNvPr id` of the shape it is anchored to. */
  shapeId: number | null;
  /** null is active. */
  status: "active" | "resolved" | "closed" | null;
  replies: CommentReply[];
  legacy: boolean;
}

/** A face the deck embeds (slide-js `FaceReport`): a style of one of its
 *  typefaces, and whether the document may use it (`editable`) or why not. */
export interface EmbeddedFaceReport {
  /** The typeface the deck's text names. */
  family: string;
  /** `Regular`, `Bold`, `Italic` or `Bold Italic` (a run's FontStyle). */
  style: string;
  part: string;
  use:
    | "editable"
    | "previewAndPrint"
    | "restricted"
    | "bitmapOnly"
    | "sitesOnly"
    | "unreadable"
    | "missing";
  /** OS/2 fsType (the embedding permissions), when the part was read. */
  fsType: number | null;
  /** The face holds only the glyphs the deck uses. */
  subset: boolean;
  /** Where the decoded face sits in the fonts bytes (length 0: not used). */
  offset: number;
  length: number;
}

/** What an import produced beside the package (slide-js `Report`). */
/** A chart part of the deck and its workbook (slide ADR 715). */
export interface ChartReport {
  part: string;
  origin: "embedded" | "synthesized";
  /** The embedded workbook's part, when the chart has one. */
  embeddedPart: string | null;
  /** `slide`: PowerPoint's layout from the values; `sheet`: paged.sheet's
   *  chart engine. */
  drawnBy: "slide" | "sheet";
  /** Where the workbook sits in `Imported.workbooks`. */
  offset: number;
  length: number;
}

export interface ImportReport {
  width: number;
  height: number;
  slides: SlideReport[];
  fonts: string[];
  embeddedFonts: EmbeddedFaceReport[];
  /** Absent in a report kept by an older version. */
  charts?: ChartReport[];
  diagnostics: string[];
}

export interface Imported {
  /** The `.paged` package of the deck's native document (ADR 708). */
  paged: Uint8Array;
  report: ImportReport;
  /** The decoded embedded faces, one after the other (see
   *  `EmbeddedFaceReport.offset`). */
  fonts: Uint8Array;
  /** The chart workbooks, one after the other (see `ChartReport.offset`). */
  workbooks: Uint8Array;
}

/** A deck's embedded faces, decoded without importing it. */
export interface DeckFonts {
  faces: EmbeddedFaceReport[];
  diagnostics: string[];
  data: Uint8Array;
}

interface WasmImported {
  readonly paged: Uint8Array;
  readonly report: string;
  readonly fonts: Uint8Array;
  readonly workbooks?: Uint8Array;
  free(): void;
}

/** The live charts of a deck document (slide ADR 715): its chart
 *  workbooks, opened in paged.sheet's engine, and a chart frame redrawn
 *  from its workbook as the engine's page-item snippet. */
export interface LiveCharts {
  /** Open a chart's workbook from the document's copy (or the deck's);
   *  answers its grid as JSON. */
  open(
    part: string,
    workbook: Uint8Array | undefined,
    origin: "embedded" | "synthesized",
  ): string;
  grid(part: string): string;
  /** Enter a cell (`=…` a formula); answers the grid. Throws when the
   *  workbook refuses the input. */
  enter(
    part: string,
    sheet: string,
    row: number,
    col: number,
    input: string,
  ): string;
  /** The workbook as an `.xlsx`. */
  workbook(part: string): Uint8Array;
  /** The frame `shapeId` of `slidePart` redrawn in the box x, y, w, h (pt). */
  snippet(
    part: string,
    slidePart: string,
    shapeId: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): string;
  free(): void;
}

interface WasmDeckFonts {
  readonly report: string;
  readonly data: Uint8Array;
  free(): void;
}

interface WasmExported {
  readonly bytes: Uint8Array;
  readonly diagnostics: string;
  readonly notExported: string;
  readonly rastersNeeded?: string;
  free(): void;
}

/** A picture the export needs a PNG of (an SVG's fallback, a format
 *  PowerPoint does not open): the element and the resolution to render it
 *  at. */
export interface RasterNeed {
  id: string;
  dpi: number;
}

/** What a picture file is (pptx-core `media`). */
export interface PictureInfo {
  /** The format's extension (`png`, `jpeg`, `svg`, `webp`, …). */
  format: string;
  mime: string;
  /** PowerPoint holds it as it is (PNG, JPEG, GIF, BMP, TIFF). */
  inDeck: boolean;
  /** Pixels (an SVG's in CSS pixels); null when the header does not say. */
  width: number | null;
  height: number | null;
}

/** A written deck and what it could not carry (slide-js `ExportedDeck`). */
export interface ExportedDeck {
  bytes: Uint8Array;
  /** What the package could not carry. */
  diagnostics: string[];
  /** What is on the slides that could not round-trip, one line each. */
  notExported: string[];
  /** Pictures written without the PNG they need; render them and export
   *  again with them in `DeckPlan.rasters`. */
  rastersNeeded: RasterNeed[];
}

/** A chart whose workbook the document edited (pptx-export `ChartPlan`). */
export interface ChartPlan {
  part: string;
  origin: "embedded" | "synthesized";
  /** The workbook (`.xlsx`), base64. */
  workbook: string;
}

/** One page of the document, as export sees it (pptx-export `SlidePlan`). */
export interface SlidePlan {
  sourcePart: string;
  hidden: boolean;
  notes: string | null;
  contentEdited: boolean;
  /** The page's id: its content in the document (ADR 711). */
  pageId: string;
  /** The layout (master spread) a slide made in the editor uses. */
  layout: string | null;
  /** The slide's comments as the document holds them; absent: write them
   *  as the deck had them. */
  comments?: SlideComment[];
  /** The slide's animations as the document holds them (slide ADR 714);
   *  absent: as the deck had them. No effects: `{ nodes: [] }`. */
  timing?: Timing;
}

/** One labelled page element as the live-preset door takes it
 *  (slide-native `live::Element`, slide ADR 717). */
export interface LiveElement {
  id: string;
  /** The host's element kind: `polygon`, `rectangle`, `textFrame`, … */
  kind: string;
  /** The slide label's envelope JSON. */
  label: string;
  /** A path's anchors (`anchor`, `left`, `right`), own coordinates. */
  anchors?: [number, number][][];
  starts?: number[];
  /** Own coordinates → page. */
  transform: [number, number, number, number, number, number];
  /** `[top, left, bottom, right]`, own coordinates (a text frame). */
  bounds?: [number, number, number, number] | null;
}

/** What to write to one element (slide-native `live::Write`). */
export interface LiveWrite {
  id: string;
  kind: string;
  anchors?: [number, number][][];
  starts?: number[];
  transform?: [number, number, number, number, number, number];
  bounds?: [number, number, number, number];
  label?: string;
  /** The element's new outline on the page, SVG path data (a preview). */
  path?: string;
}

/** An adjust handle on the page. */
export interface PageHandle {
  index: number;
  pos: [number, number];
  polar: boolean;
}

/** A preset drawn as a new shape: the paste door's snippet. */
export interface NewShape {
  snippet: string;
  elements: number;
}

/** One gallery entry: a preset, its Insert ▸ Shapes category and a 40 × 30
 *  thumbnail as SVG path data. */
export interface GalleryItem {
  prst: string;
  category: string;
  path: string;
}

interface WasmAnimPlayer {
  clicks(): number;
  evaluate(events: string, nowMs: number): string;
  free(): void;
}

/** What a deck export writes beyond its slides (pptx-export `ExportPlan`,
 *  slide ADR 720). Absent fields: as the deck had them. */
export interface DeckPlan {
  /** The package kind: `pptx`, `potx` (a template) or `ppsx`. */
  format?: "pptx" | "potx" | "ppsx";
  sections?: { id?: string; name: string; firstPage: string }[];
  customShows?: { id?: number; name: string; pages: string[] }[];
  /** The charts whose data the document changed (slide ADR 715). */
  charts?: readonly ChartPlan[];
  /** PNGs of pictures PowerPoint cannot hold as they are, by element id,
   *  base64 (what `ExportedDeck.rastersNeeded` asked for). */
  rasters?: Readonly<Record<string, string>>;
}

/** What a PDF is asked to be (slide-output `pdf::Options`). */
export interface PdfOptions {
  layout: "slides" | "handouts" | "notes";
  /** Handouts: 1, 2, 3, 4, 6 or 9 slides a page. */
  perPage?: number;
  /** Paper for handouts and notes pages, pt, portrait. */
  paper?: [number, number];
  slideSize: [number, number];
  title?: string;
  frame?: boolean;
}

/** A written PDF. */
export interface WrittenPdf {
  bytes: Uint8Array;
  pages: number;
  /** Characters the PDF's standard font could not draw (shown as `?`). */
  replaced: number;
}

/** The wasm PDF writer: slides added one at a time, then the file. */
export interface PdfBuilder {
  addSlide(
    rgba: Uint8Array,
    width: number,
    height: number,
    number: number,
    notes: string,
  ): void;
  finish(): WrittenPdf;
  dispose(): void;
}

interface WasmPdfWriter {
  addSlide(
    rgba: Uint8Array,
    width: number,
    height: number,
    number: number,
    notes: string,
  ): void;
  finish(): {
    bytes: Uint8Array;
    pages: number;
    replaced: number;
    free(): void;
  };
  free(): void;
}

export interface SlideWasmModule extends WasmBindgenGlue {
  exportOutline(
    document: Uint8Array,
    pages: string,
    format: string,
  ): Uint8Array;
  PdfWriter: new (options: string) => WasmPdfWriter;
  LiveCharts: new (pptx: Uint8Array) => LiveCharts;
  importPptx(bytes: Uint8Array, name: string): WasmImported;
  live(request: string): string;
  theme(request: string): string;
  anim(request: string): string;
  AnimPlayer: new (input: string) => WasmAnimPlayer;
  embeddedFonts(bytes: Uint8Array): WasmDeckFonts;
  exportPptx(
    original: Uint8Array,
    plan: string,
    document: Uint8Array | undefined,
  ): WasmExported;
}

/** The engine, booted once per realm (a failed boot is retried by the next
 *  call). */
/** The live charts of the deck `pptx` (the source deck a document keeps). */
export async function liveCharts(pptx: Uint8Array): Promise<LiveCharts> {
  const mod = await loadModule();
  return new mod.LiveCharts(pptx);
}

export async function slideEngine(): Promise<SlideEngine> {
  return new SlideEngine(await loadModule());
}

export class SlideEngine {
  constructor(private readonly mod: SlideWasmModule) {}

  /** The wasm module itself (the output writers, engine.ts). */
  module(): SlideWasmModule {
    return this.mod;
  }

  /** Read a `.pptx` into the `.paged` package of its native slides. Throws with
   *  the engine's message when the file is not a presentation. */
  importPptx(bytes: Uint8Array, name: string): Imported {
    const out = this.mod.importPptx(bytes, name);
    try {
      return {
        paged: out.paged,
        report: JSON.parse(out.report) as ImportReport,
        fonts: out.fonts,
        workbooks: out.workbooks ?? new Uint8Array(),
      };
    } finally {
      out.free();
    }
  }

  /** Decode a deck's embedded faces without importing it (a document
   *  reopened from the source deck it keeps). */
  embeddedFonts(bytes: Uint8Array): DeckFonts {
    const out = this.mod.embeddedFonts(bytes);
    try {
      const { faces, diagnostics } = JSON.parse(out.report) as Omit<
        DeckFonts,
        "data"
      >;
      return { faces, diagnostics, data: out.data };
    } finally {
      out.free();
    }
  }

  /** The live theme (slide ADR 713): one JSON request to the Rust side,
   *  which knows the theme keys and the gallery. */
  private theme<T>(request: object): T {
    return JSON.parse(this.mod.theme(JSON.stringify(request))) as T;
  }

  /** The Design gallery's themes, each with its four variants. */
  themeGallery(): GalleryTheme[] {
    return this.theme({ op: "gallery" });
  }

  /** A theme's four variants (as it is, dark, shifted accents, muted). */
  themeVariants(theme: ThemeIr): ThemeIr[] {
    return this.theme({ op: "variants", theme });
  }

  /** The colour each theme swatch among `ids` takes under `theme`. */
  themeSwatches(theme: ThemeIr, ids: readonly string[]): ThemeSwatch[] {
    return this.theme({ op: "swatches", theme, ids });
  }

  /** The themes of a `.thmx`, `.potx` or `.pptx` (Browse for Themes). */
  readThemes(bytes: Uint8Array): GalleryTheme[] {
    return this.theme({ op: "read", data: bytesToBase64(bytes) });
  }

  /** Live presets and connectors (slide ADR 717): one JSON request to the
   *  Rust side, which knows the labels and the geometry. */
  private live<T>(request: object): T {
    return JSON.parse(this.mod.live(JSON.stringify(request))) as T;
  }

  /** What an edit to these page elements asks of their live presets and
   *  connectors: resized presets drawn again, connectors re-routed. */
  follow(elements: readonly LiveElement[]): LiveWrite[] {
    return this.live({ op: "follow", elements });
  }

  /** A live preset's adjust handles on the page (none for a reshaped one). */
  handles(element: LiveElement): PageHandle[] {
    return this.live({ op: "handles", element });
  }

  /** The writes a drag of handle `index` of `target` to `point` makes. */
  adjust(
    elements: readonly LiveElement[],
    target: string,
    index: number,
    point: [number, number],
  ): LiveWrite[] {
    return this.live({ op: "adjust", elements, target, index, point });
  }

  /** Preset `prst` drawn as a new `w` × `h` shape labelled `key`. */
  newShape(prst: string, w: number, h: number, key: string): NewShape | null {
    return this.live({ op: "newShape", prst, w, h, key });
  }

  /** Every preset by Insert ▸ Shapes category, with a thumbnail. */
  gallery(): GalleryItem[] {
    return this.live({ op: "gallery" });
  }

  /** Animations (slide ADR 714): one JSON request to the Rust side, which
   *  reads, edits and evaluates timings. */
  private anim<T>(request: object): T {
    return JSON.parse(this.mod.anim(JSON.stringify(request))) as T;
  }

  /** A slide's effects as the Animation Pane lists them. */
  effects(timing: Timing | null): EffectList {
    if (!timing) return { effects: [], clicks: 0 };
    return this.anim({ op: "list", timing });
  }

  /** Every preset by class (the Add Animation gallery). */
  animationGallery(): GalleryPreset[] {
    return this.anim({ op: "gallery" });
  }

  /** `timing` with `edit` made; null when no effect is left. */
  editTiming(timing: Timing | null, edit: TimingEdit): Timing | null {
    return this.anim<{ timing: Timing | null }>({ op: "edit", timing, edit })
      .timing;
  }

  /** A player for one slide's timing: compiled once, evaluated per frame. */
  animPlayer(input: PlayerInput): AnimPlayer {
    return new AnimPlayer(new this.mod.AnimPlayer(JSON.stringify(input)));
  }

  /** What a picture file is, from its first bytes; null for a format the
   *  engine does not read. */
  picture(bytes: Uint8Array): PictureInfo | null {
    const head = bytes.subarray(0, 64 * 1024);
    return this.live({ op: "picture", head: bytesToBase64(head) });
  }

  /** Every picture format the engine reads (the picker's types). */
  pictureFormats(): { format: string; mime: string }[] {
    return this.live({ op: "pictureFormats" });
  }

  /** Write a `.pptx` from the deck the document was imported from and its
   *  slides in page order. With the document's `.paged` serialization,
   *  what is on the slides is written from it (edited and new slides
   *  regenerated, untouched ones kept byte for byte, ADR 711). `deck` is
   *  what it writes beyond the slides: the package kind, sections and
   *  custom shows (ADR 720), and the charts whose data the document edited
   *  (ADR 715). */
  exportPptx(
    original: Uint8Array,
    slides: readonly SlidePlan[],
    document?: Uint8Array | null,
    deck: DeckPlan = {},
  ): ExportedDeck {
    const out = this.mod.exportPptx(
      original,
      JSON.stringify({ ...deck, slides, charts: deck.charts ?? [] }),
      document ?? undefined,
    );
    try {
      return {
        bytes: out.bytes,
        diagnostics: JSON.parse(out.diagnostics) as string[],
        notExported: JSON.parse(out.notExported) as string[],
        rastersNeeded: JSON.parse(out.rastersNeeded ?? "[]") as RasterNeed[],
      };
    } finally {
      out.free();
    }
  }
}

/** One slide's animations, compiled (slide-anim `AnimPlayer`). */
export class AnimPlayer {
  private freed = false;
  constructor(private readonly p: WasmAnimPlayer) {}

  /** Clicks the main sequence takes before the slide advances. */
  clicks(): number {
    return this.freed ? 0 : this.p.clicks();
  }

  /** The layers' state at `nowMs` after the slide started, given the
   *  clicks so far. */
  evaluate(events: readonly PlayerEvent[], nowMs: number): PlayerFrame {
    if (this.freed)
      return { layers: {}, running: false, nextChange: null, commands: [] };
    return JSON.parse(
      this.p.evaluate(JSON.stringify(events), nowMs),
    ) as PlayerFrame;
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.p.free();
  }
}

/** The engine's outline (titles, body levels) of `pages` of the document,
 *  as RTF or UTF-8 text (slide ADR 720). */
export function exportOutline(
  engine: SlideEngine,
  document: Uint8Array,
  pages: readonly string[],
  format: "rtf" | "txt",
): Uint8Array {
  return engine.module().exportOutline(document, JSON.stringify(pages), format);
}

/** A PDF writer on the engine (slide ADR 720). */
export function pdfBuilder(
  engine: SlideEngine,
  options: PdfOptions,
): PdfBuilder {
  const w = new (engine.module().PdfWriter)(JSON.stringify(options));
  return {
    addSlide: (rgba, width, height, number, notes) =>
      w.addSlide(rgba, width, height, number, notes),
    finish() {
      const out = w.finish();
      try {
        return { bytes: out.bytes, pages: out.pages, replaced: out.replaced };
      } finally {
        out.free();
      }
    },
    dispose: () => w.free(),
  };
}

/** The one instantiation per realm (wasm-boot's single flight). */
const loadModule = wasmBindgenModule<SlideWasmModule>({
  // @ts-ignore: built by scripts/build-wasm.sh, absent from the source tree.
  glue: () => import("../bin/slide_js.js"),
  // @ts-ignore: `?url` is a bundler affordance (the editor's wasm convention).
  wasmUrl: () => import("../bin/slide_js_bg.wasm?url"),
  wasmFile: () => new URL("../bin/slide_js_bg.wasm", import.meta.url),
  notBuilt: ENGINE_NOT_BUILT,
});
