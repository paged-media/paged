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

// BRUSH SETTINGS — Photoshop's Brush Settings panel over the brush
// engine's settings (`brush-dynamics.ts`): a pane list on the left, with
// a checkbox for every pane that can be switched off, and the selected
// pane's controls on the right; plus the options of the paint tools that
// stroke through the same engine (smudge, mixer, history, art history,
// background eraser, colour replacement, magic eraser).
//
// `BrushSettingsView` is PURE — props in, elements out, no hooks — so a
// spec can render any pane and assert the exact patch a control sends.
// `makeBrushSettingsPanel` connects it to the session. Every setting is
// frozen into a stroke when the stroke begins (the engine replays a
// stroke from its settings and samples), so a change applies from the
// next stroke.

import { useState, type ReactNode } from "react";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import { defineMessages, t, useStrings } from "@paged-media/strings";
import { space } from "@paged-media/panel-kit";

import type { BrushParams, LayerHistory } from "../engine";
import { historySourceChoices } from "./sections/history-section";
import {
  ART_HISTORY_STYLES,
  BRUSH_CONTROLS,
  COLOR_REPLACE_MODES,
  COMBINE_MODES,
  LIMITS_MODES,
  SAMPLING_MODES,
  SYMMETRY_KINDS,
  type BrushControl,
  type BrushDynamics,
  type DynamicsPatch,
  type JitterSetting,
  type PaintToolOptions,
} from "../brush-dynamics";
import type { UserBrushPreset } from "../brush-presets";
import { mono, note, panelTitle, row, sectionTitle } from "./sections/styles";

export const BRUSH_SETTINGS_PANEL_ID = "media.paged.image.panel.brushSettings";

/** The session members this panel reads and calls — a structural subset
 *  of `ImageSession`. */
export interface BrushSettingsSession {
  state(): {
    brush: BrushParams;
    dynamics: BrushDynamics;
    paintTools: PaintToolOptions;
    pattern: { width: number; height: number } | null;
    gpu: boolean;
    strokeActive: boolean;
    brushPresets?: readonly UserBrushPreset[];
    /** The image's history (the History brush's sources). */
    history?: LayerHistory | null;
  };
  setBrushParams(p: Partial<BrushParams>): void;
  setBrushDynamics(patch: DynamicsPatch): void;
  setPaintToolOptions<K extends keyof PaintToolOptions>(
    tool: K,
    patch: Partial<PaintToolOptions[K]>,
  ): void;
  onDidChange(listener: () => void): { dispose(): void };
}

export type BrushPane =
  | "tip"
  | "shape"
  | "scatter"
  | "texture"
  | "dual"
  | "color"
  | "transfer"
  | "pose"
  | "noise"
  | "wetEdges"
  | "buildUp"
  | "smoothing"
  | "protectTexture"
  | "symmetry"
  | "lockAlpha"
  | "tools";

export const BRUSH_PANES: readonly BrushPane[] = [
  "tip",
  "shape",
  "scatter",
  "texture",
  "dual",
  "color",
  "transfer",
  "pose",
  "noise",
  "wetEdges",
  "buildUp",
  "smoothing",
  "protectTexture",
  "symmetry",
  "lockAlpha",
  "tools",
];

