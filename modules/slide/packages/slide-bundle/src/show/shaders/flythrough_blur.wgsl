// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:flythrough, pass 2 of 2: a radial zoom blur over pass 1's frame,
// strongest mid-way. In a second pass `from_tex` is the previous pass's
// output (the renderer's ping-pong texture); `to_tex` is the incoming slide.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let strength = sin(u.progress * PI) * 0.09;
  if (strength <= 1e-4) {
    return from_color(in.uv);
  }
  // Eight taps towards the centre, written out (Tint's loop guards keep a
  // loop from being unrolled on Metal).
  let step = (vec2f(0.5) - in.uv) * strength / 7.0;
  var acc = from_color(in.uv);
  acc = acc + from_color(in.uv + step);
  acc = acc + from_color(in.uv + step * 2.0);
  acc = acc + from_color(in.uv + step * 3.0);
  acc = acc + from_color(in.uv + step * 4.0);
  acc = acc + from_color(in.uv + step * 5.0);
  acc = acc + from_color(in.uv + step * 6.0);
  acc = acc + from_color(in.uv + step * 7.0);
  return opaque(acc / 8.0);
}
