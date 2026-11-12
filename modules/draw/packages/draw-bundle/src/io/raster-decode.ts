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

// ENCODED placed-image bytes → RGBA8 pixels, decoded by the ENGINE.
//
// The tracer reads pixels through the host's decoded-pixels door,
// `host.assets.decodeImage` (extensions ADR 1105): the bytes
// `host.assets.getPlacedImage` serves (or an action's asset) decoded the way
// the renderer decodes the placed picture — PNG, JPEG, TIFF, PSD, WebP, a
// CMYK file colour converted to sRGB — so the trace sees what the page
// shows, and paged.draw ships no decoder and leans on no browser codec.
//
// DOWNSAMPLING. The tracer's caps are hard refusals, so an over-cap photo
// is shrunk by the engine as it decodes (`maxDimension`), to the size
// `decodeSizeFor` picks inside BOTH caps; the factor is reported on
// `scale`.
//
// A host without the door (an older editor, the headless harness) gets an
// honest refusal rather than a stub; the trace pipeline itself is driven
// there from synthetic pixels instead.

import type { BundleHost } from "@paged-media/plugin-api";

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

/** Message thrown when the host has no decoded-pixels door. */
export const RASTER_DECODER_UNAVAILABLE =
  "this host has no image decoder (assets.decodeImage@1) — placed-image " +
  "pixels cannot be obtained here";

/** Can this host decode image bytes for the tracer? */
export function rasterDecoderAvailable(host: BundleHost): boolean {
  return (
    host.supports("assets.decodeImage@1") &&
    typeof host.assets.decodeImage === "function"
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
 * Decode `bytes` (an original placed file) to RGBA8 through the engine,
 * DOWNSAMPLED to fit `limits` when needed. `natural` is the file's pixel
 * size when the caller knows it (a placed image does), which spares a
 * second decode of an over-cap file. Rejects — never returns a stub — when
 * the host has no decoder or the engine refuses the bytes.
 */
export async function decodeRasterBytes(
  host: BundleHost,
  bytes: Uint8Array,
  limits: TraceLimits,
  natural?: { width: number; height: number },
): Promise<DecodedRaster> {
  if (!rasterDecoderAvailable(host)) {
    throw new Error(RASTER_DECODER_UNAVAILABLE);
  }
  const decode = (maxDimension?: number) =>
    host.assets.decodeImage!(
      bytes,
      maxDimension !== undefined ? { maxDimension } : undefined,
    );
  const refused = () =>
    new Error(
      "the engine could not decode this placed image — its bytes are not " +
        "an image format the document can place",
    );
  const fit = (w: number, h: number) => {
    const t = decodeSizeFor(w, h, limits);
    return t.scale < 1 ? Math.max(t.width, t.height) : undefined;
  };
  let sourceWidth: number;
  let sourceHeight: number;
  let image;
  if (natural && natural.width > 0 && natural.height > 0) {
    sourceWidth = natural.width;
    sourceHeight = natural.height;
    image = await decode(fit(sourceWidth, sourceHeight));
  } else {
    // Unknown size: decode inside the edge cap, then shrink further when
    // the area cap still binds.
    image = await decode(limits.maxDimension);
    if (!image) throw refused();
    sourceWidth = image.width;
    sourceHeight = image.height;
    const again = fit(image.width, image.height);
    if (again !== undefined) image = await decode(again);
  }
  if (!image) throw refused();
  return {
    width: image.width,
    height: image.height,
    data: image.data,
    sourceWidth,
    sourceHeight,
    scale: Math.min(1, image.width / sourceWidth),
  };
}
