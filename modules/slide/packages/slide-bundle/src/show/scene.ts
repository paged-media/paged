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

// An animated slide as layers (slide ADR 714, on extensions ADR 346 and its
// C4 amendment). The static background holds every item below the lowest
// animated one; each animated shape's items are layers of their own (its
// text frame cut into paragraph layers when the shape builds by
// paragraph); the static items above an animated one are drawn as "runs"
// between the layers, so the stacking order of the page holds. Pure: the
// plan, and each layer's draw state from the player's states.

import type { ElementId } from "@paged-media/plugin-api";

import {
  IDENTITY_STATE,
  targetId,
  type Box,
  type EffectInfo,
  type LayerState,
} from "../anim/model.js";
import {
  idOf,
  resolveTarget,
  type PageItem,
  type PageShapes,
} from "../anim/shapes.js";

/** Which part of an animated shape a layer draws. */
export type LayerPart = "art" | "text" | { paragraph: number };

/** One entry of a slide's plan, bottom first. */
export type PlanEntry =
  | { kind: "item"; item: PageItem; target: string; part: LayerPart }
  | { kind: "paragraphs"; item: PageItem; target: string }
  | { kind: "static"; items: PageItem[] };

export interface ScenePlan {
  pageId: string;
  /** Items left out of the background (every layer's and run's). */
  hide: ElementId[];
  entries: PlanEntry[];
  /** Each animated target's shape box, page pt (the whole shape's and its
   *  background's layer keys). */
  boxes: Record<string, Box>;
  /** Targets the timing names that are not on the page. */
  missing: string[];
  /** The shapes whose click plays a trigger, by target id: their boxes,
   *  page pt. */
  triggers: Record<string, Box>;
}

/** The plan of a slide whose effects are `effects` (a slide without
 *  effects: everything is the background). */
export function planScene(
  page: PageShapes | undefined,
  pageId: string,
  effects: readonly EffectInfo[],
): ScenePlan {
  const plan: ScenePlan = {
    pageId,
    hide: [],
    entries: [],
    boxes: {},
    missing: [],
    triggers: {},
  };
  if (!page || effects.length === 0) return plan;
  // The shapes the effects (and their triggers' shapes need no layer)
  // animate, and whether each builds its text by paragraph.
  const animated = new Map<string, { target: string; byParagraph: boolean }>();
  for (const e of effects) {
    if (e.trigger) {
      const t = resolveTarget(e.trigger, page);
      if (t) plan.triggers[targetId(e.trigger)] = t.box;
    }
    const shape = resolveTarget(e.target, page);
    const id = targetId(e.target);
    if (!shape) {
      if (!plan.missing.includes(id)) plan.missing.push(id);
      continue;
    }
    const first = shape.items[0];
    const k = idOf(first.id);
    const a = animated.get(k) ?? { target: id, byParagraph: false };
    if (e.paragraph !== null && shape.text) a.byParagraph = true;
    animated.set(k, a);
    plan.boxes[id] = shape.box;
    plan.boxes[`${id}#bg`] = shape.box;
  }
  if (animated.size === 0) return plan;
  const owner = new Map<string, { target: string; byParagraph: boolean }>();
  for (const s of page.shapes) {
    const a = animated.get(idOf(s.items[0].id));
    if (!a) continue;
    for (const it of s.items) owner.set(idOf(it.id), a);
  }
  const lowest = Math.min(
    ...page.items.filter((i) => owner.has(idOf(i.id))).map((i) => i.z),
  );
  let run: PageItem[] = [];
  const flush = () => {
    if (run.length) plan.entries.push({ kind: "static", items: run });
    run = [];
  };
  for (const it of page.items) {
    if (it.z < lowest) continue;
    const a = owner.get(idOf(it.id));
    plan.hide.push(it.id);
    if (!a) {
      run.push(it);
      continue;
    }
    flush();
    if (it.id.kind === "textFrame" && a.byParagraph) {
      plan.entries.push({ kind: "paragraphs", item: it, target: a.target });
    } else {
      plan.entries.push({
        kind: "item",
        item: it,
        target: a.target,
        part: it.id.kind === "textFrame" ? "text" : "art",
      });
    }
  }
  flush();
  return plan;
}

// ------------------------------------------------------------ draw state

/** Page pt → page pt: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = [number, number, number, number, number, number];
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function mul(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** A state's map of the page: scale, skew and turn about the box's
 *  centre, then the move. */
export function stateMatrix(s: LayerState, box: Box): Affine {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = (s.rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const kx = Math.tan(((s.skewX ?? 0) * Math.PI) / 180);
  const ky = Math.tan(((s.skewY ?? 0) * Math.PI) / 180);
  // R · K · S, about the centre.
  const k: Affine = [1, ky, kx, 1, 0, 0];
  const sc: Affine = [s.sx, 0, 0, s.sy, 0, 0];
  const rot: Affine = [cos, sin, -sin, cos, 0, 0];
  const lin = mul(rot, mul(k, sc));
  const toOrigin: Affine = [1, 0, 0, 1, -cx, -cy];
  const back: Affine = [1, 0, 0, 1, cx + s.dx, cy + s.dy];
  return mul(back, mul(lin, toOrigin));
}

export interface MaskState {
  filter: string;
  sub: string | null;
  progress: number;
  out: boolean;
  /** The box the mask is laid out in, page pt (before the layer moves). */
  box: Box;
}

/** How one layer is drawn this frame. */
export interface DrawState {
  visible: boolean;
  opacity: number;
  matrix: Affine;
  masks: MaskState[];
  /** A colour the layer is recoloured to (`#rrggbb`), or null. */
  tint: string | null;
}

const STATIC: DrawState = {
  visible: true,
  opacity: 1,
  matrix: IDENTITY,
  masks: [],
  tint: null,
};

/** A layer's draw state: its shape's whole state, then its part's (the
 *  shape's background for its art, a paragraph's for that paragraph). */
export function drawState(
  layers: Readonly<Record<string, LayerState>>,
  target: string | null,
  part: LayerPart | null,
  boxes: Readonly<Record<string, Box>>,
  partBox: Box | null,
): DrawState {
  if (target === null) return STATIC;
  const shapeBox = boxes[target] ?? partBox ?? { x: 0, y: 0, w: 0, h: 0 };
  const whole = layers[target] ?? IDENTITY_STATE;
  const partKey =
    part === "art"
      ? `${target}#bg`
      : part !== null && typeof part === "object"
        ? `${target}#p${part.paragraph}`
        : null;
  const own = partKey ? layers[partKey] : undefined;
  const ownBox = partKey ? (boxes[partKey] ?? partBox ?? shapeBox) : shapeBox;
  const masks: MaskState[] = [];
  if (own?.mask) masks.push({ ...own.mask, box: ownBox });
  if (whole.mask) masks.push({ ...whole.mask, box: shapeBox });
  let matrix = stateMatrix(whole, shapeBox);
  if (own) matrix = mul(matrix, stateMatrix(own, ownBox));
  const colour = (s: LayerState | undefined) =>
    part === "text" || (part !== null && typeof part === "object")
      ? (s?.text ?? null)
      : (s?.fill ?? s?.line ?? null);
  return {
    visible: whole.visible && (own?.visible ?? true),
    opacity: whole.opacity * (own?.opacity ?? 1),
    matrix,
    masks,
    tint: colour(own) ?? colour(whole),
  };
}
