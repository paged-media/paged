/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// `paged.stroke.dash*` — the four stroke dash presets as host commands
// (Solid, Dashed, Dotted, Dash-dot).
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A PLUGIN. `frameStrokeDashArray`
// is a page-item property the Stroke panel's "Dashes & arrows" section
// already edits; the presets were reachable only as paged.draw commands
// (PM-0017). The write is the shared one (`dashArrayOp` in
// `@paged-media/helpers`), which paged.draw's own dash editor builds through
// as well.
//
//  1. ONE BATCH for the whole selection, so one undo takes the preset back.
//  2. EVERY SELECTED PAGE ITEM is written, as draw's commands did; the
//     engine refuses what has no dash array, and the refusal is reported in
//     words.
//  3. PALETTE ONLY for the presets (draw had no menu rows for them); the
//     editor's `Dashes…` row is Object > Stroke > Dashes…, which raises the
//     Stroke panel.

import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { commandNeeds } from "@paged-media/shell";
import type { CanvasClient, ElementId, Mutation } from "@paged-media/client";
import { refusalText } from "@paged-media/panel-kit";
import { DASH_PRESET_LENGTHS, dashArrayOp } from "@paged-media/helpers";
import { defineMessages, t } from "@paged-media/strings";

import { isPageItem, objectVerbApplies } from "./object-commands";

const M = defineMessages("app.strokeDashCommands", {
  solid: "Stroke: Solid",
  dashed: "Stroke: Dashed",
  dotted: "Stroke: Dotted",
  dashDot: "Stroke: Dash-dot",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  Stroke: "Stroke",
  "Dashes…": "Dashes…",
});

export const PAGED_STROKE_DASH_SOLID = "paged.stroke.dashSolid";
export const PAGED_STROKE_DASH_DASHED = "paged.stroke.dashDashed";
export const PAGED_STROKE_DASH_DOTTED = "paged.stroke.dashDotted";
export const PAGED_STROKE_DASH_DASH_DOT = "paged.stroke.dashDashDot";

/** The Problems panel's source id for these commands. */
export const STROKE_DASH_DIAGNOSTIC_SOURCE = "paged.stroke";

/** What a run needs of the app: the client and the live selection. */
export interface StrokeDashDeps {
  client: Pick<CanvasClient, "mutate">;
  getSelection: () => readonly ElementId[];
}

/** Write `lengths` to every selected page item, in one batch. Answers the
 *  engine's refusal in words, or null. */
export async function applyDashLengths(
  deps: StrokeDashDeps,
  lengths: readonly number[],
): Promise<string | null> {
  const targets = deps.getSelection().filter(isPageItem);
  if (targets.length === 0) return null;
  const reply = await deps.client.mutate({
    op: "batch",
    args: { ops: targets.map((id) => dashArrayOp(id, lengths) as Mutation) },
  });
  if (reply.kind !== "mutationFailed") return null;
  return refusalText(reply.payload.error, "Stroke");
}

const PRESETS = [
  {
    id: PAGED_STROKE_DASH_SOLID,
    title: M.solid,
    lengths: DASH_PRESET_LENGTHS.solid,
  },
  {
    id: PAGED_STROKE_DASH_DASHED,
    title: M.dashed,
    lengths: DASH_PRESET_LENGTHS.dashed,
  },
  {
    id: PAGED_STROKE_DASH_DOTTED,
    title: M.dotted,
    lengths: DASH_PRESET_LENGTHS.dotted,
  },
  {
    id: PAGED_STROKE_DASH_DASH_DOT,
    title: M.dashDot,
    lengths: DASH_PRESET_LENGTHS.dashDot,
  },
] as const;

/** The four commands. `report` lands a refusal in the Problems panel. */
export function buildStrokeDashCommands(
  deps: StrokeDashDeps,
  report: (message: string) => void,
  clear: () => void,
): CommandContribution[] {
  return PRESETS.map((p) => ({
    id: p.id,
    title: t(p.title),
    category: "Stroke",
    when: objectVerbApplies,
    applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
    handler: async () => {
      clear();
      const refusal = await applyDashLengths(deps, p.lengths);
      if (refusal) report(refusal);
    },
  }));
}

/** Object > Stroke > Dashes… raises the Stroke panel, whose dash editor is
 *  the entry draw's `Dashes…` row opened its own panel for. */
export const STROKE_DASH_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "Object/Stroke/Dashes…",
    command: "paged.panel.show.paged.stroke",
    order: 66.5,
    group: "stroke",
  },
];
