// WP5.12 — the workspace TOOLS: Ruler, Count, Note (the Eyedropper's
// flyout, as in Photoshop) and Slice (the Crop tool's flyout). None takes
// a key: the shortcut registers are full (modules/draw/CLAUDE.md).
//
//   · RULER — drag a line; it stays until the next one (Escape clears).
//     Shift keeps it to 45° steps. Its length and angle show in the Info
//     panel and beside the line; Image ▸ Straighten to ruler levels it.
//   · COUNT — a click numbers a mark in the active count group; a drag on
//     a mark moves it, Alt-click removes it.
//   · NOTE — a click pins a note (its text is written in the image panel's
//     Notes section); a drag moves a note, Alt-click deletes it.
//   · SLICE — drag a rectangle (snapped to the guides and grid); Alt-click
//     inside a slice deletes it. File slices export each as a PNG.
//
// Every completed gesture is ONE undo step in the image's history (the
// Ruler line is not document state, as in Photoshop). Points go through
// the frame's image↔page mapping (`frame-fit.ts`) and, where Photoshop
// snaps, through the workspace's snapping (guides, edges, grid).

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import { imageToPage, pageToImage, type FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";

/** Grab radius around a mark or a note, screen px. */
const HIT_PX = 6;

/** Constrain `to` to the nearest 45° ray from `from`. */
export function constrain45(
  from: [number, number],
  to: [number, number],
): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return to;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
}

/** The shared plumbing: the fit (resolved on activate) and the image
 *  point of an event, snapped or raw. */
function frameTool(host: BundleHost, session: ImageSession) {
  let fit: FitTransform | null = null;
  return {
    activate() {
      void session
        .workspace()
        .refreshFit()
        .then((f) => {
          fit = f;
        });
    },
    deactivate() {
      fit = null;
      host.overlay.setToolPreview(null);
    },
    fit: () => fit,
    point(e: CanvasPointerEvent, snap: boolean): [number, number] | null {
      if (!fit || !e.pagePoint || !session.state().source) return null;
      const p = pageToImage(fit, e.pagePoint);
      return snap ? session.workspace().snap(p) : p;
    },
    /** Hit radius in image px (at least half a pixel). */
    radius(): number {
      if (!fit) return 1;
      let scale = 1;
      try {
        scale = host.viewport.camera().scale || 1;
      } catch {
        scale = 1;
      }
      return Math.max(HIT_PX / (scale * fit.scale), 0.5);
    },
  };
}

const near = (a: [number, number], b: [number, number], r: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= r;

export function makeRulerGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  const tool = frameTool(host, session);
  let from: [number, number] | null = null;
  const preview = (a: [number, number], b: [number, number]) => {
    const fit = tool.fit();
    if (!fit) return;
    host.overlay.setToolPreview({
      pageId: fit.pageId,
      points: [imageToPage(fit, a), imageToPage(fit, b)],
    });
  };
  return {
    onActivate: () => tool.activate(),
    onDeactivate: () => {
      from = null;
      tool.deactivate();
    },
    onPointerDown(e) {
      from = tool.point(e, true);
    },
    onPointerMove(e) {
      if (!from) return;
      let to = tool.point(e, !e.modifiers.shift);
      if (!to) return;
      if (e.modifiers.shift) to = constrain45(from, to);
      preview(from, to);
    },
    onPointerUp(e) {
      const start = from;
      from = null;
      host.overlay.setToolPreview(null);
      if (!start) return;
      let to = tool.point(e, !e.modifiers.shift);
      if (!to) return;
      if (e.modifiers.shift) to = constrain45(start, to);
      // A click without a drag clears the line, as Photoshop's does.
      if (near(start, to, 1e-6)) {
        session.workspace().setRuler(null);
        return;
      }
      session.workspace().setRuler({ from: start, to });
    },
    onKey(e) {
      if (e.key !== "Escape") return;
      from = null;
      host.overlay.setToolPreview(null);
      session.workspace().setRuler(null);
      e.preventDefault();
    },
  };
}

