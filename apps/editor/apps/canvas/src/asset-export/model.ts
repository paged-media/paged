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

// Editor ADR 288 — Asset Export, the model: the assets collected for
// export (page items, artboards, pages), the export settings every asset
// is written with (a scale, a file-name suffix and a format per row), and
// the names of the files they make. Pure: the panel, the commands and the
// run read and write it through one scoped store, so an asset added by a
// command shows in the panel and the panel's settings drive a command.

import type { ElementId } from "@paged-media/client";
import {
  createValueStore,
  scoped,
  type EditorScope,
  type ValueStore,
} from "@paged-media/shell";

/** The drag payload a Layers-panel object row carries (its ids as JSON),
 *  which the Asset Export panel collects when it is dropped on it. */
export const PAGED_ELEMENTS_MIME = "application/x-paged-elements";

/** What an asset exports: one or more page items, or a whole page. A page
 *  with an artboard name (engine ADR 1011) is an artboard. */
export type AssetKind = "object" | "artboard" | "page";

export interface Asset {
  /** Stable within the editor session. */
  id: string;
  kind: AssetKind;
  /** The file-name stem (before the suffix and extension). */
  name: string;
  /** The page the asset is drawn from. */
  pageId: string;
  /** The page items of an object asset (empty for a page). */
  elementIds: ElementId[];
}

/** The formats an asset is written in. PNG, JPEG, WebP and TIFF are
 *  pixels, as are GIF, BMP, TGA and JPEG XL (engine ADR 1038), encoded
 *  by the engine (`paged-raster`); SVG (`paged-svg`) and
 *  PDF are vector and ignore the scale. */
export type AssetFormat =
  | "png"
  | "jpeg"
  | "webp"
  | "tiff"
  | "gif"
  | "bmp"
  | "tga"
  | "jxl"
  | "svg"
  | "pdf";

export const ASSET_FORMATS: readonly AssetFormat[] = [
  "png",
  "jpeg",
  "webp",
  "tiff",
  "gif",
  "bmp",
  "tga",
  "jxl",
  "svg",
  "pdf",
];

export const RASTER_FORMATS: ReadonlySet<AssetFormat> = new Set([
  "png",
  "jpeg",
  "webp",
  "tiff",
  "gif",
  "bmp",
  "tga",
  "jxl",
]);

export const EXTENSION: Record<AssetFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  tiff: "tif",
  gif: "gif",
  bmp: "bmp",
  tga: "tga",
  jxl: "jxl",
  svg: "svg",
  pdf: "pdf",
};

export const MIME: Record<AssetFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tiff: "image/tiff",
  gif: "image/gif",
  bmp: "image/bmp",
  tga: "image/x-tga",
  jxl: "image/jxl",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** One export setting: every asset is written once per row. */
export interface ExportSetting {
  id: string;
  /** 1 = 72 ppi (one pixel per point). */
  scale: number;
  /** Appended to the asset's name: `@2x`, `-large`, or nothing. */
  suffix: string;
  format: AssetFormat;
}

/** The scale presets (Illustrator's Export for Screens offers the same);
 *  any other value is a custom scale. */
export const SCALE_PRESETS: readonly number[] = [0.5, 1, 1.5, 2, 3, 4];

/** The smallest and largest scale: 7.2 ppi to 2400 ppi (the snapshot's
 *  resolution limit). */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 2400 / 72;

export interface AssetExportState {
  assets: Asset[];
  /** Ids of the rows selected in the panel ("Export selected"). */
  selected: string[];
  settings: ExportSetting[];
  /** JPEG quality, 1 to 100. */
  quality: number;
  /** Several files go out as one ZIP. */
  zip: boolean;
  /** Pages and artboards on a transparent ground instead of paper (JPEG,
   *  which has no alpha, is always on white). */
  transparentPages: boolean;
  /** The next id (assets and settings share the counter). */
  next: number;
}

export const INITIAL_ASSET_EXPORT: AssetExportState = {
  assets: [],
  selected: [],
  settings: [{ id: "s1", scale: 1, suffix: "", format: "png" }],
  quality: 90,
  zip: true,
  transparentPages: false,
  next: 2,
};

export const ASSET_EXPORT = scoped("assetExport", () =>
  createValueStore<AssetExportState>(INITIAL_ASSET_EXPORT),
);

export function assetExportStoreOf(
  scope: EditorScope,
): ValueStore<AssetExportState> {
  return scope.get(ASSET_EXPORT);
}

/** The suffix a scale suggests: nothing at 1x, `@2x` at 2x, `@0.5x` … */
export function defaultSuffix(scale: number): string {
  return scale === 1 ? "" : `@${formatScale(scale)}x`;
}

/** A scale as people write it: `2`, `1.5`, `0.75`. */
export function formatScale(scale: number): string {
  return String(Math.round(scale * 100) / 100);
}

