// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
// #include "_curl.wgsl"
//
// p15:prstTrans prst="pageCurlDouble" — the slide parts at its centre line
// and both halves curl back outwards from it, each rolling off over its
// outer edge (invX lets the right half lead; invY tilts the curls the other
// way).
// params: invX (slot 0), invY (slot 1).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let sy = select(1.0, -1.0, param(1u) > 0.5);
  let lead = select(0.0, 0.08, param(0u) > 0.5);
  let r = 0.09;
  // Each half's seam edge lies furthest along its axis, so it lifts first
  // and the turned-over part rolls outwards, off the slide.
  let al = normalize(vec2f(1.0, 0.22 * sy));
  let ar = normalize(vec2f(-1.0, 0.22 * sy));
  let lo_l = vec2f(0.0, 0.0);
  let hi_l = vec2f(0.5, 1.0);
  let lo_r = vec2f(0.5, 0.0);
  let hi_r = vec2f(1.0, 1.0);
  let pl = clamp(p * (1.0 + 0.08) - lead, 0.0, 1.0);
  let pr = clamp(p * (1.0 + 0.08) - (0.08 - lead), 0.0, 1.0);
  let xl = curl_line(pl, al, lo_l, hi_l, r);
  let xr = curl_line(pr, ar, lo_r, hi_r, r);
  let hl = page_curl(in.uv, al, xl, r, lo_l, hi_l);
  let hr = page_curl(in.uv, ar, xr, r, lo_r, hi_r);
  if (hl.hit && (!hr.hit || hl.z >= hr.z)) {
    return hl.color;
  }
  if (hr.hit) {
    return hr.color;
  }
  let shadow_side = in.uv.x < 0.5;
  if (shadow_side) {
    return under_curl(in.uv, al, xl, r, p);
  }
  return under_curl(in.uv, ar, xr, r, p);
}
