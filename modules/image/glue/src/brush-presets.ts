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

// THE BRUSH PRESET LIBRARY — a PURE model the session holds and the
// Brush Presets panel edits: the stock brushes, the presets a user
// defined (Define Brush Preset), and the ones imported from `.abr` or
// from this bundle's own JSON format.
//
// Every edit returns a NEW list; an edit that is refused (an unknown id,
// an empty name, an index out of range) returns the SAME list instance,
// so a caller can tell "nothing changed" by identity and say why.
//
// THE OWN FORMAT ("paged-brush-presets", version 1) is what Export writes
// when `.abr` cannot carry something and what Import reads back. It is
// validated strictly: an unknown key, a wrong type or an out-of-list enum
// is a NAMED error with the path that failed, never a silently defaulted
// field — a preset that loaded "mostly" would paint something its author
// did not make.

import { base64ToBytes, bytesToBase64 } from "@paged-media/helpers";
import { defineMessages, t } from "@paged-media/strings";

import type { BrushParams } from "./engine";
import {
  BRUSH_CONTROLS,
  COMBINE_MODES,
  DEFAULT_BRUSH_DYNAMICS,
  SYMMETRY_KINDS,
  cloneDynamics,
  type BrushDynamics,
  type TipBitmap,
} from "./brush-dynamics";

/** The brush parameters a preset carries (colour, blend and the pen's
 *  pressure target stay with the user, as in Photoshop). */
export type PresetParams = Pick<
  BrushParams,
  "size" | "hardness" | "spacing" | "opacity" | "flow"
>;

export type PresetSource = "default" | "defined" | "abr" | "imported";

export interface UserBrushPreset {
  /** Stable for the preset's life: renames and reorders keep it. */
  id: string;
  name: string;
  source: PresetSource;
  params: PresetParams;
  dynamics: BrushDynamics;
}

const M = defineMessages("image.brushPresetLibrary", {
  hardRound: "Hard Round {size}",
  softRound: "Soft Round {size}",
  airbrush: "Soft Round Airbrush {size}",
  spray: "Spray {size}",
  untitled: "Brush {n}",
});

