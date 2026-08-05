/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// BLENDS v1 — the Illustrator §16.2 row. Read the header before the
// code; three things in here are easy to get backwards.
//
// ------------------------------------------------- what v0 was, and was not
// v0 (wave 2) shipped ONE command: two structurally matching paths → 3
// interpolated intermediates, in TWO batches. Everything the catalog row
// actually names — the three SPACING MODES, a SPINE, the two reverse
// verbs, easing, independent colour acceleration, expand/release — was
// absent. v1 is that row. The v0 exports that other code reads
// (`blendSourceFrom`, `blendStructureMatches`) survive unchanged; the
// two v0 batch builders do not, because there is one batch now.
//
// ---------------------------------------------- ONE BATCH. ONE UNDO.
// v0's header named two engine gaps as the reason it paid two undo
// steps. One of them is closed: RFI C-15's `bindCreated` is in the
// contract (plugin-sdk `bc52766`), so a batch can ADDRESS the ids it
// mints and the inserts, the swatches, the fills and the links all ride
// ONE mutation. Repeats v1 was the first consumer; this is the second,
// and it rides the SAME seam (`commands/v59-wire.ts`) rather than a
// second copy of the cast. MEASURED: make = 1, update = 1, expand = 1,
// release = 1, reverse-spine / reverse-front-to-back = 1 each (they are
// updates), select = 0.
//
// The other v0 gap — `setDocumentDefaults` is rejected inside a batch —
// is still true and still irrelevant: the fills ride direct property
// writes, never the defaults idiom.
//
// A MEASURED C-15 EDGE this module routes around, the same one
// `commands/repeat.ts` records: with an EARLIER `bindCreated` in the
// batch, a bind placed after a `createGroup` resolves inconsistently. So
// nothing here ever addresses a group it minted in the same batch —
// Update reads the previous group out of the TREE first.
//
// ------------------------------------------------- THE THREE SPACING MODES
// This is the substance of the row, and all three reduce to a STEP
// COUNT and then to the same placement:
//   · SPECIFIED STEPS — the count IS the parameter.
//   · SPECIFIED DISTANCE — the count is derived from the SPINE's arc
//     length: how many gaps of `distancePt` fit along it.
//   · SMOOTH COLOR — the count is derived from the COLOUR distance: the
//     largest per-channel difference between the two key fills, which is
//     how many 1/255 steps it takes to get from one to the other without
//     banding. If either fill is not resolvable to RGB there is no
//     colour distance to measure, so it falls back to the default count
//     and SAYS SO rather than inventing one.
// A count over {@link BLEND_MAX_STEPS} is REFUSED when it was TYPED and
// CLAMPED when it was DERIVED — a typo should not build a 5000-op batch,
// but a black→white smooth blend asking for 255 is data, not a typo.
//
// ------------------------------------------------------------- THE SPINE
// The spine is the path the intermediates follow. By DEFAULT it is the
// straight line between the two key objects' centres — and the default
// is provably inert: `measureSegment(cA, cB)` sampled at the same eased
// parameter the shapes interpolate at is EXACTLY the lerp v0 produced,
// so a v1 blend with default options is a v0 blend with more steps
// available. Every deviation is opt-in.
//
// REPLACE SPINE swaps in a chosen path. Then each intermediate is
// translated by (spine point at u) − (straight-line point at t), and —
// with `orientation: "path"` — rotated about that point by the spine's
// tangent minus the straight line's. Both terms vanish on the default
// spine, which is what makes "the default changed nothing" an assertion
// rather than a claim.
//
// TWO DIFFERENCES FROM ILLUSTRATOR, named rather than hidden:
//   1. THE SPINE PATH KEEPS ITS OWN PAINT. Illustrator's replaced spine
//      stops painting; clearing a stroke the user drew, without being
//      asked, is a worse surprise than a visible spine. Clear it
//      yourself, or give it no stroke before you replace with it.
//   2. THE SPINE IS NOT IN THE BLEND'S GROUP. It stays an ordinary
//      top-level path so it can still be selected and edited directly —
//      which is the whole reason to replace a spine.
//
// ------------------------------------------------- REVERSE, THE TWO KINDS
// They are different and the catalog lists both:
//   · REVERSE SPINE flips the direction the intermediates travel: the
//     spine is read from the far end, so key A's shape ends up at key
//     B's end of the path. Geometry moves.
//   · REVERSE FRONT-TO-BACK flips PAINT ORDER only. Nothing moves; the
//     intermediate that was on top is now at the bottom. It is
//     expressible because INSERTION ORDER IS PAINT ORDER (the pattern-v1
//     finding) — the steps are simply emitted in the other order, so it
//     costs no `reorderElement` and no second batch.
// Both are stored parameters, so both are just an Update.
//
// ---------------------------------------------------- EXPAND vs RELEASE
// Illustrator's two verbs, the same way `commands/repeat.ts` keeps them:
//   · EXPAND — stop tracking, keep EVERYTHING (the intermediates become
//     ordinary paths).
//   · RELEASE — remove the intermediates, keep the two KEY objects (and
//     the spine) exactly as they were.
//
// ---------------------------------------------- LIVE PANEL PREVIEW: HONESTLY
// The catalog asks for a "live Blend panel preview". What the panel
// previews is the PLAN — the resolved step count, the spine length, the
// derivation that produced the count — recomputed as you change the
// options. It does NOT re-render the artwork as you type: that would be
// one document mutation, and one undo step, per keystroke. The artwork
// is rebuilt by Update, and {@link BLEND_LIVE_NOTE} says so in the panel
// itself.
//
// -------------------------------------------------------------- limits
// · STRUCTURE MISMATCH IS STILL A REFUSAL. v0 refused two paths with
//   different subpath/anchor counts rather than inventing a
//   correspondence, and v1 does the same. Resampling both keys to a
//   common parameterization is a real feature and is NOT built.
// · RFI C-23 — `pathAnchors`/`elementGeometry` are PAGE-KEYED. Only a
//   REPLACED spine can throw an intermediate off the page (the default
//   spine runs between two on-page keys), so `fitToArtboard` matters
//   there and reports what it dropped.
// · TEXT FRAMES ARE REFUSED: no wire op copies a story and `insertPath`
//   mints Polygons — the symbols/pattern/repeat refusal, unchanged.
// · AN INTERMEDIATE IS ARTWORK, not a live link: its element ids are new
//   on every Update.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PathAnchorsResult,
  PluginMetadataEnvelope,
  MutationInput,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  affineRotate,
  affineTranslate,
  composeAffine,
  distributeAlongPath,
  ease,
  interpolateAnchors,
  measureAnchorRun,
  measureSegment,
  mixRgb,
  parseCssColor,
  pointAtFraction,
  rgbToHex,
  type Affine,
  type AnchorTriple,
  type EaseKind,
  type PathMetric,
  type Rgb,
  type Vec2,
} from "@paged-media/draw-geometry";

import { stampDrawMetadata } from "./appearance-bake";
import { compoundPaintOf, type CompoundPaint } from "./compound-path";
import { groupMutationFor, ungroupMutationFor } from "./group";
import { supportsPathOps } from "./path-ops";
import { repeatPageRect } from "./repeat";
import { leafIdsOf, valueForCriterion } from "./select-same";
import { insertPathMutationFor } from "../handlers/insert-path";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "./v59-wire";

export const BLEND_COMMAND_CATEGORY = "Blend";

/** MAKE. The id is v0's and is deliberately UNCHANGED: it is declared in
 *  the manifest and reachable from a host command palette, and renaming
 *  a published command to match a newer naming convention breaks callers
 *  for cosmetics. */
export const BLEND_COMMAND_ID = "media.paged.draw.command.blendSelected";
export const UPDATE_BLEND_COMMAND_ID = "media.paged.draw.command.updateBlend";
export const REPLACE_BLEND_SPINE_COMMAND_ID =
  "media.paged.draw.command.replaceBlendSpine";
export const REVERSE_BLEND_SPINE_COMMAND_ID =
  "media.paged.draw.command.reverseBlendSpine";
export const REVERSE_BLEND_ORDER_COMMAND_ID =
  "media.paged.draw.command.reverseBlendFrontToBack";
export const SELECT_BLEND_OBJECTS_COMMAND_ID =
  "media.paged.draw.command.selectBlendObjects";
export const EXPAND_BLEND_COMMAND_ID = "media.paged.draw.command.expandBlend";
export const RELEASE_BLEND_COMMAND_ID = "media.paged.draw.command.releaseBlend";

