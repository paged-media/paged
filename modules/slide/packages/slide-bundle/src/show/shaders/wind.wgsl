// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="wind" — the outgoing slide is blown away in gusting
// streaks to the left (invX: to the right), the incoming slide behind it.
// params: invX (slot 0).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let sx = select(-1.0, 1.0, param(0u) > 0.5);
  let row = floor(in.uv.y * 90.0);
  // The upwind side lets go last: lead is 1 at the upwind edge.
  let lead = select(in.uv.x, 1.0 - in.uv.x, sx > 0.0);
  let t = clamp(p * 1.3 - lead * 0.3, 0.0, 1.0);
  let to_c = to_color(in.uv);
  // The sheet tears into streaks along each row, blown downwind; a streak
  // survives while its noise is above t.
  let streak = value_noise(vec2f((in.uv.x - sx * t * 0.6) * 7.0, row * 0.45)) * 0.75 + hash11(row) * 0.25;
  if (streak < t) {
    return to_c;
  }
  let src = vec2f(in.uv.x - sx * t * t * 0.35, in.uv.y);
  if (!inside(src)) {
    return to_c;
  }
  let edge = select(1.0, smoothstep(t, t + 0.08, streak), t > 0.0);
  return vec4f(mix(to_c.rgb, from_color(src).rgb, edge), 1.0);
}
