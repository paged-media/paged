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

// The draw module's ACTIONS (`host.actions`, extensions ADR 344, PM-0015):
// tracing and recolouring as pure steps over an ASSET, which another bundle
// runs alone or chained (data's asset columns, data ADR 563). Neither edits
// the document — Image Trace and Recolor Artwork stay the commands that do.
//
//   · trace — a raster picture in, an SVG out. The kernel is the trace wasm
//     (`trace-engine.ts`), in a `host.workers` worker when the host has one,
//     on the calling thread otherwise. The DECODE is the platform's
//     (`io/raster-decode.ts`: createImageBitmap + OffscreenCanvas), so the
//     action runs where those exist — the editor's window or worker realm —
//     and refuses with the decoder's own sentence where they do not (Node,
//     the headless host). A picture over the trace budget is downsampled
//     first; the SVG is written at the picture's own pixel size either way.
//   · recolor — an SVG in, an SVG out: its solid fill and stroke colours
//     reduced to N, moved to a harmony, or mapped. The document is read and
//     written by draw-geometry's SVG reader/writer, so the output is that
//     writer's flattening: one path per shape, solid paints only (gradients,
//     text, images and `<use>` are not carried; see svg-doc.ts).
//
// Recolouring a PLACED RASTER is not here: that is pixel work and belongs to
// the image module's kernels.

import type {
  ActionAsset,
  ActionDefinition,
  BundleHost,
  Disposable,
} from "@paged-media/plugin-api";
import {
  harmonyOf,
  isNeutral,
  parseCssColor,
  parseSvgDocument,
  recolorToHarmony,
  reduceColors,
  rgbToHex,
  rotateHues,
  serializeSvgDocument,
  HARMONY_RULES,
  type DrawShape,
  type HarmonyRule,
  type Rgb,
  type WeightedColor,
} from "@paged-media/draw-geometry";

import { decodeRasterBytes } from "./io/raster-decode";
import { SVG_MIME } from "./io/svg";
import {
  openTraceSession,
  traceBudget,
  DEFAULT_TRACE_PIXELS,
  type TraceOptions,
  type TraceResult,
} from "./trace-engine";

const PREFIX = "media.paged.draw/";

export const DRAW_ACTION_IDS = {
  trace: `${PREFIX}trace`,
  recolor: `${PREFIX}recolor`,
} as const;

/** The trace parameters an action takes (the kernel's own, by name). */
const TRACE_KEYS = [
  "mode",
  "pathMode",
  "colorPrecision",
  "filterSpeckle",
  "layerDifference",
  "bwThreshold",
  "ignoreWhite",
  "cornerThresholdDeg",
  "segmentLength",
  "spliceThresholdDeg",
  "maxIterations",
  "maxRegions",
  "stacked",
  "maxColors",
  "grayscale",
  "maxTracePixels",
] as const satisfies readonly (keyof TraceOptions)[];

function assetOf(input: unknown, id: string): ActionAsset {
  const a = input as Partial<ActionAsset> | null;
  if (!a || !(a.bytes instanceof Uint8Array))
    throw new Error(`${id}: the input is not an asset ({ bytes, mediaType })`);
  return { bytes: a.bytes, mediaType: a.mediaType ?? "" };
}

const scaled = (p: readonly [number, number], k: number): [number, number] => [
  p[0] * k,
  p[1] * k,
];

/** A trace result as SVG shapes, in the SOURCE picture's pixels (`k` undoes
 *  the decoder's downsample). Each region is one even-odd path — its outer
 *  boundary and its holes; each centreline one stroked open path. */
