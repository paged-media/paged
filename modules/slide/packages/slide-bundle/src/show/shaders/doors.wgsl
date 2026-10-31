// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:doors — the outgoing slide opens like a pair of doors towards the
// viewer; the incoming slide comes forward behind them. dir vert hinges
// the doors at the left and right edges, horz at the top and bottom.
// directions: horz vert.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let swap = u.direction == DIR_HORZ;
  var scr = to_centered(in.uv);
  var w = ratio();
  var h = 1.0;
  if (swap) {
    scr = scr.yx;
    w = 1.0;
    h = ratio();
  }
  let theta = p * PI * 0.5;
  let c = cos(theta);
  let s = sin(theta);
  let ey = vec3f(0.0, h, 0.0);
  let left = plane_hit(scr, vec3f(-w * 0.5, -h * 0.5, 0.0), vec3f(w * 0.5 * c, 0.0, -w * 0.5 * s), ey);
  let right = plane_hit(scr, vec3f(w * 0.5, -h * 0.5, 0.0), vec3f(-w * 0.5 * c, 0.0, -w * 0.5 * s), ey);
  let back = plane_hit(scr, vec3f(-w * 0.5, -h * 0.5, (1.0 - p) * 1.2), vec3f(w, 0.0, 0.0), ey);
  var best = 1e9;
  var col = BG;
  if (left.w > 0.5 && left.z < best) {
    best = left.z;
    var st = vec2f(left.x * 0.5, left.y);
    if (swap) { st = st.yx; }
    col = vec4f(from_color(st).rgb * facing(theta), 1.0);
  }
  if (right.w > 0.5 && right.z < best) {
    best = right.z;
    var st = vec2f(1.0 - right.x * 0.5, right.y);
    if (swap) { st = st.yx; }
    col = vec4f(from_color(st).rgb * facing(theta), 1.0);
  }
  if (back.w > 0.5 && back.z < best) {
    var st = back.xy;
    if (swap) { st = st.yx; }
    col = to_color(st);
  }
  return col;
}