const M = defineMessages("image.brushSettings", {
  title: "Brush Settings",
  frozen: "Settings are fixed for a stroke when it starts.",
  needsGpu: "Painting needs WebGPU, so the paint tools are disabled here.",
  // pane names
  tip: "Brush Tip Shape",
  shape: "Shape Dynamics",
  scatter: "Scattering",
  texture: "Texture",
  dual: "Dual Brush",
  color: "Color Dynamics",
  transfer: "Transfer",
  pose: "Brush Pose",
  noise: "Noise",
  wetEdges: "Wet Edges",
  buildUp: "Build-up",
  smoothing: "Smoothing",
  protectTexture: "Protect Texture",
  symmetry: "Symmetry",
  lockAlpha: "Lock Transparent Pixels",
  tools: "Tool options",
  enablePane: "Use {pane}",
  // tip
  size: "Size (px)",
  angle: "Angle (°)",
  roundness: "Roundness",
  hardness: "Hardness",
  spacing: "Spacing (× diameter)",
  spacingEnabled: "Spacing",
  flipX: "Flip X",
  flipY: "Flip Y",
  sampledTip: "Sampled tip, {w}×{h} px",
  roundTip: "Round tip",
  preview: "Tip preview",
  // jitter
  jitter: "{name} jitter",
  control: "Control",
  fadeSteps: "Fade steps",
  minimum: "Minimum",
  controlOff: "Off",
  controlFade: "Fade",
  controlPressure: "Pen pressure",
  controlTilt: "Pen tilt",
  controlWheel: "Stylus wheel",
  controlInitialDirection: "Initial direction",
  controlDirection: "Direction",
  controlInitialRotation: "Initial rotation",
  controlRotation: "Rotation",
  // shape
  sizeName: "Size",
  angleName: "Angle",
  roundnessName: "Roundness",
  minDiameter: "Minimum diameter",
  tiltScale: "Tilt scale",
  minRoundness: "Minimum roundness",
  flipXJitter: "Flip X jitter",
  flipYJitter: "Flip Y jitter",
  projection: "Brush projection",
  // scatter
  scatterName: "Scatter",
  bothAxes: "Both axes",
  count: "Count",
  countName: "Count",
  // texture
  pattern: "Pattern: the defined pattern, {w}×{h} px",
  noPattern: "Define a pattern first (Fill ▸ Define pattern).",
  invert: "Invert",
  scale: "Scale",
  brightness: "Brightness",
  contrast: "Contrast",
  eachTip: "Texture each tip",
  mode: "Mode",
  depth: "Depth",
  minDepth: "Minimum depth",
  depthName: "Depth",
  modeMultiply: "Multiply",
  modeSubtract: "Subtract",
  modeDarken: "Darken",
  modeOverlay: "Overlay",
  modeColorDodge: "Color dodge",
  modeColorBurn: "Color burn",
  modeLinearBurn: "Linear burn",
  modeHardMix: "Hard mix",
  modeLinearHeight: "Linear height",
  modeHeight: "Height",
  // dual
  diameter: "Diameter (px)",
  flip: "Flip",
  dualBitmap: "Dual tip: sampled, {w}×{h} px",
  dualRound: "Dual tip: round",
  // color
  perTip: "Apply per tip",
  fgBgName: "Foreground/background",
  hueJitter: "Hue jitter",
  saturationJitter: "Saturation jitter",
  brightnessJitter: "Brightness jitter",
  purity: "Purity",
  // transfer
  opacityName: "Opacity",
  flowName: "Flow",
  // pose
  tiltX: "Tilt X (°)",
  tiltY: "Tilt Y (°)",
  rotation: "Rotation (°)",
  pressure: "Pressure",
  override: "Override",
  overrideTilt: "Override tilt",
  overrideRotation: "Override rotation",
  overridePressure: "Override pressure",
  // single-flag panes
  noiseNote: "Adds grain to the soft edge of every dab.",
  wetEdgesNote:
    "Paint builds up along the edges of the stroke, like watercolour.",
  buildUpNote: "Airbrush: a held pointer keeps depositing paint.",
  protectTextureNote:
    "Keeps this texture when you switch between textured presets.",
  lockAlphaNote:
    "Every paint tool keeps the layer's transparency: paint lands only where the layer already has pixels.",
  // smoothing
  amount: "Amount",
  catchUp: "Catch up while paused",
  catchUpEnd: "Catch up at the stroke's end",
  zoomCompensation: "Adjust for zoom",
  smoothingNote:
    "Pulled-string smoothing: the stroke follows the pointer at the string's length.",
  // symmetry
  symmetryKind: "Symmetry",
  centreX: "Centre X",
  centreY: "Centre Y",
  axisAngle: "Axis angle (°)",
  segments: "Segments",
  symOff: "Off",
  symVertical: "Vertical",
  symHorizontal: "Horizontal",
  symDual: "Dual axis",
  symDiagonal: "Diagonal",
  symWavy: "Wavy",
  symCircle: "Circle",
  symSpiral: "Spiral",
  symRadial: "Radial",
  symMandala: "Mandala",
  // tools
  smudge: "Smudge",
  strength: "Strength",
  fingerPainting: "Finger painting",
  sampleAll: "Sample all layers",
  mixer: "Mixer brush",
  wet: "Wet",
  load: "Load",
  mix: "Mix",
  flow: "Flow",
  loadAfter: "Load the brush after each stroke",
  cleanAfter: "Clean the brush after each stroke",
  history: "History brush",
  source: "Source",
  historyNote:
    "Any step in the history and any snapshot can be the source; the Image panel lists them under Snapshots.",
  artHistory: "Art history brush",
  style: "Style",
  area: "Area (px)",
  tolerance: "Tolerance",
  fidelity: "Fidelity",
  styleTightShort: "Tight short",
  styleTightMedium: "Tight medium",
  styleTightLong: "Tight long",
  styleLooseMedium: "Loose medium",
  styleLooseLong: "Loose long",
  styleDab: "Dab",
  styleTightCurl: "Tight curl",
  styleTightCurlLong: "Tight curl long",
  styleLooseCurl: "Loose curl",
  styleLooseCurlLong: "Loose curl long",
  backgroundEraser: "Background eraser",
  sampling: "Sampling",
  limits: "Limits",
  protectForeground: "Protect foreground colour",
  samplingContinuous: "Continuous",
  samplingOnce: "Once",
  samplingSwatch: "Background swatch",
  limitsDiscontiguous: "Discontiguous",
  limitsContiguous: "Contiguous",
  limitsFindEdges: "Find edges",
  colorReplace: "Colour replacement",
  replaceHue: "Hue",
  replaceSaturation: "Saturation",
  replaceColor: "Color",
  replaceLuminosity: "Luminosity",
  magicEraser: "Magic eraser",
  antialias: "Anti-alias",
  contiguous: "Contiguous",
  opacity: "Opacity",
});

