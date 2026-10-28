// The rasterImage context's history as the host's History panel lists it
// (editor ADR 285, image ADR 477). Without snapshots it is the journal's
// steps. With snapshots it is Photoshop's History panel: the snapshots
// first, then a row for the oldest kept state, then the steps. The
// panel's contract (`EditContextHistory`) is a list of labels and a walk
// by `delta`, so the snapshot rows are positions in that list: a click on
// one restores it (one new undo step), a click on the state row undoes
// every kept step, and a click on a step walks to it as before. The state
// row also keeps the newest snapshot from ever being the list's last row,
// which the panel marks as the current state.

import type { EditContextHistory } from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import type { ImageSession } from "./session";

const M = defineMessages("image.contextHistory", {
  snapshot: "Snapshot: {name}",
  start: "Oldest kept state",
});

type Session = Pick<
  ImageSession,
  "state" | "undoSteps" | "redoSteps" | "restoreSnapshot"
>;

export function contextHistory(session: Session): EditContextHistory | null {
  const h = session.state().history;
  if (!h) return null;
  const walk = (delta: number) =>
    delta < 0 ? session.undoSteps(-delta) : session.redoSteps(delta);
  const snaps = h.snapshots ?? [];
  if (snaps.length === 0)
    return { undo: h.undoSteps, redo: h.redoSteps, step: walk };
  const k = snaps.length;
  const steps = h.undoSteps.length;
  const undo = [
    ...snaps.map((s) => t(M.snapshot, { name: s.name })),
    t(M.start),
    ...h.undoSteps,
  ];
  const n = undo.length;
  return {
    undo,
    redo: h.redoSteps,
    step(delta: number) {
      if (delta > 0) return session.redoSteps(delta);
      const target = n - 1 + delta;
      if (target > k) return walk(delta);
      if (target >= 0 && target < k)
        return session.restoreSnapshot(snaps[target].id);
      // The state row (or the panel's own origin row above it).
      return session.undoSteps(steps);
    },
  };
}
