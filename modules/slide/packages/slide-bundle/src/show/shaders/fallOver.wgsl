// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="fallOver" — the outgoing slide falls over backwards
// on its bottom edge and fades out, uncovering the incoming slide.
// params: invX (slot 0) leans the fall to one side.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let scr = to_centered(in.uv);
  let fall = p * p;
  let lean = select(0.0, 0.25, param(0u) > 0.5) * fall;
  let h = card_x(rot2(lean) * scr, -fall * PI * 0.5, 0.5, 0.0, vec3f(0.0));
  let to_c = to_color(in.uv);
  if (h.w < 0.5) {
    return to_c;
  }
  let a = 1.0 - smoothstep(0.75, 1.0, p);
  let c = from_color(h.xy).rgb * facing(fall * PI * 0.5);
  return vec4f(mix(to_c.rgb, c, a), 1.0);
}
