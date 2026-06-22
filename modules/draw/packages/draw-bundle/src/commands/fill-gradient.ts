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

// Phase 2d — gradient-fill ASSIGNMENT as command-driven presets (the
// dash.ts precedent, applied to B-03).
//
// A gradient assignment is a MULTI-MUTATION, array-valued flow: create
// the two stop swatches, create the gradient over them (`GradientSpec
// { stops: [...] }` — a vector, above the scalar §11.5 binding
// ceiling), then point each selected element's `frameFillColor` at the
// gradient's self-id (the B-03 ref assignment, pinned by
// `test/conformance/gradient-fill.spec.ts`). The fill panel's schema
// can't express that, so each preset is a COMMAND; the panel's
// gradient section (angle/length, scalar) then steers the result.
//
// FINDING honored (gradient-fill.spec): `mutationApplied.createdId` is
// NULL for collection creates (it carries page-item ids only), so the
// stop swatches AND the gradient are named via `selfId` (a fresh
// `u<hex>` nonce per invocation — repeat invocations must not collide)
// and referenced by those names.
//
// Host-agnostic: imports only plugin-api types; every engine touch is
// `host.document.mutate` (the single write door).

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";

/** The command category the gradient-fill presets group under. */
export const FILL_COMMAND_CATEGORY = "Fill";

/** A named gradient-fill preset: the gradient kind the command creates
 *  (black → white, 0..100%) and assigns to the selection's fill. */
export interface FillGradientPreset {
  /** The namespaced command id (under the manifest id). */
  id: string;
  /** The menu/command title. */
  title: string;
  /** `GradientSpec.kind` — `"Linear"` | `"Radial"`. */
  kind: "Linear" | "Radial";
}

/** The two v1 gradient-fill presets. */
export const FILL_GRADIENT_PRESETS: readonly FillGradientPreset[] = [
  {
    id: "media.paged.draw.command.fillGradientLinear",
    title: "Fill: Linear gradient",
    kind: "Linear",
  },
  {
    id: "media.paged.draw.command.fillGradientRadial",
    title: "Fill: Radial gradient",
    kind: "Radial",
  },
] as const;

/** The contributed command ids, in registration order. */
export const FILL_GRADIENT_COMMAND_IDS = FILL_GRADIENT_PRESETS.map(
  (p) => p.id,
);

/** Monotonic per-session counter folded into each invocation's selfId
 *  nonce, so two invocations in the same millisecond still mint
 *  distinct ids. */
let invocation = 0;

/** Mint the self-ids one invocation uses (`u<hex>` page-item-style
 *  ids in the Color/ and Gradient/ namespaces). */
export function mintFillGradientIds(nonce?: string): {
  stopA: string;
  stopB: string;
  gradient: string;
} {
  const n =
    nonce ??
    `${Date.now().toString(16)}${(invocation++).toString(16)}${Math.floor(
      Math.random() * 0xffff,
    ).toString(16)}`;
  return {
    stopA: `Color/udrawga${n}`,
    stopB: `Color/udrawgb${n}`,
    gradient: `Gradient/udrawg${n}`,
  };
}

/** The mutation SEQUENCE one preset commits: two stop swatches (black,
 *  white), the gradient over them, then one `frameFillColor` ref
 *  assignment per selected element. Exported so the conformance spec
 *  asserts the EXACT wire shapes the live command emits (no second
 *  copy to drift from). Sequential single mutations — the engine-proven
 *  path (gradient-fill.spec); each is individually undoable. */
export function fillGradientMutationsFor(
  elementIds: ElementId[],
  preset: FillGradientPreset,
  ids: { stopA: string; stopB: string; gradient: string },
): Mutation[] {
  return [
    {
      op: "createSwatch",
      args: {
        spec: {
          selfId: ids.stopA,
          name: `${preset.kind} stop A`,
          space: "RGB",
          value: [0, 0, 0],
        },
      },
    },
    {
      op: "createSwatch",
      args: {
        spec: {
          selfId: ids.stopB,
          name: `${preset.kind} stop B`,
          space: "RGB",
          value: [255, 255, 255],
        },
      },
    },
    {
      op: "createGradient",
      args: {
        spec: {
          selfId: ids.gradient,
          name: `Fill ${preset.kind}`,
          kind: preset.kind,
          stops: [
            { stopColor: ids.stopA, locationPct: 0 },
            { stopColor: ids.stopB, locationPct: 100 },
          ],
        },
      },
    },
    ...elementIds.map(
      (elementId): Mutation => ({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameFillColor",
          value: { type: "colorRef", value: ids.gradient },
        },
      }),
    ),
  ];
}

/** Apply one gradient-fill preset to the current selection. No
 *  selection ⇒ no-op (a debug log, never a throw). A rejected step is
 *  warned and STOPS the sequence (no fill pointing at a gradient that
 *  failed to exist). */
export async function applyFillGradientPreset(
  host: BundleHost,
  preset: FillGradientPreset,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${preset.id}: no selection — no-op`);
    return;
  }
  const mutations = fillGradientMutationsFor(
    selection,
    preset,
    mintFillGradientIds(),
  );
  for (const mutation of mutations) {
    const outcome = await host.document.mutate(mutation);
    if (!outcome.applied) {
      host.log.warn(
        `${preset.id} rejected by engine at ${mutation.op}: ${JSON.stringify(outcome.error)}`,
      );
      return;
    }
  }
}

/** Register both gradient-fill commands (the dash-command pattern).
 *  Returns a Disposable dropping both registrations. */
export function contributeFillGradientCommands(host: BundleHost): Disposable {
  const disposers = FILL_GRADIENT_PRESETS.map((preset) =>
    host.contribute.command({
      id: preset.id,
      title: preset.title,
      category: FILL_COMMAND_CATEGORY,
      handler: () => applyFillGradientPreset(host, preset),
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
