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
  useMemo,
  useSyncExternalStore,
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
  cellRect as viewportCellRect,
  colAt,
  colBand,
  completionTokenAt,
  hitCell,
  rowAt,
  rowBand,
  matchFunctions,
  paintGridScene,
  rowHeadingWidthPt,
  type FunctionEntry,
  type GridScene,
} from "../../../sheet-host-model/src";
import type { WorkbookSession } from "../session";
import type { DataToolsApi } from "../data-tools";
import { DataCards } from "./data-cards";
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
  | "pasteSpecialOpen"
  | "closePasteSpecial"
  | "pasteAtSelection"
  | "frameView"
  | "setFrameSheet"
  | "documentFontFace"
  | "documentTextDefault"
  | "documentSwatchColors"
  | "documentStyleChoices"
  | "applyDocumentSwatch"
  | "styleAtTarget"
  | "setStyle"
  | "documentStyleRevision"
  | "setFrameViewLock"
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
  | "undoCellEdit"
  | keyof DataToolsApi
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
  // A JSON snapshot: equal state reads as the same string, so React only
  // re-renders when what is shown changed.
  const json = useSyncExternalStore(
    (onChange) => {
      const sub = session.onDidChange(() => onChange());
      return () => sub.dispose();
    },
    () => JSON.stringify(read() ?? null),
  );
  return useMemo(() => JSON.parse(json) as T, [json]);
}

/** A cell's rectangle `[x0, y0, x1, y1]` in cell-area points, or null
 *  when its row or column is not shown. */
function cellRect(
  scene: GridScene,
  row: number,
  col: number,
): [number, number, number, number] | null {
  const r = viewportCellRect(scene.viewport, row, col);
  return r ? [r[0], r[1], r[0] + r[2], r[1] + r[3]] : null;
}

