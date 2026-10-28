// CANVAS CAPTURE (WP5.2): while a dialog draws on the image — the Blur
// Gallery's pins and handles, Curves' targeted adjustment — a drag on the
// image belongs to it, whichever image tool is active. The plugin
// contract has no door to switch the active tool, and a workspace that
// asked the user to pick a special tool first would be one step more than
// Photoshop's; so every image tool is wrapped once, at registration
// (activate.ts), and offers each press to `session.canvasPointer` first.
// When the session takes it the whole drag goes there and the tool sees
// none of it; otherwise the tool runs exactly as before.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  GestureHandler,
} from "@paged-media/plugin-api";

import { pageToImage, resolveFrameFit, type FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";

export function withCanvasCapture(
  host: BundleHost,
  session: ImageSession,
  inner: GestureHandler,
): GestureHandler {
  let fit: FitTransform | null = null;
  let fitFor: unknown = null;
  let sub: Disposable | null = null;
  let captured = false;
  const refit = () => {
    const src = session.state().source;
    if (src === fitFor) return;
    fitFor = src;
    void resolveFrameFit(host, src, "canvas capture").then((f) => {
      if (fitFor === src) fit = f;
    });
  };
  const at = (e: CanvasPointerEvent): [number, number] | null =>
    fit && e.pagePoint ? pageToImage(fit, e.pagePoint) : null;
  return {
    ...inner,
    onActivate(paged) {
      refit();
      sub = session.onDidChange(refit);
      inner.onActivate(paged);
    },
    onDeactivate(reason) {
      sub?.dispose();
      sub = null;
      if (captured) {
        captured = false;
        session.canvasPointer("up", [Number.NaN, Number.NaN]);
      }
      inner.onDeactivate(reason);
    },
    onPointerDown(e) {
      const p = at(e);
      if (
        p &&
        session.canvasPointer("down", p, {
          alt: e.modifiers.alt,
          shift: e.modifiers.shift,
        })
      ) {
        captured = true;
        return;
      }
      inner.onPointerDown(e);
    },
    onPointerMove(e) {
      if (!captured) return inner.onPointerMove(e);
      const p = at(e);
      if (p) session.canvasPointer("move", p);
    },
    onPointerUp(e) {
      if (!captured) return inner.onPointerUp(e);
      captured = false;
      const p = at(e);
      session.canvasPointer("up", p ?? [Number.NaN, Number.NaN]);
    },
  };
}