export function makeCountGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  const tool = frameTool(host, session);
  let dragging: { group: number; index: number } | null = null;
  let moved: [number, number] | null = null;
  const hit = (p: [number, number]) => {
    const r = tool.radius();
    const groups = session.workspace().state().info.counts;
    for (let g = groups.length - 1; g >= 0; g--) {
      const grp = groups[g]!;
      if (!grp.visible) continue;
      for (let i = grp.marks.length - 1; i >= 0; i--)
        if (near(grp.marks[i]!, p, r)) return { group: g, index: i };
    }
    return null;
  };
  return {
    onActivate: () => tool.activate(),
    onDeactivate: () => {
      dragging = null;
      moved = null;
      tool.deactivate();
    },
    onPointerDown(e) {
      const p = tool.point(e, false);
      if (!p) return;
      const h = hit(p);
      if (h && e.modifiers.alt) {
        session.workspace().removeCount(h.group, h.index);
        return;
      }
      if (h) {
        dragging = h;
        moved = null;
        return;
      }
      session.workspace().addCount(p);
    },
    onPointerMove(e) {
      if (!dragging) return;
      moved = tool.point(e, false) ?? moved;
    },
    onPointerUp() {
      const d = dragging;
      dragging = null;
      if (d && moved) session.workspace().moveCount(d.group, d.index, moved);
      moved = null;
    },
  };
}

export function makeNoteGesture(
  host: BundleHost,
  session: ImageSession,
  openPanel: () => void,
): GestureHandler {
  const tool = frameTool(host, session);
  let dragging: number | null = null;
  let moved: [number, number] | null = null;
  const hit = (p: [number, number]) => {
    const r = tool.radius() * 2;
    const notes = session.workspace().state().info.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const a = notes[i]!.at;
      // The note's marker is a square to the lower right of its point.
      if (
        p[0] >= a[0] - r / 2 &&
        p[0] <= a[0] + 2 * r &&
        p[1] >= a[1] - r / 2 &&
        p[1] <= a[1] + 2 * r
      )
        return i;
    }
    return -1;
  };
  return {
    onActivate: () => tool.activate(),
    onDeactivate: () => {
      dragging = null;
      moved = null;
      tool.deactivate();
    },
    onPointerDown(e) {
      const p = tool.point(e, false);
      if (!p) return;
      const i = hit(p);
      if (i >= 0 && e.modifiers.alt) {
        session.workspace().deleteNote(i);
        return;
      }
      if (i >= 0) {
        dragging = i;
        moved = null;
        return;
      }
      if (session.workspace().addNote(p) !== null) openPanel();
    },
    onPointerMove(e) {
      if (dragging === null) return;
      moved = tool.point(e, false) ?? moved;
    },
    onPointerUp() {
      const d = dragging;
      dragging = null;
      if (d !== null && moved) session.workspace().moveNote(d, moved);
      moved = null;
    },
  };
}

export function makeSliceGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  const tool = frameTool(host, session);
  let from: [number, number] | null = null;
  const rectOf = (a: [number, number], b: [number, number]) => {
    const x0 = Math.round(Math.min(a[0], b[0]));
    const y0 = Math.round(Math.min(a[1], b[1]));
    const x1 = Math.round(Math.max(a[0], b[0]));
    const y1 = Math.round(Math.max(a[1], b[1]));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  return {
    onActivate: () => tool.activate(),
    onDeactivate: () => {
      from = null;
      tool.deactivate();
    },
    onPointerDown(e) {
      const p = tool.point(e, true);
      if (!p) return;
      if (e.modifiers.alt) {
        const slices = session.workspace().state().info.slices;
        for (let i = slices.length - 1; i >= 0; i--) {
          const s = slices[i]!;
          if (
            p[0] >= s.x &&
            p[0] <= s.x + s.w &&
            p[1] >= s.y &&
            p[1] <= s.y + s.h
          ) {
            session.workspace().deleteSlice(i);
            return;
          }
        }
        return;
      }
      from = p;
    },
    onPointerMove(e) {
      const fit = tool.fit();
      if (!from || !fit) return;
      const to = tool.point(e, true);
      if (!to) return;
      const r = rectOf(from, to);
      const a = imageToPage(fit, [r.x, r.y]);
      const b = imageToPage(fit, [r.x + r.w, r.y + r.h]);
      host.overlay.setToolPreview({
        pageId: fit.pageId,
        points: [a, [b[0], a[1]], b, [a[0], b[1]]],
        close: true,
      });
    },
    onPointerUp(e) {
      const start = from;
      from = null;
      host.overlay.setToolPreview(null);
      if (!start) return;
      const to = tool.point(e, true);
      if (!to) return;
      const r = rectOf(start, to);
      if (r.w < 1 || r.h < 1) return;
      session.workspace().addSlice(r);
    },
    onKey(e) {
      if (e.key !== "Escape" || !from) return;
      from = null;
      host.overlay.setToolPreview(null);
      e.preventDefault();
    },
  };
}
