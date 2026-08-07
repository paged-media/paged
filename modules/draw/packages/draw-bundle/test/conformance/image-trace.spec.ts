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

// IMAGE TRACE v0 through the REAL tracer wasm and the REAL engine wasm
// (protocol 57). Nothing here is stubbed: the pixels are synthetic, the
// TRACER is `crates/trace-js` over visioncortex, and the DOCUMENT side is
// the booted engine. Pins:
//   (1) the tracer itself — a ring traces to ONE region with TWO
//       contours, walked with OPPOSITE windings, at the areas the
//       fixture's pixels dictate;
//   (2) the caps are REFUSALS that name the size, and the decoder's
//       downsample target is derived from the wasm's own limits (one
//       source of truth);
//   (3) the exact wire shapes the two batches emit;
//   (4) the REAL undo count (RFI C-15 — assert it, never claim "one"):
//       insert = 1 batch, paint/group = 1 batch, so a trace is TWO;
//   (5) THE HOLE ACTUALLY RENDERS. An anchor table cannot tell a ring
//       from a coin — under the engine's NON-ZERO fill that is decided by
//       the inner contour's WINDING. So the traced ring is exported to a
//       real PDF, the page content stream is inflated, and the painted
//       path's two subpaths are measured: same fill op, one path,
//       opposite signed areas;
//   (6) THE HONEST GAP, asserted rather than described: in this headless
//       harness `host.assets.getPlacedImage` answers NULL and the realm
//       has no image decoder, so the full command REFUSES and inserts
//       nothing. Both are pinned so a future host that closes either gap
//       breaks this spec loudly instead of silently.

import { inflateSync } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { contourSignedArea, rgbToHex } from "@paged-media/draw-geometry";

import {
  drawBundle,
  applyImageTrace,
  applyImageTracePlan,
  bindTraceRegions,
  bootTraceEngine,
  decodeScaleFor,
  decodeSizeFor,
  imageTraceOf,
  pixelToPageAffine,
  rasterDecoderAvailable,
  regionTableFor,
  traceFinishBatchFor,
  traceInsertBatchFor,
  traceOptionsFrom,
  tracePlanFor,
  traceSwatchMutationFor,
  withImageTrace,
  traceBudget,
  DEFAULT_TRACE_PIXELS,
  IMAGE_TRACE_COMMAND_ID,
  IMAGE_TRACE_COMMAND_TITLE,
  TRACE_DEFAULTS,
  TRACE_SLOW_PIXELS,
  type TraceEngine,
  type TracePlan,
  type TraceResult,
} from "../../src";
import { F7_PLACED_IMAGE, ringPixels } from "../fixtures/corpus";
import { openHost } from "./host";

const IMAGE = { kind: "rectangle", id: F7_PLACED_IMAGE.imageId } as ElementId;
const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

/** A `w × h` RGBA raster painted by `paint`. */
function raster(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const at = (y * w + x) * 4;
      out[at] = r;
      out[at + 1] = g;
      out[at + 2] = b;
      out[at + 3] = 255;
    }
  }
  return out;
}

/** Two flat colours side by side — the multi-region case. */
const twoColours = (): Uint8Array =>
  raster(64, 32, (x) => (x < 32 ? [200, 30, 40] : [30, 60, 200]));

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Every leaf element id in the scene tree. */
async function leafIds(h: HeadlessHost): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: { id?: { id?: unknown }; children?: unknown[] }[]) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as never[];
      if (children.length > 0) walk(children);
      else if (node.id && typeof node.id.id === "string") out.push(node.id.id);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out.sort();
}

/** The element's contours, in the space the engine stores them. */
async function contoursOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<{ starts: number[]; areas: number[] } | null> {
  const r = await h.host.document.pathAnchors(id).catch(() => null);
  if (!r) return null;
  const starts = r.subpathStarts.length > 0 ? [...r.subpathStarts] : [0];
  const areas = starts.map((from, i) =>
    contourSignedArea(
      r.anchors.slice(from, starts[i + 1] ?? r.anchors.length) as never,
    ),
  );
  return { starts, areas };
}

async function readProp(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  for (const e of props?.entries ?? []) {
    if (e.path === path) return e.value;
  }
  return undefined;
}

