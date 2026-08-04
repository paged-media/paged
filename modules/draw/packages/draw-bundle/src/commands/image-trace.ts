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

// IMAGE TRACE v0 — a placed raster becomes real vector page items.
//
// READ THIS BEFORE BELIEVING THE FEATURE NAME. Illustrator's Image Trace
// is a LIVE object: presets, a tracing panel you scrub, a result that
// re-traces when you change a knob, an Expand step, and a centreline mode
// that finds STROKES. THIS IS NOT THAT, and the command title says so.
// What this is:
//   · a ONE-SHOT lowering — pixels in, ordinary filled Polygons out, in
//     one place, once. Editing the source image afterwards does nothing;
//     undo is the only "un-trace";
//   · FILLS ONLY — every region is a filled shape. There is no
//     centreline/stroke detection, so a line drawing comes back as thin
//     filled outlines, not as strokes;
//   · NO PRESETS — parameters are the documented v0 defaults below,
//     overridable per invocation through the command payload;
//   · NON-DESTRUCTIVE toward the source: the placed image is NOT deleted,
//     hidden or replaced. The traced group is INSERTED, so it lands at
//     the top of the page's z-order — over the image it came from (the
//     insert-lane fact `commands/pattern.ts` and the appearance bake also
//     record). Deleting or hiding the original is the user's call.
//
// THE PIXELS come through the C-5 placed-asset door,
// `host.assets.getPlacedImage(elementId)` (manifest
// `capabilities.assets: ["images"]`), which serves the ORIGINAL encoded
// file. Decoding is the platform's (`io/raster-decode.ts` — see its
// header for why, and for what a PSD does). The trace itself is the
// `trace-js` wasm over `visioncortex` (`../trace-engine.ts`).
//
// THE HOLES are the reason this module sits next to
// `commands/compound-path.ts`. A traced ring has an outer boundary and an
// inner one, and the engine fills NON-ZERO (`paged-compose`'s display
// list says so; `paged-export-pdf` emits `f`, never `f*`). Contours wound
// the SAME way paint a solid coin. So every region's contours go through
// draw-geometry's `makeCompoundTable` — `mergeCompound` +
// `orientForNonZeroHoles` — which re-winds by NESTING DEPTH. No second
// winding implementation exists in this repo, and the conformance spec
// proves the hole in an exported PDF rather than in an anchor table.
//
// MUTATION / UNDO SHAPE (probed against the booted engine, protocol 57;
// the RFI C-15 rule — assert the real count, never claim "one undo"):
// TWO batches ⇒ 2 undo steps. Batch 1 creates the colour swatches and
// inserts every contour as its own path; batch 2 re-merges each region's
// contours through the `framePath` door, deletes the surplus elements,
// paints, stamps the record and groups. Two is the FLOOR: `insertPath`
// mints the ids batch 2 addresses, and a batch cannot address an id
// minted inside itself (the appearance-bake / blend.ts finding).
//
// KNOWN GAP, named rather than papered over: the trace is fitted to the
// FRAME's bounds. A placed image's OWN transform inside its frame (fit,
// crop, offset — the IDML `<Image>` `ItemTransform`) is not on the plugin
// contract: `elementGeometry` reports the frame's bounds + the FRAME's
// `itemTransform` and a `hasImage` flag, and no read door exposes the
// inner one. So a cropped or non-fitted placement traces to the frame
// rectangle and will not line up with what is displayed. That is an RFI
// gap (a placed-image placement read), not something to guess at here —
// the command logs the assumption every time it runs.
//
// BLOCKING, with MEASURED numbers rather than a comforting adjective: the
// trace runs synchronously in the bundle realm — the MAIN thread in the
// editor — and cannot be interrupted once started. Flat artwork at
// 2048×2048 takes ~0.3 s; a NOISY PHOTOGRAPH at the same size took 41 s
// on the bench (`../trace-engine.ts` carries the whole table). That is
// why the default trace budget is 1 MP, not the kernel's 4 MP refusal
// cap, and why anything over `TRACE_SLOW_PIXELS` gets a warning BEFORE
// the call. v0 does not use `host.workers`; that is the named v1 step and
// the real fix.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  composeAffine,
  makeCompoundTable,
  rgbToHex,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
  type Rgb,
} from "@paged-media/draw-geometry";