const CONTROL_LABEL: Record<BrushControl, string> = {
  off: M.controlOff,
  fade: M.controlFade,
  pressure: M.controlPressure,
  tilt: M.controlTilt,
  wheel: M.controlWheel,
  initialDirection: M.controlInitialDirection,
  direction: M.controlDirection,
  initialRotation: M.controlInitialRotation,
  rotation: M.controlRotation,
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const modeLabel = (m: string) =>
  t((M as Record<string, string>)[`mode${cap(m)}`]);
const symLabel = (k: string) =>
  t((M as Record<string, string>)[`sym${cap(k)}`]);
const styleLabel = (k: string) =>
  t((M as Record<string, string>)[`style${cap(k)}`]);
const samplingLabel = (k: string) =>
  t((M as Record<string, string>)[`sampling${cap(k)}`]);
const limitsLabel = (k: string) =>
  t((M as Record<string, string>)[`limits${cap(k)}`]);
const replaceLabel = (k: string) =>
  t((M as Record<string, string>)[`replace${cap(k)}`]);

// ── the controls (pure) ──────────────────────────────────────────────

/** A labelled range. `field` names the setting (`tip.angle`) and is the
 *  control's test hook. `percent` shows the value ×100. */
function Range({
  field,
  label,
  min,
  max,
  step,
  value,
  disabled,
  percent,
  onChange,
}: {
  field: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled: boolean;
  percent?: boolean;
  onChange: (v: number) => void;
}) {
  const id = `pg-brush-${field}`;
  return (
    <div style={row}>
      <label htmlFor={id}>{label}</label>
      <span style={{ display: "flex", gap: space[1], alignItems: "center" }}>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          data-brush-field={field}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span style={{ ...mono, minWidth: "3.5em", textAlign: "right" }}>
          {percent
            ? `${Math.round(value * 100)}%`
            : String(Math.round(value * 100) / 100)}
        </span>
      </span>
    </div>
  );
}

function Check({
  field,
  label,
  value,
  disabled,
  onChange,
}: {
  field: string;
  label: string;
  value: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={row}>
      <label>
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          data-brush-field={field}
          onChange={(e) => onChange(e.target.checked)}
        />{" "}
        {label}
      </label>
    </div>
  );
}

function Choice<T extends string>({
  field,
  label,
  value,
  options,
  labelOf,
  disabled,
  onChange,
}: {
  field: string;
  label: string;
  value: T;
  options: readonly T[];
  labelOf: (v: T) => string;
  disabled: boolean;
  onChange: (v: T) => void;
}) {
  const id = `pg-brush-${field}`;
  return (
    <div style={row}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        data-brush-field={field}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labelOf(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** One dynamic: its jitter, its control (and fade length under Fade),
 *  and — where the pane has one — the control's floor. */
function Jitter({
  field,
  name,
  value,
  max = 1,
  showMinimum,
  disabled,
  onChange,
}: {
  field: string;
  name: string;
  value: JitterSetting;
  max?: number;
  showMinimum?: boolean;
  disabled: boolean;
  onChange: (v: JitterSetting) => void;
}) {
  return (
    <>
      <Range
        field={`${field}.jitter`}
        label={t(M.jitter, { name })}
        min={0}
        max={max}
        step={0.01}
        value={value.jitter}
        percent
        disabled={disabled}
        onChange={(jitter) => onChange({ ...value, jitter })}
      />
      <Choice
        field={`${field}.control`}
        label={t(M.control)}
        value={value.control}
        options={BRUSH_CONTROLS}
        labelOf={(c) => t(CONTROL_LABEL[c])}
        disabled={disabled}
        onChange={(control) => onChange({ ...value, control })}
      />
      {value.control === "fade" ? (
        <Range
          field={`${field}.fadeSteps`}
          label={t(M.fadeSteps)}
          min={1}
          max={9999}
          step={1}
          value={value.fadeSteps}
          disabled={disabled}
          onChange={(fadeSteps) => onChange({ ...value, fadeSteps })}
        />
      ) : null}
      {showMinimum ? (
        <Range
          field={`${field}.minimum`}
          label={t(M.minimum)}
          min={0}
          max={1}
          step={0.01}
          value={value.minimum}
          percent
          disabled={disabled}
          onChange={(minimum) => onChange({ ...value, minimum })}
        />
      ) : null}
    </>
  );
}

/** The tip's outline at its angle and roundness — the pane's preview. */
function TipPreview({ d }: { d: BrushDynamics }) {
  const r = 20;
  return (
    <svg
      width={56}
      height={56}
      viewBox="-28 -28 56 56"
      role="img"
      aria-label={t(M.preview)}
      data-brush-preview
      data-angle={d.tip.angle}
      data-roundness={d.tip.roundness}
    >
      {/* SVG's y points down like the image's, so a counter-clockwise
          angle on screen is a negative SVG rotation. */}
      <g
        transform={`rotate(${-d.tip.angle}) scale(${d.tip.flipX ? -1 : 1} ${
          d.tip.flipY ? -1 : 1
        })`}
      >
        <ellipse
          rx={r}
          ry={Math.max(0.5, r * d.tip.roundness)}
          fill="currentColor"
          opacity={0.35}
        />
        <line x1={0} y1={0} x2={r} y2={0} stroke="currentColor" />
      </g>
    </svg>
  );
}

// ── the panes (pure) ─────────────────────────────────────────────────

export interface BrushSettingsViewProps {
  pane: BrushPane;
  brush: BrushParams;
  dynamics: BrushDynamics;
  tools: PaintToolOptions;
  /** The image's history, for the History brush's step and snapshot
   *  sources (image ADR 477); absent = the two fixed states. */
  history?: LayerHistory | null;
  pattern: { width: number; height: number } | null;
  gpu: boolean;
  disabled: boolean;
  onPane: (pane: BrushPane) => void;
  onBrush: (patch: Partial<BrushParams>) => void;
  onDynamics: (patch: DynamicsPatch) => void;
  onTool: <K extends keyof PaintToolOptions>(
    tool: K,
    patch: Partial<PaintToolOptions[K]>,
  ) => void;
}

/** Whether a pane is switched on, and the patch that switches it; null
 *  for the panes that are always there. */
function paneSwitch(
  pane: BrushPane,
  d: BrushDynamics,
): { on: boolean; patch: (on: boolean) => DynamicsPatch } | null {
  switch (pane) {
    case "shape":
    case "scatter":
    case "texture":
    case "dual":
    case "color":
    case "transfer":
    case "pose":
      return {
        on: d[pane].enabled,
        patch: (enabled) => ({ [pane]: { enabled } }) as DynamicsPatch,
      };
    case "noise":
    case "wetEdges":
    case "buildUp":
    case "protectTexture":
    case "lockAlpha":
      return {
        on: d[pane],
        patch: (on) => ({ [pane]: on }) as DynamicsPatch,
      };
    case "smoothing":
      return {
        on: d.smoothing.amount > 0,
        patch: (on) => ({ smoothing: { amount: on ? 0.1 : 0 } }),
      };
    default:
      return null;
  }
}

function TipPane(p: BrushSettingsViewProps) {
  const { brush, dynamics: d, disabled, onBrush, onDynamics } = p;
  return (
    <>
      <div style={row}>
        <TipPreview d={d} />
        <span style={note} data-brush-tip-kind>
          {d.bitmap
            ? t(M.sampledTip, { w: d.bitmap.width, h: d.bitmap.height })
            : t(M.roundTip)}
        </span>
      </div>
      <Range
        field="size"
        label={t(M.size)}
        min={1}
        max={2000}
        step={1}
        value={brush.size}
        disabled={disabled}
        onChange={(size) => onBrush({ size })}
      />
      <Range
        field="tip.angle"
        label={t(M.angle)}
        min={-180}
        max={180}
        step={1}
        value={d.tip.angle}
        disabled={disabled}
        onChange={(angle) => onDynamics({ tip: { angle } })}
      />
      <Range
        field="tip.roundness"
        label={t(M.roundness)}
        min={0.01}
        max={1}
        step={0.01}
        value={d.tip.roundness}
        percent
        disabled={disabled}
        onChange={(roundness) => onDynamics({ tip: { roundness } })}
      />
      <Range
        field="hardness"
        label={t(M.hardness)}
        min={0}
        max={1}
        step={0.01}
        value={brush.hardness}
        percent
        disabled={disabled || d.bitmap !== null}
        onChange={(hardness) => onBrush({ hardness })}
      />
      <Check
        field="tip.spacingEnabled"
        label={t(M.spacingEnabled)}
        value={d.tip.spacingEnabled}
        disabled={disabled}
        onChange={(spacingEnabled) => onDynamics({ tip: { spacingEnabled } })}
      />
      <Range
        field="spacing"
        label={t(M.spacing)}
        min={0.01}
        max={10}
        step={0.01}
        value={brush.spacing}
        percent
        disabled={disabled || !d.tip.spacingEnabled}
        onChange={(spacing) => onBrush({ spacing })}
      />
      <Check
        field="tip.flipX"
        label={t(M.flipX)}
        value={d.tip.flipX}
        disabled={disabled}
        onChange={(flipX) => onDynamics({ tip: { flipX } })}
      />
      <Check
        field="tip.flipY"
        label={t(M.flipY)}
        value={d.tip.flipY}
        disabled={disabled}
        onChange={(flipY) => onDynamics({ tip: { flipY } })}
      />
    </>
  );
}

function ShapePane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const s = d.shape;
  const off = disabled || !s.enabled;
  return (
    <>
      <Jitter
        field="shape.size"
        name={t(M.sizeName)}
        value={s.size}
        disabled={off}
        onChange={(size) => onDynamics({ shape: { size } })}
      />
      <Range
        field="shape.minDiameter"
        label={t(M.minDiameter)}
        min={0}
        max={1}
        step={0.01}
        value={s.minDiameter}
        percent
        disabled={off}
        onChange={(minDiameter) => onDynamics({ shape: { minDiameter } })}
      />
      <Range
        field="shape.tiltScale"
        label={t(M.tiltScale)}
        min={0}
        max={2}
        step={0.01}
        value={s.tiltScale}
        percent
        disabled={off || s.size.control !== "tilt"}
        onChange={(tiltScale) => onDynamics({ shape: { tiltScale } })}
      />
      <Jitter
        field="shape.angle"
        name={t(M.angleName)}
        value={s.angle}
        disabled={off}
        onChange={(angle) => onDynamics({ shape: { angle } })}
      />
      <Jitter
        field="shape.roundness"
        name={t(M.roundnessName)}
        value={s.roundness}
        disabled={off}
        onChange={(roundness) => onDynamics({ shape: { roundness } })}
      />
      <Range
        field="shape.minRoundness"
        label={t(M.minRoundness)}
        min={0.01}
        max={1}
        step={0.01}
        value={s.minRoundness}
        percent
        disabled={off}
        onChange={(minRoundness) => onDynamics({ shape: { minRoundness } })}
      />
      <Check
        field="shape.flipXJitter"
        label={t(M.flipXJitter)}
        value={s.flipXJitter}
        disabled={off}
        onChange={(flipXJitter) => onDynamics({ shape: { flipXJitter } })}
      />
      <Check
        field="shape.flipYJitter"
        label={t(M.flipYJitter)}
        value={s.flipYJitter}
        disabled={off}
        onChange={(flipYJitter) => onDynamics({ shape: { flipYJitter } })}
      />
      <Check
        field="shape.projection"
        label={t(M.projection)}
        value={s.projection}
        disabled={off}
        onChange={(projection) => onDynamics({ shape: { projection } })}
      />
    </>
  );
}

function ScatterPane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const s = d.scatter;
  const off = disabled || !s.enabled;
  return (
    <>
      <Jitter
        field="scatter.amount"
        name={t(M.scatterName)}
        value={s.amount}
        max={10}
        disabled={off}
        onChange={(amount) => onDynamics({ scatter: { amount } })}
      />
      <Check
        field="scatter.bothAxes"
        label={t(M.bothAxes)}
        value={s.bothAxes}
        disabled={off}
        onChange={(bothAxes) => onDynamics({ scatter: { bothAxes } })}
      />
      <Range
        field="scatter.count"
        label={t(M.count)}
        min={1}
        max={16}
        step={1}
        value={s.count}
        disabled={off}
        onChange={(count) => onDynamics({ scatter: { count } })}
      />
      <Jitter
        field="scatter.countJitter"
        name={t(M.countName)}
        value={s.countJitter}
        disabled={off}
        onChange={(countJitter) => onDynamics({ scatter: { countJitter } })}
      />
    </>
  );
}

function TexturePane({
  dynamics: d,
  pattern,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const x = d.texture;
  const off = disabled || !x.enabled;
  return (
    <>
      <div
        style={note}
        data-brush-texture-pattern={pattern ? "defined" : "none"}
      >
        {pattern
          ? t(M.pattern, { w: pattern.width, h: pattern.height })
          : t(M.noPattern)}
      </div>
      <Check
        field="texture.invert"
        label={t(M.invert)}
        value={x.invert}
        disabled={off}
        onChange={(invert) => onDynamics({ texture: { invert } })}
      />
      <Range
        field="texture.scale"
        label={t(M.scale)}
        min={0.01}
        max={10}
        step={0.01}
        value={x.scale}
        percent
        disabled={off}
        onChange={(scale) => onDynamics({ texture: { scale } })}
      />
      <Range
        field="texture.brightness"
        label={t(M.brightness)}
        min={-150}
        max={150}
        step={1}
        value={x.brightness}
        disabled={off}
        onChange={(brightness) => onDynamics({ texture: { brightness } })}
      />
      <Range
        field="texture.contrast"
        label={t(M.contrast)}
        min={-50}
        max={100}
        step={1}
        value={x.contrast}
        disabled={off}
        onChange={(contrast) => onDynamics({ texture: { contrast } })}
      />
      <Check
        field="texture.eachTip"
        label={t(M.eachTip)}
        value={x.eachTip}
        disabled={off}
        onChange={(eachTip) => onDynamics({ texture: { eachTip } })}
      />
      <Choice
        field="texture.mode"
        label={t(M.mode)}
        value={x.mode}
        options={COMBINE_MODES}
        labelOf={modeLabel}
        disabled={off}
        onChange={(mode) => onDynamics({ texture: { mode } })}
      />
      <Range
        field="texture.depth"
        label={t(M.depth)}
        min={0}
        max={1}
        step={0.01}
        value={x.depth}
        percent
        disabled={off}
        onChange={(depth) => onDynamics({ texture: { depth } })}
      />
      <Range
        field="texture.minDepth"
        label={t(M.minDepth)}
        min={0}
        max={1}
        step={0.01}
        value={x.minDepth}
        percent
        disabled={off || !x.eachTip}
        onChange={(minDepth) => onDynamics({ texture: { minDepth } })}
      />
      <Jitter
        field="texture.depthJitter"
        name={t(M.depthName)}
        value={x.depthJitter}
        disabled={off || !x.eachTip}
        onChange={(depthJitter) => onDynamics({ texture: { depthJitter } })}
      />
    </>
  );
}

function DualPane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const x = d.dual;
  const off = disabled || !x.enabled;
  return (
    <>
      <div style={note} data-brush-dual-tip>
        {x.bitmap
          ? t(M.dualBitmap, { w: x.bitmap.width, h: x.bitmap.height })
          : t(M.dualRound)}
      </div>
      <Choice
        field="dual.mode"
        label={t(M.mode)}
        value={x.mode}
        options={COMBINE_MODES}
        labelOf={modeLabel}
        disabled={off}
        onChange={(mode) => onDynamics({ dual: { mode } })}
      />
      <Check
        field="dual.flip"
        label={t(M.flip)}
        value={x.flip}
        disabled={off}
        onChange={(flip) => onDynamics({ dual: { flip } })}
      />
      <Range
        field="dual.diameter"
        label={t(M.diameter)}
        min={1}
        max={2000}
        step={1}
        value={x.diameter}
        disabled={off}
        onChange={(diameter) => onDynamics({ dual: { diameter } })}
      />
      <Range
        field="dual.spacing"
        label={t(M.spacing)}
        min={0.01}
        max={10}
        step={0.01}
        value={x.spacing}
        percent
        disabled={off}
        onChange={(spacing) => onDynamics({ dual: { spacing } })}
      />
      <Range
        field="dual.scatter"
        label={t(M.scatterName)}
        min={0}
        max={10}
        step={0.01}
        value={x.scatter}
        percent
        disabled={off}
        onChange={(scatter) => onDynamics({ dual: { scatter } })}
      />
      <Check
        field="dual.bothAxes"
        label={t(M.bothAxes)}
        value={x.bothAxes}
        disabled={off}
        onChange={(bothAxes) => onDynamics({ dual: { bothAxes } })}
      />
      <Range
        field="dual.count"
        label={t(M.count)}
        min={1}
        max={16}
        step={1}
        value={x.count}
        disabled={off}
        onChange={(count) => onDynamics({ dual: { count } })}
      />
      <Range
        field="dual.roundness"
        label={t(M.roundness)}
        min={0.01}
        max={1}
        step={0.01}
        value={x.roundness}
        percent
        disabled={off}
        onChange={(roundness) => onDynamics({ dual: { roundness } })}
      />
    </>
  );
}

function ColorPane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const c = d.color;
  const off = disabled || !c.enabled;
  return (
    <>
      <Check
        field="color.perTip"
        label={t(M.perTip)}
        value={c.perTip}
        disabled={off}
        onChange={(perTip) => onDynamics({ color: { perTip } })}
      />
      <Jitter
        field="color.fgBg"
        name={t(M.fgBgName)}
        value={c.fgBg}
        disabled={off}
        onChange={(fgBg) => onDynamics({ color: { fgBg } })}
      />
      <Range
        field="color.hue"
        label={t(M.hueJitter)}
        min={0}
        max={1}
        step={0.01}
        value={c.hue}
        percent
        disabled={off}
        onChange={(hue) => onDynamics({ color: { hue } })}
      />
      <Range
        field="color.saturation"
        label={t(M.saturationJitter)}
        min={0}
        max={1}
        step={0.01}
        value={c.saturation}
        percent
        disabled={off}
        onChange={(saturation) => onDynamics({ color: { saturation } })}
      />
      <Range
        field="color.brightness"
        label={t(M.brightnessJitter)}
        min={0}
        max={1}
        step={0.01}
        value={c.brightness}
        percent
        disabled={off}
        onChange={(brightness) => onDynamics({ color: { brightness } })}
      />
      <Range
        field="color.purity"
        label={t(M.purity)}
        min={-1}
        max={1}
        step={0.01}
        value={c.purity}
        percent
        disabled={off}
        onChange={(purity) => onDynamics({ color: { purity } })}
      />
    </>
  );
}

function TransferPane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const x = d.transfer;
  const off = disabled || !x.enabled;
  return (
    <>
      <Jitter
        field="transfer.opacity"
        name={t(M.opacityName)}
        value={x.opacity}
        showMinimum
        disabled={off}
        onChange={(opacity) => onDynamics({ transfer: { opacity } })}
      />
      <Jitter
        field="transfer.flow"
        name={t(M.flowName)}
        value={x.flow}
        showMinimum
        disabled={off}
        onChange={(flow) => onDynamics({ transfer: { flow } })}
      />
    </>
  );
}

