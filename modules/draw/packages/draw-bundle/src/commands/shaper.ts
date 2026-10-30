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

// THE SHAPER — a freehand gesture becomes a clean shape, or a SCRIBBLE
// over overlapping shapes merges or punches them (Illustrator's Shaper).
// What the gesture IS is draw-geometry's `recogniseShape` (pure,
// deterministic); this module says what it does to the document, and is
// the typed `shaperStroke { page, path }` command the tool also runs.
//
// A SHAPE (line, rectangle, ellipse, triangle, regular polygon) is
// inserted as ONE path, painted with the graphic default a drawing tool
// gives its shape — one batch, and the new shape is selected. It is a
// plain path: Illustrator's Shaper makes LIVE shapes, and this engine's
// live-shape parameters are a later package (WP6.2), so a recognised
// ellipse is not an Oval frame either — keeping every recognised shape a
// path is what lets the next scribble merge it.
//
// A SCRIBBLE acts on the closed shapes under it (polygons and rectangles
// the scribble's box touches — the selection, when there is one) through
// the Shape Builder's own commit (`applyShapeBuild`, one batch):
//   · a scribble that stays inside ONE region — every point of it inside
//     exactly the same set of shapes — PUNCHES that region out (remove):
//     inside an overlap it removes the overlap, inside one shape alone it
//     removes that part;
//   · a scribble that crosses from one region into another MERGES the
//     regions it crossed (keep).
// Ovals are not operands: the Shape Builder reads them through temporary
// stand-ins only in its live tool, and refuses them as data.

import type {
  BundleHost,
  Disposable,
  ElementId,
} from "@paged-media/plugin-api";
import {
  inverseApplyAffine,
  pointInAnchorPath,
  recogniseShape,
  type Affine,
  type ShaperKind,
  type Vec2,
} from "@paged-media/draw-geometry";

import { knifeCandidates } from "./knife";
import { orderTopToBottom, paintOrderLeaves } from "./pathfinder-region";
import { readEditablePath, tableOfRead } from "./path-rewrite";
import { applyShapeBuild } from "../handlers/shape-builder";
import { graphicPaintFor, withGraphicPaint } from "../handlers/graphic-default";
import { insertPathMutationFor } from "../handlers/insert-path";
import { resolveTargetPage } from "../target-page";
import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";

export const SHAPER_STROKE_COMMAND_ID = "media.paged.draw.command.shaperStroke";

export type ShaperResult =
  | {
      applied: true;
      kind: Exclude<ShaperKind, "scribble">;
      created: ElementId | null;
    }
  | {
      applied: true;
      kind: "scribble";
      mode: "keep" | "remove";
      operands: number;
    }
  | { applied: false; reason: string };

const SCRIBBLE_KINDS = new Set(["polygon", "rectangle"]);

/** The scribble's resampling step (pt). */
export const SCRIBBLE_STEP_PT = 2;

/** `points` with every segment resampled to steps of at most `step`. */
export function densify(
  points: readonly Vec2[],
  step: number,
): [number, number][] {
  const out: [number, number][] = [];
  points.forEach((p, i) => {
    if (i > 0) {
      const a = points[i - 1]!;
      const n = Math.ceil(Math.hypot(p[0] - a[0], p[1] - a[1]) / step);
      for (let k = 1; k < n; k++)
        out.push([
          a[0] + ((p[0] - a[0]) * k) / n,
          a[1] + ((p[1] - a[1]) * k) / n,
        ]);
    }
    out.push([p[0], p[1]]);
  });
  return out;
}

/** Which of `shapes` (inner tables + transforms) each scribble point is
 *  inside, as a key per point. */
function containmentKeys(
  points: readonly Vec2[],
  shapes: readonly {
    anchors: Parameters<typeof pointInAnchorPath>[1];
    starts: number[];
    m: Affine | null;
  }[],
): string[] {
  return points.map((p) =>
    shapes
      .map((s, i) => {
        const q = inverseApplyAffine(s.m, p[0], p[1]);
        return q && pointInAnchorPath(q, s.anchors, s.starts) ? String(i) : "";
      })
      .filter(Boolean)
      .join(","),
  );
}

