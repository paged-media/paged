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

// LAYER STYLES (WP5.4) — the Layer Style dialog (every effect's pane, the
// style switches of Blending Options, Global Light), the Global Light and
// Scale Effects dialogs, and the STYLES section (presets: apply, save,
// delete; copy, paste and clear the active layer's style).
//
// Every component is PURE (props in, elements out): an edit hands the
// next style to the panel, which sets it through the session — one undo
// step per layer for a run of edits in the dialog.

import { useState } from "react";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";
import { hexToRgb, rgbToHex } from "@paged-media/helpers";

import type { LayerInfo } from "../../engine";
import {
  CONTOURS,
  EFFECT_KINDS,
  REPEATABLE,
  STYLE_BLEND_MODES,
  addInstance,
  cloneStyle,
  defaultGradientFill,
  defaultPatternFill,
  emptyStyle,
  firstEffect,
  setEffectEnabled,
  twoStopGradient,
  type BlendModeName,
  type Contour,
  type EffectKind,
  type GlobalLight,
  type Gradient,
  type GradientFill,
  type LayerStyle,
  type PatternFill,
  type PatternRef,
  type Rgb,
  type StyleOptions,
  type StylePreset,
} from "../../layer-style";
import type { LayerStylePane } from "../../session";

import { note, row, sectionTitle } from "./styles";

const M = defineMessages("image.layerStyle", {
  title: "Layer style — {name}",
  styles: "Styles",
  blending: "Blending options",
  bevel: "Bevel and emboss",
  stroke: "Stroke",
  innerShadow: "Inner shadow",
  innerGlow: "Inner glow",
  satin: "Satin",
  colorOverlay: "Colour overlay",
  gradientOverlay: "Gradient overlay",
  patternOverlay: "Pattern overlay",
  outerGlow: "Outer glow",
  dropShadow: "Drop shadow",
  addInstance: "Add another {effect}",
  removeInstance: "Remove this {effect}",
  instance: "{at} of {count}",
  previewEffects: "Show effects",
  blendMode: "Blend mode",
  colour: "Colour",
  opacity: "Opacity",
  angle: "Angle",
  useGlobalLight: "Use global light",
  distance: "Distance",
  spread: "Spread",
  choke: "Choke",
  size: "Size",
  contour: "Contour",
  antiAliased: "Anti-aliased",
  noise: "Noise",
  knocksOut: "Layer knocks out drop shadow",
  technique: "Technique",
  softer: "Softer",
  precise: "Precise",
  source: "Source",
  center: "Centre",
  edge: "Edge",
  range: "Range",
  jitter: "Jitter",
  fillType: "Fill",
  solid: "Colour",
  gradient: "Gradient",
  pattern: "Pattern",
  style: "Style",
  innerBevel: "Inner bevel",
  outerBevel: "Outer bevel",
  emboss: "Emboss",
  pillowEmboss: "Pillow emboss",
  strokeEmboss: "Stroke emboss",
  smooth: "Smooth",
  chiselHard: "Chisel hard",
  chiselSoft: "Chisel soft",
  depth: "Depth",
  direction: "Direction",
  up: "Up",
  down: "Down",
  soften: "Soften",
  altitude: "Altitude",
  glossContour: "Gloss contour",
  highlight: "Highlight",
  shadow: "Shadow",
  contourPane: "Contour",
  texturePane: "Texture",
  invert: "Invert",
  scale: "Scale",
  linkWithLayer: "Link with layer",
  alignWithLayer: "Align with layer",
  reverse: "Reverse",
  offsetX: "Offset X",
  offsetY: "Offset Y",
  startColour: "Start colour",
  endColour: "End colour",
  endOpacity: "End opacity",
  linear: "Linear",
  radial: "Radial",
  angleStyle: "Angle",
  reflected: "Reflected",
  diamond: "Diamond",
  position: "Position",
  outside: "Outside",
  inside: "Inside",
  centerPosition: "Centre",
  useDefinedPattern: "Use the defined pattern",
  noPattern: "No pattern: use Edit ▸ Define pattern first",
  patternName: "Pattern: {name}",
  blendInterior: "Blend interior effects as group",
  blendClipped: "Blend clipped layers as group",
  transparencyShapes: "Transparency shapes layer",
  maskHides: "Layer mask hides effects",
  vectorMaskHides: "Vector mask hides effects",
  moreBlending: "Fill opacity, knockout and Blend If…",
  globalLight: "Global light",
  scaleEffects: "Scale effects",
  apply: "Apply",
  close: "Close",
  cancel: "Cancel",
  clearStyle: "Clear style",
  copyStyle: "Copy style",
  pasteStyle: "Paste style",
  newStyle: "New style",
  styleName: "Style name",
  deleteStyle: "Delete style {name}",
  applyStyle: "Apply style {name}",
  noStyle: "The active layer has no style",
  styleNote:
    "A style draws around the layer's pixels and redraws on every edit; " +
    "a PSD keeps it as Photoshop's own effects.",
  contourLinear: "Linear",
  contourCone: "Cone",
  contourConeInverted: "Cone – inverted",
  contourGaussian: "Gaussian",
  contourHalfRound: "Half round",
  contourRing: "Ring",
  contourCustom: "Custom",
});

const PANE_LABEL: Record<EffectKind, () => string> = {
  bevel: () => t(M.bevel),
  stroke: () => t(M.stroke),
  innerShadow: () => t(M.innerShadow),
  innerGlow: () => t(M.innerGlow),
  satin: () => t(M.satin),
  colorOverlay: () => t(M.colorOverlay),
  gradientOverlay: () => t(M.gradientOverlay),
  patternOverlay: () => t(M.patternOverlay),
  outerGlow: () => t(M.outerGlow),
  dropShadow: () => t(M.dropShadow),
};

export function effectLabel(k: EffectKind): string {
  return PANE_LABEL[k]();
}

const CONTOUR_LABEL: Record<string, () => string> = {
  linear: () => t(M.contourLinear),
  cone: () => t(M.contourCone),
  coneInverted: () => t(M.contourConeInverted),
  gaussian: () => t(M.contourGaussian),
  halfRound: () => t(M.contourHalfRound),
  ring: () => t(M.contourRing),
};