function PosePane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const x = d.pose;
  const off = disabled || !x.enabled;
  return (
    <>
      <Check
        field="pose.overrideTilt"
        label={t(M.overrideTilt)}
        value={x.overrideTilt}
        disabled={off}
        onChange={(overrideTilt) => onDynamics({ pose: { overrideTilt } })}
      />
      <Range
        field="pose.tiltX"
        label={t(M.tiltX)}
        min={-90}
        max={90}
        step={1}
        value={x.tiltX}
        disabled={off || !x.overrideTilt}
        onChange={(tiltX) => onDynamics({ pose: { tiltX } })}
      />
      <Range
        field="pose.tiltY"
        label={t(M.tiltY)}
        min={-90}
        max={90}
        step={1}
        value={x.tiltY}
        disabled={off || !x.overrideTilt}
        onChange={(tiltY) => onDynamics({ pose: { tiltY } })}
      />
      <Check
        field="pose.overrideRotation"
        label={t(M.overrideRotation)}
        value={x.overrideRotation}
        disabled={off}
        onChange={(overrideRotation) =>
          onDynamics({ pose: { overrideRotation } })
        }
      />
      <Range
        field="pose.rotation"
        label={t(M.rotation)}
        min={0}
        max={360}
        step={1}
        value={x.rotation}
        disabled={off || !x.overrideRotation}
        onChange={(rotation) => onDynamics({ pose: { rotation } })}
      />
      <Check
        field="pose.overridePressure"
        label={t(M.overridePressure)}
        value={x.overridePressure}
        disabled={off}
        onChange={(overridePressure) =>
          onDynamics({ pose: { overridePressure } })
        }
      />
      <Range
        field="pose.pressure"
        label={t(M.pressure)}
        min={0}
        max={1}
        step={0.01}
        value={x.pressure}
        percent
        disabled={off || !x.overridePressure}
        onChange={(pressure) => onDynamics({ pose: { pressure } })}
      />
    </>
  );
}

