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

//! Puppet Warp and Liquify for the vector tools: `paged-warp`'s kernels
//! over FLAT `Float64Array`s (a drag sample crosses the boundary on every
//! pointer move, so no JSON). The layouts are the TS facade's
//! (`draw-bundle/src/warp-kernel.ts`), and every entry point refuses a
//! malformed array with an error instead of panicking.

use paged_warp::liquify::{self, Anchor, Brush, Kind, Params, State, Table};
use paged_warp::mesh::{self, Located};
use paged_warp::puppet::{self, PuppetMesh, PuppetMode, VertexPin};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

type P = [f64; 2];

fn bad(what: &str) -> String {
    format!("warp: malformed {what}")
}

fn count(v: f64, what: &str) -> Result<usize, String> {
    if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v < 1e9 {
        Ok(v as usize)
    } else {
        Err(bad(what))
    }
}

fn points(flat: &[f64]) -> Vec<P> {
    flat.as_chunks::<2>()
        .0
        .iter()
        .map(|c| [c[0], c[1]])
        .collect()
}

fn mesh_of(vertices: &[f64], triangles: &[u32]) -> Result<PuppetMesh, String> {
    if !vertices.len().is_multiple_of(2) || !triangles.len().is_multiple_of(3) {
        return Err(bad("mesh"));
    }
    let n = (vertices.len() / 2) as u32;
    if triangles.iter().any(|&k| k >= n) {
        return Err(bad("mesh"));
    }
    Ok(PuppetMesh {
        vertices: points(vertices),
        triangles: triangles
            .as_chunks::<3>()
            .0
            .iter()
            .map(|t| [t[0], t[1], t[2]])
            .collect(),
    })
}

/// The mesh of closed rings. `rings` is `[count, len₀, x, y, …, len₁, …]`
/// (points per ring). Answers `[vertexCount, triangleCount, pinCount,
/// x, y, …, a, b, c, …, pin, …]` with `autoPins` automatic pins.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = puppetMesh))]
pub fn puppet_mesh(
    rings: &[f64],
    spacing: f64,
    max_vertices: u32,
    auto_pins: u32,
) -> Result<Vec<f64>, String> {
    let mut list: Vec<Vec<P>> = Vec::new();
    let n = count(*rings.first().ok_or_else(|| bad("rings"))?, "rings")?;
    let mut at = 1;
    for _ in 0..n {
        let len = count(*rings.get(at).ok_or_else(|| bad("rings"))?, "rings")?;
        let body = rings
            .get(at + 1..at + 1 + 2 * len)
            .ok_or_else(|| bad("rings"))?;
        list.push(points(body));
        at += 1 + 2 * len;
    }
    if !spacing.is_finite() || list.iter().flatten().flatten().any(|v| !v.is_finite()) {
        return Err(bad("rings"));
    }
    let m = mesh::triangulate_rings(&list, spacing, max_vertices.max(3) as usize).mesh;
    let pins = mesh::auto_pins(&m, auto_pins as usize);
    let mut out = vec![
        m.vertices.len() as f64,
        m.triangles.len() as f64,
        pins.len() as f64,
    ];
    out.extend(m.vertices.iter().flatten());
    out.extend(m.triangles.iter().flatten().map(|&k| f64::from(k)));
    out.extend(pins.iter().map(|&k| f64::from(k)));
    Ok(out)
}

/// Where each point of `points` (`x, y, …`) sits in the mesh: `[triangle,
/// w₀, w₁, w₂]` per point (triangle −1 for an empty mesh); outside the
/// mesh, the nearest triangle and extrapolated weights.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = puppetLocate))]
pub fn puppet_locate(
    vertices: &[f64],
    triangles: &[u32],
    points_flat: &[f64],
) -> Result<Vec<f64>, String> {
    let m = mesh_of(vertices, triangles)?;
    let mut out = Vec::with_capacity(points_flat.len() * 2);
    for p in points(points_flat) {
        match mesh::locate(&m.vertices, &m.triangles, p) {
            Some(l) => out.extend([
                f64::from(l.triangle),
                l.weights[0],
                l.weights[1],
                l.weights[2],
            ]),
            None => out.extend([-1.0, 1.0, 0.0, 0.0]),
        }
    }
    Ok(out)
}

