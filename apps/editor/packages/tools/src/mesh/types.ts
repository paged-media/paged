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

// The wire shape of a gradient mesh / freeform gradient fill (engine ADR
// 1048, `PropertyPath::FrameFillMesh`, value `{ type: "fillMesh", value }`),
// written out here so the editing maths of this folder is a pure module:
// it compiles and tests without the engine's generated types, and the
// handlers hand these objects to the wire unchanged (the shapes are the
// engine's camelCase JSON). Every point is in the FRAME'S INNER
// coordinates — the space of the element's `bounds`.

export type Vec2 = [number, number];

export type MeshColorSpace = "RGB" | "CMYK" | "LAB" | "Gray";

/** A colour as the engine stores it inline: RGB 0..255, CMYK percent,
 *  Lab L*a*b*, Gray percent; `opacityPct` 0..100 (absent = opaque). */
export interface MeshColorSpec {
  space: MeshColorSpace;
  value: number[];
  opacityPct?: number;
}

/** One node of a grid: its position, its colour and the four inner
 *  control points of the edges leaving it towards the previous column,
 *  the next column, the previous row and the next row. On the outside
 *  of the grid a handle equals the point. */
export interface MeshNodeSpec {
  point: Vec2;
  handles: [Vec2, Vec2, Vec2, Vec2];
  color: MeshColorSpec;
}

/** `rows × cols` patches over `(rows+1) × (cols+1)` nodes, row-major from
 *  the top-left node. `tensor` holds imported type-7 interiors (per patch,
 *  row-major: p11 p12 p21 p22); an edit through the Mesh tool clears it,
 *  the patches becoming Coons patches (engine ADR 1048). The engine may
 *  leave it out; `normalizeFill` puts it back as `[]`. */
export interface MeshGridSpec {
  rows: number;
  cols: number;
  nodes: MeshNodeSpec[];
  tensor: Array<[Vec2, Vec2, Vec2, Vec2]>;
}

export interface FreeformPointSpec {
  point: Vec2;
  color: MeshColorSpec;
  /** How far the colour holds, percent of the box diagonal (0 = absent). */
  spreadPct?: number;
}

export type MeshFillSpec =
  | { kind: "mesh"; grids: MeshGridSpec[] }
  | { kind: "freeform"; points: FreeformPointSpec[]; lines: number[][] };

/** A fill as the engine reads it back (`tensor` and `lines` may be left
 *  out) in the shape this folder works on. */
export function normalizeFill(raw: unknown): MeshFillSpec | null {
  const spec = raw as
    | {
        kind?: string;
        grids?: Array<Partial<MeshGridSpec>>;
        points?: FreeformPointSpec[];
        lines?: number[][];
      }
    | null
    | undefined;
  if (spec?.kind === "mesh") {
    return {
      kind: "mesh",
      grids: (spec.grids ?? []).map((g) => ({
        rows: g.rows ?? 0,
        cols: g.cols ?? 0,
        nodes: g.nodes ?? [],
        tensor: g.tensor ?? [],
      })),
    };
  }
  if (spec?.kind === "freeform") {
    return {
      kind: "freeform",
      points: spec.points ?? [],
      lines: spec.lines ?? [],
    };
  }
  return null;
}

/** Handle slots of a node, in `handles` order. */
export const LEFT = 0;
export const RIGHT = 1;
export const UP = 2;
export const DOWN = 3;
export type HandleSlot = 0 | 1 | 2 | 3;

/** `[top, left, bottom, right]` — the frame's inner box. */
export type InnerBox = [number, number, number, number];

/** `[a, b, c, d, tx, ty]` — inner → page-local pt (null = identity). */
export type Affine = readonly [number, number, number, number, number, number];

export function applyAffine(m: Affine | null, p: Vec2): Vec2 {
  if (!m) return [p[0], p[1]];
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** The inverse map (page-local → inner); null for a singular matrix. */
export function invertAffine(m: Affine | null): Affine | null {
  if (!m) return [1, 0, 0, 1, 0, 0];
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

/** Interpolate two colours at `t`: channel-wise when they share a space,
 *  else the nearer one (a mesh blends per space; a cross-space blend has
 *  no single right answer without the document's colour management). */
export function lerpColor(
  a: MeshColorSpec,
  b: MeshColorSpec,
  t: number,
): MeshColorSpec {
  if (a.space !== b.space || a.value.length !== b.value.length) {
    return cloneColor(t < 0.5 ? a : b);
  }
  const out: MeshColorSpec = {
    space: a.space,
    value: a.value.map((v, i) => v + (b.value[i]! - v) * t),
  };
  const oa = a.opacityPct ?? 100;
  const ob = b.opacityPct ?? 100;
  const o = oa + (ob - oa) * t;
  if (o < 100) out.opacityPct = o;
  return out;
}

export function cloneColor(c: MeshColorSpec): MeshColorSpec {
  const out: MeshColorSpec = { space: c.space, value: [...c.value] };
  if (c.opacityPct !== undefined) out.opacityPct = c.opacityPct;
  return out;
}

/** The fallback colour when a frame's fill cannot be resolved. */
export const MID_GREY: MeshColorSpec = { space: "RGB", value: [128, 128, 128] };
