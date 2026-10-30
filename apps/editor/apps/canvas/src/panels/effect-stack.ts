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

// Engine ADR 1008, editor ADR 309 — the ordered effect stack, as the
// Effects and Appearance panels and the Effect menu edit it. The engine
// keeps one stack per transparency target and takes it whole
// (`frameEffectStack`, `frameFillEffectStack`, …: one write, one undo
// step); every gesture here — add, remove, move, switch on or off, change
// a stack-only effect's parameter — is a pure function from the stack read
// to the stack written.
//
// WHICH kinds exist, which targets take them, how often a stack may hold
// one and the form of their parameters are core's (`CORE_EFFECT_KINDS`,
// the catalog's `effectKinds`): nothing here lists a kind, so a kind the
// engine adds is offered without a change to the editor (plan C16).
// InDesign's nine carry no parameters in the stack: theirs stay on their
// own per-field paths (`frameInnerShadowSize`, …), which the Effects
// panel's disclosures edit.

import {
  CORE_EFFECT_CATEGORIES,
  CORE_EFFECT_KINDS,
} from "@paged-media/plugin-sdk";
import type {
  EffectKindDescriptor,
  EffectParamDescriptor,
} from "@paged-media/plugin-api";

/** An effect kind, as the wire spells it (`gaussianBlur`). */
export type EffectKind = string;

/** One stack entry (the wire's `EffectEntrySpec`): `kind`, `enabled`, and
 *  the flat optional parameters each kind reads. */
export interface StackEntry {
  kind: EffectKind;
  enabled: boolean;
  blendMode?: string | null;
  opacityPct?: number | null;
  [param: string]: unknown;
}

export type StackTarget = "object" | "fill" | "stroke" | "content";

/** Every kind core describes, in the wire's order. */
export function effectKinds(): readonly EffectKindDescriptor[] {
  return CORE_EFFECT_KINDS;
}

/** Core's description of `kind`, or `undefined` for a kind this build's
 *  catalog does not know (a newer document): it is listed, not edited. */
export function kindOf(kind: EffectKind): EffectKindDescriptor | undefined {
  return CORE_EFFECT_KINDS.find((k) => k.kind === kind);
}

/** One of InDesign's nine (its parameters are per-field paths). */
export const isIndesign = (k: EffectKind) => kindOf(k)?.indesign === true;

/** The parameters of a stack-only kind, in form order. */
export const paramsOf = (k: EffectKind): readonly EffectParamDescriptor[] =>
  kindOf(k)?.params ?? [];

/** The Effect menu's groups that hold a kind, in menu order, each with
 *  its kinds in the wire's order. */
export function effectMenu(): {
  category: string;
  kinds: EffectKindDescriptor[];
}[] {
  return CORE_EFFECT_CATEGORIES.map((category) => ({
    category,
    kinds: CORE_EFFECT_KINDS.filter((k) => k.category === category),
  })).filter((g) => g.kinds.length > 0);
}

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

/** Whether `kind` may join this target's stack: the target takes it and
 *  the stack holds fewer than its limit. */
export function canAdd(
  entries: readonly StackEntry[],
  target: StackTarget,
  kind: EffectKind,
): boolean {
  const k = kindOf(kind);
  if (!k || !k.targets.includes(target)) return false;
  const held = entries.filter((e) => e.kind === kind).length;
  return k.maxPerStack === undefined || held < k.maxPerStack;
}

/** The kinds the add menu offers a target, in the wire's order. */
export function addable(
  entries: readonly StackEntry[],
  target: StackTarget,
): EffectKind[] {
  return CORE_EFFECT_KINDS.filter((k) => canAdd(entries, target, k.kind)).map(
    (k) => k.kind,
  );
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
export function setParam(
  entries: readonly StackEntry[],
  index: number,
  key: string,
  value: unknown,
): StackEntry[] {
  return entries.map((e, i) => (i === index ? { ...e, [key]: value } : e));
}

/** The control a parameter's value type takes. */
export type ParamControl = "number" | "enum" | "bool" | "color" | "swatch";

export function controlOf(p: EffectParamDescriptor): ParamControl {
  switch (p.type.kind) {
    case "bool":
      return "bool";
    case "enum":
      return "enum";
    case "color":
      return "color";
    case "ref":
      return "swatch";
    default:
      return "number";
  }
}

/** The unit suffix a number parameter shows. */
export function suffixOf(p: EffectParamDescriptor): string | undefined {
  const t = p.type;
  if (t.kind === "length") return "pt";
  if (t.kind === "number")
    return t.unit === "percent" ? "%" : t.unit === "deg" ? "°" : undefined;
  return undefined;
}