/// Bend the mesh by `pins` (`vertex, x, y, angle` each; angle NaN = the
/// pin does not turn) in `mode` (0 rigid, 1 normal, 2 distort), then map
/// the `located` points (`puppetLocate`'s rows). Answers the bent
/// vertices (`x, y, …`) followed by the mapped points (`x, y, …`; NaN for
/// a point located in no triangle).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = puppetSolve))]
pub fn puppet_solve(
    vertices: &[f64],
    triangles: &[u32],
    pins: &[f64],
    mode: u32,
    located: &[f64],
) -> Result<Vec<f64>, String> {
    let m = mesh_of(vertices, triangles)?;
    if !pins.len().is_multiple_of(4) || !located.len().is_multiple_of(4) {
        return Err(bad("pins"));
    }
    let mode = PuppetMode::from_code(mode).ok_or_else(|| bad("mode"))?;
    let mut list = Vec::with_capacity(pins.len() / 4);
    for p in pins.as_chunks::<4>().0.iter() {
        let vertex = count(p[0], "pins")?;
        if vertex >= m.vertices.len() || !p[1].is_finite() || !p[2].is_finite() {
            return Err(bad("pins"));
        }
        list.push(VertexPin {
            vertex: vertex as u32,
            to: [p[1], p[2]],
            angle: p[3].is_finite().then_some(p[3]),
        });
    }
    let bent = puppet::solve_with(
        &m,
        &puppet::vertex_pins(&m, &list),
        mode,
        puppet::VECTOR_SOLVE,
    );
    let mut out: Vec<f64> = bent.iter().flatten().copied().collect();
    for l in located.as_chunks::<4>().0.iter() {
        let t = l[0];
        if t < 0.0 || !t.is_finite() || t as usize >= m.triangles.len() {
            out.extend([f64::NAN, f64::NAN]);
            continue;
        }
        let loc = Located {
            triangle: t as u32,
            weights: [l[1], l[2], l[3]],
        };
        out.extend(mesh::map_located(&m.triangles, &bent, loc));
    }
    Ok(out)
}

/// A liquify state over the boundary: `[startCount, openCount,
/// anchorCount, start…, open…, (ax, ay, lx, ly, rx, ry, touched, id)…]`.
fn read_state(flat: &[f64]) -> Result<State, String> {
    let head = flat.get(..3).ok_or_else(|| bad("state"))?;
    let (ns, no, na) = (
        count(head[0], "state")?,
        count(head[1], "state")?,
        count(head[2], "state")?,
    );
    let need = 3 + ns + no + 8 * na;
    if flat.len() != need {
        return Err(bad("state"));
    }
    let starts = flat[3..3 + ns]
        .iter()
        .map(|&v| count(v, "state").map(|v| v as u32))
        .collect::<Result<Vec<_>, _>>()?;
    let open = flat[3 + ns..3 + ns + no]
        .iter()
        .map(|&v| v != 0.0)
        .collect();
    let mut state = State {
        table: Table {
            anchors: Vec::with_capacity(na),
            subpath_starts: starts,
            subpath_open: open,
        },
        touched: Vec::with_capacity(na),
        ids: Vec::with_capacity(na),
    };
    for a in flat[3 + ns + no..].as_chunks::<8>().0.iter() {
        if a[..6].iter().any(|v| !v.is_finite()) {
            return Err(bad("state"));
        }
        state.table.anchors.push(Anchor {
            anchor: [a[0], a[1]],
            left: [a[2], a[3]],
            right: [a[4], a[5]],
        });
        state.touched.push(a[6] != 0.0);
        // An id is an index or a minted hash (below 2³²).
        if !(a[7].is_finite()
            && a[7] >= 0.0
            && a[7].fract() == 0.0
            && a[7] < 9_007_199_254_740_992.0)
        {
            return Err(bad("state"));
        }
        state.ids.push(a[7] as u64);
    }
    Ok(state)
}

fn write_state(s: &State) -> Vec<f64> {
    let t = &s.table;
    let mut out = vec![
        t.subpath_starts.len() as f64,
        t.subpath_open.len() as f64,
        t.anchors.len() as f64,
    ];
    out.extend(t.subpath_starts.iter().map(|&v| f64::from(v)));
    out.extend(t.subpath_open.iter().map(|&o| f64::from(u8::from(o))));
    for ((a, &touched), &id) in t.anchors.iter().zip(&s.touched).zip(&s.ids) {
        out.extend([
            a.anchor[0],
            a.anchor[1],
            a.left[0],
            a.left[1],
            a.right[0],
            a.right[1],
            f64::from(u8::from(touched)),
            id as f64,
        ]);
    }
    out
}

