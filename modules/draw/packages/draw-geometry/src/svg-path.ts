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

// SVG path `d` ⇄ the draw anchor model. The parser lowers every path
// command into the engine's cubic-Bezier vocabulary (`AnchorTriple`:
// on-curve anchor + incoming `left` / outgoing `right` handles; a corner
// collapses both handles onto the anchor — the IDML `PathPointType`
// semantics draw already speaks). Quadratics elevate to cubic; arcs are
// approximated via svg-arc.ts. The serializer is the inverse: anchor
// table → `M/L/C/Z`. Pure, host-free, dependency-light (a hand-rolled
// tokenizer — no regex-heavy DOM dep).

import type { AnchorTriple, AnchorTable, Vec2, Vec2Mut } from "./types";
import { arcToCubics } from "./svg-arc";

// ----------------------------------------------------------- tokenizer

/** A scanned `d`: command letters interleaved with their number runs.
 *  We tokenize into a flat stream of `{ cmd?, num? }` then group. */
type Token = { kind: "cmd"; value: string } | { kind: "num"; value: number };

const COMMANDS = new Set("MmLlHhVvCcSsQqTtAaZz");

/**
 * Tokenize a `d` string. Handles SVG number grammar: leading sign,
 * decimals, exponents, implicit separators (a sign or `.` after digits
 * starts a new number — `1.5.5` is `1.5` then `.5`; `-1-2` is two
 * numbers). Whitespace and commas are separators.
 */
