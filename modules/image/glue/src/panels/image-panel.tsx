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

// The adjustments panel — an expert React leaf over the ingest session.
// Phase 6 grew it from the four base sliders into the levels / curves /
// white-balance panel with histograms, plus the crop controls. Honest
// seams throughout: the engine/GPU state is stated; the composite is named
// a PREVIEW (the document is never mutated); parameter edits hit the GPU +
// scene channel only on the committed Apply (Stage-A re-submit-on-commit,
// per-drag interactivity is Stage B / M2). The histogram + curve LUT +
// crop geometry are the engine's deterministic Rust (image_core / the
// reduce histogram); this leaf only renders + forwards.

import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import {
  createStrings,
  defineMessages,
  t,
  useStrings,
} from "@paged-media/strings";
import {
  About,
  color,
  Disclosure,
  font,
  IconButton,
  space,
} from "@paged-media/panel-kit";

import manifest from "../../manifest.json";

import type { CurveChannel, ImageSession } from "../session";
import type {
  AdjustParams,
  AlignTo,
  ColorLabel,
  BrushLibraryInfo,
  BrushParams,
  BrushPresetInfo,
  BrushStats,
  ChannelStatsInfo,
  LayerGroupInfo,
  EditTarget,
  GradientKind,
  ImageHistogram,
  LayerHistory,
  LayerInfo,
  LevelsChannel,
  PressureTarget,
  Rgba01,
} from "../engine";
import {
  DEFAULT_BW_WEIGHTS,
  displayTreatmentLabel,
  isCmykConversion,
  GRADIENT_KINDS,
  PRESSURE_TARGETS,
  isIdentity,
} from "../engine";
import type { AspectPreset } from "../crop-machine";
import { COLOR_NAMES, gradientKindLabel, toneRangeLabel } from "../words";

import { CanvasSection, type CanvasSize } from "./sections/canvas-section";
import { HueSatSection } from "./sections/hue-sat-section";
import { ToneSection } from "./sections/tone-section";
import { ColorSection } from "./sections/color-section";
import { RankLookupSection } from "./sections/rank-lookup-section";
import { SelectModifySection } from "./sections/select-modify-section";
import { MoveSection } from "./sections/move-section";
import { PatternSection } from "./sections/pattern-section";
import { SmartObjectSection } from "./sections/smart-object-section";
import {
  DISTORT_DEFAULTS,
  DistortSection,
  type DistortParams,
} from "./sections/distort-section";
import { Section } from "./sections/disclosure";
import { FilterDialog } from "./sections/filter-dialog";
import {
  ImageSizeDialog,
  RotateDialog,
  TrimDialog,
} from "./sections/image-dialogs";
import { CurvesTools } from "./sections/curves-tools";
import {
  ActiveLayerStrip,
  BlendingOptionsDialog,
  ColorLabelPicker,
  LayerCompsSection,
  LayerFilterBar,
  LayerPropertiesSection,
  LayerVerbs,
  matchesLayerFilter,
} from "./sections/layer-parity";
import type { LayerFilter } from "../session";
import { FILTERS, filterDef, type FilterId } from "../filters";
import {
  actionBar,
  kicker,
  mono,
  note,
  panelTitle,
  row,
  sectionTitle,
  swatch,
} from "./sections/styles";

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  disabled,
}: SliderSpec) {
  return (
    <div style={row}>
      <label>{label}</label>
      <span
        style={{
          display: "flex",
          gap: space[1],
          alignItems: "center",
        }}
      >
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span style={{ ...mono, minWidth: "3.5em", textAlign: "right" }}>
          {value.toFixed(2)}
        </span>
      </span>
    </div>
  );
}

/** A compact numeric cell — the Channel-Mixer / per-channel-Levels grid
 *  idiom (sliders would not fit three columns; the number IS the value). */
function Num({
  value,
  onChange,
  disabled,
  step = 0.05,
  title,
  width = 46,
  testAttr,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
  step?: number;
  title?: string;
  width?: number;
  testAttr?: string;
}) {
  const attrs = testAttr ? { [testAttr]: "" } : {};
  return (
    <input
      type="number"
      step={step}
      value={value}
      title={title}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ width, font: `11px ${font.mono}` }}
      {...attrs}
    />
  );
}

/** A labelled row of compact numbers (the grid idiom's line). */
function NumRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ ...row, gap: space[1] }}>
      <label style={{ flex: 1, minWidth: 0 }}>{label}</label>
      <span style={{ display: "flex", gap: 3 }}>{children}</span>
    </div>
  );
}

/** A checkbox gate (the "this looks destructive, opt in" idiom). */
function Gate({
  label,
  checked,
  onChange,
  disabled,
  testAttr,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  testAttr?: string;
}) {
  const attrs = testAttr ? { [testAttr]: "" } : {};
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        font: `12px ${font.sans}`,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        {...attrs}
      />
      {label}
    </label>
  );
}

// ── histogram ────────────────────────────────────────────────────────

const GRAPH = defineMessages("image.graph", {
  histogram: "RGB and luma histogram",
  curve: "Tone curve editor",
});

const HIST_W = 256;
const HIST_H = 60;

/** Render one channel's 256 bins as a normalized SVG area path. */
function channelPath(bins: Uint32Array, max: number): string {
  if (max <= 0) return "";
  let d = `M0,${HIST_H}`;
  for (let i = 0; i < 256; i++) {
    const y = HIST_H - (bins[i] / max) * HIST_H;
    d += ` L${i},${y.toFixed(2)}`;
  }
  d += ` L${HIST_W - 1},${HIST_H} Z`;
  return d;
}

function HistogramView({ hist }: { hist: ImageHistogram }) {
  // Shared vertical scale across channels (the tallest bin overall), so
  // the channels are comparable — clipping the very tallest bin (often a
  // spike at 0/255) by capping at the 2nd-tallest keeps detail visible.
  const peak = (b: Uint32Array) => {
    const s = [...b].sort((x, y) => y - x);
    return s[1] ?? s[0] ?? 1;
  };
  const max = Math.max(
    peak(hist.r),
    peak(hist.g),
    peak(hist.b),
    peak(hist.luma),
    1,
  );
  return (
    <svg
      viewBox={`0 0 ${HIST_W} ${HIST_H}`}
      preserveAspectRatio="none"
      style={{
        width: "100%",
        height: HIST_H,
        background: "var(--pg-muted)",
        borderRadius: "3px",
      }}
      role="img"
      aria-label={t(GRAPH.histogram)}
    >
      <path d={channelPath(hist.luma, max)} fill="rgba(160,160,160,0.5)" />
      <path d={channelPath(hist.r, max)} fill="rgba(220,60,60,0.55)" />
      <path d={channelPath(hist.g, max)} fill="rgba(60,200,90,0.55)" />
      <path d={channelPath(hist.b, max)} fill="rgba(70,120,235,0.55)" />
    </svg>
  );
}

// ── curves (control-point editor) ────────────────────────────────────

/** The default identity curve control points (input, output) in [0,1]. */
const IDENTITY_CURVE: Array<[number, number]> = [
  [0, 0],
  [0.5, 0.5],
  [1, 1],
];

const CURVE_SIZE = 140;

/** A draggable control-point curve editor. The points drive the LUT the
 *  curves kernel-stage consumes (built engine-side by `engine.curveLut`);
 *  this UI only edits the points + previews the polyline through them.
 *  v0 previews a straight polyline between points (the engine applies the
 *  monotone-cubic LUT) — the honest UI subset. */
function CurveEditor({
  points,
  onChange,
  disabled,
}: {
  points: Array<[number, number]>;
  onChange: (p: Array<[number, number]>) => void;
  disabled: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);

  const toScreen = (p: [number, number]): [number, number] => [
    p[0] * CURVE_SIZE,
    (1 - p[1]) * CURVE_SIZE,
  ];

  const updatePoint = (
    i: number,
    clientX: number,
    clientY: number,
    svg: SVGSVGElement,
  ) => {
    const r = svg.getBoundingClientRect();
    let x = (clientX - r.left) / r.width;
    let y = 1 - (clientY - r.top) / r.height;
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
    const next = points.map((p, j) =>
      j === i ? ([x, y] as [number, number]) : p,
    );
    // Endpoints keep their input fixed (0 and 1) — only their output moves.
    if (i === 0) next[0] = [0, y];
    if (i === points.length - 1) next[i] = [1, y];
    onChange(next);
  };

  const line =
    "M" +
    points
      .map((p) => {
        const s = toScreen(p);
        return `${s[0].toFixed(1)},${s[1].toFixed(1)}`;
      })
      .join(" L");

  return (
    <svg
      viewBox={`0 0 ${CURVE_SIZE} ${CURVE_SIZE}`}
      style={{
        width: CURVE_SIZE,
        height: CURVE_SIZE,
        background: "var(--pg-muted)",
        borderRadius: "3px",
        touchAction: "none",
        opacity: disabled ? 0.5 : 1,
      }}
      onPointerMove={(e) => {
        if (drag === null || disabled) return;
        updatePoint(drag, e.clientX, e.clientY, e.currentTarget);
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      role="img"
      aria-label={t(GRAPH.curve)}
    >
      <line
        x1="0"
        y1={CURVE_SIZE}
        x2={CURVE_SIZE}
        y2="0"
        stroke="rgba(127,127,127,0.3)"
      />
      <path d={line} fill="none" stroke={color.primary} strokeWidth="1.5" />
      {points.map((p, i) => {
        const s = toScreen(p);
        return (
          <circle
            key={i}
            cx={s[0]}
            cy={s[1]}
            r={5}
            fill={color.primary}
            style={{ cursor: disabled ? "default" : "grab" }}
            onPointerDown={(e) => {
              if (disabled) return;
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDrag(i);
            }}
          />
        );
      })}
    </svg>
  );
}

// ── crop ─────────────────────────────────────────────────────────────

const ASPECTS: AspectPreset[] = [
  "free",
  "original",
  "1:1",
  "3:2",
  "4:3",
  "16:9",
];

// ── colour presets ───────────────────────────────────────────────────

/** A few conventional photo-filter gels (straight RGB in [0,1]), named by
 *  message key (read through `t` at render). The
 *  kernel takes an arbitrary colour — this is the shortlist the panel
 *  offers instead of a colour picker the shell does not provide. */
const PHOTO_FILTERS: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: COLOR_NAMES.warming85, rgb: [0.925, 0.639, 0.365] },
  { name: COLOR_NAMES.warming81, rgb: [0.92, 0.78, 0.55] },
  { name: COLOR_NAMES.cooling80, rgb: [0.0, 0.44, 0.88] },
  { name: COLOR_NAMES.cooling82, rgb: [0.44, 0.71, 0.94] },
  { name: COLOR_NAMES.sepia, rgb: [0.67, 0.51, 0.25] },
  { name: COLOR_NAMES.red, rgb: [0.91, 0.14, 0.16] },
  { name: COLOR_NAMES.green, rgb: [0.14, 0.71, 0.32] },
  { name: COLOR_NAMES.blue, rgb: [0.11, 0.28, 0.82] },
];

/** The gradient stop wells (no colour-picker door in the contract, so
 *  the panel offers a shortlist — the ENGINE takes any RGBA). */
const STOPS: Array<{ name: string; rgba: Rgba01 }> = [
  { name: COLOR_NAMES.black, rgba: [0, 0, 0, 1] },
  { name: COLOR_NAMES.white, rgba: [1, 1, 1, 1] },
  { name: COLOR_NAMES.red, rgba: [1, 0, 0, 1] },
  { name: COLOR_NAMES.green, rgba: [0, 1, 0, 1] },
  { name: COLOR_NAMES.blue, rgba: [0, 0, 1, 1] },
  { name: COLOR_NAMES.transparent, rgba: [0, 0, 0, 0] },
];

/** Pen-pressure targets in the panel's words (message keys). */
const PRESSURE_LABELS: Record<string, string> = defineMessages(
  "image.pressure",
  {
    none: "Nothing",
    size: "Size",
    opacity: "Opacity",
    both: "Size and opacity",
  },
);

/** "shadows" → "Shadows" (a row label from a lower-case word). */
const capitalize = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);

