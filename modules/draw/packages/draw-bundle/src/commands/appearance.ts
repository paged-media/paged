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

// Appearance model — stacked fills/strokes per object (concept §13.5,
// Tier B; "the Appearance model is Illustrator's deepest concept").
//
// MECHANISM (the honest "metadata + baked path" the concept names): the
// IDML/engine frame has ONE fill and ONE stroke. A multi-fill/multi-stroke
// appearance is therefore PLUGIN METADATA — an `appearance` envelope in
// this plugin's `x-paged:media.paged.draw` carrier listing the extra
// fill/stroke LAYERS — plus a BAKE that writes the COMPOSITED top layer to
// the frame's real `frameFillColor` / `frameStrokeColor` /
// `frameStrokeWeight`. Opening in InDesign shows the baked top layer
// (valid IDML); reopening in Paged restores the full stack from metadata.
//
// LIMITATION, named (the task's "name the limitation honestly"): the
// engine has ONE fill + ONE stroke slot per frame and NO per-layer
// blend/opacity compositing of multiple fills into a single frame paint.
// So the top-layer bake is NOT a true composite of N fills — it lowers
// the FRONT-MOST (top) opaque fill layer and the front-most stroke layer
// to the frame's real attributes (the visible result when layers don't
// blend).
//
// B-24 CLOSED (the GROUP BAKE, `commands/appearance-bake.ts`): the
// faithful N-layer lowering is NOT a multi-paint frame model — that
// would be a paged-only extension IDML cannot round-trip. It is a GROUP
// of stacked page items, each with one paint, all sharing the source
// geometry, which IS ordinary IDML. This module keeps the stack model,
// the metadata carrier and the front-most-layer bake (what an UNBAKED
// object shows and what a RELEASED object goes back to); the bake module
// owns the group lowering, its inverse, and the honest list of what does
// and does not survive it.
//
// The layer EDITORS (add fill / add stroke / clear / remove / reorder) are
// the HOST's: `paged.appearance.*` over the engine's native appearance
// (PM-0017). What stays here is the stack MODEL, which the group bake, the
// graphic styles and the migration of a document's old metadata stacks read.

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationOutcome,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

import {
  appearanceBakeOf,
  rebakeAppearance,
  stampDrawMetadata,
} from "./appearance-bake";
import { oneBatchFor } from "./batch-handles";

/** Which half of the stack an edit addresses. */
export type AppearanceLayerKind = "fill" | "stroke";

/** One extra fill layer (a swatch ref + optional tint %). */
export interface FillLayer {
  /** A swatch / gradient self-id (the `frameFillColor` colorRef vocab). */
  color: string;
  /** Tint 0..100, default 100. Survives the metadata, the front-most-layer
   *  bake AND the GROUP bake: core's `set_property` grew Polygon + Oval
   *  arms for `FrameFillTint` (C-20) and the IDML writer emits the
   *  attribute for an inserted item (C-19), so a tinted layer round-trips
   *  through a save. */
  tint?: number;
  /** Layer opacity 0..100. Renders on canvas, prints into a PDF export,
   *  and since C-19 the IDML write-new lane emits the
   *  `<TransparencySetting>` that carries it — so it survives a save-back
   *  of a baked layer too (see `appearance-bake.ts`). */
  opacity?: number;
  /** IDML blend mode for this layer (`"Multiply"`, `"Screen"`, …). A
   *  GROUP-BAKE property: a blend mode needs the layers BELOW it to blend
   *  with, which only the baked stack provides, so it lowers onto the
   *  derived path (`FrameBlendMode` grew a Polygon arm in C-20) and is
   *  deliberately not part of the front-most-layer bake. */
  blendMode?: string;
}

/** One extra stroke layer (a swatch ref + weight in pt). */
export interface StrokeLayer {
  color: string;
  /** Stroke weight in pt. */
  weight: number;
  /** Layer opacity 0..100 — same lane as {@link FillLayer.opacity}. */
  opacity?: number;
  /** IDML blend mode — same lane as {@link FillLayer.blendMode}. */
  blendMode?: string;
}

/** The appearance stack — fills + strokes BOTTOM-to-TOP (the LAST entry
 *  is the front-most, the one the bake lowers to the frame). */
export interface AppearanceStack {
  fills: FillLayer[];
  strokes: StrokeLayer[];
}

