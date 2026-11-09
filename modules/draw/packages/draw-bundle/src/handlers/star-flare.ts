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

// THE FLARE tool — a host-routed shim over vector-tools' `FlareMachine`, in
// the host's SHAPE flyout beside Rectangle, Ellipse and Polygon. (Star is
// the host's: Object ▸ Insert star… and the Polygon tool's Star option.)
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
import { flareParts } from "@paged-media/vector-geometry";
import {
  FlareMachine,
  type FlareGesture,
  type FlareSnapshot,
} from "@paged-media/vector-tools";

import { applyInsertFlare, type FlareParams } from "../commands/star-flare";
import {
  lastUsedPathOptions,
  rememberPathOptions,
  showPathOptions,
} from "../commands/path-options";

const CLICK_PX = 3;

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
