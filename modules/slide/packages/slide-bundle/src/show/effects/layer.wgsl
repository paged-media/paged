// The animation layer compositor (slide ADR 714): one slide layer (the
// background, an animated shape, a paragraph of one, a run of static items)
// drawn as a textured quad onto the slide, moved by the animation's affine
// map, faded by its opacity, recoloured by a colour effect, and cut by up to
// two of PowerPoint's animation filters (`p:animEffect filter`): fade, wipe,
// barn, blinds, box, checkerboard, circle, diamond, dissolve, plus,
// randombar, slide, strips, wedge, wheel(n).
//
// A single-input effect: one texture, one sampler, one uniform block, as the
// transition library's prelude declares for two (ADR 721); the direction
// and reveal conventions are the transition library's: a filter's reveal
// coordinate s runs 0..1 across the layer's box and the point shows while
// s < progress. Each filter is laid out in its own box (the shape's, or the
// paragraph's), in page points, before the layer moves, so the cut moves
// with it.

struct Layer {
  // Page pt -> page pt: (a, b, c, d) and (e, f, 0, 0).
  m0: vec4f,
  m1: vec4f,
  // The page region the texture covers: x, y, w, h (pt).
  region: vec4f,
  // The slide: w, h (pt); the output's pixel size.
  view: vec4f,
  // opacity, tint amount, unused, seed.
  look: vec4f,
  // Tint colour (straight RGB).
  tint: vec4f,
  // Filter 0 and 1: (kind, sub, progress, out) and its box (x, y, w, h).
  f0: vec4f,
  b0: vec4f,
  f1: vec4f,
  b1: vec4f,
};

@group(0) @binding(0) var l_sampler: sampler;
@group(0) @binding(1) var l_tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> L: Layer;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) page: vec2f,
};

const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

// Filter kinds (FILTER_CODES in effects/index.ts).
const F_NONE: u32 = 0u;
const F_FADE: u32 = 1u;
const F_WIPE: u32 = 2u;
const F_BARN: u32 = 3u;
const F_BLINDS: u32 = 4u;
const F_BOX: u32 = 5u;
const F_CHECKER: u32 = 6u;
const F_CIRCLE: u32 = 7u;
const F_DIAMOND: u32 = 8u;
const F_DISSOLVE: u32 = 9u;
const F_PLUS: u32 = 10u;
const F_RANDOMBAR: u32 = 11u;
const F_SLIDE: u32 = 12u;
const F_STRIPS: u32 = 13u;
const F_WEDGE: u32 = 14u;
const F_WHEEL: u32 = 15u;

@vertex
fn vs_layer(@builtin(vertex_index) i: u32) -> VsOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let uv = corners[i];
  let p = L.region.xy + uv * L.region.zw;
  let q = vec2f(
    L.m0.x * p.x + L.m0.z * p.y + L.m1.x,
    L.m0.y * p.x + L.m0.w * p.y + L.m1.y,
  );
  var out: VsOut;
  out.pos = vec4f(q.x / L.view.x * 2.0 - 1.0, 1.0 - q.y / L.view.y * 2.0, 0.0, 1.0);
  out.uv = uv;
  out.page = p;
  return out;
}

// Hash in [0, 1), the transition prelude's (rounded input, no sin).
fn fhash(k: vec2f) -> f32 {
  let a = fract(k * vec2f(0.1031, 0.1137));
  let b = a + dot(a, a.yx + 19.27);
  return min(fract(b.x * b.y * 3.17 + b.x), 0.99999);
}

fn shows(s: f32, p: f32) -> f32 {
  return select(0.0, 1.0, s < p);
}

