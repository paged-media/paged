// Where the image context's PRESETS and HISTORY OPTIONS live between
// sessions (image ADR 477). Before this, every library the Preset Manager
// shows was session-only: a reload lost the defined brushes and the saved
// styles (WP5.4 said so).
//
// The bundle's own namespaced key-value store (`host.storage`, the
// editor's per-user localStorage, `paged.plugin.<id>.*`) keeps the small
// kinds as JSON. The two kinds that carry pixels — brushes (sampled tips)
// and patterns — go to the bundle's binary store (`host.blob`, OPFS) when
// the host has one, so a library of large tips does not crowd the shared
// key-value quota; without one they fall back to the key-value store up
// to a size bound, and past it are kept for the session only, which
// `saveAll` reports instead of failing quietly.

import type { BundleHost } from "@paged-media/plugin-api";
import { base64ToBytes, bytesToBase64 } from "@paged-media/helpers";

import {
  deserializePresets,
  serializePresets,
  type UserBrushPreset,
} from "./brush-presets";
import type { StylePreset } from "./layer-style";
import {
  adjustFromJson,
  adjustToJson,
  packPatterns,
  unpackPatterns,
  type AdjustmentPreset,
  type GradientPreset,
  type PatternPreset,
  type ToolPreset,
} from "./preset-library";

/** The History Options preference (Photoshop's History Options dialog). */
export interface HistoryPrefs {
  /** Undo steps the journal keeps (1–1000). */
  depth: number;
  /** The journal's memory budget, MiB (16–2048). */
  memoryMb: number;
  /** Take a snapshot named after the image when it opens. */
  autoSnapshot: boolean;
}

/** The engine's own bounds (`image_graph::journal`): what applies until a
 *  preference is stored. */
export const DEFAULT_HISTORY_PREFS: HistoryPrefs = {
  depth: 32,
  memoryMb: 256,
  autoSnapshot: true,
};

export const HISTORY_DEPTH_RANGE = [1, 1000] as const;
export const HISTORY_MEMORY_RANGE = [16, 2048] as const;

/** Clamp a preference to what the engine accepts. */
export function clampHistoryPrefs(p: Partial<HistoryPrefs>): HistoryPrefs {
  const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(hi, Math.max(lo, Math.round(v)))
      : d;
  return {
    depth: clamp(p.depth, HISTORY_DEPTH_RANGE, DEFAULT_HISTORY_PREFS.depth),
    memoryMb: clamp(
      p.memoryMb,
      HISTORY_MEMORY_RANGE,
      DEFAULT_HISTORY_PREFS.memoryMb,
    ),
    autoSnapshot:
      typeof p.autoSnapshot === "boolean"
        ? p.autoSnapshot
        : DEFAULT_HISTORY_PREFS.autoSnapshot,
  };
}

/** Every library, as far as one is stored (absent = never saved). */
export interface StoredPresets {
  brushes?: UserBrushPreset[];
  tools?: ToolPreset[];
  adjustments?: AdjustmentPreset[];
  gradients?: GradientPreset[];
  patterns?: PatternPreset[];
  styles?: StylePreset[];
}

const KEY = {
  history: "history.prefs",
  tools: "presets.v1.tools",
  adjustments: "presets.v1.adjustments",
  gradients: "presets.v1.gradients",
  styles: "presets.v1.styles",
  brushesKv: "presets.v1.brushes",
  patternsMeta: "presets.v1.patterns",
  patternsKv: "presets.v1.patternPixels",
} as const;

const BLOB = {
  brushes: "presets/brushes.json",
  patterns: "presets/patterns.rgba",
} as const;

/** The most a pixel-carrying library may take in the key-value store
 *  when there is no binary store (base64 text, so ~4/3 of the bytes). */
export const KV_PIXEL_LIMIT = 1024 * 1024;

type Host = Pick<BundleHost, "storage" | "blob" | "supports" | "log">;

const hasBlob = (host: Host) => host.supports("storage.blob@1");

/** The stored History Options, or null when none were ever saved. */
export function loadHistoryPrefs(host: Host): HistoryPrefs | null {
  try {
    const v = host.storage.get<Partial<HistoryPrefs>>(KEY.history);
    return v ? clampHistoryPrefs(v) : null;
  } catch {
    return null;
  }
}

export function saveHistoryPrefs(host: Host, p: HistoryPrefs): void {
  try {
    host.storage.set(KEY.history, clampHistoryPrefs(p));
  } catch (err) {
    host.log.warn(`image: history options not saved: ${String(err)}`);
  }
}

