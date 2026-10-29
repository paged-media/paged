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

// Editor-ops — the Gradient Swatch tool's gesture handler.
//
// Drag across the selected element(s) → the gradient AXIS: angle from
// the drag direction (renderer convention: 0° = left→right, 90° =
// top→bottom, i.e. y-down positive) and length from the drag extent
// in pt. Committed as ONE batch Mutation (angle + length per target)
// so the whole drag is a single undo step. The fill must already
// reference a `Gradient/<id>` swatch — the axis fields are inert on
// solid fills (the renderer only reads them for gradient paints).
// Shift constrains the axis to 45° increments.
//
// WP7.2 — the tool's `mode` option (double-click the slot) adds the two
// FREEFORM modes of engine ADR 1040, "Freeform points" and "Freeform
// lines", with a "Spread" option for new points; in them every pointer
// event goes to `freeform-gradient.ts` instead. "Linear" — the default,
// and what an unset option reads as — is the axis drag above, unchanged.

import type { Mutation } from "@paged-media/client";
import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
  ToolOptionField,
} from "@paged-media/shell";
import { t } from "@paged-media/strings";

import { GRADIENT_TOOL } from "../messages";
import {
  createFreeformGradientEditor,
  type FreeformMode,
} from "./freeform-gradient";

import {
  beginPageDrag,
  endLocalFor,
  CLICK_DRAG_THRESHOLD_PX,
  type PageDrag,
} from "./shared";

const MIN_LENGTH_PT = 1;

export const GRADIENT_SWATCH_TOOL_ID = "paged.tool.gradientSwatch";

export type GradientMode = "linear" | FreeformMode;

/** The tool's options: the mode (Linear listed first, so an unset value
 *  shows as the default it reads as) and the spread of new freeform
 *  points. The words are getters, read in the editor's locale when the
 *  popover shows them. */
export const GRADIENT_OPTION_FIELDS: ToolOptionField[] = [
  {
    kind: "select",
    key: "mode",
    get label() {
      return t(GRADIENT_TOOL.mode);
    },
    options: [
      {
        value: "linear",
        get label() {
          return t(GRADIENT_TOOL.linear);
        },
      },
      {
        value: "freeformPoints",
        get label() {
          return t(GRADIENT_TOOL.freeformPoints);
        },
      },
      {
        value: "freeformLines",
        get label() {
          return t(GRADIENT_TOOL.freeformLines);
        },
      },
    ],
  },
  {
    kind: "number",
    key: "spread",
    get label() {
      return t(GRADIENT_TOOL.spread);
    },
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
  },
];

/** The mode the tool's settings hold (Linear when unset or unknown). */
export function gradientModeOf(paged: PagedEditor): GradientMode {
  const raw = paged.toolSettings?.getValue(GRADIENT_SWATCH_TOOL_ID, "mode");
  return raw === "freeformPoints" || raw === "freeformLines" ? raw : "linear";
}

function spreadOf(paged: PagedEditor): number {
  const raw = paged.toolSettings?.getValue(GRADIENT_SWATCH_TOOL_ID, "spread");
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(100, Math.max(0, raw))
    : 0;
}

export function createGradientSwatchHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  let drag: PageDrag | null = null;
  const freeform = createFreeformGradientEditor(GRADIENT_SWATCH_TOOL_ID);
  let unsubscribeSettings: (() => void) | null = null;
  /** The mode this press started in: a gesture ends where it began. */
  let pressMode: GradientMode = "linear";

  const cancel = () => {
    paged?.overlaySignals.setToolPreview(null);
    drag = null;
  };

  const axisFor = (
    e: CanvasPointerEvent,
  ): { end: [number, number]; angleDeg: number; lengthPt: number } => {
    const end = endLocalFor(drag!, e);
    let dx = end[0] - drag!.startLocal[0];
    let dy = end[1] - drag!.startLocal[1];
    let angle = Math.atan2(dy, dx);
    if (e.modifiers.shift) {
      const step = Math.PI / 4;
      angle = Math.round(angle / step) * step;
      const len = Math.hypot(dx, dy);
      dx = len * Math.cos(angle);
      dy = len * Math.sin(angle);
    }
    return {
      end: [drag!.startLocal[0] + dx, drag!.startLocal[1] + dy],
      angleDeg: (angle * 180) / Math.PI,
      lengthPt: Math.hypot(dx, dy),
    };
  };

  return {
    onActivate(p) {
      paged = p;
      freeform.activate(p);
      freeform.show(gradientModeOf(p) !== "linear");
      unsubscribeSettings?.();
      unsubscribeSettings =
        p.toolSettings?.subscribe(GRADIENT_SWATCH_TOOL_ID, () => {
          if (paged) freeform.show(gradientModeOf(paged) !== "linear");
        }) ?? null;
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      cancel();
      unsubscribeSettings?.();
      unsubscribeSettings = null;
      freeform.deactivate();
      paged?.overlaySignals.setToolPreview(null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!paged) return;
      pressMode = gradientModeOf(paged);
      if (pressMode !== "linear") {
        freeform.show(true);
        freeform.pointerDown(e, pressMode);
        return;
      }
      if (paged.selection.elementSelection.length === 0) return;
      drag = beginPageDrag(e);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (paged && pressMode !== "linear") {
        freeform.pointerMove(e);
        return;
      }
      if (!paged || !drag) return;
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      const { end } = axisFor(e);
      paged.overlaySignals.setToolPreview({
        pageId: drag.pageId,
        points: [drag.startLocal, end],
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (paged && pressMode !== "linear") {
        freeform.pointerUp(e, pressMode, spreadOf(paged));
        return;
      }
      if (!paged || !drag) {
        cancel();
        return;
      }
      const targets = paged.selection.elementSelection.slice();
      const { angleDeg, lengthPt } = axisFor(e);
      cancel();
      // A click is not a drag at any zoom (INV-6, GT-1).
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      if (lengthPt < MIN_LENGTH_PT || targets.length === 0) return;
      const ops: Mutation[] = targets.flatMap((elementId): Mutation[] => [
        {
          op: "setElementProperty",
          args: {
            elementId,
            path: "frameGradientFillAngle",
            value: { type: "length", value: angleDeg },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId,
            path: "frameGradientFillLength",
            value: { type: "length", value: lengthPt },
          },
        },
      ]);
      void paged.client
        .mutate({ op: "batch", args: { ops } })
        .then((reply) => {
          if (reply.kind === "mutationFailed") {
            // eslint-disable-next-line no-console
            console.warn(
              "gradient axis rejected by engine:",
              JSON.stringify((reply as { payload?: unknown }).payload),
            );
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("gradient axis failed:", err);
        });
    },
    onKey(e: KeyboardEvent) {
      if (paged && gradientModeOf(paged) !== "linear") {
        freeform.key(e);
        return;
      }
      if (e.key === "Escape") cancel();
    },
  };
}