/** The contributed command ids, in registration order. */
export const BLEND_COMMAND_IDS = [
  BLEND_COMMAND_ID,
  UPDATE_BLEND_COMMAND_ID,
  REPLACE_BLEND_SPINE_COMMAND_ID,
  REVERSE_BLEND_SPINE_COMMAND_ID,
  REVERSE_BLEND_ORDER_COMMAND_ID,
  SELECT_BLEND_OBJECTS_COMMAND_ID,
  EXPAND_BLEND_COMMAND_ID,
  RELEASE_BLEND_COMMAND_ID,
];

/** The default intermediate count — v0's fixed 3, now the fallback the
 *  `steps` mode starts at and the one Smooth Color degrades to when the
 *  key fills carry no readable colour. The NAME is v0's so nothing that
 *  imported it breaks. */
export const BLEND_STEPS = 3;

/** How many intermediates one blend may emit. A TYPED count above this
 *  refuses (a typo must not build a five-thousand-op batch); a DERIVED
 *  one — Smooth Color's colour distance, Specified Distance's arc-length
 *  division — CLAMPS, because those are data. */
export const BLEND_MAX_STEPS = 200;

/** The container part the recipes live in, relative to this plugin's
 *  namespace. The SIXTH in this repo, after graphic styles / symbols /
 *  live paint / pattern / repeat. */
export const BLEND_PART = "blend.json";

/** The recipe envelope version (an unknown version reads as an EMPTY
 *  library rather than a crash — the graphic-styles convention). */
export const BLEND_LIBRARY_VERSION = 1;

/** The capability the recipe rides. */
export const BLEND_FEATURE = "storage.parts@1";

/** What "live" does and does not mean here. Exported so the panel shows
 *  it and a conformance test pins the WORDING. */
export const BLEND_LIVE_NOTE =
  "A BLEND HERE IS NOT A LIVE OBJECT. The engine has no blend node: what " +
  "a blend produces is real artwork — one inserted path per intermediate " +
  "— plus a recipe that remembers how to rebuild it. Editing a key object " +
  "does NOT re-render the intermediates; Update does, by re-reading both " +
  "keys' geometry and paint. The panel's preview is a preview of the " +
  "PLAN (the resolved step count, the spine length and where the count " +
  "came from), recomputed as you change the options — not of the artwork, " +
  "because re-rendering per keystroke would be one document mutation, and " +
  "one undo step, per keystroke.";

/** What the spine is, and the two places this deliberately differs from
 *  Illustrator. Pinned by a test. */
export const BLEND_SPINE_NOTE =
  "THE SPINE is the path the intermediates follow; by default it is the " +
  "straight line between the two key objects, and that default is inert — " +
  "a default-options blend places exactly what a straight interpolation " +
  "would. Replace Spine swaps in a selected path. Two differences from " +
  "Illustrator, on purpose: the replacement path KEEPS ITS OWN PAINT " +
  "(clearing a stroke you drew, unasked, is a worse surprise than a " +
  "visible spine), and it is NOT put inside the blend's group, so it " +
  "stays selectable and editable — which is the whole reason to replace " +
  "a spine. Reverse Spine flips which end each key's shape travels " +
  "toward; Reverse Front-to-Back flips PAINT ORDER only and moves " +
  "nothing, because insertion order is paint order.";

// ---------------------------------------------------------------- model

/** How the intermediate COUNT is arrived at (the three §16.2 modes). */
export type BlendSpacing = "smoothColor" | "steps" | "distance";

/** Whether an intermediate is turned to follow the spine. */
export type BlendOrientation = "page" | "path";

export const BLEND_SPACINGS: readonly BlendSpacing[] = [
  "smoothColor",
  "steps",
  "distance",
];

export const BLEND_ORIENTATIONS: readonly BlendOrientation[] = ["page", "path"];

/** Everything the §16.2 row asks a blend to expose. */
export interface BlendParams {
  spacing: BlendSpacing;
  /** `steps` mode: the intermediate count. */
  steps: number;
  /** `distance` mode: the arc-length gap between consecutive objects. */
  distancePt: number;
  orientation: BlendOrientation;
  easing: EaseKind;
  /** 0 = no easing at all (the identity, for every kind); 1 = the full
   *  curve. */
  easingStrength: number;
  /** INDEPENDENT COLOUR ACCELERATION: `null` means colour follows the
   *  SHAPE's easing (not independent). Anything else gives colour its
   *  own curve, so a blend can move evenly while its colour accelerates. */
  colorEasing: EaseKind | null;
  colorEasingStrength: number;
  /** Travel the spine from the far end. */
  reverseSpine: boolean;
  /** Emit the intermediates in the other order, i.e. flip paint order. */
  reverseFrontToBack: boolean;
  /** Drop intermediates that would not land fully inside the page
   *  (RFI C-23). Only a REPLACED spine can produce one. */
  fitToArtboard: boolean;
}

export const BLEND_DEFAULTS: BlendParams = {
  spacing: "steps",
  steps: BLEND_STEPS,
  distancePt: 24,
  orientation: "page",
  easing: "linear",
  easingStrength: 1,
  colorEasing: null,
  colorEasingStrength: 1,
  reverseSpine: false,
  reverseFrontToBack: false,
  fitToArtboard: true,
};

/** One saved blend — the RECIPE, not the artwork. */
export interface BlendRecord {
  id: string;
  name: string;
  params: BlendParams;
  /** The two KEY objects, in blend order. */
  keys: { kind: string; id: string }[];
  /** The replaced spine, or null for the straight-line default. */
  spine: { kind: string; id: string } | null;
  /** The materialised intermediates, in EMISSION (= paint) order. */
  steps: { kind: string; id: string }[];
}

export interface BlendLibrary {
  v: number;
  blends: BlendRecord[];
}

/** The link a KEY object carries. */
export interface BlendKeyRef {
  blend: string;
  index: number;
}

/** The link one materialised INTERMEDIATE carries. */
export interface BlendStepRef {
  blend: string;
  /** 1-based ordinal from key 0 toward key 1. */
  index: number;
  /** The eased shape parameter it was built at. */
  t: number;
}

/** The link the SPINE path carries. */
export interface BlendSpineRef {
  blend: string;
}

const emptyLibrary = (): BlendLibrary => ({
  v: BLEND_LIBRARY_VERSION,
  blends: [],
});

// -------------------------------------------------- v0: the structure gate

/** One source path normalized to PAGE space: per-subpath anchor runs +
 *  open flags. (v0's shape, unchanged — the interpolation still needs
 *  exactly this and nothing more.) */
export interface BlendSource {
  subpaths: AnchorTriple[][];
  open: boolean[];
}

/** Normalize a pathAnchors read into page-space subpath runs. */
export function blendSourceFrom(table: PathAnchorsResult): BlendSource {
  const m = table.itemTransform ?? null;
  const toPage = (p: readonly [number, number]): [number, number] =>
    m ? (applyAffine(m, p[0], p[1]) as [number, number]) : [p[0], p[1]];
  const starts = table.subpathStarts.length ? table.subpathStarts : [0];
  const subpaths: AnchorTriple[][] = [];
  const open: boolean[] = [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : table.anchors.length;
    subpaths.push(
      table.anchors.slice(begin, end).map((a) => ({
        anchor: toPage(a.anchor),
        left: toPage(a.left),
        right: toPage(a.right),
      })),
    );
    open.push(table.subpathOpen?.[s] ?? false);
  }
  return { subpaths, open };
}

/** Do two sources blend? Same subpath count, same anchor count per
 *  subpath, same open flags. v1 still REFUSES a mismatch rather than
 *  inventing a correspondence. */
export function blendStructureMatches(a: BlendSource, b: BlendSource): boolean {
  if (a.subpaths.length !== b.subpaths.length) return false;
  for (let i = 0; i < a.subpaths.length; i++) {
    if (a.subpaths[i].length !== b.subpaths[i].length) return false;
    if (a.open[i] !== b.open[i]) return false;
  }
  return true;
}

