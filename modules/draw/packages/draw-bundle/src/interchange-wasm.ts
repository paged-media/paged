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

// The INTERCHANGE half of the draw wasm (draw ADR 364): the typed facade
// over `crates/trace-js`'s DXF and SVG-paint exports, booted with the
// trace engine (one artifact, one instance per realm).
//
//   · dxfToSvg / svgToDxf — DXF in and out THROUGH SVG: the engine's
//     `document.importSvg` / `document.exportSvg` doors do the lowering
//     and the reading (`io/dxf.ts`), so there is one of each.
//   · svgColors / svgRecolor — the engine's SVG paint reader
//     (`paged-svg::paint`): the colours an SVG declares, and the same
//     file with them replaced, every other byte kept (the `recolor`
//     action, `actions.ts`).

import { bootDrawWasm } from "./trace-engine";

/** One row of a conversion report (the shape of the engine's
 *  `SvgReport`'s notes). */
export interface InterchangeNote {
  code: string;
  severity: "approximated" | "dropped";
  message: string;
  count: number;
}

/** What a conversion carried and what it could not. */
export interface InterchangeReport {
  items: number;
  notes: InterchangeNote[];
}

/** A DXF read into an SVG document (user units are points). */
export interface DxfImport {
  svg: string;
  report: InterchangeReport;
  /** The layers that drew something (each a named group). */
  layers: number;
  /** Points per drawing unit. */
  scale: number;
}

/** An SVG written as an ASCII DXF (AutoCAD 2010, millimetres). */
export interface DxfExport {
  dxf: string;
  report: InterchangeReport;
}

export type Rgb = readonly [number, number, number];

/** A colour an SVG declares, and how many places declare it. */
export interface DeclaredColor {
  rgb: Rgb;
  count: number;
}

export interface InterchangeEngine {
  /** Throws the reader's sentence when the bytes are not a DXF. */
  dxfToSvg(bytes: Uint8Array): DxfImport;
  /** Throws when the text is not an SVG or draws no path. */
  svgToDxf(svg: string): DxfExport;
  /** Throws when the text is not an SVG. */
  svgColors(svg: string): DeclaredColor[];
  /** `svg` with each `from` colour replaced by its `to`. */
  svgRecolor(svg: string, map: ReadonlyArray<readonly [Rgb, Rgb]>): string;
}

/** The wasm-bindgen glue throws a `Result`'s error as a string. */
function call<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Boot (once) and return the interchange engine. */
export async function bootInterchange(): Promise<InterchangeEngine> {
  const mod = await bootDrawWasm();
  return {
    dxfToSvg: (bytes) =>
      JSON.parse(call(() => mod.dxfToSvg(bytes))) as DxfImport,
    svgToDxf: (svg) => JSON.parse(call(() => mod.svgToDxf(svg))) as DxfExport,
    svgColors: (svg) =>
      (
        JSON.parse(call(() => mod.svgColors(svg))) as [
          number,
          number,
          number,
          number,
        ][]
      ).map(([r, g, b, count]) => ({ rgb: [r, g, b] as const, count })),
    svgRecolor: (svg, map) =>
      call(() => mod.svgRecolor(svg, JSON.stringify(map))),
  };
}
