// THE PRESET MANAGER's model (image ADR 477) — PURE. One shape for every
// kind of preset the image context keeps: brushes (WP5.7's library, kept
// in `brush-presets.ts`), tool presets, adjustment presets, gradients,
// patterns and layer styles (WP5.4's Styles presets). The dialog lists,
// renames, deletes and reorders any of them through the generic edits
// below; import and export go through each kind's file format (`.abr`,
// `.grd`, `.pat`, `.asl`, or this module's own JSON for the kinds
// Photoshop's formats do not carry here).
//
// Every edit returns a NEW list; a refused edit (an unknown id, an empty
// name, an index out of range) returns the SAME instance, so a caller can
// tell "nothing changed" by identity.

import { defineMessages, t } from "@paged-media/strings";

import type { BrushDynamics, PaintToolOptions } from "./brush-dynamics";
import {
  freshIdentityParams,
  type AdjustParams,
  type BrushParams,
  type GradientValue,
} from "./engine";

/** The kinds the Preset Manager lists, in its tab order. */
export const PRESET_KINDS = [
  "brushes",
  "tools",
  "adjustments",
  "gradients",
  "patterns",
  "styles",
] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

/** What every preset has. */
export interface PresetEntry {
  /** Stable for the preset's life: renames and reorders keep it. */
  id: string;
  name: string;
  /** Shipped with the bundle: renamed and reordered, never deleted. */
  builtIn?: boolean;
}

export interface GradientPreset extends PresetEntry {
  gradient: GradientValue;
}

export interface PatternPreset extends PresetEntry {
  /** Photoshop's unique id, when the pattern came from a file (styles
   *  refer to patterns by it). */
  psId: string;
  width: number;
  height: number;
  /** `width × height × 4` straight RGBA8. */
  rgba: Uint8Array;
}

export interface AdjustmentPreset extends PresetEntry {
  params: AdjustParams;
}

/** A TOOL PRESET: a brush tool's settings under a name (Photoshop's Tool
 *  Presets): the brush parameters, the brush engine's dynamics, and the
 *  paint tools' own options. */
export interface ToolPreset extends PresetEntry {
  brush: Omit<BrushParams, "color" | "pressureTarget">;
  dynamics: BrushDynamics | null;
  paintTools: PaintToolOptions | null;
}

const M = defineMessages("image.presetLibrary", {
  blackWhite: "Black, White",
  spectrum: "Spectrum",
  transparentFade: "Black to transparent",
  untitled: "Preset {n}",
});

// ── the generic edits ────────────────────────────────────────────────

