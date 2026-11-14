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

// What a Pathfinder button will do, shown before the click (the UX
// strategy's §7.1; paged.draw ADR 370, amended 2026-11-14). The engine's
// dry run (`client.preview`, engine ADR 1308) applies the button's write to
// a copy of the document and answers the outlines it would leave: the
// result is drawn solid and named, the operands it consumes dashed.
// Where no preview can be made (the engine refuses the write, the read
// fails), what is shown is WHICH objects the click takes and which of
// them has the role the operation turns on — the object that keeps the
// result of a shape mode (the first selected), the frontmost that Crop
// cuts with and Minus back keeps — and the panel says the button applies
// on click. Nothing is changed until the click.

import type {
  ElementId,
  PathfinderKind,
  PreviewReport,
} from "@paged-media/client";

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

const apply = (
  m: readonly number[] | null | undefined,
  [x, y]: readonly number[],
): [number, number] =>
  m && m.length === 6
    ? [m[0]! * x! + m[2]! * y! + m[4]!, m[1]! * x! + m[3]! * y! + m[5]!]
    : [x!, y!];

/** The overlay shapes of a dry run's result (engine ADR 1308): every
 *  outline it answers, contour by contour, mapped onto its page and drawn
 *  solid; the operands it consumes (`removed`, from `boxes`) dashed; the
 *  first result named `label`. PURE. */
export function resultPreview(
  report: PreviewReport,
  boxes: readonly OperandBox[],
  label: string,
): Array<Record<string, unknown>> {
  const shapes: Array<Record<string, unknown>> = [];
  const gone = new Set(report.removed.map(key));
  for (const b of boxes) if (gone.has(key(b.id))) shapes.push(boxPath(b, true));
  let named = false;
  for (const o of report.outlines) {
    if (!o.pageId) continue;
    const starts = o.subpathStarts.length ? o.subpathStarts : [0];
    starts.forEach((start, k) => {
      const end = starts[k + 1] ?? o.anchors.length;
      const anchors = o.anchors.slice(start, end).map((a) => ({
        anchor: apply(o.itemTransform, a.anchor),
        left: apply(o.itemTransform, a.left),
        right: apply(o.itemTransform, a.right),
      }));
      if (anchors.length < 2) return;
      shapes.push({
        pageId: o.pageId,
        anchors,
        close: !(o.subpathOpen[k] ?? false),
        dashed: false,
      });
      if (!named) {
        named = true;
        const top = anchors.reduce(
          (p, a) => (a.anchor[1] < p[1] ? a.anchor : p),
          anchors[0]!.anchor,
        );
        shapes.push({
          kind: "text",
          pageId: o.pageId,
          x: Math.min(...anchors.map((a) => a.anchor[0])),
          y: top[1] - 4,
          text: label,
          size: 11,
          background: true,
        });
      }
    });
  }
  return shapes;
}
