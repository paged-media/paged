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

// B-12 — stroke DASH editing: the EDITOR's builders. The four preset
// COMMANDS (Solid / Dashed / Dotted / Dash-dot) are the host's
// (`paged.stroke.dash*`, PM-0017), written through the same shared op.
//
// `frameStrokeDashArray` is on the wire (a `setElementProperty`
// PropertyPath taking a `Lengths` value = alternating on/off pt
// lengths; empty clears). The schema binding ceiling is scalar
// (`literal | selectionProperty`, B-01), and a dash array is a VECTOR,
// so an inline scrub can't bind it. Instead each preset is a COMMAND:
// it commits a fixed `lengths` value to every selected element through
// `host.document.mutate` (the single write door). No inline array
// scrubs are faked — the honest v1 (the stroke panel's dash section
// points the author at these commands).
//
// Host-agnostic: imports only plugin-api types. Commands register
// through `host.contribute.command` (the plugin-web pattern); every
// engine touch is a `host.*` facade.

import type { BundleHost, ElementId, Mutation } from "@paged-media/plugin-api";

import { dashArrayOp } from "@paged-media/helpers";

/** The dash-array PropertyPath (already on the wire — protocol ≥ 35).
 *  A literal type so it satisfies the `PropertyPath` union in the
 *  mutation arg without a cast (the §12.3 compat alarm holds). */
const DASH_PATH = "frameStrokeDashArray" as const;

/** The `setElementProperty{ frameStrokeDashArray, lengths }` mutation
 *  one preset commits to one element. Exported so the conformance test
 *  asserts the EXACT wire shape the live command emits (no second copy
 *  to drift from). */
export function dashMutationFor(
  elementId: ElementId,
  lengths: readonly number[],
): Mutation {
  return dashArrayOp(elementId, lengths) as Mutation;
}

// ------------------------------------------------------- the dash EDITOR
//
// The presets above are four fixed arrays. The editor (the Stroke dashes
// section of the Path Options panel — `commands/path-options.ts` says
// why it lives there) types its own: up to `MAX_DASH_PAIRS` dash/gap
// pairs, written through the SAME property, read back for the selection.

/** The most dash/gap pairs the editor offers — Illustrator's three. */
export const MAX_DASH_PAIRS = 3;

/** The engine's dash array as it reads back (`elementProperties`
 *  answers `{ type: "lengths", value: [] }` for a solid stroke). Null
 *  when the entry is absent. Pure. */
export function dashArrayFrom(
  entries: readonly {
    path: string;
    value?: { type: string; value?: unknown } | null;
  }[],
): number[] | null {
  for (const e of entries) {
    if (e.path !== DASH_PATH || !e.value || e.value.type !== "lengths")
      continue;
    const v = e.value.value;
    return Array.isArray(v)
      ? v.filter((n): n is number => typeof n === "number")
      : [];
  }
  return null;
}

/** ONE batch writing `lengths` to every element — one undo step for the
 *  whole selection (the presets and the editor both commit through it). */
export function dashBatchFor(
  elementIds: readonly ElementId[],
  lengths: readonly number[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: elementIds.map((elementId) => dashMutationFor(elementId, lengths)),
    },
  };
}

/** Write `lengths` to every PATH in the selection (`[]` = solid), in one
 *  batch. Answers the ids written; empty = a logged no-op. */
export async function applyDashArray(
  host: BundleHost,
  lengths: readonly number[],
  targets: readonly ElementId[],
): Promise<ElementId[]> {
  if (targets.length === 0) {
    host.log.debug("stroke dashes: no path selected — no-op");
    return [];
  }
  const outcome = await host.document.mutate(dashBatchFor(targets, lengths));
  if (!outcome.applied) {
    host.log.warn(
      `stroke dashes rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return [];
  }
  return [...targets];
}
