// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:shred — pattern strip: the outgoing slide is cut into strips that slide
// off up and down; pattern rectangle: into small pieces that shrink and spin
// away. dir out shreds the outgoing slide; dir in assembles the incoming one.
// params: rectangle (slot 0). directions: in out.

fn strips(uv: vec2f, k: f32, moving_from: bool) -> vec4f {
  let n = 18.0;
  let j = floor(uv.x * n);
  let sgn = select(1.0, -1.0, (j % 2.0) < 0.5);
  let off = sgn * k * k * (1.15 + hash11(j) * 0.8);
  let src = vec2f(uv.x, uv.y - off);
  if (inside(src)) {
    let edge = abs(fract(uv.x * n) - 0.5) * 2.0;
    let shade = 1.0 - 0.25 * k * smoothstep(0.6, 1.0, edge);
    let c = select(to_color(src), from_color(src), moving_from);
    return vec4f(c.rgb * shade, 1.0);
  }
  return select(from_color(uv), to_color(uv), moving_from);
}

fn pieces(uv: vec2f, k: f32, moving_from: bool) -> vec4f {
  let grid = vec2f(max(1.0, floor(14.0 * ratio() + 0.5)), 14.0);
  let cell = floor(uv * grid);
  let delay = hash21(cell) * 0.4;
  let lp = clamp((k - delay) / 0.6, 0.0, 1.0);
  let back = select(from_color(uv), to_color(uv), moving_from);
  if (lp >= 1.0) {
    return back;
  }
  let s = 1.0 - lp;
  let local = rot2(-(hash21(cell + vec2f(5.0)) - 0.5) * 6.0 * lp) * (fract(uv * grid) - vec2f(0.5)) / s;
  if (any(abs(local) > vec2f(0.5))) {
    return back;
  }
  let src = (cell + local + vec2f(0.5)) / grid;
  let c = select(to_color(src), from_color(src), moving_from);
  return vec4f(c.rgb * mix(1.0, 0.7, lp), 1.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let out_dir = u.direction != DIR_IN;
  let k = select(1.0 - p, p, out_dir);
  if (param(0u) > 0.5) {
    return pieces(in.uv, k, out_dir);
  }
  return strips(in.uv, k, out_dir);
}
