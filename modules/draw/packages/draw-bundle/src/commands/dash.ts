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

// B-12 — stroke DASH editing as command-driven presets.
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

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";

import { registerCommand } from "../command-registry";
/** The dash-array PropertyPath (already on the wire — protocol ≥ 35).
 *  A literal type so it satisfies the `PropertyPath` union in the
 *  mutation arg without a cast (the §12.3 compat alarm holds). */
const DASH_PATH = "frameStrokeDashArray" as const;

/** A named dash preset: an alternating on/off run in pt (empty clears
 *  to a solid stroke). */
export interface DashPreset {
  /** The namespaced command id (under the manifest id). */
  id: string;
  /** The menu/command title. */
  title: string;
  /** The alternating on/off lengths in pt. `[]` ⇒ solid (clears). */
  lengths: number[];
}

/** The command category the dash presets group under. */
export const DASH_COMMAND_CATEGORY = "Stroke";

/** The four v1 dash presets. Solid clears the array; the rest are
 *  alternating on/off pt runs (Dashed 6/3, Dotted 1/3, DashDot
 *  6/3/1/3). */
export const DASH_PRESETS: readonly DashPreset[] = [
  {
    id: "media.paged.draw.command.strokeDashSolid",
    title: "Stroke: Solid",
    lengths: [],
  },
  {
    id: "media.paged.draw.command.strokeDashDashed",
    title: "Stroke: Dashed",
    lengths: [6, 3],
  },
  {
    id: "media.paged.draw.command.strokeDashDotted",
    title: "Stroke: Dotted",
    lengths: [1, 3],
  },
  {
    id: "media.paged.draw.command.strokeDashDashDot",
    title: "Stroke: Dash-dot",
    lengths: [6, 3, 1, 3],
  },
] as const;

/** The contributed command ids, in registration order. */
export const DASH_COMMAND_IDS = DASH_PRESETS.map((p) => p.id);

/** The `setElementProperty{ frameStrokeDashArray, lengths }` mutation
 *  one preset commits to one element. Exported so the conformance test
 *  asserts the EXACT wire shape the live command emits (no second copy
 *  to drift from). */
export function dashMutationFor(
  elementId: ElementId,
  preset: DashPreset,
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId,
      path: DASH_PATH,
      value: { type: "lengths", value: preset.lengths },
    },
  };
}

/** Apply one dash preset to the current selection: commit the
 *  `frameStrokeDashArray` mutation to each selected element through the
 *  document door. No selection ⇒ no-op (a debug log, never a throw). */
export async function applyDashPreset(
  host: BundleHost,
  preset: DashPreset,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${preset.id}: no selection — no-op`);
    return;
  }
  for (const elementId of selection) {
    const outcome = await host.document.mutate(dashMutationFor(elementId, preset));
    if (!outcome.applied) {
      host.log.warn(
        `${preset.id} rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  }
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
  entries: readonly { path: string; value?: { type: string; value?: unknown } | null }[],
): number[] | null {
  for (const e of entries) {
    if (e.path !== DASH_PATH || !e.value || e.value.type !== "lengths") continue;
    const v = e.value.value;
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  }
  return null;
}

/** ONE batch writing `lengths` to every element — one undo step for the
 *  whole selection (the presets above write one mutation per element). */
export function dashBatchFor(elementIds: readonly ElementId[], lengths: readonly number[]): Mutation {
  return {
    op: "batch",
    args: {
      ops: elementIds.map((elementId) =>
        dashMutationFor(elementId, { id: "", title: "", lengths: [...lengths] }),
      ),
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
    host.log.warn(`stroke dashes rejected by engine: ${JSON.stringify(outcome.error)}`);
    return [];
  }
  return [...targets];
}

/** Register all four dash-preset commands. Each handler ignores its
 *  `(paged, payload)` args and drives the bundle's own `host` (the
 *  plugin-web command pattern). Returns a Disposable that drops every
 *  registration (the host also tracks them for teardown). */
export function contributeDashCommands(host: BundleHost): Disposable {
  const disposers = DASH_PRESETS.map((preset) =>
    registerCommand(host, {
      id: preset.id,
      title: preset.title,
      category: DASH_COMMAND_CATEGORY,
      handler: () => applyDashPreset(host, preset),
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
