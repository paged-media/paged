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

// The chart data sheet (slide ADR 715): the frame surface of the
// `slideChart` edit context, over a chart frame while its data is edited,
// as PowerPoint's Edit Data opens the chart's workbook beside it. A grid of
// the chart's workbook: column letters and row numbers, the cells the chart
// reads tinted as PowerPoint tints them (series names, categories,
// values), sheet tabs when there is more than one, and the surface's full
// screen. Typing into a cell enters it into the workbook (paged.sheet's
// engine in the slide wasm: a number, a date, text, or `=` a formula); the
// chart is redrawn from the workbook when the user leaves.

import type { FrameSurfaceProps } from "@paged-media/plugin-api";
import { chrome, color, status } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { CHARTS } from "./messages.js";

export interface GridCell {
  row: number;
  col: number;
  text: string;
  input: string;
}

export interface GridSheet {
  name: string;
  rows: number;
  cols: number;
  cells: GridCell[];
  bound: [number, number, number, number][];
}

/** What the surface edits: the chart being edited and its workbook. */
export interface ChartEditSession {
  /** The open chart's grid, or null when no chart is being edited. */
  grid(): GridSheet[] | null;
  /** Enter a cell; answers false (and leaves the grid) when the workbook
   *  refused the input. */
  enter(sheet: string, row: number, col: number, input: string): boolean;
  subscribe(listener: () => void): () => void;
}

export function columnName(c: number): string {
  let s = "";
  let n = c;
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    if (n < 26) return s;
    n = Math.floor(n / 26) - 1;
  }
}

/** How a cell the chart reads is tinted, by what it is (PowerPoint's
 *  colours: names red, categories purple, values blue). */
export function boundTint(
  sheet: GridSheet,
  row: number,
  col: number,
): string | null {
  for (const [r0, c0, r1, c1] of sheet.bound) {
    if (row < r0 || row > r1 || col < c0 || col > c1) continue;
    if (r0 === r1 && c0 === c1) return "rgba(220, 60, 60, 0.18)";
    const firstCol = sheet.bound.every(([, bc0]) => c0 <= bc0);
    return firstCol && c0 === 0
      ? "rgba(140, 80, 200, 0.18)"
      : "rgba(50, 110, 220, 0.16)";
  }
  return null;
}

const CELL_W = 64;
const CELL_H = 18;
const HEAD_W = 30;
/** Below this box (pt) the sheet opens full screen. */
const MIN_W = 240;
const MIN_H = 140;

