// FILTER ▸ FILTER GALLERY — the breadth (WP5.2): every effect of
// Photoshop's Filter Gallery that the first families did not already name,
// and the WORKSPACE that stacks them.
//
// The gallery is not forty-seven algorithms. It is a dozen operations
// (image-kernels `gallery.*`: Kuwahara regions, posterised edges, glowing
// edges, a halftone screen, grain, diffusion, hatching, relief, threshold
// ink, Voronoi cells, glass, texture; and `gallery.strokes` /
// `gallery.chrome` / `gallery.plastic_wrap`), each named several times
// with different settings, and the Sketch family drawn in the foreground
// and background colours. So an effect here is a RECIPE: Photoshop's own
// sliders, mapped onto one or a few of those operations. A recipe of
// several steps runs as one undo step (`chain`: detached on a copy, landed
// once through the selection).
//
// These are clean-room approximations of what each filter visibly does,
// not of how Photoshop computes it; the gallery's Photoshop probes record
// the distance (docs/status.md).
//
// THE WORKSPACE (`filterGallery`) is a stack of effect layers, applied
// bottom to top, each with its own settings and an eye. Its values are
// flat, so the dialog's preview identity, the proxy scaling and the last
// settings work as for any filter: `stack` is `[effect, visible, …]` per
// layer (the effect an index into `GALLERY_EFFECT_IDS`) and a layer's
// settings are `"<layer>.<key>"`.

import { defineMessages } from "@paged-media/strings";

import type { DecodedInfo, ImageEngine } from "./engine";
import {
  angle,
  chain,
  colour,
  F,
  num,
  range,
  rgb,
  seed,
  select,
  type FilterContext,
  type FilterDef,
  type FilterId,
  type FilterValue,
  type FilterValues,
} from "./filters-schema";

export const FG = defineMessages("image.filter", {
  halftonePattern: "Halftone pattern",
  filterGallery: "Filter gallery",
  coloredPencil: "Coloured pencil",
  cutout: "Cutout",
  dryBrush: "Dry brush",
  fresco: "Fresco",
  neonGlow: "Neon glow",
  paletteKnife: "Palette knife",
  plasticWrap: "Plastic wrap",
  roughPastels: "Rough pastels",
  smudgeStick: "Smudge stick",
  sponge: "Sponge",
  underpainting: "Underpainting",
  watercolor: "Watercolour",
  accentedEdges: "Accented edges",
  angledStrokes: "Angled strokes",
  darkStrokes: "Dark strokes",
  inkOutlines: "Ink outlines",
  sprayedStrokes: "Sprayed strokes",
  sumiE: "Sumi-e",
  diffuseGlow: "Diffuse glow",
  oceanRipple: "Ocean ripple",
  chalkCharcoal: "Chalk & charcoal",
  charcoal: "Charcoal",
  chrome: "Chrome",
  conteCrayon: "Conté crayon",
  graphicPen: "Graphic pen",
  notePaper: "Note paper",
  plaster: "Plaster",
  reticulation: "Reticulation",
  stamp: "Stamp",
  tornEdges: "Torn edges",
  waterPaper: "Water paper",
  craquelure: "Craquelure",
  grainEffect: "Grain",
  mosaicTiles: "Mosaic tiles",
  patchwork: "Patchwork",
  // Categories (the workspace's browser).
  artistic: "Artistic",
  brushStrokes: "Brush strokes",
  distortCat: "Distort",
  sketch: "Sketch",
  stylizeCat: "Stylize",
  textureCat: "Texture",
  // Photoshop's slider names.
  pencilWidth: "Pencil width",
  strokePressure: "Stroke pressure",
  paperBrightness: "Paper brightness",
  numberOfLevels: "Number of levels",
  edgeSimplicity: "Edge simplicity",
  edgeFidelity: "Edge fidelity",
  brushSize: "Brush size",
  brushDetail: "Brush detail",
  textureAmount: "Texture",
  glowSize: "Glow size",
  glowBrightness: "Glow brightness",
  glowColour: "Glow colour",
  strokeSize: "Stroke size",
  strokeDetail: "Stroke detail",
  softnessLabel: "Softness",
  highlightStrength: "Highlight strength",
  detail: "Detail",
  smoothnessLabel: "Smoothness",
  strokeLength: "Stroke length",
  textureKind: "Texture",
  scaling: "Scaling",
  reliefLabel: "Relief",
  highlightArea: "Highlight area",
  intensityLabel: "Intensity",
  definition: "Definition",
  textureCoverage: "Texture coverage",
  shadowIntensity: "Shadow intensity",
  edgeWidth: "Edge width",
  edgeBrightness: "Edge brightness",
  directionBalance: "Direction balance",
  sharpness: "Sharpness",
  balance: "Balance",
  blackIntensity: "Black intensity",
  whiteIntensity: "White intensity",
  darkIntensity: "Dark intensity",
  lightIntensity: "Light intensity",
  sprayRadiusLabel: "Spray radius",
  strokeDirection: "Stroke direction",
  rightDiagonal: "Right diagonal",
  horizontalDir: "Horizontal",
  leftDiagonal: "Left diagonal",
  verticalDir: "Vertical",
  strokeWidth: "Stroke width",
  pressure: "Stroke pressure",
  contrastLabel: "Contrast",
  graininess: "Graininess",
  glowAmount: "Glow amount",
  clearAmount: "Clear amount",
  rippleSize: "Ripple size",
  rippleMagnitude: "Ripple magnitude",
  charcoalArea: "Charcoal area",
  chalkArea: "Chalk area",
  charcoalThickness: "Charcoal thickness",
  lightDarkBalance: "Light/dark balance",
  foregroundLevel: "Foreground level",
  backgroundLevel: "Background level",
  imageBalance: "Image balance",
  density: "Density",
  fibreLength: "Fibre length",
  brightnessLabel: "Brightness",
  crackSpacing: "Crack spacing",
  crackDepth: "Crack depth",
  crackBrightness: "Crack brightness",
  grainType: "Grain type",
  regular: "Regular",
  soft: "Soft",
  sprinkles: "Sprinkles",
  clumped: "Clumped",
  contrasty: "Contrasty",
  enlarged: "Enlarged",
  stippled: "Stippled",
  horizontalGrain: "Horizontal",
  verticalGrain: "Vertical",
  speckle: "Speckle",
  tileSize: "Tile size",
  groutWidth: "Grout width",
  lightenGrout: "Lighten grout",
  squareSize: "Square size",
  lightPosition: "Light",
  // The workspace.
  effectLayers: "Effect layers",
  newEffectLayer: "New effect layer",
  deleteEffectLayer: "Delete effect layer",
  moveUp: "Move up",
  moveDown: "Move down",
  showLayer: "Show",
  effect: "Effect",
});