/** The shown part of a cell range as `[x0, y0, x1, y1]`, or null. */
function rangeRect(
  scene: GridScene,
  top: number,
  left: number,
  bottom: number,
  right: number,
): [number, number, number, number] | null {
  const vp = scene.viewport;
  const [r0, r1] = rowBand(vp, top, bottom - top + 1);
  const [c0, c1] = colBand(vp, left, right - left + 1);
  if (r0 >= r1 || c0 >= c1) return null;
  return [
    vp.xOffsets[c0]!,
    vp.yOffsets[r0]!,
    vp.xOffsets[c1]!,
    vp.yOffsets[r1]!,
  ];
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

/** What the surface and its bar share: the session, and the surface's text
 *  field so the bar can hand focus back to the grid. */
interface SurfaceLink {
  session: FrameSurfaceSession;
}

/** Each surface's text field, by link (so the bar can focus it). */
const editors = new WeakMap<SurfaceLink, HTMLTextAreaElement>();

export function makeSheetFrameSurface(
  session: FrameSurfaceSession,
): SheetFrameSurface {
  const link: SurfaceLink = { session };
  // Named bindings the React Compiler can see; the components they render
  // are declared at module level.
  const SheetFrameSurface = (props: FrameSurfaceProps) => (
    <SheetFrameSurfaceView {...props} link={link} />
  );
  const SheetBar = (props: FrameSurfaceProps) => (
    <SheetBarView {...props} link={link} />
  );
  return { render: SheetFrameSurface, bar: SheetBar };
}

// ── document faces: the grid draws in the fonts the page uses ─────────

/** The faces a session asked for (family|style → loaded), so each face is
 *  requested once per session. */
const requestedFaces = new WeakMap<FrameSurfaceSession, Map<string, boolean>>();

/** The CSS face descriptors of a cell style. */
function faceOfStyle(st: { bold?: boolean; italic?: boolean }): {
  style: string;
  weight: string;
  name: string;
} {
  const bold = !!st.bold;
  const italic = !!st.italic;
  return {
    style: italic ? "italic" : "normal",
    weight: bold ? "700" : "400",
    name:
      bold && italic
        ? "Bold Italic"
        : bold
          ? "Bold"
          : italic
            ? "Italic"
            : "Regular",
  };
}

/** The document swatch ids a scene's styles reference. */
function swatchIdsOf(scene: GridScene): string[] {
  const ids = new Set<string>();
  for (const st of scene.styles) {
    if (st.fillSwatch) ids.add(st.fillSwatch);
    if (st.textSwatch) ids.add(st.textSwatch);
    for (const line of Object.values(st.borderLines ?? {}))
      if (line?.swatch) ids.add(line.swatch);
  }
  return [...ids].sort();
}

/** `scene` with every referenced document swatch drawn in the colour the
 *  document shows it in now (P7): a swatch edited in the document recolours
 *  the grid, as it recolours the placed table. */
export function withSwatchColors(
  scene: GridScene,
  colors: ReadonlyMap<string, string>,
): GridScene {
  if (colors.size === 0) return scene;
  const pick = (
    id: string | null | undefined,
    rgb: string | null | undefined,
  ) => (id ? colors.get(id) : undefined) ?? rgb ?? null;
  return {
    ...scene,
    styles: scene.styles.map((st) => {
      if (!st.fillSwatch && !st.textSwatch && !st.borderLines) return st;
      const lines = st.borderLines
        ? Object.fromEntries(
            Object.entries(st.borderLines).map(([edge, line]) => [
              edge,
              line?.swatch
                ? { ...line, rgb: pick(line.swatch, line.rgb) }
                : line,
            ]),
          )
        : undefined;
      return {
        ...st,
        fillRgb: st.fillSwatch ? pick(st.fillSwatch, st.fillRgb) : st.fillRgb,
        textRgb: st.textSwatch ? pick(st.textSwatch, st.textRgb) : st.textRgb,
        ...(lines ? { borderLines: lines } : {}),
      };
    }),
  };
}

/** The document's current colours for the swatches `scene` references,
 *  re-read when the document's styles may have changed. */
function useSwatchColors(
  session: FrameSurfaceSession,
  scene: GridScene | null,
): ReadonlyMap<string, string> {
  const revision = useSessionView(session, () =>
    session.documentStyleRevision(),
  );
  const [colors, setColors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const key = scene ? swatchIdsOf(scene).join("\u0000") : "";
  useEffect(() => {
    if (!key) return;
    let live = true;
    void session.documentSwatchColors(key.split("\u0000")).then((next) => {
      if (live) setColors(next);
    });
    return () => {
      live = false;
    };
  }, [session, key, revision]);
  return colors;
}

/** The document's default text face per session (asked once). */
const textDefaults = new WeakMap<
  FrameSurfaceSession,
  Promise<{
    family: string;
    style: string | null;
    sizePt: number | null;
  } | null>
>();

/** The face and size the page gives text that names none (the document's
 *  basic paragraph style), or null until known / when unreadable. */
function useDocumentTextDefault(
  session: FrameSurfaceSession,
): { family: string; style: string | null; sizePt: number | null } | null {
  const [value, setValue] = useState<{
    family: string;
    style: string | null;
    sizePt: number | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    let pending = textDefaults.get(session);
    if (!pending) {
      pending = session.documentTextDefault().catch(() => null);
      textDefaults.set(session, pending);
    }
    void pending.then((d) => {
      if (live) setValue(d);
    });
    return () => {
      live = false;
    };
  }, [session]);
  return value;
}

/** Load the document's faces for the families `scene` names into the
 *  page's font set; answers a counter that moves whenever one arrived, so
 *  the grid repaints in it. */
function useDocumentFaces(
  session: FrameSurfaceSession,
  scene: GridScene | null,
  defaultFamily: string | null,
): number {
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    if (!scene || typeof document === "undefined" || !("fonts" in document))
      return;
    if (typeof FontFace === "undefined") return;
    let asked = requestedFaces.get(session);
    if (!asked) {
      asked = new Map();
      requestedFaces.set(session, asked);
    }
    let live = true;
    const wanted = [
      ...scene.styles,
      ...(defaultFamily
        ? [{ fontName: defaultFamily, bold: false, italic: false }]
        : []),
    ];
    for (const st of wanted) {
      const family = st.fontName ?? defaultFamily;
      if (!family) continue;
      const face = faceOfStyle(st);
      const key = `${family}|${face.name}`;
      if (asked.has(key)) continue;
      asked.set(key, false);
      const memo = asked;
      void session
        .documentFontFace(family, face.name)
        .then(async (got) => {
          if (!got) return;
          const ff = new FontFace(family, new Uint8Array(got.bytes), {
            style: face.style,
            weight: face.weight,
          });
          await ff.load();
          document.fonts.add(ff);
          memo.set(key, true);
          if (live) setLoaded((n) => n + 1);
        })
        .catch(() => {
          // A face the browser cannot load keeps the fallback family.
        });
    }
    return () => {
      live = false;
    };
  }, [session, scene, defaultFamily]);
  return loaded;
}

