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

// Editor ADR 1240, amendment 1 — `paged.object.transformSelection`: what a
// recorded canvas gesture replays through. A step says what the gesture did
// to the selection (`UXI-MUT-013`), and this command does it to the
// selection a replay hands it, as ONE `host.objects` batch (one undo step):
//
//   move       translate by (dx, dy) pt                  frameTransform
//   duplicate  a copy of the targets offset by (dx, dy)  core.duplicateElements
//   resize     each frame's own box made width × height,
//              its anchor kept                            core.resizeFrame
//   scale      the targets' box scaled to width × height
//              about its anchor                           frameTransform
//   rotate     turned by `angle` (degrees clockwise on
//              the page) about the targets' centre        frameTransform
//
// A side the step leaves out keeps its size. The reads and writes are
// Align's and Transform Each's (spread-targets.ts, transform-targets.ts), so
// the numbers are spread-space points, as the recorder measured them.

import {
  TRANSFORM_ANCHORS,
  TRANSFORM_SELECTION_COMMAND,
  anchorPoint,
  type ShellObjectOp,
  type ShellValueType,
  type TransformAnchor,
} from "@paged-media/shell";
import {
  compose,
  translate,
  type Affine,
  type Bounds,
} from "@paged-media/helpers";

import {
  isIdentity,
  transformOpFor,
  type SpreadTarget,
} from "./transform-targets";

export { TRANSFORM_SELECTION_COMMAND };

export const TRANSFORM_SELECTION_KINDS = [
  "move",
  "duplicate",
  "resize",
  "scale",
  "rotate",
] as const;
export type TransformSelectionKind = (typeof TRANSFORM_SELECTION_KINDS)[number];

/** The command's declared args (ADR 323): what a replay's payload and its
 *  parameters are checked against. */
export const TRANSFORM_SELECTION_ARGS: ShellValueType = {
  kind: "struct",
  fields: {
    targets: { kind: "list", of: { kind: "text" } },
    transform: { kind: "enum", members: TRANSFORM_SELECTION_KINDS },
    dx: { kind: "number", unit: "pt", optional: true },
    dy: { kind: "number", unit: "pt", optional: true },
    width: { kind: "number", unit: "pt", optional: true },
    height: { kind: "number", unit: "pt", optional: true },
    anchor: { kind: "enum", members: TRANSFORM_ANCHORS, optional: true },
    angle: { kind: "number", unit: "deg", optional: true },
  },
};

export interface TransformSelectionArgs {
  targets: readonly string[];
  transform: TransformSelectionKind;
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
  anchor?: TransformAnchor;
  angle?: number;
}

/** The box around every target, spread space. */
function unionOf(targets: readonly SpreadTarget[]): Bounds | null {
  let out: [number, number, number, number] | null = null;
  for (const { box: b } of targets)
    out = out
      ? [
          Math.min(out[0], b[0]),
          Math.min(out[1], b[1]),
          Math.max(out[2], b[2]),
          Math.max(out[3], b[3]),
        ]
      : [b[0], b[1], b[2], b[3]];
  return out;
}

/** A scale about `p` that takes `box` to `width` × `height` (a side not
 *  given keeps its size). Null for a box with no extent on a scaled side. */
function scaleAbout(
  box: Bounds,
  p: readonly [number, number],
  width: number | undefined,
  height: number | undefined,
): Affine | null {
  const w = box[3] - box[1];
  const h = box[2] - box[0];
  if ((width !== undefined && w <= 0) || (height !== undefined && h <= 0))
    return null;
  const sx = width !== undefined ? width / w : 1;
  const sy = height !== undefined ? height / h : 1;
  return compose(
    translate(p[0], p[1]),
    compose([sx, 0, 0, sy, 0, 0], translate(-p[0], -p[1])),
  );
}

/** A turn by `deg` clockwise on the page (y down) about `p`. */
export function rotationAbout(
  deg: number,
  p: readonly [number, number],
): Affine {
  const r = (deg * Math.PI) / 180;
  const exact = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  const c = exact(Math.cos(r));
  const s = exact(Math.sin(r));
  return compose(
    translate(p[0], p[1]),
    compose([c, s, -s, c, 0, 0], translate(-p[0], -p[1])),
  );
}

