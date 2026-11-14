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

// What a Pathfinder button will act on, shown before the click (the UX
// strategy's §7.1; paged.draw ADR 370). The engine offers no dry run of a
// Boolean or region operation, so the result itself cannot be previewed;
// what can be shown honestly is WHICH objects the click takes and which
// of them has the role the operation turns on — the object that keeps the
// result of a shape mode (the first selected), the frontmost that Crop
// cuts with and Minus back keeps. The kept one is drawn solid and named,
// the others dashed. Nothing is changed until the click.

import type { ElementId, PathfinderKind } from "@paged-media/client";

import type { PathfinderRegionVerb } from "../pathfinder-commands";

/** One operand's outline: its page and page-local bounds. */
export interface OperandBox {
  id: ElementId;
  pageId: string;
  /** `[top, left, bottom, right]`, page-local pt. */
  bounds: readonly [number, number, number, number];
}

export type PathfinderOp = PathfinderKind | PathfinderRegionVerb;

/** The role the operation gives its special operand, or null when every
 *  operand plays the same part (Divide, Trim, Merge, Outline). */
export function specialRole(op: PathfinderOp): {
  which: "first-selected" | "frontmost";
  role: "result" | "kept" | "cutter";
} | null {
  switch (op) {
    case "union":
    case "intersect":
    case "exclude":
      return { which: "first-selected", role: "result" };
    case "subtract":
      return { which: "first-selected", role: "kept" };
    case "pathfinderCrop":
      return { which: "frontmost", role: "cutter" };
    case "pathfinderMinusBack":
      return { which: "frontmost", role: "kept" };
    default:
      return null;
  }
}

const key = (id: ElementId) => `${id.kind}:${JSON.stringify(id.id)}`;

/** A box as a closed four-anchor path (the overlay's path variant carries
 *  the dashed stroke). */
function boxPath(b: OperandBox, dashed: boolean) {
  const [t, l, bt, r] = b.bounds;
  const corner = (x: number, y: number) => ({
    anchor: [x, y] as [number, number],
    left: [x, y] as [number, number],
    right: [x, y] as [number, number],
  });
  return {
    pageId: b.pageId,
    anchors: [corner(l, t), corner(r, t), corner(r, bt), corner(l, bt)],
    close: true,
    dashed,
  };
}

/** The overlay shapes for `op` over `boxes` (in selection order), with the
 *  special operand — `selection[0]`, or `frontmost` — solid and labelled
 *  `label`. */
export function operandPreview(
  op: PathfinderOp,
  boxes: readonly OperandBox[],
  frontmost: ElementId | null,
  label: string | null,
): Array<Record<string, unknown>> {
  const role = specialRole(op);
  const special =
    role === null
      ? null
      : role.which === "first-selected"
        ? (boxes[0]?.id ?? null)
        : frontmost;
  const shapes: Array<Record<string, unknown>> = [];
  for (const b of boxes) {
    const isSpecial = special !== null && key(b.id) === key(special);
    shapes.push(boxPath(b, role !== null && !isSpecial));
    if (isSpecial && label) {
      shapes.push({
        kind: "text",
        pageId: b.pageId,
        x: b.bounds[1],
        y: b.bounds[0] - 4,
        text: label,
        size: 11,
        background: true,
      });
    }
  }
  return shapes;
}
