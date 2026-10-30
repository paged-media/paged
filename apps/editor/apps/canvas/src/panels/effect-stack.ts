/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Engine ADR 1008 — the ordered effect stack, as the Effects panel edits
// it. The engine keeps one stack per transparency target and takes it
// whole (`frameEffectStack`, `frameFillEffectStack`, …: one write, one
// undo step); every gesture here — add, remove, move, switch on or off,
// change a stack-only effect's parameter — is a pure function from the
// stack read to the stack written.
//
// InDesign's nine effects carry no parameters in the stack: theirs stay
// on their own per-field paths (`frameInnerShadowSize`, …), which the
// panel's existing disclosures edit. The stack-only effects carry theirs
// in the entry, flat (the wire's `EffectEntrySpec`).

/** An effect kind, as the wire spells it. */
export type EffectKind =
  | "dropShadow"
  | "innerShadow"
  | "outerGlow"
  | "innerGlow"
  | "bevelEmboss"
  | "satin"
  | "feather"
  | "directionalFeather"
  | "gradientFeather"
  | "gaussianBlur"
  | "outlineStroke"
  | "colorOverlay"
  | "gradientOverlay"
  | "reflection"
  | "softEdge"
  | "noise"
  | "colorAdjust";

/** One stack entry (the wire's `EffectEntrySpec`). */
export interface StackEntry {
  kind: EffectKind;
  enabled: boolean;
  blendMode?: string | null;
  opacityPct?: number | null;
  radiusPt?: number | null;
  sizePt?: number | null;
  position?: string | null;
  color?: string | null;
  gradient?: string | null;
  angleDeg?: number | null;
  reverse?: boolean | null;
  distancePt?: number | null;
  sizePct?: number | null;
  startOpacityPct?: number | null;
  endOpacityPct?: number | null;
  blurPt?: number | null;
  amountPct?: number | null;
  monochromatic?: boolean | null;
  brightness?: number | null;
  contrast?: number | null;
  saturation?: number | null;
  hueDeg?: number | null;
}

/** InDesign's nine, in its own order. */
export const INDESIGN_KINDS: readonly EffectKind[] = [
  "dropShadow",
  "innerShadow",
  "outerGlow",
  "innerGlow",
  "bevelEmboss",
  "satin",
  "feather",
  "directionalFeather",
  "gradientFeather",
];

/** The effects only the stack has (applied to the object target). */
export const STACK_ONLY_KINDS: readonly EffectKind[] = [
  "gaussianBlur",
  "outlineStroke",
  "colorOverlay",
  "gradientOverlay",
  "reflection",
  "softEdge",
  "noise",
  "colorAdjust",
];

export const isIndesign = (k: EffectKind) => INDESIGN_KINDS.includes(k);

export type StackTarget = "object" | "fill" | "stroke" | "content";

/** The stack path of a target. */
export const STACK_PATHS: Record<StackTarget, string> = {
  object: "frameEffectStack",
  fill: "frameFillEffectStack",
  stroke: "frameStrokeEffectStack",
  content: "frameContentEffectStack",
};

/** The entries of a read `Value::EffectStack` (`{ entries, prev }`), or
 *  `null` when the read is not one. */
export function entriesOf(value: unknown): StackEntry[] | null {
  // The object model reads the stack as its list of entries.
  if (Array.isArray(value)) return value as StackEntry[];
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: string; value?: unknown };
  const inner =
    v.type === "effectStack" ? v.value : (value as { entries?: unknown });
  const entries = (inner as { entries?: unknown } | null)?.entries;
  return Array.isArray(entries) ? (entries as StackEntry[]) : null;
}

/** The wire value a stack write commits. */
export function stackValue(entries: readonly StackEntry[]) {
  return { type: "effectStack", value: { entries: [...entries] } } as const;
}

/** The kinds the add menu offers a target: every kind not on it yet that
 *  the target takes (InDesign's once each; the stack-only ones on the
 *  object target, as often as wanted). */
export function addable(
  entries: readonly StackEntry[],
  target: StackTarget,
): EffectKind[] {
  const present = new Set(entries.map((e) => e.kind));
  const indesign = INDESIGN_KINDS.filter((k) => !present.has(k));
  return target === "object" ? [...indesign, ...STACK_ONLY_KINDS] : indesign;
}

