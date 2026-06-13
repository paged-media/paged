// The Pencil (freehand) tool's gesture handler — host-routed shim over
// draw-tools' PencilMachine: pointer samples feed the machine, the live
// stroke previews as a POLYLINE (the raw decimated samples — honest:
// smoothing happens at commit, so previewing the samples shows what was
// actually drawn), and the pointer-up commit (RDP-simplified +
// Catmull-Rom-fitted anchors) becomes ONE `insertPath` through
// `host.document.mutate`.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";

import { PencilMachine, type PencilSnapshot } from "@paged-media/draw-tools";

import { insertPathMutationFor } from "./insert-path";

/** Screen-space RDP fidelity: pointer wobble below this collapses. */
const SIMPLIFY_TOLERANCE_PX = 2;
/** Screen-space lift-near-the-start radius that closes the contour. */
const CLOSE_TOLERANCE_PX = 8;

export function createPencilHandler(host: BundleHost): GestureHandler {
  let machine: PencilMachine | null = null;
  let pageId: string | null = null;

  const reset = () => {
    machine = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const sync = (snapshot: PencilSnapshot) => {
    if (snapshot.commit && pageId) {
      const c = snapshot.commit;
      const page = pageId;
      reset();
      void host.document
        .mutate(insertPathMutationFor(page, c.anchors, c.open))
        .then(async (outcome) => {
          if (!outcome.applied) {
            host.log.warn(
              `pencil insertPath rejected by engine: ${JSON.stringify(outcome.error)}`,
            );
            return;
          }
          if (outcome.createdId) await host.selection.set([outcome.createdId]);
        })
        .catch((err) => host.log.warn(`pencil commit failed: ${err}`));
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
      machine = new PencilMachine({
        tolerance: host.viewport.pxToPt(SIMPLIFY_TOLERANCE_PX),
        closeTolerance: host.viewport.pxToPt(CLOSE_TOLERANCE_PX),
      });
      pageId = e.pageId;
      sync(machine.handle({ type: "down", point: e.pagePoint }));
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      sync(machine.handle({ type: "move", point: e.pagePoint }));
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine) return;
      // Lifting off-page commits at the last on-page sample.
      const point =
        e.pageId === pageId && e.pagePoint ? e.pagePoint : undefined;
      const snap = point
        ? machine.handle({ type: "up", point })
        : machine.handle({ type: "key", key: "Escape" });
      sync(snap);
    },
    onKey(e: KeyboardEvent) {
      if (!machine || e.key !== "Escape") return;
      sync(machine.handle({ type: "key", key: "Escape" }));
    },
  };
}
