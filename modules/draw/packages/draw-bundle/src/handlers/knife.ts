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

// The KNIFE tool's gesture handler — a host-routed shim over draw-tools'
// `KnifeMachine`: pointer samples feed the machine, the line being drawn
// previews as a polyline (the freehand samples, or the Alt straight
// line), and the pointer-up cut goes to `applyKnife`
// (`commands/knife.ts`), which says what a cut does to the document and
// what it costs.
//
// A cut that leaves the page is cancelled rather than clipped: the
// pieces are computed on ONE page's arrangement, and a cut whose second
// half is on another page (or the pasteboard) would cut only the half
// the user can see the start of.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import { KnifeMachine, type KnifeSnapshot } from "@paged-media/draw-tools";

import { applyKnife, type KnifeResult } from "../commands/knife";

/** The cut's screen-space RDP fidelity (px). */
const KNIFE_FIDELITY_PX = 1.5;

export interface KnifeHandlerOptions {
  /** Called with every finished cut's result — the spec's hook. */
  onCut?: (result: KnifeResult) => void;
}

export function createKnifeHandler(
  host: BundleHost,
  options: KnifeHandlerOptions = {},
): GestureHandler {
  let machine: KnifeMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const sync = (snapshot: KnifeSnapshot) => {
    if (snapshot.commit && pageId) {
      const page = pageId;
      const cut = snapshot.commit.cut;
      reset();
      void applyKnife(host, page, cut)
        .then((result) => options.onCut?.(result))
        .catch((err) => host.log.warn(`knife: the cut failed: ${String(err)}`));
      return;
    }
    if (!snapshot.active) {
      reset();
      return;
    }
    if (pageId && snapshot.points.length >= 2) {
      host.overlay.setToolPreview({
        pageId,
        points: snapshot.points.map((p) => [p[0], p[1]] as [number, number]),
      });
    }
  };

  return {
    onActivate() {
      /* per-cut state allocates on pointer-down */
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      machine = new KnifeMachine({
        tolerance: host.viewport.pxToPt(KNIFE_FIDELITY_PX),
      });
      pageId = e.pageId;
      sync(
        machine.handle({
          type: "down",
          point: e.pagePoint,
          modifiers: { alt: e.modifiers.alt, shift: e.modifiers.shift },
        }),
      );
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(
        machine.handle({
          type: "move",
          point: e.pagePoint,
          modifiers: { alt: e.modifiers.alt, shift: e.modifiers.shift },
        }),
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine) return;
      const snap =
        e.pageId === pageId && e.pagePoint
          ? machine.handle({
              type: "up",
              point: e.pagePoint,
              modifiers: { alt: e.modifiers.alt, shift: e.modifiers.shift },
            })
          : machine.handle({ type: "key", key: "Escape" });
      sync(snap);
    },
    onKey(e: KeyboardEvent) {
      if (!machine || e.key !== "Escape") return;
      sync(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}