/** Add `kind` at the end: an enabled entry at its defaults. */
export function add(
  entries: readonly StackEntry[],
  kind: EffectKind,
): StackEntry[] {
  return [...entries, { kind, enabled: true }];
}

export function remove(
  entries: readonly StackEntry[],
  index: number,
): StackEntry[] {
  return entries.filter((_, i) => i !== index);
}

/** Move the entry at `index` by `delta` places (clamped to the stack). */
export function move(
  entries: readonly StackEntry[],
  index: number,
  delta: number,
): StackEntry[] {
  const to = Math.max(0, Math.min(entries.length - 1, index + delta));
  if (to === index || !entries[index]) return [...entries];
  const out = [...entries];
  const [e] = out.splice(index, 1);
  out.splice(to, 0, e!);
  return out;
}

export function setEnabled(
  entries: readonly StackEntry[],
  index: number,
  enabled: boolean,
): StackEntry[] {
  return entries.map((e, i) => (i === index ? { ...e, enabled } : e));
}

/** Set one parameter of the entry at `index`. */
export function setParam<K extends keyof StackEntry>(
  entries: readonly StackEntry[],
  index: number,
  key: K,
  value: StackEntry[K],
): StackEntry[] {
  return entries.map((e, i) => (i === index ? { ...e, [key]: value } : e));
}

/** One parameter control of a stack-only effect. */
export interface ParamSpec {
  key: keyof StackEntry;
  /** The message key of its label (see effects-panel's messages). */
  label: string;
  control: "number" | "color" | "gradient" | "position" | "bool";
  suffix?: string;
  min?: number;
  max?: number;
}

/** The parameter controls of each stack-only kind, in panel order. */
export const PARAMS: Partial<Record<EffectKind, readonly ParamSpec[]>> = {
  gaussianBlur: [
    {
      key: "radiusPt",
      label: "radius",
      control: "number",
      suffix: "pt",
      min: 0,
    },
  ],
  outlineStroke: [
    { key: "sizePt", label: "size", control: "number", suffix: "pt", min: 0 },
    { key: "position", label: "position", control: "position" },
    { key: "color", label: "color", control: "color" },
  ],
  colorOverlay: [{ key: "color", label: "color", control: "color" }],
  gradientOverlay: [
    { key: "gradient", label: "gradient", control: "gradient" },
    { key: "angleDeg", label: "angle", control: "number", suffix: "°" },
    { key: "reverse", label: "reverse", control: "bool" },
  ],
  reflection: [
    {
      key: "distancePt",
      label: "distance",
      control: "number",
      suffix: "pt",
      min: 0,
    },
    {
      key: "sizePct",
      label: "size",
      control: "number",
      suffix: "%",
      min: 0,
      max: 100,
    },
    {
      key: "startOpacityPct",
      label: "startOpacity",
      control: "number",
      suffix: "%",
      min: 0,
      max: 100,
    },
    {
      key: "endOpacityPct",
      label: "endOpacity",
      control: "number",
      suffix: "%",
      min: 0,
      max: 100,
    },
    { key: "blurPt", label: "blur", control: "number", suffix: "pt", min: 0 },
  ],
  softEdge: [
    { key: "sizePt", label: "size", control: "number", suffix: "pt", min: 0 },
  ],
  noise: [
    {
      key: "amountPct",
      label: "amount",
      control: "number",
      suffix: "%",
      min: 0,
      max: 100,
    },
    { key: "monochromatic", label: "monochromatic", control: "bool" },
  ],
  colorAdjust: [
    {
      key: "brightness",
      label: "brightness",
      control: "number",
      min: -100,
      max: 100,
    },
    {
      key: "contrast",
      label: "contrast",
      control: "number",
      min: -100,
      max: 100,
    },
    {
      key: "saturation",
      label: "saturation",
      control: "number",
      min: -100,
      max: 100,
    },
    {
      key: "hueDeg",
      label: "hue",
      control: "number",
      suffix: "°",
      min: -180,
      max: 180,
    },
  ],
};
