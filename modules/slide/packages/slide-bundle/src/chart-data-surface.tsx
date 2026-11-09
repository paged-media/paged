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

// The chart data sheet (slide ADR 715, ADR 724 amendment 1): the frame
// surface of the `slideChart` edit context, over a chart frame while its
// data is edited, as PowerPoint's Edit Data opens the chart's workbook
// beside it. The sheet itself is paged.sheet's grid on the chart's
// workbook, opened through the workbook door (extensions ADR 1102); this
// file only frames it: a title, full screen, Done, and Esc to leave. The
// chart is redrawn from the workbook when the user leaves.

import type { FrameSurfaceProps } from "@paged-media/plugin-api";
import { chrome, color, status } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import type { ChartEditing } from "./charts.js";
import { CHARTS } from "./messages.js";

/** Below this box (pt) the sheet opens full screen. */
const MIN_W = 240;
const MIN_H = 140;
/** The title row's height (px). */
const HEAD_H = 24;

export function makeChartDataSurface(
  editing: Pick<ChartEditing, "session" | "problem" | "subscribe">,
  canFullScreen: () => boolean,
): React.ComponentType<FrameSurfaceProps> {
  // A declaration, so the React Compiler sees the component (it cannot see
  // `return function ChartDataSurface()`, editor ADR 229).
  function ChartDataSurface(props: FrameSurfaceProps) {
    const { t } = useStrings();
    const session = React.useSyncExternalStore(
      editing.subscribe,
      editing.session,
      editing.session,
    );
    const problem = React.useSyncExternalStore(
      editing.subscribe,
      editing.problem,
      editing.problem,
    );
    const rootRef = React.useRef<HTMLDivElement>(null);
    // A double-click enters the chart on one of its shapes, so the
    // surface may sit over a single bar: then the data sheet opens full
    // screen, as PowerPoint opens it in a window of its own.
    const small =
      props.frameBoxPt.widthPt < MIN_W || props.frameBoxPt.heightPt < MIN_H;
    const { presentation, requestPresentation } = props;
    React.useEffect(() => {
      if (small && presentation === "frame" && canFullScreen())
        requestPresentation("fullscreen");
    }, [small, presentation, requestPresentation]);
    // Keys go to the sheet from the start. Focused once per presentation,
    // not on every render: a host that hands a new `requestPresentation`
    // each render would otherwise pull focus out of the grid's cell editor
    // (its blur commits and closes it).
    React.useEffect(() => {
      rootRef.current?.focus();
    }, [presentation]);
    // Esc the grid did not take leaves full screen, then the chart (its
    // edits kept, as PowerPoint keeps them when its sheet closes).
    const onKey = (e: React.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (props.presentation === "fullscreen")
        props.requestPresentation("frame");
      else props.exit({ commit: true });
    };
    const Sheet = session?.Surface;
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        data-slide-chart-surface=""
        onKeyDown={onKey}
        style={{
          width: props.widthPt,
          height: props.heightPt,
          display: "flex",
          flexDirection: "column",
          background: color.bg,
          color: color.fg,
          font: "11px var(--font-sans)",
          border: `1px solid ${color.border}`,
          boxSizing: "border-box",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            height: HEAD_H,
            padding: "0 6px",
            background: chrome.panelBg,
            borderBottom: `1px solid ${color.border}`,
          }}
        >
          <strong style={{ flex: 1 }}>{t(CHARTS.title)}</strong>
          {canFullScreen() && !small && (
            <button
              type="button"
              onClick={() =>
                props.requestPresentation(
                  props.presentation === "fullscreen" ? "frame" : "fullscreen",
                )
              }
            >
              {props.presentation === "fullscreen"
                ? t(CHARTS.backToSlide)
                : t(CHARTS.fullScreen)}
            </button>
          )}
          <button
            type="button"
            data-slide-chart-done=""
            onClick={() => props.exit({ commit: true })}
          >
            {t(CHARTS.done)}
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
          {Sheet ? (
            <Sheet
              width={props.widthPt}
              height={Math.max(0, props.heightPt - HEAD_H)}
            />
          ) : problem ? (
            <p
              role="alert"
              data-slide-chart-problem={problem}
              style={{ margin: 8, color: status.error }}
            >
              {t(problem === "noEditor" ? CHARTS.noEditor : CHARTS.failed)}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  return ChartDataSurface;
}
