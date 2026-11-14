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

// The Typography Debugger on the canvas (editor ADR 1227): with View ▸
// Typography debugger on, every composed line of the selected story is
// tinted by how tightly it is set (the engine's evidence, engine ADR
// 1308), a hyphen or a forced break is marked at the line's end, and the
// marker at the end of every line says, on hover, why the line broke
// there. Diagnostic chrome: hidden in Proof view, never printed. With the
// view off it reads nothing.

import { useSyncExternalStore } from "react";

import {
  getViewToggle,
  subscribeViewToggles,
  useEditorScope,
  type OverlayContribution,
  type OverlayProps,
} from "@paged-media/shell";
import { useStrings } from "@paged-media/strings";

import {
  spacingFacts,
  tightnessColour,
  tightnessLabel,
  useLineEvidence,
  useTypographyTarget,
  whyThisBreak,
} from "../typography-evidence";

function TypographyRender(props: OverlayProps) {
  const scope = useEditorScope();
  const on = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "typography"),
    () => false,
  );
  if (!on) return null;
  return <TypographyLines {...props} />;
}

function TypographyLines(props: OverlayProps) {
  const strings = useStrings();
  const target = useTypographyTarget();
  const report = useLineEvidence(target?.storyId ?? null);
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  if (!report || !report.found) return null;
  const inv = 1 / props.camera.scale;
  const bands = new Map(
    report.paragraphs.map((p) => [p.paragraph, p.wordSpacing] as const),
  );
  return (
    <g data-typography-overlay={report.storyId} pointerEvents="none">
      {report.lines.map((line) => {
        const pr = props.pageRects.get(line.pageId as never);
        if (!pr) return null;
        const colour = tightnessColour(line.tightness);
        const x = pr.x + line.left;
        const y = pr.y + line.top;
        const w = Math.max(0, line.right - line.left);
        const h = Math.max(0, line.bottom - line.top);
        const endX = pr.x + line.right;
        const baseY = pr.y + line.baseline;
        const why = [
          `${tightnessLabel(line.tightness) ? t(tightnessLabel(line.tightness)) : ""}`,
          ...whyThisBreak(line, t),
          ...spacingFacts(line, bands.get(line.paragraph), t),
        ]
          .filter(Boolean)
          .join("\n");
        const hyphen =
          line.breakKind === "hyphen" ||
          line.breakKind === "discretionaryHyphen";
        return (
          <g
            key={`${line.paragraph}:${line.line}:${line.pageId}`}
            data-typography-line={`${line.paragraph}:${line.line}`}
            data-tightness={line.tightness}
            data-break={line.breakKind}
          >
            {colour ? (
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill={colour}
                fillOpacity={0.18}
                stroke={colour}
                strokeOpacity={0.6}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <g
              transform={`translate(${endX}, ${baseY}) scale(${inv})`}
              style={{ pointerEvents: "all", cursor: "help" }}
              data-typography-why={line.breakKind}
            >
              <title>{why}</title>
              {hyphen ? (
                <path
                  d="M 2 -7 L 8 -7 L 5 -2 Z"
                  fill="var(--overlay-selection)"
                  data-typography-hyphen
                />
              ) : line.breakKind === "forcedLineBreak" ? (
                <text
                  x={3}
                  y={-1}
                  fontSize={9}
                  fill="var(--overlay-guide)"
                  fontFamily="var(--font-sans)"
                >
                  ¬
                </text>
              ) : null}
              <circle
                cx={line.oversetAfter ? 12 : 4}
                cy={-3}
                r={2.5}
                fill={
                  line.oversetAfter
                    ? "var(--status-error)"
                    : (colour ?? "var(--overlay-guide)")
                }
                fillOpacity={0.85}
              />
            </g>
          </g>
        );
      })}
    </g>
  );
}

export const typographyOverlayContribution: OverlayContribution = {
  id: "paged.overlay.typography",
  render: TypographyRender,
  // Over the frame edges (45) and the issue markers (62), under the
  // selection chrome (200) and the caret (600).
  z: 64,
};