/** A scale clamped into range, or null for one that is not a number. */
export function clampScale(scale: number): number | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

/** Add assets (an asset already collected — the same kind of the same
 *  items or page — is not added twice). Answers the state and the ids it
 *  added. */
export function addAssets(
  state: AssetExportState,
  drafts: ReadonlyArray<Omit<Asset, "id">>,
): { state: AssetExportState; added: string[] } {
  const keyOf = (a: Omit<Asset, "id">) =>
    a.elementIds.length > 0
      ? `items:${a.elementIds.map((e) => JSON.stringify(e)).join("|")}`
      : `page:${a.pageId}`;
  const have = new Set(state.assets.map(keyOf));
  let next = state.next;
  const added: Asset[] = [];
  for (const d of drafts) {
    const key = keyOf(d);
    if (have.has(key)) continue;
    have.add(key);
    added.push({ ...d, id: `a${next++}` });
  }
  return {
    state: { ...state, assets: [...state.assets, ...added], next },
    added: added.map((a) => a.id),
  };
}

export function removeAssets(
  state: AssetExportState,
  ids: readonly string[],
): AssetExportState {
  const drop = new Set(ids);
  return {
    ...state,
    assets: state.assets.filter((a) => !drop.has(a.id)),
    selected: state.selected.filter((id) => !drop.has(id)),
  };
}

export function renameAsset(
  state: AssetExportState,
  id: string,
  name: string,
): AssetExportState {
  const trimmed = name.trim();
  if (!trimmed) return state;
  return {
    ...state,
    assets: state.assets.map((a) =>
      a.id === id ? { ...a, name: trimmed } : a,
    ),
  };
}

/** Add a setting row: the next scale up from the largest, its suffix. */
export function addSetting(state: AssetExportState): AssetExportState {
  const top = Math.max(0, ...state.settings.map((s) => s.scale));
  const scale = SCALE_PRESETS.find((p) => p > top) ?? top + 1;
  const last = state.settings.at(-1);
  return {
    ...state,
    settings: [
      ...state.settings,
      {
        id: `s${state.next}`,
        scale,
        suffix: defaultSuffix(scale),
        format: last?.format ?? "png",
      },
    ],
    next: state.next + 1,
  };
}

/** Change a setting row. A new scale brings its suffix along when the
 *  row still had the old scale's own suffix. */
export function patchSetting(
  state: AssetExportState,
  id: string,
  patch: Partial<Omit<ExportSetting, "id">>,
): AssetExportState {
  return {
    ...state,
    settings: state.settings.map((s) => {
      if (s.id !== id) return s;
      const next = { ...s, ...patch };
      if (
        patch.scale !== undefined &&
        patch.suffix === undefined &&
        s.suffix === defaultSuffix(s.scale)
      ) {
        next.suffix = defaultSuffix(patch.scale);
      }
      return next;
    }),
  };
}

/** Remove a setting row; the last one stays. */
export function removeSetting(
  state: AssetExportState,
  id: string,
): AssetExportState {
  if (state.settings.length <= 1) return state;
  return { ...state, settings: state.settings.filter((s) => s.id !== id) };
}

/** Characters a file name must not carry (the Windows/macOS reserved set
 *  and the path separators); control characters go too. */
const RESERVED = '<>:"|?*/\\';

/** A file-name stem from an asset name: reserved characters become `-`,
 *  surrounding space and dots go. */
export function fileStem(name: string): string {
  const cleaned = [...name]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || RESERVED.includes(ch) ? "-" : ch;
    })
    .join("")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return cleaned || "asset";
}

/** One file an export writes. */
export interface PlannedFile {
  asset: Asset;
  setting: ExportSetting;
  fileName: string;
}

/** The files `assets` × `settings` make, each name unique (a clash gets
 *  ` 2`, ` 3` … before its suffix). A vector format ignores the scale, so
 *  two rows that differ only in scale make one vector file. */
export function planFiles(
  assets: readonly Asset[],
  settings: readonly ExportSetting[],
): PlannedFile[] {
  const out: PlannedFile[] = [];
  const taken = new Set<string>();
  for (const asset of assets) {
    const vector = new Set<string>();
    for (const setting of settings) {
      if (!RASTER_FORMATS.has(setting.format)) {
        const key = `${setting.format}:${setting.suffix}`;
        if (vector.has(key)) continue;
        vector.add(key);
      }
      const stem = fileStem(asset.name);
      const ext = EXTENSION[setting.format];
      let name = `${stem}${setting.suffix}.${ext}`;
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        name = `${stem} ${n}${setting.suffix}.${ext}`;
      }
      taken.add(name.toLowerCase());
      out.push({ asset, setting, fileName: name });
    }
  }
  return out;
}
