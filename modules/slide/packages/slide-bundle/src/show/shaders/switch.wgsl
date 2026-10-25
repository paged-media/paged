// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:switch — the two slides swing past each other in perspective: the
// outgoing one turns away to one side and back, the incoming one comes
// forward from the other side. directions: l r.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let scr = to_centered(in.uv);
  let sx = dir_vec(u.direction).x;
  let w = ratio();
  let swing = sin(p * PI);
  let a = card_y(scr, sx * swing * 0.7, 0.0, p * 1.6, vec3f(sx * swing * w * 0.55, 0.0, 0.0));
  let b = card_y(scr, -sx * swing * 0.7, 0.0, (1.0 - p) * 1.6, vec3f(-sx * swing * w * 0.55, 0.0, 0.0));
  let ha = a.w > 0.5;
  let hb = b.w > 0.5;
  if (hb && (!ha || b.z <= a.z)) {
    return vec4f(to_color(b.xy).rgb * facing(swing * 0.7), 1.0);
  }
  if (ha) {
    return vec4f(from_color(a.xy).rgb * facing(swing * 0.7), 1.0);
  }
  return BG;
}
