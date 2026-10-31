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
// WP6.3 (draw ADR 367) moved the appearance commands and the graphic
// styles onto the native appearance when the host's engine has it
// (`document.appearance@1`): the list helpers below are what they edit,
// and `installAppearanceMigration` (appearance-migrate.ts) moves a
// document's metadata stacks over when it opens. The metadata stack stays
// the lane of a host without the flag.

import type {
  BundleHost,
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

/** One layer of the engine's appearance (`PaintLayerSpec` on the wire);
 *  the fields this module does not edit ride along untouched. */
export interface NativePaintLayer {
  kind: "fill" | "stroke" | "frameFill" | "frameStroke";
  enabled?: boolean;
  color?: string;
  tint?: number;
  opacityPct?: number;
  blendMode?: string;
  weight?: number;
  [field: string]: unknown;
}

/** The feature a host's engine advertises when it draws native
 *  appearance (engine ADR 1043). */
export const NATIVE_APPEARANCE_FEATURE = "document.appearance@1";

/** The page items that carry `frameAppearance`. */
export const APPEARANCE_KINDS: ReadonlySet<string> = new Set([
  "textFrame",
  "rectangle",
  "oval",
  "polygon",
]);

/** Whether the host's engine draws native appearance. */
export function nativeAppearanceOn(host: BundleHost): boolean {
  try {
    return host.supports(NATIVE_APPEARANCE_FEATURE);
  } catch {
    return false;
  }
}

/** The layers of a read `appearance` value (`{ type, value: { layers } }`,
 *  or the list itself), or null. */
export function layersOfValue(value: unknown): NativePaintLayer[] | null {
  if (Array.isArray(value)) return value as NativePaintLayer[];
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: string; value?: unknown; layers?: unknown };
  const inner = v.type === "appearance" ? v.value : v;
  const layers = (inner as { layers?: unknown } | null)?.layers;
  return Array.isArray(layers) ? (layers as NativePaintLayer[]) : null;
}

/** `id`'s native appearance as stored (empty: the frame as it always
 *  was), or null when the item carries none. */
export async function readNativeAppearance(
  host: BundleHost,
  id: ElementId,
): Promise<NativePaintLayer[] | null> {
  if (!APPEARANCE_KINDS.has(id.kind)) return null;
  const props = await host.document.elementProperties(id).catch(() => null);
  const row = props?.entries.find((e) => e.path === "frameAppearance");
  if (!row) return null;
  return layersOfValue(row.value) ?? [];
}

/** The list with its placeholders made explicit: the empty list is the
 *  frame's fill under its stroke; a list that names only one gets the
 *  other where the engine implies it (the fill at the bottom, the stroke
 *  right above it). */
export function explicitLayers(
  layers: readonly NativePaintLayer[],
): NativePaintLayer[] {
  const out = layers.map((l) => ({ ...l }));
  const hasFill = out.some((l) => l.kind === "frameFill");
  const hasStroke = out.some((l) => l.kind === "frameStroke");
  if (!hasFill) out.unshift({ kind: "frameFill" });
  if (!hasStroke) {
    const at = out.findIndex((l) => l.kind === "frameFill");
    out.splice(at + 1, 0, { kind: "frameStroke" });
  }
  return out;
}

/** The whole-list write (one undo step). */
export function appearanceMutation(
  id: ElementId,
  layers: readonly NativePaintLayer[],
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "frameAppearance",
      value: { type: "appearance", value: { layers: [...layers] } },
    },
  } as Mutation;
}

const isFillKind = (l: NativePaintLayer) =>
  l.kind === "fill" || l.kind === "frameFill";
const isStrokeKind = (l: NativePaintLayer) =>
  l.kind === "stroke" || l.kind === "frameStroke";

/** Add a fill or stroke the way Illustrator's Add New Fill / Stroke does:
 *  directly above the topmost layer of its kind. */
export function addNativeLayer(
  layers: readonly NativePaintLayer[],
  layer: NativePaintLayer,
): NativePaintLayer[] {
  const out = explicitLayers(layers);
  const same = layer.kind === "stroke" ? isStrokeKind : isFillKind;
  let at = -1;
  out.forEach((l, i) => {
    if (same(l)) at = i;
  });
  out.splice(at + 1, 0, layer);
  return out;
}

/** The list index of the `n`-th extra layer of `kind` (bottom to top),
 *  -1 when there is none. */
export function extraLayerIndex(
  layers: readonly NativePaintLayer[],
  kind: "fill" | "stroke",
  n: number,
): number {
  let seen = -1;
  for (let i = 0; i < layers.length; i++)
    if (layers[i]!.kind === kind && ++seen === n) return i;
  return -1;
}

/** Drop the layer at `index` (a placeholder is the frame's own paint and
 *  stays: an out-of-range or placeholder index changes nothing). */
export function removeNativeLayer(
  layers: readonly NativePaintLayer[],
  index: number,
): NativePaintLayer[] {
  const out = explicitLayers(layers);
  const l = out[index];
  if (!l || l.kind === "frameFill" || l.kind === "frameStroke") return out;
  out.splice(index, 1);
  return out;
}

/** Move the layer at `index` by `delta` places (clamped; placeholders
 *  move too — the order IS what draws on top). */
export function moveNativeLayer(
  layers: readonly NativePaintLayer[],
  index: number,
  delta: number,
): NativePaintLayer[] {
  const out = explicitLayers(layers);
  const to = Math.max(0, Math.min(out.length - 1, index + delta));
  if (!out[index] || to === index) return out;
  const [l] = out.splice(index, 1);
  out.splice(to, 0, l!);
  return out;
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
