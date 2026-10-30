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

// Editor ADR 288 — the Asset Export panel (`paged.object-export`):
// Illustrator's Asset Export, over the engine's own export doors.
//
//   - ASSETS: page items, artboards and pages, collected by "Add
//     selection" (one asset each, or all as one), "Add pages", or by
//     dragging rows
//     of the Layers panel onto the list. Each row is a file name stem the
//     user can edit; rows are selected for "Export selected".
//   - EXPORT SETTINGS: one row per output — a scale (0.5x … 4x or a
//     custom value), a file-name suffix and a format (PNG, JPEG, WebP,
//     TIFF, SVG, PDF). JPEG's quality, a transparent ground for pages,
//     and one ZIP for several files.
//   - EXPORT selected rows or all of them.
//
// The panel holds no state of its own beyond the progress line: the
// assets and settings live in the scoped store the commands share.

import { useState, useSyncExternalStore } from "react";

import type { ElementId } from "@paged-media/client";
import {
  PanelToolbar,
  ToolbarBtn,
  usePaged,
  useScoped,
} from "@paged-media/shell";
import { KitSelect, NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  collectItems,
  collectPages,
  collectSelection,
  problemLines,
  runAssetExport,
  type AssetExportRun,
} from "../asset-export/commands";
import {
  ASSET_EXPORT,
  ASSET_FORMATS,
  PAGED_ELEMENTS_MIME,
  RASTER_FORMATS,
  SCALE_PRESETS,
  addSetting,
  clampScale,
  formatScale,
  patchSetting,
  planFiles,
  removeAssets,
  removeSetting,
  renameAsset,
  type AssetExportState,
  type AssetFormat,
  type AssetKind,
  type ExportSetting,
} from "../asset-export/model";

const M = defineMessages("app.assetExportPanel", {
  assets: "Assets",
  addSelection: "Add selection (one asset per object)",
  addSelectionSingle: "Add selection as one asset",
  addPages: "Add all artboards and pages",
  remove: "Remove selected assets",
  empty:
    "No assets yet. Add the selection or the pages, or drag objects from the Layers panel here.",
  dropHere: "Drop to collect for export",
  object: "Object",
  artboard: "Artboard",
  page: "Page",
  fileName: "File name",
  settings: "Export settings",
  scale: "Scale",
  custom: "Custom",
  customScale: "Custom scale",
  suffix: "Suffix",
  format: "Format",
  addScale: "Add scale",
  removeScale: "Remove this setting",
  quality: "JPEG quality",
  transparent: "Transparent background for pages and artboards",
  zip: "One ZIP for several files",
  files: "{count, plural, one {# file} other {# files}}",
  exportSelected: "Export selected",
  exportAll: "Export all",
  exporting: "Exporting {done} of {total}…",
  vectorNote: "SVG and PDF ignore the scale.",
});

const FORMAT_LABEL: Record<AssetFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
  tiff: "TIFF",
  gif: "GIF",
  bmp: "BMP",
  tga: "TGA",
  jxl: "JPEG XL",
  svg: "SVG",
  pdf: "PDF",
};

/** The panel's view of the store. */
function useAssetExport() {
  const store = useScoped(ASSET_EXPORT);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const update = (fn: (s: AssetExportState) => AssetExportState) =>
    store.set(fn(store.get()));
  return { store, state, update };
}

/** The ids a Layers-panel drag carries, or null for another drag. */
function draggedIds(data: DataTransfer | null): ElementId[] | null {
  const raw = data?.getData(PAGED_ELEMENTS_MIME);
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) && ids.length > 0 ? (ids as ElementId[]) : null;
  } catch {
    return null;
  }
}

