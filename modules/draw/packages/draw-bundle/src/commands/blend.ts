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

// Blend v0 (wave 2) — `blendSelected`: EXACTLY 2 selected path
// elements with MATCHING structure (same subpath count, same anchor
// count per subpath, same open flags) → N=3 intermediate paths by
// LINEAR anchor/handle interpolation (draw-geometry's
// `interpolateAnchors`), inserted through the standard insertPath
// lane. Anchors are compared/lerped in PAGE space (each source's item
// transform applied first), so two visually aligned paths blend where
// they appear.
//
// STRUCTURE MISMATCH = honest diagnostic + no-op (no resampling /
// re-parameterization in v0 — inventing correspondences would fake a
// capability the geometry layer doesn't have yet).
//
// UNDO SHAPE (honest, engine-probed): the commit is TWO batches —
// (1) swatches + ALL inserted geometry, (2) the intermediates' fills
// — i.e. two undo steps, not one. A single-batch blend is blocked by
// two NAMED ENGINE GAPS in the published wasm: `setDocumentDefaults`
// is REJECTED inside `Mutation::Batch` (probed: "Mutation::Batch
// notImplemented"), and a batch op cannot reference an id created by
// an EARLIER op in the same batch — so per-step fills can ride
// neither the defaults idiom nor the same batch as their inserts.
// (Also probed: the current wasm ACCEPTS direct frameFillColor writes
// on freshly inserted Polygons — the Phase 8 finding no longer bites
// on this lane, which is what makes the fills batch possible at all.)
//
// COLORS (honest v0): the fill interpolates ONLY when BOTH sources'
// `frameFillColor` refs resolve — via the swatch collection — to
// names that parse as CSS colours (the io/svg importer convention:
// swatch name = the hex; the built-in "Black" also parses). Then each
// step mints an interpolated RGB swatch (named with its hex). Anything
// else (gradients, spots, opaque swatch names, no fill) keeps the
// FIRST element's fill ref for all intermediates. Stroke is NOT
// blended in v0 (intermediates keep the creation default).

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  interpolateAnchors,
  mixRgb,
  parseCssColor,
  rgbToHex,
  type AnchorTriple,
  type Rgb,
} from "@paged-media/draw-geometry";

import { supportsPathOps } from "./path-ops";
import { leafIdsOf, valueForCriterion } from "./select-same";

export const BLEND_COMMAND_CATEGORY = "Path";
export const BLEND_COMMAND_ID = "media.paged.draw.command.blendSelected";

/** v0 fixed step count: 3 intermediates at t = 1/4, 2/4, 3/4. */
export const BLEND_STEPS = 3;

/** One source path normalized to PAGE space: per-subpath anchor runs +
 *  open flags. */
export interface BlendSource {
  subpaths: AnchorTriple[][];
  open: boolean[];
}

/** Normalize a pathAnchors read into page-space subpath runs. */
export function blendSourceFrom(table: PathAnchorsResult): BlendSource {
  const m = table.itemTransform ?? null;
  const toPage = (p: readonly [number, number]): [number, number] =>
    m ? (applyAffine(m, p[0], p[1]) as [number, number]) : [p[0], p[1]];
  const starts = table.subpathStarts.length ? table.subpathStarts : [0];
  const subpaths: AnchorTriple[][] = [];
  const open: boolean[] = [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : table.anchors.length;
    subpaths.push(
      table.anchors.slice(begin, end).map((a) => ({
        anchor: toPage(a.anchor),
        left: toPage(a.left),
        right: toPage(a.right),
      })),
    );
    open.push(table.subpathOpen?.[s] ?? false);
  }
  return { subpaths, open };
}

/** Do two sources blend? Same subpath count, same anchor count per
 *  subpath, same open flags. Exported for the conformance spec. */
export function blendStructureMatches(a: BlendSource, b: BlendSource): boolean {
  if (a.subpaths.length !== b.subpaths.length) return false;
  for (let i = 0; i < a.subpaths.length; i++) {
    if (a.subpaths[i].length !== b.subpaths[i].length) return false;
    if (a.open[i] !== b.open[i]) return false;
  }
  return true;
}