const stopCss = (c: Rgba01) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(
    c[2] * 255,
  )}, ${c[3]})`;

// ── brush ────────────────────────────────────────────────────────────

/** The brush colour wells. The engine takes ANY straight RGBA; this is
 *  the shortlist the panel offers because the host contract wires no
 *  colour-picker door (the same reason the gradient stops are a list). */
const BRUSH_COLORS: Array<{ name: string; rgba: Rgba01 }> = [
  { name: COLOR_NAMES.black, rgba: [0, 0, 0, 1] },
  { name: COLOR_NAMES.white, rgba: [1, 1, 1, 1] },
  { name: COLOR_NAMES.grey50, rgba: [0.5, 0.5, 0.5, 1] },
  { name: COLOR_NAMES.red, rgba: [1, 0, 0, 1] },
  { name: COLOR_NAMES.green, rgba: [0, 1, 0, 1] },
  { name: COLOR_NAMES.blue, rgba: [0, 0, 1, 1] },
  { name: COLOR_NAMES.yellow, rgba: [1, 1, 0, 1] },
  { name: COLOR_NAMES.magenta, rgba: [1, 0, 1, 1] },
  { name: COLOR_NAMES.cyan, rgba: [0, 1, 1, 1] },
];

/**
 * THE SCOPE OF PAINTING, in the UI rather than in a code comment.
 *
 * Exported so a spec pins the WORDING: an honesty note that can be
 * edited away silently is not a guarantee (the paged.draw Appearance
 * panel's `APPEARANCE_BAKE_NOTE` convention).
 */
const SCOPE = defineMessages("image.scope", {
  brush:
    "A stroke paints the active layer, not the flattened image — add a layer " +
    "and what is underneath survives. A committed stroke is undoable: the " +
    "tiles it touched are journaled and Undo restores them byte for byte. " +
    "That history is bounded — 32 steps or 256 MB, whichever runs out first; " +
    "past the bound the oldest edits are dropped and become permanent, and " +
    "the panel says how many. Painting still replaces what it covers in its " +
    "own layer: paint on the background and what it covered is gone until " +
    "you undo. The document and the source file are never touched (the " +
    "in-frame result stays a preview layer). A stroke still in flight can be " +
    "abandoned — the base pixels are held until you release. While you drag, " +
    "the frame shows the whole stack with the stroke composited into it; the " +
    "adjustment chain re-runs on release.",
  layers:
    "Layers are canvas-extent layers composited bottom-up through the " +
    "engine's own blend kernels — the same 26 blend modes the brush paints " +
    "through. A layer holds pixels, an adjustment (it transforms everything " +
    "beneath it) or a smart object (rescaling re-renders from the original); " +
    "layers can be grouped, clipped and masked. Undo is one list for paint, " +
    "fills and bakes and every change to the stack — adding, removing, " +
    "reordering, opacity, blend, masks, groups, rotate, flip, canvas size, " +
    "crop, straighten and image size; it is bounded, and the panel says when " +
    "old steps fall off. A crop, resize or straighten keeps every layer and " +
    "mask and is one undo step; it drops the selection. Export and " +
    "save-back write the flattened composite, not the layers. " +
    "A PSD opens as its own layers only when this model reproduces it " +
    "exactly — 8- or 16-bit RGB, with no groups and no layer masks; anything " +
    "else keeps Photoshop's merged composite as a single layer and says why.",
  psdFlattened:
    "While adjustments are set, the PSD export writes the adjusted image " +
    "as one layer: these layers and their edits are not kept. Reset the " +
    "adjustments to export the layers. The canvas shows the import-time " +
    "flatten.",
  psdKept:
    "Edits land in the exported PSD (preservation-safe — a zero-edit " +
    "export is byte-identical). The canvas shows the import-time flatten.",
});

/** The English source, which the specs pin (the panel renders the editor's
 *  language through `t`). */
const english = createStrings();

export const BRUSH_SCOPE_NOTE = english.t(SCOPE.brush);

/**
 * THE SCOPE OF THE LAYER GRAPH itself — what a layer here is and, more
 * to the point, what it is not. Exported and spec-pinned for the same
 * reason as [`BRUSH_SCOPE_NOTE`].
 */
export const LAYERS_SCOPE_NOTE = english.t(SCOPE.layers);

/**
 * What the PSD exporter will do with the file's layers, given the
 * panel's adjustments. Panel adjustments exist only as a chain over the
 * composite, so a file with more than one layer is flattened to one when
 * they are set: the note must not promise the layers then.
 */
export function psdLayersNote(
  params: AdjustParams,
  layerCount: number,
): string {
  return t(
    !isIdentity(params) && layerCount > 1 ? SCOPE.psdFlattened : SCOPE.psdKept,
  );
}

const BRUSH = defineMessages("image.brush", {
  title: "Brush",
  titleClipped: "Brush, clipped to the selection",
  intro:
    "Settings for the paint, pencil and eraser tools; size, hardness, " +
    "opacity and flow are also in the tool options bar.",
  size: "Size (px)",
  hardness: "Hardness",
  opacity: "Opacity",
  flow: "Flow",
  spacing: "Spacing (× diameter)",
  blend: "Blend",
  engineNotStarted: "{blend} (engine not started)",
  colour: "Colour",
  pressure: "Pen pressure drives",
  stroke: "Stroke",
  stats: "{dabs} dabs · {x},{y} {w}×{h}",
  inProgress: "in progress",
  needsGpu: "Painting needs WebGPU, so the paint tools are disabled here.",
  undo: "Strokes paint the active layer, and Undo takes them back.",
  shortlist:
    "The colours are a shortlist, and the blend list comes from the engine " +
    "itself. Settings are fixed for a stroke when it starts.",
});

/** The paint parameters section — a PURE component (props in, elements
 *  out, no hooks) so a spec can render it without a DOM and assert what
 *  it says. Its words come from the active catalogue (`t`), which the
 *  editor's provider sets, for the same reason: no context hook. The
 *  sections below follow it. */
export function BrushSection({
  brush,
  blendModes,
  strokeActive,
  strokeStats,
  masked,
  gpu,
  disabled,
  onChange,
}: {
  brush: BrushParams;
  /** From the engine's `compose.*` registry — never a hardcoded list. */
  blendModes: readonly string[];
  strokeActive: boolean;
  strokeStats: BrushStats | null;
  /** A selection exists, so strokes are clipped to it. */
  masked: boolean;
  gpu: boolean;
  disabled: boolean;
  onChange: (patch: Partial<BrushParams>) => void;
}) {
  const colorIndex = BRUSH_COLORS.findIndex(
    (c) =>
      c.rgba[0] === brush.color[0] &&
      c.rgba[1] === brush.color[1] &&
      c.rgba[2] === brush.color[2] &&
      c.rgba[3] === brush.color[3],
  );
  return (
    <Section
      title={t(masked ? BRUSH.titleClipped : BRUSH.title)}
      data-image-brush-section
    >
      <div style={note}>{t(BRUSH.intro)}</div>
      <Slider
        label={t(BRUSH.size)}
        min={1}
        max={512}
        step={1}
        value={brush.size}
        disabled={disabled}
        onChange={(size) => onChange({ size })}
      />
      <Slider
        label={t(BRUSH.hardness)}
        min={0}
        max={1}
        step={0.05}
        value={brush.hardness}
        disabled={disabled}
        onChange={(hardness) => onChange({ hardness })}
      />
      <Slider
        label={t(BRUSH.opacity)}
        min={0}
        max={1}
        step={0.05}
        value={brush.opacity}
        disabled={disabled}
        onChange={(opacity) => onChange({ opacity })}
      />
      <Slider
        label={t(BRUSH.flow)}
        min={0}
        max={1}
        step={0.05}
        value={brush.flow}
        disabled={disabled}
        onChange={(flow) => onChange({ flow })}
      />
      <Slider
        label={t(BRUSH.spacing)}
        min={0.01}
        max={1}
        step={0.01}
        value={brush.spacing}
        disabled={disabled}
        onChange={(spacing) => onChange({ spacing })}
      />
      <div style={row}>
        <label htmlFor="pg-image-brush-blend">{t(BRUSH.blend)}</label>
        <select
          id="pg-image-brush-blend"
          data-image-brush-blend
          value={brush.blend}
          disabled={disabled || blendModes.length === 0}
          onChange={(e) => onChange({ blend: e.target.value })}
        >
          {blendModes.length > 0 ? (
            blendModes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))
          ) : (
            <option value={brush.blend}>
              {t(BRUSH.engineNotStarted, { blend: brush.blend })}
            </option>
          )}
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-brush-color">{t(BRUSH.colour)}</label>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={swatch(stopCss(brush.color))} aria-hidden="true" />
          <select
            id="pg-image-brush-color"
            data-image-brush-color
            value={colorIndex < 0 ? 0 : colorIndex}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                color: [...BRUSH_COLORS[Number(e.target.value)].rgba],
              })
            }
          >
            {BRUSH_COLORS.map((c, i) => (
              <option key={c.name} value={i}>
                {t(c.name)}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-brush-pressure">{t(BRUSH.pressure)}</label>
        <select
          id="pg-image-brush-pressure"
          data-image-brush-pressure
          value={brush.pressureTarget}
          disabled={disabled}
          onChange={(e) =>
            onChange({ pressureTarget: e.target.value as PressureTarget })
          }
        >
          {PRESSURE_TARGETS.map((target) => (
            <option key={target} value={target}>
              {PRESSURE_LABELS[target] ? t(PRESSURE_LABELS[target]) : target}
            </option>
          ))}
        </select>
      </div>
      {strokeActive ? (
        <div style={row}>
          <span>{t(BRUSH.stroke)}</span>
          <span style={mono} data-image-brush-stats>
            {strokeStats
              ? t(BRUSH.stats, {
                  dabs: strokeStats.dabs,
                  x: Math.round(strokeStats.x),
                  y: Math.round(strokeStats.y),
                  w: Math.round(strokeStats.w),
                  h: Math.round(strokeStats.h),
                })
              : t(BRUSH.inProgress)}
          </span>
        </div>
      ) : null}
      {!gpu ? <div style={note}>{t(BRUSH.needsGpu)}</div> : null}
      <div style={note}>{t(BRUSH.undo)}</div>
      <About>
        <p data-image-brush-note>{t(SCOPE.brush)}</p>
        <p>{t(BRUSH.shortlist)}</p>
      </About>
    </Section>
  );
}

// ── raster type ──────────────────────────────────────────────────────

const TYPE = defineMessages("image.type", {
  title: "Type",
  text: "Text",
  placeholder: "Type here, then click the canvas",
  face: "Face",
  size: "Size (px)",
  note:
    "Click the canvas to set the baseline and paint the text as pixels in " +
    "the brush colour; the Character panel styles it.",
  shaping:
    "Glyphs are shaped by the font's own tables — joining, reordering, " +
    "ligatures and kerning. Only fonts the document already embeds can be " +
    "used, and nothing is fetched from the network. A character with no " +
    "glyph in the chosen face is reported and left undrawn rather than " +
    "replaced with a box.",
  pixels:
    "This paints pixels, not a text object. The Character panel applies " +
    "family, style, size, tracking, leading, case, scale, slant, baseline " +
    "shift, super/subscript, underline, strikethrough, ligatures and line " +
    "alignment. Anything that needs a text column — wrapping, indents, " +
    "hyphenation — is absent: a line ends where you end it. For live, " +
    "editable, wrapping text use a text frame.",
});

/** The TYPE section — the string, face and size the type tool paints on
 *  its next click. PURE, like the sections around it.
 *
 *  What it is NOT, stated here and in the panel: a text box. This paints
 *  a run of shaped glyphs at a point and commits them as pixels. The
 *  host's text frame is the live, editable, wrapping, styleable thing,
 *  and duplicating it here would be the same mistake the Paths panel was
 *  deliberately not built to make. */
export function TypeSection({
  type,
  disabled,
  onChange,
}: {
  type: { text: string; family: string; sizePx: number };
  disabled: boolean;
  onChange: (
    patch: Partial<{ text: string; family: string; sizePx: number }>,
  ) => void;
}) {
  return (
    <Section title={t(TYPE.title)} data-image-type-section>
      <div style={row}>
        <label htmlFor="pg-image-type-text">{t(TYPE.text)}</label>
        <input
          id="pg-image-type-text"
          type="text"
          data-image-type-text
          value={type.text}
          disabled={disabled}
          placeholder={t(TYPE.placeholder)}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-type-family">{t(TYPE.face)}</label>
        <input
          id="pg-image-type-family"
          type="text"
          data-image-type-family
          value={type.family}
          disabled={disabled}
          onChange={(e) => onChange({ family: e.target.value })}
        />
      </div>
      <Slider
        label={t(TYPE.size)}
        min={4}
        max={512}
        step={1}
        value={type.sizePx}
        disabled={disabled}
        onChange={(sizePx) => onChange({ sizePx })}
      />
      <div style={note} data-image-type-note>
        {t(TYPE.note)}
      </div>
      <About>
        <p>{t(TYPE.shaping)}</p>
        <p>{t(TYPE.pixels)}</p>
      </About>
    </Section>
  );
}

// ── retouching (clone / heal) ────────────────────────────────────────

const RETOUCH = defineMessages("image.retouch", {
  title: "Retouch",
  cloneSource: "Clone source",
  notSet: "not set",
  aligned: "Aligned",
  setSource:
    "Alt-click with the Clone stamp or the Healing brush to set the source.",
  alignedAbout:
    "The source survives between strokes, and Aligned keeps a fixed offset " +
    "from the cursor so the copy moves with it instead of repeating.",
  healLimit:
    "The healing brush fits its correction to the mismatch around the " +
    "dab's edge, so it follows a ramp instead of shifting the patch by one " +
    "number. Where the sampled area runs off the image there is no edge to " +
    "fit, and it falls back to a plain clone.",
  contentAwareFill: "Content-aware fill",
  selectFirst: "Select an area first.",
  cafNote:
    "Fills the selection with texture copied from elsewhere in the image.",
  cafAbout:
    "It works patch by patch from the edge inward, so it keeps grain and " +
    "continues edges rather than blurring across them, and decides " +
    "large-scale structure at half resolution before matching texture at " +
    "full. Its search is limited to a window around the hole: a match on " +
    "the far side of a large image will not be found.",
});

/** The RETOUCH section: the clone source, and the honest limit of the
 *  healing brush. PURE, like the sections around it.
 *
 *  There are no sliders here on purpose — clone and heal take the SAME
 *  size, hardness, opacity, flow and spacing as the brush, because they
 *  are the brush with a different paint layer. Duplicating those
 *  controls would imply two independent brushes and would drift. */
export function RetouchSection({
  source,
  hasSelection,
  onAligned,
  onContentAwareFill,
}: {
  source: { x: number; y: number; aligned: boolean } | null;
  hasSelection: boolean;
  onAligned: (aligned: boolean) => void;
  onContentAwareFill: () => void;
}) {
  return (
    <Section title={t(RETOUCH.title)} data-image-retouch-section>
      <div style={row}>
        <span>{t(RETOUCH.cloneSource)}</span>
        <span style={mono} data-image-clone-source>
          {source
            ? `${Math.round(source.x)}, ${Math.round(source.y)}`
            : t(RETOUCH.notSet)}
        </span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-aligned">{t(RETOUCH.aligned)}</label>
        <input
          id="pg-image-clone-aligned"
          type="checkbox"
          data-image-clone-aligned
          checked={source?.aligned ?? true}
          disabled={!source}
          onChange={(e) => onAligned(e.target.checked)}
        />
      </div>
      <div style={note}>{t(RETOUCH.setSource)}</div>
      <About>
        <p>{t(RETOUCH.alignedAbout)}</p>
        <p data-image-heal-limit>{t(RETOUCH.healLimit)}</p>
      </About>
      <div style={row}>
        <button
          type="button"
          data-image-content-aware-fill
          disabled={!hasSelection}
          onClick={onContentAwareFill}
        >
          {t(RETOUCH.contentAwareFill)}
        </button>
        <span style={note}>{hasSelection ? "" : t(RETOUCH.selectFirst)}</span>
      </div>
      <div style={note} data-image-caf-note>
        {t(RETOUCH.cafNote)}
        <About>{t(RETOUCH.cafAbout)}</About>
      </div>
    </Section>
  );
}

// ── paths (raster ↔ vector) ──────────────────────────────────────────

const PATHS = defineMessages("image.paths", {
  title: "Paths",
  trace: "Trace at coverage ≥",
  toPath: "Selection → path",
  fromPath: "Path → selection",
  note:
    "Turns the selection into a vector shape on the page, or a selected " +
    "shape back into a selection.",
  pageShape:
    "A traced path becomes an ordinary page shape, so the Pen, the shape " +
    "tools and the Pathfinder apply, and its undo is the document's. Each " +
    "contour becomes its own polygon, holes included: a ring is two paths.",
  corners:
    "The trace follows pixel edges and its corners carry no handles; " +
    "smooth it with the Pen once it is a path.",
});

/** The PATHS section — the raster↔vector bridge, and only that.
 *
 *  Deliberately NOT a Paths palette. The vector side of Paged is
 *  host-owned and already strong (the Pen family, the shape tools, the
 *  Pathfinder), and a second list of the same paths living inside the
 *  image panel would be a duplicate surface that drifts. What was
 *  genuinely missing was the CONVERSION between a raster selection and a
 *  real vector element, in both directions — so that is what this is.
 *
 *  The threshold is exposed rather than hidden because it is a decision:
 *  a feathered or luminosity selection has no single correct outline,
 *  and choosing silently would throw away the anti-aliased boundary. */
export function PathsSection({
  hasSelection,
  threshold,
  disabled,
  onThreshold,
  onToPath,
  onFromPath,
}: {
  hasSelection: boolean;
  threshold: number;
  disabled: boolean;
  onThreshold: (v: number) => void;
  onToPath: () => void;
  onFromPath: () => void;
}) {
  return (
    <Section title={t(PATHS.title)} data-image-paths-section>
      <Slider
        label={t(PATHS.trace)}
        min={1}
        max={255}
        step={1}
        value={threshold}
        disabled={disabled}
        onChange={onThreshold}
      />
      <div style={row}>
        <button
          type="button"
          data-image-selection-to-path
          disabled={disabled || !hasSelection}
          onClick={onToPath}
        >
          {t(PATHS.toPath)}
        </button>
        <button
          type="button"
          data-image-path-to-selection
          disabled={disabled}
          onClick={onFromPath}
        >
          {t(PATHS.fromPath)}
        </button>
      </div>
      <div style={note}>{t(PATHS.note)}</div>
      <About>
        <p>{t(PATHS.pageShape)}</p>
        <p>{t(PATHS.corners)}</p>
      </About>
    </Section>
  );
}

// ── channels ─────────────────────────────────────────────────────────

const CHANNELS = defineMessages("image.channels", {
  title: "Channels",
  empty: "Choose Use selected frame to read the image's channels.",
  loadTitle: "Load the {channel} channel as the selection",
  unmeasured: "unmeasured",
  stats: "{min}–{max} · mean {mean}",
  note: "Click a channel to load it as the selection, replacing the current one.",
  coverage:
    "The channel's values are the coverage directly, with no threshold, so " +
    "a mid-grey channel selects at 50%. Luma is the Rec.709 luminance, the " +
    "usual luminosity mask.",
  noView:
    "Viewing one channel on its own is not offered: the frame shows the " +
    "composited image, and faking a channel view would mean writing a " +
    "greyscale image into the document.",
});

/** The CHANNELS list — per-channel statistics and the one operation a
 *  channel list exists to enable: loading a channel as the selection.
 *  PURE (props in, elements out) so a spec can assert what it says.
 *
 *  The honest scope, stated in the UI and not only here: Photoshop's
 *  channels panel also VIEWS a channel in isolation, and that is a
 *  display state the host scene channel does not model — it takes a
 *  composited image, not a view mode. Writing a greyscale composite into
 *  the document to fake it would be a destructive edit wearing a view's
 *  clothes, so the section says what it does not do instead. */
export function ChannelsSection({
  channels,
  disabled,
  onLoadSelection,
}: {
  channels: readonly ChannelStatsInfo[] | null;
  disabled: boolean;
  onLoadSelection: (channel: string) => void;
}) {
  return (
    <Section title={t(CHANNELS.title)} data-image-channels-section>
      {channels === null ? (
        <div style={note}>{t(CHANNELS.empty)}</div>
      ) : (
        <>
          <div data-image-channels>
            {channels.map((c) => (
              <div key={c.name} style={row}>
                <button
                  type="button"
                  data-image-channel={c.name}
                  disabled={disabled}
                  onClick={() => onLoadSelection(c.name)}
                  title={t(CHANNELS.loadTitle, { channel: c.name })}
                >
                  {c.name}
                </button>
                <span style={mono} data-image-channel-stats={c.name}>
                  {c.mean === null
                    ? t(CHANNELS.unmeasured)
                    : t(CHANNELS.stats, {
                        min: String(c.min),
                        max: String(c.max),
                        mean: c.mean.toFixed(1),
                      })}
                </span>
              </div>
            ))}
          </div>
          <div style={note}>{t(CHANNELS.note)}</div>
          <About>
            <p>{t(CHANNELS.coverage)}</p>
            <p>{t(CHANNELS.noView)}</p>
          </About>
        </>
      )}
    </Section>
  );
}

// ── brush presets (.abr) ─────────────────────────────────────────────

/** What a preset row says it will and will NOT bring across, in the
 *  panel's words. The engine's tip is a parametric circle, so an
 *  elliptical or angled preset is applied in part — and the row says so
 *  rather than letting the designer discover it mid-stroke. */
const PRESETS = defineMessages("image.brushPresets", {
  title: "Brush presets",
  load: "Load .abr…",
  close: "Close",
  library: "library",
  presets: "{count, plural, one {# preset} other {# presets}}",
  bitmaps: "{count} bitmap",
  empty:
    "The library parsed and contains no presets — a real state, and not the " +
    "same as a file that failed to read.",
  tip: "{kind} tip",
  unnamed: "(unnamed {index}" + ")",
  warnings:
    "The reader parsed this file with {count, plural, one {# warning} other {# warnings}}: {list}",
  format:
    "`.abr` is a parameter format, and only size, hardness and spacing have " +
    "a home in this engine's tip. Roundness and angle are shown but not " +
    "applied — the tip is circular — and a sampled (bitmap) tip contributes " +
    "its size only, because stamping a bitmap is a different engine from " +
    "the parametric dab that ships.",
  none:
    "No library loaded. Photoshop `.abr` files carry brush parameters, not " +
    "pixels — loading one changes nothing until a preset is applied.",
  hardness: "hardness {value}",
  spacingOff: "spacing off",
  spacing: "spacing {value}",
});

function presetSummary(p: BrushPresetInfo): string {
  const bits: string[] = [];
  if (p.diameter !== null) {
    bits.push(
      p.diameterUnit === "#Pxl"
        ? `${Math.round(p.diameter)} px`
        : `${Math.round(p.diameter)} ${p.diameterUnit ?? "?"}`,
    );
  }
  if (p.hardness !== null)
    bits.push(t(PRESETS.hardness, { value: p.hardness.toFixed(2) }));
  if (p.spacing !== null) {
    bits.push(
      p.spacingEnabled === false
        ? t(PRESETS.spacingOff)
        : t(PRESETS.spacing, { value: p.spacing.toFixed(2) }),
    );
  }
  if (bits.length === 0) bits.push(p.kind);
  return bits.join(" · ");
}

/** The BRUSHES palette — a Photoshop `.abr` library, projected onto the
 *  parameters this engine's tip actually has. PURE (props in, elements
 *  out) like `LayersSection`, so a spec can assert what it says without
 *  a DOM.
 *
 *  The honest framing this section is built around: `.abr` is a
 *  PARAMETER format, and only some of its parameters have a home here.
 *  A sampled (bitmap) tip is listed with its size but cannot be stamped
 *  — the engine's tip is parametric — and the row says which kind it is
 *  so that "why does this look different from Photoshop" has an answer
 *  on screen rather than in a changelog. */
export function BrushPresetsSection({
  library,
  libraryName,
  activePreset,
  disabled,
  onLoad,
  onApply,
  onClose,
}: {
  library: BrushLibraryInfo | null;
  libraryName: string | null;
  activePreset: number | null;
  disabled: boolean;
  onLoad: () => void;
  onApply: (index: number) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div style={sectionTitle}>{t(PRESETS.title)}</div>
      <div style={row}>
        <button
          type="button"
          data-image-abr-load
          onClick={onLoad}
          disabled={disabled}
        >
          {t(PRESETS.load)}
        </button>
        {library ? (
          <button type="button" data-image-abr-close onClick={onClose}>
            {t(PRESETS.close)}
          </button>
        ) : null}
      </div>
      {library ? (
        <>
          <div style={row}>
            <span>{libraryName ?? t(PRESETS.library)}</span>
            <span style={mono} data-image-abr-summary>
              v{library.version}.{library.minorVersion} ·{" "}
              {t(PRESETS.presets, { count: library.presetCount })}
              {library.sampleCount > 0
                ? ` · ${t(PRESETS.bitmaps, { count: library.sampleCount })}`
                : ""}
            </span>
          </div>
          {library.presetCount === 0 ? (
            <div style={note}>{t(PRESETS.empty)}</div>
          ) : null}
          <div data-image-abr-presets>
            {library.presets.map((p) => (
              <div
                key={p.index}
                style={{
                  ...row,
                  fontWeight: p.index === activePreset ? 600 : undefined,
                }}
              >
                <button
                  type="button"
                  data-image-abr-preset={p.index}
                  onClick={() => onApply(p.index)}
                  disabled={p.kind === "unsupported" || p.kind === "missing"}
                  title={t(PRESETS.tip, { kind: p.kind })}
                >
                  {p.name || t(PRESETS.unnamed, { index: p.index })}
                </button>
                <span style={mono}>{presetSummary(p)}</span>
              </div>
            ))}
          </div>
          {library.warnings.length > 0 ? (
            <div style={note} data-image-abr-warnings>
              {t(PRESETS.warnings, {
                count: library.warnings.length,
                list: library.warnings.join("; "),
              })}
            </div>
          ) : null}
          <div style={note}>{t(PRESETS.format)}</div>
        </>
      ) : (
        <div style={note}>{t(PRESETS.none)}</div>
      )}
    </>
  );
}

/** Bytes → a compact "12.3 MB" for the history readout. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LAYERS = defineMessages("image.layers", {
  title: "Layers",
  titleCount: "Layers ({count}" + ")",
  empty: "Choose Use selected frame to open the image's layers.",
  sameStack:
    "While you edit the image, the Layers panel and Image properties show " +
    "this same stack.",
  groupForcedIsolation:
    "Pass through — but the opacity is below 100%, which forces isolation",
  groupIsolated: "Isolated: members composite into their own buffer first",
  groupPassThrough:
    "Pass through: members reach the stack below, so an adjustment inside " +
    "affects everything beneath",
  iso: "iso",
  pass: "pass",
  dissolve: "Dissolve group",
  dissolveTitle: "Dissolve this group (its layers stay)",
  visible: "Visible",
  blendMode: "Blend mode",
  opacity: "Opacity",
  lock: "Lock pixels (paint, fills and bakes refuse; properties still move)",
  paintingMask:
    "Painting the MASK (brush = foreground grey, eraser reveals) — click to " +
    "paint the pixels",
  paintMask: "Paint this layer's mask instead of its pixels",
  maskApplying:
    "Mask is applying — uncheck to disable it (the coverage is kept)",
  maskDisabled: "Mask is disabled but retained — check to apply it again",
  deleteMask: "Delete layer mask",
  deleteMaskTitle: "Delete this layer's mask (the coverage is lost)",
  selectionToMask: "Selection to layer mask",
  selectionToMaskTitle: "Make the current selection this layer's mask",
  addMask: "Add layer mask",
  addMaskTitle: "Add layer mask — reveal all (Alt-click: hide all)",
  releaseClip: "Release clipping mask",
  clip: "Clip to the layer below",
  clippedTitle: "Clipped to the layer below — click to release",
  clipTitle:
    "Clip to the layer below (an adjustment clipped to a smart object is a " +
    "smart filter)",
  moveUp: "Move layer up",
  moveUpTitle: "Move up",
  moveDown: "Move layer down",
  moveDownTitle: "Move down",
  duplicate: "Duplicate layer",
  duplicateTitle: "Duplicate",
  remove: "Remove layer",
  removeTitle: "Remove layer (Undo brings it back)",
  keepOne: "A document keeps at least one layer",
  groupsNote: "Groups pass through by default, as in Photoshop.",
  groupsAbout:
    "A pass-through group's members composite straight into the stack " +
    "below, so an adjustment inside reaches everything beneath it. Switch " +
    "it to isolated and the members composite into their own buffer first " +
    "— that makes group opacity fade the result rather than each member, " +
    "and confines an adjustment to its group. Opacity below 100% forces " +
    "isolation either way. Groups nest up to eight deep.",
  groupTitle: "Group the two layers below the active one",
  group: "Group",
  add: "Add layer",
  addAdjustmentTitle:
    "Stack the adjustment chain as a non-destructive layer — it transforms " +
    "everything beneath it, and deleting it restores the original exactly",
  addAdjustment: "Add adjustment layer",
  bakeTitle:
    "Bake the adjustment chain destructively into the active layer " +
    "(undoable)",
  bake: "Bake adjustments into layer",
  undo: "Undo",
  undoStep: "Undo {label}",
  redo: "Redo",
  redoStep: "Redo {label}",
  stepBack: "Step back to just after “{label}”",
  here: "▸ here",
  stepForward: "Step forward through “{label}”",
  history:
    "History: {depth} undo / {redoDepth} redo, {bytes} of {maxBytes} and " +
    "{steps} steps.",
  dropped:
    "{count, plural, one {# older edit fell past that bound and is now permanent.} other {# older edits fell past that bound and are now permanent.}}",
  nothingDropped: "Nothing has fallen past the bound yet.",
  noGpu:
    "Compositing more than one layer needs WebGPU; without it only a " +
    "single visible layer at full opacity in Normal mode can be shown.",
});

/** The LAYERS palette + the undo readout — a PURE component (props in,
 *  elements out, no hooks) so a spec can render it without a DOM and
 *  assert what it says. Rows read TOP-DOWN (a layers palette's
 *  convention); the engine's own order is bottom-first. */
export function LayersSection({
  layers,
  active,
  history,
  blendModes,
  layersNote,
  gpu,
  disabled,
  onSelect,
  onAdd,
  onDuplicate,
  onRemove,
  onMove,
  onVisible,
  onOpacity,
  onBlend,
  onLock,
  onAddAdjustment,
  onMaskFromSelection,
  onMaskToggle,
  onClip,
  groups,
  onGroup,
  onUngroup,
  onGroupVisible,
  onGroupOpacity,
  onGroupPassThrough,
  onMaskClear,
  editTarget = "pixels",
  onAddMask,
  onEditTarget,
  onBake,
  onUndoTo,
  onRedoTo,
  onUndo,
  onRedo,
  filter,
  onFilter,
  onColor,
}: {
  /** BOTTOM-first, as the engine holds them. */
  layers: readonly LayerInfo[];
  active: number;
  history: LayerHistory | null;
  blendModes: readonly string[];
  /** How the stack was opened (the PSD lane's honest one-liner). */
  layersNote: string | null;
  gpu: boolean;
  disabled: boolean;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onVisible: (index: number, visible: boolean) => void;
  onOpacity: (index: number, opacity: number) => void;
  onBlend: (index: number, blend: string) => void;
  onLock: (index: number, locked: boolean) => void;
  /** Stack the chain as a non-destructive adjustment layer. */
  onAddAdjustment: () => void;
  /** Make the current selection this layer's mask. */
  onMaskFromSelection: (index: number) => void;
  /** Toggle whether the mask applies (the coverage is retained). */
  onMaskToggle: (index: number, enabled: boolean) => void;
  onClip: (index: number, clipped: boolean) => void;
  groups: readonly LayerGroupInfo[];
  onGroup: () => void;
  onUngroup: (id: number) => void;
  onGroupVisible: (id: number, visible: boolean) => void;
  onGroupOpacity: (id: number, opacity: number) => void;
  onGroupPassThrough: (id: number, passThrough: boolean) => void;
  /** Delete the mask outright. */
  onMaskClear: (index: number) => void;
  /** What the paint tools write on the ACTIVE layer. */
  editTarget?: EditTarget;
  /** Add Layer Mask: reveal all (click) or hide all (Alt-click). */
  onAddMask?: (index: number, revealAll: boolean) => void;
  /** Paint the layer's pixels or its mask. */
  onEditTarget?: (index: number, target: EditTarget) => void;
  /** Walk BACK `n` journal steps (n undos — the journal is a stack). */
  onUndoTo: (n: number) => void;
  /** Walk FORWARD `n` journal steps. */
  onRedoTo: (n: number) => void;
  onBake: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** The search and filter bar (none when omitted). */
  filter?: LayerFilter;
  onFilter?: (patch: Partial<LayerFilter>) => void;
  /** A row's colour label. */
  onColor?: (index: number, color: ColorLabel) => void;
}) {
  // Top-down for reading; the engine's indices are preserved on each row.
  // The filter bar narrows the rows shown, never the stack.
  const rows = [...layers]
    .reverse()
    .filter((l) => !filter || matchesLayerFilter(l, filter));
  const multi = layers.length > 1;
  return (
    <Section
      title={
        <span data-image-layers-title>
          {layers.length > 0
            ? t(LAYERS.titleCount, { count: layers.length })
            : t(LAYERS.title)}
        </span>
      }
      data-image-layers-section
    >
      {layers.length === 0 ? (
        <div style={note}>{t(LAYERS.empty)}</div>
      ) : (
        <div style={note}>{t(LAYERS.sameStack)}</div>
      )}
      {filter && onFilter && layers.length > 0 ? (
        <LayerFilterBar
          filter={filter}
          shown={rows.length}
          total={layers.length}
          disabled={disabled}
          onFilter={onFilter}
        />
      ) : null}
      {rows.map((l, i) => (
        <Fragment key={l.id}>
          {/* A GROUP HEADER, emitted once at the top of its run (rows
              read top-down, so that is the FIRST row of the group we
              meet). Groups own their own visibility, opacity and blend
              because they composite in isolation — the header is where
              those live. */}
          {l.group !== null && rows[i - 1]?.group !== l.group
            ? (() => {
                const g = groups.find((x) => x.id === l.group);
                return g ? (
                  <div
                    style={{ ...row, fontWeight: 600 }}
                    data-image-group-row={g.id}
                  >
                    <input
                      type="checkbox"
                      data-image-group-visible={g.id}
                      checked={g.visible}
                      disabled={disabled}
                      onChange={(e) => onGroupVisible(g.id, e.target.checked)}
                    />
                    <span data-image-group-name={g.id}>{g.name}</span>
                    <Slider
                      label=""
                      min={0}
                      max={1}
                      step={0.05}
                      value={g.opacity}
                      disabled={disabled}
                      onChange={(v) => onGroupOpacity(g.id, v)}
                    />
                    <button
                      type="button"
                      title={
                        g.isolates
                          ? g.passThrough
                            ? t(LAYERS.groupForcedIsolation)
                            : t(LAYERS.groupIsolated)
                          : t(LAYERS.groupPassThrough)
                      }
                      data-image-group-mode={g.id}
                      disabled={disabled}
                      onClick={() => onGroupPassThrough(g.id, !g.passThrough)}
                    >
                      {t(g.isolates ? LAYERS.iso : LAYERS.pass)}
                    </button>
                    <IconButton
                      label={t(LAYERS.dissolve)}
                      title={t(LAYERS.dissolveTitle)}
                      data-image-group-ungroup={g.id}
                      disabled={disabled}
                      onClick={() => onUngroup(g.id)}
                    >
                      ⌧
                    </IconButton>
                  </div>
                ) : null;
              })()
            : null}
          <div
            data-image-layer-row={l.index}
            style={{
              ...row,
              paddingLeft: l.group !== null ? space[3] : undefined,
              background: l.index === active ? color.primarySoft : undefined,
            }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                minWidth: 0,
              }}
            >
              <input
                type="checkbox"
                title={t(LAYERS.visible)}
                data-image-layer-visible={l.index}
                checked={l.visible}
                disabled={disabled}
                onChange={(e) => onVisible(l.index, e.target.checked)}
              />
              {onColor ? (
                <ColorLabelPicker
                  value={l.color}
                  disabled={disabled}
                  testAttr={{ "data-image-layer-row-color": l.index }}
                  onChange={(c) => onColor(l.index, c)}
                />
              ) : null}
              <button
                type="button"
                data-image-layer-select={l.index}
                disabled={disabled}
                onClick={() => onSelect(l.index)}
                style={{
                  font: `12px ${font.sans}`,
                  fontWeight: l.index === active ? 600 : 400,
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {l.name}
                {l.link !== null ? " ⛓" : ""}
                {l.index === active ? " ●" : ""}
              </button>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <select
                data-image-layer-blend={l.index}
                value={l.blend}
                disabled={disabled || blendModes.length === 0}
                title={t(LAYERS.blendMode)}
                onChange={(e) => onBlend(l.index, e.target.value)}
                style={{
                  font: `11px ${font.sans}`,
                  maxWidth: 96,
                }}
              >
                {(blendModes.length > 0 ? blendModes : [l.blend]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                title={t(LAYERS.opacity)}
                data-image-layer-opacity={l.index}
                value={l.opacity}
                disabled={disabled}
                onChange={(e) => onOpacity(l.index, Number(e.target.value))}
                style={{ width: 56 }}
              />
              <input
                type="checkbox"
                title={t(LAYERS.lock)}
                data-image-layer-lock={l.index}
                checked={l.locked}
                disabled={disabled}
                onChange={(e) => onLock(l.index, e.target.checked)}
              />
              {/* MASK. Three states in two controls, because "no mask",
                "masked" and "masked but disabled" are genuinely
                different and collapsing them would lose the one users
                rely on: a disabled mask KEEPS its coverage. */}
              {l.hasMask ? (
                <>
                  {/* THE EDIT TARGET: pixels or mask. Photoshop's two
                    thumbnails, as one toggle — bold M means the paint
                    tools write the mask of this (active) layer. */}
                  <button
                    type="button"
                    title={
                      l.index === active && editTarget === "mask"
                        ? t(LAYERS.paintingMask)
                        : t(LAYERS.paintMask)
                    }
                    data-image-layer-edit-target={l.index}
                    data-target={l.index === active ? editTarget : "pixels"}
                    disabled={disabled || !onEditTarget}
                    onClick={() =>
                      onEditTarget?.(
                        l.index,
                        l.index === active && editTarget === "mask"
                          ? "pixels"
                          : "mask",
                      )
                    }
                    style={{
                      fontWeight:
                        l.index === active && editTarget === "mask"
                          ? 700
                          : undefined,
                    }}
                  >
                    M
                  </button>
                  <input
                    type="checkbox"
                    title={
                      l.maskEnabled
                        ? t(LAYERS.maskApplying)
                        : t(LAYERS.maskDisabled)
                    }
                    data-image-layer-mask={l.index}
                    checked={l.maskEnabled}
                    disabled={disabled}
                    onChange={(e) => onMaskToggle(l.index, e.target.checked)}
                  />
                  <IconButton
                    label={t(LAYERS.deleteMask)}
                    title={t(LAYERS.deleteMaskTitle)}
                    data-image-layer-mask-clear={l.index}
                    disabled={disabled}
                    onClick={() => onMaskClear(l.index)}
                  >
                    ⌫
                  </IconButton>
                </>
              ) : (
                <>
                  <IconButton
                    label={t(LAYERS.selectionToMask)}
                    title={t(LAYERS.selectionToMaskTitle)}
                    data-image-layer-mask-add={l.index}
                    disabled={disabled}
                    onClick={() => onMaskFromSelection(l.index)}
                  >
                    ⬚
                  </IconButton>
                  <IconButton
                    label={t(LAYERS.addMask)}
                    title={t(LAYERS.addMaskTitle)}
                    data-image-layer-mask-new={l.index}
                    disabled={disabled || !onAddMask}
                    onClick={(e) => onAddMask?.(l.index, !e.altKey)}
                  >
                    ◐
                  </IconButton>
                </>
              )}
              <IconButton
                label={l.clipped ? t(LAYERS.releaseClip) : t(LAYERS.clip)}
                title={l.clipped ? t(LAYERS.clippedTitle) : t(LAYERS.clipTitle)}
                data-image-layer-clip={l.index}
                disabled={disabled || l.index === 0}
                onClick={() => onClip(l.index, !l.clipped)}
                style={{ fontWeight: l.clipped ? 700 : undefined }}
              >
                ⌐
              </IconButton>
              <IconButton
                label={t(LAYERS.moveUp)}
                title={t(LAYERS.moveUpTitle)}
                data-image-layer-up={l.index}
                disabled={disabled || l.index === layers.length - 1}
                onClick={() => onMove(l.index, l.index + 1)}
              >
                ↑
              </IconButton>
              <IconButton
                label={t(LAYERS.moveDown)}
                title={t(LAYERS.moveDownTitle)}
                data-image-layer-down={l.index}
                disabled={disabled || l.index === 0}
                onClick={() => onMove(l.index, l.index - 1)}
              >
                ↓
              </IconButton>
              <IconButton
                label={t(LAYERS.duplicate)}
                title={t(LAYERS.duplicateTitle)}
                data-image-layer-duplicate={l.index}
                disabled={disabled}
                onClick={() => onDuplicate(l.index)}
              >
                ⧉
              </IconButton>
              <IconButton
                label={t(LAYERS.remove)}
                title={multi ? t(LAYERS.removeTitle) : t(LAYERS.keepOne)}
                data-image-layer-remove={l.index}
                disabled={disabled || !multi}
                onClick={() => onRemove(l.index)}
              >
                ✕
              </IconButton>
            </span>
          </div>
        </Fragment>
      ))}
      {groups.length > 0 ? (
        <div style={note} data-image-groups-note>
          {t(LAYERS.groupsNote)}
          <About>{t(LAYERS.groupsAbout)}</About>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, marginTop: space[1] }}>
        <button
          type="button"
          title={t(LAYERS.groupTitle)}
          data-image-layers-group
          disabled={disabled || layers.length < 2}
          onClick={onGroup}
        >
          {t(LAYERS.group)}
        </button>
        <button
          type="button"
          data-image-layer-add
          disabled={disabled}
          onClick={onAdd}
        >
          {t(LAYERS.add)}
        </button>
        <button
          type="button"
          data-image-layer-add-adjustment
          disabled={disabled}
          title={t(LAYERS.addAdjustmentTitle)}
          onClick={onAddAdjustment}
        >
          {t(LAYERS.addAdjustment)}
        </button>
        <button
          type="button"
          data-image-layer-bake
          disabled={disabled || !gpu}
          title={t(LAYERS.bakeTitle)}
          onClick={onBake}
        >
          {t(LAYERS.bake)}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: space[1] }}>
        <button
          type="button"
          data-image-undo
          disabled={disabled || !history?.canUndo}
          onClick={onUndo}
        >
          {history?.undoLabel
            ? t(LAYERS.undoStep, { label: history.undoLabel })
            : t(LAYERS.undo)}
        </button>
        <button
          type="button"
          data-image-redo
          disabled={disabled || !history?.canRedo}
          onClick={onRedo}
        >
          {history?.redoLabel
            ? t(LAYERS.redoStep, { label: history.redoLabel })
            : t(LAYERS.redo)}
        </button>
      </div>
      {/* HISTORY — the list, not just the counter. The catalog records
          this as a PANEL gap and not an engine gap, and it was right:
          the journal has carried labels, scopes and a dropped count all
          along, and the only thing missing was somewhere to show them.
          Steps are listed oldest-first with the current position marked;
          clicking one walks the journal to it. */}
      {history &&
      (history.undoSteps.length > 0 || history.redoSteps.length > 0) ? (
        <div data-image-history-list>
          {history.undoSteps.map((label, i) => (
            <button
              key={`u${i}-${label}`}
              type="button"
              data-image-history-step={i}
              disabled={disabled}
              title={t(LAYERS.stepBack, { label })}
              // Walking back N steps is N undos — the journal is a stack,
              // not a random-access log, and pretending otherwise would
              // mean holding every intermediate state.
              onClick={() => onUndoTo(history.undoSteps.length - 1 - i)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                opacity: 1,
              }}
            >
              {label}
            </button>
          ))}
          <div style={{ ...note, fontWeight: 600 }} data-image-history-here>
            {t(LAYERS.here)}
          </div>
          {history.redoSteps.map((label, i) => (
            <button
              key={`r${i}-${label}`}
              type="button"
              data-image-history-redo-step={i}
              disabled={disabled}
              title={t(LAYERS.stepForward, { label })}
              onClick={() => onRedoTo(i + 1)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                opacity: 0.55,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {history ? (
        <div style={note} data-image-history-readout>
          {t(LAYERS.history, {
            depth: history.depth,
            redoDepth: history.redoDepth,
            bytes: mb(history.bytes),
            maxBytes: mb(history.maxBytes),
            steps: history.maxEntries,
          })}{" "}
          {history.dropped > 0
            ? t(LAYERS.dropped, { count: history.dropped })
            : t(LAYERS.nothingDropped)}
        </div>
      ) : null}
      {layersNote ? (
        <div style={note} data-image-layers-source-note>
          {layersNote}
        </div>
      ) : null}
      {!gpu && layers.length > 1 ? (
        <div style={note}>{t(LAYERS.noGpu)}</div>
      ) : null}
      <About>
        <p data-image-layers-note>{t(SCOPE.layers)}</p>
      </About>
    </Section>
  );
}

const P = defineMessages("image.panel", {
  title: "Image adjustments",
  ingestFrame: "Use selected frame",
  ingestFrameTitle: "Load the selected image frame into the panel",
  liveTitle:
    "Sliders update the frame as they move; full resolution follows when " +
    "they rest",
  live: "Live",
  working: "Working…",
  loadFirst: "Load an image first",
  applyTitle:
    "Show the adjusted image in its frame (the placed file is unchanged)",
  apply: "Apply",
  resetTitle: "Return every adjustment to its starting value",
  reset: "Reset",
  noGpu:
    "WebGPU is not available here, so adjustments, filters and painting " +
    "are disabled.",
  engineUnavailable:
    "The image engine could not start. Diagnostics, at the bottom of the " +
    "panel, has the reason.",
  image: "Image",
  colour: "Colour",
  cmykConverted:
    "This CMYK image was converted to sRGB through its embedded profile; " +
    "edits and save-back are RGB.",
  cmykUnmanaged:
    "This CMYK image has no usable profile, so it was converted to sRGB " +
    "without colour management; edits and save-back are RGB.",
  cmykAbout:
    "The conversion follows Photoshop's default view: relative colorimetric " +
    "with black-point compensation, approximated by the profile's " +
    "perceptual table. Layers that use a blend mode other than Normal are " +
    "not imported, because Photoshop blends them in CMYK.",
  depth: "Depth",
  depthReduced: "16-bit source, reduced to 8",
  depthNote:
    "Layers, edits and save-back work in 8 bits, so the extra precision is " +
    "not kept.",
  histogram: "Histogram (R / G / B / luma)",
  histogramEmpty: "Choose Use selected frame to see the histogram.",
  autoEnhance: "Auto-enhance",
  autoEnhanceNote:
    "Auto-enhance sets levels and white balance from the histogram; Apply " +
    "shows the result.",
  selection: "Selection",
  bounds: "Bounds",
  coverage: "Coverage",
  deselect: "Deselect",
  noSelection:
    "No selection — adjustments apply to the whole image. Use the marquee / " +
    "lasso / wand tools (shift = add, alt = subtract, shift+alt = " +
    "intersect).",
  tone: "Tone",
  toneSelection: "Tone — applies to selection",
  exposure: "Exposure (EV)",
  brightness: "Brightness",
  contrast: "Contrast",
  saturation: "Saturation",
  whiteBalance: "White balance",
  temp: "Temp",
  tint: "Tint",
  levels: "Levels (composite)",
  inBlack: "In black",
  gamma: "Gamma",
  inWhite: "In white",
  outBlack: "Out black",
  outWhite: "Out white",
  levelsPerChannel: "Levels (per channel)",
  blk: "blk",
  gam: "gam",
  wht: "wht",
  channelInBlack: "{channel} in black",
  channelGamma: "{channel} gamma",
  channelInWhite: "{channel} in white",
  color: "Color",
  vibrance: "Vibrance",
  colorBalance: "Color balance",
  photoFilter: "Photo filter",
  gel: "Gel",
  density: "Density",
  preserveLuminosity: "Preserve luminosity",
  channelMixer: "Channel mixer",
  mixerOut: "out {channel}",
  effects: "Effects",
  blackWhite: "Black & white",
  defaultMix: "Default mix",
  posterize: "Posterize",
  posterizeLevels: "Levels",
  threshold: "Threshold",
  cut: "Cut (luma)",
  generateSelection: "Generate — fills the selection",
  generateImage: "Generate — fills the whole image",
  gradient: "Gradient",
  startColour: "Start colour",
  endColour: "End colour",
  fillGradientTitle: "Paint the gradient into the selection",
  generatorsGpuOnly: "Generators are GPU-only — no WebGPU device",
  fill: "Fill",
  noise: "Noise",
  fillNote:
    "A fill is DESTRUCTIVE into the engine source (the document and the " +
    "placed file are untouched — re-ingest restores). Two stops only in " +
    "v0; the gradient geometry follows the selection bounds.",
  filters: "Filters",
  blur: "Blur (σ px)",
  sharpen: "Sharpen",
  hueRotate: "Hue rotate (°)",
  invert: "Invert colors",
  gradientMapDistort: "Gradient map & distort",
  gradientMapTitle:
    "Map luminance through a two-stop colour ramp (shadows to highlights)",
  gradientMap: "Gradient map",
  gradientMapNote:
    "A gradient map replaces colour with a ramp read from luminance; the " +
    "distortions resample through one backward map, so they share a " +
    "reconstruction filter and edge rule with the crop straighten.",
  stylize: "Stylize, blur & pixelate",
  galleryNote:
    "Each opens its dialog: every parameter of its kernel, previewed live on " +
    "the canvas, applied with OK as one undo step. Median, Maximum and " +
    "Minimum are with the rank filters; Average fills the selection with " +
    "its average colour at once.",
  average: "Average",
  averageTitle: "Fill the selection (or the layer) with its average colour",
  imageSizeOpen: "Image size…",
  trimOpen: "Trim…",
  rotateOpen: "Rotate…",
  resize: "Resize",
  nearest: "Nearest",
  resampleTitle: "Resample the source",
  resampleGpuOnly: "Resample is GPU-only — no WebGPU device",
  resample: "Resample",
  psdLayers: "PSD layers ({count}" + ")",
  psdHidden: "{name} (hidden in the PSD)",
  layerName: "Layer name",
  psdOpacity: "Layer opacity (%)",
  psdRemove: "Remove layer from the PSD",
  psdRemoveTitle: "Remove layer (in the exported PSD)",
  curves: "Curves",
  curveChannel: "Curve channel",
  red: "Red",
  green: "Green",
  blue: "Blue",
  resetCurve: "Reset curve",
  crop: "Crop + straighten",
  aspect: "Aspect",
  aspectFree: "free",
  aspectOriginal: "original",
  straighten: "Straighten°",
  applyCrop: "Apply crop",
  resetCrop: "Reset crop",
  applyToFile: "Apply to file",
  save: "Save…",
  ready: "Ready",
  saveNote:
    "Writes the adjustments into a copy of the source file at full " +
    "resolution.",
  saveAbout:
    "A single-layer PSD gets its channel pixels written back; a multi-layer " +
    "PSD is flattened into a new single-layer PSD, and the panel says so. A " +
    "PNG or JPEG is re-encoded. Save… hands the result to the editor's file " +
    "saver; where there is none, the Export Center delivers the same bytes.",
  diagnostics: "Diagnostics",
  bundle: "Bundle",
  engine: "Engine",
  source: "Source",
  none: "none",
  diagnosticsNote:
    "Apply shows a preview layer in the frame; the document and the placed " +
    "file stay unchanged until Apply to file. A crop cuts the image itself, " +
    "straightening first when the angle is not zero (straightening needs " +
    "WebGPU). The paint tools preview every pointer sample; the adjustment " +
    "sliders preview when Live is on.",
  engineReady: "ready (WebGPU)",
  engineReadyNoGpu: "ready (no WebGPU — adjustments disabled)",
});

/** The one-click filter gallery: each button's name and what it does. */
const GALLERY = defineMessages("image.gallery", {
  emboss: "Emboss",
  embossTitle:
    "Directional relief. A flat region stays mid-grey, which is what makes " +
    "it read as relief rather than as an edge map.",
  findEdges: "Find edges",
  findEdgesTitle:
    "Sobel magnitude, inverted — dark lines on white, and run per channel " +
    "so an equal-luminance colour edge still registers.",
  motionBlur: "Motion blur",
  motionBlurTitle:
    "Directional blur along a line, centred on the pixel so the subject " +
    "smears symmetrically.",
  spinBlur: "Spin blur",
  spinBlurTitle:
    "Radial blur, spin: the smear grows outward because arc length scales " +
    "with radius.",
  zoomBlur: "Zoom blur",
  zoomBlurTitle:
    "Radial blur, zoom: the same arc walk holding the angle and varying " +
    "the radius.",
  mosaic: "Mosaic",
  mosaicTitle:
    "Pixelate by quantizing the source coordinate and sampling the cell " +
    "centre — hard blocks, not smoothed steps.",
  paintDaubs: "Paint daubs",
  paintDaubsTitle:
    "Kuwahara: takes the lowest-variance quadrant's mean, so a region " +
    "flattens toward paint while its boundary stays put.",
  posterEdges: "Poster edges",
  posterEdgesTitle:
    "Posterised colour plus a darkened outline. The two halves are " +
    "independent — that is what separates Cutout from Ink Outlines.",
  glowingEdges: "Glowing edges",
  glowingEdgesTitle:
    "Edge magnitude colourised and boosted; keeps the source hue instead of " +
    "going grey.",
  halftone: "Halftone",
  halftoneTitle:
    "Screen-angle halftone. Dot AREA carries the tone, not dot darkness — " +
    "which is what lets it survive a 1-bit output.",
  filmGrain: "Film grain",
  filmGrainTitle:
    "Deterministic hash of the coordinate and seed, never host randomness, " +
    "so undo/redo cannot shimmer.",
  spatter: "Spatter",
  spatterTitle:
    "Random local displacement. Anisotropy is the whole difference between " +
    "Spatter and Sprayed Strokes.",
  crosshatch: "Crosshatch",
  crosshatchTitle:
    "Hatching modulated by luminance. The SET COUNT alone gives Graphic Pen " +
    "(1), Crosshatch (2) and Sumi-e (3).",
  basRelief: "Bas relief",
  basReliefTitle:
    "Directional lighting over a luminance heightfield. Chrome and Plastic " +
    "Wrap are approximated at extreme settings, not modelled.",
  photocopy: "Photocopy",
  photocopyTitle:
    "Luminance threshold with a soft ramp; the ramp width is what makes " +
    "Stamp hard and Charcoal soft.",
  stainedGlass: "Stained glass",
  stainedGlassTitle:
    "Cellular tiling with a border term. The border weight alone separates " +
    "Crystallize from Stained Glass.",
  texturizer: "Texturizer",
  texturizerTitle:
    "Procedural surface texture modulating shading; kind picks Canvas / " +
    "Burlap / Brick rather than a kernel per material.",
  despeckle: "Despeckle",
  despeckleTitle:
    "Smooths speckle without softening edges: it gates on the INNER range, " +
    "which a speckle inflates and an edge does not.",
  dustScratches: "Dust & scratches",
  dustScratchesTitle:
    "Replaces a pixel with the neighbourhood median only where it differs " +
    "by more than the threshold. Threshold 1 is the identity; 0 is a plain " +
    "median.",
  offset: "Offset (wrap)",
  offsetTitle:
    "Filter > Other > Offset — moves the pixels and wraps at the edge, " +
    "which is what makes a texture tile seamlessly.",
  lensBlur: "Lens blur",
  lensBlurTitle:
    "Bokeh: a flat-topped disc, with highlights weighted up before the " +
    "average and pulled back after — so a bright speck spreads as a bright " +
    "ball, not a dim smudge.",
  reduceNoise: "Reduce noise",
  reduceNoiseTitle:
    "Bilateral denoise: taps are weighted by colour distance as well as " +
    "distance, so it refuses to average across an edge.",
  smartSharpen: "Smart sharpen",
  smartSharpenTitle:
    "Unsharp with two gates: local contrast below the threshold is left " +
    "alone as noise, and the correction is clamped so a strong edge cannot " +
    "ring into a halo.",
  selectiveColour: "Selective colour",
  selectiveColourTitle:
    "Per-range CMYK shift — this button targets the reds. Range membership " +
    "goes by channel ORDER, so there is no seam at a hue boundary and no " +
    "wraparound case.",
});

/** The filters the rank section opens (Median, Maximum, Minimum). */
const RANK_FILTERS: ReadonlySet<FilterId> = new Set([
  "median",
  "maximum",
  "minimum",
]);

/** `boxBlur` → `box-blur` (the buttons' data attributes). */
const kebab = (id: string) =>
  id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Each filter button's own data attribute (`data-image-box-blur`, …),
 *  built once here: the React Compiler does not lower a computed key. */
const FILTER_ATTRS: Record<string, Record<string, string>> = Object.fromEntries(
  FILTERS.map((f) => [f.id, { [`data-image-${kebab(f.id)}`]: "" }]),
);

/** The buttons' tooltips, where the panel always had one. */
const FILTER_TITLES: Partial<Record<FilterId, string>> = {
  emboss: GALLERY.embossTitle,
  findEdges: GALLERY.findEdgesTitle,
  motionBlur: GALLERY.motionBlurTitle,
  radialBlur: GALLERY.spinBlurTitle,
  mosaic: GALLERY.mosaicTitle,
  paintDaubs: GALLERY.paintDaubsTitle,
  posterEdges: GALLERY.posterEdgesTitle,
  glowingEdges: GALLERY.glowingEdgesTitle,
  halftone: GALLERY.halftoneTitle,
  filmGrain: GALLERY.filmGrainTitle,
  spatter: GALLERY.spatterTitle,
  crosshatch: GALLERY.crosshatchTitle,
  basRelief: GALLERY.basReliefTitle,
  photocopy: GALLERY.photocopyTitle,
  stainedGlass: GALLERY.stainedGlassTitle,
  texturizer: GALLERY.texturizerTitle,
  despeckle: GALLERY.despeckleTitle,
  dustScratches: GALLERY.dustScratchesTitle,
  offset: GALLERY.offsetTitle,
  lensBlur: GALLERY.lensBlurTitle,
  reduceNoise: GALLERY.reduceNoiseTitle,
  smartSharpen: GALLERY.smartSharpenTitle,
  selectiveColour: GALLERY.selectiveColourTitle,
};

export function makeImagePanel(session: ImageSession) {
  // A declaration, so the React Compiler sees the component (it cannot see
  // `return function ImagePanel()`, editor ADR 229).
  function ImagePanel() {
    // The session as a render value (react-live): a new view after every
    // change, so what is read from it during render is read again.
    const live = useLive(session, onDidChangeOf);
    const { t } = useStrings();
    // Control points per curve: the composite and each channel's.
    const [curveChannel, setCurveChannel] = useState<CurveChannel>("rgb");
    const [curvePointsBy, setCurvePointsBy] = useState<
      Record<CurveChannel, Array<[number, number]>>
    >({
      rgb: IDENTITY_CURVE,
      r: IDENTITY_CURVE,
      g: IDENTITY_CURVE,
      b: IDENTITY_CURVE,
    });
    const curvePoints = curvePointsBy[curveChannel];
    const [aspect, setAspect] = useState<AspectPreset>("free");
    const [angle, setAngle] = useState(0);
    // Pattern / smart-object section state (slider positions only).
    const [patternScale, setPatternScale] = useState(1);
    const [shapeRadius, setShapeRadius] = useState(8);
    const [smartScale, setSmartScale] = useState(1);
    const [canvasSize, setCanvasSize] = useState<CanvasSize>({
      width: 0,
      height: 0,
      anchorX: 1,
      anchorY: 1,
    });
    const [modifyRadius, setModifyRadius] = useState(4);
    const [distort, setDistort] = useState<DistortParams>(DISTORT_DEFAULTS);
    const [lookupName, setLookupName] = useState<string | null>(null);
    const [hueSatRange, setHueSatRange] = useState(-1);
    // Generate-section local state (the request shape, not engine state).
    const [pathThreshold, setPathThreshold] = useState(128);
    const [gradKind, setGradKind] = useState<GradientKind>("linear");
    const [stop0, setStop0] = useState(0);
    const [stop1, setStop1] = useState(1);
    const [noiseAmount, setNoiseAmount] = useState(0.5);
    const [alignTo, setAlignTo] = useState<AlignTo>("canvas");

    const s = live.state();
    const p = s.params;
    // Track the natural size when the source changes (a new import, a
    // crop, a resize). Adjusted while rendering, React's pattern for state
    // that follows a value (an effect would paint the old size first).
    const sourceSize = `${s.source?.handle ?? ""}:${s.source?.width ?? 0}x${s.source?.height ?? 0}`;
    const [sizedFor, setSizedFor] = useState(sourceSize);
    if (sizedFor !== sourceSize) {
      setSizedFor(sourceSize);
      setCanvasSize((c) => ({
        ...c,
        width: s.source?.width ?? 0,
        height: s.source?.height ?? 0,
      }));
    }
    // A NEW image starts from identity in the session (its params are
    // reset on ingest), so the pickers this panel keeps for itself follow:
    // a curve left drawn here would be re-sent, shape and all, by the
    // next drag on it. Keyed on the source OBJECT, which a crop or a
    // resize updates in place and only a new ingest replaces.
    const [pickersFor, setPickersFor] = useState(s.source);
    if (pickersFor !== s.source) {
      setPickersFor(s.source);
      setCurvePointsBy({
        rgb: IDENTITY_CURVE,
        r: IDENTITY_CURVE,
        g: IDENTITY_CURVE,
        b: IDENTITY_CURVE,
      });
      setAspect("free");
      setAngle(0);
    }
    // The Curves tools (Auto, the eyedroppers) set the channel curves in
    // the session; the editor here follows them.
    const [curvesFor, setCurvesFor] = useState(s.channelCurves);
    if (curvesFor !== s.channelCurves) {
      setCurvesFor(s.channelCurves);
      const c = s.channelCurves;
      if (c) setCurvePointsBy((m) => ({ ...m, r: c.r, g: c.g, b: c.b }));
    }
    const disabled = s.busy || !s.source;
    const engineLine =
      s.engine === "ready"
        ? s.gpu
          ? t(P.engineReady)
          : t(P.engineReadyNoGpu)
        : s.engine;

    const setBase = (k: keyof AdjustParams, v: number) =>
      session.setParams({ [k]: v });

    // The extended stages are nested objects — patch them immutably and
    // hand the whole sub-object back to the session (shallow-merged).
    const setBalance = (
      range: "shadows" | "midtones" | "highlights",
      axis: 0 | 1 | 2,
      v: number,
    ) => {
      const next = { ...p.colorBalance };
      const row3 = [...next[range]] as [number, number, number];
      row3[axis] = v;
      next[range] = row3;
      session.setParams({ colorBalance: next });
    };
    const setMixer = (out: "r" | "g" | "b", i: 0 | 1 | 2 | 3, v: number) => {
      const next = { ...p.channelMixer };
      const r4 = [...next[out]] as [number, number, number, number];
      r4[i] = v;
      next[out] = r4;
      session.setParams({ channelMixer: next });
    };
    const setLevelsRgb = (
      ch: "r" | "g" | "b",
      key: keyof LevelsChannel,
      v: number,
    ) => {
      const next = { ...p.levelsRgb, [ch]: { ...p.levelsRgb[ch], [key]: v } };
      session.setParams({ levelsRgb: next });
    };
    const setBw = (i: number, v: number) => {
      const w = [...p.blackWhite.weights] as typeof p.blackWhite.weights;
      w[i] = v;
      session.setParams({ blackWhite: { ...p.blackWhite, weights: w } });
    };

    const pushCurve = (next: Array<[number, number]>) => {
      setCurvePointsBy((m) => ({ ...m, [curveChannel]: next }));
      session.setCurvePoints(next, curveChannel);
    };

    const machine = live.cropMachine();

    return (
      <div style={{ padding: space[2], fontSize: "12px" }}>
        <div style={panelTitle}>{t(P.title)}</div>

        {/* THE COMMIT BAR — sticky, so Apply, Reset and the status line
            (where every refusal is written) stay in view while the
            sections below scroll. */}
        <div style={actionBar} data-image-action-bar>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: space[2],
            }}
          >
            <button
              type="button"
              disabled={s.busy}
              onClick={() => void session.ingestSelection()}
              title={t(P.ingestFrameTitle)}
            >
              {t(P.ingestFrame)}
            </button>
            <label title={t(P.liveTitle)}>
              <input
                type="checkbox"
                data-image-live-preview
                checked={s.livePreview}
                onChange={(e) => session.setLivePreview(e.target.checked)}
              />{" "}
              {t(P.live)}
            </label>
            <button
              type="button"
              disabled={disabled}
              title={
                disabled
                  ? s.busy
                    ? t(P.working)
                    : t(P.loadFirst)
                  : t(P.applyTitle)
              }
              onClick={() => void session.apply()}
            >
              {t(P.apply)}
            </button>
            <button
              type="button"
              data-image-reset
              disabled={s.busy}
              title={t(P.resetTitle)}
              onClick={() => {
                // session.reset() restores the FULL identity params — every
                // stage below, including the extended ones; the local
                // pickers are the panel's own state.
                void session.reset();
                setCurvePointsBy({
                  rgb: IDENTITY_CURVE,
                  r: IDENTITY_CURVE,
                  g: IDENTITY_CURVE,
                  b: IDENTITY_CURVE,
                });
                setAspect("free");
                setAngle(0);
                setGradKind("linear");
                setStop0(0);
                setStop1(1);
                setNoiseAmount(0.5);
              }}
            >
              {t(P.reset)}
            </button>
          </div>
          {/* The one line every door writes its outcome to — a result, or
              a stated reason there is none. Addressable so a journey can
              assert the app answered at all: silence here is what an
              unhandled throw looks like from the outside. */}
          <div
            style={{ ...note, opacity: 0.85 }}
            data-image-status
            role="status"
          >
            {s.status}
          </div>
          {s.engine === "ready" && !s.gpu ? (
            <div style={note} data-image-no-gpu>
              {t(P.noGpu)}
            </div>
          ) : null}
          {s.engine === "unavailable" ? (
            <div style={note} data-image-engine-unavailable>
              {t(P.engineUnavailable)}
            </div>
          ) : null}
        </div>

        {s.source ? (
          <div style={row}>
            <span>{t(P.image)}</span>
            <span style={{ ...mono, textAlign: "right" }}>
              {`${s.source.name} · ${s.source.width}×${s.source.height} px`}
            </span>
          </div>
        ) : null}

        {/* THE DIALOG on top: a filter's parameters with its live
            preview, or Image Size / Trim / Arbitrary rotation. */}
        {s.dialog?.kind === "filter" && (
          <FilterDialog
            def={filterDef(s.dialog.filter.id)}
            dialog={s.dialog.filter}
            gpu={s.gpu}
            busy={s.busy}
            onChange={(patch) => session.setFilterValues(patch)}
            onPreview={(on) => void session.setFilterPreview(on)}
            onBefore={(b) => void session.setFilterBefore(b)}
            onOk={() => void session.commitFilterDialog()}
            onCancel={() => void session.cancelFilterDialog()}
          />
        )}
        {s.dialog?.kind === "imageSize" && s.source && (
          <ImageSizeDialog
            key={`${s.source.width}x${s.source.height}`}
            width={s.source.width}
            height={s.source.height}
            ppi={s.ppi}
            gpu={s.gpu}
            busy={s.busy}
            onResample={(w, h, f, ppi) => void session.resizeTo(w, h, f, ppi)}
            onResolution={(ppi) => {
              session.setResolution(ppi);
              void session.closeDialog();
            }}
            onCancel={() => void session.closeDialog()}
          />
        )}
        {s.dialog?.kind === "trim" && (
          <TrimDialog
            busy={s.busy}
            onTrim={(by) => void session.trim(by)}
            onCancel={() => void session.closeDialog()}
          />
        )}
        {s.dialog?.kind === "rotate" && (
          <RotateDialog
            gpu={s.gpu}
            busy={s.busy}
            onRotate={(d) => void session.rotateCanvas(d)}
            onCancel={() => void session.closeDialog()}
          />
        )}
        {s.dialog?.kind === "blendingOptions" &&
          (() => {
            const i = s.dialog.index;
            const l = s.layers.layers[i];
            return l ? (
              <BlendingOptionsDialog
                layer={l}
                disabled={s.busy}
                onFill={(v) => void session.setLayerFillOpacity(i, v)}
                onKnockout={(k) => void session.setLayerKnockout(i, k)}
                onBlendIf={(b) => void session.setLayerBlendIf(i, b)}
                onClose={() => void session.closeDialog()}
              />
            ) : null;
          })()}

        {/* CMS rung 1 — SAY which colour treatment the ingest applied.
            "sRGB assumed" is the honest majority case (most PNG/JPEG carry
            no profile) and a colour-critical user needs to see it, so it
            is stated rather than defaulted silently. */}
        {s.source ? (
          <div style={row}>
            <span>{t(P.colour)}</span>
            <span style={mono} data-image-colour-treatment={s.source.display}>
              {displayTreatmentLabel(s.source.display)}
            </span>
          </div>
        ) : null}

        {/* A CMYK source was CONVERTED: the layers, the edits and the
            save-back work in RGB from here on. Stated like the depth
            reduction below, because it is the same kind of lossy step. */}
        {s.source && isCmykConversion(s.source.display) ? (
          <div style={note} data-image-cmyk-converted>
            {s.source.display === "cmyk-converted"
              ? t(P.cmykConverted)
              : t(P.cmykUnmanaged)}
            <About>{t(P.cmykAbout)}</About>
          </div>
        ) : null}

        {/* DEPTH, stated for the same reason the colour treatment is: a
            16-bit source is REDUCED to 8 here. Shown only when it
            happened — an 8-bit file needs no announcement. */}
        {s.source?.depthReduced ? (
          <div style={row}>
            <span>{t(P.depth)}</span>
            <span style={mono} data-image-depth-reduced>
              {t(P.depthReduced)}
            </span>
          </div>
        ) : null}
        {s.source?.depthReduced ? (
          <div style={note}>{t(P.depthNote)}</div>
        ) : null}

        {/* Histogram */}
        <div style={sectionTitle}>{t(P.histogram)}</div>
        {s.histogram ? (
          <HistogramView hist={s.histogram} />
        ) : (
          <div style={note}>{t(P.histogramEmpty)}</div>
        )}
        <div
          style={{
            display: "flex",
            gap: space[2],
            marginTop: space[2],
          }}
        >
          <button
            type="button"
            data-image-auto-enhance
            disabled={disabled || !s.histogram}
            onClick={() => session.autoEnhance()}
          >
            {t(P.autoEnhance)}
          </button>
        </div>
        <div style={note}>{t(P.autoEnhanceNote)}</div>

        {/* Selection readout — the engine-side coverage the marquee /
            lasso / wand tools build. When one exists, the committed Apply
            masks every adjust/filter dispatch (GPU mix(a, result, mask))
            + the CPU curves pass by it. */}
        <div style={sectionTitle}>{t(P.selection)}</div>
        {s.selection ? (
          <>
            <div style={row}>
              <span>{t(P.bounds)}</span>
              <span style={mono} data-image-selection-bounds>
                {`${Math.round(s.selection.x)},${Math.round(s.selection.y)} ` +
                  `${Math.round(s.selection.w)}×${Math.round(s.selection.h)}`}
              </span>
            </div>
            <div style={row}>
              <span>{t(P.coverage)}</span>
              <span style={mono} data-image-selection-coverage>
                {(s.selection.coverage * 100).toFixed(1)}%
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: space[2],
                marginTop: space[1],
              }}
            >
              <button
                type="button"
                data-image-deselect
                disabled={s.busy}
                onClick={() => session.deselect()}
              >
                {t(P.deselect)}
              </button>
            </div>
          </>
        ) : (
          <div style={note}>{t(P.noSelection)}</div>
        )}

        {/* Tone / color base */}
        <div style={sectionTitle}>
          {t(s.selection ? P.toneSelection : P.tone)}
        </div>
        <Slider
          label={t(P.exposure)}
          min={-5}
          max={5}
          step={0.1}
          value={p.exposureEv}
          disabled={disabled}
          onChange={(v) => setBase("exposureEv", v)}
        />
        <Slider
          label={t(P.brightness)}
          min={-1}
          max={1}
          step={0.05}
          value={p.brightness}
          disabled={disabled}
          onChange={(v) => setBase("brightness", v)}
        />
        <Slider
          label={t(P.contrast)}
          min={0}
          max={4}
          step={0.05}
          value={p.contrast}
          disabled={disabled}
          onChange={(v) => setBase("contrast", v)}
        />
        <Slider
          label={t(P.saturation)}
          min={0}
          max={4}
          step={0.05}
          value={p.saturation}
          disabled={disabled}
          onChange={(v) => setBase("saturation", v)}
        />

        {/* White balance */}
        <div style={sectionTitle}>{t(P.whiteBalance)}</div>
        <Slider
          label={t(P.temp)}
          min={-1}
          max={1}
          step={0.02}
          value={p.temp}
          disabled={disabled}
          onChange={(v) => setBase("temp", v)}
        />
        <Slider
          label={t(P.tint)}
          min={-1}
          max={1}
          step={0.02}
          value={p.tint}
          disabled={disabled}
          onChange={(v) => setBase("tint", v)}
        />

        {/* Levels */}
        <div style={sectionTitle}>{t(P.levels)}</div>
        <Slider
          label={t(P.inBlack)}
          min={0}
          max={1}
          step={0.01}
          value={p.levels.inBlack}
          disabled={disabled}
          onChange={(v) => session.setLevels({ inBlack: v })}
        />
        <Slider
          label={t(P.gamma)}
          min={0.1}
          max={4}
          step={0.05}
          value={p.levels.gamma}
          disabled={disabled}
          onChange={(v) => session.setLevels({ gamma: v })}
        />
        <Slider
          label={t(P.inWhite)}
          min={0}
          max={1}
          step={0.01}
          value={p.levels.inWhite}
          disabled={disabled}
          onChange={(v) => session.setLevels({ inWhite: v })}
        />
        <Slider
          label={t(P.outBlack)}
          min={0}
          max={1}
          step={0.01}
          value={p.levels.outBlack}
          disabled={disabled}
          onChange={(v) => session.setLevels({ outBlack: v })}
        />
        <Slider
          label={t(P.outWhite)}
          min={0}
          max={1}
          step={0.01}
          value={p.levels.outWhite}
          disabled={disabled}
          onChange={(v) => session.setLevels({ outWhite: v })}
        />

        {/* Levels — PER CHANNEL (adjust.levels_rgb). Same Levels row
            idiom, three columns: in black / gamma / in white. The OUTPUT
            range stays composite above (the kernel has no output remap). */}
        <div style={sectionTitle}>{t(P.levelsPerChannel)}</div>
        <NumRow label="&nbsp;">
          <span
            style={{
              ...mono,
              width: 46,
              fontSize: 10,
              opacity: 0.6,
              textAlign: "center",
            }}
          >
            {t(P.blk)}
          </span>
          <span
            style={{
              ...mono,
              width: 46,
              fontSize: 10,
              opacity: 0.6,
              textAlign: "center",
            }}
          >
            {t(P.gam)}
          </span>
          <span
            style={{
              ...mono,
              width: 46,
              fontSize: 10,
              opacity: 0.6,
              textAlign: "center",
            }}
          >
            {t(P.wht)}
          </span>
        </NumRow>
        {(["r", "g", "b"] as const).map((ch) => (
          <NumRow key={ch} label={ch.toUpperCase()}>
            <Num
              testAttr={`data-image-levels-${ch}-black`}
              step={0.01}
              value={p.levelsRgb[ch].inBlack}
              disabled={disabled}
              onChange={(v) => setLevelsRgb(ch, "inBlack", v)}
              title={t(P.channelInBlack, { channel: ch.toUpperCase() })}
            />
            <Num
              testAttr={`data-image-levels-${ch}-gamma`}
              step={0.05}
              value={p.levelsRgb[ch].gamma}
              disabled={disabled}
              onChange={(v) => setLevelsRgb(ch, "gamma", v)}
              title={t(P.channelGamma, { channel: ch.toUpperCase() })}
            />
            <Num
              testAttr={`data-image-levels-${ch}-white`}
              step={0.01}
              value={p.levelsRgb[ch].inWhite}
              disabled={disabled}
              onChange={(v) => setLevelsRgb(ch, "inWhite", v)}
              title={t(P.channelInWhite, { channel: ch.toUpperCase() })}
            />
          </NumRow>
        ))}

        {/* COLOR — the grading stages (adjust.vibrance, .color_balance,
            .photo_filter, .channel_mixer). Chain order is fixed in the
            engine (documented on ingest::adjust_rgba8); this section only
            edits + forwards. */}
        <div style={sectionTitle}>{t(P.color)}</div>
        <Slider
          label={t(P.vibrance)}
          min={-1}
          max={1}
          step={0.05}
          value={p.vibrance}
          disabled={disabled}
          onChange={(v) => setBase("vibrance", v)}
        />

        <div style={{ ...kicker, marginTop: space[2] }}>
          {t(P.colorBalance)}
        </div>
        <NumRow label="&nbsp;">
          <span
            style={{
              ...mono,
              width: 46,
              fontSize: 10,
              opacity: 0.6,
              textAlign: "center",
            }}
          >
            C↔R
          </span>
          <span
            style={{
              ...mono,
              width: 46,
              fontSize: 10,
              opacity: 0.6,
              textAlign: "center",
            }}
          >
            M↔G
          </span>
          <span
            style={{
              ...mono,
              width: 46,
              fontSize: 10,
              opacity: 0.6,
              textAlign: "center",
            }}
          >
            Y↔B
          </span>
        </NumRow>
        {(["shadows", "midtones", "highlights"] as const).map((range) => (
          <NumRow key={range} label={capitalize(toneRangeLabel(range))}>
            {([0, 1, 2] as const).map((axis) => (
              <Num
                key={axis}
                testAttr={`data-image-balance-${range}-${axis}`}
                step={0.02}
                value={p.colorBalance[range][axis]}
                disabled={disabled}
                onChange={(v) => setBalance(range, axis, v)}
              />
            ))}
          </NumRow>
        ))}

        <div style={{ ...kicker, marginTop: space[2] }}>{t(P.photoFilter)}</div>
        <div style={row}>
          <label htmlFor="pg-image-photofilter">{t(P.gel)}</label>
          <select
            id="pg-image-photofilter"
            data-image-photo-filter
            disabled={disabled}
            value={
              PHOTO_FILTERS.findIndex(
                (f) =>
                  f.rgb[0] === p.photoFilter.color[0] &&
                  f.rgb[1] === p.photoFilter.color[1] &&
                  f.rgb[2] === p.photoFilter.color[2],
              ) < 0
                ? 0
                : PHOTO_FILTERS.findIndex(
                    (f) =>
                      f.rgb[0] === p.photoFilter.color[0] &&
                      f.rgb[1] === p.photoFilter.color[1] &&
                      f.rgb[2] === p.photoFilter.color[2],
                  )
            }
            onChange={(e) =>
              session.setParams({
                photoFilter: {
                  ...p.photoFilter,
                  color: [...PHOTO_FILTERS[Number(e.target.value)].rgb],
                },
              })
            }
          >
            {PHOTO_FILTERS.map((f, i) => (
              <option key={f.name} value={i}>
                {t(f.name)}
              </option>
            ))}
          </select>
        </div>
        <Slider
          label={t(P.density)}
          min={0}
          max={1}
          step={0.05}
          value={p.photoFilter.density}
          disabled={disabled}
          onChange={(v) =>
            session.setParams({ photoFilter: { ...p.photoFilter, density: v } })
          }
        />
        <Gate
          label={t(P.preserveLuminosity)}
          testAttr="data-image-photo-preserve"
          checked={p.photoFilter.preserveLuminosity}
          disabled={disabled}
          onChange={(preserveLuminosity) =>
            session.setParams({
              photoFilter: { ...p.photoFilter, preserveLuminosity },
            })
          }
        />

        <div style={{ ...kicker, marginTop: space[2] }}>
          {t(P.channelMixer)}
        </div>
        <NumRow label="&nbsp;">
          {["R", "G", "B", "+"].map((h) => (
            <span
              key={h}
              style={{
                ...mono,
                width: 46,
                fontSize: 10,
                opacity: 0.6,
                textAlign: "center",
              }}
            >
              {h}
            </span>
          ))}
        </NumRow>
        {(["r", "g", "b"] as const).map((out) => (
          <NumRow
            key={out}
            label={t(P.mixerOut, { channel: out.toUpperCase() })}
          >
            {([0, 1, 2, 3] as const).map((i) => (
              <Num
                key={i}
                testAttr={`data-image-mixer-${out}-${i}`}
                step={0.05}
                value={p.channelMixer[out][i]}
                disabled={disabled}
                onChange={(v) => setMixer(out, i, v)}
              />
            ))}
          </NumRow>
        ))}

        {/* EFFECTS — the range-destroying stages. Each sits behind an
            enable GATE (they look destructive, so they never ride a
            "neutral value" default the user could hit by accident). */}
        <div style={sectionTitle}>{t(P.effects)}</div>
        <Gate
          label={t(P.blackWhite)}
          testAttr="data-image-bw-enable"
          checked={p.blackWhite.enabled}
          disabled={disabled}
          onChange={(enabled) =>
            session.setParams({ blackWhite: { ...p.blackWhite, enabled } })
          }
        />
        {p.blackWhite.enabled && (
          <>
            <NumRow label="R / Y / G">
              {[0, 1, 2].map((i) => (
                <Num
                  key={i}
                  testAttr={`data-image-bw-${i}`}
                  value={p.blackWhite.weights[i]}
                  disabled={disabled}
                  onChange={(v) => setBw(i, v)}
                />
              ))}
            </NumRow>
            <NumRow label="C / B / M">
              {[3, 4, 5].map((i) => (
                <Num
                  key={i}
                  testAttr={`data-image-bw-${i}`}
                  value={p.blackWhite.weights[i]}
                  disabled={disabled}
                  onChange={(v) => setBw(i, v)}
                />
              ))}
            </NumRow>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                session.setParams({
                  blackWhite: {
                    enabled: true,
                    weights: [...DEFAULT_BW_WEIGHTS],
                  },
                })
              }
            >
              {t(P.defaultMix)}
            </button>
          </>
        )}
        <Gate
          label={t(P.posterize)}
          testAttr="data-image-posterize-enable"
          checked={p.posterizeLevels !== null}
          disabled={disabled}
          onChange={(on) =>
            session.setParams({ posterizeLevels: on ? 6 : null })
          }
        />
        {p.posterizeLevels !== null && (
          <Slider
            label={t(P.posterizeLevels)}
            min={2}
            max={32}
            step={1}
            value={p.posterizeLevels}
            disabled={disabled}
            onChange={(v) => session.setParams({ posterizeLevels: v })}
          />
        )}
        <Gate
          label={t(P.threshold)}
          testAttr="data-image-threshold-enable"
          checked={p.threshold !== null}
          disabled={disabled}
          onChange={(on) => session.setParams({ threshold: on ? 0.5 : null })}
        />
        {p.threshold !== null && (
          <Slider
            label={t(P.cut)}
            min={0}
            max={1}
            step={0.01}
            value={p.threshold}
            disabled={disabled}
            onChange={(v) => session.setParams({ threshold: v })}
          />
        )}

        {/* GENERATE — the gen.* family. Unlike everything above this is
            NOT a re-runnable chain stage: it paints ONCE into the working
            image (composited through the selection mask on the GPU) and
            swaps the engine source, like a crop commit. Honest v0: a
            fixed TWO-STOP gradient whose geometry is derived from the
            selection bounds (no on-canvas drag handle yet). */}
        <div style={sectionTitle}>
          {t(s.selection ? P.generateSelection : P.generateImage)}
        </div>
        <div style={row}>
          <label htmlFor="pg-image-gradient">{t(P.gradient)}</label>
          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select
              id="pg-image-gradient"
              data-image-gradient-kind
              value={gradKind}
              disabled={disabled}
              onChange={(e) => setGradKind(e.target.value as GradientKind)}
            >
              {GRADIENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {gradientKindLabel(k)}
                </option>
              ))}
            </select>
            <span
              style={swatch(stopCss(STOPS[stop0].rgba))}
              aria-hidden="true"
            />
            <select
              data-image-gradient-stop0
              value={stop0}
              disabled={disabled}
              onChange={(e) => setStop0(Number(e.target.value))}
              title={t(P.startColour)}
            >
              {STOPS.map((c, i) => (
                <option key={c.name} value={i}>
                  {t(c.name)}
                </option>
              ))}
            </select>
            <span
              style={swatch(stopCss(STOPS[stop1].rgba))}
              aria-hidden="true"
            />
            <select
              data-image-gradient-stop1
              value={stop1}
              disabled={disabled}
              onChange={(e) => setStop1(Number(e.target.value))}
              title={t(P.endColour)}
            >
              {STOPS.map((c, i) => (
                <option key={c.name} value={i}>
                  {t(c.name)}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-image-fill-gradient
              disabled={disabled || !s.gpu}
              title={s.gpu ? t(P.fillGradientTitle) : t(P.generatorsGpuOnly)}
              onClick={() =>
                void session.fillSelection({
                  kind: "gradient",
                  gradient: gradKind,
                  c0: [...STOPS[stop0].rgba],
                  c1: [...STOPS[stop1].rgba],
                })
              }
            >
              {t(P.fill)}
            </button>
          </span>
        </div>
        <div style={row}>
          <label htmlFor="pg-image-noise">{t(P.noise)}</label>
          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              id="pg-image-noise"
              data-image-noise-amount
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={noiseAmount}
              disabled={disabled}
              onChange={(e) => setNoiseAmount(Number(e.target.value))}
            />
            <span style={{ ...mono, minWidth: "3.5em", textAlign: "right" }}>
              {noiseAmount.toFixed(2)}
            </span>
            <button
              type="button"
              data-image-fill-noise
              disabled={disabled || !s.gpu}
              onClick={() =>
                void session.fillSelection({
                  kind: "noise",
                  amount: noiseAmount,
                })
              }
            >
              {t(P.fill)}
            </button>
          </span>
        </div>
        <div style={note}>{t(P.fillNote)}</div>

        <PatternSection
          session={session}
          pattern={s.pattern}
          gpu={s.gpu}
          disabled={disabled}
          scale={patternScale}
          onScale={setPatternScale}
          radius={shapeRadius}
          onRadius={setShapeRadius}
        />
        <MoveSection
          session={session}
          hasSelection={!!s.selection && s.selection.w > 0}
          size={
            s.source ? { width: s.source.width, height: s.source.height } : null
          }
          gpu={s.gpu}
          disabled={disabled}
        />
        <CanvasSection
          session={session}
          size={canvasSize}
          onSize={setCanvasSize}
          disabled={disabled}
        />
        <RankLookupSection
          session={session}
          gpu={s.gpu}
          disabled={disabled}
          lookupName={lookupName}
          onLookupFile={(f) => {
            setLookupName(f.name);
            void f
              .text()
              .then((text) => session.applyColorLookup(text, f.name));
          }}
        />
        <SelectModifySection
          session={session}
          hasSelection={!!s.selection && s.selection.w > 0}
          radius={modifyRadius}
          onRadius={setModifyRadius}
          wand={s.wand}
        />
        <SmartObjectSection
          session={session}
          active={s.layers.active}
          isSmart={s.layers.layers[s.layers.active]?.kind === "smart"}
          gpu={s.gpu}
          disabled={disabled}
          scale={smartScale}
          onScale={setSmartScale}
        />

        <HueSatSection
          session={session}
          hueSat={p.hueSat}
          range={hueSatRange}
          onRange={setHueSatRange}
          disabled={disabled}
        />

        {/* Filters — the T1/T2 kernels' first editor reach (blur, unsharp,
            hue rotation, invert); same GPU chain, same Apply commit. */}
        <div style={sectionTitle}>{t(P.filters)}</div>
        <Slider
          label={t(P.blur)}
          min={0}
          max={8}
          step={0.1}
          value={p.blurSigma}
          disabled={disabled}
          onChange={(v) => setBase("blurSigma", v)}
        />
        <Slider
          label={t(P.sharpen)}
          min={0}
          max={3}
          step={0.05}
          value={p.sharpenAmount}
          disabled={disabled}
          onChange={(v) => setBase("sharpenAmount", v)}
        />
        <Slider
          label={t(P.hueRotate)}
          min={-180}
          max={180}
          step={1}
          value={p.hueDegrees}
          disabled={disabled}
          onChange={(v) => setBase("hueDegrees", v)}
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            font: `12px ${font.sans}`,
          }}
        >
          <input
            type="checkbox"
            data-image-invert
            checked={p.invert}
            disabled={disabled}
            onChange={(e) => session.setParams({ invert: e.target.checked })}
          />
          {t(P.invert)}
        </label>

        {/* EFFECTS over the new kernel classes — Gradient Map
            (adjust.gradient_map) and the parametric distortions
            (geom.warp_backward). Both land exactly like a fill: into the
            active layer when a stack is bound, journaled and
            selection-masked, so they are undoable and confinable without
            any special casing. */}
        <div style={sectionTitle}>{t(P.gradientMapDistort)}</div>
        <div
          style={{
            display: "flex",
            gap: space[2],
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            data-image-gradient-map
            disabled={s.busy || !s.source}
            title={t(P.gradientMapTitle)}
            onClick={() => void session.openFilterDialog("gradientMap")}
          >
            {t(P.gradientMap)}…
          </button>
        </div>
        <div style={note}>{t(P.gradientMapNote)}</div>
        <DistortSection
          session={session}
          params={distort}
          onParams={setDistort}
          disabled={s.busy || !s.gpu || !s.source}
        />

        <div style={sectionTitle}>{t(P.stylize)}</div>
        <div style={row}>
          {FILTERS.filter((f) => !RANK_FILTERS.has(f.id)).map((f) => (
            <button
              key={f.id}
              type="button"
              data-image-filter={f.id}
              {...FILTER_ATTRS[f.id]}
              disabled={s.busy || !s.source}
              title={FILTER_TITLES[f.id] ? t(FILTER_TITLES[f.id]!) : undefined}
              onClick={() => void session.openFilterDialog(f.id)}
            >
              {t(f.label)}…
            </button>
          ))}
          <button
            type="button"
            data-image-average
            disabled={s.busy || !s.gpu || !s.source}
            title={t(P.averageTitle)}
            onClick={() => void session.applyAverage()}
          >
            {t(P.average)}
          </button>
        </div>
        <div style={note}>{t(P.galleryNote)}</div>

        {/* LAYERS — the layer graph itself: order, visibility, opacity,
            blend and the active-layer choice paint/fill/bake land in,
            plus the journal's undo/redo and its stated bound. */}
        <LayersSection
          layers={s.layers.layers}
          active={s.layers.active}
          history={s.history}
          blendModes={s.blendModes}
          layersNote={s.layersNote}
          gpu={s.gpu}
          disabled={disabled}
          onSelect={(i) => session.setActiveLayer(i)}
          onAdd={() => void session.addLayer()}
          onDuplicate={(i) => void session.duplicateLayer(i)}
          onRemove={(i) => void session.removeLayer(i)}
          onMove={(from, to) => void session.reorderLayer(from, to)}
          onVisible={(i, v) => void session.setLayerVisible(i, v)}
          onOpacity={(i, v) => void session.setLayerOpacity(i, v)}
          onBlend={(i, b) => void session.setLayerBlend(i, b)}
          onLock={(i, v) => session.setLayerLocked(i, v)}
          onAddAdjustment={() => void session.addAdjustmentLayer()}
          onMaskFromSelection={(i) => void session.layerMaskFromSelection(i)}
          onMaskToggle={(i, v) => void session.setLayerMaskEnabled(i, v)}
          onClip={(i, v) => void session.setLayerClipped(i, v)}
          groups={s.layers.groups}
          onGroup={() => {
            // The active layer and the one below it — the smallest
            // group that means anything, and the one a designer reaches
            // for first.
            const a = s.layers.active;
            if (a > 0) void session.groupLayers(a - 1, a);
          }}
          onUngroup={(id) => void session.ungroupLayers(id)}
          onGroupVisible={(id, v) => void session.setGroupVisible(id, v)}
          onGroupOpacity={(id, o) => void session.setGroupOpacity(id, o)}
          onGroupPassThrough={(id, pt) =>
            void session.setGroupPassThrough(id, pt)
          }
          onMaskClear={(i) => void session.clearLayerMask(i)}
          editTarget={s.layers.editTarget}
          onAddMask={(i, reveal) => void session.addLayerMask(i, reveal)}
          onEditTarget={(i, target) => session.setEditTarget(i, target)}
          onUndoTo={(n) => void session.undoSteps(n)}
          onRedoTo={(n) => void session.redoSteps(n)}
          onBake={() => void session.bakeAdjustToLayer()}
          onUndo={() => void session.undo()}
          onRedo={() => void session.redo()}
          filter={s.layerFilter}
          onFilter={(patch) => session.setLayerFilter(patch)}
          onColor={(i, c) => session.setLayerColor(i, c)}
        />
        {s.layers.layers.length > 0 ? (
          <>
            <ActiveLayerStrip
              layer={s.layers.layers[s.layers.active] ?? null}
              below={s.layers.layers[s.layers.active - 1] ?? null}
              disabled={disabled}
              onFill={(v) =>
                void session.setLayerFillOpacity(s.layers.active, v)
              }
              onLocks={(patch) => session.setLayerLocks(s.layers.active, patch)}
              onColor={(c) => session.setLayerColor(s.layers.active, c)}
              onLink={() =>
                session.linkLayers([s.layers.active - 1, s.layers.active])
              }
              onUnlink={() => session.unlinkLayer(s.layers.active)}
              onBlendingOptions={() => session.openBlendingOptions()}
              onRasterize={() => void session.rasterizeLayer(s.layers.active)}
            />
            <LayerVerbs
              disabled={disabled}
              gpu={s.gpu}
              inGroup={
                (s.layers.layers[s.layers.active]?.group ?? null) !== null
              }
              hasSelection={s.selection !== null}
              alignTo={alignTo}
              onAlignTo={setAlignTo}
              onNewFill={(k) => void session.addFillLayer(k)}
              onNewAdjustment={(k) => void session.addAdjustmentLayerOf(k)}
              onVerb={(v) => {
                if (v === "mergeDown") void session.mergeDown();
                else if (v === "mergeVisible") void session.mergeVisible();
                else if (v === "stampVisible") void session.stampVisible();
                else if (v === "flatten") void session.flattenImage();
                else if (v === "mergeGroup") void session.mergeGroup();
                else if (v === "viaCopy") void session.layerViaCopy();
                else void session.layerViaCut();
              }}
              onAlign={(edge) => void session.alignLayers(edge, alignTo)}
              onDistribute={(axis) => void session.distributeLayers(axis)}
            />
            <LayerPropertiesSection
              key={s.layers.layers[s.layers.active]?.id ?? -1}
              layer={s.layers.layers[s.layers.active] ?? null}
              params={live.layerParams(s.layers.active)}
              disabled={disabled}
              onAdjust={(values, cube, label) =>
                void session.setTypedAdjustment(
                  s.layers.active,
                  values,
                  cube,
                  label,
                )
              }
              onFill={(kind, values) =>
                void session.setFillLayer(s.layers.active, kind, values)
              }
            />
            <LayerCompsSection
              comps={s.layers.comps}
              disabled={disabled}
              onNew={(name, record) => session.newLayerComp(name, record)}
              onApply={(id) => void session.applyLayerComp(id)}
              onUpdate={(id) => session.updateLayerComp(id)}
              onDelete={(id) => session.deleteLayerComp(id)}
              onRename={(id, name) => session.renameLayerComp(id, name)}
            />
          </>
        ) : null}

        <ColorSection
          session={session}
          colors={s.colors}
          gradientKind={s.gradientKind}
        />

        {/* BRUSH — the paint tools' frozen-at-pointer-down parameters
            (paged.image's RASTER brush/pencil/eraser, distinct from
            paged.draw's vector ones on the same rail). The section states
            the scope in the UI, not only in the code. */}
        <BrushSection
          brush={s.brush}
          blendModes={s.blendModes}
          strokeActive={s.strokeActive}
          strokeStats={s.strokeStats}
          masked={s.selection !== null}
          gpu={s.gpu}
          disabled={disabled}
          onChange={(patch) => session.setBrushParams(patch)}
        />

        {/* TONING — the dodge / burn / sponge options. */}
        <ToneSection
          tone={s.tone}
          disabled={disabled}
          onChange={(patch) => session.setTone(patch)}
        />

        {/* RASTER TYPE — the string, face and size the type tool paints
            on its next click. */}
        <TypeSection
          type={s.type}
          disabled={disabled}
          onChange={(patch) => session.setType(patch)}
        />

        {/* RETOUCH — the clone/heal source and the healing brush's
            honest limit. */}
        <RetouchSection
          source={s.cloneSource}
          hasSelection={s.selection !== null}
          onAligned={(a) => session.setCloneAligned(a)}
          onContentAwareFill={() =>
            void session.fillSelection({ kind: "contentAware" })
          }
        />

        {/* PATHS — the raster↔vector bridge (the vector side itself is
            host-owned and stays there). */}
        <PathsSection
          hasSelection={s.selection !== null}
          threshold={pathThreshold}
          disabled={disabled}
          onThreshold={setPathThreshold}
          onToPath={() => {
            void session.selectionToPath(pathThreshold);
          }}
          onFromPath={() => {
            void session.selectionFromPath();
          }}
        />

        {/* CHANNELS — the per-channel readout, and channel→selection
            (the luminosity mask). */}
        <ChannelsSection
          channels={s.channels}
          disabled={disabled}
          onLoadSelection={(c) => session.selectionFromChannel(c)}
        />

        {/* BRUSH PRESETS — the `.abr` reader, finally reachable. Until
            this section existed the parser was dead-code-eliminated from
            the shipped wasm: a capability in the repository and not in
            the artifact. */}
        <BrushPresetsSection
          library={s.brushLibrary}
          libraryName={s.brushLibraryName}
          activePreset={s.brushPreset}
          /* Never gated on an ingest: presets are parameters, and the
             engine boots on demand when one is loaded. */
          disabled={false}
          onLoad={() => {
            void session.pickBrushLibrary();
          }}
          onApply={(index) => session.applyBrushPreset(index)}
          onClose={() => session.closeBrushLibrary()}
        />

        {/* Image Size, Trim and Arbitrary rotation open their dialogs
            (shown on top of the panel). */}
        <div style={sectionTitle}>{t(P.resize)}</div>
        <div style={row}>
          <button
            type="button"
            data-image-open-image-size
            disabled={disabled}
            onClick={() => session.openDialog("imageSize")}
          >
            {t(P.imageSizeOpen)}
          </button>
          <button
            type="button"
            data-image-open-trim
            disabled={disabled}
            onClick={() => session.openDialog("trim")}
          >
            {t(P.trimOpen)}
          </button>
          <button
            type="button"
            data-image-open-rotate
            disabled={disabled}
            onClick={() => session.openDialog("rotate")}
          >
            {t(P.rotateOpen)}
          </button>
        </div>

        {/* PSD layers — the structural session (mutatable tier): record
            edits accumulate on the retained parse; Export Center's "PSD
            (edited)" re-emits preservation-safe. The canvas composite
            stays the import-time flatten (re-flatten is a follow-up). */}
        {s.psd && (
          <>
            <div style={sectionTitle}>
              {t(P.psdLayers, { count: s.psd.layers.length })}
            </div>
            {s.psd.layers.map((l) => (
              <div
                key={l.index}
                data-image-psd-layer={l.index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  font: `12px ${font.sans}`,
                  padding: "1px 0",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    opacity: l.hidden ? 0.5 : 1,
                  }}
                  title={l.hidden ? t(P.psdHidden, { name: l.name }) : l.name}
                  onDoubleClick={() => {
                    const name = window.prompt(t(P.layerName), l.name);
                    if (name && name !== l.name)
                      session.psdRenameLayer(l.index, name);
                  }}
                >
                  {l.name}
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  data-image-psd-opacity
                  value={Math.round((l.opacity / 255) * 100)}
                  style={{
                    width: 52,
                    font: `11px ${font.mono}`,
                  }}
                  title={t(P.psdOpacity)}
                  onChange={(e) =>
                    session.psdSetLayerOpacity(
                      l.index,
                      (Number(e.target.value) / 100) * 255,
                    )
                  }
                />
                <IconButton
                  label={t(P.psdRemove)}
                  data-image-psd-remove
                  title={t(P.psdRemoveTitle)}
                  style={{
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    color: "var(--pg-fg)",
                  }}
                  onClick={() => session.psdRemoveLayer(l.index)}
                >
                  ✕
                </IconButton>
              </div>
            ))}
            <p
              data-image-psd-note
              style={{
                margin: "2px 0 0",
                font: `10px/1.5 ${font.sans}`,
                color: "var(--pg-muted-fg)",
              }}
            >
              {psdLayersNote(p, s.psd.layers.length)}
            </p>
          </>
        )}

        {/* Curves */}
        <div style={sectionTitle}>{t(P.curves)}</div>
        <div
          style={{
            display: "flex",
            gap: space[2],
            alignItems: "flex-start",
          }}
        >
          <select
            aria-label={t(P.curveChannel)}
            data-image-curve-channel
            value={curveChannel}
            disabled={disabled}
            onChange={(e) => setCurveChannel(e.target.value as CurveChannel)}
          >
            <option value="rgb">RGB</option>
            <option value="r">{t(P.red)}</option>
            <option value="g">{t(P.green)}</option>
            <option value="b">{t(P.blue)}</option>
          </select>
          <CurveEditor
            points={curvePoints}
            onChange={pushCurve}
            disabled={disabled}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              pushCurve(IDENTITY_CURVE.map((q) => [...q] as [number, number]))
            }
          >
            {t(P.resetCurve)}
          </button>
        </div>

        <CurvesTools
          armed={s.curvesPicker}
          disabled={disabled}
          onAuto={() => void session.autoCurves()}
          onArm={(k) => session.armCurvesPicker(k)}
        />

        {/* Crop + straighten */}
        <div style={sectionTitle}>{t(P.crop)}</div>
        <div style={row}>
          <label htmlFor="pg-image-aspect">{t(P.aspect)}</label>
          <select
            id="pg-image-aspect"
            value={aspect}
            disabled={disabled || !machine}
            onChange={(e) => {
              const a = e.target.value as AspectPreset;
              setAspect(a);
              machine?.setPreset(a);
            }}
          >
            {ASPECTS.map((a) => (
              <option key={a} value={a}>
                {a === "free"
                  ? t(P.aspectFree)
                  : a === "original"
                    ? t(P.aspectOriginal)
                    : a}
              </option>
            ))}
          </select>
        </div>
        <Slider
          label={t(P.straighten)}
          min={-45}
          max={45}
          step={0.5}
          value={angle}
          disabled={disabled || !machine}
          onChange={(v) => {
            setAngle(v);
            machine?.setAngle(v);
          }}
        />
        <div
          style={{
            display: "flex",
            gap: space[2],
            marginTop: space[1],
          }}
        >
          <button
            type="button"
            disabled={disabled || !machine}
            onClick={() => void session.commitCrop()}
          >
            {t(P.applyCrop)}
          </button>
          <button
            type="button"
            disabled={disabled || !machine}
            onClick={() => {
              if (s.source) machine?.reset(s.source.width, s.source.height);
              setAspect("free");
              setAngle(0);
            }}
          >
            {t(P.resetCrop)}
          </button>
        </div>

        {/* SAVE-BACK — bake the adjustments into the SOURCE FILE bytes.
            "Apply" computes + STAGES them; "Save…" hands them to the
            host's K-10 saver. That door was added to the contract FOR
            this consumer and this bundle had never called it, so the
            Export Center was doing work the panel could do itself. The
            exporters remain the fallback for a host with no saver. */}
        <div style={sectionTitle}>{t(P.applyToFile)}</div>
        <div style={{ display: "flex", gap: space[2] }}>
          <button
            type="button"
            data-image-apply-to-file
            disabled={disabled}
            onClick={() => void session.applyToFile()}
          >
            {t(P.applyToFile)}
          </button>
          <button
            type="button"
            data-image-save-to-file
            disabled={disabled}
            onClick={() => void session.saveToFile()}
          >
            {t(P.save)}
          </button>
        </div>
        {s.saveBack ? (
          <>
            <div style={row}>
              <span>{t(P.ready)}</span>
              <span style={mono} data-image-saveback-file>
                {s.saveBack.fileName} · {s.saveBack.bytes.length} B
              </span>
            </div>
            <div style={note} data-image-saveback-note>
              {s.saveBack.note}
            </div>
          </>
        ) : (
          <div style={note}>
            {t(P.saveNote)}
            <About>{t(P.saveAbout)}</About>
          </div>
        )}

        {/* DIAGNOSTICS — the developer readout (bundle, engine, source),
            collapsed at the bottom. The Source row keeps its exact
            span/span shape: journeys read it by text. */}
        <Disclosure
          summary={t(P.diagnostics)}
          style={{ ...note, marginTop: space[3] }}
          data-image-diagnostics
        >
          <div style={row}>
            <span>{t(P.bundle)}</span>
            <span style={mono}>
              {manifest.id}@{manifest.version}
            </span>
          </div>
          <div style={row}>
            <span>{t(P.engine)}</span>
            <span style={{ textAlign: "right" }}>{engineLine}</span>
          </div>
          {s.engineDetail ? <div>{s.engineDetail}</div> : null}
          <div style={row}>
            <span>{t(P.source)}</span>
            <span style={{ ...mono, textAlign: "right" }}>
              {s.source
                ? `${s.source.name} ${s.source.width}×${s.source.height}`
                : t(P.none)}
            </span>
          </div>
          <p>{t(P.diagnosticsNote)}</p>
        </Disclosure>
      </div>
    );
  }
  return ImagePanel;
}