export function AssetExportPanel() {
  const strings = useStrings();
  const paged = usePaged();
  const { state, update } = useAssetExport();
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [last, setLast] = useState<AssetExportRun | null>(null);
  const [dropping, setDropping] = useState(false);

  const hasDocument = (paged.document.handle?.pageCount ?? 0) > 0;
  const selectedSet = new Set(state.selected);
  const chosen = state.assets.filter((a) => selectedSet.has(a.id));
  const busy = progress !== null;

  const run = async (all: boolean) => {
    setProgress({ done: 0, total: 0 });
    try {
      const result = await runAssetExport(
        paged,
        { onProgress: (done, total) => setProgress({ done, total }) },
        all ? undefined : chosen,
      );
      setLast(result);
    } finally {
      setProgress(null);
    }
  };

  const toggle = (id: string, extend: boolean) =>
    update((s) => {
      const on = s.selected.includes(id);
      if (!extend) return { ...s, selected: on ? [] : [id] };
      return {
        ...s,
        selected: on ? s.selected.filter((x) => x !== id) : [...s.selected, id],
      };
    });

  const kindLabel = (kind: AssetKind) =>
    strings.t(
      kind === "object" ? M.object : kind === "artboard" ? M.artboard : M.page,
    );

  const exportCount = (list: typeof state.assets) =>
    planFiles(list, state.settings).length;

  const usesJpeg = state.settings.some((s) => s.format === "jpeg");

  return (
    <div data-asset-export-panel="ready" className="flex flex-col">
      <PanelToolbar>
        <ToolbarBtn
          icon="ui-plus"
          testId="asset-export-add-selection"
          label={strings.t(M.addSelection)}
          disabled={
            !hasDocument || paged.selection.elementSelection.length === 0
          }
          onClick={() => void collectSelection(paged, false)}
        />
        <ToolbarBtn
          icon="ui-component"
          testId="asset-export-add-selection-single"
          label={strings.t(M.addSelectionSingle)}
          disabled={
            !hasDocument || paged.selection.elementSelection.length === 0
          }
          onClick={() => void collectSelection(paged, true)}
        />
        <ToolbarBtn
          icon="ui-page"
          testId="asset-export-add-pages"
          label={strings.t(M.addPages)}
          disabled={!hasDocument}
          onClick={() => void collectPages(paged)}
        />
        <ToolbarBtn
          icon="ui-minus"
          testId="asset-export-remove"
          label={strings.t(M.remove)}
          disabled={chosen.length === 0}
          onClick={() => update((s) => removeAssets(s, s.selected))}
        />
      </PanelToolbar>
      <section
        aria-label={strings.t(M.assets)}
        data-asset-list
        data-drop-active={dropping ? "true" : undefined}
        className="mx-[10px] my-2 min-h-[64px] rounded-[7px] border border-dashed border-input"
        style={{
          background: dropping ? "var(--hover)" : undefined,
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes(PAGED_ELEMENTS_MIME)) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          const ids = draggedIds(e.dataTransfer);
          if (!ids) return;
          e.preventDefault();
          void collectItems(paged, ids, false);
        }}
      >
        {state.assets.length === 0 ? (
          <div className="p-3 pg-ui-xs text-muted-foreground" data-asset-empty>
            {strings.t(dropping ? M.dropHere : M.empty)}
          </div>
        ) : (
          <div role="listbox" aria-multiselectable="true">
            {state.assets.map((a) => (
              <div
                key={a.id}
                role="option"
                aria-selected={selectedSet.has(a.id)}
                data-asset-row={a.id}
                data-asset-kind={a.kind}
                data-selected={selectedSet.has(a.id) ? "true" : undefined}
                className="flex h-[28px] items-center gap-2 px-2 hover:bg-muted/60 data-[selected]:bg-muted"
                onClick={(e) =>
                  toggle(a.id, e.shiftKey || e.metaKey || e.ctrlKey)
                }
              >
                <span
                  className="w-[52px] shrink-0 pg-ui-xs text-muted-foreground"
                  data-asset-kind-label
                  title={kindLabel(a.kind)}
                >
                  {kindLabel(a.kind)}
                </span>
                <input
                  key={`${a.id}:${a.name}`}
                  data-asset-name={a.id}
                  aria-label={strings.t(M.fileName)}
                  className="h-[22px] min-w-0 flex-1 rounded-[5px] border border-transparent bg-transparent px-1 pg-ui-xs hover:border-input focus:border-input"
                  defaultValue={a.name}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => {
                    const next = e.currentTarget.value;
                    if (next.trim() && next.trim() !== a.name) {
                      update((s) => renameAsset(s, a.id, next));
                    } else {
                      e.currentTarget.value = a.name;
                    }
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </section>
      <section
        className="flex flex-col gap-2 px-[14px] py-2"
        aria-label={strings.t(M.settings)}
        data-asset-settings
      >
        <div className="pg-ui-xs font-medium">{strings.t(M.settings)}</div>
        {state.settings.map((s) => (
          <SettingRow
            key={s.id}
            setting={s}
            canRemove={state.settings.length > 1}
            onPatch={(patch) => update((st) => patchSetting(st, s.id, patch))}
            onRemove={() => update((st) => removeSetting(st, s.id))}
          />
        ))}
        <button
          type="button"
          data-asset-add-scale
          className="h-[26px] rounded-[6px] border border-input bg-background hover:bg-muted/60 pg-ui-xs"
          onClick={() => update(addSetting)}
        >
          {strings.t(M.addScale)}
        </button>
        {state.settings.some((s) => !RASTER_FORMATS.has(s.format)) ? (
          <div
            className="pg-ui-xs text-muted-foreground"
            data-asset-vector-note
          >
            {strings.t(M.vectorNote)}
          </div>
        ) : null}
        {usesJpeg ? (
          <div className="flex items-center gap-2 pg-ui-xs">
            <span className="w-24">{strings.t(M.quality)}</span>
            <span className="flex-1" data-asset-quality>
              <NumberInput
                aria-label={strings.t(M.quality)}
                value={state.quality}
                min={1}
                max={100}
                precision={0}
                onChange={(v) =>
                  update((st) => ({
                    ...st,
                    quality: Math.min(100, Math.max(1, Math.round(v))),
                  }))
                }
              />
            </span>
          </div>
        ) : null}
        <label className="flex items-center gap-2 pg-ui-xs">
          <input
            type="checkbox"
            data-asset-transparent
            checked={state.transparentPages}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              update((st) => ({ ...st, transparentPages: on }));
            }}
          />
          {strings.t(M.transparent)}
        </label>
        <label className="flex items-center gap-2 pg-ui-xs">
          <input
            type="checkbox"
            data-asset-zip
            checked={state.zip}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              update((st) => ({ ...st, zip: on }));
            }}
          />
          {strings.t(M.zip)}
        </label>
      </section>
      <section className="flex flex-col gap-2 px-[14px] pb-3">
        <div className="flex gap-2">
          <button
            type="button"
            data-asset-export-selected
            disabled={busy || chosen.length === 0}
            className="h-[28px] flex-1 rounded-[6px] border border-input bg-background hover:bg-muted/60 pg-ui-xs disabled:opacity-50"
            onClick={() => void run(false)}
          >
            {strings.t(M.exportSelected)}
            {chosen.length > 0
              ? ` (${strings.t(M.files, { count: exportCount(chosen) })})`
              : ""}
          </button>
          <button
            type="button"
            data-asset-export-all
            disabled={busy || state.assets.length === 0}
            className="h-[28px] flex-1 rounded-[6px] border border-input bg-background hover:bg-muted/60 pg-ui-xs disabled:opacity-50"
            onClick={() => void run(true)}
          >
            {strings.t(M.exportAll)}
            {state.assets.length > 0
              ? ` (${strings.t(M.files, { count: exportCount(state.assets) })})`
              : ""}
          </button>
        </div>
        {progress ? (
          <div className="pg-ui-xs text-muted-foreground" data-asset-progress>
            {strings.t(M.exporting, progress)}
          </div>
        ) : last ? (
          <div className="pg-ui-xs" data-asset-status>
            <div data-asset-status-message>{last.message}</div>
            {problemLines(last).map((line) => (
              <div
                key={line}
                className="text-muted-foreground"
                data-asset-problem
              >
                {line}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SettingRow({
  setting,
  canRemove,
  onPatch,
  onRemove,
}: {
  setting: ExportSetting;
  canRemove: boolean;
  onPatch: (patch: Partial<Omit<ExportSetting, "id">>) => void;
  onRemove: () => void;
}) {
  const strings = useStrings();
  const preset = SCALE_PRESETS.includes(setting.scale)
    ? String(setting.scale)
    : "custom";
  const vector = !RASTER_FORMATS.has(setting.format);
  return (
    <div
      className="flex items-center gap-1 pg-ui-xs"
      data-asset-setting={setting.id}
    >
      <span className="w-[72px] shrink-0" data-asset-scale>
        <KitSelect
          aria-label={strings.t(M.scale)}
          value={preset}
          disabled={vector}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "custom") return;
            onPatch({ scale: Number(v) });
          }}
        >
          {SCALE_PRESETS.map((p) => (
            <option key={p} value={String(p)}>
              {`${formatScale(p)}x`}
            </option>
          ))}
          <option value="custom">{strings.t(M.custom)}</option>
        </KitSelect>
      </span>
      {preset === "custom" ? (
        <span className="w-[56px] shrink-0" data-asset-custom-scale>
          <NumberInput
            aria-label={strings.t(M.customScale)}
            value={setting.scale}
            min={0.1}
            max={33}
            precision={2}
            onChange={(v) => {
              const scale = clampScale(v);
              if (scale !== null) onPatch({ scale });
            }}
          />
        </span>
      ) : null}
      <input
        data-asset-suffix
        aria-label={strings.t(M.suffix)}
        placeholder={strings.t(M.suffix)}
        className="h-[30px] min-w-0 flex-1 rounded-[6px] border border-input bg-background px-2"
        value={setting.suffix}
        onChange={(e) => onPatch({ suffix: e.currentTarget.value })}
      />
      <span className="w-[72px] shrink-0" data-asset-format>
        <KitSelect
          aria-label={strings.t(M.format)}
          value={setting.format}
          onChange={(e) => onPatch({ format: e.target.value as AssetFormat })}
        >
          {ASSET_FORMATS.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABEL[f]}
            </option>
          ))}
        </KitSelect>
      </span>
      <button
        type="button"
        data-asset-remove-scale
        aria-label={strings.t(M.removeScale)}
        title={strings.t(M.removeScale)}
        disabled={!canRemove}
        className="h-[26px] w-[26px] shrink-0 rounded-[6px] hover:bg-muted/60 disabled:opacity-40"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
