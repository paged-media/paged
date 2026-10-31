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

import type { SnapLine } from "@paged-media/client";
import { formatLength } from "@paged-media/ui";

import type {
  OverlayContribution,
  OverlayPageRect,
  OverlayProps,
} from "../registries/overlay";
import { useOptionalOverlaySignals } from "../state/overlay-signals-context";
import { useViewPreferences } from "../state/view-preferences";

const STROKE = "var(--overlay-snap)";
/** Label text size and end-tick length, screen px. */
const LABEL_PX = 10;
const TICK_PX = 4;

/** A label at `at` (document space), drawn upright-ish at a fixed screen
 *  size whatever the zoom. */
function Label(props: { at: [number, number]; text: string; inv: number }) {
  const size = LABEL_PX * props.inv;
  return (
    <text
      x={props.at[0]}
      y={props.at[1] - 3 * props.inv}
      fontSize={size}
      textAnchor="middle"
      fill={STROKE}
      stroke="var(--overlay-label-halo, white)"
      strokeWidth={2.5 * props.inv}
      paintOrder="stroke"
      data-snap-label=""
    >
      {props.text}
    </text>
  );
}

function at(
  pr: OverlayPageRect,
  p: readonly [number, number],
): [number, number] {
  return [pr.x + p[0], pr.y + p[1]];
}

/** Two ticks across the segment `a` → `b` at its ends. */
function endTicks(a: [number, number], b: [number, number], inv: number) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = (-(b[1] - a[1]) / len) * TICK_PX * inv;
  const ny = ((b[0] - a[0]) / len) * TICK_PX * inv;
  return [a, b].map((p, i) => (
    <line
      key={i}
      x1={p[0] - nx}
      y1={p[1] - ny}
      x2={p[0] + nx}
      y2={p[1] + ny}
      stroke={STROKE}
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  ));
}

/** One line of the engine's snap reply (v77 shape, editor ADR 287). */
function SnapLineShape(props: {
  line: SnapLine;
  pr: OverlayPageRect;
  inv: number;
  labels: boolean;
}) {
  const { line: l, pr, inv, labels } = props;
  const common = {
    stroke: STROKE,
    strokeWidth: 1,
    vectorEffect: "non-scaling-stroke" as const,
    pointerEvents: "none" as const,
  };
  const kind = l.kind ?? "alignment";
  if (l.from && l.to) {
    const a = at(pr, l.from);
    const b = at(pr, l.to);
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // A gap shows its two ends as ticks across it.
    const ticks = kind === "spacing" ? endTicks(a, b, inv) : null;
    let text: string | null = null;
    if (labels && kind === "angle" && l.angle != null) {
      text = `${Math.round(l.angle * 10) / 10}°`;
    } else if (labels && l.distance != null && l.distance > 0.01) {
      text = formatLength(l.distance);
    }
    return (
      <g data-snap-kind={kind}>
        <line
          x1={a[0]}
          y1={a[1]}
          x2={b[0]}
          y2={b[1]}
          {...common}
          strokeDasharray={
            kind === "angle" ? `${4 * inv} ${3 * inv}` : undefined
          }
        />
        {ticks}
        {text && <Label at={mid} text={text} inv={inv} />}
      </g>
    );
  }
  if (l.axis === "x") {
    return (
      <line
        data-snap-kind={kind}
        x1={pr.x + l.position}
        y1={pr.y}
        x2={pr.x + l.position}
        y2={pr.y + pr.h}
        {...common}
      />
    );
  }
  return (
    <line
      data-snap-kind={kind}
      x1={pr.x}
      y1={pr.y + l.position}
      x2={pr.x + pr.w}
      y2={pr.y + l.position}
      {...common}
    />
  );
}

/**
 * Active snap guides — magenta 1pt non-scaling-stroke lines. An alignment
 * line spans its page; a smart guide the engine gave an extent (`from` →
 * `to`, v77) runs between the point it came through and the snapped
 * point; an equal-spacing gap shows as a ticked segment and an angle guide
 * as a dashed one. With measurement labels on (Guides & Grid
 * preferences) each carries its distance or angle in the document unit.
 * Drawn high in the z-order so they sit above selection chrome during a
 * drag.
 */
function SnapLinesRender(props: OverlayProps) {
  const signals = useOptionalOverlaySignals();
  const prefs = useViewPreferences();
  const lines = signals?.snapLines ?? [];
  if (lines.length === 0) return null;
  const inv = 1 / (props.camera.scale || 1);
  return (
    <>
      {lines.map((l, i) => {
        const pr = props.pageRects.get(l.pageId);
        if (!pr) return null;
        return (
          <SnapLineShape
            key={i}
            line={l}
            pr={pr}
            inv={inv}
            labels={prefs.measurementLabels}
          />
        );
      })}
    </>
  );
}

export const snapLinesContribution: OverlayContribution = {
  id: "paged.snap-lines",
  render: SnapLinesRender,
  z: 500,
};
