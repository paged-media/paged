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

// The WP5.8 retouching tools' gestures:
//
// - CONTENT-AWARE MOVE (the patch flyout): drag the selection where the
//   object should go. With "Transform on drop" the moved box stays on the
//   canvas for its scale and angle (tool options / panel), Enter commits,
//   Escape cancels; without it the drop commits. One undo step.
// - REMOVE (the healing flyout): paint over an object; on release the
//   stroke's area is filled from its surroundings (or by an `ml.inpaint`
//   provider when one is installed). One undo step.
// - SAMPLING BRUSH (the Content-Aware Fill workspace): paint the sampling
//   area, Alt erases.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import { tipOutline } from "./brush-machine";
import {
  imageToPage,
  pageToImage,
  resolveFrameFit,
  type FitTransform,
} from "./frame-fit";
import type { ImageSession } from "./session";

/** The corners of the selection's box moved by `(dx, dy)` and turned by
 *  `angle`° at `scale`% about its centre — the move's preview outline. */
export function movedBox(
  sel: { x: number; y: number; w: number; h: number },
  dx: number,
  dy: number,
  scale = 100,
  angle = 0,
): [number, number][] {
  const cx = sel.x + sel.w / 2;
  const cy = sel.y + sel.h / 2;
  const k = scale / 100;
  const r = (angle * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return (
    [
      [sel.x, sel.y],
      [sel.x + sel.w, sel.y],
      [sel.x + sel.w, sel.y + sel.h],
      [sel.x, sel.y + sel.h],
    ] as [number, number][]
  ).map(([x, y]) => {
    const ux = (x - cx) * k;
    const uy = (y - cy) * k;
    return [cx + dx + c * ux - s * uy, cy + dy + s * ux + c * uy];
  });
}

export function makeContentAwareMoveGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let from: [number, number] | null = null;
  let to: [number, number] | null = null;

  const render = () => {
    const sel = session.state().selection;
    const pending = session.state().retouch.pendingMove;
    if (!fit || !sel) return host.overlay.setToolPreview(null);
    const base: [number, number] =
      pending !== null ? [pending.dx, pending.dy] : [0, 0];
    const drag: [number, number] =
      from && to ? [to[0] - from[0], to[1] - from[1]] : [0, 0];
    if (!pending && !from) return host.overlay.setToolPreview(null);
    const corners = movedBox(
      sel,
      base[0] + drag[0],
      base[1] + drag[1],
      pending?.scale ?? 100,
      pending?.angle ?? 0,
    );
    host.overlay.setToolPreview({
      pageId: fit.pageId,
      points: corners.map((p) => imageToPage(fit!, p)),
      close: true,
    });
  };

  const unsubscribe = { dispose: () => {} };

  return {
    onActivate() {
      void resolveFrameFit(
        host,
        session.state().source,
        "content-aware move tool",
      ).then((f) => {
        fit = f;
        render();
      });
      const sub = session.onDidChange(render);
      unsubscribe.dispose = () => sub.dispose();
    },
    onDeactivate() {
      unsubscribe.dispose();
      host.overlay.setToolPreview(null);
      session.cancelContentAwareMove();
      fit = null;
      from = to = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint || !session.state().source) return;
      from = to = pageToImage(fit, e.pagePoint);
      render();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!fit || !from || !e.pagePoint) return;
      to = pageToImage(fit, e.pagePoint);
      render();
    },
    onPointerUp() {
      const [a, b] = [from, to];
      from = to = null;
      if (!a || !b) return;
      const dx = Math.round(b[0] - a[0]);
      const dy = Math.round(b[1] - a[1]);
      const pending = session.state().retouch.pendingMove;
      if (pending) {
        // A drag while the transform waits moves the pending box.
        if (dx !== 0 || dy !== 0)
          session.setMoveTransform({
            dx: pending.dx + dx,
            dy: pending.dy + dy,
          });
        render();
        return;
      }
      if (dx === 0 && dy === 0) {
        render();
        return;
      }
      void session.dropContentAwareMove(dx, dy).then(render);
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (from) {
          from = to = null;
        } else if (session.state().retouch.pendingMove) {
          session.cancelContentAwareMove();
        } else {
          return;
        }
        render();
        e.preventDefault();
      } else if (e.key === "Enter" && session.state().retouch.pendingMove) {
        void session.commitContentAwareMove().then(render);
        e.preventDefault();
      }
    },
  };
}

/** A stroke's points as the flat `[x, y, …]` list the engine takes. */
export function flatPoints(points: [number, number][]): number[] {
  return points.flatMap(([x, y]) => [x, y]);
}

export function makeRemoveGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let points: [number, number][] | null = null;

  const render = (cursor: [number, number] | null) => {
    if (!fit) return host.overlay.setToolPreview(null);
    const shapes = [];
    if (points && points.length > 1) {
      shapes.push({
        pageId: fit.pageId,
        points: points.map((p) => imageToPage(fit!, p)),
      });
    }
    if (cursor) {
      shapes.push({
        pageId: fit.pageId,
        points: tipOutline(cursor, session.state().brush.size).map((p) =>
          imageToPage(fit!, p),
        ),
        close: true,
      });
    }
    host.overlay.setToolPreviews(shapes.length ? shapes : null);
  };

  return {
    onActivate() {
      void resolveFrameFit(host, session.state().source, "remove tool").then(
        (f) => {
          fit = f;
        },
      );
    },
    onDeactivate() {
      host.overlay.setToolPreview(null);
      fit = null;
      points = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint || !session.state().source) return;
      points = [pageToImage(fit, e.pagePoint)];
      render(points[0]);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint) return;
      const p = pageToImage(fit, e.pagePoint);
      if (points) points.push(p);
      render(p);
    },
    onPointerUp() {
      const stroke = points;
      points = null;
      render(null);
      if (!stroke) return;
      // A click removes a dot: the engine stamps one disc.
      const pts = stroke.length === 1 ? [stroke[0], stroke[0]] : stroke;
      void session.removeStroke(flatPoints(pts), session.state().brush.size);
    },
    onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || !points) return;
      points = null;
      render(null);
      e.preventDefault();
    },
  };
}

export function makeCafSamplingGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let erase = false;
  let painting = false;

  const ring = (p: [number, number] | null) => {
    if (!fit || !p) return host.overlay.setToolPreview(null);
    host.overlay.setToolPreview({
      pageId: fit.pageId,
      points: tipOutline(p, session.state().brush.size).map((q) =>
        imageToPage(fit!, q),
      ),
      close: true,
    });
  };

  return {
    onActivate() {
      void resolveFrameFit(host, session.state().source, "sampling brush").then(
        (f) => {
          fit = f;
        },
      );
    },
    onDeactivate() {
      host.overlay.setToolPreview(null);
      fit = null;
      painting = false;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint) return;
      if (!session.state().retouch.caf) {
        // The brush only means something inside the workspace.
        void session.openContentAwareFill();
        return;
      }
      erase = !!e.modifiers?.alt;
      painting = true;
      const p = pageToImage(fit, e.pagePoint);
      session.paintCafSampling(p, session.state().brush.size / 2, erase);
      ring(p);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint) return;
      const p = pageToImage(fit, e.pagePoint);
      if (painting)
        session.paintCafSampling(p, session.state().brush.size / 2, erase);
      ring(p);
    },
    onPointerUp() {
      if (!painting) return;
      painting = false;
      void session.endCafPaint();
    },
  };
}
