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

// THE ENVELOPE MESH TOOL (draw ADR 367) — edits the mesh of a selected
// item's envelope (`envelope` entry, made by Object ▸ Envelope Distort ▸
// Make with Mesh or Make with Top Object) on canvas. KEYLESS, in the
// host's Free Transform flyout beside Puppet Warp: the shortcut registers
// are full (CLAUDE.md), and Illustrator's own mesh key `u` is the host's.
//
//   drag a node        → it moves with its handles (Illustrator's mesh
//                        point); the canvas follows on release
//   drag a handle      → that control point alone
//   Alt+click the mesh → a row and a column through the point (the same
//                        surface, one more mesh line each way)
//   Escape             → a drag in progress goes back
//
// Each release is ONE write of the item's object stack: one undo step.
// The overlay draws the mesh as the engine bends the box (the same patch
// map, draw-geometry's `envelopePoint`), the nodes as squares and the
// handles as dots on their lines.

import type {
  BundleHost,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  cellOf,
  ENVELOPE_MAX_CELLS,
  invertAffine,
  invertEnvelope,
  isNet,
  meshLines,
  moveNetPoint,
  netIndex,
  splitColumn,
  splitRow,
  type Affine,
  type EnvelopeNet,
  type Vec2,
} from "@paged-media/draw-geometry";

import {
  envelopeIndexOf,
  objectStackMutation,
  readEnvelopeTargets,
  type EnvelopeTarget,
  type StackEntry,
} from "../commands/envelope";
import { batchMutationFor } from "../commands/batch-handles";
import { ellipseShape, polyShape, squareShape } from "./preview-shapes";
import { serial } from "./serial";

const PICK_PX = 7;
const NODE_PX = 3.5;
const HANDLE_PX = 2.5;

/** One selected item with a mesh envelope. */
export interface MeshSession {
  target: EnvelopeTarget;
  index: number;
  rows: number;
  columns: number;
  net: EnvelopeNet;
}

const map = (m: Affine | null, p: Vec2): [number, number] =>
  m
    ? [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
    : [p[0], p[1]];

/** A unit-square point of `s`'s box, on the page. */
export function unitToPage(s: MeshSession, p: Vec2): [number, number] {
  const b = s.target.box;
  return map(s.target.matrix, [b.x + p[0] * b.w, b.y + p[1] * b.h]);
}

/** A page point in `s`'s box's unit square (null when its transform has
 *  no inverse). */
export function pageToUnit(s: MeshSession, p: Vec2): [number, number] | null {
  const inv = s.target.matrix ? invertAffine(s.target.matrix) : null;
  if (s.target.matrix && !inv) return null;
  const q = map(inv, p);
  const b = s.target.box;
  return [(q[0] - b.x) / b.w, (q[1] - b.y) / b.h];
}

/** The mesh sessions of the selection: items whose envelope is a mesh. */
export async function readMeshSessions(
  host: BundleHost,
): Promise<MeshSession[]> {
  const out: MeshSession[] = [];
  for (const target of await readEnvelopeTargets(host, host.selection.get())) {
    const index = envelopeIndexOf(target.entries);
    const e = target.entries[index];
    if (!e || e.kind !== "envelope") continue;
    const rows = typeof e.rows === "number" ? e.rows : 1;
    const columns = typeof e.columns === "number" ? e.columns : 1;
    const net = e.mesh as Vec2[] | undefined;
    if (!isNet(net, rows, columns)) continue;
    out.push({
      target,
      index,
      rows,
      columns,
      net: net.map((p) => [p[0], p[1]]),
    });
  }
  return out;
}

/** The control point of the sessions nearest `p` within `tol` (page pt). */
export function pickControl(
  sessions: readonly MeshSession[],
  p: Vec2,
  tol: number,
): { session: number; index: number } | null {
  let best: { session: number; index: number } | null = null;
  let bestD = Infinity;
  for (let si = 0; si < sessions.length; si++) {
    const s = sessions[si]!;
    for (let i = 0; i < s.net.length; i++) {
      const pp = unitToPage(s, s.net[i]!);
      const d = Math.hypot(pp[0] - p[0], pp[1] - p[1]);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = { session: si, index: i };
      }
    }
  }
  return best;
}

/** The stack write of a session's net. */
export function meshWrite(s: MeshSession) {
  const entries: StackEntry[] = s.target.entries.map((e, i) =>
    i === s.index ? { ...e, rows: s.rows, columns: s.columns, mesh: s.net } : e,
  );
  return objectStackMutation(s.target.id, entries);
}

/** Alt+click: one row and one column more through `unit` (the clicked
 *  point in the box's unit square). Null when the mesh is at its limit or
 *  the point is off it. */
export function refineAt(
  s: MeshSession,
  unit: Vec2,
  tol: number,
): MeshSession | null {
  const hit = invertEnvelope(s.net, s.rows, s.columns, unit);
  if (hit.distance > tol) return null;
  if (s.rows >= ENVELOPE_MAX_CELLS || s.columns >= ENVELOPE_MAX_CELLS)
    return null;
  const { r, c, s: cs, t } = cellOf(s.rows, s.columns, hit.u, hit.v);
  if (cs <= 1e-3 || cs >= 1 - 1e-3 || t <= 1e-3 || t >= 1 - 1e-3) return null;
  const wide = splitColumn(s.net, s.rows, s.columns, c, cs);
  const net = splitRow(wide, s.rows, s.columns + 1, r, t);
  return { ...s, rows: s.rows + 1, columns: s.columns + 1, net };
}

