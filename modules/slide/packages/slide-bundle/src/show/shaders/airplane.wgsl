// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="airplane" — the outgoing slide folds into a paper
// dart and flies off to the upper right (invX: upper left). 2.5D
// approximation: the fold is a narrowing dart shape with shaded flaps.
// params: invX (slot 0).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let sx = select(1.0, -1.0, param(0u) > 0.5);
  let w = ratio();
  let fold = clamp(p / 0.45, 0.0, 1.0);
  let fly = clamp((p - 0.45) / 0.55, 0.0, 1.0);
  let flyease = fly * fly;
  // Undo the flight: translate, rotate, scale.
  var q = to_centered(in.uv);
  q = q - vec2f(sx * flyease * (w * 0.5 + 0.9), -flyease * 1.2);
  q = rot2(-sx * fly * 0.7) * q;
  let k = 1.0 - 0.8 * flyease;
  if (k <= 1e-3) {
    return to_color(in.uv);
  }
  q = q / k;
  // The dart: at height y (top -0.5, nose) the half width narrows to
  // (y + 0.5) of the page's as the fold closes.
  let narrow = mix(1.0, clamp(q.y + 0.5, 0.0, 1.0) * 0.55 + 0.05, fold);
  let hw = w * 0.5 * narrow;
  if (abs(q.x) > hw || abs(q.y) > 0.5) {
    return to_color(in.uv);
  }
  let src = from_centered(vec2f(q.x / narrow, q.y));
  // The flaps: the outer part of each side, folded under, darker.
  let flap = smoothstep(0.35, 0.9, abs(q.x) / max(hw, 1e-4)) * fold;
  let crease = 1.0 - 0.35 * fold * (1.0 - smoothstep(0.0, 0.04, abs(q.x)));
  let col = from_color(src).rgb * (1.0 - 0.35 * flap) * crease;
  return vec4f(col, 1.0);
}
