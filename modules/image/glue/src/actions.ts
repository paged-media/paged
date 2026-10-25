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
//   · crop — the axis-aligned cut (`crop_image`, pure windowing), or with
//     an `angle` the straightened crop (`straighten_crop_image_cpu`);
//   · resize and fit — a resample on the CPU (`resize_image_cpu`): the
//     engine's `paged-resample`, separable Lanczos-3 or bilinear,
//     premultiplied, its filter widened when shrinking (ADR 467);
//   · the adjustment chain — `filter_region_rgba8` over the whole picture,
//     on the GPU where this realm's engine has a device, otherwise on the
//     shipped CPU twins of the same kernels (ADR 465): greyscale is the
//     Black & White stage, sharpen the unsharp stage, and `adjust` takes any
//     of the adjustment layer's parameters by their object-model path;
//   · encode — PNG (lossless, with the channel reduction for a grey buffer)
//     or JPEG at a quality.
//
// The resample is the CPU one even where a device exists: an action may
// not depend on whether the realm happens to have one, so a resize gives
// the same bytes in the editor, a worker and the headless host. The GPU
// resample kernels stay the editor's interactive path (its resize dialog
// and crop tool); the two agree within one 8-bit level on opaque pixels
// (ADR 467). WebP is neither decoded nor encoded by the codec set.
//
// THE ACTIONS AND THEIR PARAMETERS (each asset action also takes `format`,
// "keep" | "png" | "jpeg", and `quality`, 1–100, for its output):
//
//   info       — { width, height, format, colour, depthReduced, ppi }
//   convert    — re-encode (`format` defaults to "png")
//   crop       — x, y, width, height (0 = to the edge), aspect (w ÷ h, the
//                largest centred rectangle of that shape), angle (degrees,
//                clockwise: the content inside the rectangle turned by
//                `angle` about its centre lands upright; where the turn
//                swings past the picture its edge pixels repeat)
//   resize     — width and/or height (one alone keeps the aspect), or
//                scale (a factor); filter "lanczos3" | "bilinear"
//   fit        — width, height (the box), mode "contain" (the whole
//                picture inside the box) | "cover" (the box filled, the
//                overflow cut centred), enlarge (false: never scale up),
//                filter
//   adjust     — adjust: { <adjustment-layer path>: value }
//   greyscale  — (none)
//   sharpen    — amount

import type {
  ActionAsset,
  ActionDefinition,
  BundleHost,
  Disposable,
} from "@paged-media/plugin-api";

