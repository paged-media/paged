// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="fracture" — the outgoing slide shatters into
// triangular shards that fall away from the viewer, each shrinking towards
// a point low inside itself and darkening, the incoming slide showing
// through the widening cracks. 2.5D approximation: the shards recede in
// place instead of tumbling down in 3D.
//
// The shards tile each horizontal band as a strip of triangles between two
// rows of jittered points (tops at k + jitter, bottoms at k + 0.5 + jitter).
// A shard only ever shrinks inside its own outline, so a pixel needs only the
// shard it lies in: one of six candidates of its band, found without a loop.

const BANDS: f32 = 5.0;

fn top_point(k: f32, band: f32) -> vec2f {
  return vec2f(k + (hash21(vec2f(k, band * 2.0)) - 0.5) * 0.8, band);
}

fn bottom_point(k: f32, band: f32) -> vec2f {
  return vec2f(k + 0.5 + (hash21(vec2f(k, band * 2.0 + 1.0)) - 0.5) * 0.8, band + 1.0);
}

fn cross2(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.y - a.y * b.x;
}

fn in_triangle(q: vec2f, a: vec2f, b: vec2f, c: vec2f) -> bool {
  let d1 = cross2(b - a, q - a);
  let d2 = cross2(c - b, q - b);
  let d3 = cross2(a - c, q - c);
  let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
  let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
  return !(neg && pos);
}

// The colour of shard (a, b, c) with id `id` at grid point `q`, which lies in
// its outline; the incoming slide where the shrunken shard has left it.
fn shard(uv: vec2f, q: vec2f, g: vec2f, id: vec2f, a: vec2f, b: vec2f, c: vec2f) -> vec4f {
  let p = u.progress;
  let delay = hash21(id + vec2f(7.0, 3.0)) * 0.35 + (1.0 - clamp(id.y / g.y, 0.0, 1.0)) * 0.1;
  let lp = clamp((p - delay) / 0.55, 0.0, 1.0);
  let k = 1.0 - lp;
  if (k <= 1e-3) {
    return to_color(uv);
  }
  // Shrink towards a point between the centroid and the lowest corner: the
  // shard seems to drop as it recedes.
  let low = select(select(c, b, b.y > c.y), a, a.y > max(b.y, c.y));
  let anchor = mix((a + b + c) / 3.0, low, 0.5 * lp);
  let src = anchor + (q - anchor) / k;
  if (!in_triangle(src, a, b, c)) {
    return to_color(uv);
  }
  return vec4f(from_color(src / g).rgb * (1.0 - 0.6 * lp), 1.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let g = vec2f(max(1.0, floor(BANDS * ratio() * 1.4 + 0.5)), BANDS);
  let q = in.uv * g;
  let band = floor(q.y);
  let k = floor(q.x);
  let t0 = top_point(k - 1.0, band);
  let t1 = top_point(k, band);
  let t2 = top_point(k + 1.0, band);
  let t3 = top_point(k + 2.0, band);
  let b0 = bottom_point(k - 1.0, band);
  let b1 = bottom_point(k, band);
  let b2 = bottom_point(k + 1.0, band);
  let b3 = bottom_point(k - 2.0, band);
  // Up_j = (T_j, T_j+1, B_j); Down_j = (B_j-1, T_j, B_j).
  if (in_triangle(q, t1, t2, b1)) {
    return shard(in.uv, q, g, vec2f(k * 2.0, band), t1, t2, b1);
  }
  if (in_triangle(q, b0, t1, b1)) {
    return shard(in.uv, q, g, vec2f(k * 2.0 + 1.0, band), b0, t1, b1);
  }
  if (in_triangle(q, t0, t1, b0)) {
    return shard(in.uv, q, g, vec2f(k * 2.0 - 2.0, band), t0, t1, b0);
  }
  if (in_triangle(q, b1, t2, b2)) {
    return shard(in.uv, q, g, vec2f(k * 2.0 + 3.0, band), b1, t2, b2);
  }
  if (in_triangle(q, t2, t3, b2)) {
    return shard(in.uv, q, g, vec2f(k * 2.0 + 2.0, band), t2, t3, b2);
  }
  if (in_triangle(q, b3, t0, b0)) {
    return shard(in.uv, q, g, vec2f(k * 2.0 - 1.0, band), b3, t0, b0);
  }
  return from_color(in.uv);
}
