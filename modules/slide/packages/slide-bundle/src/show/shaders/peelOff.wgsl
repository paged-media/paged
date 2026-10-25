// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
// #include "_curl.wgsl"
//
// p15:prstTrans prst="peelOff" — the slide peels off from its bottom right
// corner like a sticker, in a tight curl (invX: from the left; invY: from
// the top). params: invX (slot 0), invY (slot 1).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let sx = select(1.0, -1.0, param(0u) > 0.5);
  let sy = select(1.0, -1.0, param(1u) > 0.5);
  let axis = normalize(vec2f(sx, sy));
  let r = 0.05;
  let lo = vec2f(0.0);
  let hi = vec2f(1.0);
  let ease = u.progress * u.progress * (3.0 - 2.0 * u.progress);
  let xc = curl_line(ease, axis, lo, hi, r);
  let h = page_curl(in.uv, axis, xc, r, lo, hi);
  if (h.hit) {
    return h.color;
  }
  return under_curl(in.uv, axis, xc, r, u.progress);
}