const small = { font: `11px ${font.sans}` } as const;
const numberStyle = { width: 52, font: `11px ${font.mono}` } as const;
const hex = (c: Rgb) => rgbToHex(c);
const rgbOf = (h: string): Rgb => hexToRgb(h) ?? [0, 0, 0];

// ───────────────────────────── controls ─────────────────────────────

function Num({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  field,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  field: string;
  onChange: (v: number) => void;
}) {
  const set = (x: number) =>
    onChange(Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : value);
  return (
    <div style={{ ...row, gap: 4 }} data-image-style-field={field}>
      <label style={{ ...small, flex: 1 }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => set(Number(e.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(2))}
        disabled={disabled}
        aria-label={label}
        data-image-style-number={field}
        onChange={(e) => set(Number(e.target.value))}
        style={numberStyle}
      />
    </div>
  );
}

function Check({
  label,
  value,
  disabled,
  field,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  field: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ ...row, ...small, justifyContent: "flex-start", gap: 6 }}>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        data-image-style-check={field}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  disabled,
  field,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  disabled: boolean;
  field: string;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ ...row, gap: 4 }}>
      <label style={{ ...small, flex: 1 }}>{label}</label>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        data-image-style-choice={field}
        onChange={(e) => onChange(e.target.value as T)}
        style={small}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function ColourWell({
  label,
  value,
  disabled,
  field,
  onChange,
}: {
  label: string;
  value: Rgb;
  disabled: boolean;
  field: string;
  onChange: (v: Rgb) => void;
}) {
  return (
    <div style={{ ...row, gap: 4 }}>
      <label style={{ ...small, flex: 1 }}>{label}</label>
      <input
        type="color"
        aria-label={label}
        disabled={disabled}
        data-image-style-colour={field}
        value={hex(value)}
        onChange={(e) => onChange(rgbOf(e.target.value))}
      />
    </div>
  );
}

function BlendPick({
  value,
  disabled,
  field,
  onChange,
}: {
  value: BlendModeName;
  disabled: boolean;
  field: string;
  onChange: (v: BlendModeName) => void;
}) {
  return (
    <Choice
      label={t(M.blendMode)}
      value={value}
      options={STYLE_BLEND_MODES.map((m) => [m, m.replace(/_/g, " ")] as const)}
      disabled={disabled}
      field={field}
      onChange={onChange}
    />
  );
}

/** Which preset a contour is (by its points), or "custom". */
function contourKey(c: Contour): string {
  const same = (a: Contour, b: Contour) =>
    a.points.length === b.points.length &&
    a.points.every((p, i) => p.x === b.points[i]!.x && p.y === b.points[i]!.y);
  for (const [k, make] of Object.entries(CONTOURS)) {
    if (same(c, make())) return k;
  }
  return "custom";
}

function ContourPick({
  label,
  value,
  disabled,
  field,
  onChange,
}: {
  label: string;
  value: Contour;
  disabled: boolean;
  field: string;
  onChange: (v: Contour) => void;
}) {
  const key = contourKey(value);
  const options: (readonly [string, string])[] = Object.keys(CONTOURS).map(
    (k) => [k, CONTOUR_LABEL[k]?.() ?? k] as const,
  );
  if (key === "custom") options.push(["custom", t(M.contourCustom)]);
  return (
    <Choice
      label={label}
      value={key}
      options={options}
      disabled={disabled}
      field={field}
      onChange={(k) => {
        const make = CONTOURS[k];
        if (make) onChange(make());
      }}
    />
  );
}

/** A two-stop gradient: start and end colour, end opacity. */
function GradientPick({
  value,
  disabled,
  field,
  onChange,
}: {
  value: Gradient;
  disabled: boolean;
  field: string;
  onChange: (g: Gradient) => void;
}) {
  const a = value.stops[0]?.rgb ?? [0, 0, 0];
  const b = value.stops[value.stops.length - 1]?.rgb ?? [255, 255, 255];
  const endOpacity =
    value.opacityStops[value.opacityStops.length - 1]?.opacity ?? 1;
  const make = (sa: Rgb, sb: Rgb, op: number): Gradient => {
    const g = twoStopGradient(sa, sb);
    g.opacityStops[1]!.opacity = op;
    return g;
  };
  return (
    <div data-image-style-gradient={field}>
      <ColourWell
        label={t(M.startColour)}
        value={a}
        disabled={disabled}
        field={`${field}.start`}
        onChange={(c) => onChange(make(c, b, endOpacity))}
      />
      <ColourWell
        label={t(M.endColour)}
        value={b}
        disabled={disabled}
        field={`${field}.end`}
        onChange={(c) => onChange(make(a, c, endOpacity))}
      />
      <Num
        label={t(M.endOpacity)}
        value={Math.round(endOpacity * 100)}
        min={0}
        max={100}
        disabled={disabled}
        field={`${field}.endOpacity`}
        onChange={(v) => onChange(make(a, b, v / 100))}
      />
    </div>
  );
}

function GradientFillFields({
  value,
  disabled,
  field,
  onChange,
}: {
  value: GradientFill;
  disabled: boolean;
  field: string;
  onChange: (g: GradientFill) => void;
}) {
  const set = (patch: Partial<GradientFill>) =>
    onChange({ ...value, ...patch });
  return (
    <>
      <GradientPick
        value={value.gradient}
        disabled={disabled}
        field={`${field}.gradient`}
        onChange={(g) => set({ gradient: g })}
      />
      <Check
        label={t(M.reverse)}
        value={value.reverse}
        disabled={disabled}
        field={`${field}.reverse`}
        onChange={(v) => set({ reverse: v })}
      />
      <Choice
        label={t(M.style)}
        value={value.style}
        options={[
          ["linear", t(M.linear)],
          ["radial", t(M.radial)],
          ["angle", t(M.angleStyle)],
          ["reflected", t(M.reflected)],
          ["diamond", t(M.diamond)],
        ]}
        disabled={disabled}
        field={`${field}.style`}
        onChange={(v) => set({ style: v })}
      />
      <Check
        label={t(M.alignWithLayer)}
        value={value.align}
        disabled={disabled}
        field={`${field}.align`}
        onChange={(v) => set({ align: v })}
      />
      <Num
        label={t(M.angle)}
        value={value.angle}
        min={-180}
        max={180}
        disabled={disabled}
        field={`${field}.angle`}
        onChange={(v) => set({ angle: v })}
      />
      <Num
        label={t(M.scale)}
        value={value.scale}
        min={10}
        max={150}
        disabled={disabled}
        field={`${field}.scale`}
        onChange={(v) => set({ scale: v })}
      />
      <Num
        label={t(M.offsetX)}
        value={value.offset[0]}
        min={-100}
        max={100}
        disabled={disabled}
        field={`${field}.offsetX`}
        onChange={(v) => set({ offset: [v, value.offset[1]] })}
      />
      <Num
        label={t(M.offsetY)}
        value={value.offset[1]}
        min={-100}
        max={100}
        disabled={disabled}
        field={`${field}.offsetY`}
        onChange={(v) => set({ offset: [value.offset[0], v] })}
      />
    </>
  );
}

