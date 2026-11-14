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

// The design constraints on the canvas (editor ADR 1233): subtle glyphs
// where each constraint stands — a hairline along the edge an alignment
// keeps, an equals sign in each gap of an even spacing, a bracket across a
// minimum gap, a small tag on a frame's lines or fit, a tick from an edge
// to its margin — faint while it holds, in the review colour while it does
// not. An editing aid (View ▸ Editing aids ▸ Design constraints): never
// printed, hidden in Proof view, drawn by the overlay host's one rule.
//
// And the fix preview: while a suggested fix has the pointer or the focus,
// dashed boxes show where it would move what it moves. Gesture feedback,
// not document state: nothing is sent to the engine until the fix runs.

import type { OverlayContribution, OverlayProps } from "@paged-media/shell";

import type { Box, ConstraintResult } from "./evaluate";
import type { Constraint } from "./model";
import { useConstraintState, useFixPreview } from "./store";

const HOLDS = "var(--overlay-guide, #8b5cf6)";
const BROKEN = "var(--status-review)";
const UNKNOWN = "var(--pg-muted-fg)";

type Rect = { x: number; y: number; w: number; h: number };

function onPage(
  props: OverlayProps,
  at: { pageId: string; box: Box } | null,
): Rect | null {
  if (!at) return null;
  const pr = props.pageRects.get(at.pageId as never);
  if (!pr) return null;
  return {
    x: pr.x + at.box[0],
    y: pr.y + at.box[1],
    w: at.box[2],
    h: at.box[3],
  };
}

function Glyph({
  c,
  r,
  props,
}: {
  c: Constraint;
  r: ConstraintResult;
  props: OverlayProps;
}) {
  const px = 1 / props.camera.scale;
  const stroke =
    r.status === "holds" ? HOLDS : r.status === "broken" ? BROKEN : UNKNOWN;
  const rects = r.boxes.map((b) => onPage(props, b));
  const present = rects.filter((x): x is Rect => x !== null);
  if (present.length === 0) return null;
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    key: string,
  ) => (
    <line
      key={key}
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={stroke}
      strokeWidth={px}
      strokeDasharray={`${3 * px} ${2 * px}`}
      opacity={r.status === "holds" ? 0.55 : 0.9}
    />
  );
  const tag = (x: number, y: number, text: string) => (
    <g transform={`translate(${x}, ${y}) scale(${px})`}>
      <rect
        x={0}
        y={-12}
        width={7 * text.length + 8}
        height={12}
        rx={3}
        fill={stroke}
        opacity={r.status === "holds" ? 0.55 : 0.9}
      />
      <text
        x={4}
        y={-3}
        fontSize={9}
        fontFamily="var(--font-sans)"
        fill="white"
        pointerEvents="none"
      >
        {text}
      </text>
    </g>
  );
  const parts: React.ReactNode[] = [];
  switch (c.kind) {
    case "align": {
      const edge = c.params.edge!;
      const key = present[0]!;
      const minX = Math.min(...present.map((p) => p.x));
      const maxX = Math.max(...present.map((p) => p.x + p.w));
      const minY = Math.min(...present.map((p) => p.y));
      const maxY = Math.max(...present.map((p) => p.y + p.h));
      if (edge === "left" || edge === "right" || edge === "centerX") {
        const x =
          edge === "left"
            ? key.x
            : edge === "right"
              ? key.x + key.w
              : key.x + key.w / 2;
        parts.push(line(x, minY - 6 * px, x, maxY + 6 * px, "a"));
      } else if (edge === "baseline") {
        for (const [i, p] of present.entries())
          parts.push(
            line(
              p.x,
              p.y + p.h,
              p.x + Math.min(p.w, 24 * px),
              p.y + p.h,
              `b${i}`,
            ),
          );
      } else {
        const y =
          edge === "top"
            ? key.y
            : edge === "bottom"
              ? key.y + key.h
              : key.y + key.h / 2;
        parts.push(line(minX - 6 * px, y, maxX + 6 * px, y, "a"));
      }
      break;
    }
    case "equal-spacing": {
      const horizontal = c.params.axis === "horizontal";
      const sorted = [...present].sort((a, b) =>
        horizontal ? a.x - b.x : a.y - b.y,
      );
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        const cx = horizontal ? (a.x + a.w + b.x) / 2 : a.x + a.w / 2;
        const cy = horizontal ? a.y + a.h / 2 : (a.y + a.h + b.y) / 2;
        parts.push(
          line(cx - 4 * px, cy - 2 * px, cx + 4 * px, cy - 2 * px, `e${i}a`),
          line(cx - 4 * px, cy + 2 * px, cx + 4 * px, cy + 2 * px, `e${i}b`),
        );
      }
      break;
    }
    case "min-gap": {
      const [a, b] = present;
      if (!a || !b) break;
      const measure = r.measure?.kind === "min-gap" ? r.measure : null;
      if (measure?.axis === "vertical") {
        const top = a.y < b.y ? a : b;
        const bottom = top === a ? b : a;
        const x = Math.max(top.x, bottom.x) + 4 * px;
        parts.push(line(x, top.y + top.h, x, bottom.y, "g"));
      } else {
        const left = a.x < b.x ? a : b;
        const right = left === a ? b : a;
        const y = Math.max(left.y, right.y) + 4 * px;
        parts.push(line(left.x + left.w, y, right.x, y, "g"));
      }
      break;
    }
    case "max-lines": {
      const p = present[0]!;
      parts.push(<g key="t">{tag(p.x, p.y, `≤${c.params.lines}`)}</g>);
      break;
    }
    case "fits": {
      const p = present[0]!;
      parts.push(<g key="t">{tag(p.x, p.y + p.h + 14 * px, "fit")}</g>);
      break;
    }
    case "margin": {
      const m = r.measure?.kind === "margin" ? r.measure : null;
      for (const [i, p] of present.entries()) {
        const side = m?.side ?? "left";
        const offset = m?.offsets[i] ?? 0;
        if (side === "left" || side === "right") {
          const x = side === "left" ? p.x : p.x + p.w;
          parts.push(
            line(x, p.y + p.h / 2, x - offset, p.y + p.h / 2, `m${i}`),
          );
          parts.push(line(x - offset, p.y, x - offset, p.y + p.h, `n${i}`));
        } else {
          const y = side === "top" ? p.y : p.y + p.h;
          parts.push(
            line(p.x + p.w / 2, y, p.x + p.w / 2, y - offset, `m${i}`),
          );
          parts.push(line(p.x, y - offset, p.x + p.w, y - offset, `n${i}`));
        }
      }
      break;
    }
  }
  return (
    <g
      data-constraint-glyph={c.id}
      data-constraint-kind={c.kind}
      data-constraint-status={r.status}
    >
      <title>{c.kind}</title>
      {parts}
    </g>
  );
}

