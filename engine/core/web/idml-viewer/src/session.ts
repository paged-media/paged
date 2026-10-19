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
 * The typed contract of the wasm `ViewerSession`
 * (`core/crates/paged-sdk/src/lib.rs`). The viewer programs against
 * this interface so tests can inject a fake session and embedders can
 * wrap their own init flow. Method names mirror the wasm-bindgen
 * exports (snake_case); the viewer surface re-exposes everything in
 * idiomatic camelCase.
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

/** Continuous-layout geometry from `page_layout()`. */
export interface SessionPageRect {
  index: number;
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

export interface ViewerSessionLike {
  load(idml: Uint8Array, font?: Uint8Array): SessionDiagnostics;
  register_font(
    family: string,
    style: string | undefined,
    bytes: Uint8Array,
  ): void;
  page_count(): number;
  set_page(index: number): void;
  page_layout(): SessionPagesLayout;
  /**
   * Camera-transformed present of the continuous page stack. `zoom`
   * is CSS px per pt; `scrollX`/`scrollY` place the doc origin in CSS
   * px; `onlyPage` restricts to one page laid out at y = 0.
   */
  present(
    zoom: number,
    scrollX: number,
    scrollY: number,
    dpr: number,
    onlyPage?: number | null,
  ): SessionDiagnostics;
  /** Binds the presenter to `canvas` on first call (fit-page paint). */
  render_to_canvas_main(canvas: HTMLCanvasElement): Promise<SessionDiagnostics>;
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
