// FILTER ▸ Distort / Render / Stylize / Pixelate / Adjust — the families
// WP5.2 adds to the Filter dialog's catalogue (the kernels: image-kernels
// `distort`, `render`, `stylize`, `pixelate`, `adjust_ext`). Each entry is
// the kernel's parameters in Photoshop's units, converted in `run`:
// Photoshop's Displace scale is a percentage of 128 px, its levels are
// 0–255, its percentages 0–100.
//
// Positions are NORMALISED to the image (0..1) so the proxy preview and
// the full pass agree; lengths are px and marked so the proxy scales them.

import { defineMessages } from "@paged-media/strings";

import {
  angle,
  colour,
  F,
  num,
  range,
  seed,
  select,
  toggle,
  bool,
  rgb,
  inSection,
  type FilterDef,
  type FilterValue,
  type FilterValues,
} from "./filters-schema";

export const FF = defineMessages("image.filter", {
  displace: "Displace",
  horizontalScale: "Horizontal scale",
  verticalScale: "Vertical scale",
  displacementMap: "Displacement map",
  stretchToFit: "Stretch to fit",
  tileMap: "Tile",
  mapSource: "Map",
  thisImage: "This image (composite)",
  aFile: "A file…",
  polarCoordinates: "Polar coordinates",
  rectToPolar: "Rectangular to polar",
  polarToRect: "Polar to rectangular",
  ripple: "Ripple",
  waveSize: "Size",
  small: "Small",
  medium: "Medium",
  large: "Large",
  shear: "Shear",
  shearTop: "Top",
  shearUpper: "Upper quarter",
  shearMiddle: "Middle",
  shearLower: "Lower quarter",
  shearBottom: "Bottom",
  zigzag: "ZigZag",
  ridges: "Ridges",
  zigzagStyle: "Style",
  aroundCentre: "Around centre",
  outFromCentre: "Out from centre",
  pondRipples: "Pond ripples",
  clouds: "Clouds",
  differenceClouds: "Difference clouds",
  fibers: "Fibers",
  variance: "Variance",
  lensFlare: "Lens flare",
  flareBrightness: "Brightness",
  lensType: "Lens type",
  zoom50300: "50–300 mm zoom",
  prime35: "35 mm prime",
  prime105: "105 mm prime",
  moviePrime: "Movie prime",
  lightingEffects: "Lighting effects",
  lightSection: "Light",
  lightType: "Light type",
  spot: "Spot",
  pointLight: "Point",
  infinite: "Infinite",
  lightHeight: "Height",
  lightDirection: "Direction",
  hotspot: "Hotspot",
  lightPower: "Intensity",
  lightColour: "Colour",
  focus: "Focus",
  material: "Material",
  gloss: "Gloss",
  metallic: "Metallic",
  lightExposure: "Exposure",
  ambience: "Ambience",
  textureChannel: "Texture",
  noTexture: "None",
  channelRed: "Red",
  channelGreen: "Green",
  channelBlue: "Blue",
  channelAlpha: "Transparency",
  channelLuminance: "Luminance",
  bumpHeight: "Height",
  whiteIsHigh: "White is high",
  wind: "Wind",
  windMethod: "Method",
  blast: "Blast",
  stagger: "Stagger",
  windDirection: "Direction",
  fromRight: "From the right",
  fromLeft: "From the left",
  extrude: "Extrude",
  extrudeType: "Type",
  blocks: "Blocks",
  pyramids: "Pyramids",
  extrudeSize: "Size",
  depth: "Depth",
  random: "Random",
  levelBased: "Level-based",
  solidFront: "Solid front faces",
  maskIncomplete: "Mask incomplete blocks",
  tiles: "Tiles",
  numberOfTiles: "Number of tiles",
  maxOffset: "Maximum offset",
  fillEmpty: "Fill empty area with",
  backgroundColour: "Background colour",
  foregroundColour: "Foreground colour",
  inverseImage: "Inverse image",
  unalteredImage: "Unaltered image",
  traceContour: "Trace contour",
  level: "Level",
  edge: "Edge",
  lower: "Lower",
  upper: "Upper",
  crystallize: "Crystallize",
  pointillize: "Pointillize",
  mezzotint: "Mezzotint",
  mezzoType: "Type",
  fineDots: "Fine dots",
  mediumDots: "Medium dots",
  grainyDots: "Grainy dots",
  coarseDots: "Coarse dots",
  shortLines: "Short lines",
  mediumLines: "Medium lines",
  longLines: "Long lines",
  shortStrokes: "Short strokes",
  mediumStrokes: "Medium strokes",
  longStrokes: "Long strokes",
  maxRadius: "Max. radius",
  channel1: "Channel 1",
  channel2: "Channel 2",
  channel3: "Channel 3",
  channel4: "Channel 4",
  shadowsHighlights: "Shadows/highlights",
  shSection: "Shadows",
  hlSection: "Highlights",
  adjSection: "Adjustments",
  tone: "Tone",
  colourCorrection: "Colour correction",
  midtoneContrast: "Midtone contrast",
  hdrToning: "HDR toning",
  edgeGlow: "Edge glow",
  toneDetail: "Tone and detail",
  gamma: "Gamma",
  hdrExposure: "Exposure",
  hdrDetail: "Detail",
  advanced: "Advanced",
  hdrShadow: "Shadow",
  hdrHighlight: "Highlight",
  vibrance: "Vibrance",
  saturation: "Saturation",
  matchColor: "Match colour",
  source: "Source",
  luminance: "Luminance",
  colourIntensity: "Colour intensity",
  fade: "Fade",
  neutralize: "Neutralize",
  replaceColor: "Replace colour",
  replaceWhat: "Colour",
  fuzziness: "Fuzziness",
  hue: "Hue",
  lightness: "Lightness",
});