type Step = (h: number) => Promise<DecodedInfo>;
type Recipe = (
  e: ImageEngine,
  v: FilterValues,
  ctx: FilterContext,
) => readonly Step[];

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));
const sd = (v: FilterValues) => Math.round(num(v, "seed")) || 1;
const texture = () =>
  select("texture", FG.textureKind, [F.canvas, F.burlap, F.brick], 0);
const lightAngle = () => angle("light", FG.lightPosition, 135);
const ink =
  (e: ImageEngine, ctx: FilterContext): Step =>
  (h) =>
    e.applyGradientMap(h, ctx.fg, ctx.bg);
const DIR_ANGLE = [45, 0, 135, 90] as const;
const direction = () =>
  select(
    "dir",
    FG.strokeDirection,
    [FG.rightDiagonal, FG.horizontalDir, FG.leftDiagonal, FG.verticalDir],
    0,
  );

/** One gallery effect: id, label, category, Photoshop's sliders, recipe. */
interface Effect {
  id: FilterId;
  label: string;
  category: string;
  params: FilterDef["params"];
  recipe: Recipe;
}

const r = range;
const EFFECTS: readonly Effect[] = [
  // ── Artistic ─────────────────────────────────────────────────────
  {
    id: "coloredPencil",
    label: FG.coloredPencil,
    category: FG.artistic,
    params: [
      r("width", FG.pencilWidth, 1, 24, 1, 4, { px: true }),
      r("pressure", FG.strokePressure, 0, 15, 1, 8),
      r("paper", FG.paperBrightness, 0, 50, 1, 25),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryCrosshatch(
          h,
          45,
          clamp(2 + num(v, "width") * 0.5, 2, 32),
          num(v, "pressure") / 15,
          2,
          1 - num(v, "paper") / 100,
        ),
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          45,
          clamp(num(v, "width"), 0, 24),
          0,
          0,
          0.6,
        ),
    ],
  },
  {
    id: "cutout",
    label: FG.cutout,
    category: FG.artistic,
    params: [
      r("levels", FG.numberOfLevels, 2, 8, 1, 4),
      r("simplicity", FG.edgeSimplicity, 0, 10, 1, 4),
      r("fidelity", FG.edgeFidelity, 1, 3, 1, 2),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryKuwahara(
          h,
          clamp(1 + num(v, "simplicity") * 0.7, 1, 8),
          1 - (num(v, "fidelity") - 1) * 0.2,
        ),
      (h) => e.galleryPosterizeEdges(h, num(v, "levels"), 0, 0.1, 1),
    ],
  },
  {
    id: "dryBrush",
    label: FG.dryBrush,
    category: FG.artistic,
    params: [
      r("size", FG.brushSize, 0, 10, 1, 2),
      r("detail", FG.brushDetail, 0, 10, 1, 8),
      r("texture", FG.textureAmount, 1, 3, 1, 1),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryKuwahara(
          h,
          clamp(1 + num(v, "size") * 0.7, 1, 8),
          1 - num(v, "detail") * 0.03,
        ),
      (h) => e.galleryGrain(h, sd(v), 1, true, num(v, "texture") * 0.08),
    ],
  },
  {
    id: "fresco",
    label: FG.fresco,
    category: FG.artistic,
    params: [
      r("size", FG.brushSize, 0, 10, 1, 2),
      r("detail", FG.brushDetail, 0, 10, 1, 8),
      r("texture", FG.textureAmount, 1, 3, 1, 1),
      seed(),
    ],
    recipe: (e, v) => [
      (h) => e.galleryKuwahara(h, clamp(2 + num(v, "size") * 0.6, 1, 8), 1),
      (h) => e.galleryPosterizeEdges(h, 6 + num(v, "detail"), 0.9, 0.05, 1),
      (h) =>
        e.galleryTexturizer(h, sd(v), 0, 12, num(v, "texture") * 0.25, 135, 1),
    ],
  },
  {
    id: "neonGlow",
    label: FG.neonGlow,
    category: FG.artistic,
    params: [
      r("size", FG.glowSize, -24, 24, 1, 5),
      r("brightness", FG.glowBrightness, 0, 50, 1, 15),
      colour("color", FG.glowColour, [0.3, 0.5, 1]),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryGlowingEdges(
          h,
          num(v, "brightness") / 10,
          Math.abs(num(v, "size")) / 24,
          1,
        ),
      (h) => e.applyGradientMap(h, [0, 0, 0], rgb(v, "color")),
    ],
  },
  {
    id: "paletteKnife",
    label: FG.paletteKnife,
    category: FG.artistic,
    params: [
      r("size", FG.strokeSize, 1, 50, 1, 25),
      r("detail", FG.strokeDetail, 1, 3, 1, 3),
      r("softness", FG.softnessLabel, 0, 10, 1, 0),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryKuwahara(
          h,
          clamp(1 + num(v, "size") / 7, 1, 8),
          0.7 + num(v, "detail") * 0.1,
        ),
      ...(num(v, "softness") > 0
        ? [(h: number) => e.galleryKuwahara(h, 2, num(v, "softness") / 10)]
        : []),
    ],
  },
  {
    id: "plasticWrap",
    label: FG.plasticWrap,
    category: FG.artistic,
    params: [
      r("strength", FG.highlightStrength, 0, 20, 1, 15),
      r("detail", FG.detail, 1, 15, 1, 9),
      r("smoothness", FG.smoothnessLabel, 1, 15, 1, 7),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryPlasticWrap(
          h,
          num(v, "strength"),
          num(v, "detail"),
          num(v, "smoothness"),
          1,
        ),
    ],
  },
  {
    id: "roughPastels",
    label: FG.roughPastels,
    category: FG.artistic,
    params: [
      r("length", FG.strokeLength, 0, 40, 1, 6, { px: true }),
      r("detail", FG.strokeDetail, 1, 20, 1, 4),
      texture(),
      r("scaling", FG.scaling, 50, 200, 1, 100),
      r("relief", FG.reliefLabel, 0, 50, 1, 20),
      lightAngle(),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          45,
          clamp(num(v, "length") * 0.6, 0, 24),
          0,
          0,
          1 - num(v, "detail") / 40,
        ),
      (h) =>
        e.galleryTexturizer(
          h,
          sd(v),
          num(v, "texture"),
          (24 * num(v, "scaling")) / 100,
          num(v, "relief") / 25,
          num(v, "light"),
          1,
        ),
    ],
  },
  {
    id: "smudgeStick",
    label: FG.smudgeStick,
    category: FG.artistic,
    params: [
      r("length", FG.strokeLength, 0, 10, 1, 2),
      r("area", FG.highlightArea, 0, 20, 1, 0),
      r("intensity", FG.intensityLabel, 0, 10, 1, 10),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          45,
          2 + num(v, "length") * 2,
          0,
          -num(v, "area") / 20,
          1,
        ),
      (h) => e.galleryKuwahara(h, 2, num(v, "intensity") / 10),
    ],
  },
  {
    id: "sponge",
    label: FG.sponge,
    category: FG.artistic,
    params: [
      r("size", FG.brushSize, 0, 10, 1, 2),
      r("definition", FG.definition, 0, 25, 1, 12),
      r("smoothness", FG.smoothnessLabel, 1, 15, 1, 5),
      seed(),
    ],
    recipe: (e, v) => [
      (h) => e.galleryKuwahara(h, clamp(1 + num(v, "size") * 0.5, 1, 8), 1),
      (h) =>
        e.galleryTexturizer(
          h,
          sd(v),
          1,
          4 + num(v, "size") * 2,
          num(v, "definition") / 12,
          135,
          1,
        ),
      (h) => e.galleryKuwahara(h, clamp(num(v, "smoothness") / 2, 1, 8), 0.5),
    ],
  },
  {
    id: "underpainting",
    label: FG.underpainting,
    category: FG.artistic,
    params: [
      r("size", FG.brushSize, 0, 40, 1, 6),
      r("coverage", FG.textureCoverage, 0, 40, 1, 16),
      texture(),
      r("scaling", FG.scaling, 50, 200, 1, 100),
      r("relief", FG.reliefLabel, 0, 50, 1, 4),
      lightAngle(),
      seed(),
    ],
    recipe: (e, v) => [
      (h) => e.galleryKuwahara(h, clamp(1 + num(v, "size") / 5, 1, 8), 1),
      (h) =>
        e.galleryTexturizer(
          h,
          sd(v),
          num(v, "texture"),
          (24 * num(v, "scaling")) / 100,
          num(v, "relief") / 25,
          num(v, "light"),
          num(v, "coverage") / 40,
        ),
    ],
  },
  {
    id: "watercolor",
    label: FG.watercolor,
    category: FG.artistic,
    params: [
      r("detail", FG.brushDetail, 1, 14, 1, 9),
      r("shadow", FG.shadowIntensity, 0, 10, 1, 1),
      r("texture", FG.textureAmount, 1, 3, 1, 1),
      seed(),
    ],
    recipe: (e, v) => [
      (h) => e.galleryKuwahara(h, clamp(9 - num(v, "detail") / 2, 1, 8), 1),
      (h) => e.galleryPosterizeEdges(h, 24, num(v, "shadow") / 10, 0.04, 1),
      (h) => e.galleryGrain(h, sd(v), 1, true, num(v, "texture") * 0.05),
    ],
  },
  // ── Brush strokes ────────────────────────────────────────────────
  {
    id: "accentedEdges",
    label: FG.accentedEdges,
    category: FG.brushStrokes,
    params: [
      r("width", FG.edgeWidth, 1, 14, 1, 2),
      r("brightness", FG.edgeBrightness, 0, 50, 1, 38),
      r("smoothness", FG.smoothnessLabel, 1, 15, 1, 5),
    ],
    recipe: (e, v) => [
      (h) => e.galleryKuwahara(h, clamp(num(v, "smoothness") / 2, 1, 8), 0.6),
      (h) =>
        e.galleryPosterizeEdges(
          h,
          64,
          1 - num(v, "brightness") / 50,
          0.02 * num(v, "width"),
          1,
        ),
      (h) =>
        e.galleryGlowingEdges(
          h,
          num(v, "brightness") / 25,
          num(v, "width") / 14,
          0.35,
        ),
    ],
  },
  {
    id: "angledStrokes",
    label: FG.angledStrokes,
    category: FG.brushStrokes,
    params: [
      r("balance", FG.directionBalance, 0, 100, 1, 50),
      r("length", FG.strokeLength, 3, 50, 1, 15, { px: true }),
      r("sharpness", FG.sharpness, 0, 10, 1, 3),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          45,
          clamp(num(v, "length") / 2, 0, 24),
          2,
          (num(v, "balance") - 50) / 50,
          1 - num(v, "sharpness") / 30,
        ),
    ],
  },
  {
    id: "darkStrokes",
    label: FG.darkStrokes,
    category: FG.brushStrokes,
    params: [
      r("balance", FG.balance, 0, 10, 1, 5),
      r("black", FG.blackIntensity, 0, 10, 1, 6),
      r("white", FG.whiteIntensity, 0, 10, 1, 2),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          45,
          8,
          2,
          clamp(
            (num(v, "black") - num(v, "white")) / 10 +
              (num(v, "balance") - 5) / 20,
            -1,
            1,
          ),
          1,
        ),
    ],
  },
  {
    id: "inkOutlines",
    label: FG.inkOutlines,
    category: FG.brushStrokes,
    params: [
      r("length", FG.strokeLength, 1, 50, 1, 4, { px: true }),
      r("dark", FG.darkIntensity, 0, 50, 1, 20),
      r("light", FG.lightIntensity, 0, 50, 1, 10),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          45,
          clamp(num(v, "length"), 0, 24),
          1,
          clamp((num(v, "dark") - num(v, "light")) / 50, -1, 1),
          1,
        ),
      (h) => e.galleryPosterizeEdges(h, 32, 1, 0.08, 1),
    ],
  },
  {
    id: "sprayedStrokes",
    label: FG.sprayedStrokes,
    category: FG.brushStrokes,
    params: [
      r("length", FG.strokeLength, 0, 20, 1, 12, { px: true }),
      r("radius", FG.sprayRadiusLabel, 0, 25, 1, 7, { px: true }),
      direction(),
      seed(),
    ],
    recipe: (e, v) => {
      const a = DIR_ANGLE[num(v, "dir")] ?? 45;
      return [
        (h) =>
          e.galleryDiffuse(
            h,
            sd(v),
            clamp(num(v, "radius") / 3, 0, 8),
            a,
            1,
            1,
          ),
        (h) => e.galleryStrokes(h, sd(v), a, num(v, "length"), 0, 0, 0.7),
      ];
    },
  },
  {
    id: "sumiE",
    label: FG.sumiE,
    category: FG.brushStrokes,
    params: [
      r("width", FG.strokeWidth, 3, 15, 1, 10),
      r("pressure", FG.pressure, 0, 15, 1, 2),
      r("contrast", FG.contrastLabel, 0, 40, 1, 16),
      seed(),
    ],
    recipe: (e, v) => [
      (h) => e.galleryKuwahara(h, clamp(num(v, "width") / 2, 1, 8), 1),
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          45,
          num(v, "width"),
          1,
          clamp(0.2 + num(v, "pressure") / 15, -1, 1),
          0.5 + num(v, "contrast") / 80,
        ),
    ],
  },
  // ── Distort ──────────────────────────────────────────────────────
  {
    id: "diffuseGlow",
    label: FG.diffuseGlow,
    category: FG.distortCat,
    params: [
      r("graininess", FG.graininess, 0, 10, 1, 6),
      r("glow", FG.glowAmount, 0, 20, 1, 10),
      r("clear", FG.clearAmount, 0, 20, 1, 15),
      seed(),
    ],
    recipe: (e, v) => [
      (h) => e.galleryGrain(h, sd(v), 1, true, num(v, "graininess") / 20),
      (h) =>
        e.applyLensBlur(
          h,
          clamp(num(v, "glow"), 0, 24),
          clamp(1 - num(v, "clear") / 40, 0, 1),
          4,
        ),
    ],
  },
  {
    id: "oceanRipple",
    label: FG.oceanRipple,
    category: FG.distortCat,
    params: [
      r("size", FG.rippleSize, 1, 15, 1, 9),
      r("magnitude", FG.rippleMagnitude, 0, 20, 1, 9),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryGlass(
          h,
          sd(v),
          4 + num(v, "size") * 3,
          clamp(num(v, "magnitude") * 0.8, 0, 16),
          1,
        ),
    ],
  },
  // ── Sketch (foreground and background colours) ──────────────────
  {
    id: "chalkCharcoal",
    label: FG.chalkCharcoal,
    category: FG.sketch,
    params: [
      r("charcoal", FG.charcoalArea, 0, 20, 1, 6),
      r("chalk", FG.chalkArea, 0, 20, 1, 6),
      r("pressure", FG.pressure, 0, 5, 1, 1),
      seed(),
    ],
    recipe: (e, v, ctx) => [
      (h) => e.galleryStrokes(h, sd(v), 45, 6, 0, 0, 1),
      (h) =>
        e.galleryThresholdInk(
          h,
          clamp(0.5 + (num(v, "chalk") - num(v, "charcoal")) / 60, 0, 1),
          0.05 + num(v, "pressure") * 0.03,
          1,
        ),
      ink(e, ctx),
    ],
  },
  {
    id: "charcoal",
    label: FG.charcoal,
    category: FG.sketch,
    params: [
      r("thickness", FG.charcoalThickness, 1, 7, 1, 1),
      r("detail", FG.detail, 0, 5, 1, 5),
      r("balance", FG.lightDarkBalance, 0, 100, 1, 50),
      seed(),
    ],
    recipe: (e, v, ctx) => [
      (h) =>
        e.galleryStrokes(h, sd(v), 45, 3 + num(v, "thickness") * 2, 1, 0, 1),
      (h) =>
        e.galleryThresholdInk(
          h,
          num(v, "balance") / 100,
          0.3 - num(v, "detail") * 0.04,
          1,
        ),
      ink(e, ctx),
    ],
  },
  {
    id: "chrome",
    label: FG.chrome,
    category: FG.sketch,
    params: [
      r("detail", FG.detail, 0, 10, 1, 4),
      r("smoothness", FG.smoothnessLabel, 0, 10, 1, 7),
    ],
    recipe: (e, v) => [
      (h) => e.galleryChrome(h, num(v, "detail"), num(v, "smoothness"), 1),
    ],
  },
  {
    id: "conteCrayon",
    label: FG.conteCrayon,
    category: FG.sketch,
    params: [
      r("fgLevel", FG.foregroundLevel, 1, 15, 1, 11),
      r("bgLevel", FG.backgroundLevel, 1, 15, 1, 7),
      texture(),
      r("scaling", FG.scaling, 50, 200, 1, 100),
      r("relief", FG.reliefLabel, 0, 50, 1, 4),
      lightAngle(),
      seed(),
    ],
    recipe: (e, v, ctx) => [
      (h) => e.galleryStrokes(h, sd(v), 45, 6, 0, 0, 1),
      (h) =>
        e.galleryThresholdInk(
          h,
          clamp(0.5 + (num(v, "bgLevel") - num(v, "fgLevel")) / 30, 0, 1),
          0.2,
          1,
        ),
      ink(e, ctx),
      (h) =>
        e.galleryTexturizer(
          h,
          sd(v),
          num(v, "texture"),
          (24 * num(v, "scaling")) / 100,
          num(v, "relief") / 25,
          num(v, "light"),
          1,
        ),
    ],
  },
  {
    id: "graphicPen",
    label: FG.graphicPen,
    category: FG.sketch,
    params: [
      r("length", FG.strokeLength, 1, 15, 1, 15),
      r("balance", FG.lightDarkBalance, 0, 100, 1, 50),
      direction(),
      seed(),
    ],
    recipe: (e, v, ctx) => {
      const a = DIR_ANGLE[num(v, "dir")] ?? 45;
      return [
        (h) => e.galleryCrosshatch(h, a, 2.5, 1, 1, 1),
        (h) => e.galleryStrokes(h, sd(v), a, num(v, "length"), 0, 0, 1),
        (h) => e.galleryThresholdInk(h, num(v, "balance") / 100, 0.02, 1),
        ink(e, ctx),
      ];
    },
  },
  {
    id: "notePaper",
    label: FG.notePaper,
    category: FG.sketch,
    params: [
      r("balance", FG.imageBalance, 0, 50, 1, 25),
      r("graininess", FG.graininess, 0, 20, 1, 10),
      r("relief", FG.reliefLabel, 0, 25, 1, 11),
      seed(),
    ],
    recipe: (e, v, ctx) => [
      (h) => e.galleryThresholdInk(h, num(v, "balance") / 50, 0.05, 1),
      ink(e, ctx),
      (h) => e.galleryBasRelief(h, 135, 30, num(v, "relief") / 8, 1),
      (h) => e.galleryGrain(h, sd(v), 1, true, num(v, "graininess") / 40),
    ],
  },
  {
    id: "plaster",
    label: FG.plaster,
    category: FG.sketch,
    params: [
      r("balance", FG.imageBalance, 0, 50, 1, 20),
      r("smoothness", FG.smoothnessLabel, 1, 15, 1, 2),
      lightAngle(),
    ],
    recipe: (e, v, ctx) => [
      (h) => e.galleryKuwahara(h, clamp(num(v, "smoothness") / 2 + 1, 1, 8), 1),
      (h) => e.galleryThresholdInk(h, num(v, "balance") / 50, 0.1, 1),
      (h) => e.galleryBasRelief(h, num(v, "light"), 30, 3, 1),
      ink(e, ctx),
    ],
  },
  {
    id: "reticulation",
    label: FG.reticulation,
    category: FG.sketch,
    params: [
      r("density", FG.density, 0, 50, 1, 12),
      r("fgLevel", FG.foregroundLevel, 0, 50, 1, 40),
      r("bgLevel", FG.backgroundLevel, 0, 50, 1, 5),
      seed(),
    ],
    recipe: (e, v, ctx) => [
      (h) => e.galleryGrain(h, sd(v), 1.5, true, num(v, "density") / 50),
      (h) =>
        e.galleryThresholdInk(
          h,
          clamp(0.5 + (num(v, "fgLevel") - num(v, "bgLevel")) / 200, 0, 1),
          0.15,
          1,
        ),
      ink(e, ctx),
    ],
  },
  {
    id: "stamp",
    label: FG.stamp,
    category: FG.sketch,
    params: [
      r("balance", FG.lightDarkBalance, 0, 50, 1, 25),
      r("smoothness", FG.smoothnessLabel, 1, 50, 1, 5),
    ],
    recipe: (e, v, ctx) => [
      (h) => e.galleryKuwahara(h, clamp(num(v, "smoothness") / 6 + 1, 1, 8), 1),
      (h) => e.galleryThresholdInk(h, num(v, "balance") / 50, 0.02, 1),
      ink(e, ctx),
    ],
  },
  {
    id: "tornEdges",
    label: FG.tornEdges,
    category: FG.sketch,
    params: [
      r("balance", FG.imageBalance, 0, 50, 1, 25),
      r("smoothness", FG.smoothnessLabel, 1, 15, 1, 11),
      r("contrast", FG.contrastLabel, 1, 25, 1, 17),
      seed(),
    ],
    recipe: (e, v, ctx) => [
      (h) =>
        e.galleryThresholdInk(
          h,
          num(v, "balance") / 50,
          clamp(0.3 / num(v, "contrast"), 0.005, 0.3),
          1,
        ),
      (h) =>
        e.galleryDiffuse(
          h,
          sd(v),
          clamp(8 - num(v, "smoothness") / 2, 0, 8),
          0,
          0,
          1,
        ),
      (h) => e.galleryKuwahara(h, 2, 0.5),
      ink(e, ctx),
    ],
  },
  {
    id: "waterPaper",
    label: FG.waterPaper,
    category: FG.sketch,
    params: [
      r("length", FG.fibreLength, 3, 50, 1, 15, { px: true }),
      r("brightness", FG.brightnessLabel, 0, 100, 1, 60),
      r("contrast", FG.contrastLabel, 0, 100, 1, 80),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStrokes(
          h,
          sd(v),
          90,
          clamp(num(v, "length") / 2, 0, 24),
          0,
          (50 - num(v, "brightness")) / 100,
          num(v, "contrast") / 100,
        ),
      (h) => e.galleryGlass(h, sd(v), 6, 2, 0.6),
    ],
  },
  // ── Texture ──────────────────────────────────────────────────────
  {
    id: "craquelure",
    label: FG.craquelure,
    category: FG.textureCat,
    params: [
      r("spacing", FG.crackSpacing, 2, 100, 1, 15, { px: true }),
      r("depth", FG.crackDepth, 0, 10, 1, 6),
      r("brightness", FG.crackBrightness, 0, 10, 1, 9),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStainedGlass(
          h,
          sd(v),
          clamp(num(v, "spacing") / 4, 2, 16),
          (num(v, "depth") / 10) * 0.5,
          0.35 * (1 - num(v, "brightness") / 20),
        ),
      (h) => e.galleryBasRelief(h, 135, 40, num(v, "depth") / 4, 0.5),
    ],
  },
  {
    id: "grain",
    label: FG.grainEffect,
    category: FG.textureCat,
    params: [
      r("intensity", FG.intensityLabel, 0, 100, 1, 40),
      r("contrast", FG.contrastLabel, 0, 100, 1, 50),
      select(
        "type",
        FG.grainType,
        [
          FG.regular,
          FG.soft,
          FG.sprinkles,
          FG.clumped,
          FG.contrasty,
          FG.enlarged,
          FG.stippled,
          FG.horizontalGrain,
          FG.verticalGrain,
          FG.speckle,
        ],
        0,
      ),
      seed(),
    ],
    recipe: (e, v) => {
      const type = num(v, "type");
      // [grain size px, monochromatic] per type.
      const kinds: ReadonlyArray<readonly [number, boolean]> = [
        [1, false],
        [1.5, false],
        [1, true],
        [3, false],
        [1, false],
        [4, false],
        [1, true],
        [1, false],
        [1, false],
        [1, true],
      ];
      const [size, mono] = kinds[type] ?? [1, false];
      const amt =
        (num(v, "intensity") / 100) * (0.5 + num(v, "contrast") / 100);
      return [
        (h) => e.galleryGrain(h, sd(v), size, mono, clamp(amt, 0, 1)),
        ...(type === 7 || type === 8
          ? [
              (h: number) =>
                e.galleryStrokes(h, sd(v), type === 7 ? 0 : 90, 6, 0, 0, 1),
            ]
          : []),
      ];
    },
  },
  {
    id: "mosaicTiles",
    label: FG.mosaicTiles,
    category: FG.textureCat,
    params: [
      r("size", FG.tileSize, 2, 100, 1, 12, { px: true }),
      r("grout", FG.groutWidth, 1, 15, 1, 3),
      r("lighten", FG.lightenGrout, 0, 10, 1, 9),
      seed(),
    ],
    recipe: (e, v) => [
      (h) =>
        e.galleryStainedGlass(
          h,
          sd(v),
          clamp(num(v, "size") / 3 + 2, 2, 16),
          num(v, "grout") / 15,
          0.85 - num(v, "lighten") * 0.03,
        ),
      (h) => e.galleryBasRelief(h, 135, 40, 1.5, 0.4),
    ],
  },
  {
    id: "patchwork",
    label: FG.patchwork,
    category: FG.textureCat,
    params: [
      r("size", FG.squareSize, 0, 10, 1, 4),
      r("relief", FG.reliefLabel, 0, 25, 1, 8),
      seed(),
    ],
    recipe: (e, v) => [
      (h) => e.applyMosaic(h, 4 + num(v, "size") * 2),
      (h) =>
        e.galleryTexturizer(
          h,
          sd(v),
          2,
          4 + num(v, "size") * 2,
          num(v, "relief") / 12,
          135,
          1,
        ),
    ],
  },
];