/** Read the appearance stack out of an envelope's `data.appearance`, or
 *  an empty stack. Tolerant of partial/foreign shapes (returns empty
 *  rather than throwing). */
export function appearanceOf(
  env: PluginMetadataEnvelope | null,
): AppearanceStack {
  const raw = (env?.data as { appearance?: unknown } | undefined)?.appearance;
  if (!raw || typeof raw !== "object") return { fills: [], strokes: [] };
  const a = raw as Partial<AppearanceStack>;
  return {
    fills: Array.isArray(a.fills) ? a.fills.slice() : [],
    strokes: Array.isArray(a.strokes) ? a.strokes.slice() : [],
  };
}

/** Merge a stack back into an envelope's `data.appearance`, preserving
 *  other draw metadata. An empty stack drops the key (and clears the
 *  whole envelope to null when nothing else remains). */
export function withAppearance(
  prev: PluginMetadataEnvelope | null,
  stack: AppearanceStack,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  const empty = stack.fills.length === 0 && stack.strokes.length === 0;
  if (empty) {
    delete data.appearance;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.appearance = stack;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

// ------------------------------------------------ pure stack transforms
// (the panel's edit vocabulary — index arithmetic with no host in sight,
// so the round-trip is unit-testable and the panel stays a view)

/** The BAKE: the `setElementProperty` writes that lower the FRONT-MOST
 *  (last) fill + stroke layer onto the frame's real attributes. Returns
 *  an empty array when the stack has neither (nothing to bake — the
 *  frame keeps its own paint). Exported so the conformance spec asserts
 *  the exact wire shape. */
export function bakeAppearanceMutations(
  elementId: ElementId,
  stack: AppearanceStack,
): Mutation[] {
  const ops: Mutation[] = [];
  const topFill = stack.fills.at(-1);
  if (topFill) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameFillColor",
        value: { type: "colorRef", value: topFill.color },
      },
    });
    if (typeof topFill.tint === "number") {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameFillTint",
          value: { type: "length", value: topFill.tint },
        },
      });
    }
  }
  const topStroke = stack.strokes.at(-1);
  if (topStroke) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameStrokeColor",
        value: { type: "colorRef", value: topStroke.color },
      },
    });
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameStrokeWeight",
        value: { type: "length", value: topStroke.weight },
      },
    });
  }
  return ops;
}

/** Persist a stack onto an element.
 *
 *  UNBAKED target: write the metadata envelope AND bake the top layer to
 *  the frame, in ONE batch: one undo step (DRW-4).
 *
 *  BAKED target (a `data.appearanceBake` record on the envelope): the
 *  derived layers ARE what renders, so a metadata-only write would let
 *  the model and the page diverge. The edit therefore RE-BAKES — release
 *  the old layers with the new stack, then bake it again (two undo
 *  steps; see `appearance-bake.ts`).
 *
 *  Exported for the conformance spec. Returns the metadata outcome (the
 *  source of truth); a bake failure is logged, not thrown (the stack
 *  still round-trips). */
export async function commitAppearance(
  host: BundleHost,
  id: ElementId,
  stack: AppearanceStack,
  prev: PluginMetadataEnvelope | null,
): Promise<MutationOutcome> {
  if (appearanceBakeOf(prev)) {
    return rebakeAppearance(host, id, stack, prev);
  }
  return commitAppearancePlans(host, [planAppearance(id, stack, prev)]);
}

/** The ops that persist `stack` on an UNBAKED element: the envelope (a
 *  raw in-batch `setPluginMetadata`) and the top layer painted onto the
 *  frame. */
export function planAppearance(
  id: ElementId,
  stack: AppearanceStack,
  prev: PluginMetadataEnvelope | null,
): Mutation[] {
  return [
    stampDrawMetadata(id, withAppearance(prev, stack)),
    ...bakeAppearanceMutations(id, stack),
  ];
}

/** Send planned appearance writes as ONE batch (one undo step for the
 *  whole selection). */
async function commitAppearancePlans(
  host: BundleHost,
  plans: Mutation[][],
): Promise<MutationOutcome> {
  const ops = plans.flat();
  const outcome = await host.document.mutate(oneBatchFor(ops));
  if (!outcome.applied) {
    host.log.warn(
      `appearance edit rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
  }
  return outcome;
}