// How much of the point (box coordinates u, 0..1) filter `f` shows at its
// progress, before `out` turns it round. `box` gives the cell sizes in pt.
fn filter_amount(f: vec4f, u: vec2f, box: vec4f) -> f32 {
  let kind = u32(f.x);
  let sub = u32(f.y);
  let p = clamp(f.z, 0.0, 1.0);
  let c = u - vec2f(0.5);
  switch kind {
    case 1u: {
      // fade: the opacity.
      return p;
    }
    case 2u: {
      // wipe(left|right|up|down): from that side.
      var s = u.x;
      if (sub == 2u) { s = 1.0 - u.x; }
      if (sub == 3u) { s = u.y; }
      if (sub == 4u) { s = 1.0 - u.y; }
      return shows(s, p);
    }
    case 3u: {
      // barn(inVertical|inHorizontal|outVertical|outHorizontal).
      var d = abs(c.x) * 2.0;
      if (sub == 2u || sub == 4u) { d = abs(c.y) * 2.0; }
      if (sub <= 2u) { return shows(1.0 - d, p); }
      return shows(d, p);
    }
    case 4u: {
      // blinds(horizontal|vertical): six slats.
      var s = fract(u.y * 6.0);
      if (sub == 2u) { s = fract(u.x * 6.0); }
      return shows(s, p);
    }
    case 5u: {
      // box(in|out).
      let d = max(abs(c.x), abs(c.y)) * 2.0;
      if (sub == 1u) { return shows(1.0 - d, p); }
      return shows(d, p);
    }
    case 6u: {
      // checkerboard(across|down): eight cells a side, rows offset by one.
      let n = 8.0;
      var along = u.x;
      var across = u.y;
      if (sub == 2u) { along = u.y; across = u.x; }
      let row = floor(across * n);
      let k = along * n + select(0.0, 1.0, (row % 2.0) >= 1.0);
      return shows(fract(k * 0.5), p);
    }
    case 7u: {
      // circle(in|out).
      let d = length(c * 2.0) / 1.41421356;
      if (sub == 1u) { return shows(1.0 - d, p); }
      return shows(d, p);
    }
    case 8u: {
      // diamond(in|out).
      let d = (abs(c.x) + abs(c.y));
      if (sub == 1u) { return shows(1.0 - d, p); }
      return shows(d, p);
    }
    case 9u: {
      // dissolve: squares of about 4 pt.
      let cell = floor(u * max(box.zw / 4.0, vec2f(1.0)));
      return shows(fhash(cell + vec2f(L.look.w, 0.0)), p);
    }
    case 10u: {
      // plus(in|out).
      let d = min(abs(c.x), abs(c.y)) * 2.0;
      if (sub == 1u) { return shows(1.0 - d, p); }
      return shows(d, p);
    }
    case 11u: {
      // randombar(horizontal|vertical): lines about 1.5 pt.
      var line = floor(u.y * max(box.w / 1.5, 1.0));
      if (sub == 2u) { line = floor(u.x * max(box.z / 1.5, 1.0)); }
      return shows(fhash(vec2f(line, 3.0 + L.look.w)), p);
    }
    case 13u: {
      // strips(downLeft|upLeft|downRight|upRight): a diagonal edge.
      var s = ((1.0 - u.x) + u.y) * 0.5;
      if (sub == 2u) { s = ((1.0 - u.x) + (1.0 - u.y)) * 0.5; }
      if (sub == 3u) { s = (u.x + u.y) * 0.5; }
      if (sub == 4u) { s = (u.x + (1.0 - u.y)) * 0.5; }
      return shows(s, p);
    }
    case 14u: {
      // wedge: from twelve o'clock, both ways.
      let a = abs(atan2(c.x, -c.y));
      return shows(a / PI, p);
    }
    case 15u: {
      // wheel(n): n spokes, clockwise.
      var a = atan2(c.x, -c.y);
      if (a < 0.0) { a = a + TAU; }
      let n = max(f32(sub), 1.0);
      return shows(fract(a * n / TAU), p);
    }
    default: { return 1.0; }
  }
}

// The filter's share of the point: what it shows, or for an exit (`out`)
// what it has not taken away yet.
fn filter_mask(f: vec4f, box: vec4f, page: vec2f) -> f32 {
  let kind = u32(f.x);
  if (kind == F_NONE || kind == F_SLIDE) { return 1.0; }
  let u = (page - box.xy) / max(box.zw, vec2f(1e-6));
  // Past its box (a stroke, a shadow) a filter acts as at the nearest edge.
  let a = filter_amount(f, clamp(u, vec2f(0.0), vec2f(1.0)), box);
  return select(a, 1.0 - a, f.w > 0.5);
}

// slide(fromTop|fromBottom|fromLeft|fromRight): the content moves into its
// box from that side (out: towards it) and shows only inside the box.
fn slide_uv(f: vec4f, box: vec4f, page: vec2f) -> vec3f {
  let sub = u32(f.y);
  let p = clamp(f.z, 0.0, 1.0);
  var away = 1.0 - p;
  if (f.w > 0.5) { away = p; }
  var dir = vec2f(0.0, -1.0);
  if (sub == 2u) { dir = vec2f(0.0, 1.0); }
  if (sub == 3u) { dir = vec2f(-1.0, 0.0); }
  if (sub == 4u) { dir = vec2f(1.0, 0.0); }
  let shift = dir * away * box.zw;
  let src = page - shift;
  let u = (page - box.xy) / max(box.zw, vec2f(1e-6));
  let inside = all(u >= vec2f(0.0)) && all(u <= vec2f(1.0));
  return vec3f(src, select(0.0, 1.0, inside));
}

@fragment
fn fs_layer(in: VsOut) -> @location(0) vec4f {
  var page = in.page;
  var keep = 1.0;
  if (u32(L.f0.x) == F_SLIDE) {
    let s = slide_uv(L.f0, L.b0, page);
    page = s.xy;
    keep = s.z;
  } else if (u32(L.f1.x) == F_SLIDE) {
    let s = slide_uv(L.f1, L.b1, page);
    page = s.xy;
    keep = s.z;
  }
  let uv = (page - L.region.xy) / max(L.region.zw, vec2f(1e-6));
  var c = textureSampleLevel(l_tex, l_sampler, uv, 0.0);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { c = vec4f(0.0); }
  // Recolour (a colour effect): the layer's own colour towards the tint.
  let rgb = mix(c.rgb, L.tint.rgb, L.look.y);
  let a = c.a * L.look.x * keep
    * filter_mask(L.f0, L.b0, in.page)
    * filter_mask(L.f1, L.b1, in.page);
  // Premultiplied out: the pass blends with (one, one - src alpha).
  return vec4f(rgb * a, a);
}