const pct = (key: string, label: string, min: number, max: number, d: number) =>
  range(key, label, min, max, 1, d);

/** Five shear control offsets (px) → the kernel's sixteen, top to bottom,
 *  by Catmull-Rom through the five (ends clamped). */
export function shearOffsets(c: readonly number[]): number[] {
  const p = (i: number) => c[Math.min(c.length - 1, Math.max(0, i))] ?? 0;
  const out: number[] = [];
  for (let k = 0; k < 16; k++) {
    const u = (k / 15) * (c.length - 1);
    const i = Math.min(c.length - 2, Math.floor(u));
    const t = u - i;
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const t2 = t * t;
    const t3 = t2 * t;
    out.push(
      0.5 *
        (2 * p1 +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t3),
    );
  }
  return out;
}

const resource = (
  ctx: { resource(key: string): number | null },
  key: string,
  what: string,
): number => {
  const h = ctx.resource(key);
  if (h === null) throw new Error(`${what}: choose the image first`);
  return h;
};

/** Scale the listed keys by the proxy factor (lengths given in other
 *  units: Displace's percentages, Shear's offsets). */
const scaling =
  (keys: readonly string[]) =>
  (v: FilterValues, factor: number): Record<string, FilterValue> => {
    const out: Record<string, FilterValue> = { ...v };
    for (const k of keys) out[k] = num(v, k) * factor;
    return out;
  };

const SHEAR_KEYS = ["s0", "s1", "s2", "s3", "s4"] as const;

