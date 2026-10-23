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


// The sheet's FRAME SURFACE (sheet ADR 510, extensions ADR 334): Excel
// inside the frame. While the frame is entered the grid is drawn on the
// main thread over it, with row and column headings inside the frame; a
// text field at the active cell is the cell editor (typing, the caret,
// input methods), a formula bar rides above the frame in screen space.
// Every state shown is the session's and every input goes through the
// session's grid operations, so the keyboard map, the undo journal and the
// page refresh are the ones the edit context always used.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";

import {
  DEFAULT_HEADING_STYLE,
  applyCompletion,
  completionTokenAt,
  hitCell,
  matchFunctions,
  paintGridScene,
  rowHeadingWidthPt,
  type FunctionEntry,
  type GridScene,
} from "../../../sheet-host-model/src";
import type { WorkbookSession } from "../session";
import {
  REF_COLORS,
  a1Of,
  cycleAbsolute,
  formulaRefs,
  refEndingAt,
  refInsertable,
} from "./formula-refs";

/** The operations the surface needs from the session. */
export type FrameSurfaceSession = Pick<
  WorkbookSession,
  | "attachFrameSurface"
  | "pointerDownInFrame"
  | "pointerMoveInFrame"
  | "pointerUpInFrame"
  | "wheelInFrame"
  | "handleGridKey"
  | "isCellEditing"
  | "cellEditState"
  | "beginCellEdit"
  | "setCellEditText"
  | "commitCellEdit"
  | "cancelCellEdit"
  | "onDidChange"
  | "activeCell"
  | "selectCell"
  | "extendSelection"
  | "setColumnWidth"
  | "setRowHeight"
  | "selectionStats"
  | "cellInputAt"
  | "functionList"
  | "sheets"
  | "state"
>;

const MAX_ROW = 1_048_575;
const MAX_COL = 16_383;
/** Points per xlsx width character (the page lowering's constant). */
const CHAR_TO_PT = 5.25;
/** A heading border is grabbed within this many points. */
const GRAB_PT = 3;
/** The cell editor's text, as the painter draws cell text. */
const EDITOR_FONT_PT = 10;

/** The session state the surface and its bar draw, re-read on every change. */
function useSessionView<T>(session: FrameSurfaceSession, read: () => T): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    setValue(read());
    const sub = session.onDidChange(() => setValue(read()));
    return () => sub.dispose();
    // `read` is a fresh closure each render; the session is the identity.
  }, [session]);
  return value;
}

/** A cell's rectangle in cell-area points, or null outside the window. */
function cellRect(
  scene: GridScene,
  row: number,
  col: number,
): [number, number, number, number] | null {
  const vp = scene.viewport;
  const ci = col - vp.firstCol;
  const ri = row - vp.firstRow;
  if (ci < 0 || ri < 0 || ci >= vp.cols || ri >= vp.rows) return null;
  return [vp.xOffsets[ci]!, vp.yOffsets[ri]!, vp.xOffsets[ci + 1]!, vp.yOffsets[ri + 1]!];
}

/** Which track boundary (index into offsets, ≥ 1) lies within GRAB_PT of
 *  `at`, or -1. */
function boundaryNear(offsets: readonly number[], at: number): number {
  for (let i = 1; i < offsets.length; i++) {
    if (Math.abs(offsets[i]! - at) <= GRAB_PT) return i;
  }
  return -1;
}

/** The track index under `at` along `offsets`, or -1. */
function trackAt(offsets: readonly number[], at: number): number {
  for (let i = 0; i + 1 < offsets.length; i++) {
    if (at >= offsets[i]! && at < offsets[i + 1]!) return i;
  }
  return -1;
}

export interface SheetFrameSurface {
  render: ComponentType<FrameSurfaceProps>;
  bar: ComponentType<FrameSurfaceProps>;
}