function SmoothingPane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const s = d.smoothing;
  return (
    <>
      <Range
        field="smoothing.amount"
        label={t(M.amount)}
        min={0}
        max={1}
        step={0.01}
        value={s.amount}
        percent
        disabled={disabled}
        onChange={(amount) => onDynamics({ smoothing: { amount } })}
      />
      <Check
        field="smoothing.catchUp"
        label={t(M.catchUp)}
        value={s.catchUp}
        disabled={disabled}
        onChange={(catchUp) => onDynamics({ smoothing: { catchUp } })}
      />
      <Check
        field="smoothing.catchUpEnd"
        label={t(M.catchUpEnd)}
        value={s.catchUpEnd}
        disabled={disabled}
        onChange={(catchUpEnd) => onDynamics({ smoothing: { catchUpEnd } })}
      />
      <Check
        field="smoothing.zoomCompensation"
        label={t(M.zoomCompensation)}
        value={s.zoomCompensation}
        disabled={disabled}
        onChange={(zoomCompensation) =>
          onDynamics({ smoothing: { zoomCompensation } })
        }
      />
      <div style={note}>{t(M.smoothingNote)}</div>
    </>
  );
}

function SymmetryPane({
  dynamics: d,
  disabled,
  onDynamics,
}: BrushSettingsViewProps) {
  const s = d.symmetry;
  const off = disabled || s.kind === "off";
  const segmented =
    s.kind === "radial" || s.kind === "mandala" || s.kind === "spiral";
  return (
    <>
      <Choice
        field="symmetry.kind"
        label={t(M.symmetryKind)}
        value={s.kind}
        options={SYMMETRY_KINDS}
        labelOf={symLabel}
        disabled={disabled}
        onChange={(kind) => onDynamics({ symmetry: { kind } })}
      />
      <Range
        field="symmetry.cx"
        label={t(M.centreX)}
        min={0}
        max={1}
        step={0.01}
        value={s.cx}
        percent
        disabled={off}
        onChange={(cx) => onDynamics({ symmetry: { cx } })}
      />
      <Range
        field="symmetry.cy"
        label={t(M.centreY)}
        min={0}
        max={1}
        step={0.01}
        value={s.cy}
        percent
        disabled={off}
        onChange={(cy) => onDynamics({ symmetry: { cy } })}
      />
      <Range
        field="symmetry.angle"
        label={t(M.axisAngle)}
        min={-180}
        max={180}
        step={1}
        value={s.angle}
        disabled={off}
        onChange={(angle) => onDynamics({ symmetry: { angle } })}
      />
      {segmented ? (
        <Range
          field="symmetry.segments"
          label={t(M.segments)}
          min={2}
          max={12}
          step={1}
          value={s.segments}
          disabled={off}
          onChange={(segments) => onDynamics({ symmetry: { segments } })}
        />
      ) : null}
    </>
  );
}

