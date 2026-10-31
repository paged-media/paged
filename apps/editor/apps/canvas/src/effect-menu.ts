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

// Editor ADR 309 — Object ▸ Effects ▸ <group> ▸ <effect>: Illustrator's
// Effect menu on the ordered effect stack (engine ADR 1008). Its rows are
// core's catalog (`CORE_EFFECT_KINDS` through effect-stack.ts): one
// submenu per Effect menu group that holds a kind, one row per kind, so a
// kind the engine adds appears here without a change to the editor (plan
// C16). A row appends the effect, at its defaults, to the OBJECT stack of
// every selected item that takes it — all of them in one batch, so one
// undo step — and raises the Appearance panel, where its parameters are.
//
// The rows apply in every edit context (WP10.7): an effect is a property
// of the page item, whichever module made it, so the only condition is a
// selection.

import { cockpitActionsOf, scopeOf } from "@paged-media/shell";
import type {
  CommandContribution,
  MenuItemContribution,
  PagedEditor,
} from "@paged-media/shell";
import { activeStrings, defineMessages, t } from "@paged-media/strings";

import {
  STACK_PATHS,
  add,
  canAdd,
  effectMenu,
  entriesOf,
  kindOf,
  stackValue,
  type StackEntry,
} from "./panels/effect-stack";
import { effectName } from "./panels/effect-stack-section";

const M = defineMessages("app.effectMenu", {
  apply: "Apply effect: {name}",
});

// The menu's segments stay English (they are identities); the menu bar
// shows each through `menu.<segment>`. A kind or group core adds later
// shows its English name until a catalogue names it.
defineMessages("menu", {
  Effects: "Effects",
  Stylize: "Stylize",
  Blur: "Blur",
  Noise: "Noise",
  Color: "Color",
  "Distort & Transform": "Distort & Transform",
  Path: "Path",
  Pathfinder: "Pathfinder",
  Warp: "Warp",
  "Convert to Shape": "Convert to Shape",
  Rasterize: "Rasterize",
  "Drop shadow": "Drop shadow",
  "Inner shadow": "Inner shadow",
  "Outer glow": "Outer glow",
  "Inner glow": "Inner glow",
  "Bevel and emboss": "Bevel and emboss",
  Satin: "Satin",
  Feather: "Feather",
  "Directional feather": "Directional feather",
  "Gradient feather": "Gradient feather",
  "Gaussian blur": "Gaussian blur",
  "Stroke (layer style)": "Stroke (layer style)",
  "Color overlay": "Color overlay",
  "Gradient overlay": "Gradient overlay",
  Reflection: "Reflection",
  "Soft edge": "Soft edge",
  "Add noise": "Add noise",
  "Color adjustment": "Color adjustment",
});
defineMessages("commandCategory", { Object: "Object" });

/** Core's Effect menu groups by their English menu segment. */
const CATEGORY_SEGMENTS: Record<string, string> = {
  stylize: "Stylize",
  blur: "Blur",
  noise: "Noise",
  color: "Color",
  distortAndTransform: "Distort & Transform",
  path: "Path",
  pathfinder: "Pathfinder",
  warp: "Warp",
  convertToShape: "Convert to Shape",
  rasterize: "Rasterize",
};

export const EFFECT_COMMAND_PREFIX = "paged.effect.add.";
export const APPEARANCE_PANEL_ID = "paged.appearance";

/** The page items whose object target carries a stack. */
const STACK_KINDS = new Set(["textFrame", "rectangle", "oval", "polygon"]);

type ElementRef = { kind: string; id: string };

const addressOf = (e: ElementRef) => `${e.kind}:${e.id}`;

/** The batch that appends `kind` to each read stack that takes it, or
 *  `null` when none does. Pure: the command reads, this plans. */
export function planAddEffect(
  stacks: readonly { address: string; entries: readonly StackEntry[] }[],
  kind: string,
): { op: "batch"; args: { ops: unknown[] } } | null {
  const ops = stacks
    .filter((s) => canAdd(s.entries, "object", kind))
    .map((s) => ({
      op: "set",
      args: {
        address: s.address,
        path: STACK_PATHS.object,
        value: stackValue(add(s.entries, kind)),
      },
    }));
  return ops.length ? { op: "batch", args: { ops } } : null;
}

const hasSelection = (state: unknown): boolean =>
  ((
    state as {
      selection?: { elementSelection?: readonly unknown[] } | null;
    } | null
  )?.selection?.elementSelection?.length ?? 0) > 0;

async function readStack(
  paged: PagedEditor,
  address: string,
): Promise<StackEntry[] | null> {
  const reply = (await paged.client
    .send({
      kind: "requestGet",
      payload: { address, path: STACK_PATHS.object },
    } as never)
    .catch(() => null)) as {
    kind: string;
    payload?: { value?: unknown };
  } | null;
  return reply?.kind === "propertyValue"
    ? entriesOf(reply.payload?.value ?? null)
    : null;
}

/** Append `kind` to the selection's object stacks: one batch. */
export async function applyEffect(
  paged: PagedEditor,
  kind: string,
): Promise<boolean> {
  const selected = (paged.selection.elementSelection ?? []) as ElementRef[];
  const stacks: { address: string; entries: StackEntry[] }[] = [];
  for (const e of selected) {
    if (!STACK_KINDS.has(e.kind)) continue;
    const address = addressOf(e);
    const entries = await readStack(paged, address);
    if (entries) stacks.push({ address, entries });
  }
  const plan = planAddEffect(stacks, kind);
  if (!plan) return false;
  const reply = await paged.client.mutate(plan as never);
  if (reply.kind !== "mutationApplied") return false;
  cockpitActionsOf(scopeOf(paged)).openPanel?.(APPEARANCE_PANEL_ID);
  return true;
}

/** One command per kind core describes. */
export function buildEffectMenuCommands(): CommandContribution[] {
  return effectMenu().flatMap((group) =>
    group.kinds.map((k) => ({
      id: `${EFFECT_COMMAND_PREFIX}${k.kind}`,
      get title() {
        return t(M.apply, { name: effectName(activeStrings(), k.kind) });
      },
      category: "Object",
      when: hasSelection,
      handler: (paged: unknown) =>
        applyEffect(paged as PagedEditor, k.kind).then(() => undefined),
    })),
  );
}

/** Object ▸ Effects ▸ <group> ▸ <effect>, below Effects… and Global
 *  light…, one group per Effect menu group. */
export function buildEffectMenuItems(): MenuItemContribution[] {
  return effectMenu().flatMap((group, g) =>
    group.kinds.map((k, i) => ({
      path: `Object/Effects/${
        CATEGORY_SEGMENTS[group.category] ?? group.category
      }/${kindOf(k.kind)?.title ?? k.kind}`,
      command: `${EFFECT_COMMAND_PREFIX}${k.kind}`,
      order: 100 + g * 50 + i,
      group: "effect-kinds",
    })),
  );
}
