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

// Brush tools v0 — three gesture handlers over draw-tools' BrushMachine
// (the pencil handler's shape: samples in, polyline preview, one async
// commit flow on lift), composed ENTIRELY from existing engine ops (no
// new offset geometry):
//
//   · Paintbrush — centerline + per-anchor calligraphic widths →
//     `insertPath` → `outlineStrokeVariable` → a FILLED swept shape
//     (fill = the document's creation-default fill, stroke none).
//   · Blob Brush — the same sweep, then `pathfinderBoolean` UNITE with
//     a same-fill SELECTED element (honest v0 scope below).
//   · Eraser — a UNIFORM round-nib sweep → `outlineStroke` →
//     `pathfinderBoolean` SUBTRACT from each SELECTED path element.
//
// STYLING NOTE (the Phase 8 SVG-importer finding, io/svg.ts): an
// inserted Polygon rejects direct frame-property writes
// (`setElementProperty{ frameFillColor }`), so a sweep's style flows
// through the DOCUMENT CREATION DEFAULTS: capture them, point them at
// the sweep's style, insert, restore. Each commit is therefore a short
// SEQUENCE of mutations (defaults → insert → outline → restore →
// boolean), i.e. several undo steps — the same trade the pencil's
// two-step (insert + outline) commit already makes.
//
// ENGINE NOTE (`variable_width_outline_stroke`, core kurbo_kernel v1):
// the widths are STOPS lerped over the centerline's arc length by index
// (per-anchor stops distribute uniformly), the contour is treated as
// OPEN regardless of the stored flag, single contour only, and
// cap/join/miterLimit are accepted on the wire but IGNORED by the v1
// kernel. The machines therefore never close a brush contour
// (closeTolerance stays 0) — a close-on-lift would silently reopen.

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  Mutation,
  MutationOutcome,
} from "@paged-media/plugin-api";

import type { NibProfile } from "@paged-media/draw-geometry";
import {
  BrushMachine,
  type BrushCommit,
  type BrushSnapshot,
} from "@paged-media/draw-tools";

import { insertPathMutationFor } from "./insert-path";
import {
  DEFAULT_MITER_LIMIT,
  outlineStrokeMutationFor,
  supportsPathOps,
} from "../commands/path-ops";
import { pathfinderMutationFor } from "../commands/pathfinder";

/** Screen-space RDP fidelity (the pencil's constant). */
const SIMPLIFY_TOLERANCE_PX = 2;

/** Paintbrush + Blob Brush nib — v0 fixed defaults (documented in the
 *  tool registration): 6pt base size, 45° nib angle, roundness 0.3. */
export const PAINTBRUSH_NIB: NibProfile = {
  angle: Math.PI / 4,
  roundness: 0.3,
  size: 6,
};

/** Eraser nib — ROUND (roundness 1) and pressure-free in the machine,
 *  so the sweep is a uniform 6pt band (`outlineStroke`, not the
 *  variable op). */
export const ERASER_NIB: NibProfile = { angle: 0, roundness: 1, size: 6 };

/** The fill a sweep falls back to when the document declares NO
 *  creation-default fill (`meta.defaultFillColor` null): the IDML-
 *  standard Black swatch every document carries. */
export const FALLBACK_FILL_REF = "Color/Black";

/** The `setElementProperty{ outlineStrokeVariable }` wire shape the
 *  paintbrush/blob commit emits — exported so the conformance spec
 *  asserts the EXACT payload (no second copy to drift from). cap/join/
 *  miterLimit ride the wire but the v1 kernel ignores them (see the
 *  ENGINE NOTE above). */
export function outlineStrokeVariableMutationFor(
  elementId: ElementId,
  widths: number[],
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId,
      path: "outlineStrokeVariable",
      value: {
        type: "outlineStrokeVariable",
        value: {
          widths,
          cap: "round",
          join: "round",
          miterLimit: DEFAULT_MITER_LIMIT,
        },
      },
    },
  };
}

// ------------------------------------------------------------ commit flows

