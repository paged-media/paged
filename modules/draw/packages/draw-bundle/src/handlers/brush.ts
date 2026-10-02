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
// SEQUENCE of ops (defaults → insert → outline → restore → boolean) —
// which used to be a sequence of MUTATIONS, several undo steps a lift,
// and is now ONE batch and one undo step (see "commit flows" below).
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
  MutationInput,
  MutationOutcome,
} from "@paged-media/plugin-api";

import type { NibProfile } from "@paged-media/draw-geometry";
import {
  BrushMachine,
  type BrushCommit,
  type BrushSnapshot,
} from "@paged-media/draw-tools";

import { insertPathMutationFor } from "./insert-path";
import { createStrokePreview } from "./stroke-preview";
import {
  DEFAULT_MITER_LIMIT,
  outlineStrokeMutationFor,
  supportsPathOps,
} from "../commands/path-ops";
import { pathfinderMutationFor } from "../commands/pathfinder";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "../commands/v59-wire";

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
//
// ONE BATCH PER LIFT. Each tool's commit is built whole and sent once:
// one rebuild, one undo step. `bindCreated` is what makes that possible —
// the batch names the sweep it just inserted (`"$h:<handle>"`) so the
// outline and the boolean can address it before the engine has answered
// with its id. Measured before this, against the same strokes:
//
//                               mutations   undo steps   reads
//   paintbrush                      4            2          1
//   blob brush, same-fill target    5            3          2
//   eraser, 12 selected            60           36         12
//   now, each                       1            1        1 / 2 / 0
//
// Three things measured about what may ride in the batch:
//   · `setDocumentDefaults` may, and the insert that follows it in the
//     SAME batch takes the new defaults (the sweep comes out styled
//     exactly as the stepwise chain styled it);
//   · `pathfinderBoolean` accepts a `$h:` handle among its `others`, and
//     a subtract that removes nothing APPLIES (it consumes the sweep and
//     leaves the target as it was) — so one selected element the stroke
//     never touched does not refuse the whole eraser batch;
//   · a refused child refuses the batch and leaves NOTHING behind — no
//     half-styled centerline, no orphaned sweep, the defaults untouched.
//
// The eraser's batch inserts EVERY sweep copy before it subtracts any of
// them. A boolean consumes its `others`, and a batch that deletes and
// then inserts is refused (the insert's z-position resolves against the
// spread the batch started with — CLAUDE.md, "Two batch-ORDERING rules").
//
// A REFUSED BATCH FALLS BACK TO THE STEPWISE CHAIN, unchanged from how
// these tools shipped. That keeps two things true: an engine that
// predates `bindCreated` still paints, and a sweep whose OUTLINE the
// kernel rejects still leaves its centerline standing — the degrade the
// stepwise chain always had, which an all-or-nothing batch alone would
// have turned into "nothing happened".

/** The handle a sweep is named by inside its own batch. */
const SWEEP_HANDLE = "sweep";

/** How a sweep is outlined: per-anchor stops (paintbrush, blob) or one
 *  uniform width (eraser). */
type SweepOutline = { widths: number[] } | { width: number };

function outlineMutationFor(id: ElementId, outline: SweepOutline): Mutation {
  return "widths" in outline
    ? outlineStrokeVariableMutationFor(id, outline.widths)
    : outlineStrokeMutationFor(id, {
        width: outline.width,
        cap: "round",
        join: "round",
        miterLimit: DEFAULT_MITER_LIMIT,
      });
}

/** Insert the centerline, name it `handle`, outline it. The centerline
 *  is always OPEN (the machines never close a brush contour — see the
 *  ENGINE NOTE in the header). */
function sweepOpsFor(
  pageId: string,
  commit: BrushCommit,
  outline: SweepOutline,
  handle: string,
): MutationInput[] {
  return [
    insertPathMutationFor(pageId, commit.anchors, commit.open),
    bindCreatedMutationFor(handle),
    outlineMutationFor(handleElementId(handle), outline),
  ];
}

/** The style a PAINTED sweep takes, and how to put the creation defaults
 *  back afterwards. */
