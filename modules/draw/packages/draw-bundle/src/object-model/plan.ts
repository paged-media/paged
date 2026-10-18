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

// ONE WRITE PER BATCH (plugin-sdk DESIGN.md §21.8). Every draw kind PLANS
// its ops into a `DrawPlan`; the plugin-level `objectModel.batch` plans
// all kinds of a batch and folds the plans into ONE `ObjectWrite`:
//
//   · engine mutations (framePath, bakes, unlinks, style propagation) —
//     concatenated;
//   · library writes (the seven recipe libraries) — ONE `state` write
//     hosted on `doc`, sub-key `x-paged:media.paged.draw.recipes`, built
//     by the recipe store over every library the batch touches (two
//     libraries in one batch used to be refused: they share the label);
//   · appearance stacks — the element's own label. When the write has no
//     other `state` slot and exactly ONE element's stack changes, it is a
//     `state` write on that element under the sub-key
//     `x-paged:media.paged.draw.appearance`, which the registry merges
//     into the element's envelope (its `graphicStyle` link, its bake
//     record stay). A write has one `state` host, so several elements (or
//     a stack next to a library write) fall back to full-envelope
//     `setPluginMetadata` mutations — the registry checks their key and
//     envelope and fills the caller.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  ObjectOp,
  ObjectWrite,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

import { withAppearance, type AppearanceStack } from "../commands/appearance";
import { stampDrawMetadata } from "../commands/appearance-bake";
import { planRecipeWrites, RECIPE_LABEL_KEY, type RecipeWrite } from "../recipe-store";
import { coreAddressOf } from "./shared";

/** One element's appearance stack, to be written to its label. */
export interface StackStamp {
  el: ElementId;
  prev: PluginMetadataEnvelope | null;
  stack: AppearanceStack;
}

/** What one kind's ops plan to: nothing is written yet. */
export interface DrawPlan {
  mutations: MutationInput[];
  libraries: RecipeWrite[];
  stamps: StackStamp[];
}

export type Planned = DrawPlan | { rejected: string };

export const APPEARANCE_SUBKEY = `${RECIPE_LABEL_KEY}.appearance`;

export const plan = (p: Partial<DrawPlan> = {}): DrawPlan => ({
  mutations: p.mutations ?? [],
  libraries: p.libraries ?? [],
  stamps: p.stamps ?? [],
});

export const rejected = (reason: string): Planned => ({ rejected: reason });

export const isRejected = (p: Planned): p is { rejected: string } => "rejected" in p;

/** A kind that plans (the plugin-level batch's input). */
export interface Planner {
  kind: string;
  plan(ops: readonly ObjectOp[]): Promise<Planned>;
}

/** Fold plans into the ONE write the registry commits. */
export async function finishPlans(host: BundleHost, plans: readonly DrawPlan[]): Promise<ObjectWrite> {
  const mutations: MutationInput[] = plans.flatMap((p) => p.mutations);
  const libraries = plans.flatMap((p) => p.libraries);
  const stamps = plans.flatMap((p) => p.stamps);

  let state: Extract<ObjectWrite, { kind: "state" }> | null = null;
  if (libraries.length > 0) {
    const r = await planRecipeWrites(host, libraries);
    if (typeof r === "string") return { kind: "rejected", reason: r };
    state = { kind: "state", parts: r.parts, host: r.host, labelKey: r.labelKey, labelValue: r.labelValue };
  }
  if (stamps.length > 0) {
    const els = new Set(stamps.map((s) => `${s.el.kind}:${String(s.el.id)}`));
    if (state === null && els.size === 1) {
      const last = stamps[stamps.length - 1]!;
      const empty = last.stack.fills.length === 0 && last.stack.strokes.length === 0;
      state = {
        kind: "state",
        parts: [],
        host: coreAddressOf(last.el),
        labelKey: APPEARANCE_SUBKEY,
        labelValue: JSON.stringify(empty ? null : last.stack),
      };
    } else {
      for (const s of stamps) mutations.push(stampDrawMetadata(s.el, withAppearance(s.prev, s.stack)));
    }
  }
  if (state === null) return { kind: "mutations", mutations };
  return mutations.length === 0 ? state : { ...state, kind: "both", mutations };
}

/** A kind's `batch` (the per-kind door a pre-0.2.43 registry calls): its
 *  own plan, folded the same way. */
export const kindBatch =
  (host: BundleHost, planner: Planner["plan"]) =>
  async (ops: readonly ObjectOp[]): Promise<ObjectWrite> => {
    const p = await planner(ops);
    return isRejected(p) ? { kind: "rejected", reason: p.rejected } : finishPlans(host, [p]);
  };

/** A kind whose ops are engine mutations only (path, symbolInstance):
 *  its `ObjectWrite` as a plan. */
export function fromWrite(w: ObjectWrite): Planned {
  if (w.kind === "rejected") return rejected(w.reason);
  if (w.kind === "mutations") return plan({ mutations: [...w.mutations] });
  return rejected(`internal: a draw kind answered a ${w.kind} write directly`);
}
