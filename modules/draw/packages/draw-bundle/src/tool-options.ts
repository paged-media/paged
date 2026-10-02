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

// TOOL OPTIONS — the parameters the freehand tools ran on as constants.
//
// WHAT THE CONTRACT GIVES. `ToolContribution.options` is a
// `ToolOptionsSpec` (`{ toolId, fields }`), and the editor renders it:
// double-click a rail slot and a popover edits one value per field, each
// written to the HOST's tool-settings store under `toolId`. So the
// declaration, the UI and the storage are the host's, and this module
// adds none of the three.
//
// WHAT THE CONTRACT DOES NOT GIVE — two things, both measured against
// `@paged-media/plugin-api` 0.2.37-canary.0, and both worked around in
// exactly ONE place each rather than papered over:
//
//   1. NO DECLARED READ DOOR. The store the popover writes is
//      `PagedEditor.toolSettings` on the editor's own handle
//      (`{ get(toolId), getValue(toolId, key), set(toolId, key, value) }`),
//      and every built-in tool reads it there. The contract's
//      `PagedEditor` — the type of the argument `GestureHandler.onActivate`
//      receives — declares no such member, and `BundleHost` has no facade
//      for it (`host.storage` is the bundle's OWN key/value store, a
//      different thing: the popover never writes there). The values are
//      therefore reachable at RUNTIME on the object a handler is handed
//      and unreachable in the TYPES. `toolSettingsDoorOf` is the one
//      structural probe — the same shape `menu.ts` uses for
//      `contribute.menu` — and where it finds nothing (the headless
//      harness, an older editor) every option reads as its default, which
//      is the tool exactly as it shipped.
//
//   2. NO DEFAULT ON A FIELD. `ToolOptionField` carries `min`/`max`/`step`
//      and no `default`, and the popover shows an UNSET number as its
//      `min` (an unset select as its first option, an unset toggle as
//      off). A 6 pt nib would be displayed as 0.5 pt until first edited.
//      Two things keep the display honest: `seed` writes each still-unset
//      default into the host's store when the tool activates (the popover
//      is reached by double-clicking the tool's own slot, i.e. after it
//      activated), and every `select` here lists its default FIRST, so
//      that one is right even unseeded. No option is a `toggle` whose
//      default is on, for the same reason.
//
// PERSISTENCE IS THE HOST'S. Values live in the host's store and
// nowhere else — this module keeps no copy, so "what the popover shows"
// and "what the next stroke uses" cannot disagree. The editor's store is
// in-memory today (app state, per session); when it learns to persist,
// these options persist with it and nothing here changes.

import type {
  ToolOptionField,
  ToolOptionsSpec,
} from "@paged-media/plugin-api";

type OptionValue = number | boolean | string;

/** The host's tool-settings store, as far as this bundle uses it — the
 *  shape of the editor's `PagedEditor.toolSettings` (see gap 1 above). */
export interface ToolSettingsDoor {
  getValue(toolId: string, key: string): unknown;
  set?(toolId: string, key: string, value: OptionValue): void;
}

/** The ONE probe for the undeclared member: the handle a handler gets in
 *  `onActivate`, read structurally. Null when the host has no store. */
export function toolSettingsDoorOf(paged: unknown): ToolSettingsDoor | null {
  if (!paged || typeof paged !== "object") return null;
  const door = (paged as { toolSettings?: unknown }).toolSettings;
  if (!door || typeof door !== "object") return null;
  if (typeof (door as ToolSettingsDoor).getValue !== "function") return null;
  return door as ToolSettingsDoor;
}

export interface NumberOption {
  kind: "number";
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  default: number;
}

export interface SelectOption<V extends string = string> {
  kind: "select";
  key: string;
  label: string;
  /** The DEFAULT comes first — an unset select displays its first
   *  option (gap 2 above); `defineToolOptions` refuses anything else. */
  options: readonly { value: V; label: string }[];
  default: V;
}

export type OptionDef = NumberOption | SelectOption;

/** One tool's options: the contract's spec, plus the defaults and the
 *  ranges the contract has no room for. */
export interface ToolOptionsDef {
  toolId: string;
  fields: readonly OptionDef[];
}

/** Validate a definition at module load — a default outside its own
 *  range, or a select whose default is not its first option, is a typo
 *  that would otherwise surface as a popover showing one value while the
 *  tool uses another. */
export function defineToolOptions<D extends ToolOptionsDef>(def: D): D {
  const seen = new Set<string>();
  for (const f of def.fields) {
    if (seen.has(f.key)) {
      throw new Error(`${def.toolId}: duplicate option key "${f.key}"`);
    }
    seen.add(f.key);
    if (f.kind === "number") {
      if (!(f.min <= f.default && f.default <= f.max)) {
        throw new Error(
          `${def.toolId}.${f.key}: default ${f.default} is outside ${f.min}..${f.max}`,
        );
      }
    } else if (f.options[0]?.value !== f.default) {
      throw new Error(
        `${def.toolId}.${f.key}: the default "${f.default}" must be the first option`,
      );
    }
  }
  return def;
}

/** The `ToolContribution.options` value: the definition with everything
 *  the contract does not model (`default`) stripped. */
export function toolOptionsSpecOf(def: ToolOptionsDef): ToolOptionsSpec {
  return {
    toolId: def.toolId,
    fields: def.fields.map((f): ToolOptionField => {
      if (f.kind === "number") {
        return {
          kind: "number",
          key: f.key,
          label: f.label,
          min: f.min,
          max: f.max,
          ...(f.step !== undefined ? { step: f.step } : {}),
          ...(f.unit !== undefined ? { unit: f.unit } : {}),
        };
      }
      return {
        kind: "select",
        key: f.key,
        label: f.label,
        options: f.options.map((o) => ({ value: o.value, label: o.label })),
      };
    }),
  };
}

