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

// THE RESHAPE TOOL — a host-routed shim over draw-tools'
// `ReshapeMachine`, in the host's TRANSFORM flyout (Illustrator keeps it
// with Scale and Shear). Press on the path under the pointer (or the one
// selected path) — on an anchor, or on a segment, where an anchor is
// added — and drag: the anchor follows and its contour follows it by a
// falloff ALONG the path, previewed as the real cubics. Release writes the
// table in ONE `framePath` batch (`commands/path-tools.ts`). The falloff
// radius is the tool's option (pt).
//
// The pointer is mapped into the path's own space through its transform,
// and the pick tolerance and the radius are scaled with it, as the anchor
// tools do.

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  affineScale,
  contourRanges,
  inverseApplyAffine,
  type Affine,
  type AnchorTable,
} from "@paged-media/draw-geometry";
import { ReshapeMachine, type ReshapeSnapshot } from "@paged-media/draw-tools";

import { applyReshapeTable } from "../commands/path-tools";
import {
  anchorsToPage,
  EDITABLE_PATH_KINDS,
  readEditablePath,
  tableOfRead,
} from "../commands/path-rewrite";
import { createToolOptionsReader, RESHAPE_OPTIONS } from "../tool-options";
import { serial } from "./serial";

const PICK_PX = 6;

/** The table as cubic previews, page space. Pure. */
export function tablePreview(
  table: AnchorTable,
  m: Affine | null,
  pageId: string,
): ToolPreviewShape[] {
  return contourRanges(table.anchors.length, table.subpathStarts).map(
    ([from, to], i) => ({
      pageId,
      anchors: anchorsToPage(table.anchors.slice(from, to), m),
      close: !(table.subpathOpen?.[i] ?? false),
      dashed: true,
    }),
  );
}

export function createReshapeHandler(
  host: BundleHost,
  options: { onReshape?: (target: ElementId, applied: boolean) => void } = {},
): GestureHandler {
  const reader = createToolOptionsReader(RESHAPE_OPTIONS);
  const queue = serial(host, "reshape");
  let machine: ReshapeMachine | null = null;
  let target: ElementId | null = null;
  let matrix: Affine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    target = null;
    pageId = null;
    host.overlay.setToolPreviews(null);
  };

  const local = (e: CanvasPointerEvent): [number, number] | null => {
    if (!e.pagePoint) return null;
    const q = inverseApplyAffine(matrix, e.pagePoint[0], e.pagePoint[1]);
    return q ? [q[0], q[1]] : null;
  };

  const sync = async (snap: ReshapeSnapshot) => {
    if (snap.commit && target) {
      const id = target;
      const table = snap.commit;
      reset();
      // Written first: `onReshape?.(…)` would skip evaluating its
      // arguments — the write — when no callback is given.
      const applied = await applyReshapeTable(host, id, table);
      options.onReshape?.(id, applied);
      return;
    }
    if (!snap.active) {
      reset();
      return;
    }
    if (snap.table && pageId) host.overlay.setToolPreviews(tablePreview(snap.table, matrix, pageId));
  };

  return {
    onActivate(paged) {
      reader.attach(paged);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      queue.run(async () => {
        let id: ElementId | null = null;
        try {
          id = (await host.document.hitTest(e.pageId!, e.pagePoint!, "any"))?.element ?? null;
        } catch {
          /* fall through to the selection */
        }
        if (!id || !EDITABLE_PATH_KINDS.has(id.kind)) {
          const sel = host.selection.get();
          id = sel.length === 1 ? sel[0]! : null;
        }
        if (!id) return;
        const read = await readEditablePath(host, id);
        if (!read || read.pageId !== e.pageId) return;
        const { table, matrix: m } = tableOfRead(read);
        matrix = m;
        target = id;
        pageId = e.pageId!;
        const k = affineScale(m);
        machine = new ReshapeMachine({
          table,
          tolerance: host.viewport.pxToPt(PICK_PX) / k,
          radius: reader.number("radius") / k,
        });
        const p = local(e);
        if (p) await sync(machine.handle({ type: "down", point: p }));
      });
    },
    onPointerMove(e) {
      queue.run(async () => {
        const p = machine && e.pageId === pageId ? local(e) : null;
        if (machine && p) await sync(machine.handle({ type: "move", point: p }));
      });
    },
    onPointerUp(e) {
      queue.run(async () => {
        if (!machine) return;
        const p = e.pageId === pageId ? local(e) : null;
        await sync(
          p ? machine.handle({ type: "up", point: p }) : machine.handle({ type: "key", key: "Escape" }),
        );
      });
    },
    onKey(e) {
      if (e.key !== "Escape") return;
      queue.run(async () => {
        if (machine) await sync(machine.handle({ type: "key", key: "Escape" }));
      });
    },
  };
}
