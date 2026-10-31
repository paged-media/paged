// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="prestige" — the outgoing slide tips back on its
// bottom edge and sinks away while the incoming slide rises up into place
// from below. 2.5D approximation of PowerPoint's swing.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let scr = to_centered(in.uv);
  let a1 = clamp(p / 0.6, 0.0, 1.0);
  let tip = -a1 * a1 * PI * 0.42;
  let back = card_x(scr, tip, 0.5, a1 * 0.8, vec3f(0.0));
  let a2 = clamp((p - 0.3) / 0.7, 0.0, 1.0);
  let ease = 1.0 - (1.0 - a2) * (1.0 - a2);
  let rise = card_x(scr, (1.0 - ease) * PI * 0.3, -0.5, (1.0 - ease) * 0.6, vec3f(0.0, (1.0 - ease) * 1.1, 0.0));
  if (a2 > 0.0 && rise.w > 0.5 && (back.w < 0.5 || rise.z <= back.z)) {
    return to_color(rise.xy);
  }
  if (back.w > 0.5) {
    let fade = 1.0 - smoothstep(0.55, 1.0, p);
    return vec4f(from_color(back.xy).rgb * facing(tip) * fade, 1.0);
  }
  return BG;
}
