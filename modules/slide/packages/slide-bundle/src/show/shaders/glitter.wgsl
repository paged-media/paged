// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:glitter — small diamonds (or hexagons) flip over in a glittering wave
// that travels in `dir`.
// params: hexagon (slot 0). directions: l r u d.

const BG: vec4f = vec4f(0.02, 0.02, 0.02, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let q = to_centered(in.uv);
  let scale = 9.0;
  let hex = param(0u) > 0.5;
  var center_q: vec2f;
  var local: vec2f;
  var axis_rot = 0.0;
  if (hex) {
    let hq = q * scale;
    let c = hex_center(hq);
    center_q = c / scale;
    local = hq - c;
  } else {
    axis_rot = PI * 0.25;
    let rq = rot2(axis_rot) * q * scale;
    let cell = floor(rq) + vec2f(0.5);
    center_q = rot2(-axis_rot) * cell / scale;
    local = rq - cell;
  }
  let center_uv = from_centered(center_q);
  let delay = clamp(along(center_uv, dir_vec(u.direction)), 0.0, 1.0) * 0.6 + hash21(floor(center_q * 97.0)) * 0.1;
  let lp = clamp((p - delay) / 0.3, 0.0, 1.0);
  if (lp <= 0.0) {
    return from_color(in.uv);
  }
  if (lp >= 1.0) {
    return to_color(in.uv);
  }
  let squeeze = abs(cos(lp * PI));
  if (squeeze < 1e-3) {
    return BG;
  }
  let src_local = vec2f(local.x / squeeze, local.y);
  var outside_tile: bool;
  if (hex) {
    outside_tile = hex_dist(src_local) > 0.5;
  } else {
    outside_tile = any(abs(src_local) > vec2f(0.5));
  }
  if (outside_tile) {
    return BG;
  }
  var src_q: vec2f;
  if (hex) {
    src_q = (center_q * scale + src_local) / scale;
  } else {
    src_q = rot2(-axis_rot) * (rot2(axis_rot) * center_q * scale + src_local) / scale;
  }
  let src = from_centered(src_q);
  let c = select(to_color(src), from_color(src), lp < 0.5);
  let sparkle = pow(1.0 - squeeze, 6.0) * hash21(floor(center_q * 53.0) + vec2f(3.0)) * 1.4;
  return vec4f(mix(c.rgb * mix(0.55, 1.0, squeeze), vec3f(1.0), clamp(sparkle, 0.0, 1.0)), 1.0);
}