export function createEnvelopeMeshHandler(
  host: BundleHost,
  hooks: { onCommit?: (applied: boolean) => void } = {},
): GestureHandler {
  const queue = serial(host, "envelope mesh");
  let sessions: MeshSession[] = [];
  let drag: {
    session: number;
    index: number;
    before: EnvelopeNet;
    moved: boolean;
  } | null = null;

  const draw = () => {
    const shapes: ToolPreviewShape[] = [];
    const node = host.viewport.pxToPt(NODE_PX);
    const dot = host.viewport.pxToPt(HANDLE_PX);
    for (const s of sessions) {
      const page = s.target.pageId;
      for (const line of meshLines(s.net, s.rows, s.columns))
        shapes.push(
          polyShape(
            page,
            line.map((q) => unitToPage(s, q)),
            { dashed: true },
          ),
        );
      for (let r = 0; r <= s.rows; r++)
        for (let c = 0; c <= s.columns; c++) {
          const ni = netIndex(s.columns, 3 * r, 3 * c);
          const np = unitToPage(s, s.net[ni]!);
          shapes.push(squareShape(page, np, node));
          for (const [di, dj] of [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ] as const) {
            const i = 3 * r + di;
            const j = 3 * c + dj;
            if (i < 0 || j < 0 || i > 3 * s.rows || j > 3 * s.columns) continue;
            const hp = unitToPage(s, s.net[netIndex(s.columns, i, j)]!);
            shapes.push(polyShape(page, [np, hp]));
            shapes.push(ellipseShape(page, hp, dot, dot));
          }
        }
    }
    host.overlay.setToolPreviews(shapes.length > 0 ? shapes : null);
  };

  const refresh = async () => {
    sessions = await readMeshSessions(host);
    draw();
  };

  const write = async (s: MeshSession) => {
    const out = await host.document.mutate(batchMutationFor([meshWrite(s)]), {
      label: "Edit envelope mesh",
    });
    if (!out.applied)
      host.log.warn(
        `envelope mesh: refused by the engine: ${JSON.stringify(out.error)}`,
      );
    hooks.onCommit?.(out.applied);
    await refresh();
  };

  return {
    onActivate(_paged) {
      queue.run(refresh);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      queue.run(() => {
        sessions = [];
        drag = null;
        host.overlay.setToolPreviews(null);
      });
    },
    onPointerDown(e) {
      if (e.button !== 0 || !e.pagePoint) return;
      const point = e.pagePoint;
      const page = e.pageId;
      const alt = e.modifiers.alt;
      queue.run(async () => {
        if (sessions.length === 0) await refresh();
        const tol = host.viewport.pxToPt(PICK_PX);
        if (alt) {
          for (const s of sessions) {
            if (s.target.pageId !== page) continue;
            const unit = pageToUnit(s, point);
            if (!unit) continue;
            const b = s.target.box;
            const finer = refineAt(s, unit, tol / Math.max(b.w, b.h));
            if (finer) {
              await write(finer);
              return;
            }
          }
          return;
        }
        const hit = pickControl(
          sessions.filter((s) => s.target.pageId === page),
          point,
          tol,
        );
        if (!hit) return;
        const onPage = sessions.filter((s) => s.target.pageId === page);
        const si = sessions.indexOf(onPage[hit.session]!);
        drag = {
          session: si,
          index: hit.index,
          before: sessions[si]!.net,
          moved: false,
        };
      });
    },
    onPointerMove(e) {
      if (!e.pagePoint) return;
      const point = e.pagePoint;
      queue.run(() => {
        if (!drag) return;
        const s = sessions[drag.session];
        if (!s) return;
        const unit = pageToUnit(s, point);
        if (!unit) return;
        s.net = moveNetPoint(drag.before, s.rows, s.columns, drag.index, unit);
        drag.moved = true;
        draw();
      });
    },
    onPointerUp(e) {
      const point = e.pagePoint;
      queue.run(async () => {
        const d = drag;
        drag = null;
        if (!d) return;
        const s = sessions[d.session];
        if (!s) return;
        if (point) {
          const unit = pageToUnit(s, point);
          if (unit)
            s.net = moveNetPoint(d.before, s.rows, s.columns, d.index, unit);
        }
        // A click that moved nothing writes nothing (no empty undo step).
        if (
          s.net.every(
            (q, i) => q[0] === d.before[i]![0] && q[1] === d.before[i]![1],
          )
        ) {
          draw();
          return;
        }
        await write(s);
      });
    },
    onKey(e) {
      if (e.key !== "Escape") return;
      queue.run(() => {
        if (!drag) return;
        const s = sessions[drag.session];
        if (s) s.net = drag.before;
        drag = null;
        draw();
      });
    },
  };
}
