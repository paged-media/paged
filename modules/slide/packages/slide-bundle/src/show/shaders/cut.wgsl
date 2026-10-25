// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:cut — the incoming slide replaces the outgoing one at once; with
// thruBlk, a black frame sits between them.
// params: thruBlack (slot 0).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  if (p <= 0.0) {
    return from_color(in.uv);
  }
  if (p >= 1.0) {
    return to_color(in.uv);
  }
  if (param(0u) > 0.5) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (p < 0.5) {
    return from_color(in.uv);
  }
  return to_color(in.uv);
}