export function traceShapes(result: TraceResult, k = 1): DrawShape[] {
  const shapes: DrawShape[] = [];
  for (const region of result.regions) {
    const anchors: DrawShape["anchors"]["anchors"][number][] = [];
    const subpathStarts: number[] = [];
    for (const contour of region.contours) {
      if (contour.anchors.length === 0) continue;
      subpathStarts.push(anchors.length);
      for (const a of contour.anchors)
        anchors.push({
          anchor: scaled(a.anchor, k),
          left: scaled(a.left, k),
          right: scaled(a.right, k),
        });
    }
    if (anchors.length === 0) continue;
    shapes.push({
      anchors: { anchors, subpathStarts },
      style: { fill: rgbToHex(region.color), fillRule: "evenodd" },
    });
  }
  for (const stroke of result.strokes ?? []) {
    if (stroke.anchors.length === 0) continue;
    shapes.push({
      anchors: {
        anchors: stroke.anchors.map((a) => ({
          anchor: scaled(a.anchor, k),
          left: scaled(a.left, k),
          right: scaled(a.right, k),
        })),
        subpathStarts: [0],
        subpathOpen: [!stroke.closed],
      },
      style: {
        fill: null,
        stroke: rgbToHex(stroke.color),
        strokeWidth: stroke.width * k,
      },
    });
  }
  return shapes;
}

const svgAsset = (svg: string): ActionAsset => ({
  bytes: new TextEncoder().encode(svg),
  mediaType: SVG_MIME,
});

/** The new colour of each of `colors` under the recolour parameters. */
export function recolorPalette(
  colors: readonly WeightedColor[],
  params: Readonly<Record<string, unknown>>,
  id: string = DRAW_ACTION_IDS.recolor,
): Rgb[] {
  const mode = params.mode ?? "reduce";
  if (colors.length === 0) return [];
  if (mode === "reduce") {
    const n = Number(params.count ?? 3);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`${id}: count is a whole number, 1 or more`);
    return reduceColors(colors, n);
  }
  if (mode === "harmony") {
    const rule = (params.rule ?? "complementary") as HarmonyRule;
    if (!HARMONY_RULES.includes(rule))
      throw new Error(`${id}: rule is one of ${HARMONY_RULES.join(", ")}`);
    let base: Rgb | null = null;
    if (typeof params.base === "string" && params.base !== "") {
      base = parseCssColor(params.base);
      if (!base) throw new Error(`${id}: base ${params.base} is not a colour`);
    } else {
      // The heaviest chromatic colour, as the Recolor Artwork command picks.
      const chromatic = colors.filter((c) => !isNeutral(c.rgb));
      const heaviest = [...(chromatic.length ? chromatic : colors)].sort(
        (a, b) => b.weight - a.weight,
      )[0]!;
      base = heaviest.rgb;
    }
    const rotate = Number(params.rotate ?? 0);
    if (!Number.isFinite(rotate)) throw new Error(`${id}: rotate is degrees`);
    return recolorToHarmony(colors, rotateHues(harmonyOf(base, rule), rotate), {
      recolorNeutrals: params.recolorNeutrals === true,
    });
  }
  if (mode === "map") {
    const table = new Map<string, Rgb>();
    for (const [from, to] of Object.entries(
      (params.map ?? {}) as Record<string, unknown>,
    )) {
      const f = parseCssColor(from);
      const t = typeof to === "string" ? parseCssColor(to) : null;
      if (!f || !t)
        throw new Error(`${id}: map takes colour → colour (${from} → ${to})`);
      table.set(rgbToHex(f), t);
    }
    return colors.map((c) => table.get(rgbToHex(c.rgb)) ?? c.rgb);
  }
  throw new Error(`${id}: mode is "reduce", "harmony" or "map"`);
}

