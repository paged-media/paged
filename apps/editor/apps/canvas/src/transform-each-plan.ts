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

// WP4.4 — Object ▸ Transform ▸ Transform Each (Illustrator's dialog), as
// the typed command `paged.object.transformEach`.
//
// Every object transforms about ITS OWN reference point — one of the nine
// points of its transformed box, in spread space — by
//
//     M = translate(move) ∘ translate(p) ∘ rotate(angle) ∘ scale ∘ translate(−p)
//
// (scale first, then rotate, then move: Illustrator's order). Reflect X
// mirrors across the horizontal axis (top ↔ bottom), Reflect Y across the
// vertical one (left ↔ right). A positive angle turns counter-clockwise on
// screen, as InDesign's and Illustrator's do (y points down, so that is
// `[cos, −sin, sin, cos]`). With `random`, each object draws its own
// amounts between the neutral value and the one given (scale between
// 100 % and it, move and angle between 0 and it), from a SEEDED generator,
// so the same seed transforms the same selection the same way. All the
// writes ride ONE batch: one undo step for the whole selection.
//
// Pure: the unit tests pin every matrix.

import type { ShellObjectOp, ShellValueType } from "@paged-media/shell";

import {
  compose,
  isIdentity,
  transformOpFor,
  translate,
  type Affine,
  type Bounds,
  type SpreadTarget,
} from "./transform-targets";

export const TRANSFORM_EACH_COMMAND = "paged.object.transformEach";

/** The nine reference points, row by row. */
export const REFERENCE_POINTS = [
  "topLeft",
  "top",
  "topRight",
  "left",
  "center",
  "right",
  "bottomLeft",
  "bottom",
  "bottomRight",
] as const;
export type ReferencePoint = (typeof REFERENCE_POINTS)[number];

export interface TransformEachParams {
  /** Horizontal / vertical scale, percent (100 = unchanged). */
  scaleH: number;
  scaleV: number;
  /** Horizontal / vertical move, pt. */
  moveH: number;
  moveV: number;
  /** Rotation, degrees, counter-clockwise. */
  angle: number;
  reflectX: boolean;
  reflectY: boolean;
  reference: ReferencePoint;
  random: boolean;
  /** The random generator's seed. */
  seed: number;
}

export const TRANSFORM_EACH_DEFAULTS: TransformEachParams = {
  scaleH: 100,
  scaleV: 100,
  moveH: 0,
  moveV: 0,
  angle: 0,
  reflectX: false,
  reflectY: false,
  reference: "center",
  random: false,
  seed: 1,
};

export const TRANSFORM_EACH_ARGS: ShellValueType = {
  kind: "struct",
  fields: {
    targets: { kind: "list", of: { kind: "text" } },
    scaleH: { kind: "number", unit: "percent", optional: true },
    scaleV: { kind: "number", unit: "percent", optional: true },
    moveH: { kind: "number", unit: "pt", optional: true },
    moveV: { kind: "number", unit: "pt", optional: true },
    angle: { kind: "number", unit: "deg", optional: true },
    reflectX: { kind: "bool", optional: true },
    reflectY: { kind: "bool", optional: true },
    reference: { kind: "enum", members: REFERENCE_POINTS, optional: true },
    random: { kind: "bool", optional: true },
    seed: { kind: "number", integer: true, optional: true },
  },
};

export type TransformEachArgs = {
  targets: readonly string[];
} & Partial<TransformEachParams>;

/** mulberry32: a small, seeded, deterministic generator in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The point `reference` names on `box`, spread space. */
export function referencePointOf(
  box: Bounds,
  reference: ReferencePoint,
): [number, number] {
  const [t, l, b, r] = box;
  const i = REFERENCE_POINTS.indexOf(reference);
  const col = i % 3;
  const row = Math.floor(i / 3);
  return [l + ((r - l) * col) / 2, t + ((b - t) * row) / 2];
}

/** One object's matrix about `p`. */
export function transformEachMatrix(
  p: readonly [number, number],
  amounts: {
    scaleH: number;
    scaleV: number;
    moveH: number;
    moveV: number;
    angle: number;
    reflectX: boolean;
    reflectY: boolean;
  },
): Affine {
  const sx = (amounts.scaleH / 100) * (amounts.reflectY ? -1 : 1);
  const sy = (amounts.scaleV / 100) * (amounts.reflectX ? -1 : 1);
  const rad = (amounts.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotate: Affine = [cos, -sin, sin, cos, 0, 0];
  const scale: Affine = [sx, 0, 0, sy, 0, 0];
  const about = compose(
    translate(p[0], p[1]),
    compose(rotate, compose(scale, translate(-p[0], -p[1]))),
  );
  return compose(translate(amounts.moveH, amounts.moveV), about);
}

/** The per-object amounts: the params, or with `random` a draw between
 *  each neutral value and the one given. */
function amountsFor(params: TransformEachParams, next: () => number) {
  if (!params.random) return params;
  const between = (neutral: number, value: number) =>
    neutral + (value - neutral) * next();
  return {
    ...params,
    scaleH: between(100, params.scaleH),
    scaleV: between(100, params.scaleV),
    moveH: between(0, params.moveH),
    moveV: between(0, params.moveV),
    angle: between(0, params.angle),
  };
}

/** The whole command's params from its (partial) args. */
export function transformEachParams(
  args: Partial<TransformEachParams>,
): TransformEachParams {
  const out = { ...TRANSFORM_EACH_DEFAULTS };
  for (const k of Object.keys(out) as Array<keyof TransformEachParams>) {
    const v = args[k];
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** The writes of a Transform Each over `targets` (in their order); an
 *  object the transform leaves where it is gets none. */
export function planTransformEach(
  params: TransformEachParams,
  targets: readonly SpreadTarget[],
): ShellObjectOp[] {
  const next = seededRandom(params.seed);
  const ops: ShellObjectOp[] = [];
  for (const t of targets) {
    const amounts = amountsFor(params, next);
    const m = transformEachMatrix(
      referencePointOf(t.box, params.reference),
      amounts,
    );
    if (isIdentity(m)) continue;
    ops.push(transformOpFor(t, m));
  }
  return ops;
}

/** What `runTransformEach` reads and writes through (align-plan's). */
export interface TransformEachDeps {
  targets(addresses: readonly string[]): Promise<SpreadTarget[]>;
  batch(
    ops: readonly ShellObjectOp[],
    opts?: { label?: string },
  ): Promise<{
    applied: boolean;
    undoSteps: 0 | 1;
    code?: string;
    reason?: string;
  }>;
}

/** Read → plan → ONE batch (`undoSteps: 0` when nothing changes). */
export async function runTransformEach(
  deps: TransformEachDeps,
  args: TransformEachArgs,
) {
  const targets = await deps.targets(args.targets);
  const ops = planTransformEach(transformEachParams(args), targets);
  if (ops.length === 0) return { applied: true, undoSteps: 0 as const };
  return deps.batch(ops, { label: "transform each" });
}
