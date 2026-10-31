// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:prism — the slides sit on two faces of a cube that turns in `dir`;
// isInverted views the cube from inside. (isContent, turning only the
// slide's content, is drawn as the whole slide.)
// params: inverted (slot 0). directions: l r u d.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

// Rotate a cube-relative point about the vertical axis.
fn spin(v: vec3f, c: f32, s: f32, k: f32) -> vec3f {
  return vec3f(v.x * c + k * v.z * s, v.y, -k * v.x * s + v.z * c);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let vertical = u.direction == DIR_U || u.direction == DIR_D;
  let sgn = select(1.0, -1.0, u.direction == DIR_R || u.direction == DIR_D);
  let k = select(1.0, -1.0, param(0u) > 0.5);
  var scr = to_centered(in.uv);
  var w = ratio();
  var h = 1.0;
  if (vertical) {
    scr = scr.yx;
    w = 1.0;
    h = ratio();
  }
  let theta = sgn * u.progress * PI * 0.5;
  let c = cos(theta);
  let s = sin(theta);
  let center = vec3f(0.0, 0.0, k * w * 0.5);
  // Front face: the outgoing slide.
  let fo = spin(vec3f(-w * 0.5, -h * 0.5, -k * w * 0.5), c, s, k) + center;
  let fe = spin(vec3f(w, 0.0, 0.0), c, s, k);
  let front = plane_hit(scr, fo, fe, vec3f(0.0, h, 0.0));
  // Side face: the incoming slide, on the side the cube turns towards.
  let so = spin(vec3f(sgn * w * 0.5, -h * 0.5, -k * w * 0.5), c, s, k) + center;
  let se = spin(vec3f(0.0, 0.0, k * w), c, s, k);
  let side = plane_hit(scr, so, se, vec3f(0.0, h, 0.0));
  let hf = front.w > 0.5;
  let hs = side.w > 0.5;
  if (!hf && !hs) {
    return BG;
  }
  let use_side = hs && (!hf || side.z < front.z);
  var st = select(front.xy, side.xy, use_side);
  if (use_side && sgn < 0.0) {
    st.x = 1.0 - st.x;
  }
  var uv = st;
  if (vertical) {
    uv = st.yx;
  }
  let shade = select(facing(theta), facing(PI * 0.5 - abs(theta)), use_side);
  let col = select(from_color(uv), to_color(uv), use_side);
  return vec4f(col.rgb * shade, 1.0);
}
