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

// paged.draw's OBJECT MODEL (ADR 323; plugin-sdk DESIGN.md §21): ten
// kinds and the typed command twins, contributed through
// `host.contribute.objectModel` and reached by every surface through
// `host.objects`.
//
//   kind             backing        write                         undo
//   path             core           framePath                     1 step
//   appearance       core           stamp + bake / style apply    1 step
//   symbolInstance   core           per-leaf unlink               1 step
//   graphicStyle     plugin state   label-hash (+ propagation)    1 step
//   symbol           plugin state   label-hash (+ unlink)         1 step
//   pattern, repeat, blend,
//   livePaint, objectsOnPath
//                    plugin state   label-hash (recipe only)      1 step
//
// Everything here runs headless: no DOM, no edit context.
//
// The manifest's `contributes.objectModel` is GENERATED from the same
// rows (`drawObjectModelManifest`), and `test/object-model-manifest.spec.ts`
// fails when the two drift (`UPDATE_OBJECT_MODEL=1` rewrites it).

import type {
  BundleHost,
  ObjectModelContribution,
  ObjectModelHandle,
  ObjectOp,
  ObjectWrite,
  PropertySchema,
  ValueType,
} from "@paged-media/plugin-api";
import { parseAddress } from "@paged-media/plugin-sdk";

import { APPEARANCE_KIND, APPEARANCE_SCHEMA, makeAppearanceKind } from "./appearance-kind";
import { GRAPHIC_STYLE_KIND, GRAPHIC_STYLE_SCHEMA, makeGraphicStyleKind } from "./graphic-style-kind";
import { PATH_KIND, PATH_SCHEMA, makePathKind } from "./path-kind";
import { finishPlans, isRejected, type DrawPlan, type Planner } from "./plan";
import { RECIPE_KINDS, makeRecipeKinds } from "./recipe-kinds";
import {
  SYMBOL_INSTANCE_KIND,
  SYMBOL_INSTANCE_SCHEMA,
  SYMBOL_KIND,
  SYMBOL_SCHEMA,
  makeSymbolInstanceKind,
  makeSymbolKind,
} from "./symbol-kinds";
import { TWINS, argsOf, typedCommands } from "./typed-commands";

export { TWINS, payloadFor, typedCommands, type TwinSpec } from "./typed-commands";
export { validSubpathStarts } from "./path-kind";

/** Every kind, as pure data (kind, title, schema) — the manifest view. */
export const DRAW_OBJECT_KINDS: readonly { kind: string; title: string; schema: readonly PropertySchema[] }[] = [
  { kind: PATH_KIND, title: "Path", schema: PATH_SCHEMA },
  { kind: APPEARANCE_KIND, title: "Appearance", schema: APPEARANCE_SCHEMA },
  { kind: GRAPHIC_STYLE_KIND, title: "Graphic style", schema: GRAPHIC_STYLE_SCHEMA },
  { kind: SYMBOL_KIND, title: "Symbol", schema: SYMBOL_SCHEMA },
  { kind: SYMBOL_INSTANCE_KIND, title: "Symbol instance", schema: SYMBOL_INSTANCE_SCHEMA },
  ...RECIPE_KINDS,
];

/** The `contributes.objectModel` block the manifest carries (pure). */
export function drawObjectModelManifest(): {
  kinds: { kind: string; title: string; schema: PropertySchema[] }[];
  commands: { id: string; title: string; args: ValueType; result?: ValueType }[];
} {
  return {
    kinds: DRAW_OBJECT_KINDS.map((k) => ({
      kind: k.kind,
      title: k.title,
      schema: JSON.parse(JSON.stringify(k.schema)) as PropertySchema[],
    })),
    commands: TWINS.map((t) => ({
      id: t.id,
      title: t.title,
      args: argsOf(t),
      ...(t.result ? { result: t.result } : {}),
    })),
  };
}

/** The kind an op targets (`create` names it, set/delete address it). */
function kindOfOp(op: ObjectOp): string | null {
  if (op.op === "create") {
    const k = op.kind;
    const slash = k.lastIndexOf("/");
    return k.startsWith("plugin:") && slash > 0 ? k.slice(slash + 1) : k;
  }
  if (op.op === "invoke") return null;
  const p = parseAddress(op.address);
  return p?.kind === "plugin" ? p.objectKind : null;
}

/**
 * The PLUGIN-level planner (plugin-sdk DESIGN.md §21.8): every op of a
 * batch that targets ANY draw kind, in ONE call. Ops are grouped per kind
 * (batch order kept within a kind), each kind plans from the pre-batch
 * state, and `finishPlans` folds the plans into ONE write — so two
 * libraries in one batch become ONE document-label write (they share the
 * label; per kind, the second plan would drop the first's entry).
 */
export async function planDrawBatch(
  planners: ReadonlyMap<string, Planner>,
  host: BundleHost,
  ops: readonly ObjectOp[],
): Promise<ObjectWrite> {
  const groups = new Map<Planner, ObjectOp[]>();
  for (const op of ops) {
    const name = kindOfOp(op);
    const planner = name ? planners.get(name) : undefined;
    if (!planner) return { kind: "rejected", reason: `paged.draw has no kind for ${JSON.stringify(op)}` };
    const group = groups.get(planner) ?? [];
    group.push(op);
    groups.set(planner, group);
  }
  const plans: DrawPlan[] = [];
  for (const [planner, kindOps] of groups) {
    const p = await planner.plan(kindOps);
    if (isRejected(p)) return { kind: "rejected", reason: p.rejected };
    plans.push(p);
  }
  return finishPlans(host, plans);
}

/** The live contribution, bound to `host`. */
export function drawObjectModel(host: BundleHost): ObjectModelContribution {
  const kinds = [
    makePathKind(host),
    makeAppearanceKind(host),
    makeGraphicStyleKind(host),
    makeSymbolKind(host),
    makeSymbolInstanceKind(host),
    ...makeRecipeKinds(host),
  ];
  const planners = new Map<string, Planner>(kinds.map((k) => [k.kind, k]));
  return {
    kinds,
    commands: typedCommands(host),
    batch: (ops) => planDrawBatch(planners, host, ops),
  };
}

/** Contribute it. `null` on a host that predates the door (an editor
 *  without plugin-api 0.2.42's `contribute.objectModel`). */
export function contributeDrawObjectModel(host: BundleHost): ObjectModelHandle | null {
  const door = (host.contribute as { objectModel?: BundleHost["contribute"]["objectModel"] }).objectModel;
  if (typeof door !== "function" || !host.supports("contribute.objectModel@1")) {
    host.log.info("object model: this host has no contribute.objectModel door (plugin-api < 0.2.42) — skipped");
    return null;
  }
  return door.call(host.contribute, drawObjectModel(host));
}
