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

// THE STAR and FLARE tools — host-routed shims over draw-tools'
// `StarMachine` / `FlareMachine`, both in the host's SHAPE flyout beside
// Rectangle, Ellipse and Polygon.
//
// STAR: drag from the centre (Radius 1 to the pointer, Radius 2 by the
// tool option's ratio, the pointer's direction turns it, Shift keeps it
// upright, Arrow Up / Down add or remove a point while dragging — the host
// routes keys to the active tool during a gesture). Release inserts it
// (`commands/star-flare.ts`, one batch). A CLICK opens the Path Options
// panel's Star section with its centre at the click — Illustrator's
// dialog, where Radius 1, Radius 2 and Points are typed and Insert makes
// the star; a host without the panel door inserts the last-used star at
// the click.
//
// FLARE: drag from the centre to size it, release, then drag where its
// rings should end and release — the flare is inserted as one grouped
// batch. Escape after the first drag inserts it without rings' direction
// (at the last-used end). A click opens the Flare section at the click.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";
import { flareParts, starPath } from "@paged-media/draw-geometry";
import {
  FlareMachine,
  StarMachine,
  type FlareGesture,
  type FlareSnapshot,
  type StarShape,
  type StarSnapshot,
} from "@paged-media/draw-tools";

import {
  applyInsertFlare,
  applyInsertStar,
  type FlareParams,
} from "../commands/star-flare";
import {
  lastUsedPathOptions,
  rememberPathOptions,
  showPathOptions,
} from "../commands/path-options";
import { createToolOptionsReader, STAR_OPTIONS } from "../tool-options";

const CLICK_PX = 3;

export function createStarHandler(
  host: BundleHost,
  options: { onStar?: (shape: StarShape | null) => void } = {},
): GestureHandler {
  const reader = createToolOptionsReader(STAR_OPTIONS);
  let machine: StarMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const sync = (snap: StarSnapshot) => {
    const page = pageId;
    if (snap.commit && page) {
      const star = snap.commit;
      reset();
      void applyInsertStar(host, { ...star }, page)
        .then(() => options.onStar?.(star))
        .catch((err) => host.log.warn(`star: ${String(err)}`));
      return;
    }
    if (snap.openOptions && page) {
      const at = snap.openOptions;
      reset();
      const params = {
        ...lastUsedPathOptions(host).star,
        cx: at[0],
        cy: at[1],
        points: reader.number("points"),
      };
      rememberPathOptions(host, "star", params);
      if (!showPathOptions(host, "star"))
        void applyInsertStar(host, { ...params }, page).then(() =>
          options.onStar?.(null),
        );
      return;
    }
    if (!snap.active) {
      reset();
      return;
    }
    if (snap.star && page) {
      const t = starPath(snap.star);
      host.overlay.setToolPreview({
        pageId: page,
        anchors: [...t.anchors],
        close: true,
        dashed: true,
      });
    }
  };

  return {
    onActivate(paged) {
      reader.attach(paged);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      machine = new StarMachine({
        points: reader.number("points"),
        ratio: reader.number("radius2") / 100,
        clickTolerance: host.viewport.pxToPt(CLICK_PX),
      });
      pageId = e.pageId;
      sync(machine.handle({ type: "down", point: e.pagePoint }));
    },
    onPointerMove(e) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(
        machine.handle({
          type: "move",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift },
        }),
      );
    },
    onPointerUp(e) {
      if (!machine) return;
      sync(
        e.pagePoint && e.pageId === pageId
          ? machine.handle({
              type: "up",
              point: e.pagePoint,
              modifiers: { shift: e.modifiers.shift },
            })
          : machine.handle({ type: "key", key: "Escape" }),
      );
    },
    onKey(e: KeyboardEvent) {
      if (!machine) return;
      if (e.key === "Escape" || e.key === "ArrowUp" || e.key === "ArrowDown")
        sync(machine.handle({ type: "key", key: e.key }));
    },
  };
}

/** A gesture's flare parameters over the last-used ones: the drag's
 *  length is the HALO's radius, the centre and the rays scale with it. */
export function flareParamsOfGesture(
  g: FlareGesture,
  base: FlareParams,
): FlareParams {
  const halo = Math.max(1, g.size);
  const centreRadius = halo / Math.max(1, base.haloScale);
  const scale = centreRadius / Math.max(0.5, base.centreRadius);
  return {
    ...base,
    cx: g.centre[0],
    cy: g.centre[1],
    centreRadius,
    rayLength: base.rayLength * scale,
    ringRadius: base.ringRadius * scale,
    ...(g.end
      ? { endX: g.end[0], endY: g.end[1] }
      : {
          endX: g.centre[0] + (base.endX - base.cx),
          endY: g.centre[1] + (base.endY - base.cy),
        }),
  };
}

export function createFlareHandler(
  host: BundleHost,
  options: { onFlare?: (params: FlareParams | null) => void } = {},
): GestureHandler {
  let machine: FlareMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreviews(null);
  };

  const preview = (g: FlareGesture, page: string) => {
    const p = flareParamsOfGesture(g, lastUsedPathOptions(host).flare);
    const parts = flareParts({
      cx: p.cx,
      cy: p.cy,
      centreRadius: p.centreRadius,
      haloScale: p.haloScale,
      rays: p.rays,
      rayLength: p.rayLength,
      rings: g.end ? p.rings : 0,
      end: [p.endX, p.endY],
      ringRadius: p.ringRadius,
    });
    host.overlay.setToolPreviews(
      [parts.halo, parts.centre, ...parts.rings].map((t) => ({
        pageId: page,
        anchors: [...t.anchors],
        close: true,
        dashed: true,
      })),
    );
  };

  const sync = (snap: FlareSnapshot) => {
    const page = pageId;
    if (snap.commit && page) {
      const params = flareParamsOfGesture(
        snap.commit,
        lastUsedPathOptions(host).flare,
      );
      reset();
      void applyInsertFlare(host, { ...params }, page)
        .then(() => options.onFlare?.(params))
        .catch((err) => host.log.warn(`flare: ${String(err)}`));
      return;
    }
    if (snap.openOptions && page) {
      const at = snap.openOptions;
      reset();
      const base = lastUsedPathOptions(host).flare;
      const params: FlareParams = {
        ...base,
        cx: at[0],
        cy: at[1],
        endX: at[0] + (base.endX - base.cx),
        endY: at[1] + (base.endY - base.cy),
      };
      rememberPathOptions(host, "flare", params);
      if (!showPathOptions(host, "flare"))
        void applyInsertFlare(host, { ...params }, page).then(() =>
          options.onFlare?.(null),
        );
      return;
    }
    if (!snap.active) {
      reset();
      return;
    }
    if (snap.flare && page) preview(snap.flare, page);
  };

  return {
    onActivate() {
      /* the two-step gesture allocates on its first press */
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      if (!machine) {
        machine = new FlareMachine({
          clickTolerance: host.viewport.pxToPt(CLICK_PX),
        });
        pageId = e.pageId;
      }
      if (e.pageId !== pageId) return;
      sync(machine.handle({ type: "down", point: e.pagePoint }));
    },
    onPointerMove(e) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(machine.handle({ type: "move", point: e.pagePoint }));
    },
    onPointerUp(e) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(machine.handle({ type: "up", point: e.pagePoint }));
    },
    onKey(e: KeyboardEvent) {
      if (machine && e.key === "Escape")
        sync(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}
