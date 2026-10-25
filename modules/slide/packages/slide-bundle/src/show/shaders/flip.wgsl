// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:flip — the slide turns over about its vertical centre line, the
// incoming slide on its back. directions: l r.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let scr = to_centered(in.uv);
  let sx = -dir_vec(u.direction).x;
  let angle = p * PI;
  let lift = vec3f(0.0, 0.0, sin(p * PI) * 0.6);
  if (angle < PI * 0.5) {
    let h = card_y(scr, sx * angle, 0.0, 0.0, lift);
    if (h.w > 0.5) {
      return vec4f(from_color(h.xy).rgb * facing(angle), 1.0);
    }
    return BG;
  }
  let a2 = angle - PI;
  let h = card_y(scr, sx * a2, 0.0, 0.0, lift);
  if (h.w > 0.5) {
    return vec4f(to_color(h.xy).rgb * facing(a2), 1.0);
  }
  return BG;
}