function PatternFields({
  value,
  disabled,
  field,
  onUsePattern,
  onChange,
}: {
  value: PatternFill;
  disabled: boolean;
  field: string;
  onUsePattern: () => PatternRef | null;
  onChange: (p: PatternFill) => void;
}) {
  const [missing, setMissing] = useState(false);
  return (
    <>
      <div style={{ ...row, gap: 4 }}>
        <span style={small} data-image-style-pattern-name={field}>
          {value.pattern.name
            ? t(M.patternName, { name: value.pattern.name })
            : t(M.noPattern)}
        </span>
        <button
          type="button"
          disabled={disabled}
          data-image-style-use-pattern={field}
          style={small}
          onClick={() => {
            const p = onUsePattern();
            setMissing(p === null);
            if (p) onChange({ ...value, pattern: p });
          }}
        >
          {t(M.useDefinedPattern)}
        </button>
      </div>
      {missing ? <div style={note}>{t(M.noPattern)}</div> : null}
      <Num
        label={t(M.scale)}
        value={value.scale}
        min={1}
        max={1000}
        disabled={disabled}
        field={`${field}.scale`}
        onChange={(v) => onChange({ ...value, scale: v })}
      />
      <Check
        label={t(M.linkWithLayer)}
        value={value.link}
        disabled={disabled}
        field={`${field}.link`}
        onChange={(v) => onChange({ ...value, link: v })}
      />
    </>
  );
}

// ───────────────────────────── panes ─────────────────────────────

interface PaneProps {
  style: LayerStyle;
  at: number;
  disabled: boolean;
  light: GlobalLight;
  onStyle: (s: LayerStyle) => void;
  onGlobalLight: (angle: number, altitude: number) => void;
  onUsePattern: () => PatternRef | null;
}

/** The angle control: with Use Global Light it edits the document's. */
function AngleFields({
  angle,
  useGlobal,
  altitude,
  light,
  disabled,
  field,
  onLocal,
  onGlobalLight,
}: {
  angle: number;
  useGlobal: boolean;
  altitude?: number;
  light: GlobalLight;
  disabled: boolean;
  field: string;
  onLocal: (patch: {
    angle?: number;
    altitude?: number;
    useGlobalLight?: boolean;
  }) => void;
  onGlobalLight: (angle: number, altitude: number) => void;
}) {
  const a = useGlobal ? light.angle : angle;
  const alt = useGlobal ? light.altitude : (altitude ?? 30);
  return (
    <>
      <Num
        label={t(M.angle)}
        value={a}
        min={-180}
        max={180}
        disabled={disabled}
        field={`${field}.angle`}
        onChange={(v) =>
          useGlobal ? onGlobalLight(v, alt) : onLocal({ angle: v })
        }
      />
      {altitude !== undefined ? (
        <Num
          label={t(M.altitude)}
          value={alt}
          min={0}
          max={90}
          disabled={disabled}
          field={`${field}.altitude`}
          onChange={(v) =>
            useGlobal ? onGlobalLight(a, v) : onLocal({ altitude: v })
          }
        />
      ) : null}
      <Check
        label={t(M.useGlobalLight)}
        value={useGlobal}
        disabled={disabled}
        field={`${field}.global`}
        onChange={(v) => onLocal({ useGlobalLight: v })}
      />
    </>
  );
}