/** The control-point hull of a source, `[minX, minY, maxX, maxY]`. */
export function blendSourceBounds(
  source: BlendSource,
): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const run of source.subpaths) {
    for (const a of run) {
      for (const p of [a.anchor, a.left, a.right]) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

/** A source's centre in page space. */
export function blendSourceCenter(source: BlendSource): Vec2 {
  const [minX, minY, maxX, maxY] = blendSourceBounds(source);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// -------------------------------------------------------- pure: params

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const EASES: readonly EaseKind[] = ["linear", "easeIn", "easeOut", "easeInOut"];

const easeOr = (v: unknown, fallback: EaseKind): EaseKind =>
  EASES.includes(v as EaseKind) ? (v as EaseKind) : fallback;

/** Merge a loose payload over a base. Every value is clamped to
 *  something a plan can use, so a hostile payload degrades rather than
 *  producing a broken batch. Pure. */
export function blendParamsFrom(
  raw: unknown,
  base: BlendParams = BLEND_DEFAULTS,
): BlendParams {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof p[key] === "boolean" ? (p[key] as boolean) : fallback;
  const unit = (v: unknown, fallback: number): number =>
    Math.min(1, Math.max(0, num(v, fallback)));
  return {
    spacing: BLEND_SPACINGS.includes(p.spacing as BlendSpacing)
      ? (p.spacing as BlendSpacing)
      : base.spacing,
    steps: Math.max(1, Math.round(num(p.steps, base.steps))),
    distancePt: Math.max(0.01, num(p.distancePt, base.distancePt)),
    orientation: BLEND_ORIENTATIONS.includes(p.orientation as BlendOrientation)
      ? (p.orientation as BlendOrientation)
      : base.orientation,
    easing: easeOr(p.easing, base.easing),
    easingStrength: unit(p.easingStrength, base.easingStrength),
    colorEasing:
      p.colorEasing === null
        ? null
        : p.colorEasing === undefined
          ? base.colorEasing
          : easeOr(p.colorEasing, base.colorEasing ?? "linear"),
    colorEasingStrength: unit(p.colorEasingStrength, base.colorEasingStrength),
    reverseSpine: bool("reverseSpine", base.reverseSpine),
    reverseFrontToBack: bool("reverseFrontToBack", base.reverseFrontToBack),
    fitToArtboard: bool("fitToArtboard", base.fitToArtboard),
  };
}

// ------------------------------------------------ pure: the step count

/** Where a resolved step count CAME from — carried so the panel and the
 *  log can say it, and so a clamp or a fallback is never silent. */
export interface BlendStepCount {
  steps: number;
  /** The unclamped number the mode asked for. */
  requested: number;
  /** The mode's own explanation, e.g. "smooth colour: 255 (the largest
   *  channel difference)". */
  why: string;
  /** True when the count was reduced to {@link BLEND_MAX_STEPS}. */
  clamped: boolean;
  /** True when the mode could not do its own derivation and fell back. */
  degraded: boolean;
}

/** Smooth Color's derivation: the LARGEST per-channel difference between
 *  the two key fills — how many 1/255 steps it takes to get from one to
 *  the other without banding. Null in, and there is no colour distance
 *  to measure. Pure. */
export function smoothColorSteps(a: Rgb | null, b: Rgb | null): number | null {
  if (!a || !b) return null;
  const d = Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
  return Math.max(1, Math.round(d));
}

/** Resolve the intermediate count for `params` over a spine of
 *  `spineLength` and a key-fill pair. Pure — the three modes' whole
 *  arithmetic, so the panel previews exactly what Make will build.
 *
 *  A TYPED count above the ceiling answers `steps: 0` (a refusal the
 *  caller reports); a DERIVED one clamps. */
export function blendStepCountFor(args: {
  params: BlendParams;
  spineLength: number;
  fromRgb: Rgb | null;
  toRgb: Rgb | null;
}): BlendStepCount {
  const { params } = args;
  const clampDerived = (
    requested: number,
    why: string,
    degraded = false,
  ): BlendStepCount => ({
    steps: Math.min(BLEND_MAX_STEPS, Math.max(1, requested)),
    requested,
    why,
    clamped: requested > BLEND_MAX_STEPS,
    degraded,
  });

  if (params.spacing === "steps") {
    const requested = Math.max(1, Math.round(params.steps));
    if (requested > BLEND_MAX_STEPS) {
      return {
        steps: 0,
        requested,
        why:
          `specified steps: ${requested} — past this plugin's ` +
          `${BLEND_MAX_STEPS}-intermediate ceiling. Refused rather than ` +
          "truncated (a derived count clamps; a typed one does not)",
        clamped: false,
        degraded: false,
      };
    }
    return {
      steps: requested,
      requested,
      why: `specified steps: ${requested}`,
      clamped: false,
      degraded: false,
    };
  }

  if (params.spacing === "distance") {
    if (!(args.spineLength > 0)) {
      return clampDerived(
        BLEND_STEPS,
        `specified distance: the spine has no measurable length, so the ` +
          `gap could not be divided — falling back to ${BLEND_STEPS}`,
        true,
      );
    }
    // N intermediates make N + 1 gaps along the spine.
    const gaps = Math.round(args.spineLength / params.distancePt);
    const requested = Math.max(1, gaps - 1);
    return clampDerived(
      requested,
      `specified distance: ${params.distancePt} pt over a ` +
        `${args.spineLength.toFixed(1)} pt spine → ${requested}`,
    );
  }

  const derived = smoothColorSteps(args.fromRgb, args.toRgb);
  if (derived === null) {
    return clampDerived(
      BLEND_STEPS,
      "smooth colour: neither key fill resolves to an RGB colour, so " +
        "there is no colour distance to divide — falling back to " +
        `${BLEND_STEPS}. (Only swatches whose NAME parses as a CSS colour ` +
        "are readable here — the io/svg convention.)",
      true,
    );
  }
  return clampDerived(
    derived,
    `smooth colour: ${derived} (the largest per-channel difference between ` +
      "the two key fills)",
  );
}

// ------------------------------------------------------- pure: the plan

/** One key object, resolved. */
export interface BlendKey {
  id: ElementId;
  source: BlendSource;
  paint: CompoundPaint;
  center: Vec2;
  /** The fill as RGB, when the swatch name parses as a CSS colour. */
  rgb: Rgb | null;
  /** The stroke as RGB, likewise. */
  strokeRgb: Rgb | null;
}

/** One resolved intermediate: its geometry (already in page space) and
 *  the paint it will be given. */
export interface BlendStep {
  /** 1-based ordinal from key 0 toward key 1. */
  index: number;
  /** The eased SHAPE parameter. */
  t: number;
  /** The spine fraction it sits at (reverse-spine already applied). */
  u: number;
  subpaths: AnchorTriple[][];
  open: boolean[];
  /** A swatch to MINT for this step's fill, or null (then `fillRef`). */
  mintFill: { selfId: string; name: string } | null;
  fillRef: string | null;
  mintStroke: { selfId: string; name: string } | null;
  strokeRef: string | null;
  strokeWeight: number | null;
}

export interface BlendPlan {
  pageId: string;
  blend: string;
  params: BlendParams;
  keys: [BlendKey, BlendKey];
  /** The replaced spine element, or null for the straight-line default. */
  spineId: ElementId | null;
  spineLength: number;
  count: BlendStepCount;
  /** In EMISSION order — `reverseFrontToBack` has already been applied. */
  steps: BlendStep[];
  /** Intermediates the artboard fit removed — reported, never silent. */
  dropped: number;
}

/** A unique-enough swatch id nonce (the io/svg mint pattern). */
let swatchSeq = 0;
function mintBlendSwatchId(): string {
  const n = `${Date.now().toString(16)}${(swatchSeq++).toString(16)}`;
  return `Color/udrawblend${n}`;
}

/** Reset the swatch-id nonce. Test-only — the ids are otherwise
 *  time-seeded, which is exactly what a wire-shape assertion cannot
 *  have. */
export function resetBlendSwatchSeq(): void {
  swatchSeq = 0;
}

/** The straight-line spine between two keys — the DEFAULT, expressed
 *  through the shared kernel so nothing downstream has a "no spine"
 *  branch. Pure. */
export function defaultSpineFor(
  keys: readonly [BlendKey, BlendKey],
): PathMetric {
  return measureSegment(keys[0].center, keys[1].center);
}

/**
 * THE PLANNER — the pure half of a blend: two resolved keys, a spine
 * metric and a step count in, the intermediates' final page-space
 * geometry and paint out. Null when the structures do not match.
 *
 * The SHARED kernel does the spine work (`distributeAlongPath` with
 * `endpoints: "interior"`, so no intermediate ever lands on a key), and
 * everything above it is this module's own: the anchor interpolation,
 * the spine offset, the orientation rotation and the colour.
 */
export function blendStepsFor(args: {
  keys: readonly [BlendKey, BlendKey];
  params: BlendParams;
  spine: PathMetric;
  steps: number;
}): BlendStep[] | null {
  const [a, b] = args.keys;
  if (!blendStructureMatches(a.source, b.source)) return null;
  const { params } = args;
  const straight = measureSegment(a.center, b.center);
  const baselineDeg = pointAtFraction(straight, 0.5).tangentDeg;
  const slots = distributeAlongPath({
    metric: args.spine,
    mode: "count",
    count: args.steps,
    endpoints: "interior",
  });
  const out: BlendStep[] = [];
  slots.forEach((slot, i) => {
    // The kernel owns the interior rule (`k / (count + 1)`, never on a
    // key); easing then RE-PARAMETERIZES it, which is why the point is
    // looked up again below. With the default (inert) easing and no
    // reversal, `u === slot.u` and that lookup answers `slot` itself.
    const raw = slot.u;
    const t = ease(raw, params.easing, params.easingStrength);
    const u = params.reverseSpine ? 1 - t : t;
    const spinePoint = pointAtFraction(args.spine, u);
    const linePoint = pointAtFraction(straight, t);
    // The offset that puts the intermediate on the SPINE instead of the
    // straight line. Zero, exactly, on the default spine.
    let matrix: Affine = affineTranslate(
      spinePoint.point[0] - linePoint.point[0],
      spinePoint.point[1] - linePoint.point[1],
    );
    if (params.orientation === "path") {
      const turn = spinePoint.tangentDeg - baselineDeg;
      matrix = composeAffine(affineRotate(turn, spinePoint.point), matrix);
    }
    const subpaths: AnchorTriple[][] = [];
    for (let s = 0; s < a.source.subpaths.length; s++) {
      const run = interpolateAnchors(
        a.source.subpaths[s],
        b.source.subpaths[s],
        t,
      );
      subpaths.push(run.map((p) => mapTriple(p, matrix)));
    }
    const colorT = ease(
      raw,
      params.colorEasing ?? params.easing,
      params.colorEasing === null
        ? params.easingStrength
        : params.colorEasingStrength,
    );
    const fill = mixOrKeep(a.rgb, b.rgb, colorT, a.paint.fill);
    const stroke = mixOrKeep(a.strokeRgb, b.strokeRgb, colorT, a.paint.stroke);
    out.push({
      index: i + 1,
      t,
      u,
      subpaths,
      open: [...a.source.open],
      mintFill: fill.mint,
      fillRef: fill.ref,
      mintStroke: stroke.mint,
      strokeRef: stroke.ref,
      strokeWeight:
        typeof a.paint.weight === "number" && typeof b.paint.weight === "number"
          ? a.paint.weight + (b.paint.weight - a.paint.weight) * colorT
          : (a.paint.weight ?? null),
    });
  });
  return params.reverseFrontToBack ? out.reverse() : out;
}

function mapTriple(p: AnchorTriple, m: Affine): AnchorTriple {
  const at = (v: readonly [number, number]): [number, number] => [
    m[0] * v[0] + m[2] * v[1] + m[4],
    m[1] * v[0] + m[3] * v[1] + m[5],
  ];
  return { anchor: at(p.anchor), left: at(p.left), right: at(p.right) };
}

/** Interpolate two colours when BOTH resolve, else keep the first key's
 *  ref verbatim (v0's rule, now applied to stroke as well as fill). */
function mixOrKeep(
  from: Rgb | null,
  to: Rgb | null,
  t: number,
  keepRef: string | null,
): { mint: { selfId: string; name: string } | null; ref: string | null } {
  if (from && to) {
    const rgb = mixRgb(from, to, t);
    // Name = the hex (the io/svg convention, so the SVG exporter
    // resolves the ref back).
    return {
      mint: { selfId: mintBlendSwatchId(), name: rgbToHex(rgb) },
      ref: null,
    };
  }
  return { mint: null, ref: keepRef };
}

/** The control-point hull of one planned step. Pure. */
export function blendStepBounds(
  step: BlendStep,
): [number, number, number, number] {
  return blendSourceBounds({ subpaths: step.subpaths, open: step.open });
}

// ------------------------------------------------- pure: the container part

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const idListFrom = (v: unknown): { kind: string; id: string }[] => {
  const out: { kind: string; id: string }[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const r = (raw ?? {}) as { kind?: unknown; id?: unknown };
    const kind = strOrNull(r.kind);
    const id = strOrNull(r.id);
    if (kind && id) out.push({ kind, id });
  }
  return out;
};

/** Parse the recipe part's bytes. Anything unreadable reads as an EMPTY
 *  library: a recipe that fails to parse must never take the document
 *  with it. Pure. */
export function parseBlendLibrary(bytes: Uint8Array | null): BlendLibrary {
  if (!bytes || bytes.byteLength === 0) return emptyLibrary();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return emptyLibrary();
  }
  const lib = raw as Partial<BlendLibrary> | null;
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (lib.v !== BLEND_LIBRARY_VERSION) return emptyLibrary();
  const blends: BlendRecord[] = [];
  for (const entry of Array.isArray(lib.blends) ? lib.blends : []) {
    const r = (entry ?? {}) as Partial<BlendRecord>;
    if (typeof r.id !== "string" || r.id.length === 0) continue;
    const spine = (r.spine ?? null) as { kind?: unknown; id?: unknown } | null;
    const sk = spine ? strOrNull(spine.kind) : null;
    const si = spine ? strOrNull(spine.id) : null;
    blends.push({
      id: r.id,
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : r.id,
      params: blendParamsFrom(r.params),
      keys: idListFrom(r.keys),
      spine: sk && si ? { kind: sk, id: si } : null,
      steps: idListFrom(r.steps),
    });
  }
  return { v: BLEND_LIBRARY_VERSION, blends };
}

export function serializeBlendLibrary(library: BlendLibrary): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      { v: BLEND_LIBRARY_VERSION, blends: library.blends },
      null,
      2,
    )}\n`,
  );
}

/** The next free `bl-N` id. Deterministic. Pure. */
export function mintBlendId(library: BlendLibrary): string {
  let max = 0;
  for (const r of library.blends) {
    const m = /^bl-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `bl-${max + 1}`;
}

export function findBlendRecord(
  library: BlendLibrary,
  id: string,
): BlendRecord | null {
  return library.blends.find((r) => r.id === id) ?? null;
}

export function upsertBlendRecord(
  library: BlendLibrary,
  record: BlendRecord,
): BlendLibrary {
  const blends = library.blends.slice();
  const at = blends.findIndex((r) => r.id === record.id);
  if (at >= 0) blends[at] = record;
  else blends.push(record);
  return { v: BLEND_LIBRARY_VERSION, blends };
}

export function removeBlendRecordFrom(
  library: BlendLibrary,
  id: string,
): BlendLibrary {
  return {
    v: BLEND_LIBRARY_VERSION,
    blends: library.blends.filter((r) => r.id !== id),
  };
}

// ---------------------------------------------- pure: the element links

export function blendKeyOf(
  env: PluginMetadataEnvelope | null,
): BlendKeyRef | null {
  const raw = (env?.data as { blendKey?: unknown } | undefined)?.blendKey;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BlendKeyRef>;
  if (typeof r.blend !== "string") return null;
  return { blend: r.blend, index: num(r.index, 0) };
}

export function blendStepOf(
  env: PluginMetadataEnvelope | null,
): BlendStepRef | null {
  const raw = (env?.data as { blendStep?: unknown } | undefined)?.blendStep;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BlendStepRef>;
  if (typeof r.blend !== "string") return null;
  return { blend: r.blend, index: num(r.index, 0), t: num(r.t, 0) };
}

export function blendSpineOf(
  env: PluginMetadataEnvelope | null,
): BlendSpineRef | null {
  const raw = (env?.data as { blendSpine?: unknown } | undefined)?.blendSpine;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BlendSpineRef>;
  return typeof r.blend === "string" ? { blend: r.blend } : null;
}

export type BlendKeyName = "blendKey" | "blendStep" | "blendSpine";

/** Merge (or, with `null`, DROP) a blend key in an envelope, preserving
 *  every OTHER draw metadata key. Pure. */
export function withBlendKey(
  prev: PluginMetadataEnvelope | null,
  key: BlendKeyName,
  ref: BlendKeyRef | BlendStepRef | BlendSpineRef | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (ref === null) {
    delete data[key];
    if (Object.keys(data).length === 0) return null;
  } else {
    data[key] = ref;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

// ------------------------------------------------------- wire builders

const colorRef = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

/** The batch-local handle for step `i`'s subpath `s`. Deterministic, so
 *  the conformance spec asserts the exact emitted wire. Pure. */
export const blendHandle = (step: number, subpath: number): string =>
  `bs${step}_${subpath}`;

/** The previous generation an Update replaces. Read from the tree and
 *  the recipe BEFORE the batch is built. */
export interface BlendGeneration {
  group: ElementId | null;
  steps: ElementId[];
}

/**
 * THE BUILD BATCH — Make and Update both ride it, in the ONE order the
 * engine accepts:
 *
 *   1. every INTERMEDIATE — its swatches, one `insertPath` +
 *      `bindCreated` per subpath, then the paint and the link, all
 *      addressing the freshly minted ids by handle. Emission order IS
 *      paint order, so `reverseFrontToBack` has already reordered
 *      `plan.steps`;
 *   2. the PREVIOUS generation (Update only) — dissolve its group, then
 *      delete its intermediates. INSERTS RIDE BEFORE DELETES, because a
 *      batch that deletes and then inserts is refused ("position N out
 *      of range for parent Spread");
 *   3. the KEY links (and the SPINE link, when there is one);
 *   4. the GROUP — the two keys plus every intermediate. The SPINE is
 *      deliberately NOT in it (module header).
 *
 * ONE batch ⇒ ONE undo step, however many intermediates.
 */
export function blendBatchFor(args: {
  plan: BlendPlan;
  keyEnvelopes: readonly (PluginMetadataEnvelope | null)[];
  spineEnvelope?: PluginMetadataEnvelope | null;
  previous?: BlendGeneration | null;
}): MutationInput {
  const { plan } = args;
  const ops: MutationInput[] = [];

  plan.steps.forEach((step, i) => {
    for (const mint of [step.mintFill, step.mintStroke]) {
      if (!mint) continue;
      const rgb = parseCssColor(mint.name);
      ops.push({
        op: "createSwatch",
        args: {
          spec: {
            selfId: mint.selfId,
            name: mint.name,
            space: "RGB",
            value: [rgb?.[0] ?? 0, rgb?.[1] ?? 0, rgb?.[2] ?? 0],
          },
        },
      });
    }
    step.subpaths.forEach((run, s) => {
      ops.push(insertPathMutationFor(plan.pageId, run, step.open[s] ?? false));
      ops.push(bindCreatedMutationFor(blendHandle(i, s)));
      const id = handleElementId(blendHandle(i, s));
      ops.push(
        colorRef(id, "frameFillColor", step.mintFill?.selfId ?? step.fillRef),
      );
      ops.push(
        colorRef(
          id,
          "frameStrokeColor",
          step.mintStroke?.selfId ?? step.strokeRef,
        ),
      );
      if (typeof step.strokeWeight === "number") {
        ops.push({
          op: "setElementProperty",
          args: {
            elementId: id,
            path: "frameStrokeWeight",
            value: { type: "length", value: step.strokeWeight },
          },
        });
      }
      ops.push(
        stampDrawMetadata(id, {
          v: 1,
          data: {
            blendStep: {
              blend: plan.blend,
              index: step.index,
              t: step.t,
            } satisfies BlendStepRef,
          },
        }),
      );
    });
  });

  const previous = args.previous ?? null;
  if (previous) {
    if (previous.group && typeof previous.group.id === "string") {
      ops.push(ungroupMutationFor(previous.group.id));
    }
    for (const id of previous.steps) {
      if (typeof id.id !== "string") continue;
      ops.push({ op: "deleteFrame", args: { frameId: id.id } });
    }
  }

  plan.keys.forEach((key, index) => {
    ops.push(
      stampDrawMetadata(
        key.id,
        withBlendKey(args.keyEnvelopes[index] ?? null, "blendKey", {
          blend: plan.blend,
          index,
        }),
      ),
    );
  });
  if (plan.spineId) {
    ops.push(
      stampDrawMetadata(
        plan.spineId,
        withBlendKey(args.spineEnvelope ?? null, "blendSpine", {
          blend: plan.blend,
        }),
      ),
    );
  }

  const members: ElementId[] = [plan.keys[0].id, plan.keys[1].id];
  plan.steps.forEach((step, i) => {
    step.subpaths.forEach((_run, s) => {
      members.push(handleElementId(blendHandle(i, s)));
    });
  });
  if (members.length > 2) ops.push(groupMutationFor(members));
  return batchMutationFor(ops);
}

/** The EXPAND batch — stop tracking, keep every piece of artwork. Drops
 *  the key / step / spine links and nothing else. ONE batch ⇒ 1 undo
 *  step. */
export function blendExpandBatchFor(
  leaves: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: BlendKeyName;
  }[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: leaves.map((leaf) =>
        stampDrawMetadata(leaf.id, withBlendKey(leaf.envelope, leaf.key, null)),
      ),
    },
  };
}

/** The RELEASE batch — remove the intermediates, keep the two KEY
 *  objects (and the spine) exactly as they were. In the ONE order the
 *  engine accepts: dissolve the group BEFORE its members are deleted
 *  (deleting first leaves the group holding a hole and the dissolve is
 *  refused), then delete, then unlink. ONE batch ⇒ 1 undo step. */
export function blendReleaseBatchFor(args: {
  group?: ElementId | null;
  steps: readonly ElementId[];
  links: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: BlendKeyName;
  }[];
}): MutationInput {
  const ops: MutationInput[] = [];
  if (args.group && typeof args.group.id === "string") {
    ops.push(ungroupMutationFor(args.group.id));
  }
  for (const id of args.steps) {
    if (typeof id.id !== "string") continue;
    ops.push({ op: "deleteFrame", args: { frameId: id.id } });
  }
  for (const link of args.links) {
    ops.push(
      stampDrawMetadata(link.id, withBlendKey(link.envelope, link.key, null)),
    );
  }
  return batchMutationFor(ops);
}

// -------------------------------------------------------- host: the part

type PartsHost = Pick<BundleHost, "parts" | "supports" | "log">;

/** Read the records out of the container part. A host with no container
 *  writer is not an error: it reads as an EMPTY library and WARNS. */
export async function readBlendLibrary(host: PartsHost): Promise<BlendLibrary> {
  if (!host.supports(BLEND_FEATURE)) {
    host.log.warn(
      "blend: this host wires no `.paged` container writer " +
        `(supports("${BLEND_FEATURE}") is false) — a blend's options cannot ` +
        "be saved here, so it can be expanded or released through its links " +
        "but not updated without naming them again",
    );
    return emptyLibrary();
  }
  try {
    return parseBlendLibrary(await host.parts.read(BLEND_PART));
  } catch (e) {
    host.log.warn(`blend: recipe read failed (${String(e)})`);
    return emptyLibrary();
  }
}