/** A frame's own box made `width` × `height` with `anchor` kept. */
export function resizedBounds(
  inner: Bounds,
  anchor: TransformAnchor,
  width: number | undefined,
  height: number | undefined,
): Bounds {
  const [t, l, b, r] = inner;
  const w = width ?? r - l;
  const h = height ?? b - t;
  const [ax, ay] = anchorPoint(inner, anchor);
  const fx =
    anchor === "west" || anchor === "northWest" || anchor === "southWest"
      ? 0
      : anchor === "east" || anchor === "northEast" || anchor === "southEast"
        ? 1
        : 0.5;
  const fy =
    anchor === "north" || anchor === "northWest" || anchor === "northEast"
      ? 0
      : anchor === "south" || anchor === "southWest" || anchor === "southEast"
        ? 1
        : 0.5;
  const left = ax - fx * w;
  const top = ay - fy * h;
  const round = (v: number) => {
    const x = Math.round(v * 1e6) / 1e6;
    return Object.is(x, -0) ? 0 : x;
  };
  return [round(top), round(left), round(top + h), round(left + w)];
}

/** Why the args cannot be planned, or null. */
export function transformSelectionRefusal(
  args: TransformSelectionArgs,
): string | null {
  const need = (k: keyof TransformSelectionArgs) =>
    typeof args[k] === "number" && Number.isFinite(args[k] as number);
  switch (args.transform) {
    case "move":
    case "duplicate":
      return need("dx") || need("dy")
        ? null
        : `${args.transform} needs dx or dy`;
    case "resize":
    case "scale":
      if (!need("width") && !need("height"))
        return `${args.transform} needs a width or a height`;
      if ((args.width ?? 1) <= 0 || (args.height ?? 1) <= 0)
        return `${args.transform} needs a positive size`;
      return null;
    case "rotate":
      return need("angle") ? null : "rotate needs an angle";
  }
}

/**
 * THE PLAN — the batch of one transform over `targets` (in their order).
 * Empty when there is nothing to do (no targets, a move by nothing). Pure;
 * exported so the spec asserts the exact wire.
 */
export function planTransformSelection(
  args: TransformSelectionArgs,
  targets: readonly SpreadTarget[],
): ShellObjectOp[] {
  const box = unionOf(targets);
  if (!box) return [];
  const dx = args.dx ?? 0;
  const dy = args.dy ?? 0;
  switch (args.transform) {
    case "duplicate":
      return [
        {
          op: "invoke",
          command: "core.duplicateElements",
          args: {
            elementIds: targets.map((t) => t.address),
            offset: [dx, dy],
          },
        },
      ];
    case "move": {
      const m = translate(dx, dy);
      return isIdentity(m) ? [] : targets.map((t) => transformOpFor(t, m));
    }
    case "rotate": {
      const centre: [number, number] = [
        (box[1] + box[3]) / 2,
        (box[0] + box[2]) / 2,
      ];
      const m = rotationAbout(args.angle ?? 0, centre);
      return isIdentity(m) ? [] : targets.map((t) => transformOpFor(t, m));
    }
    case "scale": {
      const anchor = args.anchor ?? "center";
      const m = scaleAbout(
        box,
        anchorPoint(box, anchor),
        args.width,
        args.height,
      );
      return !m || isIdentity(m)
        ? []
        : targets.map((t) => transformOpFor(t, m));
    }
    case "resize": {
      // Each frame's own box, as the handle drag does; a group has no box
      // of its own, so it scales about its anchor (as its handle drag does).
      const anchor = args.anchor ?? "center";
      const ops: ShellObjectOp[] = [];
      for (const t of targets) {
        if (!t.group && t.inner) {
          ops.push({
            op: "invoke",
            command: "core.resizeFrame",
            args: {
              frameId: t.address,
              bounds: [
                ...resizedBounds(t.inner, anchor, args.width, args.height),
              ],
            },
          });
          continue;
        }
        const m = scaleAbout(
          t.box,
          anchorPoint(t.box, anchor),
          args.width,
          args.height,
        );
        if (m && !isIdentity(m)) ops.push(transformOpFor(t, m));
      }
      return ops;
    }
  }
}

/** What `runTransformSelection` reads and writes through (align-plan's). */
export interface TransformSelectionDeps {
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
export async function runTransformSelection(
  deps: TransformSelectionDeps,
  args: TransformSelectionArgs,
) {
  const refused = transformSelectionRefusal(args);
  if (refused) throw new Error(`invalidValue: ${refused}`);
  const targets = await deps.targets(args.targets);
  const ops = planTransformSelection(args, targets);
  if (ops.length === 0) return { applied: true, undoSteps: 0 as const };
  return deps.batch(ops, { label: `transform selection ${args.transform}` });
}
