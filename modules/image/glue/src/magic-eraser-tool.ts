// The MAGIC ERASER: a click erases the colour region around the clicked
// pixel to transparency — the magic wand's region (tolerance,
// contiguous, anti-aliased, from the active layer or all layers), inside
// the selection, at the tool's opacity. One click, one journaled edit.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import { pageToImage, resolveFrameFit, type FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";

export function makeMagicEraserGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  return {
    onActivate() {
      void resolveFrameFit(host, session.state().source, "magic eraser").then(
        (f) => {
          fit = f;
        },
      );
    },
    onDeactivate() {
      fit = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint) return;
      const at = pageToImage(fit, e.pagePoint);
      if (session.takeCurvesPick(at)) return;
      // Alt-click samples, as with every paint tool.
      if (e.modifiers.alt) session.sampleColor(at, 3);
      else void session.magicErase(at);
    },
    onPointerMove() {},
    onPointerUp() {},
  };
}
