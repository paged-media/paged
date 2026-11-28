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

/**
 * The typed contract of the wasm `ViewerSession` (the engine's `paged-sdk`
 * crate, `engine/core/crates/paged-sdk/src/lib.rs`). The viewer programs
 * against it so tests can inject a fake session and embedders can wrap
 * their own init flow.
 *
 * Two shapes describe the same session. `ViewerSessionLike` carries the
 * names the wasm exports today, most of them snake_case; `ViewerSessionApi`
 * is the same surface in camelCase, the names to write new code against.
 * `adaptSession` turns either into a `ViewerSessionApi`, and `createViewer`
 * accepts both.
 */

/** One diagnostic from `load` / `render_*`. */
export interface SessionDiagnostic {
  /** `"error" | "warning" | "info"`. */
  severity: string;
  /** Short machine code, e.g. `"open"`, `"build"`, `"no_gpu"`. */
  code: string;
  message: string;
  part?: string | null;
  line?: number | null;
}

export interface SessionDiagnostics {
  ok: boolean;
  messages: SessionDiagnostic[];
}

/** One page's place in doc space (pt), from `page_layout()`. */
export interface SessionPageRect {
  index: number;
  /**
   * The page's left edge. 0 in the default vertical stack; the pages of a
   * spread sit side by side. Sessions older than protocol 77 omit it.
   */
  xPt?: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

export interface SessionPagesLayout {
  gapPt: number;
  pages: SessionPageRect[];
}

export interface SessionRaster {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** The session surface in camelCase. See `adaptSession`. */
export interface ViewerSessionApi {
  load(idml: Uint8Array, font?: Uint8Array): SessionDiagnostics;
  registerFont(
    family: string,
    style: string | undefined,
    bytes: Uint8Array,
  ): void;
  pageCount(): number;
  setPage(index: number): void;
  pageLayout(): SessionPagesLayout;
  /**
   * Camera-transformed present of the page layout. `zoom` is CSS px per
   * pt; `scrollX`/`scrollY` place the doc origin in CSS px; `onlyPage`
   * restricts to one page laid out at the origin.
   */
  present(
    zoom: number,
    scrollX: number,
    scrollY: number,
    dpr: number,
    onlyPage?: number | null,
  ): SessionDiagnostics;
  /** Binds the presenter to `canvas` on first call (fit-page paint). */
  renderToCanvasMain(canvas: HTMLCanvasElement): Promise<SessionDiagnostics>;
  renderPageToBytes(
    index: number,
    targetWidthPx: number,
  ): Promise<SessionRaster>;
  /** `width`/`height` are CSS px; the surface gets them times the ratio. */
  resize(width: number, height: number, devicePixelRatio: number): void;
  /**
   * After a present reported `gpu_lost` (the GPU process crashed, the
   * driver reset): request a new device and rebind the same canvas.
   * `true` when presents work again. Optional: older builds lack it.
   */
  recoverGpu?(): Promise<boolean>;
  /** wasm-bindgen finalizer. */
  free?(): void;
}

/**
 * The session under the names the wasm exports (wasm-bindgen keeps the
 * Rust method names). The snake_case members stay for as long as the wasm
 * exports them; call the camelCase names of `ViewerSessionApi` through
 * `adaptSession` instead.
 */
export interface ViewerSessionLike {
  load(idml: Uint8Array, font?: Uint8Array): SessionDiagnostics;
  /** @deprecated Call `registerFont` on `adaptSession(session)` or the viewer. */
  register_font(
    family: string,
    style: string | undefined,
    bytes: Uint8Array,
  ): void;
  /** @deprecated Call `pageCount` on `adaptSession(session)`. */
  page_count(): number;
  /** @deprecated Call `setPage` on `adaptSession(session)`. */
  set_page(index: number): void;
  /** @deprecated Call `pageLayout` on `adaptSession(session)`. */
  page_layout(): SessionPagesLayout;
  /**
   * Camera-transformed present of the page layout. `zoom` is CSS px per
   * pt; `scrollX`/`scrollY` place the doc origin in CSS px; `onlyPage`
   * restricts to one page laid out at the origin.
   */
  present(
    zoom: number,
    scrollX: number,
    scrollY: number,
    dpr: number,
    onlyPage?: number | null,
  ): SessionDiagnostics;
  /**
   * Binds the presenter to `canvas` on first call (fit-page paint).
   * @deprecated Call `renderToCanvasMain` on `adaptSession(session)`.
   */
  render_to_canvas_main(canvas: HTMLCanvasElement): Promise<SessionDiagnostics>;
  /** @deprecated Call `renderPageToBytes` on `adaptSession(session)`. */
  render_page_to_bytes(
    index: number,
    targetWidthPx: number,
  ): Promise<SessionRaster>;
  resize(width: number, height: number, devicePixelRatio: number): void;
  /**
   * After a present reported `gpu_lost` (the GPU process crashed, the
   * driver reset): request a new device and rebind the same canvas.
   * `true` when presents work again. Optional: older builds lack it.
   */
  recoverGpu?(): Promise<boolean>;
  /** wasm-bindgen finalizer. */
  free?(): void;
}

function isCamelSession(
  session: ViewerSessionLike | ViewerSessionApi,
): session is ViewerSessionApi {
  return (
    typeof (session as Partial<ViewerSessionApi>).renderToCanvasMain ===
    "function"
  );
}

/**
 * The camelCase view of a session. A session that already has the
 * camelCase names is returned as it is; one with the wasm's names is
 * wrapped, each call forwarded to the session (so it stays the owner of
 * its state and of `free`).
 */
export function adaptSession(
  session: ViewerSessionLike | ViewerSessionApi,
): ViewerSessionApi {
  if (isCamelSession(session)) return session;
  const api: ViewerSessionApi = {
    load: (idml, font) => session.load(idml, font),
    registerFont: (family, style, bytes) =>
      session.register_font(family, style, bytes),
    pageCount: () => session.page_count(),
    setPage: (index) => session.set_page(index),
    pageLayout: () => session.page_layout(),
    present: (zoom, scrollX, scrollY, dpr, onlyPage) =>
      session.present(zoom, scrollX, scrollY, dpr, onlyPage),
    renderToCanvasMain: (canvas) => session.render_to_canvas_main(canvas),
    renderPageToBytes: (index, targetWidthPx) =>
      session.render_page_to_bytes(index, targetWidthPx),
    resize: (width, height, devicePixelRatio) =>
      session.resize(width, height, devicePixelRatio),
    free: () => session.free?.(),
  };
  if (typeof session.recoverGpu === "function") {
    api.recoverGpu = () => session.recoverGpu!();
  }
  return api;
}
