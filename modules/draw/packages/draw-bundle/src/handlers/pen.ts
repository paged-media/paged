// The Pen tool's gesture handler — the bundle-owned version (D3).
// Identical behavior to the editor-incubated shim it replaces, now
// built ONLY from the public surface: the gesture kit from
// @paged-media/plugin-sdk (page anchoring, px→pt, commit+select) and
// the host-agnostic PenMachine from @paged-media/draw-tools. The
// modifier matrix and anchor state live in the machine; this file is
// host glue.

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/plugin-api";
import {
  beginPageDrag,
  commitAndSelect,
  endLocalFor,
  pxToPt,
  type PageDrag,
} from "@paged-media/plugin-sdk";

import { flattenAnchorRun } from "@paged-media/draw-geometry";
import {
  PenMachine,
  type PenModifiers,
  type PenSnapshot,
} from "@paged-media/draw-tools";

/** Screen-space radius for the click-first-anchor close. */
const CLOSE_TOLERANCE_PX = 6;
/** Pointer travel below which a down→up places a corner, not a
 *  smooth-handle drag. */
const DRAG_THRESHOLD_PX = 3;

export function createPenHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  let machine: PenMachine | null = null;
  let page: PageDrag | null = null;

  const reset = () => {
    machine = null;
    page = null;
    paged?.overlaySignals.setToolPreview(null);
  };

  /** Render/commit one machine snapshot. */
  const apply = (snap: PenSnapshot) => {
    if (!paged || !page) return;
    if (snap.commit) {
      const { pageId } = page;
      const { anchors, open } = snap.commit;
      reset();
      void commitAndSelect(
        paged,
        { op: "insertPath", args: { pageId, anchors, open } },
        "insertPath",
      );
      return;
    }
    if (!snap.active) {
      reset();
      return;
    }
    const points = flattenAnchorRun(snap.anchors, { close: snap.closePreview });
    if (snap.rubberTo) points.push([snap.rubberTo[0], snap.rubberTo[1]]);
    paged.overlaySignals.setToolPreview(
      points.length >= 2
        ? { pageId: page.pageId, points, close: snap.closePreview }
        : null,
    );
  };

  const mods = (e: CanvasPointerEvent): PenModifiers => ({
    shift: e.modifiers.shift,
    alt: e.modifiers.alt,
  });

  return {
    onActivate(p) {
      paged = p;
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      // A real tool switch COMMITS the in-progress path (Illustrator's
      // behaviour); a degenerate run cancels inside the machine.
      if (machine) apply(machine.handle({ type: "key", key: "Enter" }));
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!paged || e.button !== 0) return;
      if (!machine) {
        const start = beginPageDrag(e);
        if (!start) return; // pasteboard click — no page to draw on
        page = start;
        const scale = paged.camera.camera.scale;
        machine = new PenMachine({
          closeTolerance: pxToPt(scale, CLOSE_TOLERANCE_PX),
          dragThreshold: pxToPt(scale, DRAG_THRESHOLD_PX),
        });
      }
      if (!page) return;
      apply(
        machine.handle({
          type: "down",
          point: endLocalFor(page, e),
          modifiers: mods(e),
        }),
      );
    },
    onPointerMove(e: CanvasPointerEvent) {
      // Hover moves arrive too (the rubber band tracks them); the
      // machine distinguishes drag from hover internally.
      if (!machine || !page) return;
      apply(
        machine.handle({
          type: "move",
          point: endLocalFor(page, e),
          modifiers: mods(e),
        }),
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !page) return;
      apply(
        machine.handle({
          type: "up",
          point: endLocalFor(page, e),
          modifiers: mods(e),
        }),
      );
    },
    onKey(e: KeyboardEvent) {
      if (!machine) return;
      if (e.key === "Escape") {
        apply(machine.handle({ type: "key", key: "Escape" }));
      } else if (e.key === "Enter") {
        apply(machine.handle({ type: "key", key: "Enter" }));
      }
    },
  };
}
