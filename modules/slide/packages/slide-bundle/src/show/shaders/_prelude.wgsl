// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
//
// The shared prelude of every slide transition (slide ADR 721). It declares
// the ONLY bindings a transition may use, the uniform block, the vertex
// output, and the helpers the transitions share. A transition file starts
// with `// #include "_prelude.wgsl"` and declares nothing at @group/@binding
// itself: the loader prepends this file, and a unit test rejects a shader
// that redeclares a binding.
//
// Conventions:
// - `uv` is texture space: (0, 0) top left, (1, 1) bottom right, y down.
// - `u.progress` runs 0 → 1. At 0 a transition shows `from` exactly; at 1 it
//   shows `to` exactly (the golden-frame test asserts both).
// - `u.direction` is the PowerPoint `dir` as a code (DIR_* below). Motion
//   vectors from `dir_vec` point the way the content MOVES: `dir="l"` moves
//   leftwards, so the incoming slide enters from the right.
// - `u.params` holds eight named numbers; manifest.json gives each shader's
//   names, slots and defaults. `param(i)` reads slot i.

struct Uniforms {
  progress: f32,
  time: f32,
  resolution: vec2f,
  direction: u32,
  params: array<vec4f, 2>,
};

@group(0) @binding(0) var u_sampler: sampler;
@group(0) @binding(1) var from_tex: texture_2d<f32>;
@group(0) @binding(2) var to_tex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: Uniforms;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

const DIR_NONE: u32 = 0u;
const DIR_L: u32 = 1u;
const DIR_R: u32 = 2u;
const DIR_U: u32 = 3u;
const DIR_D: u32 = 4u;
const DIR_LU: u32 = 5u;
const DIR_RU: u32 = 6u;
const DIR_LD: u32 = 7u;
const DIR_RD: u32 = 8u;
const DIR_HORZ: u32 = 9u;
const DIR_VERT: u32 = 10u;
const DIR_IN: u32 = 11u;
const DIR_OUT: u32 = 12u;
const DIR_CENTER: u32 = 13u;

fn param(i: u32) -> f32 {
  return u.params[i / 4u][i % 4u];
}

// Explicit-LOD sampling: legal in non-uniform control flow, which most
// transitions have.
fn from_color(uv: vec2f) -> vec4f {
  return textureSampleLevel(from_tex, u_sampler, uv, 0.0);
}

fn to_color(uv: vec2f) -> vec4f {
  return textureSampleLevel(to_tex, u_sampler, uv, 0.0);
}

fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}

fn ratio() -> f32 {
  return u.resolution.x / max(u.resolution.y, 1.0);
}

// The motion vector of a side or corner direction (screen space, y down).
fn dir_vec(d: u32) -> vec2f {
  switch d {
    case 1u: { return vec2f(-1.0, 0.0); }
    case 2u: { return vec2f(1.0, 0.0); }
    case 3u: { return vec2f(0.0, -1.0); }
    case 4u: { return vec2f(0.0, 1.0); }
    case 5u: { return vec2f(-1.0, -1.0); }
    case 6u: { return vec2f(1.0, -1.0); }
    case 7u: { return vec2f(-1.0, 1.0); }
    case 8u: { return vec2f(1.0, 1.0); }
    default: { return vec2f(-1.0, 0.0); }
  }
}

// How far `uv` lies along a motion, 0 where the motion starts and 1 where it
// ends: for `dir="l"` that is 1 - x (the right edge is reached first).
fn along(uv: vec2f, d: vec2f) -> f32 {
  let a = abs(d.x) + abs(d.y);
  return (dot(uv - vec2f(0.5), d) / a) + 0.5;
}

// The amount of `to` at a point whose reveal coordinate is `s` (0..1): a
// soft edge of width `w` that has not started at p = 0 and has passed every
// s <= 1 at p = 1.
fn reveal(s: f32, p: f32, w: f32) -> f32 {
  let e = p * (1.0 + w);
  return 1.0 - smoothstep(e - w, e, s);
}

// Hard reveal: `to` where s < p (p = 1 covers every s < 1).
fn reveal_hard(s: f32, p: f32) -> f32 {
  return select(0.0, 1.0, s < p);
}

// Hashes in [0, 1). Plain float arithmetic: no transcendental (Dawn
// compiles Metal without fast math, so sin is slow, and sin-based hashes
// lose precision on large arguments) and no integer multiplies (which
// measured three times slower per call on Apple GPUs). The input is rounded
// to quarter units first, so a cell centre computed with rounding noise
// hashes the same everywhere in the cell. Results stay below 1, so a reveal
// by `hash < p` covers everything at p = 1.
fn fhash(k: vec2f) -> f32 {
  let a = fract(k * vec2f(0.1031, 0.1137));
  let b = a + dot(a, a.yx + 19.27);
  return min(fract(b.x * b.y * 3.17 + b.x), 0.99999);
}

fn hash11(n: f32) -> f32 {
  return fhash(vec2f(round(n * 4.0), 7.0));
}