/** The breadth effects as Filter-dialog entries of their own. */
export const GALLERY_FILTERS: readonly FilterDef[] = EFFECTS.map((x) => ({
  id: x.id,
  label: x.label,
  group: "Filter Gallery",
  params: x.params,
  run: (e, h, v, ctx) => chain(e, h, x.recipe(e, v, ctx)),
}));

/** The gallery category of each effect the workspace offers (the first
 *  families' gallery entries included). */
export const GALLERY_CATEGORY: Readonly<Partial<Record<FilterId, string>>> = {
  ...Object.fromEntries(EFFECTS.map((x) => [x.id, x.category])),
  paintDaubs: FG.artistic,
  posterEdges: FG.artistic,
  filmGrain: FG.artistic,
  spatter: FG.brushStrokes,
  crosshatch: FG.brushStrokes,
  glass: FG.distortCat,
  basRelief: FG.sketch,
  halftone: FG.sketch,
  photocopy: FG.sketch,
  glowingEdges: FG.stylizeCat,
  stainedGlass: FG.textureCat,
  texturizer: FG.textureCat,
};

export const GALLERY_CATEGORIES = [
  FG.artistic,
  FG.brushStrokes,
  FG.distortCat,
  FG.sketch,
  FG.stylizeCat,
  FG.textureCat,
] as const;