import manifest from "../../manifest.json";
import {
  bootTraceEngine,
  traceBudget,
  TRACE_DEFAULTS,
  type TraceEngine,
  type TraceLimits,
  type TraceOptions,
  type TraceRegion,
  type TraceResult,
} from "../trace-engine";
import { decodeRasterBytes, rasterDecoderAvailable } from "../io/raster-decode";

import { DRAW_METADATA_KEY } from "./appearance-bake";
import { framePathMutationFor } from "./compound-path";
import { groupMutationFor } from "./group";
import { insertPathMutationFor } from "../handlers/insert-path";

export const IMAGE_TRACE_COMMAND_CATEGORY = "Image";

export const IMAGE_TRACE_COMMAND_ID = "media.paged.draw.command.imageTrace";

/** The contributed command ids, in registration order. */
export const IMAGE_TRACE_COMMAND_IDS = [IMAGE_TRACE_COMMAND_ID];

/** The command title. Long on purpose: `CommandContribution` has no
 *  description field, so the title is the ONLY place the honest scope can
 *  reach a user who never opens the source. */
export const IMAGE_TRACE_COMMAND_TITLE =
  "Image: Trace placed image to vector paths " +
  "(one-shot, fills only — not Illustrator's live Image Trace)";

// ------------------------------------------------------------- record

/** Stamped on the SOURCE image frame so a reopened document can tell
 *  traced artwork from hand-drawn artwork, and say what it came from. */
export interface ImageTraceRecord {
  /** The resolved link URI the trace read. */
  uri: string;
  /** Natural pixel size of the decoded file. */
  source: [number, number];
  /** Pixel size actually traced (below `source` when downsampled). */
  traced: [number, number];
  /** 1 = full resolution; below 1 the raster was downsampled to fit the
   *  tracer's caps and detail is gone. */
  scale: number;
  /** The options the trace actually ran with. */
  options: Required<TraceOptions>;
  /** Emitted region ids, in insertion order. */
  regions: string[];
  /** Regions dropped by `maxRegions` — non-zero means the artwork is an
   *  INCOMPLETE trace, and the value says by how much. */
  truncated: number;
  /** Always true, and always read as "these paths do NOT track the
   *  image". Carried explicitly so the value says so on reopen. */
  oneShot: true;
}

/** Read the trace record out of an envelope, or null. Tolerant of
 *  partial/foreign shapes (the `patternBakeOf` convention). */
export function imageTraceOf(
  env: PluginMetadataEnvelope | null,
): ImageTraceRecord | null {
  const raw = (env?.data as { imageTrace?: unknown } | undefined)?.imageTrace;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ImageTraceRecord>;
  if (typeof r.uri !== "string") return null;
  const pair = (v: unknown, fallback: [number, number]): [number, number] =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number")
      ? [v[0] as number, v[1] as number]
      : fallback;
  return {
    uri: r.uri,
    source: pair(r.source, [0, 0]),
    traced: pair(r.traced, [0, 0]),
    scale: typeof r.scale === "number" ? r.scale : 1,
    options: { ...TRACE_DEFAULTS, ...(r.options ?? {}) },
    regions: Array.isArray(r.regions)
      ? r.regions.filter((s): s is string => typeof s === "string")
      : [],
    truncated: typeof r.truncated === "number" ? r.truncated : 0,
    oneShot: true,
  };
}

/** Merge (or, with `null`, drop) the trace record in an envelope,
 *  preserving every other draw metadata key. */
