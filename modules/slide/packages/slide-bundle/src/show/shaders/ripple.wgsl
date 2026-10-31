// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:ripple — rings spread from the centre (or a corner) and carry the
// incoming slide out with them. directions: center lu ru ld rd.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  var origin = vec2f(0.5);
  var far = length(vec2f(ratio() * 0.5, 0.5));
  switch u.direction {
    case 5u: { origin = vec2f(0.0, 0.0); far = length(vec2f(ratio(), 1.0)); }
    case 6u: { origin = vec2f(1.0, 0.0); far = length(vec2f(ratio(), 1.0)); }
    case 7u: { origin = vec2f(0.0, 1.0); far = length(vec2f(ratio(), 1.0)); }
    case 8u: { origin = vec2f(1.0, 1.0); far = length(vec2f(ratio(), 1.0)); }
    default: {}
  }
  let q = to_centered(in.uv);
  let rel = q - to_centered(origin);
  let dist = length(rel);
  let amp = sin(p * PI) * 0.025;
  let wave = sin(dist * 45.0 - p * 40.0) * amp;
  let n = rel / max(dist, 1e-5);
  let src = from_centered(q + n * wave);
  let t = reveal(dist / far, p, 0.35);
  return mix(from_color(src), to_color(src), t);
}
