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

// The migration of a metadata appearance stack (draw ADR 354) to the
// engine's native appearance (engine ADR 1043).
//
// Draw's stack lists its fills bottom to top, then its strokes bottom to
// top, and its front-most bake has already painted the TOP fill and the
// TOP stroke onto the frame's own fill and stroke. So the native list is:
// the lower fills as `fill` layers, the frame's own fill in the top fill's
// place (`frameFill`), the lower strokes as `stroke` layers, the frame's own
// stroke in the top stroke's place (`frameStroke`). The top layers' opacity
// and blend mode, which the front-most bake never wrote, go to the frame's
// fill and stroke targets (`frameFillOpacity`, `frameFillBlendMode`, …).
//
// The commands, the Appearance panel, the group bake and the graphic styles
// still read the metadata stack; moving them onto the native appearance is
// plan WP6.3. These helpers are its engine side, and what a document opened
// from before the switch migrates through.

import type {
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

import {
  appearanceOf,
  withAppearance,
  type AppearanceStack,
  type FillLayer,
  type StrokeLayer,
} from "./appearance";
import { stampDrawMetadata } from "./appearance-bake";

/** One layer of the engine's appearance (`PaintLayerSpec` on the wire). */
export interface NativePaintLayer {
  kind: "fill" | "stroke" | "frameFill" | "frameStroke";
  color?: string;
  tint?: number;
  opacityPct?: number;
  blendMode?: string;
  weight?: number;
}

function fillLayer(f: FillLayer): NativePaintLayer {
  return {
    kind: "fill",
    color: f.color,
    ...(typeof f.tint === "number" ? { tint: f.tint } : {}),
    ...(typeof f.opacity === "number" ? { opacityPct: f.opacity } : {}),
    ...(f.blendMode ? { blendMode: f.blendMode } : {}),
  };
}

function strokeLayer(s: StrokeLayer): NativePaintLayer {
  return {
    kind: "stroke",
    color: s.color,
    weight: s.weight,
    ...(typeof s.opacity === "number" ? { opacityPct: s.opacity } : {}),
    ...(s.blendMode ? { blendMode: s.blendMode } : {}),
  };
}

/** The native appearance of a metadata stack (see the file header). An
 *  empty stack is the empty list: the frame as it is. */
export function nativeAppearanceOf(stack: AppearanceStack): NativePaintLayer[] {
  if (stack.fills.length === 0 && stack.strokes.length === 0) return [];
  const out: NativePaintLayer[] = [];
  out.push(...stack.fills.slice(0, -1).map(fillLayer));
  out.push({ kind: "frameFill" });
  out.push(...stack.strokes.slice(0, -1).map(strokeLayer));
  out.push({ kind: "frameStroke" });
  return out;
}

function targetWrites(
  elementId: ElementId,
  target: "Fill" | "Stroke",
  layer: { opacity?: number; blendMode?: string } | undefined,
): Mutation[] {
  const ops: Mutation[] = [];
  if (typeof layer?.opacity === "number") {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: `frame${target}Opacity`,
        value: { type: "length", value: layer.opacity },
      },
    } as Mutation);
  }
  if (layer?.blendMode) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: `frame${target}BlendMode`,
        value: { type: "text", value: layer.blendMode },
      },
    } as Mutation);
  }
  return ops;
}

/** The ops that move `prev`'s metadata stack onto the engine: the native
 *  appearance, the top layers' opacity and blend mode on the frame's fill
 *  and stroke targets, and the envelope without its stack. Send them as
 *  ONE batch (one undo step). Empty when there is nothing to migrate, or
 *  when the stack is group-baked (release it first: the baked layers are
 *  page items the migration does not remove). */
export function migrateAppearanceMutations(
  elementId: ElementId,
  prev: PluginMetadataEnvelope | null,
): Mutation[] {
  const data = prev?.data as { appearanceBake?: unknown } | undefined;
  if (data?.appearanceBake) return [];
  const stack = appearanceOf(prev);
  const layers = nativeAppearanceOf(stack);
  if (layers.length === 0) return [];
  return [
    {
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameAppearance",
        value: { type: "appearance", value: { layers } },
      },
    } as Mutation,
    ...targetWrites(elementId, "Fill", stack.fills.at(-1)),
    ...targetWrites(elementId, "Stroke", stack.strokes.at(-1)),
    stampDrawMetadata(
      elementId,
      withAppearance(prev, { fills: [], strokes: [] }),
    ),
  ];
}
