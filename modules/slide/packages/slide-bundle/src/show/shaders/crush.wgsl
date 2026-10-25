// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="crush" — the outgoing slide is crumpled into a ball
// that shrinks away, uncovering the incoming slide. 2.5D approximation:
// noise creases instead of a folded sheet.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let k = 1.0 - p;
  if (k <= 1e-3) {
    return to_color(in.uv);
  }
  let c = to_centered(in.uv);
  let q = c / k;
  let amount = p * 0.22;
  // Noise in screen space: as the ball shrinks, neighbouring pixels still
  // read neighbouring texels (noise in sheet space would scatter the reads).
  let n0 = value_noise(c * 9.0);
  let n = vec2f(n0, fract(n0 * 7.31 + 0.5)) - vec2f(0.5);
  let r = length(q);
  // The sheet pulls in towards a ball as it crumples.
  let pull = 1.0 + p * 1.2 * smoothstep(0.0, 0.9, r);
  let src_q = q * pull + n * amount;
  let src = from_centered(src_q);
  if (!inside(src)) {
    return to_color(in.uv);
  }
  let crease = abs(fract(n0 * 3.7) - 0.5) * 2.0;
  let shade = 1.0 - p * 0.45 * crease;
  return vec4f(from_color(src).rgb * shade, 1.0);
}