export async function writeBlendLibrary(
  host: PartsHost,
  library: BlendLibrary,
): Promise<boolean> {
  if (!host.supports(BLEND_FEATURE)) return false;
  try {
    await host.parts.write(BLEND_PART, serializeBlendLibrary(library));
    return true;
  } catch (e) {
    host.log.warn(`blend: recipe write failed (${String(e)})`);
    return false;
  }
}

// -------------------------------------------------- host: document reads

// The page rect comes from `repeatPageRect` (commands/repeat.ts). It is
// exactly the same read — the `pages` collection's `sizePt`, with page
// space starting at (0, 0) because the engine reports a page SIZE and no
// ORIGIN — and a second copy of it here would be a second thing to get
// wrong when that changes.

/** Resolve a fill/stroke ref to an RGB triple through the swatch
 *  collection (swatch NAME parses as a CSS colour — the narrow-facade
 *  lane io/svg documents). Null = not hex-able. */
async function refRgbOf(
  host: BundleHost,
  ref: string | null,
): Promise<Rgb | null> {
  if (!ref) return null;
  try {
    const swatches = await host.document.collection<{
      selfId: string;
      name: string;
    }>("swatches");
    const sw = swatches.find((s) => s.selfId === ref);
    if (!sw) return null;
    return parseCssColor(sw.name);
  } catch {
    return null;
  }
}

