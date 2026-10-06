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

// REFLECT and TRANSFORM AGAIN — Illustrator's Object ▸ Transform pair.
//
// REFLECT mirrors the selection across an axis through the centre of the
// SELECTION's page box: horizontally (left ↔ right — the axis is
// vertical, 90°), vertically (top ↔ bottom — the axis is horizontal,
// 0°), or across a TYPED angle (the Path Options panel's Reflect
// section, or a `{ angleDeg }` payload).
//
// THE WRITE DOOR, and the one subtle thing about it. `frameTransform`
// REPLACES an element's item transform — it does not compose (measured,
// CLAUDE.md, writing the same rotation twice leaves 30°, not 60°). So a
// reflection R is written as `R ∘ M`, M being the element's CURRENT
// transform as `elementGeometry` reports it; writing R alone would throw
// away whatever rotation or scale the element already had. A GROUP is
// not reachable through `elementGeometry` at all (measured: the door
// omits it) and moves through its own op: `setGroupTransform` — which
// also REPLACES (the group's own transform; the engine rebases every
// member by the delta) — so a group is written `R ∘ G`, G read from the
// group's `frameTransform` property. Every write of one reflect rides
// ONE batch: one undo step for the whole selection.
//
// TRANSFORM AGAIN repeats the last transform applied THROUGH THIS MODULE
// (`applySelectionTransform` is the one place), re-centred on the
// CURRENT selection — Illustrator's behaviour: "reflect again" mirrors
// the new selection about its own centre, not about where the last one
// was. The memory is session state, like Illustrator's, not document
// state. The bundle's OTHER transform-producing commands do not route
// here and are deliberately not repeated: Objects on a Path writes a
// different transform per object (there is no one transform to repeat),
// and a Repeat or a Symbol reset rebuilds artwork rather than
// transforming the selection.
//
// COPY needs the engine's `duplicateElements` (protocol 65, C-64), which
// the engine this bundle is tested against (0.64) does not have. The
// op vocabulary is PROBED (`engineOpVocabulary`, one refused mutation,
// nothing on the undo stack), and a copy on an engine without the op is
// REFUSED by name — nothing is written. Where the op exists, the copy is
// ONE batch: `duplicateElements` (offset 0 — the clone lands directly
// above its source), then the reflection written to the SOURCES. The
// result is the two objects Illustrator's Reflect ▸ Copy leaves, with
// one named difference: the reflected one is the SOURCE (it keeps its id
// and its slot) and the untouched clone sits directly above it, because
// a clone's id cannot be addressed inside the batch that mints it
// without a handle this bundle has not measured on that op.