function tokenize(d: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = d.length;
  const isDigit = (c: string) => c >= "0" && c <= "9";
  while (i < n) {
    const c = d[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (COMMANDS.has(c)) {
      out.push({ kind: "cmd", value: c });
      i++;
      continue;
    }
    // Parse a number: [sign] digits [. digits] [e[sign]digits], or
    // [sign] . digits.
    const start = i;
    if (c === "+" || c === "-") i++;
    let sawDigit = false;
    while (i < n && isDigit(d[i])) {
      i++;
      sawDigit = true;
    }
    if (i < n && d[i] === ".") {
      i++;
      while (i < n && isDigit(d[i])) {
        i++;
        sawDigit = true;
      }
    }
    if (sawDigit && i < n && (d[i] === "e" || d[i] === "E")) {
      i++;
      if (i < n && (d[i] === "+" || d[i] === "-")) i++;
      while (i < n && isDigit(d[i])) i++;
    }
    if (!sawDigit) {
      // Unparseable char — skip it (lenient, never throw on junk).
      i = start + 1;
      continue;
    }
    out.push({ kind: "num", value: parseFloat(d.slice(start, i)) });
  }
  return out;
}

// ------------------------------------------------------------- builder
//
// We accumulate per-subpath cubic geometry as a list of on-curve points,
// each carrying its incoming/outgoing handle. A straight segment leaves
// both involved handles collapsed onto their anchors (the corner form).

interface PendingAnchor {
  anchor: Vec2Mut;
  left: Vec2Mut;
  right: Vec2Mut;
}

interface Subpath {
  pts: PendingAnchor[];
  open: boolean;
}

const corner = (p: Vec2): PendingAnchor => ({
  anchor: [p[0], p[1]],
  left: [p[0], p[1]],
  right: [p[0], p[1]],
});

/**
 * Parse an SVG path `d` string into an `AnchorTable` (one or more
 * subpaths flattened into the engine's anchor model).
 *
 * Supported commands (absolute UPPER + relative lower): M/m, L/l, H/h,
 * V/v, C/c, S/s, Q/q, T/t, A/a, Z/z. Implicit lineto after a moveto
 * (extra coordinate pairs following an `M`) is honored. An empty / all-
 * junk string yields an empty table.
 */
export function parsePathData(d: string): AnchorTable {
  const tokens = tokenize(d);
  const subpaths: Subpath[] = [];
  let cur: Subpath | null = null;

  // Current point + the subpath start (for Z). cx/cy track the pen.
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // Reflection state for S/T: the previous command's last control point
  // and the command family it belonged to.
  let prevCubicCtrl: Vec2 | null = null;
  let prevQuadCtrl: Vec2 | null = null;

  let ti = 0;
  const num = (): number => {
    const t = tokens[ti++];
    return t && t.kind === "num" ? t.value : 0;
  };
  const hasNum = (): boolean => {
    const t = tokens[ti];
    return !!t && t.kind === "num";
  };

  const ensureSub = (): Subpath => {
    if (!cur) {
      cur = { pts: [corner([cx, cy])], open: true };
      subpaths.push(cur);
    }
    return cur;
  };

  // Set the outgoing handle of the last anchor in the current subpath.
  const setRight = (h: Vec2) => {
    const s = ensureSub();
    s.pts[s.pts.length - 1].right = [h[0], h[1]];
  };
  // Push a new anchor (its left handle given), advancing the pen.
  const pushAnchor = (a: Vec2, left: Vec2) => {
    const s = ensureSub();
    s.pts.push({
      anchor: [a[0], a[1]],
      left: [left[0], left[1]],
      right: [a[0], a[1]],
    });
    cx = a[0];
    cy = a[1];
  };

  while (ti < tokens.length) {
    const tk = tokens[ti];
    if (tk.kind !== "cmd") {
      // A stray number with no active command — bail (lenient).
      ti++;
      continue;
    }
    const cmd = tk.value;
    ti++;
    const rel = cmd >= "a" && cmd <= "z";
    const up = cmd.toUpperCase();

    switch (up) {
      case "M": {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        // Start a fresh subpath.
        cur = { pts: [corner([x, y])], open: true };
        subpaths.push(cur);
        cx = x;
        cy = y;
        startX = x;
        startY = y;
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        // Implicit lineto for subsequent coordinate pairs.
        while (hasNum()) {
          const lx = num() + (rel ? cx : 0);
          const ly = num() + (rel ? cy : 0);
          pushAnchor([lx, ly], [lx, ly]);
          prevCubicCtrl = null;
          prevQuadCtrl = null;
        }
        break;
      }
      case "L": {
        do {
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          pushAnchor([x, y], [x, y]);
          prevCubicCtrl = null;
          prevQuadCtrl = null;
        } while (hasNum());
        break;
      }
      case "H": {
        do {
          const x = num() + (rel ? cx : 0);
          pushAnchor([x, cy], [x, cy]);
          prevCubicCtrl = null;
          prevQuadCtrl = null;
        } while (hasNum());
        break;
      }
      case "V": {
        do {
          const y = num() + (rel ? cy : 0);
          pushAnchor([cx, y], [cx, y]);
          prevCubicCtrl = null;
          prevQuadCtrl = null;
        } while (hasNum());
        break;
      }
      case "C": {
        do {
          const c1x = num() + (rel ? cx : 0);
          const c1y = num() + (rel ? cy : 0);
          const c2x = num() + (rel ? cx : 0);
          const c2y = num() + (rel ? cy : 0);
          const ex = num() + (rel ? cx : 0);
          const ey = num() + (rel ? cy : 0);
          setRight([c1x, c1y]);
          pushAnchor([ex, ey], [c2x, c2y]);
          prevCubicCtrl = [c2x, c2y];
          prevQuadCtrl = null;
        } while (hasNum());
        break;
      }
      case "S": {
        do {
          // First control = reflection of the previous cubic's 2nd
          // control about the current point (else the current point).
          const c1: Vec2 =
            prevCubicCtrl !== null
              ? [2 * cx - prevCubicCtrl[0], 2 * cy - prevCubicCtrl[1]]
              : [cx, cy];
          const c2x = num() + (rel ? cx : 0);
          const c2y = num() + (rel ? cy : 0);
          const ex = num() + (rel ? cx : 0);
          const ey = num() + (rel ? cy : 0);
          setRight(c1);
          pushAnchor([ex, ey], [c2x, c2y]);
          prevCubicCtrl = [c2x, c2y];
          prevQuadCtrl = null;
        } while (hasNum());
        break;
      }
      case "Q": {
        do {
          const qx = num() + (rel ? cx : 0);
          const qy = num() + (rel ? cy : 0);
          const ex = num() + (rel ? cx : 0);
          const ey = num() + (rel ? cy : 0);
          const { right, left } = quadToCubic([cx, cy], [qx, qy], [ex, ey]);
          setRight(right);
          pushAnchor([ex, ey], left);
          prevQuadCtrl = [qx, qy];
          prevCubicCtrl = null;
        } while (hasNum());
        break;
      }
      case "T": {
        do {
          // Reflected quadratic control point.
          const q: Vec2 =
            prevQuadCtrl !== null
              ? [2 * cx - prevQuadCtrl[0], 2 * cy - prevQuadCtrl[1]]
              : [cx, cy];
          const ex = num() + (rel ? cx : 0);
          const ey = num() + (rel ? cy : 0);
          const { right, left } = quadToCubic([cx, cy], q, [ex, ey]);
          setRight(right);
          pushAnchor([ex, ey], left);
          prevQuadCtrl = [q[0], q[1]];
          prevCubicCtrl = null;
        } while (hasNum());
        break;
      }
      case "A": {
        do {
          const rx = num();
          const ry = num();
          const rot = num();
          const large = num() !== 0;
          const sweep = num() !== 0;
          const ex = num() + (rel ? cx : 0);
          const ey = num() + (rel ? cy : 0);
          const cubics = arcToCubics(
            [cx, cy],
            rx,
            ry,
            rot,
            large,
            sweep,
            [ex, ey],
          );
          if (cubics.length === 0) {
            // Coincident endpoints: nothing to add.
          } else {
            for (const seg of cubics) {
              setRight(seg.c1);
              pushAnchor(seg.end, seg.c2);
            }
          }
          prevCubicCtrl = null;
          prevQuadCtrl = null;
        } while (hasNum());
        break;
      }
      case "Z": {
        if (cur) {
          cur.open = false;
          // Fold a trailing anchor that merely restates the start (a
          // closed contour's last segment returns to start; the engine
          // closes last→start implicitly, so the explicit return anchor
          // is redundant). A STRAIGHT return is dropped outright; a
          // CURVED return (the closing `C` of an exported ellipse) folds
          // its incoming handle onto the start anchor's `left` so the
          // closing curve is preserved without a duplicate point.
          const s = cur;
          if (s.pts.length > 1) {
            const last = s.pts[s.pts.length - 1];
            if (last.anchor[0] === startX && last.anchor[1] === startY) {
              const first = s.pts[0];
              const incomingCurved =
                last.left[0] !== last.anchor[0] ||
                last.left[1] !== last.anchor[1];
              if (incomingCurved) {
                first.left = [last.left[0], last.left[1]];
              }
              s.pts.pop();
            }
          }
          cx = startX;
          cy = startY;
        }
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        // A following command without an explicit M continues from the
        // start point but in a NEW subpath (per spec). Clearing `cur`
        // makes ensureSub start one at the current point if needed.
        cur = null;
        break;
      }
      default:
        // Unknown command (shouldn't happen — tokenizer only emits
        // known letters). Skip.
        break;
    }
  }

  return toAnchorTable(subpaths);
}

/** Elevate a quadratic (start, control, end) to a cubic — returns the
 *  two cubic control points (`right` = start's outgoing, `left` = end's
 *  incoming). Standard degree elevation: cᵢ = pₙ + ⅔(q − pₙ). */
export function quadToCubic(
  start: Vec2,
  ctrl: Vec2,
  end: Vec2,
): { right: Vec2Mut; left: Vec2Mut } {
  return {
    right: [
      start[0] + (2 / 3) * (ctrl[0] - start[0]),
      start[1] + (2 / 3) * (ctrl[1] - start[1]),
    ],
    left: [
      end[0] + (2 / 3) * (ctrl[0] - end[0]),
      end[1] + (2 / 3) * (ctrl[1] - end[1]),
    ],
  };
}

function toAnchorTable(subpaths: Subpath[]): AnchorTable {
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  const subpathOpen: boolean[] = [];
  for (const sp of subpaths) {
    if (sp.pts.length === 0) continue;
    subpathStarts.push(anchors.length);
    subpathOpen.push(sp.open);
    for (const p of sp.pts) {
      anchors.push({
        anchor: [p.anchor[0], p.anchor[1]],
        left: [p.left[0], p.left[1]],
        right: [p.right[0], p.right[1]],
      });
    }
  }
  return { anchors, subpathStarts, subpathOpen };
}

// ---------------------------------------------------------- serializer

/** Round to `precision` decimals, trimming trailing zeros (`1.50` →
 *  `1.5`, `2.0` → `2`). */
function fmt(n: number, precision: number): string {
  if (!Number.isFinite(n)) return "0";
  // Avoid "-0".
  const r = Number(n.toFixed(precision));
  const s = (Object.is(r, -0) ? 0 : r).toString();
  return s;
}

/**
 * Serialize an `AnchorTable` back to an SVG path `d` string. Emits `M`
 * at each subpath start, then per segment a straight `L` (both bounding
 * handles collapsed) or a cubic `C`; a closed subpath ends with `Z`.
 * Coordinates are rounded to `precision` decimals (default 3).
 */
export function serializePathData(
  table: AnchorTable,
  precision = 3,
): string {
  const { anchors, subpathStarts } = table;
  if (anchors.length === 0) return "";
  const open = table.subpathOpen ?? [];
  const f = (n: number) => fmt(n, precision);
  const parts: string[] = [];
  const starts = subpathStarts.length > 0 ? subpathStarts : [0];

  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : anchors.length;
    if (end <= begin) continue;
    const isOpen = open[s] ?? false;
    const first = anchors[begin];
    parts.push(`M ${f(first.anchor[0])} ${f(first.anchor[1])}`);

    const span = end - begin;
    const segCount = isOpen ? span - 1 : span;
    for (let i = 0; i < segCount; i++) {
      const a = anchors[begin + i];
      const b = anchors[begin + ((i + 1) % span)];
      const straight = handlesStraight(a, b);
      // The closing segment of a CLOSED subpath (last anchor → start)
      // is implied by `Z` when it's a straight return — emit nothing,
      // else `Z` would draw it twice. A curved closing segment must be
      // emitted explicitly (`Z` then closes the trailing gap, if any).
      const isClosingSeg = !isOpen && i === segCount - 1;
      if (isClosingSeg && straight) continue;
      if (straight) {
        parts.push(`L ${f(b.anchor[0])} ${f(b.anchor[1])}`);
      } else {
        parts.push(
          `C ${f(a.right[0])} ${f(a.right[1])} ${f(b.left[0])} ${f(
            b.left[1],
          )} ${f(b.anchor[0])} ${f(b.anchor[1])}`,
        );
      }
    }
    if (!isOpen) parts.push("Z");
  }
  return parts.join(" ");
}

// A segment is straight iff BOTH the outgoing handle of `a` and the
// incoming handle of `b` are collapsed onto their anchors.
const handlesStraight = (a: AnchorTriple, b: AnchorTriple): boolean =>
  a.right[0] === a.anchor[0] &&
  a.right[1] === a.anchor[1] &&
  b.left[0] === b.anchor[0] &&
  b.left[1] === b.anchor[1];
