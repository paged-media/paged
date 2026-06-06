// The gesture kit — the page-anchored-drag bookkeeping every drawing
// tool repeats, extracted from the editor's private handler helpers
// (resolves plugin-draw BREAKAGE_LOG B-11): a drag is anchored to the
// page under the pointer at pointer-down, and BOTH endpoints resolve
// against that page so the result is correct even when the pointer
// releases over another page or the pasteboard.

import type {
  CanvasPointerEvent,
  ElementId,
  Mutation,
  MutationOutcome,
  PagedEditor,
} from "@paged-media/plugin-api";

export const CLICK_DRAG_THRESHOLD_PX = 4;

/** A drag anchored to the page under the pointer at pointer-down. */
export interface PageDrag {
  pageId: string;
  /** Page origin in document pt (docPoint − pagePoint at down). */
  pageOrigin: [number, number];
  /** Pointer-down position in page-local pt. */
  startLocal: [number, number];
}

export function beginPageDrag(e: CanvasPointerEvent): PageDrag | null {
  if (e.button !== 0 || !e.pageId || !e.pagePoint) return null;
  return {
    pageId: e.pageId,
    pageOrigin: [
      e.docPoint[0] - e.pagePoint[0],
      e.docPoint[1] - e.pagePoint[1],
    ],
    startLocal: e.pagePoint,
  };
}

/** Current pointer position in the START page's local coordinates. */
export function endLocalFor(
  drag: PageDrag,
  e: CanvasPointerEvent,
): [number, number] {
  return [
    e.docPoint[0] - drag.pageOrigin[0],
    e.docPoint[1] - drag.pageOrigin[1],
  ];
}

/** Screen px → document pt at `scale`, the constant-screen-tolerance
 *  idiom. Falls back to 1:1 when the camera hasn't initialised. */
export function pxToPt(scale: number, px: number): number {
  return px / (scale > 0 ? scale : 1);
}

/**
 * Fire a mutation and select the element the engine reports as
 * created, so a fresh shape immediately carries selection chrome —
 * the post-insert flow every drawing tool wants. Failures resolve
 * (never throw); the outcome is returned for optional handling.
 */
export async function commitAndSelect(
  paged: PagedEditor,
  mutation: Mutation,
  label: string,
): Promise<MutationOutcome> {
  try {
    const reply = await paged.client.mutate(mutation);
    if (reply.kind !== "mutationApplied") {
      const error =
        reply.kind === "mutationFailed"
          ? (reply as { payload?: unknown }).payload
          : reply;
      // eslint-disable-next-line no-console
      console.warn(`${label} rejected by engine:`, JSON.stringify(error));
      return { applied: false, error };
    }
    const createdId: ElementId | null = reply.payload.createdId ?? null;
    if (createdId) {
      try {
        const ids = await paged.client.setElementSelection(
          [createdId],
          "replace",
        );
        paged.selection.setElementSelection(ids);
        const items = await paged.client.elementGeometry(ids);
        paged.selection.setElementGeometry(items);
      } catch {
        // Selection chrome is best-effort; the mutation stands.
      }
    }
    return {
      applied: true,
      createdId,
      pageIds: reply.payload.pageIds,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`${label} failed:`, error);
    return { applied: false, error };
  }
}