/** The fill plan the batch builders consume (see the COLORS note). */
export type BlendFillPlan =
  | { kind: "interpolate"; from: Rgb; to: Rgb }
  | { kind: "keepFirst"; ref: string | null };

/** A unique-enough swatch id nonce (the io/svg mint pattern). */
let swatchSeq = 0;
function mintBlendSwatchId(): string {
  const n = `${Date.now().toString(16)}${(swatchSeq++).toString(16)}`;
  return `Color/udrawblend${n}`;
}

/** Batch 1 of the blend commit: (interpolating) the per-step swatches
 *  + EVERY interpolated subpath insert — one batch, so one undo step
 *  removes the whole geometry. Also answers the per-step fill refs the
 *  fills batch applies afterwards. Null when the structures mismatch.
 *  Exported so the conformance spec asserts the exact wire shape. */
export function blendGeometryBatchFor(
  pageId: string,
  a: BlendSource,
  b: BlendSource,
  fill: BlendFillPlan,
): { mutation: Mutation; stepFills: (string | null)[] } | null {
  if (!blendStructureMatches(a, b)) return null;
  const ops: Mutation[] = [];
  const stepFills: (string | null)[] = [];
  for (let step = 1; step <= BLEND_STEPS; step++) {
    const t = step / (BLEND_STEPS + 1);
    if (fill.kind === "interpolate") {
      const rgb = mixRgb(fill.from, fill.to, t);
      const id = mintBlendSwatchId();
      ops.push({
        op: "createSwatch",
        args: {
          spec: {
            selfId: id,
            // Name = the hex (the io/svg convention, so the SVG
            // exporter resolves the ref back).
            name: rgbToHex(rgb),
            space: "RGB",
            value: [rgb[0], rgb[1], rgb[2]],
          },
        },
      });
      stepFills.push(id);
    } else {
      stepFills.push(fill.ref);
    }
    for (let s = 0; s < a.subpaths.length; s++) {
      const anchors = interpolateAnchors(a.subpaths[s], b.subpaths[s], t);
      if (anchors.length === 0) continue;
      ops.push({
        op: "insertPath",
        args: {
          pageId,
          anchors: anchors.map((p) => ({
            anchor: [p.anchor[0], p.anchor[1]] as [number, number],
            left: [p.left[0], p.left[1]] as [number, number],
            right: [p.right[0], p.right[1]] as [number, number],
          })),
          open: a.open[s],
        },
      });
    }
  }
  return { mutation: { op: "batch", args: { ops } }, stepFills };
}

/** Batch 2 of the blend commit: each created intermediate's fill (one
 *  setElementProperty per element, batched — the second undo step).
 *  `createdByStep` is step-major (every subpath of step 1, then step
 *  2, …). Null when there is nothing to write (every step fill null).
 *  Exported for the conformance spec. */
export function blendFillBatchFor(
  createdByStep: readonly (readonly ElementId[])[],
  stepFills: readonly (string | null)[],
): Mutation | null {
  const ops: Mutation[] = [];
  createdByStep.forEach((created, step) => {
    const fill = stepFills[step] ?? null;
    if (fill === null) return;
    for (const elementId of created) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameFillColor",
          value: { type: "colorRef", value: fill },
        },
      });
    }
  });
  if (ops.length === 0) return null;
  return { op: "batch", args: { ops } };
}

/** Resolve a fill ref to an RGB triple through the swatch collection
 *  (swatch NAME parses as a CSS colour — the narrow-facade lane io/svg
 *  documents). Null = not hex-able. */
async function fillRgbOf(
  host: BundleHost,
  ref: string | null,
): Promise<Rgb | null> {
  if (!ref) return null;
  try {
    const swatches = await host.document.collection<{
      selfId: string;
      name: string;
    }>("swatches");
    const sw = swatches.find((s) => s.selfId === ref);
    if (!sw) return null;
    return parseCssColor(sw.name);
  } catch {
    return null;
  }
}

/** The document's leaf element ids (string form) — the created-id
 *  diff base (a batch outcome reports only ONE createdId). */