export function withImageTrace(
  prev: PluginMetadataEnvelope | null,
  record: ImageTraceRecord | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (record === null) {
    delete data.imageTrace;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.imageTrace = record;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

// -------------------------------------------------------- the plan

/** One region, lowered: its contours merged into ONE page-space anchor
 *  table (holes re-wound for non-zero) plus the swatch its fill points
 *  at. */
export interface TracePlanRegion {
  /** PAGE-space contours — outer first, holes re-wound against it. */
  table: AnchorTable;
  /** How many contours the table carries (1 = no holes). */
  contours: number;
  /** The swatch self-id this region's fill references. */
  swatchId: string;
  color: Rgb;
}

/** Everything the two batches need, resolved once. Pure data — the
 *  conformance spec builds one from a real trace and drives the real
 *  engine with it. */
export interface TracePlan {
  pageId: string;
  source: ElementId;
  sourceUri: string;
  regions: TracePlanRegion[];
  /** Deduped swatches, in creation order. */
  swatches: { id: string; color: Rgb }[];
  /** Pixel size traced + the downsample factor, for the record. */
  raster: { width: number; height: number; scale: number };
  sourcePixels: [number, number];
  options: Required<TraceOptions>;
  truncated: number;
}

/** A unique-enough swatch id nonce — the `io/svg.ts` convention (a
 *  per-call counter folded into a hex stamp so repeat traces do not
 *  collide). */
let swatchSeq = 0;
function mintTraceSwatchId(): string {
  const n = `${Date.now().toString(16)}${(swatchSeq++).toString(16)}`;
  return `Color/udrawtrace${n}`;
}

/**
 * The affine that maps PIXEL space (origin top-left of the raster, +y
 * down) onto PAGE space for a frame whose `elementGeometry` reports
 * `bounds` = `[top, left, bottom, right]` in its own inner space and
 * `itemTransform` on top of that.
 *
 * The raster is stretched to FILL the frame's bounds — see the module
 * header's named gap: the placed image's own fit/crop transform is not on
 * the contract, so this is the only mapping available.
 */
export function pixelToPageAffine(
  bounds: readonly [number, number, number, number],
  itemTransform: Affine | null,
  rasterWidth: number,
  rasterHeight: number,
): Affine | null {
  if (rasterWidth <= 0 || rasterHeight <= 0) return null;
  const [top, left, bottom, right] = bounds;
  const sx = (right - left) / rasterWidth;
  const sy = (bottom - top) / rasterHeight;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx === 0 || sy === 0) {
    return null;
  }
  const fit: Affine = [sx, 0, 0, sy, left, top];
  return itemTransform ? composeAffine(itemTransform, fit) : fit;
}

const mapAnchor = (m: Affine, a: AnchorTriple): AnchorTriple => ({
  anchor: applyAffine(m, a.anchor[0], a.anchor[1]),
  left: applyAffine(m, a.left[0], a.left[1]),
  right: applyAffine(m, a.right[0], a.right[1]),
});

/**
 * Lower ONE traced region into a page-space compound table.
 *
 * `contours[0]` is the outer boundary and the rest are holes, so each
 * becomes its own single-contour table and `makeCompoundTable` merges +
 * RE-WINDS them by nesting depth. That call is the whole hole story: the
 * engine fills non-zero, and a hole wound like its container paints a
 * coin. No winding logic is written here.
 */
export function regionTableFor(
  region: TraceRegion,
  m: Affine,
): AnchorTable | null {
  const tables: AnchorTable[] = [];
  for (const contour of region.contours) {
    if (contour.anchors.length < 3) continue;
    tables.push({
      anchors: contour.anchors.map((a) =>
        mapAnchor(m, {
          anchor: [a.anchor[0], a.anchor[1]],
          left: [a.left[0], a.left[1]],
          right: [a.right[0], a.right[1]],
        }),
      ),
      subpathStarts: [0],
      subpathOpen: [false],
    });
  }
  if (tables.length === 0) return null;
  return makeCompoundTable(tables);
}

/** Build the emit plan from a completed trace. Pure — no host, no wasm.
 *  Regions that lower to nothing are dropped. */
export function tracePlanFor(args: {
  pageId: string;
  source: ElementId;
  sourceUri: string;
  result: TraceResult;
  pixelToPage: Affine;
  scale: number;
  sourcePixels: [number, number];
  options: Required<TraceOptions>;
}): TracePlan {
  const swatches: { id: string; color: Rgb }[] = [];
  const byHex = new Map<string, string>();
  const regions: TracePlanRegion[] = [];
  for (const region of args.result.regions) {
    const table = regionTableFor(region, args.pixelToPage);
    if (!table) continue;
    const color: Rgb = [region.color[0], region.color[1], region.color[2]];
    const hex = rgbToHex(color);
    let swatchId = byHex.get(hex);
    if (!swatchId) {
      swatchId = mintTraceSwatchId();
      byHex.set(hex, swatchId);
      swatches.push({ id: swatchId, color });
    }
    regions.push({
      table,
      contours: table.subpathStarts.length,
      swatchId,
      color,
    });
  }
  return {
    pageId: args.pageId,
    source: args.source,
    sourceUri: args.sourceUri,
    regions,
    swatches,
    raster: {
      width: args.result.width,
      height: args.result.height,
      scale: args.scale,
    },
    sourcePixels: args.sourcePixels,
    options: args.options,
    truncated: args.result.truncated,
  };
}

// ------------------------------------------------------- wire builders
// Exported so the conformance spec asserts the EXACT wire shapes the live
// command emits (no second copy to drift from).

/** `createSwatch` for one traced colour. NAMED with its hex, the
 *  `io/svg.ts` convention, so the SVG exporter resolves the ref back to a
 *  real colour. */
export function traceSwatchMutationFor(id: string, color: Rgb): Mutation {
  return {
    op: "createSwatch",
    args: {
      spec: {
        selfId: id,
        name: rgbToHex(color),
        space: "RGB",
        value: [color[0], color[1], color[2]],
      },
    },
  };
}

/** Split a compound table back into its contours (the `insertPath` door
 *  carries ONE contour, so a region with holes is inserted as N paths and
 *  re-merged in batch 2). */
function contoursOf(table: AnchorTable): AnchorTriple[][] {
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  const out: AnchorTriple[][] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : table.anchors.length;
    if (to > from) out.push(table.anchors.slice(from, to) as AnchorTriple[]);
  }
  return out;
}

