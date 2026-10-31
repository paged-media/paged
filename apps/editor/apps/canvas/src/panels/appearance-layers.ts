/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Engine ADR 1043, editor ADR 312 — an item's appearance, as the Appearance
// panel edits it. The engine keeps one bottom-to-top list of paint layers
// per item (`frameAppearance`) and takes it whole: every gesture here —
// add a fill or a stroke, duplicate, delete, move, switch on or off, change
// a layer's field — is a pure function from the list read to the list
// written, so one write and one undo step.
//
// Two placeholder kinds, `frameFill` and `frameStroke`, stand for the
// item's own fill and stroke. A list that does not place them implies them
// (the frame's fill at the bottom, its stroke directly above it; the empty
// list is the item as it always was): `explicit` makes them explicit, as
// the engine's `drawn_order` does, so every gesture works on the list as
// drawn. The engine normalises what it stores (placeholders alone in the
// implied order come back empty).

/** A layer's kind, as the wire spells it. */
export type PaintLayerKind = "fill" | "stroke" | "frameFill" | "frameStroke";

/** One layer (the wire's `PaintLayerSpec`): its kind, its switch and the
 *  flat optional fields a kind reads. */
export interface PaintLayer {
  kind: PaintLayerKind;
  enabled?: boolean;
  color?: string | null;
  tint?: number | null;
  opacityPct?: number | null;
  blendMode?: string | null;
  weight?: number | null;
  [field: string]: unknown;
}

/** The fields the panel edits on a layer of its own. */
export type LayerField = "color" | "opacityPct" | "blendMode" | "weight";

/** The colour a new layer falls back to when nothing seeds it. */
export const DEFAULT_COLOR = "Color/Black";

/** The item's own fill or stroke. */
export const isPlaceholder = (l: PaintLayer) =>
  l.kind === "frameFill" || l.kind === "frameStroke";

/** A fill-kind layer (an extra fill or the frame's own). */
export const isFillKind = (l: PaintLayer) =>
  l.kind === "fill" || l.kind === "frameFill";

/** A stroke-kind layer (an extra stroke or the frame's own). */
export const isStrokeKind = (l: PaintLayer) =>
  l.kind === "stroke" || l.kind === "frameStroke";

export const isEnabled = (l: PaintLayer) => l.enabled !== false;

/** The layers of a read `frameAppearance` — the object model reads it as
 *  its list of layers; the raw wire wraps it as `{ type: "appearance",
 *  value: { layers } }` — or `null` when the read is not one. */
export function layersOf(value: unknown): PaintLayer[] | null {
  if (Array.isArray(value)) return value as PaintLayer[];
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: string; value?: unknown };
  const inner =
    v.type === "appearance" ? v.value : (value as { layers?: unknown });
  const layers = (inner as { layers?: unknown } | null)?.layers;
  return Array.isArray(layers) ? (layers as PaintLayer[]) : null;
}

/** The wire value a write of the whole list commits. */
export function appearanceValue(layers: readonly PaintLayer[]) {
  return { type: "appearance", value: { layers: [...layers] } } as const;
}

/** The list as drawn, bottom to top, with the implied placeholders made
 *  explicit: the frame's fill at the bottom when the list does not place
 *  it, the frame's stroke directly above the frame's fill when it does
 *  not place that (the engine's `drawn_order`). */
export function explicit(layers: readonly PaintLayer[]): PaintLayer[] {
  const out = [...layers];
  if (!out.some((l) => l.kind === "frameFill"))
    out.unshift({ kind: "frameFill", enabled: true });
  if (!out.some((l) => l.kind === "frameStroke")) {
    const at = out.findIndex((l) => l.kind === "frameFill") + 1;
    out.splice(at, 0, { kind: "frameStroke", enabled: true });
  }
  return out;
}

/** One row of the panel: the layer and its index in the bottom-to-top
 *  list `explicit` returns. */
export interface ViewRow {
  layer: PaintLayer;
  index: number;
}

/** The rows as the panel lists them, top to bottom: front-most first, as
 *  Illustrator's Appearance panel does (the reverse of the list). */
export function viewOrder(layers: readonly PaintLayer[]): ViewRow[] {
  return explicit(layers)
    .map((layer, index) => ({ layer, index }))
    .reverse();
}

/** What seeds a new layer: the frame's own paint, for a placeholder. */
export interface FrameSeed {
  fillColor?: string | null;
  strokeColor?: string | null;
  strokeWeight?: number | null;
}