async function leafElements(host: BundleHost): Promise<ElementId[]> {
  const roots = await host.document.tree();
  return leafIdsOf(roots);
}

export async function applyBlendSelected(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  const paths = selection.filter(supportsPathOps);
  if (selection.length !== 2 || paths.length !== 2) {
    host.log.warn(
      `${BLEND_COMMAND_ID}: needs exactly 2 selected path elements ` +
        `(got ${selection.length} selected, ${paths.length} path-bearing) — no-op`,
    );
    return;
  }
  const [idA, idB] = paths;
  const tableA = await host.document.pathAnchors(idA).catch(() => null);
  const tableB = await host.document.pathAnchors(idB).catch(() => null);
  if (!tableA || !tableB || tableA.pageId !== tableB.pageId) {
    host.log.warn(
      `${BLEND_COMMAND_ID}: both elements need readable geometry on the same page — no-op`,
    );
    return;
  }
  const a = blendSourceFrom(tableA);
  const b = blendSourceFrom(tableB);
  if (!blendStructureMatches(a, b)) {
    // The honest diagnostic the task requires: WHY it refused.
    host.log.warn(
      `${BLEND_COMMAND_ID}: structures differ ` +
        `(${a.subpaths.map((s) => s.length).join("+")} vs ` +
        `${b.subpaths.map((s) => s.length).join("+")} anchors) — ` +
        `v0 blends only matching anchor counts per subpath; no-op`,
    );
    return;
  }

  // Fill plan (see the COLORS note): interpolate when both hex-able,
  // else keep the first's ref.
  const refA = await valueForCriterion(host, idA, "fill");
  const refB = await valueForCriterion(host, idB, "fill");
  const rgbA = typeof refA === "string" ? await fillRgbOf(host, refA) : null;
  const rgbB = typeof refB === "string" ? await fillRgbOf(host, refB) : null;
  const fill: BlendFillPlan =
    rgbA && rgbB
      ? { kind: "interpolate", from: rgbA, to: rgbB }
      : { kind: "keepFirst", ref: typeof refA === "string" ? refA : null };

  const plan = blendGeometryBatchFor(tableA.pageId, a, b, fill);
  if (!plan) return; // unreachable post-check; kept for safety

  const before = new Set(
    (await leafElements(host))
      .map((e) => (typeof e.id === "string" ? e.id : null))
      .filter((s): s is string => s !== null),
  );
  const outcome = await host.document.mutate(plan.mutation);
  if (!outcome.applied) {
    host.log.warn(
      `${BLEND_COMMAND_ID} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return;
  }

  // The created intermediates: the leaf diff, in tree (= insertion)
  // order, regrouped step-major. A batch outcome carries only ONE
  // createdId, so the diff is the honest enumeration.
  const created = (await leafElements(host)).filter(
    (e) => typeof e.id === "string" && !before.has(e.id),
  );
  const perStep = a.subpaths.length;
  if (created.length !== BLEND_STEPS * perStep) {
    host.log.warn(
      `${BLEND_COMMAND_ID}: expected ${BLEND_STEPS * perStep} created ` +
        `intermediates, found ${created.length} — skipping the fill pass`,
    );
    return;
  }
  const createdByStep: ElementId[][] = [];
  for (let step = 0; step < BLEND_STEPS; step++) {
    createdByStep.push(created.slice(step * perStep, (step + 1) * perStep));
  }
  const fills = blendFillBatchFor(createdByStep, plan.stepFills);
  if (fills) {
    const fillOutcome = await host.document.mutate(fills);
    if (!fillOutcome.applied) {
      host.log.warn(
        `${BLEND_COMMAND_ID} fill pass rejected: ` +
          `${JSON.stringify(fillOutcome.error)} (geometry stands unfilled)`,
      );
    }
  }
}

/** Register the blend command. */
export function contributeBlendCommand(host: BundleHost): Disposable {
  return host.contribute.command({
    id: BLEND_COMMAND_ID,
    title: "Path: Blend selected (3 steps)",
    category: BLEND_COMMAND_CATEGORY,
    handler: () => applyBlendSelected(host),
  });
}