/** A fresh id for a new entry of `list` (`<prefix>-<n>`). */
export function freshId(prefix: string, list: readonly PresetEntry[]): string {
  let n = list.length + 1;
  const taken = new Set(list.map((p) => p.id));
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/** The default name for the n-th preset. */
export function untitledPreset(n: number): string {
  return t(M.untitled, { n });
}

export function renameEntry<T extends PresetEntry>(
  list: readonly T[],
  id: string,
  name: string,
): readonly T[] {
  const trimmed = name.trim();
  const i = list.findIndex((p) => p.id === id);
  if (trimmed === "" || i < 0 || list[i].name === trimmed) return list;
  const out = [...list];
  out[i] = { ...list[i], name: trimmed };
  return out;
}

/** Delete by id; a built-in entry stays. */
export function deleteEntry<T extends PresetEntry>(
  list: readonly T[],
  id: string,
): readonly T[] {
  const i = list.findIndex((p) => p.id === id);
  if (i < 0 || list[i].builtIn) return list;
  return [...list.slice(0, i), ...list.slice(i + 1)];
}

/** Move the entry at `from` to `to`. */
export function moveEntry<T>(
  list: readonly T[],
  from: number,
  to: number,
): readonly T[] {
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

/** Append entries, giving each a fresh id. */
export function appendEntries<T extends PresetEntry>(
  list: readonly T[],
  prefix: string,
  add: readonly Omit<T, "id">[],
): readonly T[] {
  let out = [...list];
  for (const a of add) {
    out = [...out, { ...a, id: freshId(prefix, out) } as T];
  }
  return out;
}

// ── built-ins ────────────────────────────────────────────────────────

const stop = (at: number, rgb: [number, number, number]) => ({
  at,
  rgb,
  midpoint: 0.5,
});
const opaque = [
  { at: 0, opacity: 1, midpoint: 0.5 },
  { at: 1, opacity: 1, midpoint: 0.5 },
];

/** The gradients the bundle ships. */
export function builtInGradients(): GradientPreset[] {
  return [
    {
      id: "builtin-black-white",
      name: t(M.blackWhite),
      builtIn: true,
      gradient: {
        name: "Black, White",
        smoothness: 100,
        stops: [stop(0, [0, 0, 0]), stop(1, [255, 255, 255])],
        opacityStops: opaque,
      },
    },
    {
      id: "builtin-spectrum",
      name: t(M.spectrum),
      builtIn: true,
      gradient: {
        name: "Spectrum",
        smoothness: 100,
        stops: [
          stop(0, [255, 0, 0]),
          stop(1 / 6, [255, 255, 0]),
          stop(2 / 6, [0, 255, 0]),
          stop(3 / 6, [0, 255, 255]),
          stop(4 / 6, [0, 0, 255]),
          stop(5 / 6, [255, 0, 255]),
          stop(1, [255, 0, 0]),
        ],
        opacityStops: opaque,
      },
    },
    {
      id: "builtin-black-transparent",
      name: t(M.transparentFade),
      builtIn: true,
      gradient: {
        name: "Black to transparent",
        smoothness: 100,
        stops: [stop(0, [0, 0, 0]), stop(1, [0, 0, 0])],
        opacityStops: [
          { at: 0, opacity: 1, midpoint: 0.5 },
          { at: 1, opacity: 0, midpoint: 0.5 },
        ],
      },
    },
  ];
}

/** The two end colours of a gradient (the gradient tool draws foreground
 *  to background), as 0–1 RGBA. */
export function gradientEnds(g: GradientValue): {
  first: [number, number, number, number];
  last: [number, number, number, number];
} {
  const sorted = [...g.stops].sort((a, b) => a.at - b.at);
  const ops = [...g.opacityStops].sort((a, b) => a.at - b.at);
  const a = sorted[0]?.rgb ?? [0, 0, 0];
  const b = sorted.at(-1)?.rgb ?? [255, 255, 255];
  const oa = ops[0]?.opacity ?? 1;
  const ob = ops.at(-1)?.opacity ?? 1;
  return {
    first: [a[0] / 255, a[1] / 255, a[2] / 255, oa],
    last: [b[0] / 255, b[1] / 255, b[2] / 255, ob],
  };
}

// ── adjustment params as JSON ────────────────────────────────────────

/** An `AdjustParams` as plain JSON (its curve tables as number lists). */
export function adjustToJson(p: AdjustParams): unknown {
  return {
    ...p,
    curveLut: p.curveLut ? Array.from(p.curveLut) : null,
    curveLutRgb: p.curveLutRgb.map((c) => (c ? Array.from(c) : null)),
  };
}

const table = (v: unknown): Uint8Array | null =>
  Array.isArray(v) && v.length === 256 && v.every((x) => Number.isInteger(x))
    ? Uint8Array.from(v as number[])
    : null;

/** Back from {@link adjustToJson}: known keys over the identity chain, so
 *  a preset written by an older bundle still loads (its missing stages
 *  stay at identity) and an unknown key is ignored. */
export function adjustFromJson(v: unknown): AdjustParams {
  const out = freshIdentityParams();
  if (!v || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(out) as (keyof AdjustParams)[]) {
    if (!(k in o)) continue;
    if (k === "curveLut") out.curveLut = table(o.curveLut);
    else if (k === "curveLutRgb") {
      const rgb = Array.isArray(o.curveLutRgb) ? o.curveLutRgb : [];
      out.curveLutRgb = [table(rgb[0]), table(rgb[1]), table(rgb[2])];
    } else if (typeof o[k] === typeof out[k] || o[k] === null) {
      (out as unknown as Record<string, unknown>)[k] = structuredClone(o[k]);
    }
  }
  return out;
}

// ── the own format (tool and adjustment presets) ─────────────────────

export const LIBRARY_FORMAT = "paged-presets";
export const LIBRARY_FORMAT_VERSION = 1;

/** A refusal of the own format, named. */
export class LibraryFormatError extends Error {}

/** Tool or adjustment presets as the own format. */
export function serializeLibrary(
  kind: "tools" | "adjustments",
  list: readonly (ToolPreset | AdjustmentPreset)[],
): string {
  const presets = list.map((p) =>
    kind === "adjustments"
      ? { name: p.name, params: adjustToJson((p as AdjustmentPreset).params) }
      : {
          name: p.name,
          brush: (p as ToolPreset).brush,
          dynamics: (p as ToolPreset).dynamics,
          paintTools: (p as ToolPreset).paintTools,
        },
  );
  return JSON.stringify(
    {
      format: LIBRARY_FORMAT,
      version: LIBRARY_FORMAT_VERSION,
      kind,
      presets,
    },
    null,
    1,
  );
}

/** Read the own format; refuses a wrong format, version or kind, and an
 *  entry without a name. */
export function parseLibrary(
  text: string,
  kind: "tools" | "adjustments",
): Array<Omit<ToolPreset, "id"> | Omit<AdjustmentPreset, "id">> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new LibraryFormatError("not JSON");
  }
  const o = v as Record<string, unknown> | null;
  if (!o || o.format !== LIBRARY_FORMAT)
    throw new LibraryFormatError(`not a ${LIBRARY_FORMAT} file`);
  if (o.version !== LIBRARY_FORMAT_VERSION)
    throw new LibraryFormatError(`version ${String(o.version)}`);
  if (o.kind !== kind)
    throw new LibraryFormatError(`holds ${String(o.kind)}, not ${kind}`);
  if (!Array.isArray(o.presets)) throw new LibraryFormatError("no presets");
  return o.presets.map((raw, i) => {
    const e = raw as Record<string, unknown>;
    if (typeof e?.name !== "string" || e.name.trim() === "")
      throw new LibraryFormatError(`presets[${i}] has no name`);
    if (kind === "adjustments")
      return { name: e.name, params: adjustFromJson(e.params) };
    const b = (e.brush ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number) =>
      typeof b[k] === "number" && Number.isFinite(b[k]) ? (b[k] as number) : d;
    return {
      name: e.name,
      brush: {
        size: num("size", 24),
        hardness: num("hardness", 0.5),
        opacity: num("opacity", 1),
        flow: num("flow", 1),
        spacing: num("spacing", 0.25),
        blend: typeof b.blend === "string" ? b.blend : "normal",
      },
      dynamics: (e.dynamics as BrushDynamics | null) ?? null,
      paintTools: (e.paintTools as PaintToolOptions | null) ?? null,
    };
  });
}