interface SweepStyle {
  /** The fill the sweep carries: the creation-default fill, or the
   *  Black fallback when the document declares none. */
  fill: string;
  paint: Mutation;
  restore: Mutation;
}

/** ONE `document.meta` read per lift. */
async function readSweepStyle(host: BundleHost): Promise<SweepStyle> {
  const meta = await host.document.meta();
  const fill = meta.defaultFillColor ?? FALLBACK_FILL_REF;
  return {
    fill,
    paint: {
      op: "setDocumentDefaults",
      args: { fillColor: fill, strokeColor: null, strokeWeight: null },
    },
    restore: {
      op: "setDocumentDefaults",
      args: {
        fillColor: meta.defaultFillColor ?? null,
        strokeColor: meta.defaultStrokeColor ?? null,
        strokeWeight: meta.defaultStrokeWeight ?? null,
      },
    },
  };
}

/** A painted sweep, whole: defaults → insert → bind → outline → restore.
 *  The defaults are back where they were before the batch ends, so a
 *  refusal cannot leave them swapped. */
function paintedSweepOpsFor(
  pageId: string,
  commit: BrushCommit,
  style: SweepStyle,
): MutationInput[] {
  return [
    style.paint,
    ...sweepOpsFor(pageId, commit, { widths: commit.widths }, SWEEP_HANDLE),
    style.restore,
  ];
}

/** Send one batch. A refusal is logged at DEBUG, not WARN: the caller
 *  falls back to the stepwise chain, which warns about the step that
 *  actually fails. */
async function mutateBatch(
  host: BundleHost,
  label: string,
  ops: readonly MutationInput[],
): Promise<MutationOutcome> {
  const outcome = await host.document.mutate(batchMutationFor(ops));
  if (!outcome.applied) {
    host.log.debug(
      `${label}: the one-batch commit was refused (${JSON.stringify(outcome.error)}) — ` +
        "falling back to the stepwise chain",
    );
  }
  return outcome;
}