function ToolsPane({
  tools,
  history,
  disabled,
  onTool,
}: BrushSettingsViewProps) {
  const sources = historySourceChoices(history ?? null);
  const sm = tools.smudge;
  const mx = tools.mixer;
  const ah = tools.artHistory;
  const be = tools.backgroundEraser;
  const cr = tools.colorReplace;
  const me = tools.magicEraser;
  const pct = (
    field: string,
    label: string,
    value: number,
    onChange: (v: number) => void,
  ) => (
    <Range
      field={field}
      label={label}
      min={0}
      max={1}
      step={0.01}
      value={value}
      percent
      disabled={disabled}
      onChange={onChange}
    />
  );
  const check = (
    field: string,
    label: string,
    value: boolean,
    onChange: (v: boolean) => void,
  ) => (
    <Check
      field={field}
      label={label}
      value={value}
      disabled={disabled}
      onChange={onChange}
    />
  );
  return (
    <>
      <div style={sectionTitle}>{t(M.smudge)}</div>
      {pct("smudge.strength", t(M.strength), sm.strength, (strength) =>
        onTool("smudge", { strength }),
      )}
      {check(
        "smudge.fingerPainting",
        t(M.fingerPainting),
        sm.fingerPainting,
        (fingerPainting) => onTool("smudge", { fingerPainting }),
      )}
      {check("smudge.sampleAll", t(M.sampleAll), sm.sampleAll, (sampleAll) =>
        onTool("smudge", { sampleAll }),
      )}

      <div style={sectionTitle}>{t(M.mixer)}</div>
      {pct("mixer.wet", t(M.wet), mx.wet, (wet) => onTool("mixer", { wet }))}
      {pct("mixer.load", t(M.load), mx.load, (load) =>
        onTool("mixer", { load }),
      )}
      {pct("mixer.mix", t(M.mix), mx.mix, (mix) => onTool("mixer", { mix }))}
      {pct("mixer.flow", t(M.flow), mx.flow, (flow) =>
        onTool("mixer", { flow }),
      )}
      {check("mixer.loadAfter", t(M.loadAfter), mx.loadAfter, (loadAfter) =>
        onTool("mixer", { loadAfter }),
      )}
      {check("mixer.cleanAfter", t(M.cleanAfter), mx.cleanAfter, (cleanAfter) =>
        onTool("mixer", { cleanAfter }),
      )}
      {check("mixer.sampleAll", t(M.sampleAll), mx.sampleAll, (sampleAll) =>
        onTool("mixer", { sampleAll }),
      )}

      <div style={sectionTitle}>{t(M.history)}</div>
      <Choice
        field="history.source"
        label={t(M.source)}
        value={
          sources.some((c) => c.value === tools.history.source)
            ? tools.history.source
            : "open"
        }
        options={sources.map((c) => c.value)}
        labelOf={(s) => sources.find((c) => c.value === s)?.label ?? s}
        disabled={disabled}
        onChange={(source) => onTool("history", { source })}
      />
      <div style={note} data-brush-history-note>
        {t(M.historyNote)}
      </div>

      <div style={sectionTitle}>{t(M.artHistory)}</div>
      <Choice
        field="artHistory.style"
        label={t(M.style)}
        value={ah.style}
        options={ART_HISTORY_STYLES}
        labelOf={styleLabel}
        disabled={disabled}
        onChange={(style) => onTool("artHistory", { style })}
      />
      <Range
        field="artHistory.area"
        label={t(M.area)}
        min={0}
        max={500}
        step={1}
        value={ah.area}
        disabled={disabled}
        onChange={(area) => onTool("artHistory", { area })}
      />
      {pct("artHistory.tolerance", t(M.tolerance), ah.tolerance, (tolerance) =>
        onTool("artHistory", { tolerance }),
      )}
      {pct("artHistory.fidelity", t(M.fidelity), ah.fidelity, (fidelity) =>
        onTool("artHistory", { fidelity }),
      )}

      <div style={sectionTitle}>{t(M.backgroundEraser)}</div>
      <Choice
        field="backgroundEraser.sampling"
        label={t(M.sampling)}
        value={be.sampling}
        options={SAMPLING_MODES}
        labelOf={samplingLabel}
        disabled={disabled}
        onChange={(sampling) => onTool("backgroundEraser", { sampling })}
      />
      <Choice
        field="backgroundEraser.limits"
        label={t(M.limits)}
        value={be.limits}
        options={LIMITS_MODES}
        labelOf={limitsLabel}
        disabled={disabled}
        onChange={(limits) => onTool("backgroundEraser", { limits })}
      />
      {pct(
        "backgroundEraser.tolerance",
        t(M.tolerance),
        be.tolerance,
        (tolerance) => onTool("backgroundEraser", { tolerance }),
      )}
      {check(
        "backgroundEraser.protectForeground",
        t(M.protectForeground),
        be.protectForeground,
        (protectForeground) =>
          onTool("backgroundEraser", { protectForeground }),
      )}

      <div style={sectionTitle}>{t(M.colorReplace)}</div>
      <Choice
        field="colorReplace.mode"
        label={t(M.mode)}
        value={cr.mode}
        options={COLOR_REPLACE_MODES}
        labelOf={replaceLabel}
        disabled={disabled}
        onChange={(mode) => onTool("colorReplace", { mode })}
      />
      <Choice
        field="colorReplace.sampling"
        label={t(M.sampling)}
        value={cr.sampling}
        options={SAMPLING_MODES}
        labelOf={samplingLabel}
        disabled={disabled}
        onChange={(sampling) => onTool("colorReplace", { sampling })}
      />
      <Choice
        field="colorReplace.limits"
        label={t(M.limits)}
        value={cr.limits}
        options={LIMITS_MODES}
        labelOf={limitsLabel}
        disabled={disabled}
        onChange={(limits) => onTool("colorReplace", { limits })}
      />
      {pct(
        "colorReplace.tolerance",
        t(M.tolerance),
        cr.tolerance,
        (tolerance) => onTool("colorReplace", { tolerance }),
      )}

      <div style={sectionTitle}>{t(M.magicEraser)}</div>
      <Range
        field="magicEraser.tolerance"
        label={t(M.tolerance)}
        min={0}
        max={255}
        step={1}
        value={me.tolerance}
        disabled={disabled}
        onChange={(tolerance) => onTool("magicEraser", { tolerance })}
      />
      {check(
        "magicEraser.antialias",
        t(M.antialias),
        me.antialias,
        (antialias) => onTool("magicEraser", { antialias }),
      )}
      {check(
        "magicEraser.contiguous",
        t(M.contiguous),
        me.contiguous,
        (contiguous) => onTool("magicEraser", { contiguous }),
      )}
      {check(
        "magicEraser.sampleAll",
        t(M.sampleAll),
        me.sampleAll,
        (sampleAll) => onTool("magicEraser", { sampleAll }),
      )}
      {pct("magicEraser.opacity", t(M.opacity), me.opacity, (opacity) =>
        onTool("magicEraser", { opacity }),
      )}
    </>
  );
}