export function makeChartSurface(
  session: ChartEditSession,
  canFullScreen: () => boolean,
): React.ComponentType<FrameSurfaceProps> {
  // A declaration, so the React Compiler sees the component (it cannot
  // see `return function ChartSurface()`, editor ADR 229).
  function ChartSurface(props: FrameSurfaceProps) {
    const { t } = useStrings();
    const grid = React.useSyncExternalStore(
      session.subscribe,
      session.grid,
      session.grid,
    );
    const [tab, setTab] = React.useState(0);
    const [sel, setSel] = React.useState<[number, number]>([0, 0]);
    const [edit, setEdit] = React.useState<string | null>(null);
    const [refused, setRefused] = React.useState(false);
    const rootRef = React.useRef<HTMLDivElement>(null);
    const inputRef = React.useRef<HTMLInputElement>(null);
    // A double-click enters the chart on one of its shapes, so the
    // surface may sit over a single bar: then the data sheet opens full
    // screen, as PowerPoint opens it in a window of its own.
    const small =
      props.frameBoxPt.widthPt < MIN_W || props.frameBoxPt.heightPt < MIN_H;
    const { presentation, requestPresentation } = props;
    React.useEffect(() => {
      if (small && presentation === "frame" && canFullScreen())
        requestPresentation("fullscreen");
      rootRef.current?.focus();
    }, [small, presentation, requestPresentation]);
    const editing = edit !== null;
    React.useEffect(() => {
      if (editing) inputRef.current?.focus();
    }, [editing]);
    if (!grid || grid.length === 0) return null;
    const sheet = grid[Math.min(tab, grid.length - 1)]!;
    const rows = Math.max(sheet.rows + 1, 6);
    const cols = Math.max(sheet.cols + 1, 4);
    const at = new Map(sheet.cells.map((c) => [`${c.row}:${c.col}`, c]));
    const cellOf = (r: number, c: number) => at.get(`${r}:${c}`);
    const move = (dr: number, dc: number) =>
      setSel(([r, c]) => [
        Math.max(0, Math.min(rows - 1, r + dr)),
        Math.max(0, Math.min(cols - 1, c + dc)),
      ]);
    const commit = (dr: number, dc: number) => {
      if (edit === null) return;
      const ok = session.enter(sheet.name, sel[0], sel[1], edit);
      setRefused(!ok);
      if (!ok) return;
      setEdit(null);
      move(dr, dc);
      rootRef.current?.focus();
    };
    const onKey = (e: React.KeyboardEvent) => {
      if (edit !== null) {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.shiftKey ? -1 : 1, 0);
        } else if (e.key === "Tab") {
          e.preventDefault();
          commit(0, e.shiftKey ? -1 : 1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEdit(null);
          setRefused(false);
          rootRef.current?.focus();
        }
        return;
      }
      const arrows: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        Enter: [1, 0],
        Tab: [0, 1],
      };
      const step = arrows[e.key];
      if (step) {
        e.preventDefault();
        move(e.shiftKey ? -step[0] : step[0], e.shiftKey ? -step[1] : step[1]);
      } else if (e.key === "F2") {
        e.preventDefault();
        setEdit(cellOf(sel[0], sel[1])?.input ?? "");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        session.enter(sheet.name, sel[0], sel[1], "");
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (props.presentation === "fullscreen")
          props.requestPresentation("frame");
        else props.exit({ commit: true });
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setEdit(e.key);
      }
    };
    const head: React.CSSProperties = {
      background: chrome.panelBg,
      color: color.mutedFg,
      textAlign: "center",
      fontWeight: 500,
      position: "sticky",
    };
    return (
      <div
        ref={rootRef}
        tabIndex={0}
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
            padding: "2px 6px",
            borderBottom: `1px solid ${color.border}`,
          }}
        >
          <strong style={{ flex: 1 }}>{t(CHARTS.title)}</strong>
          {refused && (
            <span role="alert" style={{ color: status.error }}>
              {t(CHARTS.refused)}
            </span>
          )}
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
          <table
            style={{
              borderCollapse: "collapse",
              tableLayout: "fixed",
              width: HEAD_W + cols * CELL_W,
            }}
          >
            <thead>
              <tr style={{ height: CELL_H }}>
                <th style={{ ...head, width: HEAD_W, top: 0, left: 0 }} />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} style={{ ...head, width: CELL_W, top: 0 }}>
                    {columnName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, r) => (
                <tr key={r} style={{ height: CELL_H }}>
                  <th style={{ ...head, left: 0 }}>{r + 1}</th>
                  {Array.from({ length: cols }, (_, c) => {
                    const cell = cellOf(r, c);
                    const selected = sel[0] === r && sel[1] === c;
                    const numeric =
                      cell !== undefined &&
                      cell.text !== "" &&
                      !Number.isNaN(Number(cell.input));
                    return (
                      <td
                        key={c}
                        data-cell={`${columnName(c)}${r + 1}`}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          if (edit !== null) commit(0, 0);
                          setSel([r, c]);
                          rootRef.current?.focus();
                        }}
                        onDoubleClick={() => {
                          setSel([r, c]);
                          setEdit(cell?.input ?? "");
                        }}
                        style={{
                          border: `1px solid ${color.border}`,
                          background: boundTint(sheet, r, c) ?? undefined,
                          outline: selected
                            ? `2px solid ${color.primary}`
                            : undefined,
                          outlineOffset: -2,
                          padding: "0 3px",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textAlign: numeric ? "right" : "left",
                        }}
                      >
                        {selected && edit !== null ? (
                          <input
                            ref={inputRef}
                            aria-label={`${columnName(c)}${r + 1}`}
                            value={edit}
                            onChange={(e) => setEdit(e.target.value)}
                            style={{
                              width: "100%",
                              border: "none",
                              outline: "none",
                              font: "inherit",
                              background: "transparent",
                              color: "inherit",
                              padding: 0,
                            }}
                          />
                        ) : (
                          (cell?.text ?? "")
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {grid.length > 1 && (
          <div
            style={{
              display: "flex",
              gap: 2,
              borderTop: `1px solid ${color.border}`,
              padding: "1px 4px",
            }}
          >
            {grid.map((s, i) => (
              <button
                key={s.name}
                type="button"
                aria-pressed={i === tab}
                onClick={() => setTab(i)}
                style={{ fontWeight: i === tab ? 600 : 400 }}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return ChartSurface;
}
