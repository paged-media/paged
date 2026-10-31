// The engine doors of WP5.2's filter families (Distort, Render, Stylize,
// Pixelate, the Blur Gallery, the Filter Gallery's extra operations, the
// one-shot adjustments and Develop), and the CHAIN pair that runs several
// of them as one undo step.
//
// Kept beside engine.ts rather than in it: `ImageEngine` extends
// `FilterEngine` and `ImageWasmModule` extends `FilterWasm`, and
// `wrapEngine` spreads `filterEngineOf(wasm)`. Every door here is
// GPU-only (no CPU twin ships for them) and lands like every other
// effect: in the active layer, through the selection, as one journal
// step — except on a handle from `filterSource`, where it returns a new
// flat handle (the chain's intermediate).

import type { DecodedInfo } from "./engine";

export type Rgb01 = readonly [number, number, number];

/** The wasm half (snake_case, image-js `src/wasm/filters_*.rs`). */
export interface FilterWasm {
  filter_source(handle: number): FilterHandleWasm;
  filter_land(handle: number, result: number): Promise<FilterHandleWasm>;
  // Distort / Render (filters_distort.rs)
  apply_displace(
    handle: number,
    map: number,
    sx: number,
    sy: number,
    fit: number,
    edge: number,
  ): Promise<FilterHandleWasm>;
  apply_polar(handle: number, toPolar: boolean): Promise<FilterHandleWasm>;
  apply_ripple(
    handle: number,
    amount: number,
    size: number,
  ): Promise<FilterHandleWasm>;
  apply_shear(
    handle: number,
    offsets: Float32Array,
    wrap: boolean,
  ): Promise<FilterHandleWasm>;
  apply_zigzag(
    handle: number,
    amount: number,
    ridges: number,
    style: number,
  ): Promise<FilterHandleWasm>;
  apply_clouds(
    handle: number,
    seed: number,
    fg: Float32Array,
    bg: Float32Array,
    difference: boolean,
  ): Promise<FilterHandleWasm>;
  apply_fibers(
    handle: number,
    seed: number,
    variance: number,
    strength: number,
    fg: Float32Array,
    bg: Float32Array,
  ): Promise<FilterHandleWasm>;
  apply_lens_flare(
    handle: number,
    cx: number,
    cy: number,
    brightness: number,
    kind: number,
  ): Promise<FilterHandleWasm>;
  apply_lighting(handle: number, s: Float32Array): Promise<FilterHandleWasm>;
  // Stylize / Pixelate (filters_stylize.rs)
  apply_wind(
    handle: number,
    method: number,
    fromLeft: boolean,
    seed: number,
  ): Promise<FilterHandleWasm>;
  apply_extrude(
    handle: number,
    pyramids: boolean,
    size: number,
    depth: number,
    levelBased: boolean,
    solidFront: boolean,
    maskIncomplete: boolean,
    seed: number,
  ): Promise<FilterHandleWasm>;
  apply_tiles(
    handle: number,
    tiles: number,
    maxOffset: number,
    fill: number,
    fg: Float32Array,
    bg: Float32Array,
    seed: number,
  ): Promise<FilterHandleWasm>;
  apply_solarize(handle: number): Promise<FilterHandleWasm>;
  apply_trace_contour(
    handle: number,
    level: number,
    upper: boolean,
  ): Promise<FilterHandleWasm>;
  apply_crystallize(
    handle: number,
    cell: number,
    seed: number,
  ): Promise<FilterHandleWasm>;
  apply_pointillize(
    handle: number,
    cell: number,
    bg: Float32Array,
    seed: number,
  ): Promise<FilterHandleWasm>;
  apply_mezzotint(
    handle: number,
    kind: number,
    seed: number,
  ): Promise<FilterHandleWasm>;
  apply_color_halftone(
    handle: number,
    maxRadius: number,
    angles: Float32Array,
  ): Promise<FilterHandleWasm>;
  // Blur Gallery / Filter Gallery extras (filters_blur.rs)
  apply_blur_field(
    handle: number,
    pins: Float32Array,
    bokeh: number,
  ): Promise<FilterHandleWasm>;
  apply_blur_iris(
    handle: number,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    blur: number,
    feather: number,
    bokeh: number,
  ): Promise<FilterHandleWasm>;
  apply_blur_tilt_shift(
    handle: number,
    cx: number,
    cy: number,
    angle: number,
    sharp: number,
    feather: number,
    blur: number,
    symmetric: boolean,
    bokeh: number,
  ): Promise<FilterHandleWasm>;
  apply_blur_path(
    handle: number,
    points: Float32Array,
    speed: number,
    taper: number,
    centered: boolean,
  ): Promise<FilterHandleWasm>;
  apply_blur_spin(
    handle: number,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    angle: number,
    feather: number,
  ): Promise<FilterHandleWasm>;
  apply_gallery_strokes(
    handle: number,
    seed: number,
    angle: number,
    length: number,
    mode: number,
    darkness: number,
    amount: number,
  ): Promise<FilterHandleWasm>;
  apply_gallery_chrome(
    handle: number,
    detail: number,
    smoothness: number,
    amount: number,
  ): Promise<FilterHandleWasm>;
  apply_gallery_plastic_wrap(
    handle: number,
    strength: number,
    detail: number,
    smoothness: number,
    amount: number,
  ): Promise<FilterHandleWasm>;
  // Adjustments / Develop (filters_adjust.rs)
  apply_shadows_highlights(
    handle: number,
    s: Float32Array,
  ): Promise<FilterHandleWasm>;
  apply_hdr_toning(handle: number, s: Float32Array): Promise<FilterHandleWasm>;
  color_stats(handle: number, useSelection: boolean): Float32Array;
  apply_match_color(
    handle: number,
    source: Float32Array,
    luminance: number,
    intensity: number,
    fade: number,
    neutralize: boolean,
  ): Promise<FilterHandleWasm>;
  apply_replace_color(
    handle: number,
    color: Float32Array,
    fuzziness: number,
    hue: number,
    saturation: number,
    lightness: number,
  ): Promise<FilterHandleWasm>;
  apply_equalize(
    handle: number,
    selectionHistogram: boolean,
  ): Promise<FilterHandleWasm>;
  apply_desaturate(handle: number): Promise<FilterHandleWasm>;
  apply_develop(handle: number, s: Float32Array): Promise<FilterHandleWasm>;
}