export function makeSheetFrameSurface(session: FrameSurfaceSession): SheetFrameSurface {
  // The surface's text field, so the bar can hand focus back to the grid.
  let editorEl: HTMLTextAreaElement | null = null;
  const focusGrid = () => editorEl?.focus({ preventScroll: true });

  function SheetFrameSurface(props: FrameSurfaceProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const editorRef = useRef<HTMLTextAreaElement | null>(null);
    const [scene, setScene] = useState<GridScene | null>(null);
    const edit = useSessionView(session, () => session.cellEditState());
    const [completion, setCompletion] = useState<{
      items: FunctionEntry[];
      index: number;
    } | null>(null);
    const composing = useRef(false);
    const gesture = useRef<
      | { kind: "cells" }
      | { kind: "ref"; start: number; end: number; anchor: { row: number; col: number } }
      | { kind: "resize-col"; index: number; col: number; from: number; startPt: number; widthPt: number }
      | { kind: "resize-row"; index: number; row: number; from: number; startPt: number; heightPt: number }
      | { kind: "heading-col"; anchor: number }
      | { kind: "heading-row"; anchor: number }
      | null
    >(null);
    const [resizeGhost, setResizeGhost] = useState<{ axis: "col" | "row"; at: number } | null>(null);
    const headW = rowHeadingWidthPt(scene?.viewport.firstRow ?? 0);
    const headH = DEFAULT_HEADING_STYLE.colHeightPt;

    useEffect(
      () =>
        session.attachFrameSurface(setScene, {
          wPt: props.widthPt - headW,
          hPt: props.heightPt - headH,
        }),
      [props.widthPt, props.heightPt, headW, headH],
    );

    useEffect(() => {
      editorEl = editorRef.current;
      editorRef.current?.focus({ preventScroll: true });
      return () => {
        if (editorEl === editorRef.current) editorEl = null;
      };
    }, []);

    // The text field follows the open edit (the formula bar may change it).
    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      const text = edit?.text ?? "";
      if (el.value !== text) el.value = text;
      if (!edit) setCompletion(null);
    }, [edit]);

    // The grid, at screen resolution, and the formula's reference boxes.
    useLayoutEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !scene) return;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const scale = Math.min(props.pxPerPt * dpr, 8);
      const w = Math.max(1, Math.ceil(props.widthPt * scale));
      const h = Math.max(1, Math.ceil(props.heightPt * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      paintGridScene(ctx, scene, {
        headings: true,
        rowHeadingWidthPt: headW,
        widthPt: props.widthPt,
        heightPt: props.heightPt,
      });
      // Excel colours each reference of the formula being typed.
      if (edit?.text.startsWith("=")) {
        ctx.save();
        ctx.translate(headW, headH);
        for (const r of formulaRefs(edit.text)) {
          const a = cellRect(scene, Math.max(r.top, scene.viewport.firstRow), Math.max(r.left, scene.viewport.firstCol));
          const b = cellRect(
            scene,
            Math.min(r.bottom, scene.viewport.firstRow + scene.viewport.rows - 1),
            Math.min(r.right, scene.viewport.firstCol + scene.viewport.cols - 1),
          );
          if (!a || !b) continue;
          const color = REF_COLORS[r.color]!;
          ctx.fillStyle = `${color}22`;
          ctx.fillRect(a[0], a[1], b[2] - a[0], b[3] - a[1]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(a[0], a[1], b[2] - a[0], b[3] - a[1]);
        }
        ctx.restore();
      }
      if (resizeGhost) {
        ctx.strokeStyle = "#2b6cb0";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        if (resizeGhost.axis === "col") {
          ctx.moveTo(resizeGhost.at, 0);
          ctx.lineTo(resizeGhost.at, props.heightPt);
        } else {
          ctx.moveTo(0, resizeGhost.at);
          ctx.lineTo(props.widthPt, resizeGhost.at);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }, [scene, props.pxPerPt, props.widthPt, props.heightPt, headW, edit?.text, resizeGhost]);

    // ── pointer ─────────────────────────────────────────────────────────

    const contentPoint = (clientX: number, clientY: number) => props.toContentPt(clientX, clientY);

    const insertRef = (row: number, col: number, extend?: { row: number; col: number }) => {
      const el = editorRef.current;
      if (!el || !edit) return;
      const text = el.value;
      const g = gesture.current;
      let start: number;
      let end: number;
      if (g && g.kind === "ref") {
        start = g.start;
        end = g.end;
      } else {
        const caret = el.selectionEnd ?? text.length;
        const prior = refEndingAt(text, caret);
        start = prior ? prior.start : caret;
        end = caret;
      }
      const anchor = extend ?? { row, col };
      const ref = a1Of(
        Math.min(anchor.row, row),
        Math.min(anchor.col, col),
        Math.max(anchor.row, row),
        Math.max(anchor.col, col),
      );
      const next = text.slice(0, start) + ref + text.slice(end);
      el.value = next;
      const caret = start + ref.length;
      el.setSelectionRange(caret, caret);
      session.setCellEditText(next);
      gesture.current = { kind: "ref", start, end: caret, anchor };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault(); // keep the caret in the cell editor
      editorRef.current?.focus({ preventScroll: true });
      const p = contentPoint(e.clientX, e.clientY);
      if (!p || !scene) return;
      const [x, y] = p;
      const vp = scene.viewport;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      // The select-all corner.
      if (x < headW && y < headH) {
        if (edit) session.commitCellEdit();
        session.selectCell(0, 0);
        session.extendSelection(MAX_ROW, MAX_COL);
        return;
      }
      // Column headings: a border resizes, a heading selects its column.
      if (y < headH) {
        const b = boundaryNear(vp.xOffsets, x - headW);
        if (b > 0) {
          gesture.current = {
            kind: "resize-col",
            index: b - 1,
            col: vp.firstCol + b - 1,
            from: vp.xOffsets[b - 1]!,
            startPt: x,
            widthPt: vp.xOffsets[b]! - vp.xOffsets[b - 1]!,
          };
          setResizeGhost({ axis: "col", at: headW + vp.xOffsets[b]! });
          return;
        }
        const i = trackAt(vp.xOffsets, x - headW);
        if (i < 0) return;
        if (edit) session.commitCellEdit();
        const col = vp.firstCol + i;
        const active = session.activeCell();
        if (e.shiftKey && active) {
          session.extendSelection(MAX_ROW, col);
        } else {
          session.selectCell(0, col);
          session.extendSelection(MAX_ROW, col);
        }
        gesture.current = { kind: "heading-col", anchor: e.shiftKey && active ? active.col : col };
        return;
      }
      // Row headings likewise.
      if (x < headW) {
        const b = boundaryNear(vp.yOffsets, y - headH);
        if (b > 0) {
          gesture.current = {
            kind: "resize-row",
            index: b - 1,
            row: vp.firstRow + b - 1,
            from: vp.yOffsets[b - 1]!,
            startPt: y,
            heightPt: vp.yOffsets[b]! - vp.yOffsets[b - 1]!,
          };
          setResizeGhost({ axis: "row", at: headH + vp.yOffsets[b]! });
          return;
        }
        const i = trackAt(vp.yOffsets, y - headH);
        if (i < 0) return;
        if (edit) session.commitCellEdit();
        const row = vp.firstRow + i;
        const active = session.activeCell();
        if (e.shiftKey && active) {
          session.extendSelection(row, MAX_COL);
        } else {
          session.selectCell(row, 0);
          session.extendSelection(row, MAX_COL);
        }
        gesture.current = { kind: "heading-row", anchor: e.shiftKey && active ? active.row : row };
        return;
      }
      const cx = x - headW;
      const cy = y - headH;
      // A formula being typed: a click puts the cell's reference in it.
      const el = editorRef.current;
      if (edit && el && edit.text.startsWith("=") && refInsertable(el.value, el.selectionEnd ?? el.value.length)) {
        const hit = hitCell(scene, cx, cy);
        if (hit) {
          gesture.current = null;
          insertRef(hit.row, hit.col);
          return;
        }
      }
      gesture.current = { kind: "cells" };
      session.pointerDownInFrame(cx, cy, { shift: e.shiftKey });
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      const p = contentPoint(e.clientX, e.clientY);
      if (!g || !p || !scene) return;
      const [x, y] = p;
      const vp = scene.viewport;
      if (g.kind === "resize-col") {
        setResizeGhost({ axis: "col", at: Math.max(headW + g.from + 2, x) });
        return;
      }
      if (g.kind === "resize-row") {
        setResizeGhost({ axis: "row", at: Math.max(headH + g.from + 2, y) });
        return;
      }
      if (g.kind === "heading-col") {
        const i = trackAt(vp.xOffsets, x - headW);
        if (i >= 0) {
          session.selectCell(0, g.anchor);
          session.extendSelection(MAX_ROW, vp.firstCol + i);
        }
        return;
      }
      if (g.kind === "heading-row") {
        const i = trackAt(vp.yOffsets, y - headH);
        if (i >= 0) {
          session.selectCell(g.anchor, 0);
          session.extendSelection(vp.firstRow + i, MAX_COL);
        }
        return;
      }
      if (g.kind === "ref") {
        const hit = hitCell(scene, x - headW, y - headH);
        if (hit) insertRef(hit.row, hit.col, g.anchor);
        return;
      }
      session.pointerMoveInFrame(x - headW, y - headH);
    };

    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      const p = contentPoint(e.clientX, e.clientY);
      if (g.kind === "resize-col") {
        setResizeGhost(null);
        if (!p) return;
        const widthPt = Math.max(2, p[0] - headW - g.from);
        session.selectCell(0, g.col);
        session.setColumnWidth(Math.round((widthPt / CHAR_TO_PT) * 100) / 100);
        return;
      }
      if (g.kind === "resize-row") {
        setResizeGhost(null);
        if (!p) return;
        const heightPt = Math.max(2, p[1] - headH - g.from);
        session.selectCell(g.row, 0);
        session.setRowHeight(Math.round(heightPt * 4) / 4);
        return;
      }
      if (g.kind === "cells" && p) session.pointerUpInFrame(p[0] - headW, p[1] - headH);
    };

    const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const p = contentPoint(e.clientX, e.clientY);
      if (!p || !scene) return;
      const [x, y] = p;
      const vp = scene.viewport;
      // A double-click on a column heading's border fits the column to its
      // widest visible text.
      if (y < headH && x >= headW) {
        const b = boundaryNear(vp.xOffsets, x - headW);
        if (b > 0) {
          const col = vp.firstCol + b - 1;
          const ctx = canvasRef.current?.getContext("2d");
          let widest = 0;
          if (ctx) {
            ctx.font = `${EDITOR_FONT_PT}px sans-serif`;
            for (const c of scene.cells) {
              if (c.col === col) widest = Math.max(widest, ctx.measureText(c.text).width);
            }
          }
          session.selectCell(0, col);
          session.setColumnWidth(widest > 0 ? Math.round(((widest + 8) / CHAR_TO_PT) * 100) / 100 : null);
        }
        return;
      }
      if (x < headW || y < headH) return;
      // A double-click on a cell edits it in place, from its input.
      if (!edit) session.beginCellEdit(null, "edit");
      requestAnimationFrame(() => {
        const el = editorRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    };

    // ── keys and text ───────────────────────────────────────────────────

    const updateCompletion = (text: string, caret: number) => {
      if (!text.startsWith("=")) return setCompletion(null);
      const token = completionTokenAt(text, caret);
      if (token.text.length === 0 || /[0-9$]/.test(token.text[0]!)) return setCompletion(null);
      const items = matchFunctions(session.functionList(), token.text).slice(0, 8);
      setCompletion(items.length > 0 ? { items, index: 0 } : null);
    };

    const acceptCompletion = (name: string) => {
      const el = editorRef.current;
      if (!el) return;
      const token = completionTokenAt(el.value, el.selectionEnd ?? el.value.length);
      const { value, caret } = applyCompletion(el.value, token, name);
      el.value = value;
      el.setSelectionRange(caret, caret);
      session.setCellEditText(value);
      setCompletion(null);
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (composing.current || e.nativeEvent.isComposing) return;
      const el = e.currentTarget;
      const open = session.cellEditState();
      // The suggestion list owns the arrows, Tab and Enter while it shows.
      if (open && completion) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const n = completion.items.length;
          const d = e.key === "ArrowDown" ? 1 : n - 1;
          setCompletion({ ...completion, index: (completion.index + d) % n });
          return;
        }
        if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          acceptCompletion(completion.items[completion.index]!.name);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setCompletion(null);
          return;
        }
      }
      if (open) {
        // F4 cycles $ in the reference at the caret.
        if (e.key === "F4") {
          e.preventDefault();
          const r = cycleAbsolute(el.value, el.selectionEnd ?? el.value.length);
          if (r) {
            el.value = r.text;
            el.setSelectionRange(r.caret, r.caret);
            session.setCellEditText(r.text);
          }
          return;
        }
        // Alt+Enter is a line break inside the cell.
        if (e.key === "Enter" && e.altKey) {
          e.preventDefault();
          const s = el.selectionStart ?? el.value.length;
          const t = el.value.slice(0, s) + "\n" + el.value.slice(el.selectionEnd ?? s);
          el.value = t;
          el.setSelectionRange(s + 1, s + 1);
          session.setCellEditText(t);
          return;
        }
        // In "edit" mode (F2, a double-click) the arrows move the caret.
        const caretKey =
          open.mode === "edit" &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key);
        const commitKey = ["Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
        if (caretKey || !commitKey) {
          // Ordinary typing and caret moves are the text field's.
          if (e.key.length !== 1 || !(e.metaKey || e.ctrlKey)) return;
        }
        session.setCellEditText(el.value);
        gesture.current = null;
        if (session.handleGridKey(e)) e.preventDefault();
        return;
      }
      // No edit open: Esc leaves the frame (Excel's second Esc).
      if (e.key === "Escape") {
        e.preventDefault();
        props.exit({ commit: true });
        return;
      }
      // A printable key starts an edit through the text field (input event).
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) return;
      if (e.key === "F2") {
        e.preventDefault();
        session.beginCellEdit(null, "edit");
        requestAnimationFrame(() => {
          const t = editorRef.current;
          if (t) t.setSelectionRange(t.value.length, t.value.length);
        });
        return;
      }
      if (session.handleGridKey(e)) e.preventDefault();
    };

    const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
      if (composing.current) return;
      const el = e.currentTarget;
      if (session.cellEditState()) session.setCellEditText(el.value);
      else session.beginCellEdit(el.value, "enter");
      updateCompletion(el.value, el.selectionEnd ?? el.value.length);
    };

    // ── layout ──────────────────────────────────────────────────────────

    const active = edit ?? session.activeCell();
    const rect = scene && active ? cellRect(scene, active.row, active.col) : null;
    const editorStyle: CSSProperties = rect
      ? {
          position: "absolute",
          left: headW + rect[0],
          top: headH + rect[1],
          width: edit ? Math.max(rect[2] - rect[0], (edit.text.length + 1) * EDITOR_FONT_PT * 0.6) : 1,
          minHeight: edit ? rect[3] - rect[1] : 1,
          height: edit ? undefined : 1,
          opacity: edit ? 1 : 0,
          padding: "1px 3px",
          margin: 0,
          border: edit ? "1.5px solid #2b6cb0" : "none",
          boxSizing: "border-box",
          font: `${EDITOR_FONT_PT}px sans-serif`,
          lineHeight: `${(rect[3] - rect[1]) - 3}px`,
          color: "#1a1a1a",
          background: "#ffffff",
          resize: "none",
          overflow: "hidden",
          outline: "none",
          whiteSpace: "pre",
          caretColor: edit ? "#1a1a1a" : "transparent",
        }
      : { position: "absolute", left: 0, top: 0, width: 1, height: 1, opacity: 0, padding: 0, border: "none" };

    return (
      <div
        ref={rootRef}
        role="grid"
        aria-label="Sheet"
        data-testid="sheet-frame-surface"
        style={{ position: "relative", width: "100%", height: "100%", cursor: "cell" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) return; // the canvas zooms
          // deltaMode 0 = pixels: screen pixels to content points.
          const k = e.deltaMode === 0 ? 1 / Math.max(props.pxPerPt, 0.01) : 15;
          const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY * k : e.deltaX * k;
          const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY * k;
          // Used: the grid scrolled, the canvas stays put. Declined (the
          // window is at that edge): the wheel goes on to the canvas.
          if (session.wheelInFrame(dx, dy)) e.stopPropagation();
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: "block", width: props.widthPt, height: props.heightPt }}
        />
        <textarea
          ref={editorRef}
          data-testid="sheet-cell-editor"
          aria-label="Cell"
          spellCheck={false}
          autoComplete="off"
          rows={1}
          style={editorStyle}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            onInput(e as unknown as React.FormEvent<HTMLTextAreaElement>);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (session.cellEditState()) updateCompletion(el.value, el.selectionEnd ?? el.value.length);
          }}
        />
        {edit && completion && rect ? (
          <ul
            data-testid="sheet-completions"
            role="listbox"
            style={{
              position: "absolute",
              left: headW + rect[0],
              top: headH + rect[3] + 2,
              margin: 0,
              padding: 2,
              listStyle: "none",
              background: "#ffffff",
              border: "1px solid #c9c9c4",
              boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
              font: `${EDITOR_FONT_PT - 1}px sans-serif`,
              minWidth: 120,
              zIndex: 2,
            }}
          >
            {completion.items.map((f, i) => (
              <li
                key={f.name}
                role="option"
                aria-selected={i === completion.index}
                style={{
                  padding: "1px 6px",
                  background: i === completion.index ? "#dfe7f1" : "transparent",
                  color: "#1a1a1a",
                }}
                onPointerDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  acceptCompletion(f.name);
                }}
              >
                {f.name}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  // ── the bar: name box, formula, status ─────────────────────────────────

  function SheetBar(props: FrameSurfaceProps) {
    const view = useSessionView(session, () => {
      const edit = session.cellEditState();
      const active = session.activeCell();
      const st = session.state();
      const sel = st.gridSelection;
      return {
        edit,
        active,
        input: edit ? edit.text : active ? session.cellInputAt(active.row, active.col) : "",
        name: sel
          ? a1Of(sel.anchorRow, sel.anchorCol, sel.anchorRow + sel.rows - 1, sel.anchorCol + sel.cols - 1)
          : active
            ? a1Of(active.row, active.col)
            : "",
        sheet: session.sheets().find((s) => s.id === st.activeSheet)?.name ?? "",
        stats: sel && (sel.rows > 1 || sel.cols > 1) ? session.selectionStats() : null,
      };
    });
    const inputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
      const el = inputRef.current;
      if (el && document.activeElement !== el && el.value !== view.input) el.value = view.input;
    }, [view.input]);

    const bar: CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 6px",
      minWidth: 420,
      background: "var(--pg-bg, #ffffff)",
      color: "var(--pg-fg, #1a1a1a)",
      border: "1px solid var(--pg-border, #c9c9c4)",
      borderRadius: 6,
      boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
      font: "12px var(--font-sans, sans-serif)",
    };
    const box: CSSProperties = {
      font: "12px var(--font-mono, monospace)",
      padding: "2px 6px",
      border: "1px solid var(--pg-border, #c9c9c4)",
      borderRadius: 4,
      background: "var(--pg-bg, #ffffff)",
      color: "var(--pg-fg, #1a1a1a)",
    };
    const button: CSSProperties = {
      ...box,
      font: "12px var(--font-sans, sans-serif)",
      cursor: "pointer",
      padding: "1px 6px",
    };
    return (
      <div data-testid="sheet-bar" style={bar}>
        <span data-testid="sheet-bar-name" style={{ ...box, minWidth: 54, textAlign: "center" }}>
          {view.name}
        </span>
        {view.edit ? (
          <>
            <button
              type="button"
              aria-label="Cancel"
              style={button}
              onClick={() => {
                session.cancelCellEdit();
                focusGrid();
              }}
            >
              ✕
            </button>
            <button
              type="button"
              aria-label="Enter"
              style={button}
              onClick={() => {
                session.commitCellEdit();
                focusGrid();
              }}
            >
              ✓
            </button>
          </>
        ) : null}
        <span style={{ color: "var(--pg-muted-fg, #5b5b57)", fontStyle: "italic" }}>fx</span>
        <input
          ref={inputRef}
          data-testid="sheet-bar-formula"
          aria-label="Formula"
          spellCheck={false}
          defaultValue={view.input}
          style={{ ...box, flex: 1, minWidth: 180 }}
          onFocus={() => {
            if (!session.cellEditState()) session.beginCellEdit(null, "edit");
          }}
          onInput={(e) => session.setCellEditText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              session.setCellEditText(e.currentTarget.value);
              session.handleGridKey({ key: "Enter", shiftKey: e.shiftKey });
              focusGrid();
            } else if (e.key === "Escape") {
              e.preventDefault();
              session.cancelCellEdit();
              focusGrid();
            }
          }}
        />
        {view.stats && view.stats.count > 0 ? (
          <span data-testid="sheet-bar-stats" style={{ color: "var(--pg-muted-fg, #5b5b57)", whiteSpace: "nowrap" }}>
            {view.stats.numbers > 0
              ? `Sum ${view.stats.sumDisplay} · Average ${view.stats.averageDisplay} · `
              : ""}
            Count {view.stats.count}
          </span>
        ) : null}
        <span data-testid="sheet-bar-sheet" style={{ ...box, whiteSpace: "nowrap" }}>
          {view.sheet}
        </span>
        <button
          type="button"
          aria-label="Full screen"
          title="Full screen"
          style={button}
          onClick={() => props.requestPresentation(props.presentation === "fullscreen" ? "frame" : "fullscreen")}
        >
          ⤢
        </button>
      </div>
    );
  }

  return { render: SheetFrameSurface, bar: SheetBar };
}
