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

// THE REFLECT TOOL — a host-routed shim over draw-tools'
// `ReflectMachine`, in the host's TRANSFORM flyout beside Rotate, Scale
// and Shear (a bundle tool joins a host flyout by naming its group, as
// the anchor tools join the Pen's).
//
//   click        → the axis point (a small cross marks it; before the
//                  first click it is the selection's centre)
//   drag         → the axis turns to follow the pointer: the overlay draws
//                  the axis and the selection's box reflected across it;
//                  release reflects the selection (Alt at release: a copy;
//                  Shift: the axis snaps to 45°)
//   Alt+click    → the axis point there, and the Path Options panel's
//                  Reflect section opens with "about a point" set to it —
//                  Illustrator's dialog; Apply there reflects.
//
// The reflection is `applyReflect` (`commands/transform.ts`) with the
// axis point as its pivot — the commands' own math and batch, so a drag
// is ONE undo step and Transform Again repeats it.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  affineReflect,
  applyAffine,
  transformBounds,
  type Affine,
  type Vec2,
} from "@paged-media/draw-geometry";
import { ReflectMachine, type ReflectSnapshot } from "@paged-media/draw-tools";

import { applyReflect, type TransformResult } from "../commands/transform";
import {
  lastUsedPathOptions,
  rememberPathOptions,
  showPathOptions,
} from "../commands/path-options";
import { serial } from "./serial";

type Box = readonly [number, number, number, number];

/** The selection's PAGE-space box `[top, left, bottom, right]` and its
 *  page, or null. */
export async function selectionPageBox(
  host: BundleHost,
): Promise<{ pageId: string; box: Box } | null> {
  const selection = host.selection.get();
  if (selection.length === 0) return null;
  const geoms = await host.document.elementGeometry([...selection]).catch(() => []);
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  let pageId: string | null = null;
  for (const g of geoms) {
    if (!g.pageId) continue;
    pageId ??= g.pageId;
    if (g.pageId !== pageId) continue;
    const m = (g.itemTransform ?? null) as Affine | null;
    const [bt, bl, bb, br] = m ? transformBounds(g.bounds, m) : g.bounds;
    t = Math.min(t, bt);
    l = Math.min(l, bl);
    b = Math.max(b, bb);
    r = Math.max(r, br);
  }
  return pageId && Number.isFinite(t) ? { pageId, box: [t, l, b, r] } : null;
}

const centreOf = (box: Box): [number, number] => [
  (box[1] + box[3]) / 2,
  (box[0] + box[2]) / 2,
];

/** The overlay for a snapshot: the axis-point cross, and while dragging
 *  the axis and the selection box reflected across it. Pure. */
export function reflectPreview(
  snap: ReflectSnapshot,
  pageId: string,
  box: Box | null,
  crossPt: number,
): ToolPreviewShape[] {
  const out: ToolPreviewShape[] = [];
  const p = snap.pivot;
  if (!p) return out;
  out.push(
    { pageId, points: [[p[0] - crossPt, p[1]], [p[0] + crossPt, p[1]]] },
    { pageId, points: [[p[0], p[1] - crossPt], [p[0], p[1] + crossPt]] },
  );
  if (snap.axisAngleDeg === null) return out;
  const a = (snap.axisAngleDeg * Math.PI) / 180;
  const reach = box ? Math.hypot(box[2] - box[0], box[3] - box[1]) + 2 * crossPt : 20 * crossPt;
  out.push({
    pageId,
    points: [
      [p[0] - Math.cos(a) * reach, p[1] - Math.sin(a) * reach],
      [p[0] + Math.cos(a) * reach, p[1] + Math.sin(a) * reach],
    ],
  });
  if (box) {
    const m = affineReflect(snap.axisAngleDeg, p as Vec2);
    const corners: [number, number][] = [
      [box[1], box[0]],
      [box[3], box[0]],
      [box[3], box[2]],
      [box[1], box[2]],
    ];
    out.push({
      pageId,
      points: corners.map(([x, y]) => {
        const q = applyAffine(m, x, y);
        return [q[0], q[1]] as [number, number];
      }),
      close: true,
    });
  }
  return out;
}