/** BATCH 1 — the colour swatches, then one `insertPath` per contour of
 *  every region, in plan order (which is how the minted ids are chunked
 *  back onto their regions afterwards). */
export function traceInsertBatchFor(plan: TracePlan): Mutation {
  const ops: Mutation[] = plan.swatches.map((s) =>
    traceSwatchMutationFor(s.id, s.color),
  );
  for (const region of plan.regions) {
    for (const contour of contoursOf(region.table)) {
      ops.push(insertPathMutationFor(plan.pageId, contour, false));
    }
  }
  return { op: "batch", args: { ops } };
}

/** What batch 2 resolved each region to: the surviving element id (a
 *  region's first contour absorbs the rest) and the contour ids that get
 *  deleted again. */
export interface TraceRegionBinding {
  region: TracePlanRegion;
  keep: ElementId;
  absorb: ElementId[];
}

/** Chunk the ids minted by batch 1 back onto their regions. Insertion
 *  order == tree order (the appearance-bake finding), so this is a walk,
 *  not a guess. Returns null when the count does not match — the caller
 *  then refuses rather than mis-binding. */
export function bindTraceRegions(
  plan: TracePlan,
  minted: readonly ElementId[],
): TraceRegionBinding[] | null {
  const expected = plan.regions.reduce((n, r) => n + r.contours, 0);
  if (minted.length !== expected) return null;
  const bindings: TraceRegionBinding[] = [];
  let at = 0;
  for (const region of plan.regions) {
    const ids = minted.slice(at, at + region.contours);
    at += region.contours;
    bindings.push({ region, keep: ids[0], absorb: ids.slice(1) });
  }
  return bindings;
}

const colorRef = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

const stamp = (
  elementId: ElementId,
  envelope: PluginMetadataEnvelope | null,
): Mutation => ({
  op: "setPluginMetadata",
  args: {
    elementId,
    key: DRAW_METADATA_KEY,
    value: envelope === null ? null : JSON.stringify(envelope),
    caller: manifest.id,
  },
});

/** BATCH 2 — re-merge every multi-contour region through the SAME
 *  `framePath` door Make Compound Path uses, fill each survivor with its
 *  traced colour (and clear the stroke — a traced region is a FILL, and
 *  an inherited document default stroke would outline every shape),
 *  stamp the record on the source and wrap the artwork in one group.
 *  One batch ⇒ one undo step. */
export function traceFinishBatchFor(args: {
  plan: TracePlan;
  bindings: readonly TraceRegionBinding[];
  record: ImageTraceRecord;
  sourceEnvelope: PluginMetadataEnvelope | null;
}): Mutation {
  const ops: Mutation[] = [];
  for (const binding of args.bindings) {
    if (binding.absorb.length > 0) {
      ops.push(framePathMutationFor(binding.keep, binding.region.table));
      for (const id of binding.absorb) {
        ops.push({ op: "deleteFrame", args: { frameId: id.id as string } });
      }
    }
    ops.push(colorRef(binding.keep, "frameFillColor", binding.region.swatchId));
    ops.push(colorRef(binding.keep, "frameStrokeColor", null));
  }
  ops.push(stamp(args.plan.source, withImageTrace(args.sourceEnvelope, args.record)));
  if (args.bindings.length >= 2) {
    ops.push(groupMutationFor(args.bindings.map((b) => b.keep)));
  }
  return { op: "batch", args: { ops } };
}

