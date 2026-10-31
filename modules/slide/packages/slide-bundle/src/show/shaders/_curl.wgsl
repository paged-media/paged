// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
//
// A page curling over a cylinder, shared by pageCurlSingle, pageCurlDouble
// and peelOff (`// #include "_curl.wgsl"` after the prelude). It declares no
// bindings.
//
// The page is the rectangle [lo, hi] of the outgoing slide (uv). It curls
// along `axis` (centered units, unit length): the edge that lies furthest
// along `axis` lifts first, the curl line sits at `xc` (along the axis) and
// the cylinder has radius `r`. A page point at distance a = x0 - xc past the
// line wraps onto the cylinder (a < PI r) or lies flat on top, face down.

struct CurlHit {
  color: vec4f,
  z: f32,
  hit: bool,
};

fn in_rect(uv: vec2f, lo: vec2f, hi: vec2f) -> bool {
  return all(uv >= lo) && all(uv <= hi);
}

// (min, max) of the page rectangle's extent along `axis`.
fn curl_extent(axis: vec2f, lo: vec2f, hi: vec2f) -> vec2f {
  let a = dot(to_centered(lo), axis);
  let b = dot(to_centered(vec2f(hi.x, lo.y)), axis);
  let c = dot(to_centered(vec2f(lo.x, hi.y)), axis);
  let d = dot(to_centered(hi), axis);
  return vec2f(min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
}

// The curl line for progress p: just past the page at 0, far enough at 1
// that the whole page has gone over.
fn curl_line(p: f32, axis: vec2f, lo: vec2f, hi: vec2f, r: f32) -> f32 {
  let e = curl_extent(axis, lo, hi);
  return mix(e.y + 0.001, e.x - r - 0.01, p);
}

// Paper seen from the back: the slide shows through, lighter.
fn paper_back(c: vec4f) -> vec4f {
  return vec4f(mix(c.rgb, vec3f(0.94), 0.6), 1.0);
}

fn page_curl(uv: vec2f, axis: vec2f, xc: f32, r: f32, lo: vec2f, hi: vec2f) -> CurlHit {
  let q = to_centered(uv);
  let x = dot(q, axis);
  let d = x - xc;
  // 1. The part that has gone right over, lying face down on top.
  if (d <= 0.0) {
    let x0 = xc + PI * r - d;
    let src = from_centered(q + (x0 - x) * axis);
    if (in_rect(src, lo, hi)) {
      return CurlHit(paper_back(from_color(src)), 2.0 * r, true);
    }
  }
  if (d >= 0.0 && d <= r) {
    // 2. The upper half of the cylinder (the page's back).
    let phi_back = PI - asin(clamp(d / r, 0.0, 1.0));
    let xb = xc + r * phi_back;
    let sb = from_centered(q + (xb - x) * axis);
    if (in_rect(sb, lo, hi)) {
      let shade = mix(0.75, 1.0, sin(phi_back));
      return CurlHit(vec4f(paper_back(from_color(sb)).rgb * shade, 1.0), r * (1.0 - cos(phi_back)), true);
    }
    // 3. The lower half (the page's face, turning away).
    let phi = asin(clamp(d / r, 0.0, 1.0));
    let xf = xc + r * phi;
    let sf = from_centered(q + (xf - x) * axis);
    if (in_rect(sf, lo, hi)) {
      let shade = mix(1.0, 0.65, phi / (PI * 0.5));
      return CurlHit(vec4f(from_color(sf).rgb * shade, 1.0), r * (1.0 - cos(phi)), true);
    }
  }
  // 4. The flat page not yet reached by the curl.
  if (d <= 0.0 && in_rect(uv, lo, hi)) {
    return CurlHit(from_color(uv), 0.0, true);
  }
  return CurlHit(vec4f(0.0), -1.0, false);
}

// The incoming slide under the curl, with the curl's shadow on it.
fn under_curl(uv: vec2f, axis: vec2f, xc: f32, r: f32, p: f32) -> vec4f {
  let d = dot(to_centered(uv), axis) - xc;
  let fade = 1.0 - smoothstep(0.85, 1.0, p);
  let shadow = (1.0 - smoothstep(0.0, r * 2.5, d)) * 0.35 * fade * select(0.0, 1.0, d >= 0.0);
  let c = to_color(uv);
  return vec4f(c.rgb * (1.0 - shadow), 1.0);
}