function SheetFrameSurfaceView({
  link,
  ...props
}: FrameSurfaceProps & { link: SurfaceLink }) {
  const session = link.session;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [scene, setScene] = useState<GridScene | null>(null);
  const textDefault = useDocumentTextDefault(session);
  const swatchColors = useSwatchColors(session, scene);
  const facesLoaded = useDocumentFaces(
    session,
    scene,
    textDefault?.family ?? null,
  );
  const edit = useSessionView(session, () => session.cellEditState());
  // Sheet ADR 517 — what sits on the cells: the active cell's input
  // message and list, the AutoFilter's buttons, the invalid-data circles.
  const data = useSessionView(session, () => ({
    prompt: session.cellPrompt(),
    listOpen: session.validationListOpen(),
    filter: session.filterButtons(),
    circles: session.invalidCircles(),
  }));
  const [listIndex, setListIndex] = useState(0);
  const [completion, setCompletion] = useState<{
    items: FunctionEntry[];
    index: number;
  } | null>(null);
  const composing = useRef(false);
  const gesture = useRef<
    | { kind: "cells" }
    | {
        kind: "ref";
        start: number;
        end: number;
        anchor: { row: number; col: number };
      }
    | {
        kind: "resize-col";
        index: number;
        col: number;
        from: number;
        startPt: number;
        widthPt: number;
      }
    | {
        kind: "resize-row";
        index: number;
        row: number;
        from: number;
        startPt: number;
        heightPt: number;
      }
    | { kind: "heading-col"; anchor: number }
    | { kind: "heading-row"; anchor: number }
    | null
  >(null);
  const [resizeGhost, setResizeGhost] = useState<{
    axis: "col" | "row";
    at: number;
  } | null>(null);
  const headW = rowHeadingWidthPt(scene?.viewport.firstRow ?? 0);
  const headH = DEFAULT_HEADING_STYLE.colHeightPt;

  useEffect(
    () =>
      session.attachFrameSurface(setScene, {
        wPt: props.widthPt - headW,
        hPt: props.heightPt - headH,
      }),
    [session, props.widthPt, props.heightPt, headW, headH],
  );

  useEffect(() => {
    const el = editorRef.current;
    if (el) editors.set(link, el);
    el?.focus({ preventScroll: true });
    return () => {
      if (editors.get(link) === el) editors.delete(link);
    };
  }, [link]);

  // The text field follows the open edit (the formula bar may change it).
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = edit?.text ?? "";
    if (el.value !== text) el.value = text;
    // (The suggestion list only shows while an edit is open.)
  }, [edit]);

  // The grid, at screen resolution, and the formula's reference boxes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    // (Repainted when a document face arrives: `facesLoaded` moves.)
    if (!canvas || !scene || facesLoaded < 0) return;
    const dpr =
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const scale = Math.min(props.pxPerPt * dpr, 8);
    const w = Math.max(1, Math.ceil(props.widthPt * scale));
    const h = Math.max(1, Math.ceil(props.heightPt * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    paintGridScene(ctx, withSwatchColors(scene, swatchColors), {
      // P7 — un-styled cells in the face the page prints them in.
      ...(textDefault
        ? {
            grid: {
              fontFamily: `"${textDefault.family}", sans-serif`,
              ...(textDefault.sizePt ? { fontSizePt: textDefault.sizePt } : {}),
            },
          }
        : {}),
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
        const box = rangeRect(scene, r.top, r.left, r.bottom, r.right);
        if (!box) continue;
        const color = REF_COLORS[r.color]!;
        ctx.fillStyle = `${color}22`;
        ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      }
      ctx.restore();
    }
    // Circle invalid data: a red ellipse around each cell breaking its rule.
    if (data.circles && data.circles.length > 0) {
      ctx.save();
      ctx.translate(headW, headH);
      ctx.strokeStyle = "#d62020";
      ctx.lineWidth = 1.25;
      for (const c of data.circles) {
        const box = cellRect(scene, c.row, c.col);
        if (!box) continue;
        const rx = (box[2] - box[0]) / 2 + 2;
        const ry = (box[3] - box[1]) / 2 + 1.5;
        ctx.beginPath();
        ctx.ellipse(
          box[0] + rx - 2,
          box[1] + ry - 1.5,
          rx,
          ry,
          0,
          0,
          2 * Math.PI,
        );
        ctx.stroke();
      }
      ctx.restore();
    }
    // Full screen shows more than the frame: a dashed outline marks the
    // frame-sized window that lands on the page when the frame is left.
    if (props.presentation === "fullscreen") {
      ctx.save();
      ctx.strokeStyle = "#2b6cb0";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(
        headW,
        headH,
        props.frameBoxPt.widthPt,
        props.frameBoxPt.heightPt,
      );
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
  }, [
    scene,
    headH,
    props.presentation,
    props.frameBoxPt.widthPt,
    props.frameBoxPt.heightPt,
    props.pxPerPt,
    props.widthPt,
    props.heightPt,
    headW,
    edit?.text,
    resizeGhost,
    data.circles,
    facesLoaded,
    textDefault,
    swatchColors,
  ]);

  // ── pointer ─────────────────────────────────────────────────────────

  const contentPoint = (clientX: number, clientY: number) =>
    props.toContentPt(clientX, clientY);

  const insertRef = (
    row: number,
    col: number,
    extend?: { row: number; col: number },
  ) => {
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
          col: colAt(vp, b - 1),
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
      const col = colAt(vp, i);
      const active = session.activeCell();
      if (e.shiftKey && active) {
        session.extendSelection(MAX_ROW, col);
      } else {
        session.selectCell(0, col);
        session.extendSelection(MAX_ROW, col);
      }
      gesture.current = {
        kind: "heading-col",
        anchor: e.shiftKey && active ? active.col : col,
      };
      return;
    }
    // Row headings likewise.
    if (x < headW) {
      const b = boundaryNear(vp.yOffsets, y - headH);
      if (b > 0) {
        gesture.current = {
          kind: "resize-row",
          index: b - 1,
          row: rowAt(vp, b - 1),
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
      const row = rowAt(vp, i);
      const active = session.activeCell();
      if (e.shiftKey && active) {
        session.extendSelection(row, MAX_COL);
      } else {
        session.selectCell(row, 0);
        session.extendSelection(row, MAX_COL);
      }
      gesture.current = {
        kind: "heading-row",
        anchor: e.shiftKey && active ? active.row : row,
      };
      return;
    }
    const cx = x - headW;
    const cy = y - headH;
    // A formula being typed: a click puts the cell's reference in it.
    const el = editorRef.current;
    if (
      edit &&
      el &&
      edit.text.startsWith("=") &&
      refInsertable(el.value, el.selectionEnd ?? el.value.length)
    ) {
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
        session.extendSelection(MAX_ROW, colAt(vp, i));
      }
      return;
    }
    if (g.kind === "heading-row") {
      const i = trackAt(vp.yOffsets, y - headH);
      if (i >= 0) {
        session.selectCell(g.anchor, 0);
        session.extendSelection(rowAt(vp, i), MAX_COL);
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
    if (g.kind === "cells" && p)
      session.pointerUpInFrame(p[0] - headW, p[1] - headH);
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
        const col = colAt(vp, b - 1);
        const ctx = canvasRef.current?.getContext("2d");
        let widest = 0;
        if (ctx) {
          ctx.font = `${EDITOR_FONT_PT}px sans-serif`;
          for (const c of scene.cells) {
            if (c.col === col)
              widest = Math.max(widest, ctx.measureText(c.text).width);
          }
        }
        session.selectCell(0, col);
        session.setColumnWidth(
          widest > 0
            ? Math.round(((widest + 8) / CHAR_TO_PT) * 100) / 100
            : null,
        );
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
    if (token.text.length === 0 || /[0-9$]/.test(token.text[0]!))
      return setCompletion(null);
    const items = matchFunctions(session.functionList(), token.text).slice(
      0,
      8,
    );
    setCompletion(items.length > 0 ? { items, index: 0 } : null);
  };

  const acceptCompletion = (name: string) => {
    const el = editorRef.current;
    if (!el) return;
    const token = completionTokenAt(
      el.value,
      el.selectionEnd ?? el.value.length,
    );
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
    // An open validation list owns the arrows, Enter and Esc.
    const listItems = data.listOpen ? (data.prompt?.items ?? null) : null;
    if (!open && listItems && listItems.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = listItems.length;
        setListIndex((listIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        session.chooseListItem(
          listItems[Math.min(listIndex, listItems.length - 1)]!,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        session.openCellDropdown(false);
        return;
      }
    }
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
        const t =
          el.value.slice(0, s) + "\n" + el.value.slice(el.selectionEnd ?? s);
        el.value = t;
        el.setSelectionRange(s + 1, s + 1);
        session.setCellEditText(t);
        return;
      }
      // In "edit" mode (F2, a double-click) the arrows move the caret.
      const caretKey =
        open.mode === "edit" &&
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(e.key);
      const commitKey = [
        "Enter",
        "Tab",
        "Escape",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
      ].includes(e.key);
      if (caretKey || !commitKey) {
        // Ordinary typing and caret moves are the text field's.
        if (e.key.length !== 1 || !(e.metaKey || e.ctrlKey)) return;
      }
      session.setCellEditText(el.value);
      gesture.current = null;
      if (session.handleGridKey(e)) e.preventDefault();
      return;
    }
    // No edit open: Esc leaves full screen, else the frame (Excel's
    // second Esc; one level per press).
    if (e.key === "Escape") {
      e.preventDefault();
      if (props.presentation === "fullscreen")
        props.requestPresentation("frame");
      else props.exit({ commit: true });
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
    // A refused edit (a locked cell) leaves nothing typed behind.
    else if (!session.beginCellEdit(el.value, "enter")) el.value = "";
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
        width: edit
          ? Math.max(
              rect[2] - rect[0],
              (edit.text.length + 1) * EDITOR_FONT_PT * 0.6,
            )
          : 1,
        minHeight: edit ? rect[3] - rect[1] : 1,
        height: edit ? undefined : 1,
        opacity: edit ? 1 : 0,
        padding: "1px 3px",
        margin: 0,
        border: edit ? "1.5px solid #2b6cb0" : "none",
        boxSizing: "border-box",
        font: `${EDITOR_FONT_PT}px sans-serif`,
        lineHeight: `${rect[3] - rect[1] - 3}px`,
        color: "#1a1a1a",
        background: "#ffffff",
        resize: "none",
        overflow: "hidden",
        outline: "none",
        whiteSpace: "pre",
        caretColor: edit ? "#1a1a1a" : "transparent",
      }
    : {
        position: "absolute",
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        opacity: 0,
        padding: 0,
        border: "none",
      };

  return (
    <div
      ref={rootRef}
      role="grid"
      aria-label="Sheet"
      data-testid="sheet-frame-surface"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        cursor: "cell",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        // The host opens the menu; like Excel, a right-click outside the
        // selection first selects the cell under the pointer.
        const p = props.toContentPt(e.clientX, e.clientY);
        if (!p || !scene || p[0] < headW || p[1] < headH) return;
        const hit = hitCell(scene, p[0] - headW, p[1] - headH);
        const sel = session.state().gridSelection;
        const inside =
          hit &&
          sel &&
          hit.row >= sel.anchorRow &&
          hit.row < sel.anchorRow + sel.rows &&
          hit.col >= sel.anchorCol &&
          hit.col < sel.anchorCol + sel.cols;
        if (hit && !inside) {
          if (session.cellEditState()) session.commitCellEdit();
          session.selectCell(hit.row, hit.col);
        }
      }}
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
        style={{
          display: "block",
          width: props.widthPt,
          height: props.heightPt,
        }}
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
          if (session.cellEditState())
            updateCompletion(el.value, el.selectionEnd ?? el.value.length);
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
      <CellChrome
        session={session}
        scene={scene}
        headW={headW}
        headH={headH}
        active={active}
        editing={edit !== null}
        prompt={data.prompt}
        listOpen={data.listOpen}
        listIndex={listIndex}
        filter={data.filter}
        onListOpen={() => setListIndex(0)}
        focusEditor={() => editorRef.current?.focus({ preventScroll: true })}
      />
    </div>
  );
}

/** A small funnel / arrow, drawn in the button's own pt box. */
function FilterGlyph({ filtered }: { filtered: boolean }) {
  return (
    <svg viewBox="0 0 10 10" width="100%" height="100%" aria-hidden="true">
      {filtered ? (
        <path d="M1 2h8L6 5.5V9L4 8V5.5z" fill="#2b6cb0" />
      ) : (
        <path d="M2 3.5h6L5 7z" fill="#3a3a38" />
      )}
    </svg>
  );
}

/** What sits on cells, in frame points (sheet ADR 517): the AutoFilter's
 *  header buttons, the active cell's list button and list, and its input
 *  message. */
function CellChrome({
  session,
  scene,
  headW,
  headH,
  active,
  editing,
  prompt,
  listOpen,
  listIndex,
  filter,
  onListOpen,
  focusEditor,
}: {
  session: FrameSurfaceSession;
  scene: GridScene | null;
  headW: number;
  headH: number;
  active: { row: number; col: number } | null;
  editing: boolean;
  prompt: ReturnType<FrameSurfaceSession["cellPrompt"]>;
  listOpen: boolean;
  listIndex: number;
  filter: ReturnType<FrameSurfaceSession["filterButtons"]>;
  onListOpen: () => void;
  focusEditor: () => void;
}) {
  if (!scene) return null;
  const stop = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const rect = active ? cellRect(scene, active.row, active.col) : null;
  const items = prompt?.items ?? null;
  const onHeader =
    !!filter &&
    !!active &&
    active.row === filter.row &&
    active.col >= filter.left &&
    active.col <= filter.right;
  const btn: CSSProperties = {
    position: "absolute",
    padding: 0,
    margin: 0,
    border: "1px solid #a8a8a4",
    borderRadius: 1,
    background: "#f3f3f1",
    cursor: "pointer",
    boxSizing: "border-box",
    zIndex: 1,
  };
  return (
    <>
      {rect && items && !onHeader ? (
        <button
          type="button"
          data-testid="sheet-list-button"
          aria-label="Choose from list"
          aria-expanded={listOpen}
          tabIndex={-1}
          style={{
            ...btn,
            left: headW + rect[2] + 1,
            top: headH + rect[1],
            width: Math.min(14, rect[3] - rect[1]),
            height: rect[3] - rect[1],
          }}
          onPointerDown={stop}
          onClick={() => {
            if (editing) session.commitCellEdit();
            if (!listOpen) onListOpen();
            session.openCellDropdown(!listOpen);
            focusEditor();
          }}
        >
          <FilterGlyph filtered={false} />
        </button>
      ) : null}
      {rect && items && listOpen ? (
        <ul
          data-testid="sheet-list"
          role="listbox"
          style={{
            position: "absolute",
            left: headW + rect[0],
            top: headH + rect[3] + 1,
            minWidth: rect[2] - rect[0] + 14,
            maxHeight: 8 * 13,
            overflowY: "auto",
            margin: 0,
            padding: 1,
            listStyle: "none",
            background: "#ffffff",
            border: "1px solid #a8a8a4",
            boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
            font: `${EDITOR_FONT_PT - 1}px sans-serif`,
            color: "#1a1a1a",
            zIndex: 2,
          }}
        >
          {items.map((it, i) => (
            <li
              key={`${i}:${it}`}
              role="option"
              aria-selected={i === listIndex}
              style={{
                padding: "1px 4px",
                whiteSpace: "nowrap",
                background: i === listIndex ? "#dfe7f1" : "transparent",
              }}
              onPointerDown={(e) => {
                stop(e);
                session.chooseListItem(it);
                focusEditor();
              }}
            >
              {it === "" ? "\u00a0" : it}
            </li>
          ))}
        </ul>
      ) : null}
      {rect && prompt && (prompt.title || prompt.message) && !listOpen ? (
        <div
          data-testid="sheet-input-message"
          role="note"
          style={{
            position: "absolute",
            left: headW + rect[2] + (items ? 16 : 4),
            top: headH + rect[3] + 2,
            maxWidth: 160,
            padding: "3px 5px",
            background: "#ffffe1",
            border: "1px solid #a8a8a4",
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            font: `${EDITOR_FONT_PT - 1}px sans-serif`,
            color: "#1a1a1a",
            whiteSpace: "pre-wrap",
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          {prompt.title ? <strong>{prompt.title}</strong> : null}
          {prompt.title && prompt.message ? <br /> : null}
          {prompt.message}
        </div>
      ) : null}
    </>
  );
}

// ── the bar: name box, formula, status ─────────────────────────────────

function SheetBarView({
  link,
  ...props
}: FrameSurfaceProps & { link: SurfaceLink }) {
  const session = link.session;
  const focusGrid = () => editors.get(link)?.focus({ preventScroll: true });
  const view = useSessionView(session, () => {
    const edit = session.cellEditState();
    const active = session.activeCell();
    const st = session.state();
    const sel = st.gridSelection;
    return {
      edit,
      active,
      input: edit
        ? edit.text
        : active
          ? formulaShown(session, active.row, active.col)
          : "",
      name: sel
        ? a1Of(
            sel.anchorRow,
            sel.anchorCol,
            sel.anchorRow + sel.rows - 1,
            sel.anchorCol + sel.cols - 1,
          )
        : active
          ? a1Of(active.row, active.col)
          : "",
      sheet: session.sheets().find((s) => s.id === st.activeSheet)?.name ?? "",
      sheetId: st.activeSheet,
      sheetList: session.sheets().map((x) => ({ id: x.id, name: x.name })),
      stats:
        sel && (sel.rows > 1 || sel.cols > 1) ? session.selectionStats() : null,
      pasteSpecial: session.pasteSpecialOpen(),
      // P7 — the document references on the active cell.
      docStyle: (() => {
        const cs = session.styleAtTarget();
        return {
          para: cs?.docParaStyle ?? "",
          fill: cs?.fillSwatch?.id ?? null,
          text: cs?.fontSwatch?.id ?? null,
        };
      })(),
      alert: session.entryAlert(),
      card: session.dataCard(),
      filterHeader: filterHeaderText(session),
      // ADR 510 — a window frame's lock (null: not a window frame).
      lock: session.frameView(props.elementId)?.lock ?? null,
    };
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement !== el && el.value !== view.input)
      el.value = view.input;
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
    <div style={{ position: "relative" }}>
      <div data-testid="sheet-bar" style={bar}>
        <span
          data-testid="sheet-bar-name"
          style={{ ...box, minWidth: 54, textAlign: "center" }}
        >
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
        <span
          style={{ color: "var(--pg-muted-fg, #5b5b57)", fontStyle: "italic" }}
        >
          fx
        </span>
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
        <DocumentStylePickers
          session={session}
          current={view.docStyle}
          box={box}
          button={button}
          card={bar}
          done={() => requestAnimationFrame(focusGrid)}
        />
        {view.stats && view.stats.count > 0 ? (
          <span
            data-testid="sheet-bar-stats"
            style={{
              color: "var(--pg-muted-fg, #5b5b57)",
              whiteSpace: "nowrap",
            }}
          >
            {view.stats.numbers > 0
              ? `Sum ${view.stats.sumDisplay} · Average ${view.stats.averageDisplay} · `
              : ""}
            Count {view.stats.count}
          </span>
        ) : null}
        <select
          data-testid="sheet-bar-sheet"
          aria-label="Sheet"
          value={view.sheetId ?? ""}
          style={{ ...box, whiteSpace: "nowrap" }}
          onChange={(e) => {
            session.setFrameSheet(Number(e.currentTarget.value));
            requestAnimationFrame(focusGrid);
          }}
        >
          {view.sheetList.map((sh) => (
            <option key={sh.id} value={sh.id}>
              {sh.name}
            </option>
          ))}
        </select>
        {view.lock !== null ? (
          <button
            type="button"
            data-testid="sheet-bar-lock"
            aria-label="Lock view"
            aria-pressed={view.lock}
            title={
              view.lock
                ? "View locked: leaving the frame keeps this window"
                : "Lock view: keep the page on this window when you leave"
            }
            style={{
              ...button,
              ...(view.lock
                ? { background: "var(--pg-accent-bg, #e6eefc)" }
                : null),
            }}
            onClick={() => {
              session.setFrameViewLock(!view.lock, props.elementId);
              requestAnimationFrame(focusGrid);
            }}
          >
            {view.lock ? "🔒" : "🔓"}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Full screen"
          title="Full screen"
          style={button}
          onClick={() => {
            props.requestPresentation(
              props.presentation === "fullscreen" ? "frame" : "fullscreen",
            );
            // The grid keeps the keys, as after any bar button.
            requestAnimationFrame(focusGrid);
          }}
        >
          ⤢
        </button>
      </div>
      <DataCards
        session={session}
        chrome={{
          style: bar,
          button,
          done: () => requestAnimationFrame(focusGrid),
        }}
        card={view.card}
        alert={view.alert}
        filterHeader={view.filterHeader}
      />
      {view.pasteSpecial ? (
        <PasteSpecialCard
          session={session}
          style={bar}
          button={button}
          done={() => requestAnimationFrame(focusGrid)}
        />
      ) : null}
    </div>
  );
}

/** The bar's formula: the cell's input, or nothing for a hidden formula on
 *  a protected sheet (sheet ADR 517). */
function formulaShown(
  session: FrameSurfaceSession,
  row: number,
  col: number,
): string {
  const p = session.cellProtectionAt(row, col);
  if (p?.sheetProtected && p.formulaHidden) return "";
  return session.cellInputAt(row, col);
}

/** The header text of the column the filter menu is open on. */
function filterHeaderText(session: FrameSurfaceSession): string {
  const card = session.dataCard();
  const fb = session.filterButtons();
  if (card?.kind !== "filter" || !fb) return "";
  return session.cellInputAt(fb.row, card.col);
}

// ── document styles on the bar: paragraph style, fill and text swatch ──

type StyleChoices = {
  paragraphStyles: { id: string; name: string }[];
  swatches: { id: string; name: string; rgbHex: string }[];
};

/** The document's choices, re-read when its styles may have changed. */
function useStyleChoices(session: FrameSurfaceSession): StyleChoices {
  const revision = useSessionView(session, () =>
    session.documentStyleRevision(),
  );
  const [choices, setChoices] = useState<StyleChoices>({
    paragraphStyles: [],
    swatches: [],
  });
  useEffect(() => {
    let live = true;
    void session.documentStyleChoices().then((c) => {
      if (live) setChoices(c);
    });
    return () => {
      live = false;
    };
  }, [session, revision]);
  return choices;
}

function DocumentStylePickers({
  session,
  current,
  box,
  button,
  card,
  done,
}: {
  session: FrameSurfaceSession;
  current: { para: string; fill: string | null; text: string | null };
  box: CSSProperties;
  button: CSSProperties;
  card: CSSProperties;
  done: () => void;
}) {
  const choices = useStyleChoices(session);
  const [open, setOpen] = useState<"fill" | "text" | null>(null);
  const colorOf = (id: string | null) =>
    choices.swatches.find((x) => x.id === id)?.rgbHex ?? null;
  const chip = (rgb: string | null): CSSProperties => ({
    display: "inline-block",
    width: 12,
    height: 12,
    borderRadius: 2,
    border: "1px solid var(--pg-border, #c9c9c4)",
    background:
      rgb ??
      "linear-gradient(to top right, transparent 45%, #d33 45%, #d33 55%, transparent 55%)",
    verticalAlign: "middle",
  });
  const pick = (id: string | null) => {
    const target = open;
    setOpen(null);
    if (!target) return;
    void session.applyDocumentSwatch(target, id).then(done);
  };
  return (
    <span style={{ position: "relative", display: "inline-flex", gap: 4 }}>
      <select
        data-testid="sheet-bar-style"
        aria-label="Paragraph style"
        title="Paragraph style (document)"
        value={current.para}
        style={{ ...box, maxWidth: 140 }}
        onChange={(e) => {
          session.setStyle({ docParaStyle: e.currentTarget.value });
          done();
        }}
      >
        <option value="">No paragraph style</option>
        {choices.paragraphStyles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="sheet-bar-fill"
        aria-label="Cell fill"
        title="Cell fill (document swatch)"
        aria-expanded={open === "fill"}
        style={button}
        onClick={() => setOpen(open === "fill" ? null : "fill")}
      >
        <span style={chip(colorOf(current.fill))} /> ▾
      </button>
      <button
        type="button"
        data-testid="sheet-bar-text-color"
        aria-label="Text colour"
        title="Text colour (document swatch)"
        aria-expanded={open === "text"}
        style={button}
        onClick={() => setOpen(open === "text" ? null : "text")}
      >
        A <span style={chip(colorOf(current.text))} />
      </button>
      {open ? (
        <div
          data-testid="sheet-swatch-picker"
          role="listbox"
          aria-label={open === "fill" ? "Cell fill" : "Text colour"}
          style={{
            ...card,
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            minWidth: 0,
            width: 196,
            flexWrap: "wrap",
            gap: 4,
            padding: 8,
            zIndex: 1,
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(null);
              done();
            }
          }}
        >
          <button
            type="button"
            role="option"
            aria-selected={
              (open === "fill" ? current.fill : current.text) === null
            }
            title="None"
            data-swatch=""
            style={{ ...button, padding: 2 }}
            onClick={() => pick(null)}
          >
            <span style={chip(null)} />
          </button>
          {choices.swatches.map((sw) => (
            <button
              key={sw.id}
              type="button"
              role="option"
              aria-selected={
                (open === "fill" ? current.fill : current.text) === sw.id
              }
              title={sw.name}
              data-swatch={sw.id}
              style={{ ...button, padding: 2 }}
              onClick={() => pick(sw.id)}
            >
              <span style={chip(sw.rgbHex)} />
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

// ── paste special: the options card under the bar ─────────────────────

type PasteWhat = "all" | "formulas" | "values";
type PasteOperation = "none" | "add" | "subtract" | "multiply" | "divide";

const PASTE_WHAT: [PasteWhat, string][] = [
  ["all", "All"],
  ["formulas", "Formulas"],
  ["values", "Values"],
];
const PASTE_OPERATIONS: [PasteOperation, string][] = [
  ["none", "None"],
  ["add", "Add"],
  ["subtract", "Subtract"],
  ["multiply", "Multiply"],
  ["divide", "Divide"],
];

function PasteSpecialCard({
  session,
  style,
  button,
  done,
}: {
  session: FrameSurfaceSession;
  style: CSSProperties;
  button: CSSProperties;
  done: () => void;
}) {
  const [what, setWhat] = useState<PasteWhat>("all");
  const [operation, setOperation] = useState<PasteOperation>("none");
  const [skipBlanks, setSkipBlanks] = useState(false);
  const [transpose, setTranspose] = useState(false);
  const paste = () => {
    void session
      .pasteAtSelection({ what, operation, skipBlanks, transpose })
      .then(done);
  };
  const cancel = () => {
    session.closePasteSpecial();
    done();
  };
  const group: CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  };
  return (
    <div
      data-testid="sheet-paste-special"
      role="dialog"
      aria-label="Paste special"
      style={{
        ...style,
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        minWidth: 300,
        flexDirection: "column",
        alignItems: "stretch",
        gap: 8,
        padding: 10,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          paste();
        }
      }}
    >
      <div role="radiogroup" aria-label="Paste" style={group}>
        <strong>Paste</strong>
        {PASTE_WHAT.map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="paste-what"
              checked={what === value}
              onChange={() => setWhat(value)}
            />{" "}
            {label}
          </label>
        ))}
      </div>
      <div role="radiogroup" aria-label="Operation" style={group}>
        <strong>Operation</strong>
        {PASTE_OPERATIONS.map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="paste-operation"
              checked={operation === value}
              onChange={() => setOperation(value)}
            />{" "}
            {label}
          </label>
        ))}
      </div>
      <div style={group}>
        <label>
          <input
            type="checkbox"
            checked={skipBlanks}
            onChange={(e) => setSkipBlanks(e.currentTarget.checked)}
          />{" "}
          Skip blanks
        </label>
        <label>
          <input
            type="checkbox"
            checked={transpose}
            onChange={(e) => setTranspose(e.currentTarget.checked)}
          />{" "}
          Transpose
        </label>
      </div>
      <div style={{ ...group, justifyContent: "flex-end" }}>
        <button type="button" style={button} onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="sheet-paste-special-ok"
          style={button}
          onClick={paste}
        >
          OK
        </button>
      </div>
    </div>
  );
}