// ------------------------------------------------------------ appliers

/** Every leaf element id in the scene tree — the honest enumeration of
 *  what a multi-insert batch created (a batch outcome reports ONE
 *  `createdId`; the blend.ts / appearance-bake / pattern precedent). */
async function leafElements(host: BundleHost): Promise<ElementId[]> {
  const out: ElementId[] = [];
  const walk = (nodes: readonly { id?: ElementId | null; children?: unknown }[]) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as {
        id?: ElementId | null;
        children?: unknown;
      }[];
      if (children.length > 0) walk(children);
      else if (node.id) out.push(node.id);
    }
  };
  walk(await host.document.tree().catch(() => []));
  return out;
}

/** The group node holding `member`, or null — a BATCH outcome does not
 *  echo an inner `createGroup`'s minted id, so the tree is the source of
 *  truth (the pattern-bake precedent). */
async function groupContaining(
  host: BundleHost,
  member: ElementId,
): Promise<ElementId | null> {
  let found: ElementId | null = null;
  const walk = (nodes: readonly { id?: ElementId | null; children?: unknown }[]) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as {
        id?: ElementId | null;
        children?: unknown;
      }[];
      if (
        node.id?.kind === "group" &&
        children.some((c) => c.id && c.id.id === member.id)
      ) {
        found = node.id;
        return;
      }
      if (children.length > 0) walk(children);
      if (found) return;
    }
  };
  walk(await host.document.tree().catch(() => []));
  return found;
}

/**
 * Commit a resolved plan: TWO batches, the undo shape the module header
 * states. Returns the surviving element ids (empty on a refusal, always
 * logged, never thrown — the dash-command convention).
 *
 * Split out from `applyImageTrace` so the conformance spec can drive the
 * REAL engine with a plan built from a REAL trace, on a headless host
 * that has neither placed-image bytes nor an image decoder.
 */
export async function applyImageTracePlan(
  host: BundleHost,
  plan: TracePlan,
): Promise<ElementId[]> {
  const label = IMAGE_TRACE_COMMAND_ID;
  if (plan.regions.length === 0) {
    host.log.debug(`${label}: the trace produced no regions — nothing inserted`);
    return [];
  }
  const before = new Set(
    (await leafElements(host))
      .map((e) => (typeof e.id === "string" ? e.id : null))
      .filter((s): s is string => s !== null),
  );
  const inserted = await host.document.mutate(traceInsertBatchFor(plan));
  if (!inserted.applied) {
    host.log.warn(
      `${label}: contour insert rejected by engine: ${JSON.stringify(
        inserted.error,
      )}`,
    );
    return [];
  }
  const minted = (await leafElements(host)).filter(
    (e) => typeof e.id === "string" && !before.has(e.id),
  );
  const bindings = bindTraceRegions(plan, minted);
  if (!bindings) {
    host.log.warn(
      `${label}: expected ${plan.regions.reduce(
        (n, r) => n + r.contours,
        0,
      )} inserted paths, found ${minted.length} — leaving the insert in ` +
        `place, not painting or grouping`,
    );
    return minted;
  }
  const sourceEnvelope = await host.document
    .getMetadata(plan.source)
    .catch(() => null);
  const record: ImageTraceRecord = {
    uri: plan.sourceUri,
    source: plan.sourcePixels,
    traced: [plan.raster.width, plan.raster.height],
    scale: plan.raster.scale,
    options: plan.options,
    regions: bindings.map((b) => b.keep.id as string),
    truncated: plan.truncated,
    oneShot: true,
  };
  const finished = await host.document.mutate(
    traceFinishBatchFor({ plan, bindings, record, sourceEnvelope }),
  );
  if (!finished.applied) {
    host.log.warn(
      `${label}: paint/group batch rejected by engine: ${JSON.stringify(
        finished.error,
      )}`,
    );
    return bindings.map((b) => b.keep);
  }
  const keeps = bindings.map((b) => b.keep);
  const group = keeps.length >= 2 ? await groupContaining(host, keeps[0]) : null;
  await host.selection.set(group ? [group] : keeps);
  if (plan.truncated > 0) {
    host.log.warn(
      `${label}: INCOMPLETE — ${plan.truncated} region(s) past the ` +
        `maxRegions cap (${plan.options.maxRegions}) were dropped; raise ` +
        `maxRegions or increase filterSpeckle`,
    );
  }
  host.log.info(
    `${label}: ${keeps.length} region(s) traced from ${plan.sourceUri} ` +
      `(${plan.raster.width}×${plan.raster.height} px` +
      `${plan.raster.scale < 1 ? `, downsampled ×${plan.raster.scale.toFixed(3)}` : ""}` +
      `), ${plan.swatches.length} swatch(es)`,
  );
  return keeps;
}