const textOf = (b: Uint8Array) => new TextDecoder().decode(b);

/** Read every stored library. A library that does not read back (an
 *  older or damaged entry) is left out and logged; the defaults stand
 *  in for it. */
export async function loadPresets(host: Host): Promise<StoredPresets> {
  const out: StoredPresets = {};
  const kv = <T>(key: string): T | undefined => {
    try {
      return host.storage.get<T>(key);
    } catch {
      return undefined;
    }
  };
  const tools = kv<ToolPreset[]>(KEY.tools);
  if (Array.isArray(tools)) out.tools = tools;
  const adjustments = kv<Array<{ id: string; name: string; params: unknown }>>(
    KEY.adjustments,
  );
  if (Array.isArray(adjustments))
    out.adjustments = adjustments.map((a) => ({
      id: a.id,
      name: a.name,
      params: adjustFromJson(a.params),
    }));
  const gradients = kv<GradientPreset[]>(KEY.gradients);
  if (Array.isArray(gradients)) out.gradients = gradients;
  const styles = kv<StylePreset[]>(KEY.styles);
  if (Array.isArray(styles)) out.styles = styles;

  // Brushes: the blob, else the key-value fallback.
  try {
    const bytes = hasBlob(host) ? await host.blob.read(BLOB.brushes) : null;
    const text = bytes ? textOf(bytes) : kv<string>(KEY.brushesKv);
    if (typeof text === "string") out.brushes = deserializePresets(text);
  } catch (err) {
    host.log.warn(`image: stored brush presets did not read: ${String(err)}`);
  }
  // Patterns: metadata in the key-value store, pixels beside it.
  try {
    const meta = kv<unknown>(KEY.patternsMeta);
    if (meta !== undefined) {
      const fromBlob = hasBlob(host)
        ? await host.blob.read(BLOB.patterns)
        : null;
      const kvPixels = kv<string>(KEY.patternsKv);
      const rgba =
        fromBlob ??
        (typeof kvPixels === "string"
          ? base64ToBytes(kvPixels)
          : new Uint8Array(0));
      const list = unpackPatterns(meta, rgba);
      if (list) out.patterns = list;
      else host.log.warn("image: stored patterns did not match their pixels");
    }
  } catch (err) {
    host.log.warn(`image: stored patterns did not read: ${String(err)}`);
  }
  return out;
}

/** What a save could not keep beyond the session. */
export type SaveShortfall = "brushes" | "patterns";

/** Store one library. Answers the kind that stays session-only (no
 *  binary store and too large for the key-value one), else null. */
export async function savePresets(
  host: Host,
  kind: keyof StoredPresets,
  lists: Required<StoredPresets>,
): Promise<SaveShortfall | null> {
  try {
    switch (kind) {
      case "tools":
        host.storage.set(KEY.tools, lists.tools);
        return null;
      case "adjustments":
        host.storage.set(
          KEY.adjustments,
          lists.adjustments.map((a) => ({
            id: a.id,
            name: a.name,
            params: adjustToJson(a.params),
          })),
        );
        return null;
      case "gradients":
        host.storage.set(KEY.gradients, lists.gradients);
        return null;
      case "styles":
        host.storage.set(KEY.styles, lists.styles);
        return null;
      case "brushes": {
        const text = serializePresets(lists.brushes);
        if (hasBlob(host)) {
          await host.blob.write(BLOB.brushes, new TextEncoder().encode(text));
          host.storage.delete(KEY.brushesKv);
          return null;
        }
        if (text.length > KV_PIXEL_LIMIT) return "brushes";
        host.storage.set(KEY.brushesKv, text);
        return null;
      }
      case "patterns": {
        const { meta, rgba } = packPatterns(lists.patterns);
        if (hasBlob(host)) {
          await host.blob.write(BLOB.patterns, rgba);
          host.storage.delete(KEY.patternsKv);
          host.storage.set(KEY.patternsMeta, meta);
          return null;
        }
        if (rgba.length > (KV_PIXEL_LIMIT * 3) / 4) return "patterns";
        host.storage.set(KEY.patternsKv, bytesToBase64(rgba));
        host.storage.set(KEY.patternsMeta, meta);
        return null;
      }
    }
  } catch (err) {
    host.log.warn(`image: ${kind} presets not saved: ${String(err)}`);
    return kind === "brushes" || kind === "patterns" ? kind : null;
  }
  return null;
}
