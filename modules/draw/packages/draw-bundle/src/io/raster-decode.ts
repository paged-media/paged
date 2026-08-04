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

// ENCODED placed-image bytes → RGBA8 pixels, using the PLATFORM's own
// decoders.
//
// WHY NOT IN THE WASM. `host.assets.getPlacedImage` (C-5 / I-04) serves
// the ORIGINAL file — PNG / JPEG / TIFF / PSD, undecoded. Decoding those
// is the one part of this pipeline the browser already does, natively,
// for every format it can place: `createImageBitmap` + `OffscreenCanvas`
// gives correct, colour-managed RGBA with no bytes added to the plugin's
// wasm budget. Bundling a codec set into `trace-js` would duplicate what
// the host realm already has and would still not cover PSD.
//
// WHAT THAT COSTS, named: the tracer sees what the BROWSER can decode. A
// placed PSD or a CMYK TIFF that `createImageBitmap` refuses is a
// REFUSAL here, not a silent blank — and the refusal says which format
// failed. paged.image's Rust codec/PSD lane is the place that gap gets
// closed if it matters, not a second decoder here.
//
// REALM. `createImageBitmap` / `OffscreenCanvas` exist in the editor's
// window realm, where first-party bundles run. They do NOT exist in Node,
// so the headless conformance harness gets `rasterDecoderAvailable() ===
// false` and an honest refusal rather than a stub — the trace pipeline
// itself is driven there from synthetic pixels instead.

import type { TraceLimits } from "../trace-engine";

/** A decoded raster, ready for the tracer. */
export interface DecodedRaster {
  /** Width AFTER any cap downsample. */
  width: number;
  /** Height AFTER any cap downsample. */
  height: number;
  /** RGBA8, row-major, `width * height * 4`. */
  data: Uint8ClampedArray;
  /** Natural width of the decoded file, before the downsample. */
  sourceWidth: number;
  /** Natural height of the decoded file, before the downsample. */
  sourceHeight: number;
  /** 1 = traced at full resolution. Below 1 the raster was DOWNSAMPLED
   *  to fit the tracer's caps and detail below the new sample grid is
   *  gone — the command logs the factor rather than implying fidelity it
   *  does not have. */
  scale: number;
}

/** Message thrown when the realm has no image decoder (Node, or a future
 *  isolate without DOM). Names the door that would be needed rather than
 *  inventing one. */
export const RASTER_DECODER_UNAVAILABLE =
  "this realm has no image decoder (createImageBitmap / OffscreenCanvas " +
  "are absent) — placed-image pixels cannot be obtained here; the host " +
  "would need a decode door on the plugin contract";

/** Does this realm have the two globals the decode needs? */
export function rasterDecoderAvailable(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas === "function" &&
    typeof Blob === "function"
  );
}

/**
 * The scale factor that brings `width × height` inside BOTH caps, or 1
 * when it already is. Pure — the caps come from the wasm
 * (`TraceEngine.limits()`), so there is one source of truth.
 *
 * Both caps bind: an edge cap AND an area cap, and the tighter wins.
 */
export function decodeScaleFor(
  width: number,
  height: number,
  limits: TraceLimits,
): number {
  if (width <= 0 || height <= 0) return 1;
  const edge = Math.min(
    1,
    limits.maxDimension / width,
    limits.maxDimension / height,
  );
  const area = Math.min(1, Math.sqrt(limits.maxPixels / (width * height)));
  return Math.min(edge, area);
}

/** Apply `decodeScaleFor` and round to whole pixels (never below 1). */
export function decodeSizeFor(
  width: number,
  height: number,
  limits: TraceLimits,
): { width: number; height: number; scale: number } {
  const scale = decodeScaleFor(width, height, limits);
  if (scale >= 1) return { width, height, scale: 1 };
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

/**
 * Decode `bytes` (an original placed file) to RGBA8, DOWNSAMPLED to fit
 * `limits` when needed. Rejects — never returns a stub — when the realm
 * has no decoder or the platform refuses the format.
 *
 * The downsample rides the platform's own `drawImage` resampling, which
 * is why an over-cap photo is traceable at all: the tracer's caps are
 * hard refusals, so something has to shrink the pixels first, and this is
 * the honest place for it (the factor is reported on `scale`).
 */
export async function decodeRasterBytes(
  bytes: Uint8Array,
  limits: TraceLimits,
  mimeType?: string,
): Promise<DecodedRaster> {
  if (!rasterDecoderAvailable()) {
    throw new Error(RASTER_DECODER_UNAVAILABLE);
  }
  const view = new Uint8Array(bytes);
  const blob = mimeType ? new Blob([view], { type: mimeType }) : new Blob([view]);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (cause) {
    throw new Error(
      `the platform could not decode this placed image` +
        `${mimeType ? ` (${mimeType})` : ""} — a PSD or a CMYK TIFF is the ` +
        `usual reason; re-place it as PNG/JPEG to trace it`,
      { cause },
    );
  }
  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const target = decodeSizeFor(sourceWidth, sourceHeight, limits);
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("OffscreenCanvas refused a 2d context");
    }
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const image = ctx.getImageData(0, 0, target.width, target.height);
    return {
      width: target.width,
      height: target.height,
      data: image.data,
      sourceWidth,
      sourceHeight,
      scale: target.scale,
    };
  } finally {
    bitmap.close();
  }
}