/** The next free `user-<n>` id (deterministic: the largest in use + 1). */
export function nextPresetId(list: readonly UserBrushPreset[]): string {
  let max = 0;
  for (const p of list) {
    const m = /^user-(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `user-${max + 1}`;
}

/** A default preset name for the n-th user preset. */
export function untitledName(n: number): string {
  return t(M.untitled, { n });
}

function preset(
  id: string,
  name: string,
  params: PresetParams,
  edit?: (d: BrushDynamics) => void,
): UserBrushPreset {
  const dynamics = cloneDynamics(DEFAULT_BRUSH_DYNAMICS);
  edit?.(dynamics);
  return { id, name, source: "default", params, dynamics };
}

/** The stock brushes (named in the active language at call time). */
export function defaultPresets(): UserBrushPreset[] {
  const round = (hardness: number, size: number): PresetParams => ({
    size,
    hardness,
    spacing: 0.25,
    opacity: 1,
    flow: 1,
  });
  return [
    preset("default-hard-10", t(M.hardRound, { size: 10 }), round(1, 10)),
    preset("default-hard-30", t(M.hardRound, { size: 30 }), round(1, 30)),
    preset("default-soft-30", t(M.softRound, { size: 30 }), round(0, 30)),
    preset("default-soft-100", t(M.softRound, { size: 100 }), round(0, 100)),
    preset(
      "default-airbrush-60",
      t(M.airbrush, { size: 60 }),
      { ...round(0, 60), flow: 0.1, spacing: 0.1 },
      (d) => {
        d.buildUp = true;
      },
    ),
    preset(
      "default-spray-40",
      t(M.spray, { size: 40 }),
      { ...round(0.3, 40), spacing: 0.4 },
      (d) => {
        d.scatter.enabled = true;
        d.scatter.amount.jitter = 2.5;
        d.scatter.bothAxes = true;
        d.scatter.count = 4;
        d.shape.enabled = true;
        d.shape.size.jitter = 0.5;
      },
    ),
  ];
}

/** Append `p`; a duplicate id is refused. */
export function addPreset(
  list: readonly UserBrushPreset[],
  p: UserBrushPreset,
): readonly UserBrushPreset[] {
  if (list.some((x) => x.id === p.id)) return list;
  return [...list, p];
}

/** Rename (trimmed). An empty name or an unknown id is refused. */
export function renamePreset(
  list: readonly UserBrushPreset[],
  id: string,
  name: string,
): readonly UserBrushPreset[] {
  const trimmed = name.trim();
  const i = list.findIndex((p) => p.id === id);
  if (trimmed === "" || i < 0 || list[i].name === trimmed) return list;
  const out = [...list];
  out[i] = { ...list[i], name: trimmed };
  return out;
}

export function deletePreset(
  list: readonly UserBrushPreset[],
  id: string,
): readonly UserBrushPreset[] {
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return list;
  return [...list.slice(0, i), ...list.slice(i + 1)];
}

/** Move the preset at `from` to `to` (both indices into `list`). */
export function movePreset(
  list: readonly UserBrushPreset[],
  from: number,
  to: number,
): readonly UserBrushPreset[] {
  const n = list.length;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= n ||
    to < 0 ||
    to >= n ||
    from === to
  )
    return list;
  const out = [...list];
  const [p] = out.splice(from, 1);
  out.splice(to, 0, p);
  return out;
}

/** What applying `p` sets: its parameters and its dynamics — except
 *  that PROTECT TEXTURE keeps the current texture pane when the current
 *  brush protects it and both brushes are textured (Photoshop's rule:
 *  the paper stays the same as you change brushes). */
export function applyPreset(
  p: UserBrushPreset,
  current: BrushDynamics,
): { params: PresetParams; dynamics: BrushDynamics } {
  const dynamics = cloneDynamics(p.dynamics);
  if (
    current.protectTexture &&
    current.texture.enabled &&
    p.dynamics.texture.enabled
  ) {
    dynamics.texture = {
      ...current.texture,
      depthJitter: { ...current.texture.depthJitter },
    };
    dynamics.protectTexture = true;
  }
  return { params: { ...p.params }, dynamics };
}

// ── the own format ───────────────────────────────────────────────────

export const PRESET_FORMAT = "paged-brush-presets";
export const PRESET_FORMAT_VERSION = 1;

export type PresetFormatErrorCode =
  | "not-json"
  | "wrong-format"
  | "unsupported-version"
  | "not-a-list"
  | "unknown-key"
  | "missing-key"
  | "wrong-type"
  | "not-in-list"
  | "bad-bitmap"
  | "duplicate-id";

/** A refusal with the path that failed (`presets[2].dynamics.tip.angle`). */
export class PresetFormatError extends Error {
  constructor(
    readonly code: PresetFormatErrorCode,
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "PresetFormatError";
  }
}

const toBase64 = bytesToBase64;

function fromBase64(s: string, path: string): Uint8Array {
  try {
    return base64ToBytes(s);
  } catch {
    throw new PresetFormatError("bad-bitmap", path, "alpha is not base64");
  }
}

const encodeBitmap = (b: TipBitmap | null) =>
  b === null
    ? null
    : { id: b.id, width: b.width, height: b.height, alpha: toBase64(b.alpha) };

/** The library as the own format's text. */
export function serializePresets(list: readonly UserBrushPreset[]): string {
  return JSON.stringify(
    {
      format: PRESET_FORMAT,
      version: PRESET_FORMAT_VERSION,
      presets: list.map((p) => ({
        id: p.id,
        name: p.name,
        source: p.source,
        params: { ...p.params },
        dynamics: {
          ...p.dynamics,
          bitmap: encodeBitmap(p.dynamics.bitmap),
          dual: {
            ...p.dynamics.dual,
            bitmap: encodeBitmap(p.dynamics.dual.bitmap),
          },
        },
      })),
    },
    null,
    1,
  );
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The string fields whose value must be one of a list, by the key name
 *  under which they appear. */
const ENUMS: Record<string, readonly string[]> = {
  control: BRUSH_CONTROLS,
  mode: COMBINE_MODES,
  kind: SYMMETRY_KINDS,
};

function readBitmap(v: unknown, path: string): TipBitmap | null {
  if (v === null) return null;
  if (!isObj(v))
    throw new PresetFormatError("wrong-type", path, "expected an object");
  for (const k of Object.keys(v))
    if (!["id", "width", "height", "alpha"].includes(k))
      throw new PresetFormatError("unknown-key", `${path}.${k}`, "not a key");
  const { id, width, height, alpha } = v;
  if (typeof id !== "string")
    throw new PresetFormatError("wrong-type", `${path}.id`, "expected text");
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new PresetFormatError(
      "bad-bitmap",
      path,
      "width and height must be positive integers",
    );
  if (typeof alpha !== "string")
    throw new PresetFormatError("wrong-type", `${path}.alpha`, "expected text");
  const bytes = fromBase64(alpha, `${path}.alpha`);
  if (bytes.length !== width * height)
    throw new PresetFormatError(
      "bad-bitmap",
      path,
      `alpha is ${bytes.length} bytes for ${width}×${height}`,
    );
  return { id, width, height, alpha: bytes };
}

/** Read `input` against the shape of `template` (a default value). */
function readLike(template: unknown, input: unknown, path: string): unknown {
  const key = path.slice(path.lastIndexOf(".") + 1);
  if (key === "bitmap") return readBitmap(input, path);
  if (typeof template === "number") {
    if (typeof input !== "number" || !Number.isFinite(input))
      throw new PresetFormatError("wrong-type", path, "expected a number");
    return input;
  }
  if (typeof template === "boolean") {
    if (typeof input !== "boolean")
      throw new PresetFormatError("wrong-type", path, "expected true/false");
    return input;
  }
  if (typeof template === "string") {
    if (typeof input !== "string")
      throw new PresetFormatError("wrong-type", path, "expected text");
    const list = ENUMS[key];
    if (list && !list.includes(input))
      throw new PresetFormatError(
        "not-in-list",
        path,
        `"${input}" is not one of ${list.join(", ")}`,
      );
    return input;
  }
  if (!isObj(template) || !isObj(input))
    throw new PresetFormatError("wrong-type", path, "expected an object");
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input))
    if (!(k in template))
      throw new PresetFormatError("unknown-key", `${path}.${k}`, "not a key");
  for (const [k, tv] of Object.entries(template)) {
    if (!(k in input))
      throw new PresetFormatError("missing-key", `${path}.${k}`, "is missing");
    out[k] = readLike(tv, input[k], `${path}.${k}`);
  }
  return out;
}