function FlagPane({ text }: { text: string }) {
  return (
    <div style={note} data-brush-pane-note>
      {text}
    </div>
  );
}

function paneBody(p: BrushSettingsViewProps): ReactNode {
  switch (p.pane) {
    case "tip":
      return <TipPane {...p} />;
    case "shape":
      return <ShapePane {...p} />;
    case "scatter":
      return <ScatterPane {...p} />;
    case "texture":
      return <TexturePane {...p} />;
    case "dual":
      return <DualPane {...p} />;
    case "color":
      return <ColorPane {...p} />;
    case "transfer":
      return <TransferPane {...p} />;
    case "pose":
      return <PosePane {...p} />;
    case "noise":
      return <FlagPane text={t(M.noiseNote)} />;
    case "wetEdges":
      return <FlagPane text={t(M.wetEdgesNote)} />;
    case "buildUp":
      return <FlagPane text={t(M.buildUpNote)} />;
    case "protectTexture":
      return <FlagPane text={t(M.protectTextureNote)} />;
    case "lockAlpha":
      return <FlagPane text={t(M.lockAlphaNote)} />;
    case "smoothing":
      return <SmoothingPane {...p} />;
    case "symmetry":
      return <SymmetryPane {...p} />;
    case "tools":
      return <ToolsPane {...p} />;
  }
}

