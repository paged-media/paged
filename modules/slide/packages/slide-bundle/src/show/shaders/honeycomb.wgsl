// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:honeycomb — the outgoing slide breaks into hexagons that shrink away
// from the centre outwards, uncovering the incoming slide. 2.5D: the cells
// shrink and darken (PowerPoint flips them in 3D).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let scale = 7.0;
  let q = to_centered(in.uv) * scale;
  let c = hex_center(q);
  let far = length(vec2f(ratio() * 0.5, 0.5)) * scale;
  let delay = clamp(length(c) / far, 0.0, 1.0) * 0.45 + hash21(c) * 0.25;
  let lp = clamp((u.progress - delay) / 0.3, 0.0, 1.0);
  if (lp <= 0.0) {
    return from_color(in.uv);
  }
  if (lp >= 1.0) {
    return to_color(in.uv);
  }
  let k = 1.0 - lp;
  let local = (q - c) / k;
  if (hex_dist(local) > 0.5) {
    return to_color(in.uv);
  }
  let src = from_centered((c + local) / scale);
  let edge = smoothstep(0.42, 0.5, hex_dist(local));
  return vec4f(from_color(src).rgb * (1.0 - 0.5 * lp) * (1.0 - 0.35 * edge * lp), 1.0);
}
