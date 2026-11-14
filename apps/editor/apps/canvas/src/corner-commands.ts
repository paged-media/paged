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

// `paged.corners.*` — the five corner presets as host commands.
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A PLUGIN. A corner option and a
// radius are properties of the page item (`frameCornerOption*` /
// `frameCornerRadius*`), the shape section and the on-canvas widgets already
// edit them, and a preset is the same eight writes. paged.draw carried the
// preset commands and their menu alone (two implementations; PM-0017). The
// writes are the shared ones (`cornerPresetOps` in `@paged-media/helpers`),
// which paged.draw's Corner Radius tool builds through as well.
//
//  1. THE KINDS ARE THE ENGINE'S: rectangle, polygon and text frame are the
//     ones whose corners it both accepts and renders. Anything else in the
//     selection is skipped; nothing eligible sends nothing.
//  2. ONE BATCH for the whole selection, so one undo takes the preset back.
//  3. A POLYGON takes its geometry from the top-left slot only (the other
//     three round-trip), and the presets write that slot first.
//  4. THE ENGINE'S REFUSAL is reported in words.

import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { commandNeeds } from "@paged-media/shell";
import type { CanvasClient, ElementId, Mutation } from "@paged-media/client";
import { refusalText } from "@paged-media/panel-kit";
import {
  cornerPresetOps,
  supportsLiveCornerKind,
  type CornerStyleToken,
} from "@paged-media/helpers";
import { defineMessages, t } from "@paged-media/strings";

import { objectVerbApplies } from "./object-commands";

const M = defineMessages("app.cornerCommands", {
  rounded: "Corners: Rounded",
  inverseRounded: "Corners: Inverse rounded",
  bevel: "Corners: Bevel",
  fancy: "Corners: Fancy",
  none: "Corners: None (square)",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  Corners: "Corners",
  Rounded: "Rounded",
  "Inverse rounded": "Inverse rounded",
  Bevel: "Bevel",
  Fancy: "Fancy",
  None: "None",
});

export const PAGED_CORNERS_ROUNDED = "paged.corners.rounded";
export const PAGED_CORNERS_INVERSE_ROUNDED = "paged.corners.inverseRounded";
export const PAGED_CORNERS_BEVEL = "paged.corners.bevel";
export const PAGED_CORNERS_FANCY = "paged.corners.fancy";
export const PAGED_CORNERS_NONE = "paged.corners.none";

/** The Problems panel's source id for these commands. */
export const CORNER_DIAGNOSTIC_SOURCE = "paged.corners";

/** The radius (pt) the styled presets apply. */
export const DEFAULT_CORNER_RADIUS_PT = 12;

interface Preset {
  id: string;
  title: string;
  menu: string;
  style: CornerStyleToken;
  radius: number;
}

const PRESETS: readonly Preset[] = [
  {
    id: PAGED_CORNERS_ROUNDED,
    title: M.rounded,
    menu: "Rounded",
    style: "RoundedCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: PAGED_CORNERS_INVERSE_ROUNDED,
    title: M.inverseRounded,
    menu: "Inverse rounded",
    style: "InverseRoundedCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: PAGED_CORNERS_BEVEL,
    title: M.bevel,
    menu: "Bevel",
    style: "BeveledCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: PAGED_CORNERS_FANCY,
    title: M.fancy,
    menu: "Fancy",
    style: "FancyCorner",
    radius: DEFAULT_CORNER_RADIUS_PT,
  },
  {
    id: PAGED_CORNERS_NONE,
    title: M.none,
    menu: "None",
    style: "None",
    radius: 0,
  },
];

/** What a run needs of the app: the client and the live selection. */
export interface CornerDeps {
  client: Pick<CanvasClient, "mutate">;
  getSelection: () => readonly ElementId[];
}

/** Apply one preset to the selection's corner-bearing items, in one batch.
 *  Answers the engine's refusal in words, or null. */
export async function applyCornerPreset(
  deps: CornerDeps,
  style: CornerStyleToken,
  radius: number,
): Promise<string | null> {
  const targets = deps
    .getSelection()
    .filter((id) => supportsLiveCornerKind(id.kind));
  if (targets.length === 0) return null;
  const reply = await deps.client.mutate({
    op: "batch",
    args: {
      ops: targets.flatMap(
        (id) => cornerPresetOps(id, style, radius) as Mutation[],
      ),
    },
  });
  if (reply.kind !== "mutationFailed") return null;
  return refusalText(reply.payload.error, "Corners");
}

/** The five commands. `report` lands a refusal in the Problems panel. */
export function buildCornerCommands(
  deps: CornerDeps,
  report: (message: string) => void,
  clear: () => void,
): CommandContribution[] {
  return PRESETS.map((p) => ({
    id: p.id,
    title: t(p.title),
    category: "Corners",
    when: objectVerbApplies,
    applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
    handler: async () => {
      clear();
      const refusal = await applyCornerPreset(deps, p.style, p.radius);
      if (refusal) report(refusal);
    },
  }));
}

/** Object > Corners > <preset>. */
export const CORNER_MENU_ITEMS: MenuItemContribution[] = PRESETS.map(
  (p, i) => ({
    path: `Object/Corners/${p.menu}`,
    command: p.id,
    order: 69 + (i + 1) / 100,
    group: "corners",
    when: objectVerbApplies,
    applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
  }),
);
