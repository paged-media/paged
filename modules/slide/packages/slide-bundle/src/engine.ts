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

import {
  wasmBindgenModule,
  type WasmBindgenGlue,
} from "@paged-media/wasm-boot";

const ENGINE_NOT_BUILT =
  "paged.slide engine wasm not built: run scripts/build-wasm.sh";

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
export interface ImportReport {
  width: number;
  height: number;
  slides: SlideReport[];
  fonts: string[];
  embeddedFonts: EmbeddedFaceReport[];
  diagnostics: string[];
}

export interface Imported {
  /** The `.paged` package of the deck's native document (ADR 708). */
  paged: Uint8Array;
  report: ImportReport;
  /** The decoded embedded faces, one after the other (see
   *  `EmbeddedFaceReport.offset`). */
  fonts: Uint8Array;
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
  free(): void;
}

/** A written deck and what it could not carry (slide-js `ExportedDeck`). */
export interface ExportedDeck {
  bytes: Uint8Array;
  /** What the package could not carry. */
  diagnostics: string[];
  /** What is on the slides that could not round-trip, one line each. */
  notExported: string[];
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

interface SlideWasmModule extends WasmBindgenGlue {
  importPptx(bytes: Uint8Array, name: string): WasmImported;
  live(request: string): string;
  embeddedFonts(bytes: Uint8Array): WasmDeckFonts;
  exportPptx(
    original: Uint8Array,
    plan: string,
    document: Uint8Array | undefined,
  ): WasmExported;
}

/** The engine, booted once per realm (a failed boot is retried by the next
 *  call). */
export async function slideEngine(): Promise<SlideEngine> {
  return new SlideEngine(await loadModule());
}

export class SlideEngine {
  constructor(private readonly mod: SlideWasmModule) {}

  /** Read a `.pptx` into the `.paged` package of its native slides. Throws with
   *  the engine's message when the file is not a presentation. */
  importPptx(bytes: Uint8Array, name: string): Imported {
    const out = this.mod.importPptx(bytes, name);
    try {
      return {
        paged: out.paged,
        report: JSON.parse(out.report) as ImportReport,
        fonts: out.fonts,
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

  /** Write a `.pptx` from the deck the document was imported from and its
   *  slides in page order. With the document's `.paged` serialization,
   *  what is on the slides is written from it (edited and new slides
   *  regenerated, untouched ones kept byte for byte, ADR 711). */
  exportPptx(
    original: Uint8Array,
    slides: readonly SlidePlan[],
    document?: Uint8Array | null,
  ): ExportedDeck {
    const out = this.mod.exportPptx(
      original,
      JSON.stringify({ slides }),
      document ?? undefined,
    );
    try {
      return {
        bytes: out.bytes,
        diagnostics: JSON.parse(out.diagnostics) as string[],
        notExported: JSON.parse(out.notExported) as string[],
      };
    } finally {
      out.free();
    }
  }
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
