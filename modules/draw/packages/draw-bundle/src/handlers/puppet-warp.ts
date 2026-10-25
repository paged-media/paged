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

// THE PUPPET WARP TOOL — a host-routed shim over draw-tools'
// `PuppetWarpMachine`, in the host's Free Transform flyout (where
// Illustrator keeps it).
//
// A SESSION per selection: when the tool activates (and whenever the
// selection or the selected artwork changes under it — an undo, an edit
// with another tool) the selection's paths are read and meshed, three
// pins are placed automatically and the mesh and pins are drawn. Then:
//
//   click on the mesh     → a new pin (nothing moves)
//   drag a pin            → the artwork follows, live (ARAP); release
//                           writes every selected path in ONE batch
//   Alt+click a pin       → the pin goes and the artwork settles (a write)
//   drag the selected pin's RING (just outside it) → turn about it
//   Delete / Backspace    → remove the selected pin (a write)
//   Escape                → a drag in progress goes back
//
// Each write is one undo step. The pins live as long as the session —
// Illustrator's do not survive a deselection either.

import type {
  BundleHost,
  ElementId,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  PuppetWarpMachine,
  type PuppetWarpSnapshot,
} from "@paged-media/draw-tools";

import {
  readDistortTargets,
  writeDistorted,
  type DistortTarget,
} from "../commands/distort-shared";
import { EDITABLE_PATH_KINDS } from "../commands/path-rewrite";
import { createToolOptionsReader, PUPPET_WARP_OPTIONS } from "../tool-options";
import {
  ellipseShape,
  polyShape,
  squareShape,
  tableShapes,
} from "./preview-shapes";
import { serial } from "./serial";

const PICK_PX = 7;
const PIN_PX = 4;

const keyOf = (ids: readonly ElementId[]) =>
  ids
    .map((i) => `${i.kind}:${String(i.id)}`)
    .sort()
    .join("|");

const DENSITY: Record<string, { divisions: number; maxVertices: number }> = {
  normal: { divisions: 24, maxVertices: 320 },
  more: { divisions: 36, maxVertices: 450 },
  fewer: { divisions: 16, maxVertices: 200 },
};

export function createPuppetWarpHandler(
  host: BundleHost,
  hooks: { onCommit?: (applied: boolean) => void } = {},
): GestureHandler {
  const reader = createToolOptionsReader(PUPPET_WARP_OPTIONS);
  const queue = serial(host, "puppet warp");
  let machine: PuppetWarpMachine | null = null;
  let targets: DistortTarget[] = [];
  let sessionKey = "";
  /** What the session last wrote (or read), to notice outside edits. */
  let expected = "";
  let pageId: string | null = null;

  const snapshotOfTargets = (ts: readonly DistortTarget[]) =>
    JSON.stringify(ts.map((t) => t.table.anchors));

  const draw = (snap: PuppetWarpSnapshot) => {
    if (!pageId) return;
    const page = pageId;
    const shapes: ToolPreviewShape[] = [];
    if (reader.select("showMesh") === "on")
      for (const [a, b] of snap.meshEdges)
        shapes.push(polyShape(page, [a, b], { dashed: true }));
    for (const t of snap.tables) shapes.push(...tableShapes(page, t, false));
    const r = host.viewport.pxToPt(PIN_PX);
    for (const pin of snap.pins) {
      shapes.push(squareShape(page, pin.point, pin.selected ? r * 1.5 : r));
      if (pin.selected) {
        const ring = host.viewport.pxToPt(PICK_PX * 2);
        shapes.push(
          ellipseShape(page, pin.point, ring, ring, 0, { dashed: true }),
        );
      }
    }
    host.overlay.setToolPreviews(shapes);
  };

  const clear = () => {
    machine = null;
    targets = [];
    sessionKey = "";
    expected = "";
    pageId = null;
    host.overlay.setToolPreviews(null);
  };

  /** Make sure the session matches the selection and the artwork. */
  const ensureSession = async (): Promise<boolean> => {
    const ids = host.selection
      .get()
      .filter((i) => EDITABLE_PATH_KINDS.has(i.kind));
    if (ids.length === 0) {
      clear();
      return false;
    }
    const read = await readDistortTargets(host, ids);
    const onPage = read.filter((t) => t.pageId === read[0]?.pageId);
    const key = keyOf(onPage.map((t) => t.id));
    if (machine && key === sessionKey && snapshotOfTargets(onPage) === expected)
      return true;
    if (onPage.length === 0) {
      clear();
      return false;
    }
    const density = DENSITY[reader.select("density")] ?? DENSITY.normal!;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of onPage)
      for (const a of t.page.anchors) {
        x0 = Math.min(x0, a.anchor[0]);
        y0 = Math.min(y0, a.anchor[1]);
        x1 = Math.max(x1, a.anchor[0]);
        y1 = Math.max(y1, a.anchor[1]);
      }
    machine = new PuppetWarpMachine({
      targets: onPage.map((t) => t.page),
      tolerance: host.viewport.pxToPt(PICK_PX),
      spacing: Math.max(1, Math.hypot(x1 - x0, y1 - y0) / density.divisions),
      maxVertices: density.maxVertices,
    });
    if (!machine.usable) {
      clear();
      return false;
    }
    targets = onPage;
    sessionKey = key;
    expected = snapshotOfTargets(onPage);
    pageId = onPage[0]!.pageId;
    draw(machine.view());
    return true;
  };

  const sync = async (snap: PuppetWarpSnapshot) => {
    draw(snap);
    if (!snap.commit) return;
    const owned = targets;
    const applied = await writeDistorted(
      host,
      "puppet warp",
      snap.commit.map((page, i) => ({ target: owned[i]!, page })),
    );
    if (applied) {
      // The session's own write is not an outside edit.
      const after = await readDistortTargets(
        host,
        owned.map((t) => t.id),
      );
      expected = snapshotOfTargets(after);
      targets = owned.map((t, i) => ({
        ...t,
        table: after[i]?.table ?? t.table,
      }));
    }
    hooks.onCommit?.(applied);
  };

  return {
    onActivate(paged) {
      reader.attach(paged);
      queue.run(async () => {
        await ensureSession();
      });
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      queue.run(() => clear());
    },
    onPointerDown(e) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const point = e.pagePoint;
      const page = e.pageId;
      const alt = e.modifiers.alt;
      queue.run(async () => {
        if (!(await ensureSession()) || !machine || page !== pageId) return;
        await sync(machine.handle({ type: "down", point, alt }));
      });
    },
    onPointerMove(e) {
      if (!e.pagePoint) return;
      const point = e.pagePoint;
      const page = e.pageId;
      queue.run(async () => {
        if (machine && page === pageId)
          await sync(machine.handle({ type: "move", point }));
      });
    },
    onPointerUp(e) {
      const point = e.pagePoint;
      const page = e.pageId;
      queue.run(async () => {
        if (!machine) return;
        await sync(
          point && page === pageId
            ? machine.handle({ type: "up", point })
            : machine.handle({ type: "key", key: "Escape" }),
        );
      });
    },
    onKey(e) {
      if (e.key !== "Escape" && e.key !== "Delete" && e.key !== "Backspace")
        return;
      const key = e.key;
      queue.run(async () => {
        if (machine) await sync(machine.handle({ type: "key", key }));
      });
    },
  };
}