/** Parse the command payload into a full option set over the documented
 *  v0 defaults. Unknown keys are ignored; the RUST side clamps ranges. */
export function traceOptionsFrom(payload: unknown): Required<TraceOptions> {
  const out: Required<TraceOptions> = { ...TRACE_DEFAULTS };
  if (!payload || typeof payload !== "object") return out;
  const p = payload as Record<string, unknown>;
  const num = (k: keyof TraceOptions) => {
    const v = p[k as string];
    if (typeof v === "number" && Number.isFinite(v)) {
      (out as Record<string, unknown>)[k as string] = v;
    }
  };
  const bool = (k: keyof TraceOptions) => {
    const v = p[k as string];
    if (typeof v === "boolean") (out as Record<string, unknown>)[k as string] = v;
  };
  if (p.mode === "color" || p.mode === "bw") out.mode = p.mode;
  if (p.pathMode === "spline" || p.pathMode === "polygon") {
    out.pathMode = p.pathMode;
  }
  num("colorPrecision");
  num("filterSpeckle");
  num("layerDifference");
  num("bwThreshold");
  num("cornerThresholdDeg");
  num("segmentLength");
  num("spliceThresholdDeg");
  num("maxIterations");
  num("maxRegions");
  num("maxTracePixels");
  bool("ignoreWhite");
  bool("stacked");
  return out;
}

/** Above this many traced pixels the command warns BEFORE it starts —
 *  there is no way to interrupt a synchronous wasm call once it is
 *  running, so a warning first is the only honesty available. Set from
 *  the measured timings in `../trace-engine.ts`: a noisy photograph at
 *  1 MP took 6.3 s. */
export const TRACE_SLOW_PIXELS = 700_000;

/** The four things the applier needs from the host before it can trace —
 *  resolved separately so each refusal can name itself. */
interface TraceSource {
  id: ElementId;
  pageId: string;
  bounds: [number, number, number, number];
  itemTransform: Affine | null;
  uri: string;
  bytes: Uint8Array;
}

async function traceSourceOf(host: BundleHost): Promise<TraceSource | null> {
  const label = IMAGE_TRACE_COMMAND_ID;
  const selection = host.selection.get();
  if (selection.length !== 1) {
    host.log.debug(
      `${label}: select exactly ONE placed image frame (have ${selection.length}) — no-op`,
    );
    return null;
  }
  const id = selection[0];
  const elementId = typeof id.id === "string" ? id.id : null;
  if (!elementId) {
    host.log.debug(`${label}: the selection carries no element id — no-op`);
    return null;
  }
  const items = await host.document.elementGeometry([id]).catch(() => []);
  const item = items[0];
  if (!item) {
    host.log.warn(`${label}: the selection exposes no geometry — no-op`);
    return null;
  }
  if (item.hasImage === false) {
    host.log.debug(
      `${label}: ${id.kind} ${elementId} hosts no placed image ` +
        `(elementGeometry.hasImage is false) — no-op`,
    );
    return null;
  }
  if (!host.supports("assets.images@1")) {
    host.log.warn(
      `${label}: the host serves no placed-image bytes ` +
        `(supports("assets.images@1") is false) — no-op`,
    );
    return null;
  }
  const asset = await host.assets.getPlacedImage(elementId).catch(() => null);
  if (!asset) {
    host.log.warn(
      `${label}: no placed-image bytes for ${elementId} — the element is ` +
        `not an image frame, its link does not resolve, or the image has ` +
        `not rendered yet (the C-5 door serves what the engine's build ` +
        `already cached) — no-op`,
    );
    return null;
  }
  return {
    id,
    pageId: item.pageId,
    bounds: item.bounds,
    itemTransform: (item.itemTransform ?? null) as Affine | null,
    uri: asset.uri,
    bytes: asset.bytes,
  };
}