const SOURCES: readonly PresetSource[] = [
  "default",
  "defined",
  "abr",
  "imported",
];

/** Parse the own format. Throws a {@link PresetFormatError} naming the
 *  first thing that is wrong. */
export function deserializePresets(text: string): UserBrushPreset[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PresetFormatError("not-json", "$", "not JSON");
  }
  if (!isObj(doc) || doc.format !== PRESET_FORMAT)
    throw new PresetFormatError(
      "wrong-format",
      "$.format",
      `not a ${PRESET_FORMAT} file`,
    );
  if (doc.version !== PRESET_FORMAT_VERSION)
    throw new PresetFormatError(
      "unsupported-version",
      "$.version",
      `version ${String(doc.version)} (this reads ${PRESET_FORMAT_VERSION})`,
    );
  if (!Array.isArray(doc.presets))
    throw new PresetFormatError("not-a-list", "$.presets", "expected a list");
  const seen = new Set<string>();
  const paramsTemplate: PresetParams = {
    size: 0,
    hardness: 0,
    spacing: 0,
    opacity: 0,
    flow: 0,
  };
  return doc.presets.map((raw: unknown, i: number) => {
    const path = `presets[${i}]`;
    if (!isObj(raw))
      throw new PresetFormatError("wrong-type", path, "expected an object");
    for (const k of Object.keys(raw))
      if (!["id", "name", "source", "params", "dynamics"].includes(k))
        throw new PresetFormatError("unknown-key", `${path}.${k}`, "not a key");
    const { id, name, source } = raw;
    if (typeof id !== "string" || id === "")
      throw new PresetFormatError("wrong-type", `${path}.id`, "expected text");
    if (seen.has(id))
      throw new PresetFormatError("duplicate-id", `${path}.id`, `"${id}"`);
    seen.add(id);
    if (typeof name !== "string")
      throw new PresetFormatError(
        "wrong-type",
        `${path}.name`,
        "expected text",
      );
    if (typeof source !== "string" || !SOURCES.includes(source as PresetSource))
      throw new PresetFormatError(
        "not-in-list",
        `${path}.source`,
        `"${String(source)}" is not one of ${SOURCES.join(", ")}`,
      );
    const params = readLike(
      paramsTemplate,
      raw.params,
      `${path}.params`,
    ) as PresetParams;
    const dynamics = readLike(
      DEFAULT_BRUSH_DYNAMICS,
      raw.dynamics,
      `${path}.dynamics`,
    ) as BrushDynamics;
    return {
      id,
      name,
      source: source as PresetSource,
      params,
      dynamics,
    };
  });
}
