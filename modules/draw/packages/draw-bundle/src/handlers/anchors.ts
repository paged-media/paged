// Add / Delete / Convert Anchor Point — the bundle-owned version
// (D3). Click tools on the Scissors pattern over the host-agnostic
// planners; built only from the public surface (plugin-sdk gesture
// kit + plugin-api types). Plan → Mutation translation:
//
//   insert  → batch [ pathPointSet(right@segStart),
//                     pathPointSet(left@segEnd),
//                     pathPointInsert(idx, anchor, prevSubpathStarts?) ]
//   remove  → pathPointRemove
//   convert → pathPointCurveType

import type {
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  Mutation,
  PagedEditor,
} from "@paged-media/plugin-api";
import { CLICK_DRAG_THRESHOLD_PX, pxToPt } from "@paged-media/plugin-sdk";

import { affineScale, inverseApplyAffine } from "@paged-media/draw-geometry";
import {
  planAnchorAdd,
  planAnchorConvert,
  planAnchorDelete,
  type AnchorEditPlan,
} from "@paged-media/draw-tools";

/** Screen-space pick radius around anchors / segments. */
const PICK_TOLERANCE_PX = 6;

export type AnchorEditMode = "add" | "delete" | "convert";

/** The four path-bearing kinds the path-topology mutations accept. */
function supportsPathEdit(id: ElementId): boolean {
  return (
    id.kind === "polygon" ||
    id.kind === "rectangle" ||
    id.kind === "textFrame" ||
    id.kind === "graphicLine"
  );
}

function mutationFor(plan: AnchorEditPlan, elementId: ElementId): Mutation {
  switch (plan.kind) {
    case "remove":
      return { op: "pathPointRemove", args: { elementId, index: plan.index } };
    case "convert":
      return {
        op: "pathPointCurveType",
        args: { elementId, index: plan.index, smooth: plan.smooth },
      };
    case "insert": {
      // Dispatch order matters: both endpoint handles update at their
      // OLD flat indices first, then the new anchor lands — one undo
      // entry via batch.
      const ops: Mutation[] = [
        {
          op: "pathPointSet",
          args: {
            elementId,
            index: plan.segStart,
            role: "right",
            position: plan.startRight,
          },
        },
        {
          op: "pathPointSet",
          args: {
            elementId,
            index: plan.segEnd,
            role: "left",
            position: plan.endLeft,
          },
        },
        {
          op: "pathPointInsert",
          args: {
            elementId,
            index: plan.insertIndex,
            anchor: plan.anchor,
            ...(plan.prevSubpathStarts !== undefined
              ? { prevSubpathStarts: plan.prevSubpathStarts }
              : {}),
          },
        },
      ];
      return { op: "batch", args: { ops } };
    }
  }
}

export function createAnchorEditHandler(mode: AnchorEditMode): GestureHandler {
  let paged: PagedEditor | null = null;

  const act = async (e: CanvasPointerEvent) => {
    if (!paged || !e.pageId || !e.pagePoint) return;
    const client = paged.client;
    // Resolve the target: hit-test first, single selection fallback
    // (a precise click on a hairline path isn't required).
    let target: ElementId | null = null;
    try {
      const reply = await client.send({
        kind: "hitTest",
        payload: { pageId: e.pageId, docPoint: e.pagePoint, filter: "any" },
      });
      if (reply.kind === "hitResult") target = reply.payload.element ?? null;
    } catch {
      /* fall through to the selection */
    }
    if (!target && paged.selection.elementSelection.length === 1) {
      target = paged.selection.elementSelection[0];
    }
    if (!target || !supportsPathEdit(target)) return;
    const result = await client.pathAnchors(target).catch(() => null);
    if (!result || result.pageId !== e.pageId) return;
    // Page-local → path-local (inverse itemTransform); pick tolerance
    // scaled so it stays screen-constant in transformed local space.
    const matrix = result.itemTransform ?? null;
    const local = inverseApplyAffine(matrix, e.pagePoint[0], e.pagePoint[1]);
    if (!local) return;
    const tolerance =
      pxToPt(paged.camera.camera.scale, PICK_TOLERANCE_PX) /
      affineScale(matrix);
    const plan =
      mode === "add"
        ? planAnchorAdd(result, local, tolerance)
        : mode === "delete"
          ? planAnchorDelete(result, local, tolerance)
          : planAnchorConvert(result, local, tolerance);
    if (!plan) return;
    const reply = await client.mutate(mutationFor(plan, target));
    if (reply.kind === "mutationFailed") {
      // eslint-disable-next-line no-console
      console.warn(
        `anchor ${mode} rejected by engine:`,
        JSON.stringify((reply as { payload?: unknown }).payload),
      );
    }
  };

  return {
    onActivate(p) {
      paged = p;
    },
    onDeactivate() {
      /* click tool — nothing in flight */
    },
    onPointerDown() {
      /* acts on pointer-up so click-vs-drag is decidable */
    },
    onPointerMove() {},
    onPointerUp(e: CanvasPointerEvent) {
      if (e.button !== 0 || e.maxDelta > CLICK_DRAG_THRESHOLD_PX) return;
      void act(e).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`anchor ${mode} failed:`, err);
      });
    },
  };
}