/** A handler's live view of its tool's options. `attach` in
 *  `onActivate`; read on every gesture start — never cached, because the
 *  popover can change a value between two strokes of the same
 *  activation. */
export interface ToolOptionsReader {
  /** Bind to the handle `onActivate` received and seed the still-unset
   *  defaults into the host's store (gap 2). Safe with `undefined`. */
  attach(paged: unknown): void;
  /** The number under `key`, clamped to the field's range; the default
   *  when the host has no store or holds no finite number there. */
  number(key: string): number;
  /** The select value under `key`; the default when unset or when the
   *  store holds something that is not one of the options. */
  select(key: string): string;
}

export function createToolOptionsReader(def: ToolOptionsDef): ToolOptionsReader {
  let door: ToolSettingsDoor | null = null;

  const field = (key: string, kind: OptionDef["kind"]): OptionDef => {
    const f = def.fields.find((d) => d.key === key);
    if (!f || f.kind !== kind) {
      throw new Error(`${def.toolId}: no ${kind} option "${key}"`);
    }
    return f;
  };

  const raw = (key: string): unknown => {
    if (!door) return undefined;
    try {
      return door.getValue(def.toolId, key);
    } catch {
      return undefined;
    }
  };

  return {
    attach(paged) {
      door = toolSettingsDoorOf(paged);
      if (!door || typeof door.set !== "function") return;
      for (const f of def.fields) {
        if (raw(f.key) !== undefined) continue;
        try {
          door.set(def.toolId, f.key, f.default);
        } catch {
          /* a store that refuses a write still answers reads */
        }
      }
    },
    number(key) {
      const f = field(key, "number") as NumberOption;
      const v = raw(key);
      const n = typeof v === "number" && Number.isFinite(v) ? v : f.default;
      return Math.min(f.max, Math.max(f.min, n));
    },
    select(key) {
      const f = field(key, "select") as SelectOption;
      const v = raw(key);
      return typeof v === "string" && f.options.some((o) => o.value === v)
        ? v
        : f.default;
    },
  };
}

// ------------------------------------------------------------ the tools
//
// Every default below is the constant the tool shipped with, so a host
// with no store — and a user who never opens the popover — gets the same
// strokes as before. The conformance spec asserts that, option by option.

const FIDELITY: Omit<NumberOption, "default"> = {
  kind: "number",
  key: "fidelity",
  label: "Fidelity",
  min: 0.5,
  max: 20,
  step: 0.5,
  unit: "px",
};

/** The calligraphic nib — shared by the Paintbrush and the Blob Brush,
 *  which have always swept with the same one. */
const nibFields = (): OptionDef[] => [
  {
    kind: "number",
    key: "size",
    label: "Size",
    min: 0.5,
    max: 200,
    step: 0.5,
    unit: "pt",
    default: 6,
  },
  {
    kind: "number",
    key: "angle",
    label: "Angle",
    min: -180,
    max: 180,
    step: 1,
    unit: "°",
    default: 45,
  },
  {
    kind: "number",
    key: "roundness",
    label: "Roundness",
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    default: 30,
  },
  { ...FIDELITY, default: 2 },
];

export const PAINTBRUSH_OPTIONS = defineToolOptions({
  toolId: "media.paged.draw.tool.paintbrush",
  fields: nibFields(),
});

export const BLOB_BRUSH_OPTIONS = defineToolOptions({
  toolId: "media.paged.draw.tool.blobBrush",
  fields: nibFields(),
});

/** The eraser: a ROUND, pressure-free nib, so its one shape parameter is
 *  its size — the width of the band it cuts. */
export const ERASER_OPTIONS = defineToolOptions({
  toolId: "media.paged.draw.tool.eraserBrush",
  fields: [
    {
      kind: "number",
      key: "size",
      label: "Size",
      min: 0.5,
      max: 200,
      step: 0.5,
      unit: "pt",
      default: 6,
    },
    { ...FIDELITY, default: 2 },
  ],
});

export const PENCIL_OPTIONS = defineToolOptions({
  toolId: "media.paged.draw.tool.pencil",
  fields: [
    { ...FIDELITY, default: 2 },
    {
      kind: "select",
      key: "smoothing",
      label: "Smoothing",
      options: [
        { value: "smooth", label: "Smooth curves" },
        { value: "corners", label: "Corner points" },
      ],
      default: "smooth",
    },
    {
      kind: "number",
      key: "closeDistance",
      label: "Close within",
      min: 0,
      max: 50,
      step: 1,
      unit: "px",
      default: 8,
    },
  ],
});

export const WIDTH_OPTIONS = defineToolOptions({
  toolId: "media.paged.draw.tool.width",
  fields: [
    {
      kind: "number",
      key: "maxWidth",
      label: "Peak limit",
      min: 1,
      max: 500,
      step: 1,
      unit: "pt",
      default: 72,
    },
    {
      kind: "number",
      key: "gain",
      label: "Width per drag",
      min: 0.1,
      max: 10,
      step: 0.1,
      unit: "pt/pt",
      default: 1,
    },
    {
      kind: "number",
      key: "falloff",
      label: "Falloff",
      min: 1,
      max: 20,
      step: 1,
      unit: "anchors",
      default: 2,
    },
  ],
});

/** Every tool that declares options, by tool id — what `tools.ts`
 *  attaches to the contribution and what the spec walks. */
export const TOOL_OPTIONS: readonly ToolOptionsDef[] = [
  PENCIL_OPTIONS,
  PAINTBRUSH_OPTIONS,
  BLOB_BRUSH_OPTIONS,
  ERASER_OPTIONS,
  WIDTH_OPTIONS,
];
