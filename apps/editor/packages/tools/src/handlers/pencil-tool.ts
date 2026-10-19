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

// Editor-ops — the Pencil tool's gesture handler: THE one Pencil
// (modules/draw ADR 359). paged.draw's own Pencil was retired into this
// one; the stroke logic is draw-tools' `PencilMachine`, the same tested
// machine the bundle's brushes compose, so this file is a thin shim
// (the Pen / `PenMachine` division of labour, draw ADR 350).
//
// Freehand drag → pointer samples (page-local pt, anchored to the START
// page; a stroke may wander off it) → the machine decimates them,
// simplifies them with Ramer-Douglas-Peucker at a tolerance that is
// constant in SCREEN px (converted to pt at the current zoom), and closes
// the contour when the pen lifts within the close distance of where it
// started → one `insertPath` Mutation. With "Smooth curves" (the default)
// the anchors go as corners with `smooth: true` and the ENGINE runs its
// Schneider fit over them (draw ADR 353: path algebra runs in the
// engine), so the committed path is smooth cubics, not the jittery
// samples; "Corner points" keeps the simplified polyline. A click is not
// a stroke and commits nothing. One stroke per element — lift-and-redraw
// starts a new path.
//
// B-08 variable-width strokes: when an OPEN stroke is drawn with a PEN
// (`pointerType === "pen"`), the per-anchor pressure the machine carries
// becomes a width profile that the engine's `OutlineStrokeVariable` op
// bakes into a tapered filled outline — committed alongside the
// `insertPath` in ONE undo step via a `batch` whose property child
// addresses the just-minted path through the `$created` sentinel
// (protocol v34/v36). A mouse (no real pressure) keeps the plain stroke.
//
// OPTIONS (double-click the slot; settings `paged.tool.pencil.<key>`):
// fidelity (px), smoothing, close distance (px). The popover shows an
// unset number as its `min`, so activating the tool seeds each unset
// default into the store; every value is read again at the next press.

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
  ToolOptionField,
} from "@paged-media/shell";

import { strokeWidthFromPressure } from "@paged-media/draw/geometry";
import { PencilMachine, type PencilSnapshot } from "@paged-media/draw/machines";

import {
  beginPageDrag,
  endLocalFor,
  mutateGraphicAndSelect,
  pxToPt,
  type PageDrag,
} from "./shared";

/** The settings namespace of the Pencil's options. */
export const PENCIL_TOOL_ID = "paged.tool.pencil";

/** The Pencil's options as the rail's popover shows them, with the
 *  defaults the handler uses while a value is unset. */
export const PENCIL_OPTION_FIELDS: ToolOptionField[] = [
  {
    kind: "number",
    key: "fidelity",
    label: "Fidelity",
    min: 0.5,
    max: 20,
    step: 0.5,
    unit: "px",
  },
  {
    // The default first: an unset select shows its first option.
    kind: "select",
    key: "smoothing",
    label: "Smoothing",
    options: [
      { value: "smooth", label: "Smooth curves" },
      { value: "corners", label: "Corner points" },
    ],
  },
  {
    kind: "number",
    key: "closeDistance",
    label: "Close within",
    min: 0,
    max: 50,
    step: 1,
    unit: "px",
  },
];

/** ~1.5 px of screen-space simplification keeps the gesture's intent
 *  while shedding the pointer-event noise the curve fitter would
 *  otherwise chase; lifting within 8 px of the start closes the path. */
export const PENCIL_DEFAULTS = {
  fidelity: 1.5,
  smoothing: "smooth",
  closeDistance: 8,
} as const;

/** Pen width ramp (pt): pressure 0 → hairline, pressure 1 → bold. The
 *  engine lerps this profile across the committed centreline's arc
 *  length, so the stop count need not match the anchor count. */
const PEN_WIDTH_PROFILE = { min: 0.5, max: 4 };
/** Cap the profile so a long stroke stays a compact op. */
const MAX_WIDTH_STOPS = 48;

/** Pick at most `n` evenly-spaced samples (endpoints always kept), so a
 *  dense pressure stream collapses to a bounded width profile. */
function sampleEvenly(values: number[], n: number): number[] {
  if (n >= values.length || values.length <= 2) return values.slice();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(values[Math.round((i * (values.length - 1)) / (n - 1))]);
  }
  return out;
}

/** A number option, clamped to its field; the default when unset or not
 *  a finite number. */