export const FAMILY_FILTERS: readonly FilterDef[] = [
  // ── Distort ────────────────────────────────────────────────────────
  {
    id: "displace",
    label: FF.displace,
    group: "Distort",
    params: [
      pct("sx", FF.horizontalScale, -999, 999, 10),
      pct("sy", FF.verticalScale, -999, 999, 10),
      select("fit", FF.displacementMap, [FF.stretchToFit, FF.tileMap], 0),
      select("edge", F.undefinedAreas, [F.wrapAround, F.repeatEdge], 1),
      { kind: "image", key: "map", label: FF.mapSource, default: 0 },
    ],
    // Photoshop's scale is a percentage of 128 px: a length after all.
    scale: scaling(["sx", "sy"]),
    run: (e, h, v, ctx) =>
      e.applyDisplace(
        h,
        resource(ctx, "map", "Displace"),
        (num(v, "sx") / 100) * 128,
        (num(v, "sy") / 100) * 128,
        num(v, "fit") === 1,
        num(v, "edge") === 0,
      ),
  },
  {
    id: "polarCoordinates",
    label: FF.polarCoordinates,
    group: "Distort",
    params: [select("mode", F.method, [FF.rectToPolar, FF.polarToRect], 0)],
    run: (e, h, v) => e.applyPolar(h, num(v, "mode") === 0),
  },
  {
    id: "ripple",
    label: FF.ripple,
    group: "Distort",
    params: [
      pct("amount", F.amount, -999, 999, 100),
      select("size", FF.waveSize, [FF.small, FF.medium, FF.large], 1),
    ],
    run: (e, h, v) =>
      e.applyRipple(h, num(v, "amount"), num(v, "size") as 0 | 1 | 2),
  },
  {
    id: "shear",
    label: FF.shear,
    group: "Distort",
    params: [
      range("s0", FF.shearTop, -256, 256, 1, 0, { px: true }),
      range("s1", FF.shearUpper, -256, 256, 1, 0, { px: true }),
      range("s2", FF.shearMiddle, -256, 256, 1, 0, { px: true }),
      range("s3", FF.shearLower, -256, 256, 1, 0, { px: true }),
      range("s4", FF.shearBottom, -256, 256, 1, 0, { px: true }),
      select("edge", F.undefinedAreas, [F.wrapAround, F.repeatEdge], 0),
    ],
    run: (e, h, v) =>
      e.applyShear(
        h,
        shearOffsets(SHEAR_KEYS.map((k) => num(v, k))),
        num(v, "edge") === 0,
      ),
  },
  {
    id: "zigzag",
    label: FF.zigzag,
    group: "Distort",
    params: [
      pct("amount", F.amount, -100, 100, 10),
      range("ridges", FF.ridges, 0, 20, 1, 5),
      select(
        "style",
        FF.zigzagStyle,
        [FF.aroundCentre, FF.outFromCentre, FF.pondRipples],
        2,
      ),
    ],
    run: (e, h, v) =>
      e.applyZigzag(
        h,
        num(v, "amount"),
        num(v, "ridges"),
        num(v, "style") as 0 | 1 | 2,
      ),
  },
  // ── Render ─────────────────────────────────────────────────────────
  {
    id: "clouds",
    label: FF.clouds,
    group: "Render",
    params: [seed()],
    run: (e, h, v, ctx) =>
      e.applyClouds(h, num(v, "seed"), ctx.fg, ctx.bg, false),
  },
  {
    id: "differenceClouds",
    label: FF.differenceClouds,
    group: "Render",
    params: [seed()],
    run: (e, h, v, ctx) =>
      e.applyClouds(h, num(v, "seed"), ctx.fg, ctx.bg, true),
  },
  {
    id: "fibers",
    label: FF.fibers,
    group: "Render",
    params: [
      range("variance", FF.variance, 1, 64, 1, 16),
      range("strength", F.strength, 1, 64, 1, 4),
      seed(),
    ],
    run: (e, h, v, ctx) =>
      e.applyFibers(
        h,
        num(v, "seed"),
        num(v, "variance"),
        num(v, "strength"),
        ctx.fg,
        ctx.bg,
      ),
  },
  {
    id: "lensFlare",
    label: FF.lensFlare,
    group: "Render",
    params: [
      pct("brightness", FF.flareBrightness, 10, 300, 100),
      range("cx", F.centreX, 0, 1, 0.01, 0.3, { percent: true }),
      range("cy", F.centreY, 0, 1, 0.01, 0.3, { percent: true }),
      select(
        "kind",
        FF.lensType,
        [FF.zoom50300, FF.prime35, FF.prime105, FF.moviePrime],
        0,
      ),
    ],
    run: (e, h, v) =>
      e.applyLensFlare(
        h,
        num(v, "cx"),
        num(v, "cy"),
        num(v, "brightness"),
        num(v, "kind"),
      ),
  },
  {
    id: "lightingEffects",
    label: FF.lightingEffects,
    group: "Render",
    params: [
      ...inSection(FF.lightSection, [
        select("type", FF.lightType, [FF.spot, FF.pointLight, FF.infinite], 0),
        range("x", F.centreX, 0, 1, 0.01, 0.5, { percent: true }),
        range("y", F.centreY, 0, 1, 0.01, 0.5, { percent: true }),
        range("height", FF.lightHeight, 0, 1, 0.01, 0.5, { percent: true }),
        angle("direction", FF.lightDirection, -45),
        range("cone", FF.hotspot, 1, 90, 1, 45),
        pct("intensity", FF.lightPower, -100, 100, 35),
        colour("color", FF.lightColour, [1, 1, 1]),
        pct("focus", FF.focus, -100, 100, 69),
        range("elevation", F.elevation, 0, 90, 1, 45),
      ]),
      ...inSection(FF.material, [
        pct("gloss", FF.gloss, -100, 100, 0),
        pct("metallic", FF.metallic, -100, 100, 0),
        pct("exposure", FF.lightExposure, -100, 100, 0),
        pct("ambience", FF.ambience, -100, 100, 8),
        select(
          "texture",
          FF.textureChannel,
          [
            FF.noTexture,
            FF.channelRed,
            FF.channelGreen,
            FF.channelBlue,
            FF.channelAlpha,
            FF.channelLuminance,
          ],
          0,
        ),
        pct("bump", FF.bumpHeight, 0, 100, 50),
        toggle("whiteHigh", FF.whiteIsHigh, true),
      ]),
    ],
    run: (e, h, v) =>
      e.applyLighting(h, {
        type: num(v, "type") as 0 | 1 | 2,
        x: num(v, "x"),
        y: num(v, "y"),
        height: num(v, "height"),
        direction: num(v, "direction"),
        cone: num(v, "cone"),
        intensity: num(v, "intensity"),
        color: rgb(v, "color"),
        gloss: num(v, "gloss"),
        metallic: num(v, "metallic"),
        exposure: num(v, "exposure"),
        ambience: num(v, "ambience"),
        texture: num(v, "texture"),
        bump: num(v, "bump"),
        whiteHigh: bool(v, "whiteHigh"),
        focus: num(v, "focus"),
        elevation: num(v, "elevation"),
      }),
  },
  // ── Stylize ────────────────────────────────────────────────────────
  {
    id: "wind",
    label: FF.wind,
    group: "Stylize",
    params: [
      select("method", FF.windMethod, [FF.wind, FF.blast, FF.stagger], 0),
      select("from", FF.windDirection, [FF.fromRight, FF.fromLeft], 0),
      seed(),
    ],
    run: (e, h, v) =>
      e.applyWind(
        h,
        num(v, "method") as 0 | 1 | 2,
        num(v, "from") === 1,
        num(v, "seed"),
      ),
  },
  {
    id: "extrude",
    label: FF.extrude,
    group: "Stylize",
    params: [
      select("type", FF.extrudeType, [FF.blocks, FF.pyramids], 0),
      range("size", FF.extrudeSize, 2, 255, 1, 30, { px: true }),
      range("depth", FF.depth, 1, 255, 1, 30),
      select("mode", F.method, [FF.random, FF.levelBased], 1),
      toggle("solidFront", FF.solidFront, false),
      toggle("maskIncomplete", FF.maskIncomplete, false),
      seed(),
    ],
    run: (e, h, v) =>
      e.applyExtrude(h, {
        pyramids: num(v, "type") === 1,
        size: num(v, "size"),
        depth: num(v, "depth"),
        levelBased: num(v, "mode") === 1,
        solidFront: bool(v, "solidFront"),
        maskIncomplete: bool(v, "maskIncomplete"),
        seed: num(v, "seed"),
      }),
  },
  {
    id: "tiles",
    label: FF.tiles,
    group: "Stylize",
    params: [
      range("tiles", FF.numberOfTiles, 1, 99, 1, 10),
      pct("offset", FF.maxOffset, 1, 99, 10),
      select(
        "fill",
        FF.fillEmpty,
        [
          FF.backgroundColour,
          FF.foregroundColour,
          FF.inverseImage,
          FF.unalteredImage,
        ],
        0,
      ),
      seed(),
    ],
    run: (e, h, v, ctx) =>
      e.applyTiles(
        h,
        Math.round(num(v, "tiles")),
        num(v, "offset") / 100,
        num(v, "fill"),
        ctx.fg,
        ctx.bg,
        num(v, "seed"),
      ),
  },
  {
    id: "traceContour",
    label: FF.traceContour,
    group: "Stylize",
    params: [
      range("level", FF.level, 0, 255, 1, 128),
      select("edge", FF.edge, [FF.lower, FF.upper], 0),
    ],
    run: (e, h, v) =>
      e.applyTraceContour(h, num(v, "level") / 255, num(v, "edge") === 1),
  },
  // ── Pixelate ───────────────────────────────────────────────────────
  {
    id: "crystallize",
    label: FF.crystallize,
    group: "Pixelate",
    params: [range("cell", F.cellSize, 3, 300, 1, 10, { px: true }), seed()],
    run: (e, h, v) => e.applyCrystallize(h, num(v, "cell"), num(v, "seed")),
  },
  {
    id: "pointillize",
    label: FF.pointillize,
    group: "Pixelate",
    params: [range("cell", F.cellSize, 3, 300, 1, 5, { px: true }), seed()],
    run: (e, h, v, ctx) =>
      e.applyPointillize(h, num(v, "cell"), ctx.bg, num(v, "seed")),
  },
  {
    id: "mezzotint",
    label: FF.mezzotint,
    group: "Pixelate",
    params: [
      select(
        "kind",
        FF.mezzoType,
        [
          FF.fineDots,
          FF.mediumDots,
          FF.grainyDots,
          FF.coarseDots,
          FF.shortLines,
          FF.mediumLines,
          FF.longLines,
          FF.shortStrokes,
          FF.mediumStrokes,
          FF.longStrokes,
        ],
        0,
      ),
      seed(),
    ],
    run: (e, h, v) => e.applyMezzotint(h, num(v, "kind"), num(v, "seed")),
  },
  {
    id: "colorHalftone",
    label: F.halftone,
    group: "Pixelate",
    params: [
      range("radius", FF.maxRadius, 4, 127, 1, 8, { px: true }),
      angle("a1", FF.channel1, 108),
      angle("a2", FF.channel2, 162),
      angle("a3", FF.channel3, 90),
      angle("a4", FF.channel4, 45),
    ],
    run: (e, h, v) =>
      e.applyColorHalftone(h, num(v, "radius"), [
        num(v, "a1"),
        num(v, "a2"),
        num(v, "a3"),
        num(v, "a4"),
      ]),
  },
  // ── Adjust ─────────────────────────────────────────────────────────
  {
    id: "shadowsHighlights",
    label: FF.shadowsHighlights,
    group: "Adjust",
    params: [
      ...inSection(FF.shSection, [
        pct("shadows", F.amount, 0, 100, 35),
        pct("shadowTone", FF.tone, 0, 100, 50),
        range("shadowRadius", F.radius, 0, 64, 1, 30, { px: true }),
      ]),
      ...inSection(FF.hlSection, [
        pct("highlights", F.amount, 0, 100, 0),
        pct("highlightTone", FF.tone, 0, 100, 50),
        range("highlightRadius", F.radius, 0, 64, 1, 30, { px: true }),
      ]),
      ...inSection(FF.adjSection, [
        pct("colorCorrection", FF.colourCorrection, -100, 100, 20),
        pct("midtoneContrast", FF.midtoneContrast, -100, 100, 0),
      ]),
    ],
    run: (e, h, v) =>
      e.applyShadowsHighlights(h, {
        shadows: num(v, "shadows") / 100,
        shadowTone: num(v, "shadowTone") / 100,
        shadowRadius: num(v, "shadowRadius"),
        highlights: num(v, "highlights") / 100,
        highlightTone: num(v, "highlightTone") / 100,
        highlightRadius: num(v, "highlightRadius"),
        colorCorrection: num(v, "colorCorrection") / 100,
        midtoneContrast: num(v, "midtoneContrast") / 100,
      }),
  },
  {
    id: "hdrToning",
    label: FF.hdrToning,
    group: "Adjust",
    params: [
      ...inSection(FF.edgeGlow, [
        range("radius", F.radius, 1, 128, 1, 32, { px: true }),
        range("strength", F.strength, 0.1, 4, 0.05, 0.5),
      ]),
      ...inSection(FF.toneDetail, [
        range("gamma", FF.gamma, 0.1, 2, 0.01, 1),
        range("exposure", FF.hdrExposure, -5, 5, 0.05, 0),
        range("detail", FF.hdrDetail, -100, 300, 1, 30),
      ]),
      ...inSection(FF.advanced, [
        pct("shadow", FF.hdrShadow, -100, 100, 0),
        pct("highlight", FF.hdrHighlight, -100, 100, 0),
        pct("vibrance", FF.vibrance, -100, 100, 0),
        pct("saturation", FF.saturation, -100, 100, 20),
      ]),
    ],
    run: (e, h, v) =>
      e.applyHdrToning(h, {
        radius: num(v, "radius"),
        strength: num(v, "strength"),
        gamma: num(v, "gamma"),
        exposure: num(v, "exposure"),
        detail: num(v, "detail") / 100,
        shadow: num(v, "shadow") / 100,
        highlight: num(v, "highlight") / 100,
        vibrance: num(v, "vibrance") / 100,
        saturation: num(v, "saturation") / 100,
      }),
  },
  {
    id: "matchColor",
    label: FF.matchColor,
    group: "Adjust",
    params: [
      { kind: "image", key: "source", label: FF.source, default: 1 },
      pct("luminance", FF.luminance, 1, 200, 100),
      pct("intensity", FF.colourIntensity, 1, 200, 100),
      pct("fade", FF.fade, 0, 100, 0),
      toggle("neutralize", FF.neutralize, false),
    ],
    run: (e, h, v, ctx) =>
      e.applyMatchColor(
        h,
        e.colorStats(resource(ctx, "source", "Match colour"), false),
        num(v, "luminance") / 100,
        num(v, "intensity") / 100,
        num(v, "fade") / 100,
        bool(v, "neutralize"),
      ),
  },
  {
    id: "replaceColor",
    label: FF.replaceColor,
    group: "Adjust",
    params: [
      colour("color", FF.replaceWhat, [0.8, 0.2, 0.2]),
      pct("fuzziness", FF.fuzziness, 0, 200, 40),
      pct("hue", FF.hue, -180, 180, 0),
      pct("saturation", FF.saturation, -100, 100, 0),
      pct("lightness", FF.lightness, -100, 100, 0),
    ],
    run: (e, h, v) =>
      e.applyReplaceColor(
        h,
        rgb(v, "color"),
        num(v, "fuzziness"),
        num(v, "hue"),
        num(v, "saturation"),
        num(v, "lightness"),
      ),
  },
];