function ConstraintGlyphsRender(props: OverlayProps) {
  const { constraints, results } = useConstraintState();
  const shown = constraints.filter((c) => results.has(c.id));
  if (shown.length === 0) return null;
  return (
    <g data-constraint-glyphs="" pointerEvents="none">
      {shown.map((c) => (
        <Glyph key={c.id} c={c} r={results.get(c.id)!} props={props} />
      ))}
    </g>
  );
}

/** The glyphs: an editing aid, by the overlay host's rule. */
export const constraintGlyphsContribution: OverlayContribution = {
  id: "paged.overlay.constraints",
  render: ConstraintGlyphsRender,
  // With the aids, under the selection chrome (z 100).
  z: 58,
};

function FixPreviewRender(props: OverlayProps) {
  const preview = useFixPreview();
  if (!preview || preview.ghosts.length === 0) return null;
  const px = 1 / props.camera.scale;
  return (
    <g
      data-fix-preview={preview.id}
      data-gesture-preview=""
      pointerEvents="none"
    >
      {preview.ghosts.map((g, i) => {
        const r = onPage(props, g);
        if (!r) return null;
        return (
          <rect
            key={i}
            data-fix-ghost=""
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            fill="color-mix(in srgb, var(--overlay-selection) 10%, transparent)"
            stroke="var(--overlay-selection)"
            strokeWidth={1.5 * px}
            strokeDasharray={`${4 * px} ${3 * px}`}
          />
        );
      })}
    </g>
  );
}

/** Where a previewed fix would put what it moves. Above the selection. */
export const fixPreviewContribution: OverlayContribution = {
  id: "paged.overlay.fixPreview",
  render: FixPreviewRender,
  z: 104,
};
