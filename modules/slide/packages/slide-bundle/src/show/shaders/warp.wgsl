// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:warp — dir in: the outgoing slide twists and is drawn into the
// centre while the incoming one untwists out of it; dir out: the reverse.
// directions: in out.

fn twist(q: vec2f, amount: f32) -> vec2f {
  let r = length(q);
  return rot2(amount * max(0.0, 1.0 - r * 1.4)) * q;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let q = to_centered(in.uv);
  let into = u.direction != DIR_OUT;
  let kf = select(1.0 + p * 1.5, 1.0 - p * 0.6, into);
  let kt = select(1.0 - (1.0 - p) * 0.4, 1.0 + (1.0 - p) * 2.0, into);
  let sf = from_centered(twist(q, p * 7.0) * kf);
  let st = from_centered(twist(q, -(1.0 - p) * 7.0) * kt);
  let fc = select(vec4f(0.0, 0.0, 0.0, 1.0), from_color(sf), inside(sf));
  let tc = select(vec4f(0.0, 0.0, 0.0, 1.0), to_color(st), inside(st));
  return mix(fc, tc, smoothstep(0.15, 0.85, p));
}