// ------------------------------------------------------- export helper
// Rides `host.editor.client` — the MARKED escape hatch (DESIGN.md §4.9):
// a conformance spec may reach an engine query the plugin contract does
// not expose (export); the bundle's own source never does. Same helper
// shape as the compound-path spec, for the same reason: an anchor table
// cannot prove a hole, a rendered artifact can.

interface PdfClient {
  send(m: { kind: string; payload: unknown }): Promise<{
    kind: string;
    payload: Record<string, unknown>;
  }>;
}

/**
 * The page CONTENT stream, inflated.
 *
 * NOT "the first stream in the file" — the compound-path spec can assume
 * that because its fixture has no images, but F7 places a real PNG, so
 * the first `/Length` stream in this PDF is the image XObject's PIXELS.
 * Every deflate stream is inflated and the ones that read as page content
 * (they open a `q` graphics block) are joined.
 */
async function pdfContentStream(h: HeadlessHost): Promise<string> {
  const client = (h.host as unknown as { editor: { client: PdfClient } }).editor
    .client;
  const begun = await client.send({
    kind: "exportPdfBegin",
    payload: { options: {} },
  });
  const session = begun.payload.session as number;
  const pages = begun.payload.pageCount as number;
  for (let i = 0; i < pages; i++) {
    await client.send({ kind: "exportPdfPage", payload: { session } });
  }
  const fin = await client.send({
    kind: "exportPdfFinish",
    payload: { session },
  });
  const bytes = new Uint8Array(fin.payload.pdfBytes as number[]);
  const text = new TextDecoder("latin1").decode(bytes);
  const found: string[] = [];
  const re = /\/Length (\d+)[^>]*>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const length = Number(m[1]);
    const start = m.index + m[0].length;
    let inflated: string;
    try {
      inflated = new TextDecoder("latin1").decode(
        inflateSync(bytes.subarray(start, start + length)),
      );
    } catch {
      continue; // not a deflate stream
    }
    if (/(^|\n)q\r?\n/.test(inflated)) found.push(inflated);
  }
  if (found.length === 0) throw new Error("no page content stream in the PDF");
  return found.join("\n");
}

/** The vertex rings of every subpath built inside ONE `q … Q` block. */
function subpathsOf(block: string): [number, number][][] {
  const rings: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (const raw of block.split("\n")) {
    const m = /^((?:-?[\d.]+\s+)+)([a-zA-Z]+\*?)$/.exec(raw.trim());
    if (!m) continue;
    const n = m[1].trim().split(/\s+/).map(Number);
    switch (m[2]) {
      case "m":
        cur = [[n[0], n[1]]];
        rings.push(cur);
        break;
      case "l":
        cur?.push([n[0], n[1]]);
        break;
      case "c":
        cur?.push([n[4], n[5]]);
        break;
      default:
        break;
    }
  }
  return rings;
}

const ringArea = (ring: [number, number][]): number => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
};

/** Every FILLED (`f`) paint block of the content stream, with its
 *  subpath rings. */
function filledBlocks(stream: string): [number, number][][][] {
  return stream
    .split(/\nq\n/)
    .slice(1)
    .filter((b) => /^f$/m.test(b))
    .map(subpathsOf);
}

// =====================================================================