async function mutateLogged(
  host: BundleHost,
  label: string,
  mutation: Mutation,
  what: string,
): Promise<MutationOutcome> {
  const outcome = await host.document.mutate(mutation);
  if (!outcome.applied) {
    host.log.warn(
      `${label} ${what} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
  }
  return outcome;
}

/** Materialize one swept shape from a brush commit: swap the creation
 *  defaults for the sweep's style, insert the centerline, outline it
 *  (variable widths or a uniform band), restore the defaults. Returns
 *  the created element (null when the insert was rejected) + the fill
 *  ref the sweep carries (null in "invisible" mode — the eraser's
 *  transient shape). */
async function insertSweptShape(
  host: BundleHost,
  label: string,
  pageId: string,
  commit: BrushCommit,
  outline: { widths: number[] } | { width: number },
  fillMode: "paint" | "invisible",
): Promise<{ created: ElementId | null; fill: string | null }> {
  const meta = await host.document.meta();
  const restoreDefaults: Mutation = {
    op: "setDocumentDefaults",
    args: {
      fillColor: meta.defaultFillColor ?? null,
      strokeColor: meta.defaultStrokeColor ?? null,
      strokeWeight: meta.defaultStrokeWeight ?? null,
    },
  };
  const fill =
    fillMode === "paint" ? (meta.defaultFillColor ?? FALLBACK_FILL_REF) : null;
  await mutateLogged(
    host,
    label,
    {
      op: "setDocumentDefaults",
      args: { fillColor: fill, strokeColor: null, strokeWeight: null },
    },
    "setDocumentDefaults",
  );
  // The centerline is always OPEN (the machines never close a brush
  // contour — see the ENGINE NOTE in the header).
  const inserted = await mutateLogged(
    host,
    label,
    insertPathMutationFor(pageId, commit.anchors, commit.open),
    "insertPath",
  );
  const created = inserted.applied ? inserted.createdId : null;
  if (created) {
    const outlineMutation =
      "widths" in outline
        ? outlineStrokeVariableMutationFor(created, outline.widths)
        : outlineStrokeMutationFor(created, {
            width: outline.width,
            cap: "round",
            join: "round",
            miterLimit: DEFAULT_MITER_LIMIT,
          });
    // A rejected outline keeps the centerline path standing (already
    // warned) — honest degrade, same as the pencil's pressure lane.
    await mutateLogged(host, label, outlineMutation, "outline sweep");
  }
  await mutateLogged(host, label, restoreDefaults, "restore defaults");
  return { created, fill };
}

async function commitPaintbrush(
  host: BundleHost,
  pageId: string,
  commit: BrushCommit,
): Promise<void> {
  const { created } = await insertSweptShape(
    host,
    "paintbrush",
    pageId,
    commit,
    { widths: commit.widths },
    "paint",
  );
  if (created) await host.selection.set([created]);
}

async function commitBlobBrush(
  host: BundleHost,
  pageId: string,
  commit: BrushCommit,
): Promise<void> {
  // Capture the selection BEFORE the sweep lands (the commit re-selects).
  const selected = host.selection.get();
  const { created, fill } = await insertSweptShape(
    host,
    "blobBrush",
    pageId,
    commit,
    { widths: commit.widths },
    "paint",
  );
  if (!created) return;
  // HONEST v0 SCOPE: Illustrator's Blob Brush merges with nearby
  // same-styled artwork by PROXIMITY; v0 merges only with the current
  // SELECTION — the first selected path element whose fill matches the
  // sweep's fill is united with it (kept = the selected element, so its
  // identity/styling survives; the sweep is consumed). No proximity
  // detection, no multi-target merge.
  let target: ElementId | null = null;
  for (const id of selected) {
    if (!supportsPathOps(id)) continue;
    const props = await host.document.elementProperties(id);
    for (const entry of props?.entries ?? []) {
      if (entry.path === "frameFillColor" && entry.value?.type === "colorRef") {
        if (entry.value.value === fill) target = id;
        break;
      }
    }
    if (target) break;
  }
  if (target) {
    const united = await mutateLogged(
      host,
      "blobBrush",
      pathfinderMutationFor(target, [created], "union"),
      "pathfinderBoolean unite",
    );
    if (united.applied) {
      await host.selection.set([target]);
      return;
    }
  }
  // No same-fill selected element (or the unite was rejected): the
  // sweep stands as its own filled shape, selected — the paintbrush
  // outcome.
  await host.selection.set([created]);
}

async function commitEraserBrush(
  host: BundleHost,
  pageId: string,
  commit: BrushCommit,
): Promise<void> {
  // HONEST v0 SCOPE: the eraser erases from the SELECTED path elements
  // only (no hit-testing of everything under the sweep). And because
  // `pathfinderBoolean` CONSUMES its `others`, each target subtracts
  // its OWN materialized copy of the sweep — one insert→outline→
  // subtract sequence per selected element (several undo steps).
  const targets = host.selection.get().filter(supportsPathOps);
  if (targets.length === 0) {
    host.log.debug(
      "eraserBrush: no path-bearing selection — no-op (the sweep is discarded)",
    );
    return;
  }
  for (const target of targets) {
    // The transient sweep is INVISIBLE (no fill, no stroke) — it exists
    // only to be consumed by the subtract.
    const { created } = await insertSweptShape(
      host,
      "eraserBrush",
      pageId,
      commit,
      { width: ERASER_NIB.size },
      "invisible",
    );
    if (!created) continue;
    // Payload order (the pathfinder command convention, first selected
    // = kept): kept = the erased TARGET (it receives the boolean
    // result and keeps its styling/identity), others = [the sweep].
    const outcome = await mutateLogged(
      host,
      "eraserBrush",
      pathfinderMutationFor(target, [created], "subtract"),
      "pathfinderBoolean subtract",
    );
    if (!outcome.applied && typeof created.id === "string") {
      // Never leave an invisible orphan behind a rejected subtract.
      // (A created path's id is always the plain string form — the
      // union's text/table addresses never name a page item.)
      await mutateLogged(
        host,
        "eraserBrush",
        { op: "deleteFrame", args: { frameId: created.id } },
        "orphaned sweep cleanup",
      );
    }
  }
}

// ------------------------------------------------------- gesture handlers

/** The shared pencil-shaped gesture shim: pointer samples feed the
 *  machine, the live stroke previews as a POLYLINE (honest — the sweep
 *  happens at commit), and the pointer-up commit runs the tool's async
 *  commit flow. */
function createSweepHandler(
  host: BundleHost,
  label: string,
  makeMachine: () => BrushMachine,
  commitSweep: (pageId: string, commit: BrushCommit) => Promise<void>,
): GestureHandler {
  let machine: BrushMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const sync = (snapshot: BrushSnapshot) => {
    if (snapshot.commit && pageId) {
      const c = snapshot.commit;
      const page = pageId;
      reset();
      void commitSweep(page, c).catch((err) =>
        host.log.warn(`${label} commit failed: ${err}`),
      );
      return;
    }
    if (!snapshot.active) {
      reset();
      return;
    }
    host.overlay.setToolPreview(
      pageId && snapshot.points.length >= 2
        ? {
            pageId,
            points: snapshot.points.map(
              (p) => [p[0], p[1]] as [number, number],
            ),
          }
        : null,
    );
  };

  return {
    onActivate() {
      /* per-stroke state allocates on pointer-down */
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      machine = makeMachine();
      pageId = e.pageId;
      sync(
        machine.handle({
          type: "down",
          point: e.pagePoint,
          pressure: e.pressure,
        }),
      );
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(
        machine.handle({
          type: "move",
          point: e.pagePoint,
          pressure: e.pressure,
        }),
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine) return;
      // Lifting off-page cancels (a brush sweep needs its page).
      const point =
        e.pageId === pageId && e.pagePoint ? e.pagePoint : undefined;
      const snap = point
        ? machine.handle({ type: "up", point, pressure: e.pressure })
        : machine.handle({ type: "key", key: "Escape" });
      sync(snap);
    },
    onKey(e: KeyboardEvent) {
      if (!machine || e.key !== "Escape") return;
      sync(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}

export function createPaintbrushHandler(host: BundleHost): GestureHandler {
  return createSweepHandler(
    host,
    "paintbrush",
    () =>
      new BrushMachine({
        tolerance: host.viewport.pxToPt(SIMPLIFY_TOLERANCE_PX),
        nib: PAINTBRUSH_NIB,
        // closeTolerance stays 0 — see the ENGINE NOTE in the header.
      }),
    (page, c) => commitPaintbrush(host, page, c),
  );
}

export function createBlobBrushHandler(host: BundleHost): GestureHandler {
  return createSweepHandler(
    host,
    "blobBrush",
    () =>
      new BrushMachine({
        tolerance: host.viewport.pxToPt(SIMPLIFY_TOLERANCE_PX),
        nib: PAINTBRUSH_NIB,
      }),
    (page, c) => commitBlobBrush(host, page, c),
  );
}

export function createEraserBrushHandler(host: BundleHost): GestureHandler {
  return createSweepHandler(
    host,
    "eraserBrush",
    () =>
      new BrushMachine({
        tolerance: host.viewport.pxToPt(SIMPLIFY_TOLERANCE_PX),
        nib: ERASER_NIB,
        // The uniform lane: a round nib with pressure scaling OFF —
        // every stop is nib.size, and the commit outlines with the
        // uniform `outlineStroke` op (proper round caps; the v1
        // variable kernel ignores caps).
        pressure: false,
      }),
    (page, c) => commitEraserBrush(host, page, c),
  );
}
