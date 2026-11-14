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

// `paged.appearance.*` — the Appearance panel's stack operations as host
// commands: Add fill, Add stroke, Clear, Remove layer, Move layer.
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A PLUGIN. The engine's native
// appearance (`frameAppearance`, ADR 1043) is the host's panel's. The panel
// edits it by gesture only, while paged.draw carried the five commands (the
// palette and scripting entry) and its own copy of the list functions
// (PM-0017). The list functions are `panels/appearance-layers.ts`, the
// panel's own; these commands read the selection's `frameAppearance`, apply
// the same function and write the whole list back.
//
//  1. THE ENGINE TAKES THE LIST WHOLE, so each command is one
//     `setElementProperty` per selected item, all in ONE batch: one undo.
//  2. LAYER ADDRESSING, as draw's commands took it: `{ layer }` is the
//     index in the bottom-to-top list as drawn; `{ kind, index }` addresses
//     the extra (non-placeholder) layers of one kind, bottom to top. The
//     move payload takes `{ delta }` or `{ direction: "up" | "down" }`
//     (up is towards the front).
//  3. A PLACEHOLDER (the item's own fill or stroke) cannot be removed; it
//     moves like any layer.
//  4. THE ENGINE'S REFUSAL is reported in words.

import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { commandNeeds } from "@paged-media/shell";
import type { CanvasClient, ElementId, Mutation } from "@paged-media/client";
import { refusalText } from "@paged-media/panel-kit";
import { defineMessages, t } from "@paged-media/strings";

import { isPageItem, objectVerbApplies } from "./object-commands";
import {
  addFill,
  addStroke,
  appearanceValue,
  clear,
  explicit,
  isPlaceholder,
  layersOf,
  move,
  remove,
  type FrameSeed,
  type PaintLayer,
} from "./panels/appearance-layers";

const M = defineMessages("app.appearanceCommands", {
  addFill: "Appearance: Add fill",
  addStroke: "Appearance: Add stroke",
  clear: "Appearance: Clear",
  removeLayer: "Appearance: Remove layer",
  moveLayer: "Appearance: Move layer",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  Appearance: "Appearance",
  "Add fill": "Add fill",
  "Add stroke": "Add stroke",
  Clear: "Clear",
});

export const PAGED_APPEARANCE_ADD_FILL = "paged.appearance.addFill";
export const PAGED_APPEARANCE_ADD_STROKE = "paged.appearance.addStroke";
export const PAGED_APPEARANCE_CLEAR = "paged.appearance.clear";
export const PAGED_APPEARANCE_REMOVE_LAYER = "paged.appearance.removeLayer";
export const PAGED_APPEARANCE_MOVE_LAYER = "paged.appearance.moveLayer";

/** The Problems panel's source id for these commands. */
export const APPEARANCE_DIAGNOSTIC_SOURCE = "paged.appearance";

type Payload = Record<string, unknown> | undefined;

/** What a run needs of the app: the client and the live selection. */
export interface AppearanceDeps {
  client: Pick<CanvasClient, "mutate" | "elementProperties">;
  getSelection: () => readonly ElementId[];
}

const entryValue = (
  props: { entries: readonly { path: string; value?: unknown }[] } | null,
  path: string,
): unknown => {
  const v = props?.entries.find((e) => e.path === path)?.value;
  return v && typeof v === "object" && "value" in v
    ? (v as { value: unknown }).value
    : undefined;
};

/** Which index of the explicit list a payload addresses, or -1. */
function layerAt(layers: readonly PaintLayer[], p: Payload): number {
  const all = explicit(layers);
  if (typeof p?.layer === "number" && Number.isInteger(p.layer)) return p.layer;
  const kind = p?.kind === "stroke" ? "stroke" : "fill";
  const nth =
    typeof p?.index === "number" && Number.isInteger(p.index) && p.index >= 0
      ? p.index
      : -1;
  const extras = all
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !isPlaceholder(l) && l.kind === kind);
  return extras[nth]?.i ?? -1;
}

const deltaOf = (p: Payload): number =>
  typeof p?.delta === "number" && Number.isInteger(p.delta)
    ? p.delta
    : p?.direction === "down"
      ? -1
      : 1;

/** Apply `next` to the appearance of every selected page item, in one
 *  batch. Answers the engine's refusal in words, or null. */
export async function editAppearance(
  deps: AppearanceDeps,
  next: (layers: PaintLayer[], seed: FrameSeed) => PaintLayer[],
): Promise<string | null> {
  const targets = deps.getSelection().filter(isPageItem);
  const ops: Mutation[] = [];
  for (const elementId of targets) {
    const props = await deps.client.elementProperties(elementId);
    if (!props) continue;
    const layers = layersOf(entryValue(props, "frameAppearance")) ?? [];
    const str = (path: string) => {
      const v = entryValue(props, path);
      return typeof v === "string" ? v : null;
    };
    const weight = entryValue(props, "frameStrokeWeight");
    const seed: FrameSeed = {
      fillColor: str("frameFillColor"),
      strokeColor: str("frameStrokeColor"),
      strokeWeight: typeof weight === "number" ? weight : null,
    };
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameAppearance",
        value: appearanceValue(next([...layers], seed)),
      },
    } as unknown as Mutation);
  }
  if (ops.length === 0) return null;
  const reply = await deps.client.mutate({ op: "batch", args: { ops } });
  if (reply.kind !== "mutationFailed") return null;
  return refusalText(reply.payload.error, "Appearance");
}

interface Verb {
  id: string;
  title: string;
  menu?: string;
  edit: (p: Payload) => (l: PaintLayer[], seed: FrameSeed) => PaintLayer[];
}

const VERBS: readonly Verb[] = [
  {
    id: PAGED_APPEARANCE_ADD_FILL,
    title: M.addFill,
    menu: "Add fill",
    edit: () => (l, seed) => addFill(l, seed),
  },
  {
    id: PAGED_APPEARANCE_ADD_STROKE,
    title: M.addStroke,
    menu: "Add stroke",
    edit: () => (l, seed) => addStroke(l, seed),
  },
  {
    id: PAGED_APPEARANCE_CLEAR,
    title: M.clear,
    menu: "Clear",
    edit: () => () => clear(),
  },
  {
    id: PAGED_APPEARANCE_REMOVE_LAYER,
    title: M.removeLayer,
    edit: (p) => (l) => remove(l, layerAt(l, p)),
  },
  {
    id: PAGED_APPEARANCE_MOVE_LAYER,
    title: M.moveLayer,
    edit: (p) => (l) => move(l, layerAt(l, p), deltaOf(p)),
  },
];

/** The five commands. `report` lands a refusal in the Problems panel. */
export function buildAppearanceCommands(
  deps: AppearanceDeps,
  report: (message: string) => void,
  clearReport: () => void,
): CommandContribution[] {
  return VERBS.map((v) => ({
    id: v.id,
    title: t(v.title),
    category: "Appearance",
    when: objectVerbApplies,
    applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
    handler: async (_paged: unknown, payload: unknown) => {
      clearReport();
      const refusal = await editAppearance(deps, v.edit(payload as Payload));
      if (refusal) report(refusal);
    },
  }));
}

/** Object > Appearance > Add fill / Add stroke / Clear. */
export const APPEARANCE_MENU_ITEMS: MenuItemContribution[] = VERBS.filter(
  (v) => v.menu,
).map((v, i) => ({
  path: `Object/Appearance/${v.menu}`,
  command: v.id,
  order: 71.5 + i / 100,
  group: "appearance",
  when: objectVerbApplies,
  applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
}));
