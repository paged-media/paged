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

// Editor ADR 1240, amendment 1 — what the canvas's committed move, copy,
// resize, scale or rotate did to the selection, measured from the document
// (the targets' geometry before the gesture moved anything and after its
// commit) and handed to the interaction coordinator with the session's end.
// The coordinator gives it to whoever observes committed sessions (the
// actions recorder); nobody observing, the canvas reads nothing extra.

import {
  measureTransformIntent,
  type GestureMeasure,
  type TransformIntent,
} from "@paged-media/shell";
import type {
  ElementGeometryItem,
  ElementId,
  GestureModifiers,
  GestureType,
  SceneTreeNode,
} from "@paged-media/client";

/** The gestures a step can repeat; content transforms, shears and the
 *  tools' drawing are not among them. */
export function measuredGesture(
  spec: GestureType,
): GestureMeasure["gesture"] | null {
  switch (spec.kind) {
    case "translate":
    case "resize":
    case "scale":
    case "rotate":
      return spec.kind;
    default:
      return null;
  }
}

/** The reads the measure needs (the canvas client's). */
export interface IntentReadClient {
  elementGeometry(ids: ElementId[]): Promise<ElementGeometryItem[]>;
  sceneTree(): Promise<SceneTreeNode[]>;
}

const keyOf = (id: ElementId) => `${id.kind}:${String(id.id)}`;

/** Every item's id in the scene (`kind:id`): what an Alt move's copies are
 *  found against after its commit. Null when the scene cannot be read. */
export async function sceneItemKeys(
  client: IntentReadClient,
): Promise<ReadonlySet<string> | null> {
  const roots = await client.sceneTree().catch(() => null);
  if (!roots) return null;
  const out = new Set<string>();
  const walk = (n: SceneTreeNode) => {
    if (n.id) out.add(keyOf(n.id));
    for (const c of n.children ?? []) walk(c);
  };
  roots.forEach(walk);
  return out;
}

/** The items of `roots` that `known` did not hold, outermost only (a new
 *  group, not also its members). */
export function freshItems(
  known: ReadonlySet<string>,
  roots: readonly SceneTreeNode[],
): ElementId[] {
  const out: ElementId[] = [];
  const walk = (n: SceneTreeNode) => {
    if (n.id && !known.has(keyOf(n.id))) {
      out.push(n.id);
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  roots.forEach(walk);
  return out;
}

/** What the canvas knows of one committed gesture. */
export interface CommittedGesture {
  spec: GestureType;
  /** The dragged handle of a handle drag (a scale names it here; a resize
   *  in its spec). */
  handle?: string | null;
  target: readonly ElementId[];
  modifiers: GestureModifiers;
  /** The targets' geometry before the gesture moved anything. */
  before: readonly ElementGeometryItem[];
  /** The scene's items before the gesture began (an Alt move's copies are
   *  the items the commit added). */
  sceneBefore?: Promise<ReadonlySet<string> | null> | null;
}

const HANDLES = new Set([
  "north",
  "south",
  "east",
  "west",
  "northEast",
  "northWest",
  "southEast",
  "southWest",
]);

/** Read the targets (or the copies) after the commit and measure. Null
 *  when the gesture is not one a step repeats, or did nothing. */
export async function measureCommitted(
  client: IntentReadClient,
  g: CommittedGesture,
): Promise<TransformIntent | null> {
  const gesture = measuredGesture(g.spec);
  if (!gesture || g.before.length === 0) return null;
  // An Alt move left a copy (or moved the originals, when the selection
  // cannot be copied): the copies are the items the commit added.
  let copies: ElementId[] = [];
  if (gesture === "translate" && g.modifiers.alt && g.sceneBefore) {
    const known = await g.sceneBefore;
    const now = known ? await client.sceneTree().catch(() => null) : null;
    if (known && now) copies = freshItems(known, now);
  }
  const copied = copies.length > 0;
  const after = await client.elementGeometry(copied ? copies : [...g.target]);
  const handle =
    g.spec.kind === "resize"
      ? (g.spec as { handle?: string }).handle
      : (g.handle ?? null);
  return measureTransformIntent({
    gesture,
    handle:
      handle && HANDLES.has(handle)
        ? (handle as GestureMeasure["handle"])
        : null,
    alt: g.modifiers.alt,
    copied,
    before: g.before,
    after,
  });
}