import type {
  BundleHost,
  Disposable,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";
import {
  affineReflect,
  composeAffine,
  transformBounds,
  type Affine,
  type Vec2,
} from "@paged-media/draw-geometry";

import { engineOpVocabulary } from "./join-average";
import { frameTransformMutationFor } from "./objects-on-path";
import { batchMutationFor } from "./v59-wire";

import { registerCommand } from "../command-registry";
export const TRANSFORM_COMMAND_CATEGORY = "Transform";

const C = "media.paged.draw.command";
export const REFLECT_HORIZONTAL_COMMAND_ID = `${C}.reflectHorizontal`;
export const REFLECT_VERTICAL_COMMAND_ID = `${C}.reflectVertical`;
export const TRANSFORM_AGAIN_COMMAND_ID = `${C}.transformAgain`;

/** The contributed command ids, in registration order. */
export const TRANSFORM_COMMAND_IDS = [
  REFLECT_HORIZONTAL_COMMAND_ID,
  REFLECT_VERTICAL_COMMAND_ID,
  TRANSFORM_AGAIN_COMMAND_ID,
];

/** The engine op a copy needs, and the engine it arrived in. */
export const DUPLICATE_OP = "duplicateElements";
export const DUPLICATE_ENGINE = "0.65";

/** What the bundle says when a copy is asked of an engine without the
 *  op — verbatim, pinned by a test. */
export const COPY_UNAVAILABLE_NOTE =
  `Copy needs the engine's ${DUPLICATE_OP} op (engine ${DUPLICATE_ENGINE}); ` +
  "this engine does not have it, so nothing was changed.";

/** One transform this module can apply and repeat. Parametric, not a
 *  matrix: "again" re-centres it on the selection it is applied to. */
export interface TransformRecord {
  kind: "reflect";
  /** The mirror axis' angle, degrees from +x (y down). */
  angleDeg: number;
  /** Leave the original and transform a copy. */
  copy: boolean;
}

/** One element of the selection, resolved for a write. */
export interface TransformTarget {
  id: ElementId;
  /** The element's current item transform (null = identity). */
  matrix: Affine | null;
  /** Its page-space box `[top, left, bottom, right]`. */
  box: readonly [number, number, number, number];
  /** Groups move through `setGroupTransform`. */
  group: boolean;
}

export interface TransformResult {
  applied: boolean;
  /** The elements written. */
  targets: ElementId[];
  /** Why nothing was written, when it was not. */
  refusal?: string;
}

// ------------------------------------------------------- the memory

let lastTransform: TransformRecord | null = null;

/** The last transform applied through this module (session state). */
export function lastSelectionTransform(): TransformRecord | null {
  return lastTransform ? { ...lastTransform } : null;
}

/** Forget it — a spec starting from a clean session. */
export function forgetLastTransform(): void {
  lastTransform = null;
}

// ------------------------------------------------------- the pure half

/** The centre of the union of `boxes`. */
export function selectionCentre(
  boxes: readonly (readonly [number, number, number, number])[],
): Vec2 | null {
  if (boxes.length === 0) return null;
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  for (const [top, left, bottom, right] of boxes) {
    t = Math.min(t, top);
    l = Math.min(l, left);
    b = Math.max(b, bottom);
    r = Math.max(r, right);
  }
  return [(l + r) / 2, (t + b) / 2];
}

/** The page-space matrix of `record` about `centre`. */
export function transformMatrixOf(record: TransformRecord, centre: Vec2): Affine {
  return affineReflect(record.angleDeg, centre);
}

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/**
 * THE BATCH — every target written `R ∘ current` (a page item through
 * `frameTransform`, a group through `setGroupTransform`), preceded by the
 * `duplicateElements` of every target when `copy`. One batch, one undo
 * step. Pure; exported so the spec asserts the exact wire.
 */
export function transformBatchFor(
  targets: readonly TransformTarget[],
  matrix: Affine,
  copy: boolean,
): MutationInput {
  const ops: MutationInput[] = [];
  if (copy) {
    ops.push({
      op: DUPLICATE_OP,
      args: { elementIds: targets.map((t) => t.id), offset: [0, 0] },
    } as unknown as MutationInput);
  }
  for (const t of targets) {
    const next = composeAffine(matrix, t.matrix ?? IDENTITY);
    if (t.group) {
      ops.push({
        op: "setGroupTransform",
        args: { groupId: String(t.id.id), transform: [...next] as [number, number, number, number, number, number] },
      });
    } else {
      ops.push(frameTransformMutationFor(t.id, next));
    }
  }
  return batchMutationFor(ops);
}

// ------------------------------------------------------- the reads

/** Resolve the selection: page items through ONE `elementGeometry`
 *  call, groups through their own properties (the geometry door omits
 *  them). An element neither answers is dropped (logged). */
export async function transformTargetsOf(
  host: BundleHost,
  selection: readonly ElementId[],
): Promise<TransformTarget[]> {
  const items = selection.filter((id) => id.kind !== "group");
  const groups = selection.filter((id) => id.kind === "group");
  const out: TransformTarget[] = [];
  const geoms = items.length > 0 ? await host.document.elementGeometry([...items]).catch(() => []) : [];
  for (const g of geoms) {
    const m = (g.itemTransform ?? null) as Affine | null;
    out.push({ id: g.id, matrix: m, box: m ? transformBounds(g.bounds, m) : g.bounds, group: false });
  }
  for (const id of groups) {
    const props = await host.document.elementProperties(id).catch(() => null);
    let matrix: Affine | null = null;
    let box: [number, number, number, number] | null = null;
    for (const e of props?.entries ?? []) {
      const v = e.value;
      if (!v) continue;
      if (e.path === "frameTransform" && v.type === "transform") matrix = (v.value ?? null) as Affine | null;
      if (e.path === "frameBounds" && v.type === "bounds") box = v.value;
    }
    if (box) out.push({ id, matrix, box, group: true });
  }
  const answered = new Set(out.map((t) => `${t.id.kind}:${String(t.id.id)}`));
  for (const id of selection) {
    if (!answered.has(`${id.kind}:${String(id.id)}`)) {
      host.log.debug(`transform: ${id.kind} ${String(id.id)} has no readable geometry — skipped`);
    }
  }
  return out;
}

/** Does this engine carry `duplicateElements`? An unreadable vocabulary
 *  answers FALSE: a copy that silently became a move would be the worst
 *  outcome, so the copy is only offered on proof. */
export async function supportsDuplicate(host: BundleHost): Promise<boolean> {
  const vocab = await engineOpVocabulary(host);
  return vocab?.has(DUPLICATE_OP) ?? false;
}

// ------------------------------------------------------- the one place

/**
 * Apply `record` to the current selection, about the selection's centre
 * — THE place every transform of this module goes through, and so the
 * one Transform Again repeats. Remembered only when it was applied.
 */
export async function applySelectionTransform(
  host: BundleHost,
  record: TransformRecord,
): Promise<TransformResult> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug("transform: nothing selected — no-op");
    return { applied: false, targets: [], refusal: "nothing selected" };
  }
  if (record.copy && !(await supportsDuplicate(host))) {
    host.log.warn(`transform: ${COPY_UNAVAILABLE_NOTE}`);
    return { applied: false, targets: [], refusal: COPY_UNAVAILABLE_NOTE };
  }
  const targets = await transformTargetsOf(host, selection);
  const centre = selectionCentre(targets.map((t) => t.box));
  if (!centre) return { applied: false, targets: [], refusal: "no readable geometry" };
  const outcome = await host.document.mutate(
    transformBatchFor(targets, transformMatrixOf(record, centre), record.copy),
  );
  if (!outcome.applied) {
    const refusal = JSON.stringify(outcome.error);
    host.log.warn(`transform rejected by engine: ${refusal}`);
    return { applied: false, targets: [], refusal };
  }
  lastTransform = { ...record };
  return { applied: true, targets: targets.map((t) => t.id) };
}