import {
  bootEngine,
  type CpuResampleFilter,
  type DecodedInfo,
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
  resize: `${PREFIX}resize`,
  fit: `${PREFIX}fit`,
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

/** One engine step over a held picture: a new held picture made from the
 *  one behind `handle`, which is `w × h`. */
type Step = (
  e: ImageEngine,
  handle: number,
  w: number,
  h: number,
) => Pick<DecodedInfo, "handle" | "width" | "height">;

/** Decode, run the steps in order (each frees the picture before it), and
 *  read the pixels back. */
function decode(e: ImageEngine, asset: ActionAsset, ...steps: Step[]): Raster {
  const d = e.decode(asset.bytes);
  let handle = d.handle;
  let { width, height } = d;
  try {
    for (const step of steps) {
      const next = step(e, handle, width, height);
      e.freeImage(handle);
      ({ handle, width, height } = next);
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
  if (asked !== "keep" && asked !== "png" && asked !== "jpeg")
    throw new Error(`${id}: format is "keep", "png" or "jpeg"`);
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

/** The crop step the parameters name: the axis-aligned cut, or with a
 *  non-zero `angle` the straightened one. */
function cropStep(p: Readonly<Record<string, unknown>>, id: string): Step {
  const angle = Number(p.angle ?? 0);
  if (!Number.isFinite(angle) || Math.abs(angle) > 360)
    throw new Error(`${id}: angle is degrees, from -360 to 360`);
  return (e, handle, w, h) => {
    const r = cropRectFor(p, w, h, id);
    return angle === 0
      ? e.crop(handle, r)
      : e.straightenCropCpu(handle, r, angle);
  };
}

const FILTERS: readonly string[] = ["lanczos3", "bilinear"];

function filterOf(
  p: Readonly<Record<string, unknown>>,
  id: string,
): CpuResampleFilter {
  const f = p.filter ?? "lanczos3";
  if (typeof f !== "string" || !FILTERS.includes(f))
    throw new Error(`${id}: filter is "lanczos3" or "bilinear"`);
  return f as CpuResampleFilter;
}

/** The longest edge a resize or fit writes (the engine also refuses more
 *  than 2²⁸ pixels in all). */
export const MAX_EDGE = 16384;

function edge(n: number, name: string, id: string): number {
  const v = Math.max(1, Math.round(n));
  if (v > MAX_EDGE)
    throw new Error(`${id}: a ${name} of ${v} exceeds ${MAX_EDGE} pixels`);
  return v;
}

/** The size `resize`'s parameters name for a `w × h` picture. */
export function resizeSizeFor(
  p: Readonly<Record<string, unknown>>,
  w: number,
  h: number,
  id: string = IMAGE_ACTION_IDS.resize,
): { w: number; h: number } {
  const tw = whole(p.width, "width", id);
  const th = whole(p.height, "height", id);
  const scale = Number(p.scale ?? 0);
  if (!Number.isFinite(scale) || scale < 0)
    throw new Error(`${id}: scale is a factor above 0, or 0 for none`);
  if (scale > 0) {
    if (tw || th)
      throw new Error(`${id}: give a scale or a width and height, not both`);
    return {
      w: edge(w * scale, "width", id),
      h: edge(h * scale, "height", id),
    };
  }
  if (!tw && !th) throw new Error(`${id}: give a width, a height or a scale`);
  return {
    w: edge(tw || (w * th) / h, "width", id),
    h: edge(th || (h * tw) / w, "height", id),
  };
}

/** What `fit` does to a `w × h` picture: the centred rectangle it keeps
 *  (the whole picture for `contain`) and the size it resamples that to. */
export function fitPlanFor(
  p: Readonly<Record<string, unknown>>,
  w: number,
  h: number,
  id: string = IMAGE_ACTION_IDS.fit,
): {
  keep: { x: number; y: number; w: number; h: number };
  w: number;
  h: number;
} {
  const bw = whole(p.width, "width", id);
  const bh = whole(p.height, "height", id);
  if (!bw || !bh) throw new Error(`${id}: the box needs a width and a height`);
  const mode = p.mode ?? "contain";
  if (mode !== "contain" && mode !== "cover")
    throw new Error(`${id}: mode is "contain" or "cover"`);
  const enlarge = p.enlarge ?? true;
  if (typeof enlarge !== "boolean")
    throw new Error(`${id}: enlarge is true or false`);
  const s0 =
    mode === "contain" ? Math.min(bw / w, bh / h) : Math.max(bw / w, bh / h);
  const s = enlarge ? s0 : Math.min(s0, 1);
  if (mode === "contain")
    return {
      keep: { x: 0, y: 0, w, h },
      w: Math.min(bw, edge(w * s, "width", id)),
      h: Math.min(bh, edge(h * s, "height", id)),
    };
  // Cover: the box, mapped back into the picture at that scale, is the
  // part kept, centred; the rest is cut. Not enlarging, a picture smaller
  // than the box on a side keeps that side.
  const ow = Math.min(bw, edge(w * s, "width", id));
  const oh = Math.min(bh, edge(h * s, "height", id));
  const kw = Math.max(1, Math.min(w, Math.round(ow / s)));
  const kh = Math.max(1, Math.min(h, Math.round(oh / s)));
  return {
    keep: {
      x: Math.floor((w - kw) / 2),
      y: Math.floor((h - kh) / 2),
      w: kw,
      h: kh,
    },
    w: ow,
    h: oh,
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
      "Crop (a rectangle, or the largest centred one of an aspect ratio; straightened by an angle)",
      { x: 0, y: 0, width: 0, height: 0, aspect: 0, angle: 0 },
      (e, a, p) => decode(e, a, cropStep(p, IMAGE_ACTION_IDS.crop)),
    ),
    asset(
      IMAGE_ACTION_IDS.resize,
      "Resize (to a width and/or height, or by a scale)",
      { width: 0, height: 0, scale: 0, filter: "lanczos3" },
      (e, a, p) => {
        const filter = filterOf(p, IMAGE_ACTION_IDS.resize);
        return decode(e, a, (_, handle, w, h) => {
          const size = resizeSizeFor(p, w, h);
          return e.resizeCpu(handle, size.w, size.h, filter);
        });
      },
    ),
    asset(
      IMAGE_ACTION_IDS.fit,
      "Fit into a box (contain, or cover with the overflow cut)",
      {
        width: 0,
        height: 0,
        mode: "contain",
        enlarge: true,
        filter: "lanczos3",
      },
      (e, a, p) => {
        const filter = filterOf(p, IMAGE_ACTION_IDS.fit);
        return decode(e, a, (_, handle, w, h) => {
          const plan = fitPlanFor(p, w, h);
          const kept = e.crop(handle, plan.keep);
          try {
            return e.resizeCpu(kept.handle, plan.w, plan.h, filter);
          } finally {
            e.freeImage(kept.handle);
          }
        });
      },
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
