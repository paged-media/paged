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

// BRUSH PRESETS — the preset manager over the session's library
// (`brush-presets.ts`): apply, rename in place, delete, reorder, Define
// Brush Preset from the selection's pixels, Import (`.abr` or this
// bundle's own JSON) and Export (`.abr`, or the own JSON where `.abr`
// cannot carry what a preset holds).
//
// `BrushPresetsView` is PURE; `makeBrushPresetsPanel` connects it.

import { onDidChangeOf, useLive } from "@paged-media/react-live";
import { defineMessages, t, useStrings } from "@paged-media/strings";
import { space } from "@paged-media/panel-kit";

import type { UserBrushPreset } from "../brush-presets";
import { mono, note, panelTitle, row } from "./sections/styles";

export const BRUSH_PRESETS_PANEL_ID = "media.paged.image.panel.brushPresets";

/** The session members this panel reads and calls. */
export interface BrushPresetsSession {
  state(): {
    brushPresets: readonly UserBrushPreset[];
    brushPresetActive: string | null;
  };
  defineBrushPreset(name?: string): Promise<boolean>;
  applyUserPreset(id: string): boolean;
  renameBrushPreset(id: string, name: string): void;
  deleteBrushPreset(id: string): void;
  moveBrushPreset(from: number, to: number): void;
  importBrushPresets(): Promise<boolean>;
  exportBrushPresets(format: "abr" | "json"): Promise<boolean>;
  onDidChange(listener: () => void): { dispose(): void };
}

const M = defineMessages("image.brushPresetsPanel", {
  title: "Brush Presets",
  empty: "No presets. Define one from a selection, or import a library.",
  define: "Define from selection",
  defineTitle:
    "Define Brush Preset: the selection's pixels become a sampled tip (dark paints, light is clear).",
  import: "Import…",
  importTitle: "Import an .abr library or a paged brush preset file",
  exportAbr: "Export .abr",
  exportJson: "Export .json",
  exportJsonTitle:
    "The paged preset format keeps every setting, including those .abr cannot carry",
  rename: "Name of {name}",
  apply: "Use {name}",
  moveUp: "Move up",
  moveDown: "Move down",
  delete: "Delete",
  sampled: "sampled",
  summary: "{size} px",
});

/** A short line under a preset's name. */
function summary(p: UserBrushPreset): string {
  const size = t(M.summary, { size: Math.round(p.params.size) });
  return p.dynamics.bitmap ? `${size} · ${t(M.sampled)}` : size;
}

export interface BrushPresetsViewProps {
  presets: readonly UserBrushPreset[];
  active: string | null;
  disabled: boolean;
  onApply: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onDefine: () => void;
  onImport: () => void;
  onExport: (format: "abr" | "json") => void;
}

/** The preset manager, pure. A name field commits on Enter or blur; it
 *  is keyed on the name, so a rename refused by the library shows the
 *  old name again. */
export function BrushPresetsView(p: BrushPresetsViewProps) {
  const last = p.presets.length - 1;
  return (
    <div data-brush-presets>
      <h3 style={panelTitle}>{t(M.title)}</h3>
      <div style={{ display: "flex", gap: space[1], flexWrap: "wrap" }}>
        <button
          type="button"
          title={t(M.defineTitle)}
          disabled={p.disabled}
          data-brush-preset-define
          onClick={() => p.onDefine()}
        >
          {t(M.define)}
        </button>
        <button
          type="button"
          title={t(M.importTitle)}
          data-brush-preset-import
          onClick={() => p.onImport()}
        >
          {t(M.import)}
        </button>
        <button
          type="button"
          disabled={p.presets.length === 0}
          data-brush-preset-export="abr"
          onClick={() => p.onExport("abr")}
        >
          {t(M.exportAbr)}
        </button>
        <button
          type="button"
          title={t(M.exportJsonTitle)}
          disabled={p.presets.length === 0}
          data-brush-preset-export="json"
          onClick={() => p.onExport("json")}
        >
          {t(M.exportJson)}
        </button>
      </div>
      {p.presets.length === 0 ? (
        <div style={note} data-brush-presets-empty>
          {t(M.empty)}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {p.presets.map((preset, i) => {
            const active = preset.id === p.active;
            return (
              <li
                key={preset.id}
                style={{
                  ...row,
                  fontWeight: active ? 600 : 400,
                }}
                data-brush-preset-row={preset.id}
                data-brush-preset-active={active ? "" : undefined}
                aria-current={active ? "true" : undefined}
              >
                <button
                  type="button"
                  aria-label={t(M.apply, { name: preset.name })}
                  data-brush-preset-apply={preset.id}
                  onClick={() => p.onApply(preset.id)}
                  style={{ ...mono, minWidth: "4.5em" }}
                >
                  {summary(preset)}
                </button>
                <input
                  key={preset.name}
                  type="text"
                  defaultValue={preset.name}
                  aria-label={t(M.rename, { name: preset.name })}
                  data-brush-preset-name={preset.id}
                  style={{ flex: 1, minWidth: 0 }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => {
                    const name = e.currentTarget.value;
                    if (name !== preset.name) p.onRename(preset.id, name);
                  }}
                />
                <span style={{ display: "flex", gap: 2 }}>
                  <button
                    type="button"
                    title={t(M.moveUp)}
                    aria-label={t(M.moveUp)}
                    disabled={i === 0}
                    data-brush-preset-up={preset.id}
                    onClick={() => p.onMove(i, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title={t(M.moveDown)}
                    aria-label={t(M.moveDown)}
                    disabled={i === last}
                    data-brush-preset-down={preset.id}
                    onClick={() => p.onMove(i, i + 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title={t(M.delete)}
                    aria-label={t(M.delete)}
                    data-brush-preset-delete={preset.id}
                    onClick={() => p.onDelete(preset.id)}
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The connected panel. */
export function makeBrushPresetsPanel(session: BrushPresetsSession) {
  // A declaration, so the React Compiler sees the component.
  function BrushPresetsPanel() {
    const live = useLive(session, onDidChangeOf);
    useStrings();
    const s = live.state();
    return (
      <BrushPresetsView
        presets={s.brushPresets}
        active={s.brushPresetActive}
        disabled={false}
        onApply={(id) => session.applyUserPreset(id)}
        onRename={(id, name) => session.renameBrushPreset(id, name)}
        onDelete={(id) => session.deleteBrushPreset(id)}
        onMove={(from, to) => session.moveBrushPreset(from, to)}
        onDefine={() => void session.defineBrushPreset()}
        onImport={() => void session.importBrushPresets()}
        onExport={(format) => void session.exportBrushPresets(format)}
      />
    );
  }
  return BrushPresetsPanel;
}