function numberOption(
  paged: PagedEditor,
  key: "fidelity" | "closeDistance",
): number {
  const field = PENCIL_OPTION_FIELDS.find((f) => f.key === key) as {
    min: number;
    max: number;
  };
  const raw = paged.toolSettings.getValue(PENCIL_TOOL_ID, key);
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : PENCIL_DEFAULTS[key];
  return Math.min(field.max, Math.max(field.min, n));
}

function smoothingOption(paged: PagedEditor): "smooth" | "corners" {
  const raw = paged.toolSettings.getValue(PENCIL_TOOL_ID, "smoothing");
  return raw === "corners" ? "corners" : "smooth";
}

/** Write each still-unset default into the store, so the popover shows
 *  the value the next stroke uses. Never overwrites a set value. */
function seedDefaults(paged: PagedEditor): void {
  for (const [key, value] of Object.entries(PENCIL_DEFAULTS)) {
    if (paged.toolSettings.getValue(PENCIL_TOOL_ID, key) === undefined) {
      paged.toolSettings.set(PENCIL_TOOL_ID, key, value);
    }
  }
}

export function createPencilHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  let drag: PageDrag | null = null;
  let machine: PencilMachine | null = null;
  let smooth = true;
  let pointerType = "mouse";

  const cancel = () => {
    paged?.overlaySignals.setToolPreview(null);
    drag = null;
    machine = null;
  };

  const commit = (
    editor: PagedEditor,
    pageId: string,
    snapshot: PencilSnapshot,
  ) => {
    const c = snapshot.commit;
    if (!c) return;
    // A pen drives the tapered outline (open strokes: the engine's
    // variable outline is open-path only); a mouse stays a plain stroke.
    const widths =
      pointerType === "pen" && c.open
        ? sampleEvenly(
            c.pressures,
            Math.min(c.anchors.length, MAX_WIDTH_STOPS),
          ).map((p) => strokeWidthFromPressure(p, PEN_WIDTH_PROFILE))
        : null;
    const insert = {
      op: "insertPath" as const,
      args: { pageId, anchors: c.anchors, open: c.open, smooth },
    };
    if (widths && widths.length >= 2) {
      // One undo step: insert the centreline, then bake the
      // pressure-driven variable-width outline onto it. The property
      // child targets the freshly-minted path via `$created` (the
      // sentinel's `kind` is irrelevant — the engine replaces the whole
      // id with the real one before applying).
      void mutateGraphicAndSelect(
        editor,
        {
          op: "batch",
          args: {
            ops: [
              insert,
              {
                op: "setElementProperty",
                args: {
                  elementId: { kind: "polygon", id: "$created" },
                  path: "outlineStrokeVariable",
                  value: {
                    type: "outlineStrokeVariable",
                    value: {
                      widths,
                      cap: "round",
                      join: "round",
                      miterLimit: 4,
                      prevAnchors: null,
                      prevSubpathStarts: null,
                      prevSubpathOpen: null,
                    },
                  },
                },
              },
            ],
          },
        },
        "insertPath(variable-width)",
      );
    } else {
      void mutateGraphicAndSelect(editor, insert, "insertPath");
    }
  };

  return {
    onActivate(p) {
      paged = p;
      seedDefaults(p);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      cancel();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!paged) return;
      drag = beginPageDrag(e);
      if (!drag) return;
      smooth = smoothingOption(paged) === "smooth";
      pointerType = e.pointerType;
      machine = new PencilMachine({
        tolerance: pxToPt(paged, numberOption(paged, "fidelity")),
        closeTolerance: pxToPt(paged, numberOption(paged, "closeDistance")),
        // The engine fits the curve; the machine keeps the simplified
        // samples as corner anchors.
        smooth: false,
      });
      machine.handle({
        type: "down",
        point: drag.startLocal,
        pressure: e.pressure,
      });
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!paged || !drag || !machine) return;
      const snap = machine.handle({
        type: "move",
        point: endLocalFor(drag, e),
        pressure: e.pressure,
      });
      // The machine's (decimated) samples, the one array a stroke hands
      // the overlay; the overlay only reads it.
      paged.overlaySignals.setToolPreview({
        pageId: drag.pageId,
        points: snap.points as [number, number][],
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!paged || !drag || !machine) {
        cancel();
        return;
      }
      const { pageId } = drag;
      const snap = machine.handle({
        type: "up",
        point: endLocalFor(drag, e),
        pressure: e.pressure,
      });
      const editor = paged;
      cancel();
      commit(editor, pageId, snap);
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    },
  };
}
