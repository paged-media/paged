// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="drape" — the outgoing slide drops away like cloth,
// rippling as it falls, uncovering the incoming slide. 2.5D approximation.
// params: invX (slot 0) mirrors the ripple.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let sx = select(1.0, -1.0, param(0u) > 0.5);
  let fall = p * p * 1.08;
  // The cloth's lower part leads; its folds deepen as it falls.
  let sag = fall * (0.7 + 0.3 * in.uv.y);
  let fold = sin((in.uv.x * sx) * 26.0 + p * 6.0) * 0.025 * sin(p * PI);
  let src = vec2f(in.uv.x + fold * 0.4, in.uv.y - sag + fold);
  if (!inside(src)) {
    return to_color(in.uv);
  }
  let shade = 1.0 - 0.4 * sin(p * PI) * (0.5 + 0.5 * sin((in.uv.x * sx) * 26.0 + p * 6.0));
  return vec4f(from_color(src).rgb * shade, 1.0);
}
