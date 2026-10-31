// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:flash — a white flash between the slides.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let base = mix(from_color(in.uv), to_color(in.uv), smoothstep(0.4, 0.6, p));
  let x = (p - 0.5) * 5.0;
  let w = exp(-x * x) * sin(p * PI);
  return mix(base, vec4f(1.0), clamp(w, 0.0, 1.0));
}
