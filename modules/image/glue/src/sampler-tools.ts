// WP4.10 — the EYEDROPPER and the COLOR SAMPLER tools (Photoshop's I and
// its flyout partner).
//
// EYEDROPPER: press on the image to take the colour under the pointer as
// the foreground (Alt: the background); dragging keeps sampling, so the
// colour follows the pointer until the release. Its options (the tool
// bar) are the sample size — the point, or the average of a 3×3 … 101×101
// window — and what it reads: the current layer's own pixels or every
// visible layer (the composite, what is on screen).
//
// COLOR SAMPLER: click to fix up to four sampling points; each one's
// colour is re-read whenever the image changes and listed in the image
// panel's colour section (the host Info panel has no door for plugin
// readouts yet). Drag a sampler to move it, Alt-click one to remove it.
// The samplers are drawn on the canvas — a cross and their number — while
// the tool is active.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
  OverlayLayer,
  ToolPreviewShape,
} from "@paged-media/plugin-api";

import { samplerNear, type ColorSamplerInfo } from "./color-state";
import {
  imageToPage,
  pageToImage,
  resolveFrameFit,
  type FitTransform,
} from "./frame-fit";
import type { ImageSession } from "./session";

export function makeEyedropperGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let target: "fg" | "bg" | null = null;
  const sample = (e: CanvasPointerEvent) => {
    if (!fit || !e.pagePoint || !target) return;
    const at = pageToImage(fit, e.pagePoint);
    const { size, source } = session.state().eyedropper;
    session.sampleColor(at, size, target, source);
  };
  return {
    onActivate() {
      void resolveFrameFit(host, session.state().source, "eyedropper").then(
        (f) => {
          fit = f;
        },
      );
    },
    onDeactivate() {
      fit = null;
      target = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint || !session.state().source) return;
      // An armed Curves eyedropper takes the click, as with every tool.
      if (session.takeCurvesPick(pageToImage(fit, e.pagePoint))) return;
      target = e.modifiers.alt ? "bg" : "fg";
      sample(e);
    },
    onPointerMove(e: CanvasPointerEvent) {
      sample(e);
    },
    onPointerUp() {
      target = null;
    },
    onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || !target) return;
      target = null;
      e.preventDefault();
    },
  };
}

/** Pick radius around a sampler, in screen-ish page points. */
const HIT_PT = 6;
/** Marker arm length, page pt. */
const ARM_PT = 5;

/** The markers for `samplers`: a cross and the sampler's number. */
export function samplerMarkers(
  fit: FitTransform,
  samplers: readonly ColorSamplerInfo[],
): ToolPreviewShape[] {
  const out: ToolPreviewShape[] = [];
  for (const s of samplers) {
    const [x, y] = imageToPage(fit, [s.at[0] + 0.5, s.at[1] + 0.5]);
    out.push(
      {
        pageId: fit.pageId,
        points: [
          [x - ARM_PT, y],
          [x + ARM_PT, y],
        ],
      },
      {
        pageId: fit.pageId,
        points: [
          [x, y - ARM_PT],
          [x, y + ARM_PT],
        ],
      },
      {
        kind: "text",
        pageId: fit.pageId,
        x: x + ARM_PT + 1,
        y: y - 2,
        text: String(s.id),
        background: true,
      },
    );
  }
  return out;
}

export function makeColorSamplerGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let dragging: number | null = null;
  let layer: OverlayLayer | null = null;
  let off: { dispose(): void } | null = null;
  const draw = () => {
    if (!layer || !fit) return;
    layer.set(samplerMarkers(fit, session.state().samplers));
  };
  return {
    onActivate() {
      if (host.supports("overlay.layers@1")) {
        layer = host.overlay.layer();
      }
      off = session.onDidChange(draw);
      void resolveFrameFit(host, session.state().source, "colour sampler").then(
        (f) => {
          fit = f;
          draw();
        },
      );
    },
    onDeactivate() {
      off?.dispose();
      off = null;
      layer?.dispose();
      layer = null;
      fit = null;
      dragging = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint || !session.state().source) return;
      const at = pageToImage(fit, e.pagePoint);
      const hit = samplerNear(
        session.state().samplers,
        at,
        // At least the sampler's own pixel, however far zoomed in.
        Math.max(HIT_PT / Math.max(fit.scale, 1e-6), 0.75),
      );
      if (hit && e.modifiers.alt) {
        session.removeColorSampler(hit.id);
        return;
      }
      if (hit) {
        dragging = hit.id;
        return;
      }
      session.addColorSampler(at);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (dragging === null || !fit || !e.pagePoint) return;
      session.moveColorSampler(dragging, pageToImage(fit, e.pagePoint));
    },
    onPointerUp() {
      dragging = null;
    },
  };
}