/// One liquify step. `brush` is `[cx, cy, width, height, angleDeg,
/// strength]`; `params` is `[kind, dx, dy, twirlRate, complexity,
/// horizontal, vertical, affectAnchors, affectIn, affectOut, seed]` (kind
/// 0..6: warp, twirl, pucker, bloat, scallop, crystallize, wrinkle).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = liquifyStep))]
pub fn liquify_step(
    state: &[f64],
    brush: &[f64],
    params: &[f64],
    detail: f64,
) -> Result<Vec<f64>, String> {
    let s = read_state(state)?;
    let [cx, cy, width, height, angle_deg, strength] =
        <[f64; 6]>::try_from(brush).map_err(|_| bad("brush"))?;
    let p = <[f64; 11]>::try_from(params).map_err(|_| bad("params"))?;
    if brush.iter().chain(&p).any(|v| !v.is_finite()) || !detail.is_finite() {
        return Err(bad("brush"));
    }
    let kind = Kind::from_code(count(p[0], "params")? as u32).ok_or_else(|| bad("params"))?;
    let b = Brush {
        center: [cx, cy],
        width,
        height,
        angle_deg,
        strength,
    };
    let params = Params {
        kind,
        delta: [p[1], p[2]],
        twirl_rate: p[3],
        complexity: p[4],
        horizontal: p[5],
        vertical: p[6],
        affect_anchors: p[7] != 0.0,
        affect_in: p[8] != 0.0,
        affect_out: p[9] != 0.0,
        seed: p[10] as i32,
    };
    Ok(write_state(&liquify::step(&s, &b, &params, detail)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_square_meshes_bends_and_maps() {
        let rings = [1.0, 4.0, 0.0, 0.0, 100.0, 0.0, 100.0, 100.0, 0.0, 100.0];
        let out = puppet_mesh(&rings, 20.0, 600, 2).unwrap();
        let (nv, nt, np) = (out[0] as usize, out[1] as usize, out[2] as usize);
        assert!(nv > 16 && nt > 16 && np == 2);
        let vertices = &out[3..3 + 2 * nv];
        let triangles: Vec<u32> = out[3 + 2 * nv..3 + 2 * nv + 3 * nt]
            .iter()
            .map(|&v| v as u32)
            .collect();
        let loc = puppet_locate(vertices, &triangles, &[50.0, 50.0, 10.0, 90.0]).unwrap();
        assert_eq!(loc.len(), 8);
        // Two pins moved by the same offset translate everything.
        let pin = |k: usize| {
            [
                k as f64,
                vertices[2 * k] + 5.0,
                vertices[2 * k + 1] - 2.0,
                f64::NAN,
            ]
        };
        let pins: Vec<f64> = [0, nv - 1].into_iter().flat_map(pin).collect();
        let bent = puppet_solve(vertices, &triangles, &pins, 0, &loc).unwrap();
        assert_eq!(bent.len(), 2 * nv + 4);
        assert!((bent[2 * nv] - 55.0).abs() < 1e-6 && (bent[2 * nv + 3] - 88.0).abs() < 1e-6);
        assert!(puppet_solve(vertices, &triangles, &[1e12, 0.0, 0.0, 0.0], 0, &[]).is_err());
        assert!(puppet_mesh(&[2.0, 4.0], 1.0, 10, 0).is_err());
    }

    #[test]
    fn a_liquify_step_round_trips_its_state() {
        // One open line, two corners.
        let state = [
            1.0, 1.0, 2.0, 0.0, 1.0, 0.0, 200.0, 0.0, 200.0, 0.0, 200.0, 0.0, 0.0, 400.0, 200.0,
            400.0, 200.0, 400.0, 200.0, 0.0, 1.0,
        ];
        let brush = [200.0, 200.0, 200.0, 200.0, 0.0, 1.0];
        let params = [0.0, 0.0, -30.0, 40.0, 1.0, 0.0, 100.0, 1.0, 1.0, 1.0, 0.0];
        let out = liquify_step(&state, &brush, &params, 2.0).unwrap();
        let s = read_state(&out).unwrap();
        assert!(s.table.anchors.len() > 2);
        assert_eq!(s.table.subpath_open, vec![true]);
        let top = s
            .table
            .anchors
            .iter()
            .map(|a| a.anchor[1])
            .fold(999.0, f64::min);
        assert!((top - 170.0).abs() < 1e-6);
        assert!(liquify_step(&state[..5], &brush, &params, 2.0).is_err());
        assert!(liquify_step(&state, &brush[..3], &params, 2.0).is_err());
    }
}