/** A usable colour, or `null` for none (`Swatch/None`, empty). */
function usable(c: unknown): string | null {
  return typeof c === "string" && c !== "" && c !== "Swatch/None" ? c : null;
}

function seedFrom(
  layer: PaintLayer | undefined,
  kind: "fill" | "stroke",
  frame: FrameSeed,
): PaintLayer {
  const own =
    layer && !isPlaceholder(layer)
      ? usable(layer.color)
      : usable(kind === "fill" ? frame.fillColor : frame.strokeColor);
  const out: PaintLayer = {
    kind,
    enabled: true,
    color: own ?? DEFAULT_COLOR,
  };
  if (kind === "stroke") {
    const w =
      layer && !isPlaceholder(layer) ? layer.weight : frame.strokeWeight;
    out.weight = typeof w === "number" && w > 0 ? w : 1;
  }
  return out;
}

function lastIndex(
  layers: readonly PaintLayer[],
  pred: (l: PaintLayer) => boolean,
): number {
  for (let i = layers.length - 1; i >= 0; i--) if (pred(layers[i]!)) return i;
  return -1;
}

/** Add a new fill directly above the topmost fill-kind layer, seeded with
 *  that layer's colour (the frame's fill colour for the placeholder;
 *  `Color/Black` when there is none) — Illustrator's Add New Fill. */
export function addFill(
  layers: readonly PaintLayer[],
  frame: FrameSeed = {},
): PaintLayer[] {
  const out = explicit(layers);
  const at = lastIndex(out, isFillKind);
  out.splice(at + 1, 0, seedFrom(out[at], "fill", frame));
  return out;
}

/** Add a new stroke directly above the topmost stroke-kind layer, seeded
 *  likewise (its weight the seed's, else 1 pt). */
export function addStroke(
  layers: readonly PaintLayer[],
  frame: FrameSeed = {},
): PaintLayer[] {
  const out = explicit(layers);
  const at = lastIndex(out, isStrokeKind);
  out.splice(at + 1, 0, seedFrom(out[at], "stroke", frame));
  return out;
}

/** Duplicate the layer at `index` directly above it. A placeholder's copy
 *  is an extra layer of its kind seeded from the frame's paint (the item
 *  has one own fill and one own stroke). */
export function duplicate(
  layers: readonly PaintLayer[],
  index: number,
  frame: FrameSeed = {},
): PaintLayer[] {
  const out = explicit(layers);
  const l = out[index];
  if (!l) return out;
  const copy = isPlaceholder(l)
    ? seedFrom(undefined, isFillKind(l) ? "fill" : "stroke", frame)
    : { ...l, effects: Array.isArray(l.effects) ? [...l.effects] : l.effects };
  if (isPlaceholder(l)) copy.enabled = isEnabled(l);
  out.splice(index + 1, 0, copy);
  return out;
}

/** Remove the layer at `index`; a placeholder stays (the item's own paint
 *  cannot be deleted, only switched off). */
export function remove(
  layers: readonly PaintLayer[],
  index: number,
): PaintLayer[] {
  const out = explicit(layers);
  const l = out[index];
  if (!l || isPlaceholder(l)) return out;
  out.splice(index, 1);
  return out;
}

/** Move the layer at `index` by `delta` places in the bottom-to-top list
 *  (+1 is towards the front), clamped. Placeholders move too. */
export function move(
  layers: readonly PaintLayer[],
  index: number,
  delta: number,
): PaintLayer[] {
  const out = explicit(layers);
  const to = Math.max(0, Math.min(out.length - 1, index + delta));
  if (to === index || !out[index]) return out;
  const [l] = out.splice(index, 1);
  out.splice(to, 0, l!);
  return out;
}

export function setEnabled(
  layers: readonly PaintLayer[],
  index: number,
  enabled: boolean,
): PaintLayer[] {
  return explicit(layers).map((l, i) => (i === index ? { ...l, enabled } : l));
}

/** Set one field of the layer at `index` (not of a placeholder: the
 *  frame's own paint is edited on its own paths). */
export function setField(
  layers: readonly PaintLayer[],
  index: number,
  field: LayerField,
  value: unknown,
): PaintLayer[] {
  return explicit(layers).map((l, i) =>
    i === index && !isPlaceholder(l) ? { ...l, [field]: value } : l,
  );
}

/** Clear appearance: the item as it always was. */
export const clear = (): PaintLayer[] => [];
