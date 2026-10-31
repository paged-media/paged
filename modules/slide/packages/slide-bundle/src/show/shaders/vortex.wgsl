// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:vortex — the outgoing slide breaks into tiles that spin away in a
// wave travelling in `dir`; the incoming slide's tiles spin in behind them.
// 2.5D: the tiles spin and shrink in place (PowerPoint also lifts them into
// a 3D swirl). directions: l r u d.

const BG: vec4f = vec4f(0.04, 0.04, 0.05, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let rows = 8.0;
  let grid = vec2f(max(1.0, floor(rows * ratio() + 0.5)), rows);
  let cell = floor(in.uv * grid);
  let center = (cell + vec2f(0.5)) / grid;
  let delay = along(center, dir_vec(u.direction)) * 0.5 + hash21(cell) * 0.2;
  let lp = clamp((u.progress - delay) / 0.3, 0.0, 1.0);
  if (lp <= 0.0) {
    return from_color(in.uv);
  }
  if (lp >= 1.0) {
    return to_color(in.uv);
  }
  let first = lp < 0.5;
  let k = select(lp * 2.0 - 1.0, 1.0 - lp * 2.0, first);
  if (k <= 1e-4) {
    return BG;
  }
  let spin = select((1.0 - lp) * TAU, -lp * TAU, first) * select(1.0, -1.0, hash21(cell + vec2f(7.0)) < 0.5);
  let local = fract(in.uv * grid) - vec2f(0.5);
  let src_local = rot2(-spin) * local / k;
  if (any(abs(src_local) > vec2f(0.5))) {
    return BG;
  }
  let src = (cell + src_local + vec2f(0.5)) / grid;
  let shade = mix(0.6, 1.0, k);
  let c = select(to_color(src), from_color(src), first);
  return vec4f(c.rgb * shade, 1.0);
}