function ShadowPane({ inner, ...p }: PaneProps & { inner: boolean }) {
  const list = inner ? p.style.innerShadows : p.style.dropShadows;
  const s = list[p.at];
  if (!s) return null;
  const f = inner ? "innerShadow" : "dropShadow";
  const set = (patch: Partial<typeof s>) => {
    const next = cloneStyle(p.style);
    const l = inner ? next.innerShadows : next.dropShadows;
    l[p.at] = { ...s, ...patch };
    p.onStyle(next);
  };
  return (
    <div data-image-style-pane={f}>
      <BlendPick
        value={s.blend}
        disabled={p.disabled}
        field={`${f}.blend`}
        onChange={(v) => set({ blend: v })}
      />
      <ColourWell
        label={t(M.colour)}
        value={s.color}
        disabled={p.disabled}
        field={`${f}.color`}
        onChange={(v) => set({ color: v })}
      />
      <Num
        label={t(M.opacity)}
        value={s.opacity}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.opacity`}
        onChange={(v) => set({ opacity: v })}
      />
      <AngleFields
        angle={s.angle}
        useGlobal={s.useGlobalLight}
        light={p.light}
        disabled={p.disabled}
        field={f}
        onLocal={(patch) => set(patch)}
        onGlobalLight={p.onGlobalLight}
      />
      <Num
        label={t(M.distance)}
        value={s.distance}
        min={0}
        max={30000}
        disabled={p.disabled}
        field={`${f}.distance`}
        onChange={(v) => set({ distance: v })}
      />
      <Num
        label={inner ? t(M.choke) : t(M.spread)}
        value={s.spread}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.spread`}
        onChange={(v) => set({ spread: v })}
      />
      <Num
        label={t(M.size)}
        value={s.size}
        min={0}
        max={250}
        disabled={p.disabled}
        field={`${f}.size`}
        onChange={(v) => set({ size: v })}
      />
      <ContourPick
        label={t(M.contour)}
        value={s.contour}
        disabled={p.disabled}
        field={`${f}.contour`}
        onChange={(v) => set({ contour: v })}
      />
      <Check
        label={t(M.antiAliased)}
        value={s.antiAliased}
        disabled={p.disabled}
        field={`${f}.antiAliased`}
        onChange={(v) => set({ antiAliased: v })}
      />
      <Num
        label={t(M.noise)}
        value={s.noise}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.noise`}
        onChange={(v) => set({ noise: v })}
      />
      {!inner ? (
        <Check
          label={t(M.knocksOut)}
          value={s.knocksOut}
          disabled={p.disabled}
          field={`${f}.knocksOut`}
          onChange={(v) => set({ knocksOut: v })}
        />
      ) : null}
    </div>
  );
}

function GlowPane({ inner, ...p }: PaneProps & { inner: boolean }) {
  const g = inner ? p.style.innerGlow : p.style.outerGlow;
  if (!g) return null;
  const f = inner ? "innerGlow" : "outerGlow";
  const set = (patch: Partial<typeof g>) => {
    const next = cloneStyle(p.style);
    if (inner) next.innerGlow = { ...g, ...patch };
    else next.outerGlow = { ...g, ...patch };
    p.onStyle(next);
  };
  return (
    <div data-image-style-pane={f}>
      <BlendPick
        value={g.blend}
        disabled={p.disabled}
        field={`${f}.blend`}
        onChange={(v) => set({ blend: v })}
      />
      <Num
        label={t(M.opacity)}
        value={g.opacity}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.opacity`}
        onChange={(v) => set({ opacity: v })}
      />
      <Num
        label={t(M.noise)}
        value={g.noise}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.noise`}
        onChange={(v) => set({ noise: v })}
      />
      <Choice
        label={t(M.fillType)}
        value={g.fill.kind}
        options={[
          ["color", t(M.solid)],
          ["gradient", t(M.gradient)],
        ]}
        disabled={p.disabled}
        field={`${f}.fill`}
        onChange={(k) =>
          set({
            fill:
              k === "color"
                ? { kind: "color", rgb: [255, 255, 190] }
                : {
                    kind: "gradient",
                    gradient: twoStopGradient([255, 255, 190], [255, 255, 190]),
                  },
          })
        }
      />
      {g.fill.kind === "color" ? (
        <ColourWell
          label={t(M.colour)}
          value={g.fill.rgb}
          disabled={p.disabled}
          field={`${f}.color`}
          onChange={(v) => set({ fill: { kind: "color", rgb: v } })}
        />
      ) : (
        <GradientPick
          value={g.fill.gradient}
          disabled={p.disabled}
          field={`${f}.gradient`}
          onChange={(v) => set({ fill: { kind: "gradient", gradient: v } })}
        />
      )}
      <Choice
        label={t(M.technique)}
        value={g.technique}
        options={[
          ["softer", t(M.softer)],
          ["precise", t(M.precise)],
        ]}
        disabled={p.disabled}
        field={`${f}.technique`}
        onChange={(v) => set({ technique: v })}
      />
      {inner ? (
        <Choice
          label={t(M.source)}
          value={g.source}
          options={[
            ["center", t(M.center)],
            ["edge", t(M.edge)],
          ]}
          disabled={p.disabled}
          field={`${f}.source`}
          onChange={(v) => set({ source: v })}
        />
      ) : null}
      <Num
        label={inner ? t(M.choke) : t(M.spread)}
        value={g.spread}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.spread`}
        onChange={(v) => set({ spread: v })}
      />
      <Num
        label={t(M.size)}
        value={g.size}
        min={0}
        max={250}
        disabled={p.disabled}
        field={`${f}.size`}
        onChange={(v) => set({ size: v })}
      />
      <ContourPick
        label={t(M.contour)}
        value={g.contour}
        disabled={p.disabled}
        field={`${f}.contour`}
        onChange={(v) => set({ contour: v })}
      />
      <Num
        label={t(M.range)}
        value={g.range}
        min={1}
        max={100}
        disabled={p.disabled}
        field={`${f}.range`}
        onChange={(v) => set({ range: v })}
      />
      <Num
        label={t(M.jitter)}
        value={g.jitter}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.jitter`}
        onChange={(v) => set({ jitter: v })}
      />
    </div>
  );
}

function BevelPane(p: PaneProps) {
  const b = p.style.bevel;
  if (!b) return null;
  const f = "bevel";
  const set = (patch: Partial<typeof b>) => {
    const next = cloneStyle(p.style);
    next.bevel = { ...b, ...patch };
    p.onStyle(next);
  };
  const contour = b.contour ?? {
    enabled: false,
    contour: CONTOURS.linear!(),
    antiAliased: false,
    range: 50,
  };
  const texture = b.texture ?? {
    enabled: false,
    fill: defaultPatternFill(),
    depth: 100,
    invert: false,
  };
  return (
    <div data-image-style-pane={f}>
      <Choice
        label={t(M.style)}
        value={b.style}
        options={[
          ["outer_bevel", t(M.outerBevel)],
          ["inner_bevel", t(M.innerBevel)],
          ["emboss", t(M.emboss)],
          ["pillow_emboss", t(M.pillowEmboss)],
          ["stroke_emboss", t(M.strokeEmboss)],
        ]}
        disabled={p.disabled}
        field={`${f}.style`}
        onChange={(v) => set({ style: v })}
      />
      <Choice
        label={t(M.technique)}
        value={b.technique}
        options={[
          ["smooth", t(M.smooth)],
          ["chisel_hard", t(M.chiselHard)],
          ["chisel_soft", t(M.chiselSoft)],
        ]}
        disabled={p.disabled}
        field={`${f}.technique`}
        onChange={(v) => set({ technique: v })}
      />
      <Num
        label={t(M.depth)}
        value={b.depth}
        min={1}
        max={1000}
        disabled={p.disabled}
        field={`${f}.depth`}
        onChange={(v) => set({ depth: v })}
      />
      <Choice
        label={t(M.direction)}
        value={b.down ? "down" : "up"}
        options={[
          ["up", t(M.up)],
          ["down", t(M.down)],
        ]}
        disabled={p.disabled}
        field={`${f}.direction`}
        onChange={(v) => set({ down: v === "down" })}
      />
      <Num
        label={t(M.size)}
        value={b.size}
        min={0}
        max={250}
        disabled={p.disabled}
        field={`${f}.size`}
        onChange={(v) => set({ size: v })}
      />
      <Num
        label={t(M.soften)}
        value={b.soften}
        min={0}
        max={16}
        disabled={p.disabled}
        field={`${f}.soften`}
        onChange={(v) => set({ soften: v })}
      />
      <AngleFields
        angle={b.angle}
        altitude={b.altitude}
        useGlobal={b.useGlobalLight}
        light={p.light}
        disabled={p.disabled}
        field={f}
        onLocal={(patch) => set(patch)}
        onGlobalLight={p.onGlobalLight}
      />
      <ContourPick
        label={t(M.glossContour)}
        value={b.gloss}
        disabled={p.disabled}
        field={`${f}.gloss`}
        onChange={(v) => set({ gloss: v })}
      />
      {(["highlight", "shadow"] as const).map((which) => (
        <div key={which} data-image-style-bevel-light={which}>
          <div style={sectionTitle}>
            {t(which === "highlight" ? M.highlight : M.shadow)}
          </div>
          <BlendPick
            value={b[which].blend}
            disabled={p.disabled}
            field={`${f}.${which}.blend`}
            onChange={(v) => set({ [which]: { ...b[which], blend: v } })}
          />
          <ColourWell
            label={t(M.colour)}
            value={b[which].color}
            disabled={p.disabled}
            field={`${f}.${which}.color`}
            onChange={(v) => set({ [which]: { ...b[which], color: v } })}
          />
          <Num
            label={t(M.opacity)}
            value={b[which].opacity}
            min={0}
            max={100}
            disabled={p.disabled}
            field={`${f}.${which}.opacity`}
            onChange={(v) => set({ [which]: { ...b[which], opacity: v } })}
          />
        </div>
      ))}
      <div style={sectionTitle}>{t(M.contourPane)}</div>
      <Check
        label={t(M.contourPane)}
        value={contour.enabled}
        disabled={p.disabled}
        field={`${f}.contour.enabled`}
        onChange={(v) => set({ contour: { ...contour, enabled: v } })}
      />
      <ContourPick
        label={t(M.contour)}
        value={contour.contour}
        disabled={p.disabled || !contour.enabled}
        field={`${f}.contour.shape`}
        onChange={(v) => set({ contour: { ...contour, contour: v } })}
      />
      <Num
        label={t(M.range)}
        value={contour.range}
        min={1}
        max={100}
        disabled={p.disabled || !contour.enabled}
        field={`${f}.contour.range`}
        onChange={(v) => set({ contour: { ...contour, range: v } })}
      />
      <div style={sectionTitle}>{t(M.texturePane)}</div>
      <Check
        label={t(M.texturePane)}
        value={texture.enabled}
        disabled={p.disabled}
        field={`${f}.texture.enabled`}
        onChange={(v) => set({ texture: { ...texture, enabled: v } })}
      />
      <PatternFields
        value={texture.fill}
        disabled={p.disabled || !texture.enabled}
        field={`${f}.texture`}
        onUsePattern={p.onUsePattern}
        onChange={(v) => set({ texture: { ...texture, fill: v } })}
      />
      <Num
        label={t(M.depth)}
        value={texture.depth}
        min={-1000}
        max={1000}
        disabled={p.disabled || !texture.enabled}
        field={`${f}.texture.depth`}
        onChange={(v) => set({ texture: { ...texture, depth: v } })}
      />
      <Check
        label={t(M.invert)}
        value={texture.invert}
        disabled={p.disabled || !texture.enabled}
        field={`${f}.texture.invert`}
        onChange={(v) => set({ texture: { ...texture, invert: v } })}
      />
    </div>
  );
}

function SatinPane(p: PaneProps) {
  const s = p.style.satin;
  if (!s) return null;
  const f = "satin";
  const set = (patch: Partial<typeof s>) => {
    const next = cloneStyle(p.style);
    next.satin = { ...s, ...patch };
    p.onStyle(next);
  };
  return (
    <div data-image-style-pane={f}>
      <BlendPick
        value={s.blend}
        disabled={p.disabled}
        field={`${f}.blend`}
        onChange={(v) => set({ blend: v })}
      />
      <ColourWell
        label={t(M.colour)}
        value={s.color}
        disabled={p.disabled}
        field={`${f}.color`}
        onChange={(v) => set({ color: v })}
      />
      <Num
        label={t(M.opacity)}
        value={s.opacity}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.opacity`}
        onChange={(v) => set({ opacity: v })}
      />
      <Num
        label={t(M.angle)}
        value={s.angle}
        min={-180}
        max={180}
        disabled={p.disabled}
        field={`${f}.angle`}
        onChange={(v) => set({ angle: v })}
      />
      <Num
        label={t(M.distance)}
        value={s.distance}
        min={1}
        max={250}
        disabled={p.disabled}
        field={`${f}.distance`}
        onChange={(v) => set({ distance: v })}
      />
      <Num
        label={t(M.size)}
        value={s.size}
        min={0}
        max={250}
        disabled={p.disabled}
        field={`${f}.size`}
        onChange={(v) => set({ size: v })}
      />
      <ContourPick
        label={t(M.contour)}
        value={s.contour}
        disabled={p.disabled}
        field={`${f}.contour`}
        onChange={(v) => set({ contour: v })}
      />
      <Check
        label={t(M.antiAliased)}
        value={s.antiAliased}
        disabled={p.disabled}
        field={`${f}.antiAliased`}
        onChange={(v) => set({ antiAliased: v })}
      />
      <Check
        label={t(M.invert)}
        value={s.invert}
        disabled={p.disabled}
        field={`${f}.invert`}
        onChange={(v) => set({ invert: v })}
      />
    </div>
  );
}