export interface FilterHandleWasm {
  handle: number;
  width: number;
  height: number;
  display?: number;
  depth_reduced?: boolean;
  free(): void;
}

/** The `Shadows/Highlights` block (`apply_shadows_highlights`). */
export interface ShadowsHighlights {
  shadows: number;
  shadowTone: number;
  shadowRadius: number;
  highlights: number;
  highlightTone: number;
  highlightRadius: number;
  colorCorrection: number;
  midtoneContrast: number;
}

/** The `HDR Toning` block (`apply_hdr_toning`). */
export interface HdrToning {
  radius: number;
  strength: number;
  gamma: number;
  exposure: number;
  detail: number;
  shadow: number;
  highlight: number;
  vibrance: number;
  saturation: number;
}

/** Lighting Effects: one light and the material (`apply_lighting`). */
export interface Lighting {
  type: 0 | 1 | 2;
  x: number;
  y: number;
  height: number;
  direction: number;
  cone: number;
  intensity: number;
  color: Rgb01;
  gloss: number;
  metallic: number;
  exposure: number;
  ambience: number;
  texture: number;
  bump: number;
  whiteHigh: boolean;
  focus: number;
  elevation: number;
}

/** CIELAB statistics of an image: means then standard deviations. */
export type ColorStats = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

/** The camelCase facade `ImageEngine` gains. */
export interface FilterEngine {
  /** A detached, unmasked flat copy of what a filter on `handle` reads
   *  (the active layer's pixels). The caller frees it. */
  filterSource(handle: number): DecodedInfo;
  /** Land a chain's result in `handle` through the selection, as ONE
   *  undo step. The caller frees `result`. */
  filterLand(handle: number, result: number): Promise<DecodedInfo>;
  applyDisplace(
    handle: number,
    map: number,
    scaleXPx: number,
    scaleYPx: number,
    tile: boolean,
    wrap: boolean,
  ): Promise<DecodedInfo>;
  applyPolar(handle: number, toPolar: boolean): Promise<DecodedInfo>;
  applyRipple(
    handle: number,
    amount: number,
    size: 0 | 1 | 2,
  ): Promise<DecodedInfo>;
  /** 16 px offsets, top to bottom. */
  applyShear(
    handle: number,
    offsets: readonly number[],
    wrap: boolean,
  ): Promise<DecodedInfo>;
  applyZigzag(
    handle: number,
    amount: number,
    ridges: number,
    style: 0 | 1 | 2,
  ): Promise<DecodedInfo>;
  applyClouds(
    handle: number,
    seed: number,
    fg: Rgb01,
    bg: Rgb01,
    difference: boolean,
  ): Promise<DecodedInfo>;
  applyFibers(
    handle: number,
    seed: number,
    variance: number,
    strength: number,
    fg: Rgb01,
    bg: Rgb01,
  ): Promise<DecodedInfo>;
  applyLensFlare(
    handle: number,
    cx: number,
    cy: number,
    brightness: number,
    kind: number,
  ): Promise<DecodedInfo>;
  applyLighting(handle: number, light: Lighting): Promise<DecodedInfo>;
  applyWind(
    handle: number,
    method: 0 | 1 | 2,
    fromLeft: boolean,
    seed: number,
  ): Promise<DecodedInfo>;
  applyExtrude(
    handle: number,
    o: {
      pyramids: boolean;
      size: number;
      depth: number;
      levelBased: boolean;
      solidFront: boolean;
      maskIncomplete: boolean;
      seed: number;
    },
  ): Promise<DecodedInfo>;
  applyTiles(
    handle: number,
    tiles: number,
    maxOffset: number,
    fill: number,
    fg: Rgb01,
    bg: Rgb01,
    seed: number,
  ): Promise<DecodedInfo>;
  applySolarize(handle: number): Promise<DecodedInfo>;
  applyTraceContour(
    handle: number,
    level: number,
    upper: boolean,
  ): Promise<DecodedInfo>;
  applyCrystallize(
    handle: number,
    cell: number,
    seed: number,
  ): Promise<DecodedInfo>;
  applyPointillize(
    handle: number,
    cell: number,
    bg: Rgb01,
    seed: number,
  ): Promise<DecodedInfo>;
  applyMezzotint(
    handle: number,
    kind: number,
    seed: number,
  ): Promise<DecodedInfo>;
  applyColorHalftone(
    handle: number,
    maxRadius: number,
    angles: readonly [number, number, number, number],
  ): Promise<DecodedInfo>;
  /** Field Blur: pins `[x, y, blurPx]` in image px. */
  applyBlurField(
    handle: number,
    pins: ReadonlyArray<readonly [number, number, number]>,
    bokeh: number,
  ): Promise<DecodedInfo>;
  applyBlurIris(
    handle: number,
    o: {
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      rotation: number;
      blur: number;
      feather: number;
      bokeh: number;
    },
  ): Promise<DecodedInfo>;
  applyBlurTiltShift(
    handle: number,
    o: {
      cx: number;
      cy: number;
      angle: number;
      sharp: number;
      feather: number;
      blur: number;
      symmetric: boolean;
      bokeh: number;
    },
  ): Promise<DecodedInfo>;
  applyBlurPath(
    handle: number,
    points: ReadonlyArray<readonly [number, number]>,
    speed: number,
    taper: number,
    centered: boolean,
  ): Promise<DecodedInfo>;
  applyBlurSpin(
    handle: number,
    o: {
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      rotation: number;
      angle: number;
      feather: number;
    },
  ): Promise<DecodedInfo>;
  galleryStrokes(
    handle: number,
    seed: number,
    angle: number,
    length: number,
    mode: 0 | 1 | 2,
    darkness: number,
    amount: number,
  ): Promise<DecodedInfo>;
  galleryChrome(
    handle: number,
    detail: number,
    smoothness: number,
    amount: number,
  ): Promise<DecodedInfo>;
  galleryPlasticWrap(
    handle: number,
    strength: number,
    detail: number,
    smoothness: number,
    amount: number,
  ): Promise<DecodedInfo>;
  applyShadowsHighlights(
    handle: number,
    s: ShadowsHighlights,
  ): Promise<DecodedInfo>;
  applyHdrToning(handle: number, s: HdrToning): Promise<DecodedInfo>;
  /** CIELAB means and deviations of the active layer (the image), under
   *  the selection when asked. Synchronous CPU readout. */
  colorStats(handle: number, useSelection: boolean): ColorStats;
  applyMatchColor(
    handle: number,
    source: ColorStats,
    luminance: number,
    intensity: number,
    fade: number,
    neutralize: boolean,
  ): Promise<DecodedInfo>;
  applyReplaceColor(
    handle: number,
    color: Rgb01,
    fuzziness: number,
    hue: number,
    saturation: number,
    lightness: number,
  ): Promise<DecodedInfo>;
  applyEqualize(
    handle: number,
    selectionHistogram: boolean,
  ): Promise<DecodedInfo>;
  applyDesaturate(handle: number): Promise<DecodedInfo>;
  /** Develop at the 61 settings of `develop.ts`. */
  applyDevelop(
    handle: number,
    settings: readonly number[],
  ): Promise<DecodedInfo>;
}

