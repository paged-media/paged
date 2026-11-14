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

// Whether each design constraint holds (editor ADR 1233). PURE and
// deterministic: the same document facts give the same answer, to the
// hundredth of a point, whatever the zoom, the order of the reads or the
// time. The answer carries what was measured, the boxes it was measured on
// (the canvas glyphs draw them) and, where a constraint does not hold, the
// fix that would make it hold — as a plan of moves the user may preview and
// apply. Evaluating never changes the document: there is no solver.

import type { ElementId } from "@paged-media/client";

import {
  DEFAULT_TOLERANCE_PT,
  memberKey,
  type AlignEdge,
  type Constraint,
  type MarginEdge,
} from "./model";

/** A page item's box, page-local pt: `[x, y, w, h]`, axis-aligned. */
export type Box = readonly [number, number, number, number];

/** What the evaluation knows of one member. */
export interface MemberFacts {
  pageId: string | null;
  box: Box;
  /** A text frame's lines in this frame; null when unread. */
  lines?: number | null;
  /** The page-local y of the foot of its first line; null when unread. */
  firstLineFoot?: number | null;
  /** Its story runs over the end of its last frame. */
  overset?: boolean | null;
}

/** What the evaluation knows of one page. */
export interface PageFacts {
  id: string;
  index: number;
  size: readonly [number, number];
  margins: { top: number; left: number; bottom: number; right: number };
  /** The spine's side: `right` on a verso, `left` on a recto or a single
   *  page (`PageSummary.bindingEdge`). */
  bindingEdge?: "left" | "right";
}

export interface DocumentFacts {
  /** By `memberKey`. A member absent here is gone from the document. */
  members: ReadonlyMap<string, MemberFacts>;
  pages: ReadonlyMap<string, PageFacts>;
}

export type ConstraintStatus = "holds" | "broken" | "unknown";

/** Why a constraint could not be measured. */
export type UnknownReason =
  "missing-member" | "no-page" | "different-pages" | "not-text" | "unread";

export type Measure =
  | { kind: "align"; edge: AlignEdge; offsets: number[]; worst: number }
  | {
      kind: "equal-spacing";
      gaps: number[];
      min: number;
      max: number;
      target: number;
    }
  | {
      kind: "min-gap";
      gap: number;
      required: number;
      axis: "horizontal" | "vertical";
    }
  | { kind: "max-lines"; lines: number; max: number; overset: boolean }
  | { kind: "fits"; overset: boolean }
  | {
      kind: "margin";
      margin: MarginEdge;
      side: "left" | "right" | "top" | "bottom";
      offsets: number[];
      worst: number;
    };

/** One move of a fix, in page-local pt (a translation: spread space and
 *  page space agree on it). */
export interface Move {
  member: ElementId;
  dx: number;
  dy: number;
}

/** A suggested fix: moves (each member's box where it would land), or the
 *  overset fix (Expand frame, planned when it is shown), or none the
 *  editor can make (the text has to change). */
export type FixPlan =
  | {
      kind: "move";
      moves: Move[];
      ghosts: Array<{ pageId: string; box: Box }>;
    }
  | { kind: "expand-frame"; member: ElementId }
  | { kind: "edit-text"; member: ElementId };

export interface ConstraintResult {
  id: string;
  status: ConstraintStatus;
  measure: Measure | null;
  reason?: UnknownReason;
  /** The members' boxes, in member order (null for one that is gone). */
  boxes: Array<{ pageId: string; box: Box } | null>;
  /** The page the constraint stands on (its first member's). */
  pageId: string | null;
  fix: FixPlan | null;
}

const round = (n: number): number => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

function edgeValue(box: Box, edge: Exclude<AlignEdge, "baseline">): number {
  const [x, y, w, h] = box;
  switch (edge) {
    case "left":
      return x;
    case "right":
      return x + w;
    case "top":
      return y;
    case "bottom":
      return y + h;
    case "centerX":
      return x + w / 2;
    case "centerY":
      return y + h / 2;
  }
}

const horizontalEdge = (edge: AlignEdge): boolean =>
  edge === "left" || edge === "right" || edge === "centerX";

const moved = (box: Box, dx: number, dy: number): Box => [
  round(box[0] + dx),
  round(box[1] + dy),
  box[2],
  box[3],
];

function ghostsOf(
  moves: readonly Move[],
  facts: readonly (MemberFacts | null)[],
  members: readonly ElementId[],
): Array<{ pageId: string; box: Box }> {
  const out: Array<{ pageId: string; box: Box }> = [];
  for (const m of moves) {
    const i = members.findIndex((x) => memberKey(x) === memberKey(m.member));
    const f = facts[i];
    if (f?.pageId)
      out.push({ pageId: f.pageId, box: moved(f.box, m.dx, m.dy) });
  }
  return out;
}