/** The whole panel, pure. */
export function BrushSettingsView(p: BrushSettingsViewProps) {
  const d = p.dynamics;
  return (
    <div data-brush-settings>
      <h3 style={panelTitle}>{t(M.title)}</h3>
      {!p.gpu ? (
        <div style={note} data-brush-needs-gpu>
          {t(M.needsGpu)}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: space[2], alignItems: "flex-start" }}>
        <ul
          style={{ listStyle: "none", margin: 0, padding: 0, minWidth: "10em" }}
          data-brush-panes
        >
          {BRUSH_PANES.map((pane) => {
            const sw = paneSwitch(pane, d);
            const name = t(M[pane]);
            return (
              <li key={pane} style={{ display: "flex", gap: space[1] }}>
                {sw ? (
                  <input
                    type="checkbox"
                    aria-label={t(M.enablePane, { pane: name })}
                    checked={sw.on}
                    disabled={p.disabled}
                    data-brush-pane-enable={pane}
                    onChange={(e) => p.onDynamics(sw.patch(e.target.checked))}
                  />
                ) : (
                  <span style={{ width: "1.2em" }} />
                )}
                <button
                  type="button"
                  aria-pressed={p.pane === pane}
                  data-brush-pane={pane}
                  style={{ fontWeight: p.pane === pane ? 600 : 400 }}
                  onClick={() => p.onPane(pane)}
                >
                  {name}
                </button>
              </li>
            );
          })}
        </ul>
        <div style={{ flex: 1, minWidth: 0 }} data-brush-pane-body={p.pane}>
          <div style={sectionTitle}>{t(M[p.pane])}</div>
          {paneBody(p)}
        </div>
      </div>
      <div style={note}>{t(M.frozen)}</div>
    </div>
  );
}

/** The connected panel. */
export function makeBrushSettingsPanel(session: BrushSettingsSession) {
  // A declaration, so the React Compiler sees the component.
  function BrushSettingsPanel() {
    const live = useLive(session, onDidChangeOf);
    useStrings();
    const [pane, setPane] = useState<BrushPane>("tip");
    const s = live.state();
    return (
      <BrushSettingsView
        pane={pane}
        brush={s.brush}
        dynamics={s.dynamics}
        tools={s.paintTools}
        history={s.history}
        pattern={s.pattern}
        gpu={s.gpu}
        disabled={false}
        onPane={setPane}
        onBrush={(patch) => session.setBrushParams(patch)}
        onDynamics={(patch) => session.setBrushDynamics(patch)}
        onTool={(tool, patch) => session.setPaintToolOptions(tool, patch)}
      />
    );
  }
  return BrushSettingsPanel;
}
