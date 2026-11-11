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

// THE WARP KERNEL of the vector Puppet Warp and Liquify: the engine's
// `paged-warp` crate (the one implementation; paged.image bends its layers
// with the same solve and brush maps), reached through this bundle's wasm
// (crates/trace-js `warp.rs`) and handed to vector-tools' machines as
// their `WarpKernel`. The boundary is FLAT `Float64Array`s, not JSON: a
// drag sample crosses it on every pointer move. The layouts below are
// `warp.rs`'s, field for field.
//
// COST (Apple M-series): a Liquify step on a few hundred anchors took
// 0.23 ms in the release wasm. A Puppet Warp drag sample (the whole pin
// set solved, every control point mapped) solves with a direct banded
// factorisation (`paged_warp::puppet::VECTOR_SOLVE`): 1.7 ms natively on
// a 264-vertex mesh; `test/warp-machines.spec.ts` bounds the wasm's.

import type {
  AnchorTable,
  AnchorTriple,
  Vec2,
  Vec2Mut,
} from "@paged-media/vector-geometry";
import {
  LIQUIFY_KINDS,
  type Located,
  type LiquifyParams,
  type LiquifyState,
  type PuppetMode,
  type WarpKernel,
} from "@paged-media/vector-tools";

import { bootDrawWasm, type TraceWasmModule } from "./trace-engine";

const MODES: readonly PuppetMode[] = ["rigid", "normal", "distort"];

function encodeRings(rings: readonly (readonly Vec2[])[]): Float64Array {
  let n = 1;
  for (const r of rings) n += 1 + 2 * r.length;
  const out = new Float64Array(n);
  out[0] = rings.length;
  let k = 1;
  for (const r of rings) {
    out[k++] = r.length;
    for (const p of r) {
      out[k++] = p[0];
      out[k++] = p[1];
    }
  }
  return out;
}

const flatPoints = (points: readonly Vec2[]): Float64Array => {
  const out = new Float64Array(points.length * 2);
  points.forEach((p, i) => {
    out[2 * i] = p[0];
    out[2 * i + 1] = p[1];
  });
  return out;
};

const pairs = (flat: ArrayLike<number>, from: number, count: number) => {
  const out: Vec2Mut[] = [];
  for (let i = 0; i < count; i++)
    out.push([flat[from + 2 * i]!, flat[from + 2 * i + 1]!]);
  return out;
};

const flatTriangles = (tris: readonly [number, number, number][]) => {
  const out = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => out.set(t, 3 * i));
  return out;
};

const flatLocated = (located: readonly Located[]): Float64Array => {
  const out = new Float64Array(located.length * 4);
  located.forEach((l, i) => {
    out[4 * i] = l.triangle;
    out.set(l.weights, 4 * i + 1);
  });
  return out;
};

/** A Liquify state as `warp.rs` reads it: `[startCount, openCount,
 *  anchorCount, start…, open…, (ax, ay, lx, ly, rx, ry, touched, id)…]`. */
export function encodeLiquifyState(s: LiquifyState): Float64Array {
  const t = s.table;
  const starts = t.subpathStarts;
  const open = t.subpathOpen ?? [];
  const n = t.anchors.length;
  const out = new Float64Array(3 + starts.length + open.length + 8 * n);
  out[0] = starts.length;
  out[1] = open.length;
  out[2] = n;
  let k = 3;
  for (const v of starts) out[k++] = v;
  for (const o of open) out[k++] = o ? 1 : 0;
  t.anchors.forEach((a, i) => {
    out.set(
      [
        a.anchor[0],
        a.anchor[1],
        a.left[0],
        a.left[1],
        a.right[0],
        a.right[1],
        s.touched[i] ? 1 : 0,
        s.ids[i] ?? i,
      ],
      k,
    );
    k += 8;
  });
  return out;
}

/** The inverse; `withOpen` keeps the table without `subpathOpen` when
 *  the input had none. */