/** The physical side of a margin edge on `page`. */
export function marginSide(
  margin: MarginEdge,
  page: PageFacts,
): "left" | "right" | "top" | "bottom" {
  if (margin === "outer")
    return page.bindingEdge === "right" ? "left" : "right";
  if (margin === "inner")
    return page.bindingEdge === "right" ? "right" : "left";
  return margin;
}

/** Evaluate one constraint against the document's facts. */
export function evaluateConstraint(
  c: Constraint,
  doc: DocumentFacts,
): ConstraintResult {
  const facts = c.members.map((m) => doc.members.get(memberKey(m)) ?? null);
  const boxes = facts.map((f) =>
    f?.pageId ? { pageId: f.pageId, box: f.box } : null,
  );
  const pageId = facts[0]?.pageId ?? null;
  const base = { id: c.id, boxes, pageId };
  const unknown = (reason: UnknownReason): ConstraintResult => ({
    ...base,
    status: "unknown",
    measure: null,
    reason,
    fix: null,
  });
  if (facts.some((f) => f === null)) return unknown("missing-member");
  const present = facts as MemberFacts[];
  if (present.some((f) => !f.pageId)) return unknown("no-page");
  const tol = c.params.tolerance ?? DEFAULT_TOLERANCE_PT;
  const samePage = present.every((f) => f.pageId === present[0]!.pageId);

  switch (c.kind) {
    case "align": {
      const edge = c.params.edge!;
      let values: number[];
      if (edge === "baseline") {
        if (c.members.some((m) => m.kind !== "textFrame"))
          return unknown("not-text");
        if (present.some((f) => f.firstLineFoot == null))
          return unknown("unread");
        values = present.map((f) => f.firstLineFoot!);
      } else values = present.map((f) => edgeValue(f.box, edge));
      const key = values[0]!;
      const offsets = values.map((v) => round(v - key));
      const worst = Math.max(...offsets.map(Math.abs));
      const holds = worst <= tol;
      const moves: Move[] = holds
        ? []
        : c.members.slice(1).flatMap((member, j) => {
            const d = round(key - values[j + 1]!);
            if (Math.abs(d) <= tol) return [];
            return horizontalEdge(edge)
              ? [{ member, dx: d, dy: 0 }]
              : [{ member, dx: 0, dy: d }];
          });
      return {
        ...base,
        status: holds ? "holds" : "broken",
        measure: { kind: "align", edge, offsets, worst: round(worst) },
        fix: holds
          ? null
          : {
              kind: "move",
              moves,
              ghosts: ghostsOf(moves, present, c.members),
            },
      };
    }
    case "equal-spacing": {
      if (!samePage) return unknown("different-pages");
      const horizontal = c.params.axis === "horizontal";
      const start = (b: Box) => (horizontal ? b[0] : b[1]);
      const size = (b: Box) => (horizontal ? b[2] : b[3]);
      const order = present
        .map((f, i) => ({ f, i }))
        .sort((a, b) => start(a.f.box) - start(b.f.box) || a.i - b.i);
      const gaps: number[] = [];
      for (let k = 1; k < order.length; k++) {
        const prev = order[k - 1]!.f.box;
        gaps.push(round(start(order[k]!.f.box) - (start(prev) + size(prev))));
      }
      const min = Math.min(...gaps);
      const max = Math.max(...gaps);
      const first = order[0]!.f.box;
      const last = order.at(-1)!.f.box;
      const span = start(last) + size(last) - start(first);
      const sizes = order.reduce((n, o) => n + size(o.f.box), 0);
      const target = round((span - sizes) / (order.length - 1));
      const holds = max - min <= tol;
      const moves: Move[] = [];
      if (!holds) {
        let at = start(first) + size(first) + target;
        for (let k = 1; k < order.length - 1; k++) {
          const o = order[k]!;
          const d = round(at - start(o.f.box));
          if (Math.abs(d) > tol / 2)
            moves.push(
              horizontal
                ? { member: c.members[o.i]!, dx: d, dy: 0 }
                : { member: c.members[o.i]!, dx: 0, dy: d },
            );
          at += size(o.f.box) + target;
        }
      }
      return {
        ...base,
        status: holds ? "holds" : "broken",
        measure: {
          kind: "equal-spacing",
          gaps,
          min: round(min),
          max: round(max),
          target,
        },
        fix: holds
          ? null
          : {
              kind: "move",
              moves,
              ghosts: ghostsOf(moves, present, c.members),
            },
      };
    }
    case "min-gap": {
      if (!samePage) return unknown("different-pages");
      const [a, b] = present.map((f) => f.box) as [Box, Box];
      const dxRight = b[0] - (a[0] + a[2]);
      const dxLeft = a[0] - (b[0] + b[2]);
      const dyBelow = b[1] - (a[1] + a[3]);
      const dyAbove = a[1] - (b[1] + b[3]);
      const dx = Math.max(dxRight, dxLeft);
      const dy = Math.max(dyBelow, dyAbove);
      const axis = dx >= dy ? "horizontal" : "vertical";
      const gap = round(axis === "horizontal" ? dx : dy);
      const required = c.params.gap!;
      const holds = gap >= required - tol;
      let fix: FixPlan | null = null;
      if (!holds) {
        const short = round(required - gap);
        const sign =
          axis === "horizontal"
            ? dxRight >= dxLeft
              ? 1
              : -1
            : dyBelow >= dyAbove
              ? 1
              : -1;
        const move: Move =
          axis === "horizontal"
            ? { member: c.members[1]!, dx: sign * short, dy: 0 }
            : { member: c.members[1]!, dx: 0, dy: sign * short };
        fix = {
          kind: "move",
          moves: [move],
          ghosts: ghostsOf([move], present, c.members),
        };
      }
      return {
        ...base,
        status: holds ? "holds" : "broken",
        measure: { kind: "min-gap", gap, required, axis },
        fix,
      };
    }
    case "max-lines": {
      const m = c.members[0]!;
      if (m.kind !== "textFrame") return unknown("not-text");
      const f = present[0]!;
      if (f.lines == null) return unknown("unread");
      const max = c.params.lines!;
      const overset = f.overset === true;
      const holds = f.lines <= max && !overset;
      return {
        ...base,
        status: holds ? "holds" : "broken",
        measure: { kind: "max-lines", lines: f.lines, max, overset },
        // Fewer lines means other words or other type: the user's call.
        fix: holds ? null : { kind: "edit-text", member: m },
      };
    }
    case "fits": {
      const m = c.members[0]!;
      if (m.kind !== "textFrame") return unknown("not-text");
      const f = present[0]!;
      if (f.overset == null) return unknown("unread");
      const holds = !f.overset;
      return {
        ...base,
        status: holds ? "holds" : "broken",
        measure: { kind: "fits", overset: f.overset },
        fix: holds ? null : { kind: "expand-frame", member: m },
      };
    }
    case "margin": {
      const margin = c.params.margin!;
      const offsets: number[] = [];
      const moves: Move[] = [];
      let side: "left" | "right" | "top" | "bottom" = "left";
      for (let i = 0; i < present.length; i++) {
        const f = present[i]!;
        const page = doc.pages.get(f.pageId!);
        if (!page) return unknown("no-page");
        side = marginSide(margin, page);
        const [x, y, w, h] = f.box;
        const [pw, ph] = page.size;
        const line =
          side === "left"
            ? page.margins.left
            : side === "right"
              ? pw - page.margins.right
              : side === "top"
                ? page.margins.top
                : ph - page.margins.bottom;
        const value =
          side === "left"
            ? x
            : side === "right"
              ? x + w
              : side === "top"
                ? y
                : y + h;
        const d = round(line - value);
        offsets.push(round(value - line));
        if (Math.abs(d) > tol)
          moves.push(
            side === "left" || side === "right"
              ? { member: c.members[i]!, dx: d, dy: 0 }
              : { member: c.members[i]!, dx: 0, dy: d },
          );
      }
      const worst = round(Math.max(...offsets.map(Math.abs)));
      const holds = worst <= tol;
      return {
        ...base,
        status: holds ? "holds" : "broken",
        measure: { kind: "margin", margin, side, offsets, worst },
        fix: holds
          ? null
          : {
              kind: "move",
              moves,
              ghosts: ghostsOf(moves, present, c.members),
            },
      };
    }
  }
}

/** Evaluate every constraint, in the order given. */
export function evaluateConstraints(
  constraints: readonly Constraint[],
  doc: DocumentFacts,
): ConstraintResult[] {
  return constraints.map((c) => evaluateConstraint(c, doc));
}

/** The axis-aligned page-local box of an item from its geometry (its
 *  `[top, left, bottom, right]` through its transform). */
export function boxOfGeometry(
  bounds: readonly number[],
  transform: readonly number[] | null | undefined,
): Box {
  const [top, left, bottom, right] = bounds as [number, number, number, number];
  const [a, b, c, d, e, f] = (transform ?? [1, 0, 0, 1, 0, 0]) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const pts: Array<[number, number]> = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ].map(([x, y]) => [a * x! + c * y! + e, b * x! + d * y! + f]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [
    round(x0),
    round(y0),
    round(Math.max(...xs) - x0),
    round(Math.max(...ys) - y0),
  ];
}
