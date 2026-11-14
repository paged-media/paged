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

// Sheet ADR 532 — the first row of the frame surface's bar while the cells
// of a placed frame are edited (the UX strategy's §7.3, the UX audit's
// F-42): it says which mode this is ("Editing cells"), offers the way out
// ("Done", which leaves through the host's exit like Escape on a clean
// grid, so the frame stays selected and the camera stays), and answers the
// publishing question for the selection — whether the selected cells print
// in this frame, with a warning when rows or columns overflow it, and a
// preview card that draws how the selection lands in the frame.

import { useId, useState, type CSSProperties } from "react";

import { useStrings } from "@paged-media/strings";

import { SURFACE } from "../messages";
import type { CellBlock, PublicationPreview } from "../publication-preview";

/** Column letters of a 0-based column (`0` → `A`). */
function colName(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `B2:D9`, or `B2` for one cell. */
export function blockA1(b: CellBlock): string {
  const a = `${colName(b.left)}${b.top + 1}`;
  const z = `${colName(b.right)}${b.bottom + 1}`;
  return a === z ? a : `${a}:${z}`;
}

/** How many rows and columns of the selection do not print. */
export function notPrinted(p: PublicationPreview): number {
  return p.overflowRows + p.overflowCols + p.beforeRows + p.beforeCols;
}

export interface EditCellsStripProps {
  preview: PublicationPreview | null;
  /** Leave the context (the host's exit). */
  onDone(): void;
  /** Give the keys back to the grid after a press. */
  refocus(): void;
  /** The bar's card and button looks. */
  card: CSSProperties;
  button: CSSProperties;
}

export function EditCellsStrip({
  preview,
  onDone,
  refocus,
  card,
  button,
}: EditCellsStripProps) {
  const { t } = useStrings();
  const [open, setOpen] = useState(false);
  const missing = preview ? notPrinted(preview) : 0;
  return (
    <div style={{ position: "relative" }}>
      <div
        data-testid="sheet-bar-mode-strip"
        style={{ ...card, minWidth: 0, marginBottom: 4 }}
      >
        <span
          data-testid="sheet-bar-mode"
          title={t(SURFACE.modeHint)}
          style={{
            fontWeight: 600,
            color: "var(--pg-primary, #2b6cb0)",
            whiteSpace: "nowrap",
          }}
        >
          {t(SURFACE.mode)}
        </span>
        <span style={{ flex: 1 }} />
        {preview ? (
          <span
            data-testid="sheet-print-status"
            data-fits={preview.fits ? "true" : "false"}
            role="status"
            style={{
              whiteSpace: "nowrap",
              color: preview.fits
                ? "var(--pg-muted-fg, #5b5b57)"
                : "var(--pg-danger, #b42318)",
            }}
          >
            {preview.fits
              ? t(SURFACE.fits)
              : `⚠ ${t(SURFACE.overflowShort, { count: missing })}`}
          </span>
        ) : null}
        {preview ? (
          <button
            type="button"
            data-testid="sheet-print-preview-toggle"
            aria-pressed={open}
            aria-expanded={open}
            title={t(SURFACE.previewTitle)}
            style={{
              ...button,
              ...(open ? { background: "var(--pg-accent-bg, #e6eefc)" } : null),
            }}
            onClick={() => {
              setOpen(!open);
              refocus();
            }}
          >
            {t(SURFACE.preview)}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="sheet-bar-exit"
          title={t(SURFACE.doneTitle)}
          style={{ ...button, fontWeight: 600 }}
          onClick={onDone}
        >
          {t(SURFACE.done)}
        </button>
      </div>
      {open && preview ? <PrintPreviewCard preview={preview} /> : null}
    </div>
  );
}

/** Cells drawn at most per axis in the schematic. */
const MAX_TRACKS = 24;
/** One schematic cell, CSS px. */
const CELL_W = 14;
const CELL_H = 9;

/** The schematic of the selection over the frame's printed window: the
 *  frame's cells, the selected cells that print and those that do not. */
export function PrintPreviewCard({ preview }: { preview: PublicationPreview }) {
  const { t } = useStrings();
  // One pattern per card: two editors on a page keep their own.
  const hatch = `sheet-print-overflow-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const sel = preview.selection;
  const windows = preview.windows;
  // The drawn span: the frame's windows and the selection, clamped.
  const top = Math.min(sel.top, ...windows.map((w) => w.top));
  const left = Math.min(sel.left, ...windows.map((w) => w.left));
  const bottom = Math.min(
    Math.max(sel.bottom, ...windows.map((w) => w.bottom)),
    top + MAX_TRACKS - 1,
  );
  const right = Math.min(
    Math.max(sel.right, ...windows.map((w) => w.right)),
    left + MAX_TRACKS - 1,
  );
  const rows = bottom - top + 1;
  const cols = right - left + 1;
  const printed = (r: number, c: number) =>
    windows.some(
      (w) => r >= w.top && r <= w.bottom && c >= w.left && c <= w.right,
    );
  const cells: { r: number; c: number; kind: "prints" | "overflow" }[] = [];
  for (let r = Math.max(sel.top, top); r <= Math.min(sel.bottom, bottom); r++)
    for (let c = Math.max(sel.left, left); c <= Math.min(sel.right, right); c++)
      cells.push({ r, c, kind: printed(r, c) ? "prints" : "overflow" });
  const lines: string[] = [];
  if (preview.fits) lines.push(t(SURFACE.fitsLong));
  else {
    lines.push(
      t(SURFACE.printed, {
        rows: preview.printedRows,
        cols: preview.printedCols,
      }),
    );
    if (preview.overflowRows > 0)
      lines.push(t(SURFACE.overflowRows, { count: preview.overflowRows }));
    if (preview.overflowCols > 0)
      lines.push(t(SURFACE.overflowCols, { count: preview.overflowCols }));
    if (preview.beforeRows > 0)
      lines.push(t(SURFACE.beforeRows, { count: preview.beforeRows }));
    if (preview.beforeCols > 0)
      lines.push(t(SURFACE.beforeCols, { count: preview.beforeCols }));
  }
  const w = cols * CELL_W;
  const h = rows * CELL_H;
  return (
    <div
      data-testid="sheet-print-preview"
      role="region"
      aria-label={t(SURFACE.preview)}
      style={{
        marginBottom: 4,
        padding: "6px 8px",
        background: "var(--pg-bg, #ffffff)",
        color: "var(--pg-fg, #1a1a1a)",
        border: "1px solid var(--pg-border, #c9c9c4)",
        borderRadius: 6,
        boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
        font: "12px var(--font-sans, sans-serif)",
        maxWidth: 420,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {t(SURFACE.previewHeading, { range: blockA1(sel) })}
      </div>
      <svg
        width={w + 2}
        height={h + 2}
        viewBox={`-1 -1 ${w + 2} ${h + 2}`}
        aria-hidden="true"
        style={{ display: "block", maxWidth: "100%" }}
      >
        <defs>
          <pattern
            id={hatch}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" fill="#fde2e1" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="#b42318" />
          </pattern>
        </defs>
        {windows.map((win, i) => {
          const x = (Math.max(win.left, left) - left) * CELL_W;
          const y = (Math.max(win.top, top) - top) * CELL_H;
          const x2 = (Math.min(win.right, right) - left + 1) * CELL_W;
          const y2 = (Math.min(win.bottom, bottom) - top + 1) * CELL_H;
          return x2 > x && y2 > y ? (
            <rect
              key={`w${i}`}
              data-preview-frame=""
              x={x}
              y={y}
              width={x2 - x}
              height={y2 - y}
              fill="#ffffff"
              stroke="#1a1a1a"
              strokeWidth={1.5}
            />
          ) : null;
        })}
        {cells.map(({ r, c, kind }) => (
          <rect
            key={`${r}:${c}`}
            data-preview-cell={kind}
            x={(c - left) * CELL_W + 1}
            y={(r - top) * CELL_H + 1}
            width={CELL_W - 2}
            height={CELL_H - 2}
            fill={kind === "prints" ? "#bcd3f5" : `url(#${hatch})`}
          />
        ))}
      </svg>
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 4,
          color: "var(--pg-muted-fg, #5b5b57)",
        }}
      >
        <span>▭ {t(SURFACE.legendFrame)}</span>
        <span>
          <span style={{ color: "#2b6cb0" }}>■</span> {t(SURFACE.legendPrints)}
        </span>
        <span>
          <span style={{ color: "#b42318" }}>▨</span>{" "}
          {t(SURFACE.legendOverflow)}
        </span>
      </div>
      <ul
        data-testid="sheet-print-preview-notes"
        style={{ margin: "4px 0 0", paddingLeft: 16 }}
      >
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