/** Recolour an SVG document's solid fills and strokes. */
export function recolorSvg(
  svg: string,
  params: Readonly<Record<string, unknown>>,
  id: string = DRAW_ACTION_IDS.recolor,
): string {
  const doc = parseSvgDocument(svg);
  if (!doc) throw new Error(`${id}: the asset is not an SVG document`);
  // One entry per distinct colour, weighted by how many paints use it.
  const index = new Map<string, number>();
  const colors: WeightedColor[] = [];
  const slot = (paint: string | null | undefined): number | null => {
    if (typeof paint !== "string") return null;
    const rgb = parseCssColor(paint);
    if (!rgb) return null;
    const hex = rgbToHex(rgb);
    let i = index.get(hex);
    if (i === undefined) {
      i = colors.length;
      index.set(hex, i);
      colors.push({ rgb, weight: 0 });
    }
    colors[i]!.weight++;
    return i;
  };
  const slots = doc.shapes.map((s) => ({
    fill: slot(s.style.fill),
    stroke: slot(s.style.stroke),
  }));
  const next = recolorPalette(colors, params, id);
  const shapes = doc.shapes.map((s, i): DrawShape => {
    const { fill, stroke } = slots[i]!;
    return {
      anchors: s.anchors,
      style: {
        ...s.style,
        ...(fill !== null ? { fill: rgbToHex(next[fill]!) } : {}),
        ...(stroke !== null ? { stroke: rgbToHex(next[stroke]!) } : {}),
      },
    };
  });
  return serializeSvgDocument(shapes, {
    width: doc.viewBox?.[2] ?? doc.width,
    height: doc.viewBox?.[3] ?? doc.height,
  });
}

/** The action definitions for one host (the trace runs through its
 *  workers door). */
export function drawActions(host: BundleHost): ActionDefinition[] {
  return [
    {
      id: DRAW_ACTION_IDS.trace,
      title: "Trace a picture to SVG",
      input: "asset",
      output: "asset",
      params: {
        mode: "color",
        pathMode: "spline",
        maxColors: 0,
        filterSpeckle: 4,
        ignoreWhite: true,
        maxTracePixels: DEFAULT_TRACE_PIXELS,
      },
      async run(input, params) {
        const id = DRAW_ACTION_IDS.trace;
        const a = assetOf(input, id);
        const options: TraceOptions = {};
        for (const key of TRACE_KEYS)
          if (params[key] !== undefined)
            (options as Record<string, unknown>)[key] = params[key];
        const session = await openTraceSession(host);
        try {
          const budget = traceBudget(
            await session.limits(),
            options.maxTracePixels,
          );
          const raster = await decodeRasterBytes(
            a.bytes,
            budget,
            a.mediaType || undefined,
          ).catch((e: unknown) => {
            throw new Error(
              `${id}: ${e instanceof Error ? e.message : String(e)}`,
              { cause: e },
            );
          });
          const result = await session.trace(
            raster.data,
            raster.width,
            raster.height,
            options,
          );
          return svgAsset(
            serializeSvgDocument(traceShapes(result, 1 / raster.scale), {
              width: raster.sourceWidth,
              height: raster.sourceHeight,
            }),
          );
        } finally {
          session.close();
        }
      },
    },
    {
      id: DRAW_ACTION_IDS.recolor,
      title: "Recolour an SVG (reduce, harmony or a colour map)",
      input: "asset",
      output: "asset",
      params: {
        mode: "reduce",
        count: 3,
        rule: "complementary",
        base: "",
        rotate: 0,
        recolorNeutrals: false,
        map: {},
      },
      run(input, params) {
        const id = DRAW_ACTION_IDS.recolor;
        const a = assetOf(input, id);
        if (a.mediaType && a.mediaType !== SVG_MIME)
          throw new Error(`${id}: takes ${SVG_MIME}, not ${a.mediaType}`);
        return svgAsset(
          recolorSvg(new TextDecoder().decode(a.bytes), params, id),
        );
      },
    },
  ];
}

/** Register the draw actions when the host has an action registry. */
export function registerDrawActions(host: BundleHost): Disposable | null {
  if (!host.supports("actions@1")) return null;
  const subs = drawActions(host).map((a) => host.actions.register(a));
  return {
    dispose() {
      for (const s of subs.splice(0)) s.dispose();
    },
  };
}