export interface ReflectHandlerOptions {
  onReflect?: (r: TransformResult) => void;
  /** An Alt+click asked for the options here (spec hook). */
  onOptions?: (pivot: [number, number], raised: boolean) => void;
}

export function createReflectHandler(
  host: BundleHost,
  options: ReflectHandlerOptions = {},
): GestureHandler {
  let machine: ReflectMachine | null = null;
  let pageId: string | null = null;
  let box: Box | null = null;
  const queue = serial(host, "reflect");

  const draw = (snap: ReflectSnapshot) => {
    if (!pageId) return;
    host.overlay.setToolPreviews(
      reflectPreview(snap, pageId, box, host.viewport.pxToPt(5)),
    );
  };

  const handle = async (snap: ReflectSnapshot) => {
    draw(snap);
    if (snap.commit) {
      const r = await applyReflect(
        host,
        snap.commit.angleDeg,
        snap.commit.copy,
        snap.commit.pivot,
      );
      options.onReflect?.(r);
      // The box moved with the selection.
      const next = await selectionPageBox(host);
      box = next?.box ?? box;
      draw({ ...snap, commit: null, axisAngleDeg: null });
    }
    if (snap.openOptions) {
      const at = snap.openOptions;
      rememberPathOptions(host, "reflect", {
        ...lastUsedPathOptions(host).reflect,
        aboutPoint: true,
        x: at[0],
        y: at[1],
      });
      const raised = showPathOptions(host, "reflect");
      if (!raised) {
        // No panel door: reflect with the remembered angle about the point.
        const r = lastUsedPathOptions(host).reflect;
        const result = await applyReflect(host, r.angleDeg, r.copy, at);
        options.onReflect?.(result);
      }
      options.onOptions?.([at[0], at[1]], raised);
    }
  };

  const event = (e: CanvasPointerEvent) => ({
    point: e.pagePoint!,
    modifiers: { alt: e.modifiers.alt, shift: e.modifiers.shift },
  });

  return {
    onActivate() {
      machine = new ReflectMachine({ clickTolerance: host.viewport.pxToPt(3) });
      queue.run(async () => {
        const sel = await selectionPageBox(host);
        if (!sel || !machine) return;
        pageId = sel.pageId;
        box = sel.box;
        machine.setDefaultPivot(centreOf(sel.box));
        draw(machine.handle({ type: "key", key: "Escape" }));
      });
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      machine = null;
      pageId = null;
      box = null;
      host.overlay.setToolPreviews(null);
    },
    onPointerDown(e) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      queue.run(async () => {
        if (!machine) return;
        if (host.selection.get().length === 0) {
          host.log.info("reflect: select what to reflect first");
          return;
        }
        if (!box || pageId !== e.pageId) {
          const sel = await selectionPageBox(host);
          box = sel?.box ?? null;
          if (sel && !machine.currentPivot()) machine.setDefaultPivot(centreOf(sel.box));
        }
        pageId = e.pageId;
        await handle(machine.handle({ type: "down", ...event(e) }));
      });
    },
    onPointerMove(e) {
      if (!e.pagePoint) return;
      queue.run(async () => {
        if (machine && e.pageId === pageId)
          await handle(machine.handle({ type: "move", ...event(e) }));
      });
    },
    onPointerUp(e) {
      if (!e.pagePoint) return;
      queue.run(async () => {
        if (machine && e.pageId === pageId)
          await handle(machine.handle({ type: "up", ...event(e) }));
      });
    },
    onKey(e) {
      if (e.key !== "Escape") return;
      queue.run(async () => {
        if (machine) await handle(machine.handle({ type: "key", key: "Escape" }));
      });
    },
  };
}
