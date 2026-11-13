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

// The divider between a dock and the canvas (editor ADR "Docks are
// resizable and the workspace adapts"): drag it to resize the dock,
// double-click it to restore the dock's default width. It is a WAI-ARIA
// window splitter — a focusable `separator` whose value is the dock's
// width: the arrows move it (Shift for larger steps), Home and End jump to
// the bounds, Enter restores the default.
//
// A zero-width flex item between the columns, so the 6 px hit area it
// draws can straddle the hairline without taking layout width; the canvas
// beside it keeps the document point at its centre while it resizes
// (camera-context's `anchorViewportResize`, UXI-CAM-003).

import { useRef, useState } from "react";

import {
  DOCK_DEFAULT_PX,
  DOCK_MIN_PX,
  clampDockWidth,
  dockWidthForKey,
  type DockId,
} from "./dock-sizing";

export interface DockSplitterProps {
  dock: DockId;
  /** Where the dock sits relative to the canvas: `start` (left of it) or
   *  `end` (right of it). Dragging toward the canvas grows the dock. */
  side: "start" | "end";
  /** The dock's width now (CSS px). */
  width: number;
  /** The widest it may go now (the canvas keeps its working minimum). */
  max: number;
  /** The accessible name, e.g. "Resize panels". */
  label: string;
  /** The dock element's id (`aria-controls`). */
  controls?: string;
  /** A new width, while dragging and on a key press; the caller holds
   *  and remembers it. */
  onResize: (width: number) => void;
}

export function DockSplitter({
  dock,
  side,
  width,
  max,
  label,
  controls,
  onResize,
}: DockSplitterProps) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const [active, setActive] = useState(false);

  const widthAt = (clientX: number): number => {
    const d = drag.current;
    if (!d) return width;
    const dx = clientX - d.x;
    const next = side === "start" ? d.width + dx : d.width - dx;
    return Math.min(max, clampDockWidth(dock, next));
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setActive(false);
    onResize(widthAt(e.clientX));
  };

  return (
    <div style={{ position: "relative", width: 0, flexShrink: 0, zIndex: 20 }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-controls={controls}
        aria-valuenow={Math.round(width)}
        aria-valuemin={DOCK_MIN_PX}
        aria-valuemax={Math.max(DOCK_MIN_PX, Math.round(max))}
        tabIndex={0}
        data-dock-splitter={dock}
        data-dragging={active || undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { pointerId: e.pointerId, x: e.clientX, width };
          setActive(true);
        }}
        onPointerMove={(e) => {
          if (drag.current?.pointerId !== e.pointerId) return;
          onResize(widthAt(e.clientX));
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => onResize(DOCK_DEFAULT_PX[dock])}
        onKeyDown={(e) => {
          const next = dockWidthForKey(
            dock,
            side,
            width,
            e.key,
            e.shiftKey,
            max,
          );
          if (next === null) return;
          // The divider's keys are its own: no shortcut (a nudge on the
          // arrows, Enter into a selection) sees them.
          e.preventDefault();
          e.stopPropagation();
          onResize(next);
        }}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: -3,
          width: 6,
          cursor: "col-resize",
          touchAction: "none",
        }}
        // Hover, focus and a drag tint it (globals.css).
        className="pg-dock-splitter"
      />
    </div>
  );
}