function ColorOverlayPane(p: PaneProps) {
  const c = p.style.colorOverlays[p.at];
  if (!c) return null;
  const f = "colorOverlay";
  const set = (patch: Partial<typeof c>) => {
    const next = cloneStyle(p.style);
    next.colorOverlays[p.at] = { ...c, ...patch };
    p.onStyle(next);
  };
  return (
    <div data-image-style-pane={f}>
      <BlendPick
        value={c.blend}
        disabled={p.disabled}
        field={`${f}.blend`}
        onChange={(v) => set({ blend: v })}
      />
      <ColourWell
        label={t(M.colour)}
        value={c.color}
        disabled={p.disabled}
        field={`${f}.color`}
        onChange={(v) => set({ color: v })}
      />
      <Num
        label={t(M.opacity)}
        value={c.opacity}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.opacity`}
        onChange={(v) => set({ opacity: v })}
      />
    </div>
  );
}

function GradientOverlayPane(p: PaneProps) {
  const g = p.style.gradientOverlays[p.at];
  if (!g) return null;
  const f = "gradientOverlay";
  const set = (patch: Partial<typeof g>) => {
    const next = cloneStyle(p.style);
    next.gradientOverlays[p.at] = { ...g, ...patch };
    p.onStyle(next);
  };
  return (
    <div data-image-style-pane={f}>
      <BlendPick
        value={g.blend}
        disabled={p.disabled}
        field={`${f}.blend`}
        onChange={(v) => set({ blend: v })}
      />
      <Num
        label={t(M.opacity)}
        value={g.opacity}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.opacity`}
        onChange={(v) => set({ opacity: v })}
      />
      <GradientFillFields
        value={g.fill}
        disabled={p.disabled}
        field={f}
        onChange={(v) => set({ fill: v })}
      />
    </div>
  );
}