fn hash21(q: vec2f) -> f32 {
  return fhash(round(q * 4.0));
}

fn hash22(q: vec2f) -> vec2f {
  let k = round(q * 4.0);
  return vec2f(fhash(k), fhash(k + vec2f(41.0, 17.0)));
}

// Smooth value noise over the integer lattice.
fn value_noise(q: vec2f) -> f32 {
  let i = floor(q);
  let f = fract(q);
  let s = f * f * (3.0 - 2.0 * f);
  let a = fhash(i);
  let b = fhash(i + vec2f(1.0, 0.0));
  let c = fhash(i + vec2f(0.0, 1.0));
  let d = fhash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// Pointy-top hexagons of unit width: the centre of the cell `q` lies in
// (hex units), and the distance that is 0.5 on a cell's border.
fn hex_center(q: vec2f) -> vec2f {
  let r = vec2f(1.0, 1.7320508);
  let h = r * 0.5;
  let a = q - r * floor(q / r) - h;
  let b = (q - h) - r * floor((q - h) / r) - h;
  let local = select(b, a, dot(a, a) < dot(b, b));
  return q - local;
}

fn hex_dist(v: vec2f) -> f32 {
  let a = abs(v);
  return max(dot(a, vec2f(0.5, 0.8660254)), a.x);
}

fn rot2(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

// Centered, aspect-correct coordinates: x in [-ratio/2, ratio/2], y in
// [-0.5, 0.5] (y down), and back.
fn to_centered(uv: vec2f) -> vec2f {
  return vec2f((uv.x - 0.5) * ratio(), uv.y - 0.5);
}

fn from_centered(q: vec2f) -> vec2f {
  return vec2f(q.x / ratio() + 0.5, q.y + 0.5);
}

// --- 2.5D: a ray from a pinhole camera against a textured rectangle. ------
//
// The camera sits at (0, 0, -CAM_D) looking down +z; the screen is the plane
// z = 0 in centered coordinates, so a rectangle at z = 0 with origin
// (-ratio/2, -0.5, 0), e1 = (ratio, 0, 0) and e2 = (0, 1, 0) maps to the
// screen exactly (progress 0 and 1 stay pixel exact).
const CAM_D: f32 = 2.0;

// Hit of the screen point `scr` (centered coordinates) on the rectangle
// origin + s*e1 + t*e2, s and t in [0, 1]. Returns (s, t, depth, hit) with
// hit = 1 when the ray meets the rectangle in front of the camera.
fn plane_hit(scr: vec2f, origin: vec3f, e1: vec3f, e2: vec3f) -> vec4f {
  let cam = vec3f(0.0, 0.0, -CAM_D);
  let dir = vec3f(scr, CAM_D);
  // Solve origin + s*e1 + t*e2 = cam + l*dir  ->  [e1 e2 -dir][s t l] = cam - origin.
  let m = mat3x3f(e1, e2, -dir);
  let det = determinant(m);
  if (abs(det) < 1e-7) {
    return vec4f(0.0, 0.0, 1e9, 0.0);
  }
  let r = cam - origin;
  let s = determinant(mat3x3f(r, e2, -dir)) / det;
  let t = determinant(mat3x3f(e1, r, -dir)) / det;
  let l = determinant(mat3x3f(e1, e2, r)) / det;
  let ok = l > 0.0 && s >= 0.0 && s <= 1.0 && t >= 0.0 && t <= 1.0;
  return vec4f(s, t, l, select(0.0, 1.0, ok));
}

// The full-screen rectangle rotated by `angle` about a vertical axis through
// x = `pivot_x` (centered units) at depth `z`, then shifted by `offset`.
// Returns plane_hit for it.
fn card_y(scr: vec2f, angle: f32, pivot_x: f32, z: f32, offset: vec3f) -> vec4f {
  let w = ratio();
  let c = cos(angle);
  let s = sin(angle);
  let e1 = vec3f(w * c, 0.0, w * s);
  let left = -w * 0.5 - pivot_x;
  let origin = vec3f(pivot_x + left * c, -0.5, z + left * s) + offset;
  return plane_hit(scr, origin, e1, vec3f(0.0, 1.0, 0.0));
}

// The same about a horizontal axis through y = `pivot_y`.
fn card_x(scr: vec2f, angle: f32, pivot_y: f32, z: f32, offset: vec3f) -> vec4f {
  let w = ratio();
  let c = cos(angle);
  let s = sin(angle);
  let e2 = vec3f(0.0, c, s);
  let top = -0.5 - pivot_y;
  let origin = vec3f(-w * 0.5, pivot_y + top * c, z + top * s) + offset;
  return plane_hit(scr, origin, vec3f(w, 0.0, 0.0), e2);
}

// Simple diffuse shading of a rotated card (1 when it faces the camera).
fn facing(angle: f32) -> f32 {
  return mix(0.55, 1.0, abs(cos(angle)));
}

fn opaque(c: vec4f) -> vec4f {
  return vec4f(c.rgb, 1.0);
}