// ── the workspace ───────────────────────────────────────────────────

/** One effect layer of the workspace. */
export interface GalleryLayer {
  effect: FilterId;
  visible: boolean;
  values: Record<string, FilterValue>;
}

/** The workspace's flat values → its layers (bottom first). */
export function galleryLayers(
  v: FilterValues,
  effects: readonly FilterDef[],
): GalleryLayer[] {
  const stack = v.stack;
  if (!Array.isArray(stack)) return [];
  const out: GalleryLayer[] = [];
  for (let i = 0; i + 1 < stack.length; i += 2) {
    const def = effects[stack[i]!];
    if (!def) continue;
    const n = i / 2;
    const values: Record<string, FilterValue> = {};
    for (const p of def.params) values[p.key] = v[`${n}.${p.key}`] ?? p.default;
    out.push({ effect: def.id, visible: stack[i + 1] === 1, values });
  }
  return out;
}

/** Layers → the workspace's flat values. */
export function galleryValues(
  layers: readonly GalleryLayer[],
  effects: readonly FilterDef[],
): Record<string, FilterValue> {
  const out: Record<string, FilterValue> = {};
  const stack: number[] = [];
  layers.forEach((l, n) => {
    stack.push(
      effects.findIndex((d) => d.id === l.effect),
      l.visible ? 1 : 0,
    );
    for (const [k, x] of Object.entries(l.values)) out[`${n}.${k}`] = x;
  });
  out.stack = stack;
  return out;
}

