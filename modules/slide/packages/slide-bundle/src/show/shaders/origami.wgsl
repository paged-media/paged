// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="origami" — the outgoing slide is folded in half, then
// in half again, and the folded square flies away, uncovering the incoming
// slide. 2.5D approximation of PowerPoint's folds: two true hinged folds in
// perspective, then a flat flight.

fn paper_back(c: vec4f) -> vec4f {
  return vec4f(mix(c.rgb, vec3f(0.94), 0.6), 1.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let w = ratio();
  let scr = to_centered(in.uv);
  let ta = clamp(p / 0.4, 0.0, 1.0);
  let tb = clamp((p - 0.4) / 0.3, 0.0, 1.0);
  let tc = clamp((p - 0.7) / 0.3, 0.0, 1.0);
  if (tb <= 0.0) {
    // Fold 1: the right half turns over onto the left about the centre line.
    let theta = ta * PI;
    let c = cos(theta);
    let s = sin(theta);
    let flap = plane_hit(scr, vec3f(0.0, -0.5, 0.0), vec3f(w * 0.5 * c, 0.0, -w * 0.5 * s), vec3f(0.0, 1.0, 0.0));
    if (flap.w > 0.5) {
      let uv = vec2f(0.5 + flap.x * 0.5, flap.y);
      let shade = facing(theta);
      if (c >= 0.0) {
        return vec4f(from_color(uv).rgb * shade, 1.0);
      }
      return vec4f(paper_back(from_color(uv)).rgb * shade, 1.0);
    }
    if (in.uv.x < 0.5) {
      return from_color(in.uv);
    }
    return to_color(in.uv);
  }
  if (tc <= 0.0) {
    // Fold 2: the folded half's lower part turns up over its upper part.
    let phi = tb * PI;
    let c = cos(phi);
    let s = sin(phi);
    let piece = plane_hit(scr, vec3f(-w * 0.5, 0.0, 0.0), vec3f(w * 0.5, 0.0, 0.0), vec3f(0.0, 0.5 * c, -0.5 * s));
    if (piece.w > 0.5) {
      let x = -w * 0.5 + piece.x * w * 0.5;
      let v = piece.y * 0.5 + 0.5;
      let shade = facing(phi);
      if (c >= 0.0) {
        return vec4f(paper_back(from_color(vec2f(0.5 - x / w, v))).rgb * shade, 1.0);
      }
      return vec4f(from_color(vec2f(x / w + 0.5, v)).rgb * shade, 1.0);
    }
    if (in.uv.x < 0.5 && in.uv.y < 0.5) {
      return paper_back(from_color(vec2f(1.0 - in.uv.x, in.uv.y)));
    }
    return to_color(in.uv);
  }
  // The folded quarter flies off to the upper left.
  let fly = tc * tc;
  let k = 1.0 - 0.9 * fly;
  var q = in.uv - vec2f(0.25, 0.25);
  q = q + vec2f(fly * 0.9, fly * 0.9);
  q = rot2(fly * 1.2) * q / k + vec2f(0.25, 0.25);
  if (all(q >= vec2f(0.0)) && all(q <= vec2f(0.5))) {
    return from_color(vec2f(q.x, 1.0 - q.y));
  }
  return to_color(in.uv);
}
