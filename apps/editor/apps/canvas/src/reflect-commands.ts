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

// `paged.transform.*` — Reflect and Transform Again, Object > Transform.
//
// WHY THESE LIVE IN THE EDITOR AND NOT IN A PLUGIN. Mirroring the selection
// and repeating the last transform are generic object verbs; paged.draw
// carried them alone (PM-0017). They write through the same door Transform
// Each does (`transform-targets.ts`): spread space, `frameTransform` for a
// page item (REPLACING its transform, so the reflection R is written
// `R ∘ E`) and `core.setGroupTransform` for a group (`G ∘ E⁻¹ ∘ R ∘ E`, which
// is `F⁻¹ ∘ R ∘ F ∘ G` seen from the group's parent frame F), every write of
// one run in ONE `host.objects` batch: one undo step.
//
//  1. REFLECT mirrors across an axis through the centre of the SELECTION's
//     box (`angleDeg`: 90 flips left to right, 0 top to bottom) or through a
//     typed PAGE-space point (`pivot`).
//  2. COPY puts `core.duplicateElements` (offset 0) first in the batch and
//     reflects the SOURCES: the reflected object keeps its id and its slot,
//     the untouched clone sits directly above it. An engine without the op
//     refuses the whole batch; nothing is written.
//  3. TRANSFORM AGAIN repeats the last transform of the session
//     (the editor scope's `TRANSFORM_MEMORY`: a reflect, or the linear part
//     of a Rotate / Scale / Shear tool drag), re-centred on the CURRENT
//     selection. Session state, never the document's.

import {
  commandNeeds,
  scopeOf,
  TRANSFORM_MEMORY,
  type CommandContribution,
  type MenuItemContribution,
  type ShellObjectOp,
  type ShellObjectWriteResult,
} from "@paged-media/shell";
import {
  selectionCentre,
  transformMatrixOf,
  type TransformMemory,
  type TransformRecord,
} from "@paged-media/helpers";
import { defineMessages, t } from "@paged-media/strings";

import { objectVerbApplies } from "./object-commands";
import { readSpreadTargets, type SpreadReadClient } from "./spread-targets";
import { transformOpFor, type SpreadTarget } from "./transform-targets";
import type { ElementId } from "@paged-media/client";

const M = defineMessages("app.reflectCommands", {
  reflectH: "Transform: Reflect horizontally",
  reflectV: "Transform: Reflect vertically",
  options: "Transform: Reflect…",
  again: "Transform: Transform again",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  Transform: "Transform",
  "Reflect horizontally": "Reflect horizontally",
  "Reflect vertically": "Reflect vertically",
  "Reflect…": "Reflect…",
  "Transform again": "Transform again",
});
defineMessages("commandCategory", { Transform: "Transform" });

export const PAGED_TRANSFORM_REFLECT_HORIZONTAL =
  "paged.transform.reflectHorizontal";
export const PAGED_TRANSFORM_REFLECT_VERTICAL =
  "paged.transform.reflectVertical";
/** Opens the Reflect dialog (angle, point, copy). */
export const PAGED_TRANSFORM_REFLECT_OPTIONS = "paged.transform.reflectOptions";
export const PAGED_TRANSFORM_AGAIN = "paged.transform.again";

/** Axis angles (degrees from +x, y down) of the two quick reflects. */
export const REFLECT_HORIZONTAL_DEG = 90;
export const REFLECT_VERTICAL_DEG = 0;

type Point = readonly [number, number];

/** A PAGE-space point in the spread space the batch writes: the page's
 *  origin added, read off the first target that knows it. */
export function spreadPivotOf(
  pivot: Point,
  targets: readonly SpreadTarget[],
): [number, number] {
  const origin = targets.find((t) => t.origin)?.origin ?? [0, 0];
  return [pivot[0] + origin[0], pivot[1] + origin[1]];
}

/**
 * THE PLAN — the batch of `record` over `targets`, about the selection's
 * centre or the page-space `pivot`: the duplicate of every target first when
 * `record.copy`, then each target's write. Empty when there is no geometry.
 * Pure; exported so the spec asserts the exact wire.
 */
export function planTransform(
  targets: readonly SpreadTarget[],
  record: TransformRecord,
  pivot?: Point,
): ShellObjectOp[] {
  const centre = pivot
    ? spreadPivotOf(pivot, targets)
    : selectionCentre(targets.map((t) => t.box));
  if (!centre || targets.length === 0) return [];
  const matrix = transformMatrixOf(record, centre);
  const ops: ShellObjectOp[] = [];
  if (record.copy) {
    ops.push({
      op: "invoke",
      command: "core.duplicateElements",
      args: { elementIds: targets.map((t) => t.address), offset: [0, 0] },
    });
  }
  for (const target of targets) ops.push(transformOpFor(target, matrix));
  return ops;
}

/** What a run reads and writes through. */
export interface ReflectDeps {
  /** This editor's last transform (Transform again's memory). */
  memory: TransformMemory;
  targets(addresses: readonly string[]): Promise<SpreadTarget[]>;
  batch(
    ops: readonly ShellObjectOp[],
    opts?: { label?: string },
  ): Promise<ShellObjectWriteResult>;
}

const NOTHING: ShellObjectWriteResult = { applied: false, undoSteps: 0 };

/** Read, plan, ONE batch; remembered for Transform Again only when the
 *  engine applied it. */