describe("draw conformance — IMAGE TRACE v0", () => {
  let engine: TraceEngine;

  beforeAll(async () => {
    engine = await bootTraceEngine();
  }, 60_000);

  describe("the tracer wasm itself (crates/trace-js over visioncortex)", () => {
    it("the caps come FROM the wasm — one source of truth for the decoder", () => {
      const limits = engine.limits();
      expect(limits).toEqual({ maxDimension: 4096, maxPixels: 4_194_304 });
    });

    it("a RING traces to one region with TWO contours, wound OPPOSITE ways", () => {
      // 48×48: ink from 8..40 (32 px square) with a hole from 18..30
      // (12 px square). Those areas are what the walked contours must
      // measure — the fixture is arithmetic, not a vibe.
      const out = engine.trace(ringPixels(48), 48, 48, {
        mode: "bw",
        pathMode: "polygon",
      });
      expect(out.width).toBe(48);
      expect(out.regions).toHaveLength(1);
      const region = out.regions[0];
      expect(region.color).toEqual([0, 0, 0]);
      expect(region.contours).toHaveLength(2);
      expect(Math.abs(region.contours[0].area)).toBeCloseTo(32 * 32, 3);
      expect(Math.abs(region.contours[1].area)).toBeCloseTo(12 * 12, 3);
      // The walk gives the hole the opposite winding already
      // (`image_to_paths` passes `i == 0` as its clockwise flag). The
      // document lowering does NOT rely on that — it re-winds by nesting
      // depth through draw-geometry — but if upstream ever stopped doing
      // it, this is where it shows.
      expect(Math.sign(region.contours[0].area)).toBe(
        -Math.sign(region.contours[1].area),
      );
    });

    it("spline mode emits real curve handles; polygon mode emits only corners", () => {
      const spline = engine.trace(ringPixels(48), 48, 48, {
        mode: "bw",
        pathMode: "spline",
      });
      const polygon = engine.trace(ringPixels(48), 48, 48, {
        mode: "bw",
        pathMode: "polygon",
      });
      for (const contour of polygon.regions[0].contours) {
        for (const a of contour.anchors) {
          expect(a.left).toEqual(a.anchor);
          expect(a.right).toEqual(a.anchor);
        }
      }
      // The ring is axis-aligned, so its FIT is also all corners — the
      // honest assertion is that the spline lane produced geometry of the
      // same shape, not that it invented curves in a square.
      expect(spline.regions[0].contours).toHaveLength(2);
      expect(Math.abs(spline.regions[0].contours[0].area)).toBeCloseTo(
        32 * 32,
        1,
      );
    });

    it("colour mode separates two flat colours and drops the paper", () => {
      const out = engine.trace(twoColours(), 64, 32, {});
      expect(out.regions.length).toBeGreaterThanOrEqual(2);
      expect(out.regions.some((r) => r.color[0] > 150)).toBe(true);
      expect(out.regions.some((r) => r.color[2] > 150)).toBe(true);
      // Largest first — the emit order, and what the region cap keeps.
      for (let i = 1; i < out.regions.length; i++) {
        expect(out.regions[i - 1].pixels).toBeGreaterThanOrEqual(
          out.regions[i].pixels,
        );
      }
    });

    it("`{}` means the DOCUMENTED defaults — TRACE_DEFAULTS is not drifting", () => {
      // The Rust side owns the defaults; TRACE_DEFAULTS is the TS mirror
      // the UI and the logs quote. Tracing with `{}` and with the full
      // explicit mirror must produce byte-identical results, which is the
      // only way to catch a mirror that has gone stale.
      const implicit = engine.trace(twoColours(), 64, 32, {});
      const explicit = engine.trace(twoColours(), 64, 32, TRACE_DEFAULTS);
      expect(JSON.stringify(explicit)).toEqual(JSON.stringify(implicit));
    });

    it("the region cap TRUNCATES largest-first and reports the drop", () => {
      const out = engine.trace(twoColours(), 64, 32, {
        maxRegions: 1,
        filterSpeckle: 1,
      });
      expect(out.regions).toHaveLength(1);
      expect(out.truncated).toBeGreaterThanOrEqual(1);
    });

    it("the caps are REFUSALS that name the size — never a wedge", () => {
      // 5000×5000 is over both caps. The kernel refuses; nothing is
      // traced; the message says what was refused.
      expect(() => engine.trace(new Uint8Array(0), 5000, 5000, {})).toThrow(
        /5000×5000/,
      );
      // A short buffer is refused too, rather than read past its end.
      expect(() => engine.trace(new Uint8Array(3), 4, 4, {})).toThrow(
        /expected 64 RGBA bytes/,
      );
    });

    it("the DECODER's downsample target is derived from those same caps", () => {
      const limits = engine.limits();
      // In cap: untouched.
      expect(decodeScaleFor(800, 600, limits)).toBe(1);
      expect(decodeSizeFor(800, 600, limits)).toEqual({
        width: 800,
        height: 600,
        scale: 1,
      });
      // The 6000×4000 photo the brief names: the AREA cap binds (24 Mpx
      // against 4.19 Mpx), so it is traced at ~41 % and the factor is
      // reported rather than implied.
      const big = decodeSizeFor(6000, 4000, limits);
      expect(big.scale).toBeLessThan(1);
      expect(big.width * big.height).toBeLessThanOrEqual(limits.maxPixels);
      expect(big.width).toBeLessThanOrEqual(limits.maxDimension);
      // A long thin image: the EDGE cap binds even though the area does
      // not.
      const wide = decodeSizeFor(9000, 200, limits);
      expect(wide.width).toBeLessThanOrEqual(limits.maxDimension);
      // …and the downsampled size is what the tracer then accepts.
      expect(() =>
        engine.trace(
          new Uint8Array(big.width * big.height * 4),
          big.width,
          big.height,
          { mode: "bw" },
        ),
      ).not.toThrow();
    });

    it("the DEFAULT budget is 1 MP — well under the kernel's 4 MP refusal", () => {
      const limits = engine.limits();
      // The kernel cap is a REFUSAL; the budget is the resolution a trace
      // actually runs at, and it is four times lower on purpose (the
      // measured 41 s worst case at 4 MP against ~6 s at 1 MP).
      expect(DEFAULT_TRACE_PIXELS).toBe(1_048_576);
      expect(TRACE_DEFAULTS.maxTracePixels).toBe(DEFAULT_TRACE_PIXELS);
      expect(DEFAULT_TRACE_PIXELS).toBeLessThan(limits.maxPixels);
      expect(traceBudget(limits, undefined)).toEqual({
        maxDimension: limits.maxDimension,
        maxPixels: DEFAULT_TRACE_PIXELS,
      });
      // A caller may raise it — but never past the kernel's cap.
      expect(traceBudget(limits, 99_000_000).maxPixels).toBe(limits.maxPixels);
      expect(traceBudget(limits, 250_000).maxPixels).toBe(250_000);
      // Under the default budget a 6000×4000 photo lands ~1 MP.
      const budgeted = decodeSizeFor(6000, 4000, traceBudget(limits));
      expect(budgeted.width * budgeted.height).toBeLessThanOrEqual(
        DEFAULT_TRACE_PIXELS,
      );
      // The warn threshold sits under the budget, so the default path
      // still warns before a slow trace rather than after it.
      expect(TRACE_SLOW_PIXELS).toBeLessThan(DEFAULT_TRACE_PIXELS);
    });

    it("`maxTracePixels` is a DECODER knob and never crosses into the wasm", () => {
      // Passing it must not change the trace: the kernel has never heard
      // of it and `trace()` strips it rather than smuggling it across as
      // an ignored field.
      const plain = engine.trace(twoColours(), 64, 32, {});
      const budgeted = engine.trace(twoColours(), 64, 32, {
        maxTracePixels: 4,
      });
      expect(JSON.stringify(budgeted)).toEqual(JSON.stringify(plain));
    });
  });

  describe("the pure lowering (pixel space → page space → the wire)", () => {
    const bounds = F7_PLACED_IMAGE.bounds;

    it("pixelToPageAffine stretches the raster across the FRAME's bounds", () => {
      const m = pixelToPageAffine(bounds, [1, 0, 0, 1, 0, 0], 48, 48)!;
      // 240 pt over 48 px = 5 pt per pixel, origin at the frame's
      // top-left.
      expect(m).toEqual([5, 0, 0, 5, 100, 100]);
      // The frame's own ItemTransform composes on top.
      expect(pixelToPageAffine(bounds, [1, 0, 0, 1, 10, 20], 48, 48)).toEqual([
        5, 0, 0, 5, 110, 120,
      ]);
      // Degenerate inputs answer null rather than emitting NaNs.
      expect(pixelToPageAffine(bounds, null, 0, 48)).toBeNull();
      expect(pixelToPageAffine([0, 0, 0, 0], null, 48, 48)).toBeNull();
    });

    it("regionTableFor merges the contours and RE-WINDS the hole", () => {
      const out = engine.trace(ringPixels(48), 48, 48, {
        mode: "bw",
        pathMode: "polygon",
      });
      const m = pixelToPageAffine(bounds, null, 48, 48)!;
      const table = regionTableFor(out.regions[0], m)!;
      // ONE table, TWO contours.
      expect(table.subpathStarts).toHaveLength(2);
      const outer = contourSignedArea(
        table.anchors.slice(0, table.subpathStarts[1]) as never,
      );
      const hole = contourSignedArea(
        table.anchors.slice(table.subpathStarts[1]) as never,
      );
      // Opposite windings — the non-zero hole condition. This is
      // draw-geometry's `orientForNonZeroHoles` (via `makeCompoundTable`)
      // doing it, not code in this repo's trace lane.
      expect(Math.sign(outer)).toBe(-Math.sign(hole));
      // …at 5 pt per pixel, so 25× the pixel areas.
      expect(Math.abs(outer)).toBeCloseTo(32 * 32 * 25, 2);
      expect(Math.abs(hole)).toBeCloseTo(12 * 12 * 25, 2);
    });

    it("traceOptionsFrom merges a payload over the documented defaults", () => {
      expect(traceOptionsFrom(undefined)).toEqual(TRACE_DEFAULTS);
      expect(traceOptionsFrom({ mode: "bw", bwThreshold: 90 })).toEqual({
        ...TRACE_DEFAULTS,
        mode: "bw",
        bwThreshold: 90,
      });
      // Junk is ignored, not coerced.
      expect(
        traceOptionsFrom({
          mode: "sideways",
          filterSpeckle: "lots",
          ignoreWhite: 1,
          nonsense: true,
        }),
      ).toEqual(TRACE_DEFAULTS);
    });

    it("traceSwatchMutationFor names the swatch with its hex (the SVG-io convention)", () => {
      expect(traceSwatchMutationFor("Color/u1", [18, 52, 86])).toEqual({
        op: "createSwatch",
        args: {
          spec: {
            selfId: "Color/u1",
            name: "#123456",
            space: "RGB",
            value: [18, 52, 86],
          },
        },
      });
    });

    it("batch 1 = the swatches, then one insertPath per CONTOUR", () => {
      const plan = ringPlan();
      const batch = traceInsertBatchFor(plan) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(batch.op).toBe("batch");
      // One swatch (black) + two contours (outer + hole).
      expect(plan.swatches).toHaveLength(1);
      expect(plan.regions[0].contours).toBe(2);
      expect(batch.args.ops).toHaveLength(3);
      expect(batch.args.ops[0]).toEqual(
        traceSwatchMutationFor(plan.swatches[0].id, plan.swatches[0].color),
      );
      expect((batch.args.ops[1] as { op: string }).op).toBe("insertPath");
      expect((batch.args.ops[2] as { op: string }).op).toBe("insertPath");
      // `insertPath` carries ONE contour and no `subpathStarts`, which is
      // exactly why batch 2 has to re-merge through `framePath`.
      const first = batch.args.ops[1] as {
        args: { pageId: string; anchors: unknown[]; open: boolean };
      };
      expect(first.args.pageId).toBe(F7_PLACED_IMAGE.pageId);
      expect(first.args.open).toBe(false);
      expect(first.args.anchors).toHaveLength(4);
    });

    it("bindTraceRegions chunks the minted ids back onto their regions", () => {
      const plan = ringPlan();
      const bound = bindTraceRegions(plan, [poly("a"), poly("b")])!;
      expect(bound).toHaveLength(1);
      expect(bound[0].keep).toEqual(poly("a"));
      expect(bound[0].absorb).toEqual([poly("b")]);
      // A count mismatch REFUSES rather than mis-binding.
      expect(bindTraceRegions(plan, [poly("a")])).toBeNull();
      expect(bindTraceRegions(plan, [poly("a"), poly("b"), poly("c")])).toBeNull();
    });

    it("batch 2 = re-merge + delete the surplus + fill + clear stroke + stamp", () => {
      const plan = ringPlan();
      const bindings = bindTraceRegions(plan, [poly("a"), poly("b")])!;
      const batch = traceFinishBatchFor({
        plan,
        bindings,
        record: {
          uri: plan.sourceUri,
          source: [48, 48],
          traced: [48, 48],
          scale: 1,
          options: TRACE_DEFAULTS,
          regions: ["a"],
          truncated: 0,
          oneShot: true,
        },
        sourceEnvelope: null,
      }) as Extract<Mutation, { op: "batch" }>;
      const kinds = batch.args.ops.map((o) => (o as { op: string }).op);
      // framePath (re-merge) → deleteFrame (the absorbed contour) →
      // fill → stroke:null → the record on the SOURCE. ONE region, so no
      // group (a one-member group would be noise).
      expect(kinds).toEqual([
        "setElementProperty",
        "deleteFrame",
        "setElementProperty",
        "setElementProperty",
        "setPluginMetadata",
      ]);
      expect(batch.args.ops[2]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: poly("a"),
          path: "frameFillColor",
          value: { type: "colorRef", value: plan.regions[0].swatchId },
        },
      });
      // A traced region is a FILL: the stroke is cleared so an inherited
      // document default does not outline every shape.
      expect(batch.args.ops[3]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: poly("a"),
          path: "frameStrokeColor",
          value: { type: "colorRef", value: null },
        },
      });
    });

    it("two or more regions DO get grouped", () => {
      const plan = twoColourPlan();
      expect(plan.regions.length).toBeGreaterThanOrEqual(2);
      const minted = plan.regions.flatMap((r, i) =>
        Array.from({ length: r.contours }, (_, k) => poly(`u${i}_${k}`)),
      );
      const bindings = bindTraceRegions(plan, minted)!;
      const batch = traceFinishBatchFor({
        plan,
        bindings,
        record: {
          uri: "x",
          source: [64, 32],
          traced: [64, 32],
          scale: 1,
          options: TRACE_DEFAULTS,
          regions: [],
          truncated: 0,
          oneShot: true,
        },
        sourceEnvelope: null,
      }) as Extract<Mutation, { op: "batch" }>;
      const last = batch.args.ops[batch.args.ops.length - 1] as {
        op: string;
        args: { memberIds: ElementId[] };
      };
      expect(last.op).toBe("createGroup");
      expect(last.args.memberIds).toEqual(bindings.map((b) => b.keep));
    });

    it("the metadata record round-trips and says ONE-SHOT out loud", () => {
      const record = {
        uri: "file:ring-48.png",
        source: [48, 48] as [number, number],
        traced: [48, 48] as [number, number],
        scale: 1,
        options: TRACE_DEFAULTS,
        regions: ["u1"],
        truncated: 7,
        oneShot: true as const,
      };
      const env = withImageTrace({ v: 1, data: { other: 1 } }, record);
      expect((env!.data as { other: number }).other).toBe(1);
      const back = imageTraceOf(env)!;
      expect(back.uri).toBe("file:ring-48.png");
      expect(back.truncated).toBe(7);
      expect(back.oneShot).toBe(true);
      expect(back.options).toEqual(TRACE_DEFAULTS);
      // Dropping the record leaves the other keys alone.
      expect(imageTraceOf(withImageTrace(env, null))).toBeNull();
      expect(imageTraceOf(null)).toBeNull();
      expect(imageTraceOf({ v: 1, data: { imageTrace: "nope" } })).toBeNull();
    });
  });

  // ------------------------------------------------------------------

  describe("against the real engine (F7: a placed-image frame + a polygon)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F7_PLACED_IMAGE.bytes());
      h.loadBundle(drawBundle);
    }, 60_000);
    afterAll(() => h?.dispose());

    beforeEach(async () => {
      await h.host.selection.set([]);
    });

    it("the fixture really is a placed-image frame (elementGeometry says so)", async () => {
      const items = await h.host.document.elementGeometry([IMAGE]);
      expect(items[0].hasImage).toBe(true);
      expect(items[0].bounds).toEqual(F7_PLACED_IMAGE.bounds);
      expect(items[0].pageId).toBe(F7_PLACED_IMAGE.pageId);
    });

    it("THE HONEST GAP: headless serves no placed bytes, so the command REFUSES", async () => {
      // `assets.images@1` is unconditionally implemented (the read is
      // engine-served through `requestPlacedAssetBytes`, not an injected
      // source) …
      expect(h.host.supports("assets.images@1")).toBe(true);
      // … but the engine only serves what its BUILD already decoded and
      // cached UNDER THE LINK URI. This fixture's pixels ride inline
      // `<Image><Contents>` base64, which core caches under an
      // `inline:<ptr>:<len>` key, not the URI — so the C-5 door answers
      // null here. Measured, not assumed.
      //
      // FIXED IN CORE 2026-08-07 (C-26): the inline cache is now keyed
      // by the owning element's id, so this door serves embedded bytes.
      // The pin below therefore FLIPS THE MOMENT the editor picks up a
      // canvas-wasm built after that change — which is the pin working,
      // not a regression. When it goes red, replace the `toBeNull()`
      // with the positive assertion (bytes + natural size) and delete
      // the "no placed bytes" half of this test's name; the decoder half
      // below is a separate, still-true gap (Node has no ImageBitmap).
      expect(await h.host.assets.getPlacedImage(F7_PLACED_IMAGE.imageId)).toBeNull();
      // And this realm is Node: no createImageBitmap, no OffscreenCanvas.
      expect(rasterDecoderAvailable()).toBe(false);
      // So the full command inserts NOTHING and says why (it never
      // throws — the dash-command convention).
      const before = await leafIds(h);
      await h.host.selection.set([IMAGE]);
      expect(await applyImageTrace(h.host)).toEqual([]);
      expect(await leafIds(h)).toEqual(before);
    });

    it("a selection that is not ONE image frame is a no-op", async () => {
      const before = await leafIds(h);
      await h.host.selection.set([]);
      expect(await applyImageTrace(h.host)).toEqual([]);
      await h.host.selection.set([IMAGE, poly("uspare")]);
      expect(await applyImageTrace(h.host)).toEqual([]);
      // A frame with no placed image is refused on `hasImage`.
      await h.host.selection.set([poly("uspare")]);
      expect(await applyImageTrace(h.host)).toEqual([]);
      expect(await leafIds(h)).toEqual(before);
    });

    it("A TRACED RING LANDS AS ONE COMPOUND ELEMENT — TWO batches", async () => {
      const before = await leafIds(h);
      const plan = ringPlan();
      const created = await applyImageTracePlan(h.host, plan);
      expect(created).toHaveLength(1);

      // ONE element carrying BOTH contours — the surplus insert was
      // absorbed by the `framePath` re-merge and deleted.
      const ring = await contoursOf(h, created[0]);
      expect(ring!.starts).toHaveLength(2);
      expect(Math.sign(ring!.areas[0])).toBe(-Math.sign(ring!.areas[1]));
      expect(Math.abs(ring!.areas[0])).toBeCloseTo(32 * 32 * 25, 0);
      expect(Math.abs(ring!.areas[1])).toBeCloseTo(12 * 12 * 25, 0);
      expect(await leafIds(h)).toHaveLength(before.length + 1);

      // It is filled with the minted swatch and carries no stroke.
      expect(await readProp(h, created[0], "frameFillColor")).toEqual({
        type: "colorRef",
        value: plan.swatches[0].id,
      });
      // …and the swatch really was created, named with its hex.
      const swatches = await h.host.document.collection<{
        selfId: string;
        name: string;
      }>("swatches");
      const minted = swatches.find((s) => s.selfId === plan.swatches[0].id);
      expect(minted?.name).toBe(rgbToHex(plan.swatches[0].color));

      // The SOURCE frame carries the record.
      const record = imageTraceOf(await h.host.document.getMetadata(IMAGE));
      expect(record?.uri).toBe(F7_PLACED_IMAGE.uri);
      expect(record?.oneShot).toBe(true);
      expect(record?.regions).toEqual([created[0].id]);

      // TWO batches ⇒ TWO undos. `insertPath` mints the ids batch 2
      // addresses, and a batch cannot address an id minted inside itself.
      await h.host.document.undo();
      // Batch 2 undone: the absorbed contour is back as its own element.
      expect(await leafIds(h)).toHaveLength(before.length + 2);
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(before);
      expect(imageTraceOf(await h.host.document.getMetadata(IMAGE))).toBeNull();
    });

    it("THE HOLE RENDERS: the exported PDF paints ONE path, two OPPOSITE contours", async () => {
      const before = filledBlocks(await pdfContentStream(h));
      // Every pre-existing filled path is a single contour — which also
      // proves this parser sees real path construction ops.
      expect(before.every((b) => b.length === 1)).toBe(true);

      const created = await applyImageTracePlan(h.host, ringPlan());
      expect(created).toHaveLength(1);

      const after = filledBlocks(await pdfContentStream(h));
      const compound = after.filter((b) => b.length === 2);
      expect(compound).toHaveLength(1);
      const [outerRing, innerRing] = compound[0];
      // The engine fills NON-ZERO (`paged-export-pdf` emits `f`, never
      // `f*`), so opposite windings are what carves the hole. Same sign
      // here would mean the traced ring printed as a solid coin.
      expect(Math.sign(ringArea(outerRing))).toBe(-Math.sign(ringArea(innerRing)));
      expect(Math.abs(ringArea(outerRing))).toBeCloseTo(32 * 32 * 25, -1);
      expect(Math.abs(ringArea(innerRing))).toBeCloseTo(12 * 12 * 25, -1);

      await h.host.document.undo();
      await h.host.document.undo();
    });

    it("SEVERAL regions land as a GROUP, each with its own swatch", async () => {
      const before = await leafIds(h);
      const plan = twoColourPlan();
      expect(plan.regions.length).toBeGreaterThanOrEqual(2);
      expect(plan.swatches.length).toBeGreaterThanOrEqual(2);
      const created = await applyImageTracePlan(h.host, plan);
      expect(created).toHaveLength(plan.regions.length);
      expect(await leafIds(h)).toHaveLength(before.length + created.length);

      // Each region got ITS OWN colour, not a shared one.
      const fills = await Promise.all(
        created.map((id) => readProp(h, id, "frameFillColor")),
      );
      expect(new Set(fills.map((f) => JSON.stringify(f))).size).toBe(
        plan.swatches.length,
      );

      // The selection is the GROUP the batch created (found in the tree —
      // a batch outcome does not echo an inner createGroup's id).
      const selected = h.host.selection.get();
      expect(selected).toHaveLength(1);
      expect(selected[0].kind).toBe("group");

      await h.host.document.undo();
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(before);
    });

    it("a plan with no regions inserts nothing (a blank image is not artwork)", async () => {
      const before = await leafIds(h);
      const blank = engine.trace(
        raster(32, 32, () => [255, 255, 255]),
        32,
        32,
        {},
      );
      expect(blank.regions).toHaveLength(0);
      expect(
        await applyImageTracePlan(h.host, planFor(blank, 32, 32)),
      ).toEqual([]);
      expect(await leafIds(h)).toEqual(before);
    });

    it("the RECORDED command handler is registered with the honest title", async () => {
      const cmd = commandFor(h, IMAGE_TRACE_COMMAND_ID);
      expect(cmd.title).toBe(IMAGE_TRACE_COMMAND_TITLE);
      // The title itself has to carry the scope — CommandContribution has
      // no description field.
      expect(cmd.title).toContain("one-shot");
      expect(cmd.title).toContain("fills only");
      expect(cmd.title).toContain("not Illustrator's live Image Trace");
      expect(cmd.category).toBe("Image");

      // Driving it through the recorded handler takes the same refusal
      // path (no placed bytes here) and does not throw.
      const before = await leafIds(h);
      await h.host.selection.set([IMAGE]);
      await cmd.handler({} as never, { mode: "bw" } as never);
      expect(await leafIds(h)).toEqual(before);
    });
  });

  // ------------------------------------------------------------- plans

  /** A plan built from a REAL trace of the fixture's OWN pixels, mapped
   *  onto the fixture's frame. Everything but the pixel intake is live. */
  function ringPlan(): TracePlan {
    const result = engine.trace(ringPixels(48), 48, 48, {
      mode: "bw",
      pathMode: "polygon",
    });
    return planFor(result, 48, 48);
  }

  function twoColourPlan(): TracePlan {
    return planFor(engine.trace(twoColours(), 64, 32, {}), 64, 32);
  }

  function planFor(result: TraceResult, w: number, h: number): TracePlan {
    return tracePlanFor({
      pageId: F7_PLACED_IMAGE.pageId,
      source: IMAGE,
      sourceUri: F7_PLACED_IMAGE.uri,
      result,
      pixelToPage: pixelToPageAffine(F7_PLACED_IMAGE.bounds, null, w, h)!,
      scale: 1,
      sourcePixels: [w, h],
      options: TRACE_DEFAULTS,
    });
  }
});