/**
 * **Trace the selected placed image to vector paths.** One-shot, fills
 * only, non-destructive toward the source — see the module header, which
 * is the honest scope this command's title compresses. Returns the
 * inserted region ids (empty on a refusal, always logged, never thrown —
 * the dash-command convention).
 *
 * `payload` is a partial option set over the documented v0 defaults
 * (`TRACE_DEFAULTS`).
 */
export async function applyImageTrace(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = IMAGE_TRACE_COMMAND_ID;
  const options = traceOptionsFrom(payload);
  const source = await traceSourceOf(host);
  if (!source) return [];

  let engine: TraceEngine;
  try {
    engine = await bootTraceEngine();
  } catch (err) {
    host.log.warn(
      `${label}: trace engine unavailable — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  const limits: TraceLimits = engine.limits();
  // The DECODE budget: the caller's `maxTracePixels` (1 MP by default)
  // clamped to the kernel's hard refusal cap. This — not the cap — is
  // what a trace actually runs at, and it is the difference between a
  // 6-second worst case and a 41-second one.
  const budget = traceBudget(limits, options.maxTracePixels);

  if (!rasterDecoderAvailable()) {
    host.log.warn(
      `${label}: this realm cannot decode placed-image bytes ` +
        `(createImageBitmap / OffscreenCanvas absent) — no-op`,
    );
    return [];
  }
  let raster;
  try {
    raster = await decodeRasterBytes(source.bytes, budget);
  } catch (err) {
    host.log.warn(
      `${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (raster.scale < 1) {
    host.log.info(
      `${label}: ${source.uri} is ${raster.sourceWidth}×${raster.sourceHeight}, ` +
        `over the ${budget.maxPixels} px trace budget ` +
        `(maxTracePixels${
          budget.maxPixels === limits.maxPixels ? ", at the kernel's hard cap" : ""
        }) — DOWNSAMPLED to ${raster.width}×${raster.height} ` +
        `(×${raster.scale.toFixed(3)}). Detail below the new sample grid is gone.`,
    );
  }
  if (raster.width * raster.height > TRACE_SLOW_PIXELS) {
    // No way to interrupt a synchronous wasm call, so warn BEFORE.
    host.log.warn(
      `${label}: tracing ${raster.width}×${raster.height} px on the calling ` +
        `thread — this BLOCKS (measured: ~0.3 s on flat artwork, up to ~6 s ` +
        `on a noisy photograph at this size). Lower maxTracePixels for a ` +
        `faster, coarser trace.`,
    );
  }

  // Synchronous, CPU-bound, on this thread. Said in the module header,
  // said again here, because this is the line that freezes the UI.
  let result: TraceResult;
  try {
    result = engine.trace(
      new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength),
      raster.width,
      raster.height,
      options,
    );
  } catch (err) {
    host.log.warn(
      `${label}: the tracer refused — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  const pixelToPage = pixelToPageAffine(
    source.bounds,
    source.itemTransform,
    raster.width,
    raster.height,
  );
  if (!pixelToPage) {
    host.log.warn(`${label}: the frame has no mappable bounds — no-op`);
    return [];
  }
  host.log.debug(
    `${label}: fitting the trace to the FRAME's bounds — a placed image's ` +
      `own fit/crop transform is not on the plugin contract, so a cropped ` +
      `placement will not line up (named gap, see commands/image-trace.ts)`,
  );

  return applyImageTracePlan(
    host,
    tracePlanFor({
      pageId: source.pageId,
      source: source.id,
      sourceUri: source.uri,
      result,
      pixelToPage,
      scale: raster.scale,
      sourcePixels: [raster.sourceWidth, raster.sourceHeight],
      options,
    }),
  );
}

/** Register the image-trace command. The title carries the honest scope
 *  because `CommandContribution` has no description field — the pattern
 *  bake's recorded reason for the same choice. */
export function contributeImageTraceCommand(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: IMAGE_TRACE_COMMAND_ID,
      title: IMAGE_TRACE_COMMAND_TITLE,
      category: IMAGE_TRACE_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyImageTrace(host, payload).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
