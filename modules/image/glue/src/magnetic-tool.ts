// The MAGNETIC LASSO tool and the REFINE EDGE brush (image ADR 470,
// WP5.5) — thin gestures over the engine's doors, mapped through the
// same frame fit as every selection tool.
//
// MAGNETIC LASSO. A click starts the outline at the nearest edge; moving
// the pointer pulls a live wire along the strongest edges (the engine's
// Dijkstra over the gradient magnitude), dropping anchors by itself as
// the wire grows (the Frequency option). A click fixes an anchor;
// Backspace removes the newest; Enter, or a click on the first anchor,
// closes the outline into the selection; Escape abandons. Modifiers at
// the first click choose the combine mode (shift add, alt subtract,
// both intersect).
//
// REFINE EDGE BRUSH. While Select and Mask is open, a drag marks the
// band the edge is re-solved in (Alt erases the marks); each sample
// re-runs the refine preview.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import {
  imageToPage as toPage,
  pageToImage as toImage,
  resolveFrameFit,
  type FitTransform,
} from "./frame-fit";
import type { MaskMode } from "./masking-engine";
import { modeFromModifiers } from "./selection-machine";
import type { ImageSession } from "./session";

/** Screen px within which a click on the first anchor closes. */
const CLOSE_TOLERANCE_PX = 8;

function pairs(flat: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

export function makeMagneticGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let active = false;
  let mode: MaskMode = "replace";
  let outline: Array<[number, number]> = [];

  const render = () => {
    if (!fit || outline.length < 2) {
      host.overlay.setToolPreview(null);
      return;
    }
    const pts = outline.map((p) => toPage(fit, p));
    host.overlay.setToolPreview({
      pageId: fit.pageId,
      anchors: pts.map((p) => ({ anchor: p, left: p, right: p })),
      close: false,
      dashed: true,
    });
  };

  const engine = () => session.masking().engine();

  const finish = (close: boolean) => {
    const e = engine();
    if (e && active) {
      try {
        if (close) {
          if (e.magneticClose(mode)) session.refreshSelection();
        } else e.magneticCancel();
      } catch (err) {
        host.log.debug("magnetic lasso failed", err);
      }
    }
    active = false;
    outline = [];
    render();
  };

  return {
    onActivate() {
      void resolveFrameFit(host, session.state().source, "magnetic lasso").then(
        (f) => {
          fit = f;
        },
      );
    },
    onDeactivate() {
      if (active) finish(false);
      host.overlay.setToolPreview(null);
      fit = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      const eng = engine();
      if (!eng || !fit || !e.pagePoint) return;
      const [x, y] = toImage(fit, e.pagePoint);
      try {
        if (!active) {
          mode = modeFromModifiers(e.modifiers);
          outline = pairs(
            eng.magneticBegin(x, y, session.masking().magneticOptions()),
          );
          active = true;
        } else {
          const first = eng.magneticAnchors().slice(0, 2);
          const tol = CLOSE_TOLERANCE_PX / Math.max(fit.scale, 1e-6);
          const anchors = eng.magneticAnchors().length / 2;
          if (
            anchors >= 3 &&
            first.length === 2 &&
            (x - first[0]) ** 2 + (y - first[1]) ** 2 <= tol * tol
          ) {
            finish(true);
            return;
          }
          outline = pairs(eng.magneticAnchor(x, y));
        }
      } catch (err) {
        host.log.debug("magnetic lasso failed", err);
        finish(false);
        return;
      }
      render();
    },
    onPointerMove(e: CanvasPointerEvent) {
      const eng = engine();
      if (!active || !eng || !fit || !e.pagePoint) return;
      const [x, y] = toImage(fit, e.pagePoint);
      try {
        outline = pairs(eng.magneticMove(x, y));
      } catch (err) {
        host.log.debug("magnetic lasso failed", err);
      }
      render();
    },
    onKey(e: KeyboardEvent) {
      if (!active) return;
      const eng = engine();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      else if ((e.key === "Backspace" || e.key === "Delete") && eng) {
        outline = pairs(eng.magneticUndoAnchor());
        render();
      } else return;
      e.preventDefault();
    },
    onPointerUp() {
      // Anchors are clicks; the release has nothing to add.
    },
  };
}

export function makeRefineBrushGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let erase = false;
  let down = false;

  const paint = (e: CanvasPointerEvent) => {
    if (!fit || !e.pagePoint) return;
    const [x, y] = toImage(fit, e.pagePoint);
    void session.masking().refineBrush(x, y, erase);
  };

  return {
    onActivate() {
      void resolveFrameFit(host, session.state().source, "refine edge").then(
        (f) => {
          fit = f;
        },
      );
    },
    onDeactivate() {
      fit = null;
      down = false;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!session.masking().state().refine) {
        session.masking().refineHint();
        return;
      }
      erase = e.modifiers.alt;
      down = true;
      paint(e);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (down) paint(e);
    },
    onPointerUp() {
      down = false;
    },
  };
}
