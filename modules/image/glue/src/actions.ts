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

// The image module's ACTIONS (`host.actions`, extensions ADR 344, PM-0015):
// pure steps over an encoded picture — bytes in, bytes out — that another
// bundle runs alone or chained (data's asset columns, data ADR 563).
//
// WHAT RUNS HERE, AND WHY ONLY THIS. Each action is the engine wasm's CPU
// lane, which needs no device and so runs in the editor, a worker and the
// headless host alike:
//
//   · decode — PNG / JPEG / PSD composite (sniffed), CMYK and embedded ICC
//     profiles converted to sRGB at decode (the CMS rung 1 of the ingest);
//   · crop — the axis-aligned cut (`crop_image`, pure windowing);
//   · the adjustment chain — `filter_region_rgba8` over the whole picture,
//     on the GPU where this realm's engine has a device, otherwise on the
//     shipped CPU twins of the same kernels (ADR 465): greyscale is the
//     Black & White stage, sharpen the unsharp stage, and `adjust` takes any
//     of the adjustment layer's parameters by their object-model path;
//   · encode — PNG (lossless, with the channel reduction for a grey buffer)
//     or JPEG at a quality.
//
// WHAT DOES NOT, said plainly: a RESIZE or fit-to-a-box is a resample, and
// the resample kernels are GPU-only (`resize_image` refuses without
// `init_gpu`), as is a straightened (non-zero angle) crop. An action may not
// depend on whether the realm happens to have a device, so neither is
// registered until the engine's `paged-raster` / `paged-kernels` give the
// module a CPU resample (PM-0014). `crop` with an `aspect` is the honest
// subset of "fit": the largest centred rectangle of that shape, cut, not
// scaled. WebP is neither decoded nor encoded by the codec set.

import type {
  ActionAsset,
  ActionDefinition,
  BundleHost,
  Disposable,
} from "@paged-media/plugin-api";

import {
  bootEngine,
  type DisplayTreatment,
  type ImageEngine,
  type RasterFormat,
} from "./engine";
import { defaultAdjust, writeAdjust } from "./object-model/adjust";

const PREFIX = "media.paged.image/";

export const IMAGE_ACTION_IDS = {
  info: `${PREFIX}info`,
  convert: `${PREFIX}convert`,
  crop: `${PREFIX}crop`,
  adjust: `${PREFIX}adjust`,
  greyscale: `${PREFIX}greyscale`,
  sharpen: `${PREFIX}sharpen`,
} as const;

/** The output format: `keep` writes JPEG for a JPEG and PNG for anything
 *  else (a PSD composite becomes a PNG). */
type OutFormat = "keep" | RasterFormat;

const ENCODE_DEFAULTS = { format: "keep" as OutFormat, quality: 90 };

const MEDIA_TYPE: Record<RasterFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tiff: "image/tiff",
};

/** The container the decoder will sniff, by magic. */
function sniff(bytes: Uint8Array): "png" | "jpeg" | "psd" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpeg";
  if (
    bytes[0] === 0x38 &&
    bytes[1] === 0x42 &&
    bytes[2] === 0x50 &&
    bytes[3] === 0x53
  )
    return "psd";
  return null;
}

function assetOf(input: unknown, id: string): ActionAsset {
  const a = input as Partial<ActionAsset> | null;
  if (!a || !(a.bytes instanceof Uint8Array))
    throw new Error(`${id}: the input is not an asset ({ bytes, mediaType })`);
  if (!sniff(a.bytes))
    throw new Error(
      `${id}: ${a.mediaType ?? "the asset"} is not a picture this engine decodes (PNG, JPEG or a PSD composite)`,
    );
  return { bytes: a.bytes, mediaType: a.mediaType ?? "" };
}

interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
  source: "png" | "jpeg" | "psd";
  display: DisplayTreatment;
  depthReduced: boolean;
}

function decode(
  e: ImageEngine,
  asset: ActionAsset,
  crop?: (
    w: number,
    h: number,
  ) => { x: number; y: number; w: number; h: number },
): Raster {
  const d = e.decode(asset.bytes);
  let handle = d.handle;
  let { width, height } = d;
  try {
    if (crop) {
      const c = e.crop(d.handle, crop(width, height));
      handle = c.handle;
      ({ width, height } = c);
      e.freeImage(d.handle);
    }
    return {
      width,
      height,
      rgba: e.tile(handle, 0, 0, width, height),
      source: sniff(asset.bytes)!,
      display: d.display,
      depthReduced: d.depthReduced,
    };
  } finally {
    e.freeImage(handle);
  }
}

function encode(
  e: ImageEngine,
  r: Raster,
  params: Readonly<Record<string, unknown>>,
  id: string,
): ActionAsset {
  const asked = params.format ?? "keep";
  if (
    asked !== "keep" &&
    asked !== "png" &&
    asked !== "jpeg" &&
    asked !== "webp" &&
    asked !== "tiff"
  )
    throw new Error(`${id}: format is "keep", "png", "jpeg", "webp" or "tiff"`);
  const format: RasterFormat =
    asked === "keep" ? (r.source === "jpeg" ? "jpeg" : "png") : asked;
  const quality = Number(params.quality ?? 90);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100)
    throw new Error(`${id}: quality is a whole number from 1 to 100`);
  return {
    bytes: e.encodeOpt(r.rgba, r.width, r.height, format, quality, true),
    mediaType: MEDIA_TYPE[format],
  };
}

/** Run the adjustment chain, given as object-model paths, over the whole
 *  raster. An identity chain leaves the pixels as they are. */