/** Resolve one key object. Null = no readable geometry. */
export async function blendKeyOfElement(
  host: BundleHost,
  id: ElementId,
): Promise<{ key: BlendKey; pageId: string } | null> {
  const table = await host.document.pathAnchors(id).catch(() => null);
  if (!table || table.anchors.length < 2) return null;
  const source = blendSourceFrom(table);
  const paint = await compoundPaintOf(host, id);
  const fillRef =
    paint.fill ??
    ((await valueForCriterion(host, id, "fill").catch(() => null)) as
      string | null);
  return {
    pageId: table.pageId,
    key: {
      id,
      source,
      paint,
      center: blendSourceCenter(source),
      rgb: await refRgbOf(host, typeof fillRef === "string" ? fillRef : null),
      strokeRgb: await refRgbOf(host, paint.stroke),
    },
  };
}

/** Every leaf carrying a blend link, split by which one. `blend`
 *  filters; omit it for every blend. */
export async function blendLinks(
  host: BundleHost,
  blend?: string,
): Promise<{
  keys: { id: ElementId; ref: BlendKeyRef }[];
  steps: { id: ElementId; ref: BlendStepRef }[];
  spines: { id: ElementId; ref: BlendSpineRef }[];
}> {
  const keys: { id: ElementId; ref: BlendKeyRef }[] = [];
  const steps: { id: ElementId; ref: BlendStepRef }[] = [];
  const spines: { id: ElementId; ref: BlendSpineRef }[] = [];
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const key = blendKeyOf(env);
    if (key && (blend === undefined || key.blend === blend)) {
      keys.push({ id, ref: key });
    }
    const step = blendStepOf(env);
    if (step && (blend === undefined || step.blend === blend)) {
      steps.push({ id, ref: step });
    }
    const spine = blendSpineOf(env);
    if (spine && (blend === undefined || spine.blend === blend)) {
      spines.push({ id, ref: spine });
    }
  }
  keys.sort((a, b) => a.ref.index - b.ref.index);
  return { keys, steps, spines };
}