/** Reflect the selection across an axis at `angleDeg` through its
 *  centre. */
export function applyReflect(
  host: BundleHost,
  angleDeg: number,
  copy = false,
): Promise<TransformResult> {
  return applySelectionTransform(host, { kind: "reflect", angleDeg, copy });
}

/** Repeat the last transform on the current selection. Nothing
 *  remembered ⇒ a logged no-op. */
export async function applyTransformAgain(host: BundleHost): Promise<TransformResult> {
  const last = lastSelectionTransform();
  if (!last) {
    host.log.info("transform again: no transform has been applied yet — nothing to repeat");
    return { applied: false, targets: [], refusal: "nothing to repeat" };
  }
  return applySelectionTransform(host, last);
}

/** A payload's angle / copy, sanitised. */
function payloadOf(payload: unknown): { angleDeg?: number; copy: boolean } {
  const p = (payload ?? {}) as { angleDeg?: unknown; copy?: unknown };
  return {
    ...(typeof p.angleDeg === "number" && Number.isFinite(p.angleDeg) ? { angleDeg: p.angleDeg } : {}),
    copy: p.copy === true,
  };
}

/** Register Reflect horizontally / vertically and Transform again. A
 *  reflect command takes an optional `{ angleDeg, copy }` payload — the
 *  angle overrides the command's own axis. */
export function contributeTransformCommands(host: BundleHost): Disposable {
  const disposers = [
    registerCommand(host, {
      id: REFLECT_HORIZONTAL_COMMAND_ID,
      title: "Transform: Reflect horizontally",
      category: TRANSFORM_COMMAND_CATEGORY,
      handler: (_paged, payload) => {
        const p = payloadOf(payload);
        return applyReflect(host, p.angleDeg ?? 90, p.copy);
      },
    }),
    registerCommand(host, {
      id: REFLECT_VERTICAL_COMMAND_ID,
      title: "Transform: Reflect vertically",
      category: TRANSFORM_COMMAND_CATEGORY,
      handler: (_paged, payload) => {
        const p = payloadOf(payload);
        return applyReflect(host, p.angleDeg ?? 0, p.copy);
      },
    }),
    registerCommand(host, {
      id: TRANSFORM_AGAIN_COMMAND_ID,
      title: "Transform: Transform again",
      category: TRANSFORM_COMMAND_CATEGORY,
      handler: () => applyTransformAgain(host),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