/** The Filter Gallery workspace over `effects` (every entry of the
 *  Filter Gallery group): the stack applied bottom to top, one step. */
export function galleryWorkspace(effects: readonly FilterDef[]): FilterDef {
  const first = effects[0]!;
  const initial = galleryValues(
    [
      {
        effect: first.id,
        visible: true,
        values: Object.fromEntries(first.params.map((p) => [p.key, p.default])),
      },
    ],
    effects,
  );
  return {
    id: "filterGallery",
    label: FG.filterGallery,
    group: "Filter Gallery",
    // The stack is drawn by the workspace, not as parameters; the values
    // start at one layer of the first effect.
    params: [
      {
        kind: "points",
        key: "stack",
        label: FG.effectLayers,
        stride: 2,
        min: 0,
        max: effects.length,
        default: initial.stack as readonly number[],
      },
    ],
    scale(values, factor) {
      const out: Record<string, FilterValue> = { ...values };
      galleryLayers(values, effects).forEach((l, n) => {
        const def = effects.find((d) => d.id === l.effect)!;
        for (const p of def.params) {
          if (p.kind !== "range" || !p.px) continue;
          const x = num(l.values, p.key) * factor;
          out[`${n}.${p.key}`] = Math.min(
            p.max,
            Math.max(Math.min(p.min, 0), p.step >= 1 ? Math.round(x) : x),
          );
        }
      });
      return out;
    },
    run(e, h, v, ctx) {
      const steps = galleryLayers(v, effects)
        .filter((l) => l.visible)
        .map((l) => {
          const def = effects.find((d) => d.id === l.effect)!;
          return (x: number) => def.run(e, x, l.values, ctx);
        });
      if (steps.length === 0)
        return Promise.reject(new Error("no visible effect layer"));
      return chain(e, h, steps);
    },
  };
}

/** The workspace's defaults: one layer of the first effect, every
 *  setting at its default (the stack parameter's default alone would
 *  leave the layer's settings to their parameters' defaults anyway). */
export function galleryDefaults(
  effects: readonly FilterDef[],
): Record<string, FilterValue> {
  const first = effects[0]!;
  return galleryValues(
    [
      {
        effect: first.id,
        visible: true,
        values: Object.fromEntries(first.params.map((p) => [p.key, p.default])),
      },
    ],
    effects,
  );
}
