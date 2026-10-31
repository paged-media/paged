// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
//
// The shared vertex stage: one triangle that covers the viewport, drawn
// with `draw(3)` and no vertex buffer. `uv` is texture space (y down).
// The loader appends it after the prelude, so it uses the prelude's VsOut.

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VsOut;
  out.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}
