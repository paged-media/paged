// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:conveyor — the slides ride a conveyor belt: each steps back, turns
// slightly and moves along, and the incoming one comes forward.
// directions: l r.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let scr = to_centered(in.uv);
  let sx = dir_vec(u.direction).x;
  let w = ratio();
  let lift = sin(p * PI);
  let z = lift * 1.3;
  let turn = sx * lift * 0.35;
  let gap = w * 1.15;
  let a = card_y(scr, turn, 0.0, z, vec3f(sx * p * gap, 0.0, 0.0));
  let b = card_y(scr, turn, 0.0, z, vec3f(-sx * (1.0 - p) * gap, 0.0, 0.0));
  if (b.w > 0.5 && (a.w < 0.5 || b.z <= a.z)) {
    return vec4f(to_color(b.xy).rgb * facing(turn), 1.0);
  }
  if (a.w > 0.5) {
    return vec4f(from_color(a.xy).rgb * facing(turn), 1.0);
  }
  return BG;
}