const f32 = (v: readonly number[]): Float32Array => Float32Array.from(v);

export function filterEngineOf(
  wasm: FilterWasm,
  info: (h: FilterHandleWasm) => DecodedInfo,
): FilterEngine {
  const run = async (p: Promise<FilterHandleWasm>): Promise<DecodedInfo> =>
    info(await p);
  return {
    filterSource: (h) => info(wasm.filter_source(h)),
    filterLand: (h, r) => run(wasm.filter_land(h, r)),
    applyDisplace: (h, map, sx, sy, tile, wrap) =>
      run(wasm.apply_displace(h, map, sx, sy, tile ? 1 : 0, wrap ? 0 : 1)),
    applyPolar: (h, toPolar) => run(wasm.apply_polar(h, toPolar)),
    applyRipple: (h, amount, size) => run(wasm.apply_ripple(h, amount, size)),
    applyShear: (h, offsets, wrap) => {
      if (offsets.length !== 16)
        throw new Error(`shear takes 16 offsets, not ${offsets.length}`);
      return run(wasm.apply_shear(h, f32(offsets), wrap));
    },
    applyZigzag: (h, amount, ridges, style) =>
      run(wasm.apply_zigzag(h, amount, ridges, style)),
    applyClouds: (h, seed, fg, bg, difference) =>
      run(wasm.apply_clouds(h, seed >>> 0, f32(fg), f32(bg), difference)),
    applyFibers: (h, seed, variance, strength, fg, bg) =>
      run(
        wasm.apply_fibers(h, seed >>> 0, variance, strength, f32(fg), f32(bg)),
      ),
    applyLensFlare: (h, cx, cy, brightness, kind) =>
      run(wasm.apply_lens_flare(h, cx, cy, brightness, kind)),
    applyLighting: (h, l) =>
      run(
        wasm.apply_lighting(
          h,
          f32([
            l.type,
            l.x,
            l.y,
            l.height,
            l.direction,
            l.cone,
            l.intensity,
            ...l.color,
            l.gloss,
            l.metallic,
            l.exposure,
            l.ambience,
            l.texture,
            l.bump,
            l.whiteHigh ? 1 : 0,
            l.focus,
            l.elevation,
          ]),
        ),
      ),
    applyWind: (h, method, fromLeft, seed) =>
      run(wasm.apply_wind(h, method, fromLeft, seed >>> 0)),
    applyExtrude: (h, o) =>
      run(
        wasm.apply_extrude(
          h,
          o.pyramids,
          o.size,
          o.depth,
          o.levelBased,
          o.solidFront,
          o.maskIncomplete,
          o.seed >>> 0,
        ),
      ),
    applyTiles: (h, tiles, maxOffset, fill, fg, bg, seed) =>
      run(
        wasm.apply_tiles(
          h,
          tiles,
          maxOffset,
          fill,
          f32(fg),
          f32(bg),
          seed >>> 0,
        ),
      ),
    applySolarize: (h) => run(wasm.apply_solarize(h)),
    applyTraceContour: (h, level, upper) =>
      run(wasm.apply_trace_contour(h, level, upper)),
    applyCrystallize: (h, cell, seed) =>
      run(wasm.apply_crystallize(h, cell, seed >>> 0)),
    applyPointillize: (h, cell, bg, seed) =>
      run(wasm.apply_pointillize(h, cell, f32(bg), seed >>> 0)),
    applyMezzotint: (h, kind, seed) =>
      run(wasm.apply_mezzotint(h, kind, seed >>> 0)),
    applyColorHalftone: (h, maxRadius, angles) =>
      run(wasm.apply_color_halftone(h, maxRadius, f32(angles))),
    applyBlurField: (h, pins, bokeh) =>
      run(wasm.apply_blur_field(h, f32(pins.flat()), bokeh)),
    applyBlurIris: (h, o) =>
      run(
        wasm.apply_blur_iris(
          h,
          o.cx,
          o.cy,
          o.rx,
          o.ry,
          o.rotation,
          o.blur,
          o.feather,
          o.bokeh,
        ),
      ),
    applyBlurTiltShift: (h, o) =>
      run(
        wasm.apply_blur_tilt_shift(
          h,
          o.cx,
          o.cy,
          o.angle,
          o.sharp,
          o.feather,
          o.blur,
          o.symmetric,
          o.bokeh,
        ),
      ),
    applyBlurPath: (h, points, speed, taper, centered) =>
      run(wasm.apply_blur_path(h, f32(points.flat()), speed, taper, centered)),
    applyBlurSpin: (h, o) =>
      run(
        wasm.apply_blur_spin(
          h,
          o.cx,
          o.cy,
          o.rx,
          o.ry,
          o.rotation,
          o.angle,
          o.feather,
        ),
      ),
    galleryStrokes: (h, seed, angle, length, mode, darkness, amount) =>
      run(
        wasm.apply_gallery_strokes(
          h,
          seed >>> 0,
          angle,
          length,
          mode,
          darkness,
          amount,
        ),
      ),
    galleryChrome: (h, detail, smoothness, amount) =>
      run(wasm.apply_gallery_chrome(h, detail, smoothness, amount)),
    galleryPlasticWrap: (h, strength, detail, smoothness, amount) =>
      run(
        wasm.apply_gallery_plastic_wrap(
          h,
          strength,
          detail,
          smoothness,
          amount,
        ),
      ),
    applyShadowsHighlights: (h, s) =>
      run(
        wasm.apply_shadows_highlights(
          h,
          f32([
            s.shadows,
            s.shadowTone,
            s.shadowRadius,
            s.highlights,
            s.highlightTone,
            s.highlightRadius,
            s.colorCorrection,
            s.midtoneContrast,
          ]),
        ),
      ),
    applyHdrToning: (h, s) =>
      run(
        wasm.apply_hdr_toning(
          h,
          f32([
            s.radius,
            s.strength,
            s.gamma,
            s.exposure,
            s.detail,
            s.shadow,
            s.highlight,
            s.vibrance,
            s.saturation,
          ]),
        ),
      ),
    colorStats: (h, useSelection) => {
      const v = wasm.color_stats(h, useSelection);
      return [v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!];
    },
    applyMatchColor: (h, source, luminance, intensity, fade, neutralize) =>
      run(
        wasm.apply_match_color(
          h,
          f32(source),
          luminance,
          intensity,
          fade,
          neutralize,
        ),
      ),
    applyReplaceColor: (h, color, fuzziness, hue, saturation, lightness) =>
      run(
        wasm.apply_replace_color(
          h,
          f32(color),
          fuzziness,
          hue,
          saturation,
          lightness,
        ),
      ),
    applyEqualize: (h, sel) => run(wasm.apply_equalize(h, sel)),
    applyDesaturate: (h) => run(wasm.apply_desaturate(h)),
    applyDevelop: (h, s) => {
      if (s.length !== 61)
        throw new Error(`develop takes 61 settings, not ${s.length}`);
      return run(wasm.apply_develop(h, f32(s)));
    },
  };
}