// ── the stored form ──────────────────────────────────────────────────

/** Patterns as stored: metadata as JSON, the pixels as one buffer. */
export function packPatterns(list: readonly PatternPreset[]): {
  meta: Array<Omit<PatternPreset, "rgba">>;
  rgba: Uint8Array;
} {
  const total = list.reduce((n, p) => n + p.rgba.length, 0);
  const rgba = new Uint8Array(total);
  let at = 0;
  for (const p of list) {
    rgba.set(p.rgba, at);
    at += p.rgba.length;
  }
  return {
    meta: list.map(({ rgba: _px, ...m }) => m),
    rgba,
  };
}

/** Back from {@link packPatterns}; null when the two disagree. */
export function unpackPatterns(
  meta: unknown,
  rgba: Uint8Array,
): PatternPreset[] | null {
  if (!Array.isArray(meta)) return null;
  const out: PatternPreset[] = [];
  let at = 0;
  for (const m of meta as Array<Partial<PatternPreset>>) {
    const w = m.width ?? 0;
    const h = m.height ?? 0;
    if (
      typeof m.id !== "string" ||
      typeof m.name !== "string" ||
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w <= 0 ||
      h <= 0
    )
      return null;
    const n = w * h * 4;
    if (at + n > rgba.length) return null;
    out.push({
      id: m.id,
      name: m.name,
      psId: typeof m.psId === "string" ? m.psId : "",
      width: w,
      height: h,
      builtIn: m.builtIn,
      rgba: rgba.slice(at, at + n),
    });
    at += n;
  }
  return at === rgba.length ? out : null;
}