async function mutateLogged(
  host: BundleHost,
  label: string,
  mutation: MutationInput,
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

/** THE STEPWISE CHAIN (the fallback — see the note above). Materialize
 *  one swept shape from a brush commit: swap the creation defaults for
 *  the sweep's style, insert the centerline, outline it (variable widths
 *  or a uniform band), restore the defaults. Returns the created element
 *  (null when the insert was rejected) + the fill ref the sweep carries
 *  (null in "invisible" mode — the eraser's transient shape, which in
 *  this chain IS on screen between its insert and its subtract). */
async function insertSweptShape(
  host: BundleHost,
  label: string,
  pageId: string,
  commit: BrushCommit,
  outline: SweepOutline,
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
  const inserted = await mutateLogged(
    host,
    label,
    insertPathMutationFor(pageId, commit.anchors, commit.open),
    "insertPath",
  );
  const created = inserted.applied ? inserted.createdId : null;
  if (created) {
    // A rejected outline keeps the centerline path standing (already
    // warned) — honest degrade, same as the pencil's pressure lane.
    await mutateLogged(
      host,
      label,
      outlineMutationFor(created, outline),
      "outline sweep",
    );
  }
  await mutateLogged(host, label, restoreDefaults, "restore defaults");
  return { created, fill };
}

async function commitPaintbrush(
  host: BundleHost,
  pageId: string,
  commit: BrushCommit,
): Promise<void> {
  const style = await readSweepStyle(host);
  const swept = await mutateBatch(
    host,
    "paintbrush",
    paintedSweepOpsFor(pageId, commit, style),
  );
  if (swept.applied) {
    if (swept.createdId) await host.selection.set([swept.createdId]);
    return;
  }
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

/** The first selected path element whose fill is `fill` — what a blob
 *  sweep merges into. One property read per candidate until one
 *  matches; that read is the only way to learn an element's fill. */
async function sameFillTarget(
  host: BundleHost,
  selected: readonly ElementId[],
  fill: string,
): Promise<ElementId | null> {
  for (const id of selected) {
    if (!supportsPathOps(id)) continue;
    const props = await host.document.elementProperties(id);
    for (const entry of props?.entries ?? []) {
      if (entry.path === "frameFillColor" && entry.value?.type === "colorRef") {
        if (entry.value.value === fill) return id;
        break;
      }
    }
  }
  return null;
}

async function commitBlobBrush(
  host: BundleHost,
  pageId: string,
  commit: BrushCommit,
): Promise<void> {
  // Capture the selection BEFORE the sweep lands (the commit re-selects).
  const selected = host.selection.get();
  const style = await readSweepStyle(host);
  // HONEST v0 SCOPE: Illustrator's Blob Brush merges with nearby
  // same-styled artwork by PROXIMITY; v0 merges only with the current
  // SELECTION — the first selected path element whose fill matches the
  // sweep's fill is united with it (kept = the selected element, so its
  // identity/styling survives; the sweep is consumed). No proximity
  // detection, no multi-target merge.
  const target = await sameFillTarget(host, selected, style.fill);
  const painted = paintedSweepOpsFor(pageId, commit, style);
  if (target) {
    const united = await mutateBatch(host, "blobBrush", [
      ...painted,
      pathfinderMutationFor(target, [handleElementId(SWEEP_HANDLE)], "union"),
    ]);
    if (united.applied) {
      await host.selection.set([target]);
      return;
    }
  }
  // No same-fill selected element (or the batch WITH the unite was
  // refused): the sweep stands as its own filled shape, selected — the
  // paintbrush outcome.
  const alone = await mutateBatch(host, "blobBrush", painted);
  if (alone.applied) {
    if (alone.createdId) await host.selection.set([alone.createdId]);
    return;
  }
  // Neither batch applied: the stepwise chain, as shipped.
  const { created } = await insertSweptShape(
    host,
    "blobBrush",
    pageId,
    commit,
    { widths: commit.widths },
    "paint",
  );
  if (!created) return;
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
  // its OWN materialized copy of the sweep.
  const targets = host.selection.get().filter(supportsPathOps);
  if (targets.length === 0) {
    host.log.debug(
      "eraserBrush: no path-bearing selection — no-op (the sweep is discarded)",
    );
    return;
  }
  // ONE batch for the gesture: every copy inserted and outlined FIRST,
  // then every subtract (inserts ride before deletes — the note above).
  // Payload order (the pathfinder command convention, first selected =
  // kept): kept = the erased TARGET (it receives the boolean result and
  // keeps its styling/identity), others = [its sweep copy].
  //
  // No defaults swap and no `meta` read here: a copy is inserted and
  // consumed inside the same batch, so it is never on screen and its
  // style is never seen. `outlineStroke` takes its width from its own
  // argument, not from the element's stroke, so the band — and the bite
  // it takes — is the one the stepwise chain cut (asserted, target by
  // target, in the perf budget).
  const handles = targets.map((_, i) => `${SWEEP_HANDLE}${i}`);
  const erased = await mutateBatch(host, "eraserBrush", [
    ...handles.flatMap((handle) =>
      sweepOpsFor(pageId, commit, { width: ERASER_NIB.size }, handle),
    ),
    ...targets.map((target, i) =>
      pathfinderMutationFor(target, [handleElementId(handles[i])], "subtract"),
    ),
  ]);
  if (erased.applied) return;

  // The stepwise chain, as shipped: one insert → outline → subtract
  // sequence per selected element (several undo steps).
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
 *  happens at commit; appended to, not re-mapped — `./stroke-preview.ts`),
 *  and the pointer-up commit runs the tool's async commit flow. */
function createSweepHandler(
  host: BundleHost,
  label: string,
  makeMachine: () => BrushMachine,
  commitSweep: (pageId: string, commit: BrushCommit) => Promise<void>,
): GestureHandler {
  let machine: BrushMachine | null = null;
  let pageId: string | null = null;
  const preview = createStrokePreview(host);

  const reset = () => {
    machine = null;
    pageId = null;
    preview.clear();
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
    if (pageId) preview.show(pageId, snapshot.points);
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
