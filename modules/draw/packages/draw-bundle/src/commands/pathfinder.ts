// Pathfinder — Unite / Subtract / Intersect / Exclude over the
// selection, the `pathfinderBoolean` wire consumers (the dash.ts
// command pattern).
//
// Semantics (InDesign's Pathfinder): the FIRST selected element is the
// `kept` target — it receives the boolean result (and keeps its
// styling/identity); every other selected element is consumed
// (`others`, removed by the engine). One mutation = one undo step
// (the engine restores the consumed elements on undo). Fewer than two
// selected ⇒ no-op (a debug log, never a throw).

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PathfinderKind,
} from "@paged-media/plugin-api";

export const PATHFINDER_COMMAND_CATEGORY = "Pathfinder";

export interface PathfinderPreset {
  /** The namespaced command id (under the manifest id). */
  id: string;
  title: string;
  /** The wire `PathfinderKind`. */
  kind: PathfinderKind;
}

/** The four pathfinder commands, in registration order. */
export const PATHFINDER_PRESETS: readonly PathfinderPreset[] = [
  {
    id: "media.paged.draw.command.pathfinderUnite",
    title: "Pathfinder: Unite",
    kind: "union",
  },
  {
    id: "media.paged.draw.command.pathfinderSubtract",
    title: "Pathfinder: Subtract",
    kind: "subtract",
  },
  {
    id: "media.paged.draw.command.pathfinderIntersect",
    title: "Pathfinder: Intersect",
    kind: "intersect",
  },
  {
    id: "media.paged.draw.command.pathfinderExclude",
    title: "Pathfinder: Exclude overlap",
    kind: "exclude",
  },
] as const;

/** The contributed command ids, in registration order. */
export const PATHFINDER_COMMAND_IDS = PATHFINDER_PRESETS.map((p) => p.id);

/** The `pathfinderBoolean{ kept, others, kind }` mutation one preset
 *  commits. Exported so the conformance spec asserts the EXACT wire
 *  shape the live command emits (no second copy to drift from). */
export function pathfinderMutationFor(
  kept: ElementId,
  others: ElementId[],
  kind: PathfinderKind,
): Mutation {
  return { op: "pathfinderBoolean", args: { kept, others, kind } };
}

/** Apply one pathfinder preset: first selected = kept, rest consumed.
 *  On success the kept (result) element is re-selected. */
export async function applyPathfinder(
  host: BundleHost,
  preset: PathfinderPreset,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length < 2) {
    host.log.debug(
      `${preset.id}: needs ≥ 2 selected elements (have ${selection.length}) — no-op`,
    );
    return;
  }
  const [kept, ...others] = selection;
  const outcome = await host.document.mutate(
    pathfinderMutationFor(kept, others, preset.kind),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${preset.id} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return;
  }
  await host.selection.set([kept]);
}

/** Register the four pathfinder commands. */
export function contributePathfinderCommands(host: BundleHost): Disposable {
  const disposers = PATHFINDER_PRESETS.map((preset) =>
    host.contribute.command({
      id: preset.id,
      title: preset.title,
      category: PATHFINDER_COMMAND_CATEGORY,
      handler: () => applyPathfinder(host, preset),
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
