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

// The sheet's FRAME SURFACE (sheet ADR 510, extensions ADR 334): the grid
// the user works in while the sheet frame is entered, drawn on the main
// thread over the frame. Row and column headings sit inside the frame;
// the cell area is the content box minus the heading strips. Every state
// it shows (window, selection, the open cell edit, the fill drag) is the
// session's, and every input goes through the session's existing grid
// operations, so the in-frame keyboard map and the undo journal are the
// same ones the edit context used before.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";

import {
  DEFAULT_HEADING_STYLE,
  paintGridScene,
  rowHeadingWidthPt,
  type GridScene,
} from "../../../sheet-host-model/src";
import type { WorkbookSession } from "../session";

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
>;

export function makeSheetFrameSurface(
  session: FrameSurfaceSession,
): ComponentType<FrameSurfaceProps> {
  return function SheetFrameSurface(props: FrameSurfaceProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [scene, setScene] = useState<GridScene | null>(null);
    const headW = rowHeadingWidthPt(scene?.viewport.firstRow ?? 0);
    const headH = DEFAULT_HEADING_STYLE.colHeightPt;
    const dragging = useRef(false);

    // The session windows the grid to the cell area and hands every state
    // here while the surface is mounted.
    useEffect(
      () =>
        session.attachFrameSurface(setScene, {
          wPt: props.widthPt - headW,
          hPt: props.heightPt - headH,
        }),
      [props.widthPt, props.heightPt, headW, headH],
    );

    // Keys go to the grid as soon as the frame is entered.
    useEffect(() => {
      rootRef.current?.focus({ preventScroll: true });
    }, []);

    // Paint at screen resolution: the context is scaled so one unit is one
    // point of frame content.
    useLayoutEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !scene) return;
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
      paintGridScene(ctx, scene, {
        headings: true,
        rowHeadingWidthPt: headW,
        widthPt: props.widthPt,
        heightPt: props.heightPt,
      });
    }, [scene, props.pxPerPt, props.widthPt, props.heightPt, headW]);

    // A client position in cell-area points, or null outside the cells.
    const cellPoint = (
      clientX: number,
      clientY: number,
    ): [number, number] | null => {
      const p = props.toContentPt(clientX, clientY);
      if (!p) return null;
      const x = p[0] - headW;
      const y = p[1] - headH;
      return x >= 0 && y >= 0 ? [x, y] : null;
    };

    return (
      <div
        ref={rootRef}
        tabIndex={0}
        role="grid"
        aria-label="Sheet"
        data-testid="sheet-frame-surface"
        style={{
          width: "100%",
          height: "100%",
          outline: "none",
          cursor: "cell",
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          rootRef.current?.focus({ preventScroll: true });
          const at = cellPoint(e.clientX, e.clientY);
          if (!at) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          dragging.current = true;
          session.pointerDownInFrame(at[0], at[1], { shift: e.shiftKey });
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          const at = cellPoint(e.clientX, e.clientY);
          if (at) session.pointerMoveInFrame(at[0], at[1]);
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          const at = cellPoint(e.clientX, e.clientY);
          if (at) session.pointerUpInFrame(at[0], at[1]);
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
        onKeyDown={(e) => {
          // Esc with no cell edit open leaves the frame (Excel's second Esc).
          if (e.key === "Escape" && !session.isCellEditing()) {
            e.preventDefault();
            props.exit({ commit: true });
            return;
          }
          if (session.handleGridKey(e)) e.preventDefault();
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
      </div>
    );
  };
}
