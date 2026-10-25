// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:wedge — a wedge opens from the top, sweeping both ways round to the
// bottom.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let q = to_centered(in.uv);
  let s = abs(atan2(q.x, -q.y)) / PI;
  return mix(from_color(in.uv), to_color(in.uv), reveal(s, u.progress, 0.02));
}