function PatternOverlayPane(p: PaneProps) {
  const o = p.style.patternOverlay;
  if (!o) return null;
  const f = "patternOverlay";
  const set = (patch: Partial<typeof o>) => {
    const next = cloneStyle(p.style);
    next.patternOverlay = { ...o, ...patch };
    p.onStyle(next);
  };
  return (
    <div data-image-style-pane={f}>
      <BlendPick
        value={o.blend}
        disabled={p.disabled}
        field={`${f}.blend`}
        onChange={(v) => set({ blend: v })}
      />
      <Num
        label={t(M.opacity)}
        value={o.opacity}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.opacity`}
        onChange={(v) => set({ opacity: v })}
      />
      <PatternFields
        value={o.fill}
        disabled={p.disabled}
        field={f}
        onUsePattern={p.onUsePattern}
        onChange={(v) => set({ fill: v })}
      />
    </div>
  );
}

function StrokePane(p: PaneProps) {
  const s = p.style.strokes[p.at];
  if (!s) return null;
  const f = "stroke";
  const set = (patch: Partial<typeof s>) => {
    const next = cloneStyle(p.style);
    next.strokes[p.at] = { ...s, ...patch };
    p.onStyle(next);
  };
  return (
    <div data-image-style-pane={f}>
      <Num
        label={t(M.size)}
        value={s.size}
        min={1}
        max={250}
        disabled={p.disabled}
        field={`${f}.size`}
        onChange={(v) => set({ size: v })}
      />
      <Choice
        label={t(M.position)}
        value={s.position}
        options={[
          ["outside", t(M.outside)],
          ["inside", t(M.inside)],
          ["center", t(M.centerPosition)],
        ]}
        disabled={p.disabled}
        field={`${f}.position`}
        onChange={(v) => set({ position: v })}
      />
      <BlendPick
        value={s.blend}
        disabled={p.disabled}
        field={`${f}.blend`}
        onChange={(v) => set({ blend: v })}
      />
      <Num
        label={t(M.opacity)}
        value={s.opacity}
        min={0}
        max={100}
        disabled={p.disabled}
        field={`${f}.opacity`}
        onChange={(v) => set({ opacity: v })}
      />
      <Choice
        label={t(M.fillType)}
        value={s.fill.kind}
        options={[
          ["color", t(M.solid)],
          ["gradient", t(M.gradient)],
          ["pattern", t(M.pattern)],
        ]}
        disabled={p.disabled}
        field={`${f}.fill`}
        onChange={(k) =>
          set({
            fill:
              k === "color"
                ? { kind: "color", rgb: [0, 0, 0] }
                : k === "gradient"
                  ? { kind: "gradient", ...defaultGradientFill() }
                  : {
                      kind: "pattern",
                      ...defaultPatternFill(p.onUsePattern() ?? undefined),
                    },
          })
        }
      />
      {s.fill.kind === "color" ? (
        <ColourWell
          label={t(M.colour)}
          value={s.fill.rgb}
          disabled={p.disabled}
          field={`${f}.color`}
          onChange={(v) => set({ fill: { kind: "color", rgb: v } })}
        />
      ) : s.fill.kind === "gradient" ? (
        <GradientFillFields
          value={s.fill}
          disabled={p.disabled}
          field={f}
          onChange={(v) => set({ fill: { kind: "gradient", ...v } })}
        />
      ) : (
        <PatternFields
          value={s.fill}
          disabled={p.disabled}
          field={f}
          onUsePattern={p.onUsePattern}
          onChange={(v) => set({ fill: { kind: "pattern", ...v } })}
        />
      )}
    </div>
  );
}

function instanceCount(s: LayerStyle, k: EffectKind): number {
  switch (k) {
    case "dropShadow":
      return s.dropShadows.length;
    case "innerShadow":
      return s.innerShadows.length;
    case "colorOverlay":
      return s.colorOverlays.length;
    case "gradientOverlay":
      return s.gradientOverlays.length;
    case "stroke":
      return s.strokes.length;
    default:
      return firstEffect(s, k) ? 1 : 0;
  }
}

function removeInstance(s: LayerStyle, k: EffectKind, at: number): LayerStyle {
  const next = cloneStyle(s);
  const drop = <T,>(l: T[]) => l.filter((_, i) => i !== at);
  switch (k) {
    case "dropShadow":
      next.dropShadows = drop(next.dropShadows);
      break;
    case "innerShadow":
      next.innerShadows = drop(next.innerShadows);
      break;
    case "colorOverlay":
      next.colorOverlays = drop(next.colorOverlays);
      break;
    case "gradientOverlay":
      next.gradientOverlays = drop(next.gradientOverlays);
      break;
    case "stroke":
      next.strokes = drop(next.strokes);
      break;
    case "outerGlow":
      next.outerGlow = null;
      break;
    case "innerGlow":
      next.innerGlow = null;
      break;
    case "bevel":
      next.bevel = null;
      break;
    case "satin":
      next.satin = null;
      break;
    case "patternOverlay":
      next.patternOverlay = null;
      break;
  }
  return next;
}

// ───────────────────────────── the dialog ─────────────────────────────

export function LayerStyleDialog({
  layer,
  style,
  options,
  light,
  pane,
  disabled,
  onPane,
  onStyle,
  onOptions,
  onGlobalLight,
  onUsePattern,
  onMoreBlending,
  onClose,
}: {
  layer: LayerInfo;
  style: LayerStyle | null;
  options: StyleOptions;
  light: GlobalLight;
  pane: LayerStylePane;
  disabled: boolean;
  onPane: (p: LayerStylePane) => void;
  onStyle: (s: LayerStyle | null) => void;
  onOptions: (o: StyleOptions) => void;
  onGlobalLight: (angle: number, altitude: number) => void;
  onUsePattern: () => PatternRef | null;
  onMoreBlending: () => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  const s = style ?? emptyStyle();
  const count = pane === "blending" ? 0 : instanceCount(s, pane);
  const i = Math.min(at, Math.max(0, count - 1));
  const props: PaneProps = {
    style: s,
    at: i,
    disabled,
    light,
    onStyle,
    onGlobalLight,
    onUsePattern,
  };
  const pick = (k: LayerStylePane) => {
    setAt(0);
    onPane(k);
  };
  return (
    <div
      data-image-layer-style
      role="dialog"
      aria-label={t(M.title, { name: layer.name })}
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: 4,
        padding: space[2],
        margin: `${space[2]} 0`,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: space[1] }}>
        {t(M.title, { name: layer.name })}
      </div>
      <div style={{ display: "flex", gap: space[2] }}>
        <div style={{ minWidth: 150 }} data-image-style-list>
          <button
            type="button"
            data-image-style-pick="blending"
            aria-pressed={pane === "blending"}
            onClick={() => pick("blending")}
            style={{ ...small, fontWeight: pane === "blending" ? 600 : 400 }}
          >
            {t(M.blending)}
          </button>
          {EFFECT_KINDS.map((k) => {
            const e = firstEffect(s, k);
            return (
              <div key={k} style={{ ...row, gap: 4 }}>
                <input
                  type="checkbox"
                  aria-label={effectLabel(k)}
                  checked={e?.enabled ?? false}
                  disabled={disabled}
                  data-image-style-enable={k}
                  onChange={(ev) =>
                    onStyle(
                      setEffectEnabled(
                        s,
                        k,
                        ev.target.checked,
                        k === "patternOverlay" && ev.target.checked && !e
                          ? (onUsePattern() ?? undefined)
                          : undefined,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  data-image-style-pick={k}
                  aria-pressed={pane === k}
                  onClick={() => pick(k)}
                  style={{
                    ...small,
                    flex: 1,
                    textAlign: "left",
                    fontWeight: pane === k ? 600 : 400,
                  }}
                >
                  {effectLabel(k)}
                </button>
                {REPEATABLE.includes(k) ? (
                  <button
                    type="button"
                    disabled={disabled}
                    data-image-style-add={k}
                    aria-label={t(M.addInstance, { effect: effectLabel(k) })}
                    onClick={() => {
                      onStyle(addInstance(s, k));
                      setAt(instanceCount(s, k));
                      onPane(k);
                    }}
                    style={small}
                  >
                    +
                  </button>
                ) : null}
              </div>
            );
          })}
          <Check
            label={t(M.previewEffects)}
            value={s.enabled}
            disabled={disabled || style === null}
            field="master"
            onChange={(v) => onStyle({ ...s, enabled: v })}
          />
        </div>
        <div style={{ flex: 1 }}>
          {pane === "blending" ? (
            <div data-image-style-pane="blending">
              {(
                [
                  ["blendInterior", M.blendInterior],
                  ["blendClipped", M.blendClipped],
                  ["transparencyShapes", M.transparencyShapes],
                  ["maskHidesEffects", M.maskHides],
                  ["vectorMaskHidesEffects", M.vectorMaskHides],
                ] as const
              ).map(([key, m]) => (
                <Check
                  key={key}
                  label={t(m)}
                  value={options[key]}
                  disabled={disabled}
                  field={`options.${key}`}
                  onChange={(v) => onOptions({ ...options, [key]: v })}
                />
              ))}
              <button
                type="button"
                data-image-style-more-blending
                onClick={onMoreBlending}
                style={small}
              >
                {t(M.moreBlending)}
              </button>
            </div>
          ) : (
            <>
              <div style={sectionTitle}>{effectLabel(pane)}</div>
              {count > 1 ? (
                <div
                  style={{ ...row, gap: 4 }}
                  data-image-style-instances={count}
                >
                  <select
                    value={i}
                    aria-label={effectLabel(pane)}
                    onChange={(e) => setAt(Number(e.target.value))}
                    style={small}
                  >
                    {Array.from({ length: count }, (_, n) => (
                      <option key={n} value={n}>
                        {t(M.instance, { at: n + 1, count })}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {count > 0 ? (
                <button
                  type="button"
                  disabled={disabled}
                  data-image-style-remove={pane}
                  onClick={() => {
                    onStyle(removeInstance(s, pane, i));
                    setAt(0);
                  }}
                  style={small}
                >
                  {t(M.removeInstance, { effect: effectLabel(pane) })}
                </button>
              ) : null}
              {pane === "dropShadow" ? (
                <ShadowPane inner={false} {...props} />
              ) : null}
              {pane === "innerShadow" ? <ShadowPane inner {...props} /> : null}
              {pane === "outerGlow" ? (
                <GlowPane inner={false} {...props} />
              ) : null}
              {pane === "innerGlow" ? <GlowPane inner {...props} /> : null}
              {pane === "bevel" ? <BevelPane {...props} /> : null}
              {pane === "satin" ? <SatinPane {...props} /> : null}
              {pane === "colorOverlay" ? <ColorOverlayPane {...props} /> : null}
              {pane === "gradientOverlay" ? (
                <GradientOverlayPane {...props} />
              ) : null}
              {pane === "patternOverlay" ? (
                <PatternOverlayPane {...props} />
              ) : null}
              {pane === "stroke" ? <StrokePane {...props} /> : null}
            </>
          )}
        </div>
      </div>
      <div style={{ ...row, gap: 4, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-image-style-clear
          disabled={disabled || style === null}
          onClick={() => onStyle(null)}
          style={small}
        >
          {t(M.clearStyle)}
        </button>
        <button
          type="button"
          data-image-style-close
          onClick={onClose}
          style={small}
        >
          {t(M.close)}
        </button>
      </div>
      <div style={note}>{t(M.styleNote)}</div>
    </div>
  );
}

export function GlobalLightDialog({
  light,
  disabled,
  onApply,
  onClose,
}: {
  light: GlobalLight;
  disabled: boolean;
  onApply: (angle: number, altitude: number) => void;
  onClose: () => void;
}) {
  const [angle, setAngle] = useState(light.angle);
  const [altitude, setAltitude] = useState(light.altitude);
  return (
    <div
      data-image-global-light
      role="dialog"
      aria-label={t(M.globalLight)}
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: 4,
        padding: space[2],
        margin: `${space[2]} 0`,
      }}
    >
      <div style={{ fontWeight: 600 }}>{t(M.globalLight)}</div>
      <Num
        label={t(M.angle)}
        value={angle}
        min={-180}
        max={180}
        disabled={disabled}
        field="globalLight.angle"
        onChange={setAngle}
      />
      <Num
        label={t(M.altitude)}
        value={altitude}
        min={0}
        max={90}
        disabled={disabled}
        field="globalLight.altitude"
        onChange={setAltitude}
      />
      <div style={{ ...row, gap: 4, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-image-global-light-apply
          disabled={disabled}
          onClick={() => onApply(angle, altitude)}
          style={small}
        >
          {t(M.apply)}
        </button>
        <button
          type="button"
          data-image-global-light-close
          onClick={onClose}
          style={small}
        >
          {t(M.cancel)}
        </button>
      </div>
    </div>
  );
}

export function ScaleEffectsDialog({
  disabled,
  onApply,
  onClose,
}: {
  disabled: boolean;
  onApply: (percent: number) => void;
  onClose: () => void;
}) {
  const [percent, setPercent] = useState(100);
  return (
    <div
      data-image-scale-effects
      role="dialog"
      aria-label={t(M.scaleEffects)}
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: 4,
        padding: space[2],
        margin: `${space[2]} 0`,
      }}
    >
      <div style={{ fontWeight: 600 }}>{t(M.scaleEffects)}</div>
      <Num
        label={t(M.scale)}
        value={percent}
        min={1}
        max={1000}
        disabled={disabled}
        field="scaleEffects.percent"
        onChange={setPercent}
      />
      <div style={{ ...row, gap: 4, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-image-scale-effects-apply
          disabled={disabled}
          onClick={() => onApply(percent)}
          style={small}
        >
          {t(M.apply)}
        </button>
        <button
          type="button"
          data-image-scale-effects-close
          onClick={onClose}
          style={small}
        >
          {t(M.cancel)}
        </button>
      </div>
    </div>
  );
}

/** The STYLES section: the presets, and the active layer's style verbs. */
export function StylesSection({
  presets,
  hasStyle,
  hasClipboard,
  disabled,
  onApply,
  onSave,
  onDelete,
  onCopy,
  onPaste,
  onClear,
}: {
  presets: readonly StylePreset[];
  hasStyle: boolean;
  hasClipboard: boolean;
  disabled: boolean;
  onApply: (name: string) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <div data-image-styles>
      <div style={sectionTitle}>{t(M.styles)}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {presets.map((p) => (
          <span key={p.name} style={{ display: "inline-flex", gap: 2 }}>
            <button
              type="button"
              disabled={disabled}
              data-image-style-preset={p.name}
              aria-label={t(M.applyStyle, { name: p.name })}
              onClick={() => onApply(p.name)}
              style={small}
            >
              {p.name}
            </button>
            {p.builtIn ? null : (
              <button
                type="button"
                disabled={disabled}
                data-image-style-preset-delete={p.name}
                aria-label={t(M.deleteStyle, { name: p.name })}
                onClick={() => onDelete(p.name)}
                style={small}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <div style={{ ...row, gap: 4 }}>
        <input
          type="text"
          value={name}
          aria-label={t(M.styleName)}
          placeholder={t(M.styleName)}
          data-image-style-preset-name
          onChange={(e) => setName(e.target.value)}
          style={{ ...small, flex: 1 }}
        />
        <button
          type="button"
          disabled={disabled || !hasStyle || name.trim() === ""}
          data-image-style-preset-save
          onClick={() => {
            onSave(name);
            setName("");
          }}
          style={small}
        >
          {t(M.newStyle)}
        </button>
      </div>
      <div style={{ ...row, gap: 4 }}>
        <button
          type="button"
          disabled={disabled || !hasStyle}
          data-image-style-copy
          onClick={onCopy}
          style={small}
        >
          {t(M.copyStyle)}
        </button>
        <button
          type="button"
          disabled={disabled || !hasClipboard}
          data-image-style-paste
          onClick={onPaste}
          style={small}
        >
          {t(M.pasteStyle)}
        </button>
        <button
          type="button"
          disabled={disabled || !hasStyle}
          data-image-style-clear-active
          onClick={onClear}
          style={small}
        >
          {t(M.clearStyle)}
        </button>
      </div>
      {hasStyle ? null : <div style={note}>{t(M.noStyle)}</div>}
    </div>
  );
}