export function decodeLiquifyState(
  flat: Float64Array,
  withOpen: boolean,
): LiquifyState {
  const ns = flat[0]!;
  const no = flat[1]!;
  const n = flat[2]!;
  let k = 3;
  const subpathStarts = Array.from(flat.subarray(k, k + ns));
  k += ns;
  const subpathOpen = Array.from(flat.subarray(k, k + no), (v) => v !== 0);
  k += no;
  const anchors: AnchorTriple[] = [];
  const touched: boolean[] = [];
  const ids: number[] = [];
  for (let i = 0; i < n; i++, k += 8) {
    anchors.push({
      anchor: [flat[k]!, flat[k + 1]!],
      left: [flat[k + 2]!, flat[k + 3]!],
      right: [flat[k + 4]!, flat[k + 5]!],
    });
    touched.push(flat[k + 6] !== 0);
    ids.push(flat[k + 7]!);
  }
  const table: AnchorTable = {
    anchors,
    subpathStarts,
    ...(withOpen ? { subpathOpen } : {}),
  };
  return { table, touched, ids };
}

const encodeParams = (p: LiquifyParams): Float64Array =>
  Float64Array.of(
    LIQUIFY_KINDS.indexOf(p.kind),
    p.delta?.[0] ?? 0,
    p.delta?.[1] ?? 0,
    p.twirlRate ?? 40,
    p.complexity ?? 1,
    p.horizontal ?? 0,
    p.vertical ?? 100,
    (p.affectAnchors ?? true) ? 1 : 0,
    (p.affectIn ?? true) ? 1 : 0,
    (p.affectOut ?? true) ? 1 : 0,
    p.seed ?? 0,
  );

/** The `WarpKernel` over a booted draw wasm. */
export function wasmWarpKernel(mod: TraceWasmModule): WarpKernel {
  return {
    puppetMesh(rings, spacing, maxVertices, autoPins) {
      const out = mod.puppetMesh(
        encodeRings(rings),
        spacing,
        Math.max(3, Math.round(maxVertices)),
        Math.max(0, Math.round(autoPins)),
      );
      const nv = out[0]!;
      const nt = out[1]!;
      const np = out[2]!;
      const vertices = pairs(out, 3, nv);
      const t0 = 3 + 2 * nv;
      const triangles: [number, number, number][] = [];
      for (let i = 0; i < nt; i++)
        triangles.push([
          out[t0 + 3 * i]!,
          out[t0 + 3 * i + 1]!,
          out[t0 + 3 * i + 2]!,
        ]);
      const p0 = t0 + 3 * nt;
      return {
        mesh: { vertices, triangles },
        autoPins: Array.from(out.subarray(p0, p0 + np)),
      };
    },
    puppetLocate(mesh, points) {
      const out = mod.puppetLocate(
        flatPoints(mesh.vertices),
        flatTriangles(mesh.triangles),
        flatPoints(points),
      );
      const located: Located[] = [];
      for (let i = 0; i < points.length; i++)
        located.push({
          triangle: out[4 * i]!,
          weights: [out[4 * i + 1]!, out[4 * i + 2]!, out[4 * i + 3]!],
        });
      return located;
    },
    puppetSolve(mesh, pins, mode, located) {
      const flatPins = new Float64Array(pins.length * 4);
      pins.forEach((p, i) =>
        flatPins.set(
          [p.vertex, p.target[0], p.target[1], p.angle ?? Number.NaN],
          4 * i,
        ),
      );
      const out = mod.puppetSolve(
        flatPoints(mesh.vertices),
        flatTriangles(mesh.triangles),
        flatPins,
        Math.max(0, MODES.indexOf(mode)),
        flatLocated(located),
      );
      const nv = mesh.vertices.length;
      const points = pairs(out, 2 * nv, located.length).map((p) =>
        Number.isNaN(p[0]) ? null : p,
      );
      return { vertices: pairs(out, 0, nv), points };
    },
    liquifyStep(state, brush, params, detail) {
      const out = mod.liquifyStep(
        encodeLiquifyState(state),
        Float64Array.of(
          brush.center[0],
          brush.center[1],
          brush.width,
          brush.height,
          brush.angleDeg,
          brush.strength,
        ),
        encodeParams(params),
        detail,
      );
      return decodeLiquifyState(out, state.table.subpathOpen !== undefined);
    },
  };
}

/** Boot the draw wasm (once per realm) and answer its warp kernel.
 *  Rejects with `TRACE_ENGINE_NOT_BUILT` when the artifact is absent. */
export async function bootWarpKernel(): Promise<WarpKernel> {
  return wasmWarpKernel(await bootDrawWasm());
}
