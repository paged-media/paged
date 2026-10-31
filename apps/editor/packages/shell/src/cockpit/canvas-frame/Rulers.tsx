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

// Cockpit — the canvas rulers (kit canvas.jsx HRuler + the sticky
// left strip). REAL: marks are document-space coordinates mapped
// through the live camera (scale + translate), so they track zoom
// and pan like a DTP ruler must.
//
// W2.8 — each ruler strip is also a GUIDE hit zone: a pointer-down
// anywhere on the strip drags a new guide out onto the canvas (GD-01).
// HRuler → horizontal guides, VRulerStrip → vertical, matching
// InDesign. Works with ANY active tool (no tool switch) — the strip
// captures the pointer-down before it reaches the viewport / tool
// spine. The controller (GuideDragController) tracks the rest of the
// drag and commits on release; here we only START it.

//
// Extensions ADR 340 — while an edit context supplies a WORKSPACE (a
// raster image), the rulers measure IT: zero at its origin, counting in
// its unit (pixels, inches, …), and a guide dragged out lands in the
// context instead of on the spread.

import { useContextWorkspace } from "../../catalog/binding-providers";
import { useCamera } from "../../state/camera-context";
import { ptPerRulerUnit } from "../../state/context-workspace";
import { useOptionalDocument } from "../../state/document-context";
import { useOptionalGuideDrag } from "../../state/guide-drag-context";
import { layoutPageRects } from "./page-layout";
import { RULER_LABEL_INSET, rulerMarks } from "./ruler-marks";

/** The frame the rulers count in: document pt per ruler unit and the
 *  document coordinate of the zero, per axis — the page's (pt from the
 *  document origin) or the active context's workspace. */
interface RulerFrame {
  unit: string | null;
  ptPerUnit: number;
  zero: [number, number];
}

const PAGE_FRAME: RulerFrame = { unit: null, ptPerUnit: 1, zero: [0, 0] };

function useRulerFrame(): RulerFrame {
  const ctx = useContextWorkspace();
  const handle = useOptionalDocument()?.handle ?? null;
  if (!ctx || !handle) return PAGE_FRAME;
  const ws = ctx.workspace;
  const index = handle.pageIds.indexOf(ws.pageId);
  const page = index >= 0 ? layoutPageRects(handle.pageSizesPt)[index] : null;
  if (!page) return PAGE_FRAME;
  return {
    unit: ws.unit.label,
    ptPerUnit: ptPerRulerUnit(ws),
    zero: [page.x + ws.origin[0], page.y + ws.origin[1]],
  };
}

export function HRuler() {
  const { camera, viewportSize } = useCamera();
  const guideDrag = useOptionalGuideDrag();
  const frame = useRulerFrame();
  // Labels thinned so the widest one in view fits between two marks
  // (UX audit F-31, ADR 263).
  const marks = rulerMarks(
    camera.scale * frame.ptPerUnit,
    camera.tx + frame.zero[0] * camera.scale,
    viewportSize[0] || 0,
  );
  return (
    <div
      data-h-ruler
      data-ruler-unit={frame.unit ?? undefined}
      onPointerDown={
        guideDrag
          ? (e) => {
              // GD-01 — drag a HORIZONTAL guide out of the top ruler.
              if (e.button !== 0) return;
              e.preventDefault();
              guideDrag.beginCreate(
                "horizontal",
                frame.unit !== null ? "workspace" : "page",
              );
            }
          : undefined
      }
      style={{
        height: 22,
        position: "relative",
        background: "var(--chrome-panel-bg)",
        borderBottom: "1px solid var(--chrome-border)",
        overflow: "hidden",
        flexShrink: 0,
        marginLeft: 22,
        cursor: guideDrag ? "ns-resize" : undefined,
      }}
    >
      {marks.map((m) => (
        <div
          key={m.value}
          data-ruler-mark={m.value}
          style={{
            position: "absolute",
            left: m.px,
            top: 0,
            bottom: 0,
            borderLeft: "1px solid var(--chrome-divider)",
          }}
        >
          {m.label !== null && (
            <span
              data-ruler-label
              style={{
                position: "absolute",
                left: RULER_LABEL_INSET,
                top: 4,
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "var(--pg-muted-fg)",
                whiteSpace: "nowrap",
              }}
            >
              {m.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** The 22px vertical strip down the canvas's left edge (kit keeps it
 *  plain — a quiet ruler track). */
export function VRulerStrip() {
  const { camera, viewportSize } = useCamera();
  const guideDrag = useOptionalGuideDrag();
  const frame = useRulerFrame();
  const marks = rulerMarks(
    camera.scale * frame.ptPerUnit,
    camera.ty + frame.zero[1] * camera.scale,
    viewportSize[1] || 0,
  );
  return (
    <div
      data-v-ruler
      data-ruler-unit={frame.unit ?? undefined}
      onPointerDown={
        guideDrag
          ? (e) => {
              // GD-01 — drag a VERTICAL guide out of the left ruler.
              if (e.button !== 0) return;
              e.preventDefault();
              guideDrag.beginCreate(
                "vertical",
                frame.unit !== null ? "workspace" : "page",
              );
            }
          : undefined
      }
      style={{
        width: 22,
        position: "relative",
        background: "var(--chrome-panel-bg)",
        borderRight: "1px solid var(--chrome-border)",
        overflow: "hidden",
        flexShrink: 0,
        cursor: guideDrag ? "ew-resize" : undefined,
      }}
    >
      {marks.map((m) => (
        <div
          key={m.value}
          style={{
            position: "absolute",
            top: m.px,
            left: 0,
            right: 0,
            borderTop: "1px solid var(--chrome-divider)",
          }}
        />
      ))}
    </div>
  );
}