/** The group node holding `member`, or null — a BATCH outcome does not
 *  echo an inner `createGroup`'s id, so the tree is the source of truth
 *  (and the measured C-15 group edge is why this is read BEFORE a batch
 *  rather than bound inside one). */
export async function blendGroupOf(
  host: BundleHost,
  member: ElementId,
): Promise<ElementId | null> {
  const roots = await host.document.tree().catch(() => []);
  let found: ElementId | null = null;
  const walk = (
    nodes: readonly { id?: ElementId | null; children?: unknown }[],
  ) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as {
        id?: ElementId | null;
        children?: unknown;
      }[];
      if (
        node.id?.kind === "group" &&
        children.some((c) => c.id && c.id.id === member.id)
      ) {
        found = node.id;
        return;
      }
      if (children.length > 0) walk(children);
      if (found) return;
    }
  };
  walk(roots as never);
  return found;
}

/** Which blend a command acts on: the payload's `blendId`, else the
 *  selection's own link, else the only blend the document carries. */
export async function resolveBlend(
  host: BundleHost,
  blendId: unknown,
): Promise<string | null> {
  if (typeof blendId === "string") return blendId;
  for (const id of host.selection.get()) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const linked =
      blendKeyOf(env)?.blend ??
      blendStepOf(env)?.blend ??
      blendSpineOf(env)?.blend ??
      null;
    if (linked !== null) return linked;
  }
  const library = await readBlendLibrary(host);
  if (library.blends.length === 1) return library.blends[0]!.id;
  const links = await blendLinks(host);
  const distinct = new Set([
    ...links.keys.map((k) => k.ref.blend),
    ...links.steps.map((s) => s.ref.blend),
  ]);
  return distinct.size === 1 ? [...distinct][0]! : null;
}

/** The previous generation of `blend`, read BEFORE a re-plan builds its
 *  batch. */
export async function blendGenerationOf(
  host: BundleHost,
  blend: string,
): Promise<BlendGeneration> {
  const links = await blendLinks(host, blend);
  const anchor = links.keys[0]?.id ?? links.steps[0]?.id ?? null;
  return {
    group: anchor ? await blendGroupOf(host, anchor) : null,
    steps: links.steps.map((s) => s.id),
  };
}

// ------------------------------------------------------------- planning

/** Resolve keys + spine + params into a plan, or null (a refusal,
 *  already logged). Shared by Make and Update. */
export async function blendPlanFor(
  host: BundleHost,
  args: {
    blend: string;
    params: BlendParams;
    keyIds: readonly ElementId[];
    spineId: ElementId | null;
    label: string;
  },
): Promise<BlendPlan | null> {
  const { label } = args;
  if (args.keyIds.length !== 2) {
    host.log.warn(
      `${label}: a blend needs exactly 2 key objects (got ` +
        `${args.keyIds.length}) — no-op`,
    );
    return null;
  }
  for (const id of args.keyIds) {
    if (id.kind === "textFrame") {
      host.log.warn(
        `${label}: ${String(id.id)} is a text frame — no wire op copies a ` +
          "story and an intermediate is an insertPath Polygon, so text " +
          "cannot be blended; no-op",
      );
      return null;
    }
  }
  const resolved: BlendKey[] = [];
  let pageId: string | null = null;
  for (const id of args.keyIds) {
    const read = await blendKeyOfElement(host, id);
    if (!read) {
      host.log.warn(
        `${label}: ${id.kind} ${String(id.id)} exposes no readable path ` +
          "geometry — no-op",
      );
      return null;
    }
    if (pageId !== null && read.pageId !== pageId) {
      host.log.warn(
        `${label}: both key objects need readable geometry on the SAME page ` +
          "— no-op",
      );
      return null;
    }
    pageId = read.pageId;
    resolved.push(read.key);
  }
  const keys = resolved as [BlendKey, BlendKey];
  if (!blendStructureMatches(keys[0].source, keys[1].source)) {
    host.log.warn(
      `${label}: structures differ ` +
        `(${keys[0].source.subpaths.map((s) => s.length).join("+")} vs ` +
        `${keys[1].source.subpaths.map((s) => s.length).join("+")} anchors) — ` +
        "a blend interpolates anchor for anchor, so it blends only matching " +
        "subpath counts, anchor counts and open flags. Resampling both keys " +
        "to a common parameterization is a real feature and is NOT built; " +
        "no-op",
    );
    return null;
  }

  // The spine: a replaced path, or the straight line between the keys.
  let spine = defaultSpineFor(keys);
  let spineId = args.spineId;
  if (spineId) {
    const table = await host.document.pathAnchors(spineId).catch(() => null);
    if (!table || table.anchors.length < 2) {
      host.log.warn(
        `${label}: the spine ${String(spineId.id)} exposes no readable ` +
          "geometry — falling back to the straight line between the keys",
      );
      spineId = null;
    } else {
      const source = blendSourceFrom(table);
      spine = measureAnchorRun(source.subpaths[0], {
        close: !(source.open[0] ?? false),
      });
      if (!(spine.length > 0)) {
        host.log.warn(
          `${label}: the spine ${String(spineId.id)} has no measurable ` +
            "length — falling back to the straight line between the keys",
        );
        spine = defaultSpineFor(keys);
        spineId = null;
      }
    }
  }

  const count = blendStepCountFor({
    params: args.params,
    spineLength: spine.length,
    fromRgb: keys[0].rgb,
    toRgb: keys[1].rgb,
  });
  if (count.steps === 0) {
    host.log.warn(`${label}: ${count.why} — no-op`);
    return null;
  }
  if (count.clamped) {
    host.log.info(
      `${label}: ${count.why}, clamped to ${BLEND_MAX_STEPS} (a derived ` +
        "count clamps; a typed one refuses)",
    );
  } else if (count.degraded) {
    host.log.info(`${label}: ${count.why}`);
  }

  const steps = blendStepsFor({
    keys,
    params: args.params,
    spine,
    steps: count.steps,
  });
  if (!steps) return null; // unreachable post-check; kept for safety

  let placed = steps;
  let dropped = 0;
  if (args.params.fitToArtboard) {
    const page = await repeatPageRect(host, pageId!);
    if (!page) {
      host.log.warn(
        `${label}: the page rect for "${pageId}" is not readable, so the ` +
          "intermediates could not be fitted to the artboard — placing every " +
          "one. An off-page intermediate IS created, but pathAnchors/" +
          "elementGeometry answer nothing for it (RFI C-23)",
      );
    } else {
      placed = steps.filter((step) => {
        const [minX, minY, maxX, maxY] = blendStepBounds(step);
        return (
          minX >= 0 && minY >= 0 && maxX <= page.width && maxY <= page.height
        );
      });
      dropped = steps.length - placed.length;
      if (dropped > 0) {
        host.log.info(
          `${label}: ${dropped} of ${steps.length} intermediate(s) would land ` +
            `outside the ${page.width} × ${page.height} pt page and were ` +
            "dropped — an off-page item is real but page-keyed reads answer " +
            "nothing for it (RFI C-23). Pass fitToArtboard: false to place " +
            "them anyway. (Only a REPLACED spine can produce one: the default " +
            "spine runs between two on-page keys.)",
        );
      }
    }
  }
  if (placed.length === 0) {
    host.log.warn(
      `${label}: the plan places NO intermediates — nothing to build`,
    );
    return null;
  }

  return {
    pageId: pageId!,
    blend: args.blend,
    params: args.params,
    keys,
    spineId,
    spineLength: spine.length,
    count,
    steps: placed,
    dropped,
  };
}

// ------------------------------------------------------------ the emitter

export interface BlendBuild {
  steps: ElementId[];
  /** MEASURED, not claimed: one batch ⇒ one undo step. */
  undoSteps: number;
}

async function leafElements(host: BundleHost): Promise<ElementId[]> {
  return leafIdsOf(await host.document.tree().catch(() => []));
}