export async function runTransformRecord(
  deps: ReflectDeps,
  addresses: readonly string[],
  record: TransformRecord,
  pivot?: Point,
): Promise<ShellObjectWriteResult> {
  if (addresses.length === 0) return NOTHING;
  const targets = await deps.targets(addresses);
  const ops = planTransform(targets, record, pivot);
  if (ops.length === 0) return NOTHING;
  const label = record.kind === "reflect" ? "reflect" : "transform again";
  const result = await deps.batch(ops, { label });
  if (result.applied) deps.memory.remember(record);
  return result;
}

/** Repeat the last transform on `addresses`; nothing remembered is a
 *  no-op. */
export async function runTransformAgain(
  deps: ReflectDeps,
  addresses: readonly string[],
): Promise<ShellObjectWriteResult> {
  const last = deps.memory.last();
  if (!last) return NOTHING;
  // A repeated copy is a copy again: the record keeps `copy`.
  return runTransformRecord(deps, addresses, last);
}

/** A payload's `angleDeg`, `copy`, `pivot` and `targets`, sanitised. */
export interface ReflectPayload {
  angleDeg?: number;
  copy: boolean;
  pivot?: [number, number];
  targets?: readonly string[];
}

export function reflectPayloadOf(payload: unknown): ReflectPayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const pivot =
    Array.isArray(p.pivot) &&
    p.pivot.length === 2 &&
    p.pivot.every((n) => typeof n === "number" && Number.isFinite(n))
      ? ([p.pivot[0], p.pivot[1]] as [number, number])
      : undefined;
  const targets =
    Array.isArray(p.targets) && p.targets.every((a) => typeof a === "string")
      ? (p.targets as string[])
      : undefined;
  return {
    ...(typeof p.angleDeg === "number" && Number.isFinite(p.angleDeg)
      ? { angleDeg: p.angleDeg }
      : {}),
    copy: p.copy === true,
    ...(pivot ? { pivot } : {}),
    ...(targets ? { targets } : {}),
  };
}

/** What the commands need of the app. */
export interface ReflectCommandDeps {
  objects: {
    batch(
      ops: readonly ShellObjectOp[],
      opts?: { label?: string },
    ): Promise<ShellObjectWriteResult>;
  };
  /** The selection's ADR 131 addresses. */
  selectionOf(paged: unknown): readonly string[];
  elementIdOf?: (address: string) => ElementId | null;
  /** Opens the Reflect dialog over `addresses`. */
  openOptions(paged: unknown, addresses: readonly string[]): void;
}

const clientOf = (paged: unknown): SpreadReadClient => {
  const client = (paged as { client?: SpreadReadClient } | null)?.client;
  if (!client) throw new Error("failed: no canvas client to read from");
  return client;
};

export function buildReflectCommands(
  deps: ReflectCommandDeps,
): CommandContribution[] {
  const depsFor = (paged: unknown): ReflectDeps => ({
    memory: scopeOf(paged).get(TRANSFORM_MEMORY),
    targets: (addresses) =>
      readSpreadTargets(clientOf(paged), addresses, deps.elementIdOf),
    batch: (ops, opts) => deps.objects.batch(ops, opts),
  });
  const reflect =
    (defaultDeg: number) => (paged: unknown, payload?: unknown) => {
      const p = reflectPayloadOf(payload);
      return runTransformRecord(
        depsFor(paged),
        p.targets ?? deps.selectionOf(paged),
        { kind: "reflect", angleDeg: p.angleDeg ?? defaultDeg, copy: p.copy },
        p.pivot,
      );
    };
  return [
    {
      id: PAGED_TRANSFORM_REFLECT_HORIZONTAL,
      get title() {
        return t(M.reflectH);
      },
      category: "Transform",
      when: objectVerbApplies,
      applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
      handler: reflect(REFLECT_HORIZONTAL_DEG),
    },
    {
      id: PAGED_TRANSFORM_REFLECT_VERTICAL,
      get title() {
        return t(M.reflectV);
      },
      category: "Transform",
      when: objectVerbApplies,
      applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
      handler: reflect(REFLECT_VERTICAL_DEG),
    },
    {
      id: PAGED_TRANSFORM_REFLECT_OPTIONS,
      get title() {
        return t(M.options);
      },
      category: "Transform",
      when: objectVerbApplies,
      applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
      handler: (paged: unknown) => {
        const addresses = deps.selectionOf(paged);
        if (addresses.length > 0) deps.openOptions(paged, addresses);
      },
    },
    {
      id: PAGED_TRANSFORM_AGAIN,
      get title() {
        return t(M.again);
      },
      category: "Transform",
      when: objectVerbApplies,
      applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
      handler: (paged: unknown) =>
        runTransformAgain(depsFor(paged), deps.selectionOf(paged)),
    },
  ];
}

/** Object > Transform > Reflect horizontally, Reflect vertically, Reflect…
 *  and Transform again (beside Transform each…, order 10). */
export const REFLECT_MENU_ITEMS: MenuItemContribution[] = [
  [PAGED_TRANSFORM_REFLECT_HORIZONTAL, "Reflect horizontally", 11],
  [PAGED_TRANSFORM_REFLECT_VERTICAL, "Reflect vertically", 12],
  [PAGED_TRANSFORM_REFLECT_OPTIONS, "Reflect…", 13],
  [PAGED_TRANSFORM_AGAIN, "Transform again", 14],
].map(([command, label, order]) => ({
  path: `Object/Transform/${label as string}`,
  command: command as string,
  order: order as number,
  group: "transform",
  when: objectVerbApplies,
  applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
}));
