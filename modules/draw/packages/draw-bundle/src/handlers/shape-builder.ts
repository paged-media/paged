// Shape Builder — the gesture-driven boolean tool (concept §13.4, Tier
// B). A drag across overlapping shapes UNITES them; Alt-drag SUBTRACTS.
// It composes over the existing `pathfinderBoolean` op (the same wire op
// the four Pathfinder commands drive) — the gesture decides the operand
// SET + the mode, the engine does the geometry.
//
// MECHANISM: a host-agnostic machine (`ShapeBuilderMachine` in
// draw-tools) tracks the gesture polyline + the ordered set of regions
// the drag has swept; this handler is the thin host shim that:
//   · on each pointer-move, hit-tests the engine along the drag
//     (`host.document.hitTest`) and feeds the resolved element id to the
//     machine as a `cross` event (de-duped there);
//   · previews the gesture polyline through the shared overlay channel;
//   · on pointer-up commits ONE `pathfinderBoolean` over the swept
//     elements (first swept = kept; the rest united or subtracted) — one
//     undoable step, the kept element re-selected.
//
// HONEST SUBSET, named (the task's "if region-level hit-testing needs a
// door the facade lacks, fall back to selection-based pathfinder with the
// regions named"): the facade hit-tests at the ELEMENT level — there is
// no planar-region / sub-area hit-test door, so a drag that crosses the
// OVERLAP of two shapes resolves to "the two ELEMENTS the drag swept", not
// "the lens-shaped sub-region". The handler therefore unites/subtracts the
// whole swept elements (the regions named by the gesture rather than
// pre-selected). True region-level Shape Builder (merge/keep individual
// sub-faces of the planar map) needs a region hit-test + per-face boolean
// door — RFI gap B-22. Fewer than two distinct elements swept ⇒ no-op.

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  Mutation,
  PathfinderKind,
} from "@paged-media/plugin-api";

import {
  ShapeBuilderMachine,
  type ShapeBuilderMode,
  type ShapeBuilderSnapshot,
} from "@paged-media/draw-tools";

/** The path-bearing kinds the Shape Builder operates on (the engine's
 *  pathfinderBoolean operands — the same closed-path family the four
 *  Pathfinder commands accept). */
const BOOLEAN_KINDS = new Set(["polygon", "rectangle", "oval"]);

/** Map the gesture mode to the wire `PathfinderKind`. Unite = union;
 *  subtract = the engine's `subtract` (kept minus the rest). */
export function pathfinderKindFor(mode: ShapeBuilderMode): PathfinderKind {
  return mode === "subtract" ? "subtract" : "union";
}

/** The ONE `pathfinderBoolean` a finished gesture commits: the FIRST
 *  swept element is kept (receives the result + keeps its identity), the
 *  rest are `others` (united into / subtracted from it). Exported so the
 *  conformance spec asserts the EXACT wire shape the gesture emits (no
 *  second copy to drift from). Returns null when fewer than two distinct
 *  operands were swept (the honest no-op). */
export function shapeBuilderMutationFor(
  swept: ElementId[],
  mode: ShapeBuilderMode,
): Mutation | null {
  if (swept.length < 2) return null;
  const [kept, ...others] = swept;
  return {
    op: "pathfinderBoolean",
    args: { kept, others, kind: pathfinderKindFor(mode) },
  };
}

/** Build the Shape Builder gesture handler bound to `host` (the B-17
 *  factory shape — every engine touch is a `host.*` facade). */
export function createShapeBuilderHandler(host: BundleHost): GestureHandler {
  let machine: ShapeBuilderMachine | null = null;
  let pageId: string | null = null;
  // The element id resolved per crossed key — so pointer-up can rebuild
  // the typed ElementId operands the machine only tracks by string key.
  const byKey = new Map<string, ElementId>();

  const render = (snapshot: ShapeBuilderSnapshot) => {
    if (!snapshot.path || snapshot.path.length < 2 || !pageId) {
      host.overlay.setToolPreview(null);
      return;
    }
    host.overlay.setToolPreview({
      pageId,
      points: snapshot.path.map((p) => [p[0], p[1]] as [number, number]),
    });
  };

  /** Hit-test the engine at `point` and, when it resolves a boolean-
   *  capable element, feed the machine a `cross` event (de-duped there).
   *  Best-effort + async; a miss is silent. */
  const sweep = (point: [number, number]) => {
    if (!machine || !pageId) return;
    void (async () => {
      try {
        const hit = await host.document.hitTest(pageId!, point, "frame");
        const el = hit?.element ?? null;
        if (!el || !BOOLEAN_KINDS.has(el.kind) || !machine) return;
        byKey.set(el.id as string, el);
        render(machine.handle({ type: "cross", key: el.id as string }));
      } catch {
        /* hit-test is best-effort — a miss just adds no operand */
      }
    })();
  };

  return {
    onActivate() {
      machine = new ShapeBuilderMachine();
      byKey.clear();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      machine = null;
      pageId = null;
      byKey.clear();
      host.overlay.setToolPreview(null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!machine || e.button !== 0 || !e.pageId || !e.pagePoint) return;
      pageId = e.pageId;
      byKey.clear();
      render(
        machine.handle({
          type: "down",
          point: e.pagePoint,
          modifiers: { alt: e.modifiers.alt },
        }),
      );
      sweep(e.pagePoint);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      render(machine.handle({ type: "move", point: e.pagePoint }));
      sweep(e.pagePoint);
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      const snap = machine.handle({ type: "up", point: e.pagePoint });
      host.overlay.setToolPreview(null);
      // Rebuild the typed operands in swept order; commit one boolean.
      void (async () => {
        const swept = snap.crossed
          .map((key) => byKey.get(key))
          .filter((el): el is ElementId => el != null);
        const mutation = shapeBuilderMutationFor(swept, snap.mode);
        if (!mutation) {
          host.log.debug(
            `shapeBuilder: ${swept.length} element(s) swept — needs ≥ 2; no-op`,
          );
          return;
        }
        const outcome = await host.document.mutate(mutation);
        if (!outcome.applied) {
          host.log.warn(
            `shapeBuilder rejected by engine: ${JSON.stringify(outcome.error)}`,
          );
          return;
        }
        await host.selection.set([swept[0]]);
      })();
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && machine) {
        render(machine.handle({ type: "key", key: "Escape" }));
      }
    },
  };
}