async function emitBlend(
  host: BundleHost,
  args: {
    plan: BlendPlan;
    label: string;
    previous?: BlendGeneration | null;
  },
): Promise<BlendBuild> {
  const { plan, label } = args;
  const before = new Set((await leafElements(host)).map((e) => String(e.id)));
  const keyEnvelopes = await Promise.all(
    plan.keys.map((k) => host.document.getMetadata(k.id).catch(() => null)),
  );
  const spineEnvelope = plan.spineId
    ? await host.document.getMetadata(plan.spineId).catch(() => null)
    : null;
  const outcome = await host.document.mutate(
    blendBatchFor({
      plan,
      keyEnvelopes,
      spineEnvelope,
      previous: args.previous ?? null,
    }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return { steps: [], undoSteps: 0 };
  }
  // A batch outcome carries ONE `createdId`, so the tree diff is the
  // honest enumeration (the repeat.ts / appearance-bake precedent).
  const minted = (await leafElements(host)).filter(
    (e) => !before.has(String(e.id)),
  );
  const steps: ElementId[] = [];
  for (const id of minted) {
    const env = await host.document.getMetadata(id).catch(() => null);
    if (blendStepOf(env)?.blend === plan.blend) steps.push(id);
  }
  const group = steps.length > 0 ? await blendGroupOf(host, steps[0]) : null;
  await host.selection.set(
    group ? [group] : [plan.keys[0].id, plan.keys[1].id, ...steps],
  );
  return { steps, undoSteps: 1 };
}

// ------------------------------------------------------------- appliers

const nameFor = (
  payload: Record<string, unknown>,
  fallback: string,
): string | null => {
  const raw = payload.name;
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : fallback === ""
      ? null
      : fallback;
};

const payloadOf = (payload: unknown): Record<string, unknown> =>
  (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;

async function saveBlend(
  host: BundleHost,
  args: {
    library: BlendLibrary;
    plan: BlendPlan;
    name: string;
    steps: readonly ElementId[];
  },
): Promise<boolean> {
  return writeBlendLibrary(
    host,
    upsertBlendRecord(args.library, {
      id: args.plan.blend,
      name: args.name,
      params: args.plan.params,
      keys: args.plan.keys.map((k) => ({
        kind: k.id.kind,
        id: String(k.id.id),
      })),
      spine: args.plan.spineId
        ? { kind: args.plan.spineId.kind, id: String(args.plan.spineId.id) }
        : null,
      steps: args.steps.map((s) => ({ kind: s.kind, id: String(s.id) })),
    }),
  );
}

/**
 * **MAKE** — blend the two selected key objects.
 *
 * Payload: any subset of {@link BlendParams} plus `{ name?, spineId? }`.
 * ONE batch ⇒ 1 undo step.
 */
export async function applyMakeBlend(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = BLEND_COMMAND_ID;
  const p = payloadOf(payload);
  const selection = host.selection.get();
  const paths = selection.filter(supportsPathOps);
  if (selection.length !== 2 || paths.length !== 2) {
    host.log.warn(
      `${label}: needs exactly 2 selected path elements ` +
        `(got ${selection.length} selected, ${paths.length} path-bearing) — no-op`,
    );
    return [];
  }
  const params = blendParamsFrom(p);
  const library = await readBlendLibrary(host);
  const blend = mintBlendId(library);
  const plan = await blendPlanFor(host, {
    blend,
    params,
    keyIds: paths,
    spineId: null,
    label,
  });
  if (!plan) return [];
  const built = await emitBlend(host, { plan, label });
  if (built.steps.length === 0) return [];
  const name = nameFor(p, "") ?? `Blend ${library.blends.length + 1}`;
  const saved = await saveBlend(host, {
    library,
    plan,
    name,
    steps: built.steps,
  });
  host.log.info(
    `${label}: "${name}" placed ${built.steps.length} intermediate(s) ` +
      `(${plan.count.why})` +
      `${plan.dropped > 0 ? ` — ${plan.dropped} dropped off-page` : ""} in ` +
      `${built.undoSteps} undo step(s). ` +
      (saved
        ? "The options are saved, so the blend can be updated."
        : "The options were NOT saved (no container writer) — the blend can " +
          "be expanded or released, but an update must name them again.") +
      " Editing a key object does not re-render the intermediates; Update does.",
  );
  return built.steps;
}

/**
 * **UPDATE** — rebuild an existing blend with new options and FRESH key
 * geometry. This is the honest stand-in for "live", and the lane every
 * other verb here funnels through.
 *
 * Payload: `{ blendId?, name?, spineId?, …params }`. ONE batch ⇒ 1 undo
 * step. Every intermediate gets a NEW element id.
 */
export async function applyUpdateBlend(
  host: BundleHost,
  payload?: unknown,
  labelOverride?: string,
): Promise<ElementId[]> {
  const label = labelOverride ?? UPDATE_BLEND_COMMAND_ID;
  const p = payloadOf(payload);
  const blend = await resolveBlend(host, p.blendId);
  if (blend === null) {
    host.log.warn(
      `${label}: no blend resolved from the payload or the selection — make ` +
        "one first",
    );
    return [];
  }
  const library = await readBlendLibrary(host);
  const saved = findBlendRecord(library, blend);
  const links = await blendLinks(host, blend);
  const keyIds =
    links.keys.length === 2
      ? links.keys.map((k) => k.id)
      : (saved?.keys.map((k) => ({ kind: k.kind, id: k.id }) as ElementId) ??
        []);
  if (keyIds.length !== 2) {
    host.log.warn(
      `${label}: "${blend}" no longer names two key objects — nothing to update`,
    );
    return [];
  }
  const params = blendParamsFrom(p, saved?.params ?? BLEND_DEFAULTS);
  // `spineId: null` in the payload CLEARS the spine (back to the straight
  // line); omitting it keeps whatever is saved.
  const spineId =
    p.spineId === null
      ? null
      : isElementId(p.spineId)
        ? (p.spineId as ElementId)
        : (links.spines[0]?.id ??
          (saved?.spine
            ? ({ kind: saved.spine.kind, id: saved.spine.id } as ElementId)
            : null));
  const previous = await blendGenerationOf(host, blend);
  const staleSpine =
    spineId === null && links.spines.length > 0 ? links.spines : [];
  const plan = await blendPlanFor(host, {
    blend,
    params,
    keyIds,
    spineId,
    label,
  });
  if (!plan) return [];
  const built = await emitBlend(host, { plan, label, previous });
  if (built.steps.length === 0) return [];
  // A spine that was dropped keeps a dangling link otherwise.
  if (staleSpine.length > 0) {
    await host.document.mutate(
      blendExpandBatchFor(
        await Promise.all(
          staleSpine.map(async (s) => ({
            id: s.id,
            envelope: await host.document.getMetadata(s.id).catch(() => null),
            key: "blendSpine" as const,
          })),
        ),
      ),
    );
  }
  const name = nameFor(p, "") ?? saved?.name ?? blend;
  await saveBlend(host, {
    library,
    plan,
    name,
    steps: built.steps,
  });
  host.log.info(
    `${label}: "${name}" updated in ${built.undoSteps} undo step(s) — ` +
      `${previous.steps.length} old intermediate(s) replaced by ` +
      `${built.steps.length} (${plan.count.why}). The intermediates carry ` +
      "NEW element ids",
  );
  return built.steps;
}

const isElementId = (v: unknown): boolean =>
  !!v &&
  typeof v === "object" &&
  typeof (v as ElementId).id === "string" &&
  typeof (v as ElementId).kind === "string";

/**
 * **REPLACE SPINE** — make a selected path the blend's spine (or, with
 * `{ spineId: null }`, drop back to the straight line). Rebuilds through
 * Update, so ONE batch ⇒ 1 undo step.
 *
 * The path is the payload's `spineId`, else the ONE selected element
 * that is neither a key nor an intermediate of the blend.
 */
export async function applyReplaceBlendSpine(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = REPLACE_BLEND_SPINE_COMMAND_ID;
  const p = payloadOf(payload);
  if (p.spineId === null) {
    return applyUpdateBlend(host, { ...p, spineId: null }, label);
  }
  const blend = await resolveBlend(host, p.blendId);
  if (blend === null) {
    host.log.warn(`${label}: no blend resolved — make one first`);
    return [];
  }
  let spineId = isElementId(p.spineId) ? (p.spineId as ElementId) : null;
  if (!spineId) {
    const links = await blendLinks(host, blend);
    const owned = new Set([
      ...links.keys.map((k) => String(k.id.id)),
      ...links.steps.map((s) => String(s.id.id)),
    ]);
    const candidates = host.selection
      .get()
      .filter((id) => supportsPathOps(id) && !owned.has(String(id.id)));
    if (candidates.length !== 1) {
      host.log.warn(
        `${label}: select exactly ONE path that is not part of the blend to ` +
          `use as its spine (found ${candidates.length}) — no-op`,
      );
      return [];
    }
    spineId = candidates[0];
  }
  return applyUpdateBlend(host, { ...p, blendId: blend, spineId }, label);
}

/** **REVERSE SPINE** — travel the spine from the other end. Geometry
 *  moves. Rebuilds through Update: ONE batch ⇒ 1 undo step. */
export async function applyReverseBlendSpine(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = REVERSE_BLEND_SPINE_COMMAND_ID;
  const p = payloadOf(payload);
  const blend = await resolveBlend(host, p.blendId);
  if (blend === null) {
    host.log.warn(`${label}: no blend resolved — make one first`);
    return [];
  }
  const saved = findBlendRecord(await readBlendLibrary(host), blend);
  const current = saved?.params.reverseSpine ?? BLEND_DEFAULTS.reverseSpine;
  return applyUpdateBlend(
    host,
    { ...p, blendId: blend, reverseSpine: !current },
    label,
  );
}

/** **REVERSE FRONT-TO-BACK** — flip PAINT ORDER only. Nothing moves. It
 *  costs no `reorderElement` because insertion order IS paint order, so
 *  the rebuild simply emits the intermediates the other way round: ONE
 *  batch ⇒ 1 undo step. */
export async function applyReverseBlendOrder(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = REVERSE_BLEND_ORDER_COMMAND_ID;
  const p = payloadOf(payload);
  const blend = await resolveBlend(host, p.blendId);
  if (blend === null) {
    host.log.warn(`${label}: no blend resolved — make one first`);
    return [];
  }
  const saved = findBlendRecord(await readBlendLibrary(host), blend);
  const current =
    saved?.params.reverseFrontToBack ?? BLEND_DEFAULTS.reverseFrontToBack;
  return applyUpdateBlend(
    host,
    { ...p, blendId: blend, reverseFrontToBack: !current },
    label,
  );
}

/** **SELECT** — put a blend's KEY objects (the default — this is how you
 *  "edit individual objects": select them, edit them, Update), or its
 *  intermediates, or its spine, on the selection. No mutation. */
export async function applySelectBlendObjects(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = SELECT_BLEND_OBJECTS_COMMAND_ID;
  const p = payloadOf(payload);
  const blend = await resolveBlend(host, p.blendId);
  if (blend === null) {
    host.log.warn(`${label}: no blend resolved — no-op`);
    return [];
  }
  const which = typeof p.which === "string" ? p.which : "keys";
  const links = await blendLinks(host, blend);
  const ids =
    which === "steps"
      ? links.steps.map((s) => s.id)
      : which === "spine"
        ? links.spines.map((s) => s.id)
        : which === "all"
          ? [
              ...links.keys.map((k) => k.id),
              ...links.steps.map((s) => s.id),
              ...links.spines.map((s) => s.id),
            ]
          : links.keys.map((k) => k.id);
  if (ids.length === 0) {
    host.log.debug(`${label}: "${blend}" has no ${which} on the page — no-op`);
  }
  await host.selection.set(ids);
  return ids;
}

async function linkLeavesOf(
  host: BundleHost,
  blend: string,
): Promise<
  {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: BlendKeyName;
  }[]
> {
  const links = await blendLinks(host, blend);
  const out: {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: BlendKeyName;
  }[] = [];
  for (const [list, key] of [
    [links.keys, "blendKey"],
    [links.steps, "blendStep"],
    [links.spines, "blendSpine"],
  ] as const) {
    for (const entry of list) {
      out.push({
        id: entry.id,
        envelope: await host.document.getMetadata(entry.id).catch(() => null),
        key,
      });
    }
  }
  return out;
}

/** **EXPAND** — stop tracking, keep EVERYTHING as ordinary artwork. ONE
 *  batch ⇒ 1 undo step (the recipe removal is a container write and is
 *  not undoable). */
export async function applyExpandBlend(
  host: BundleHost,
  payload?: unknown,
): Promise<boolean> {
  const label = EXPAND_BLEND_COMMAND_ID;
  const p = payloadOf(payload);
  const blend = await resolveBlend(host, p.blendId);
  if (blend === null) {
    host.log.warn(`${label}: no blend resolved — no-op`);
    return false;
  }
  const library = await readBlendLibrary(host);
  const leaves = await linkLeavesOf(host, blend);
  if (leaves.length === 0 && !findBlendRecord(library, blend)) {
    host.log.warn(
      `${label}: "${blend}" names neither a recipe nor any linked artwork — no-op`,
    );
    return false;
  }
  if (leaves.length > 0) {
    const outcome = await host.document.mutate(blendExpandBatchFor(leaves));
    if (!outcome.applied) {
      host.log.warn(
        `${label}: unlink rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      return false;
    }
  }
  await writeBlendLibrary(host, removeBlendRecordFrom(library, blend));
  host.log.info(
    `${label}: "${blend}" expanded — every key, intermediate and spine keeps ` +
      "its artwork; nothing tracks them any more",
  );
  return true;
}

/** **RELEASE** — remove the intermediates, keep the two KEY objects (and
 *  the spine) exactly as they were. ONE batch ⇒ 1 undo step. */
export async function applyReleaseBlend(
  host: BundleHost,
  payload?: unknown,
): Promise<number> {
  const label = RELEASE_BLEND_COMMAND_ID;
  const p = payloadOf(payload);
  const blend = await resolveBlend(host, p.blendId);
  if (blend === null) {
    host.log.warn(`${label}: no blend resolved — no-op`);
    return 0;
  }
  const generation = await blendGenerationOf(host, blend);
  const leaves = await linkLeavesOf(host, blend);
  if (leaves.length === 0) {
    host.log.debug(`${label}: "${blend}" has no linked artwork — no-op`);
    return 0;
  }
  const outcome = await host.document.mutate(
    blendReleaseBatchFor({
      group: generation.group,
      steps: generation.steps,
      // The intermediates are being DELETED, so their links go with
      // them; only the survivors need unlinking.
      links: leaves.filter((l) => l.key !== "blendStep"),
    }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return 0;
  }
  await writeBlendLibrary(
    host,
    removeBlendRecordFrom(await readBlendLibrary(host), blend),
  );
  await host.selection.set(
    leaves.filter((l) => l.key === "blendKey").map((l) => l.id),
  );
  host.log.info(
    `${label}: "${blend}" released — ${generation.steps.length} ` +
      "intermediate(s) removed; the key objects and the spine are kept " +
      "exactly as they are",
  );
  return generation.steps.length;
}

// ------------------------------------------------------------- commands

/** Register the eight blend commands. Every title carries what the
 *  contract has no description field to say — in particular that an
 *  intermediate is ARTWORK rebuilt by Update, not a live link
 *  ({@link BLEND_LIVE_NOTE}).
 *
 *  Payloads: make `{ name?, …params }`, update `{ blendId?, name?,
 *  spineId?, …params }`, replace spine `{ blendId?, spineId? }` (null
 *  clears), the two reverses `{ blendId? }` (they TOGGLE), select
 *  `{ blendId?, which?: "keys" | "steps" | "spine" | "all" }`, expand /
 *  release `{ blendId? }`. */
export function contributeBlendCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: BLEND_COMMAND_ID,
      title:
        "Blend: Make from the two selected objects (smooth colour / steps / distance — artwork rebuilt by Update, not a live link)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakeBlend(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: UPDATE_BLEND_COMMAND_ID,
      title:
        "Blend: Update (new options + the keys' CURRENT geometry; the intermediates get new ids)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyUpdateBlend(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: REPLACE_BLEND_SPINE_COMMAND_ID,
      title:
        "Blend: Replace spine with the selected path (it keeps its own paint and stays outside the blend's group)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReplaceBlendSpine(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: REVERSE_BLEND_SPINE_COMMAND_ID,
      title: "Blend: Reverse spine (the intermediates travel the other way)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReverseBlendSpine(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: REVERSE_BLEND_ORDER_COMMAND_ID,
      title: "Blend: Reverse front to back (paint order only — nothing moves)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReverseBlendOrder(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: SELECT_BLEND_OBJECTS_COMMAND_ID,
      title:
        "Blend: Select the key objects (edit them, then Update — that is how a blend follows an edit)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySelectBlendObjects(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: EXPAND_BLEND_COMMAND_ID,
      title: "Blend: Expand (keep every intermediate as ordinary artwork)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyExpandBlend(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: RELEASE_BLEND_COMMAND_ID,
      title: "Blend: Release (remove the intermediates, keep the key objects)",
      category: BLEND_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReleaseBlend(host, payload).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