async function filter(
  e: ImageEngine,
  r: Raster,
  paths: Readonly<Record<string, unknown>>,
  id: string,
): Promise<Raster> {
  const wire = defaultAdjust();
  for (const [path, value] of Object.entries(paths)) {
    const why = writeAdjust(wire, path, value);
    if (why) throw new Error(`${id}: ${why}`);
  }
  if (wire.every((x, i) => Object.is(x, IDENTITY[i]))) return r;
  const rgba = await e.filterRegion(r.rgba, r.width, r.height, wire, {
    x: 0,
    y: 0,
    w: r.width,
    h: r.height,
  });
  return { ...r, rgba };
}

const IDENTITY = defaultAdjust();

const whole = (v: unknown, name: string, id: string): number => {
  const n = Number(v ?? 0);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${id}: ${name} is a whole number of pixels, 0 or more`);
  return n;
};

/** The crop rectangle the parameters name on a `w × h` picture. */
export function cropRectFor(
  params: Readonly<Record<string, unknown>>,
  w: number,
  h: number,
  id: string = IMAGE_ACTION_IDS.crop,
): { x: number; y: number; w: number; h: number } {
  const x = whole(params.x, "x", id);
  const y = whole(params.y, "y", id);
  const cw = whole(params.width, "width", id) || w - x;
  const ch = whole(params.height, "height", id) || h - y;
  if (x + cw > w || y + ch > h || cw < 1 || ch < 1)
    throw new Error(
      `${id}: the rectangle ${x},${y} ${cw}×${ch} does not lie inside the ${w}×${h} picture`,
    );
  const aspect = Number(params.aspect ?? 0);
  if (!Number.isFinite(aspect) || aspect < 0)
    throw new Error(`${id}: aspect is width ÷ height, or 0 for none`);
  if (aspect === 0) return { x, y, w: cw, h: ch };
  // The largest centred rectangle of that shape inside the given one.
  let aw = cw;
  let ah = Math.round(cw / aspect);
  if (ah > ch) {
    ah = ch;
    aw = Math.round(ch * aspect);
  }
  aw = Math.max(1, Math.min(cw, aw));
  ah = Math.max(1, Math.min(ch, ah));
  return {
    x: x + Math.floor((cw - aw) / 2),
    y: y + Math.floor((ch - ah) / 2),
    w: aw,
    h: ah,
  };
}

/** The action definitions over an engine boot (injected by tests). */
export function imageActions(
  engine: () => Promise<ImageEngine>,
): ActionDefinition[] {
  const asset = (
    id: string,
    title: string,
    params: Record<string, unknown>,
    step: (
      e: ImageEngine,
      a: ActionAsset,
      p: Readonly<Record<string, unknown>>,
    ) => Promise<Raster> | Raster,
  ): ActionDefinition => ({
    id,
    title,
    input: "asset",
    output: "asset",
    params: { ...ENCODE_DEFAULTS, ...params },
    async run(input, p) {
      const a = assetOf(input, id);
      const e = await engine();
      return encode(e, await step(e, a, p), p, id);
    },
  });
  return [
    {
      id: IMAGE_ACTION_IDS.info,
      title: "Picture size and colour",
      input: "asset",
      output: "value",
      async run(input) {
        const a = assetOf(input, IMAGE_ACTION_IDS.info);
        const e = await engine();
        const d = e.decode(a.bytes);
        e.freeImage(d.handle);
        return {
          width: d.width,
          height: d.height,
          format: sniff(a.bytes),
          colour: d.display,
          depthReduced: d.depthReduced,
          ppi: e.readPpi(a.bytes),
        };
      },
    },
    asset(
      IMAGE_ACTION_IDS.convert,
      "Convert to PNG or JPEG (sRGB)",
      { format: "png" },
      (e, a) => decode(e, a),
    ),
    asset(
      IMAGE_ACTION_IDS.crop,
      "Crop (a rectangle, or the largest centred one of an aspect ratio)",
      { x: 0, y: 0, width: 0, height: 0, aspect: 0 },
      (e, a, p) =>
        decode(e, a, (w, h) => cropRectFor(p, w, h, IMAGE_ACTION_IDS.crop)),
    ),
    asset(
      IMAGE_ACTION_IDS.adjust,
      "Adjust (the adjustment layer's parameters by path)",
      { adjust: {} },
      (e, a, p) => {
        const paths = p.adjust ?? {};
        if (typeof paths !== "object" || Array.isArray(paths))
          throw new Error(
            `${IMAGE_ACTION_IDS.adjust}: adjust maps parameter paths to values`,
          );
        return filter(
          e,
          decode(e, a),
          paths as Record<string, unknown>,
          IMAGE_ACTION_IDS.adjust,
        );
      },
    ),
    asset(IMAGE_ACTION_IDS.greyscale, "Greyscale", {}, (e, a) =>
      filter(
        e,
        decode(e, a),
        { "blackWhite.enabled": true },
        IMAGE_ACTION_IDS.greyscale,
      ),
    ),
    asset(IMAGE_ACTION_IDS.sharpen, "Sharpen", { amount: 0.5 }, (e, a, p) =>
      filter(
        e,
        decode(e, a),
        { "unsharp.amount": p.amount },
        IMAGE_ACTION_IDS.sharpen,
      ),
    ),
  ];
}

/** Register the image actions when the host has an action registry. */
export function registerImageActions(
  host: BundleHost,
  engine: () => Promise<ImageEngine> = bootEngine,
): Disposable | null {
  if (!host.supports("actions@1")) return null;
  const subs = imageActions(engine).map((a) => host.actions.register(a));
  return {
    dispose() {
      for (const s of subs.splice(0)) s.dispose();
    },
  };
}
