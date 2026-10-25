// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:flythrough — dir in: the outgoing slide flies past the viewer while
// the incoming one flies in from the distance (dir out: the reverse);
// hasBounce overshoots on arrival. Pass 1 of 2 (flythrough_blur adds the
// motion blur). params: bounce (slot 0). directions: in out.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let q = to_centered(in.uv);
  let into = u.direction != DIR_OUT;
  var kf = select(1.0 - 0.75 * p, 1.0 + 2.5 * p, into);
  var kt = select(3.5 - 2.5 * p, 0.25 + 0.75 * p, into);
  if (param(0u) > 0.5) {
    kt = kt + 0.18 * sin(p * PI) * p;
  }
  let af = 1.0 - smoothstep(0.0, 0.65, p);
  let at = smoothstep(0.2, 1.0, p);
  let sf = from_centered(q / kf);
  let st = from_centered(q / kt);
  let fc = select(BG, from_color(sf), inside(sf));
  let tc = select(BG, to_color(st), inside(st));
  let under = mix(BG, tc, at);
  return mix(under, fc, af);
}