/** Apply one Shaper gesture (page pt on `pageId`). */
export async function applyShaperStroke(
  host: BundleHost,
  pageId: string,
  points: readonly Vec2[],
): Promise<ShaperResult> {
  const no = (reason: string): ShaperResult => ({ applied: false, reason });
  const rec = recogniseShape(points);
  if (!rec) return no("the gesture is no shape the Shaper knows");
  if (rec.kind !== "scribble") {
    const table = rec.table!;
    const open = rec.kind === "line";
    const paint = await graphicPaintFor(host).catch(() => null);
    const outcome = await host.document.mutate(
      withGraphicPaint(
        insertPathMutationFor(pageId, table.anchors, open),
        paint,
      ),
    );
    if (!outcome.applied)
      return no(
        `the engine refused the shape: ${JSON.stringify(outcome.error)}`,
      );
    const created = outcome.createdId ?? null;
    if (created) await host.selection.set([created]);
    return { applied: true, kind: rec.kind, created };
  }
  // A scribble: the closed shapes under it, top to bottom.
  const candidates = (await knifeCandidates(host, pageId, points)).filter(
    (id) => SCRIBBLE_KINDS.has(id.kind),
  );
  const shapes: {
    id: ElementId;
    anchors: Parameters<typeof pointInAnchorPath>[1];
    starts: number[];
    m: Affine | null;
  }[] = [];
  for (const id of candidates) {
    const read = await readEditablePath(host, id);
    if (!read || read.pageId !== pageId) continue;
    if ((read.subpathOpen ?? []).some(Boolean)) continue;
    const { table, matrix } = tableOfRead(read);
    shapes.push({
      id,
      anchors: table.anchors,
      starts: [...table.subpathStarts],
      m: matrix,
    });
  }
  const keys = containmentKeys(points, shapes);
  const touched = shapes.filter((_, i) =>
    keys.some((k) => k.split(",").includes(String(i))),
  );
  if (touched.length === 0) return no("the scribble is over no closed shape");
  const oneRegion = keys.every((k) => k === keys[0]) && keys[0] !== "";
  const mode = oneRegion ? "remove" : "keep";
  let operands = touched.map((s) => s.id);
  try {
    operands = orderTopToBottom(
      operands,
      paintOrderLeaves(await host.document.tree()),
    );
  } catch {
    /* selection order stands */
  }
  // The Shape Builder collects the faces under each SAMPLE of its gesture
  // (it is fed pointer events), so a sparse stroke — a scripted one — is
  // resampled to a sample every `SCRIBBLE_STEP_PT`, as a drawn one is.
  const r = await applyShapeBuild(
    host,
    operands,
    densify(points, SCRIBBLE_STEP_PT),
    mode,
    pageId,
  );
  return r.applied
    ? { applied: true, kind: "scribble", mode, operands: operands.length }
    : no(r.reason);
}

// ------------------------------------------------------------- command

const M = defineMessages("draw.shaper", {
  stroke: "Shaper: recognise a stroke",
});

const pointsOf = (v: unknown): [number, number][] =>
  Array.isArray(v)
    ? v.filter(
        (p): p is [number, number] =>
          Array.isArray(p) &&
          p.length === 2 &&
          p.every((n) => typeof n === "number" && Number.isFinite(n)),
      )
    : [];

/** `shaperStroke { page, path }` — page "" = the active page. Throws
 *  `failed: <why>` when the stroke does nothing. */
export async function runShaperStroke(
  host: BundleHost,
  payload: unknown,
): Promise<{ kind: ShaperKind }> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const page =
    (typeof p.page === "string" && p.page !== "" ? p.page : null) ??
    (await resolveTargetPage(host));
  if (!page) throw new Error("failed: no page to draw on");
  const r = await applyShaperStroke(host, page, pointsOf(p.path));
  if (!r.applied) throw new Error(`failed: ${r.reason}`);
  return { kind: r.kind };
}

export function contributeShaperCommand(host: BundleHost): Disposable {
  return registerCommand(host, {
    id: SHAPER_STROKE_COMMAND_ID,
    title: M.stroke,
    category: "Path",
    handler: async (_paged, payload) => {
      if (payload !== undefined) return runShaperStroke(host, payload);
      host.log.info(
        `${SHAPER_STROKE_COMMAND_ID}: a stroke needs its points — draw it with the Shaper tool`,
      );
      return null;
    },
  });
}
