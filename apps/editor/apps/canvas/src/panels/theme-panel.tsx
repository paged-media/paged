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

// Theme (engine ADR 1056, 1057): the document's theme, in any module that is
// not slide (slide has its own Design panel). The twelve colour slots and the
// two font sets edit through `setThemeColor` / `setThemeFonts` (each one named
// undo step, and the swatches that follow a slot recolour in the same step), a
// preset or a stored theme applies through `setTheme`, and a document with no
// theme (every IDML from InDesign) can make one from its swatches
// (`createThemeFromSwatches`). The panel uses engine operations only.

import { useState } from "react";

import { useCanvasClient, useCollection } from "@paged-media/shell";
import type { SwatchSummary } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.themePanel", {
  noTheme: "This document has no theme.",
  name: "Theme",
  colours: "Colours",
  fonts: "Fonts",
  major: "Headings",
  minor: "Body",
  presets: "Presets",
  apply: "Apply",
  fromSwatches: "Create theme from swatches",
  fromSwatchesHint:
    "Name the swatch each slot takes its colour from. Plain RGB swatches only.",
  none: "(none)",
  relink: "Link matching tints",
  proposeSwatches: "Use the first swatches",
  create: "Create theme",
  failed: "Not applied: {error}",
  slotDk1: "Dark 1",
  slotLt1: "Light 1",
  slotDk2: "Dark 2",
  slotLt2: "Light 2",
  slotAccent1: "Accent 1",
  slotAccent2: "Accent 2",
  slotAccent3: "Accent 3",
  slotAccent4: "Accent 4",
  slotAccent5: "Accent 5",
  slotAccent6: "Accent 6",
  slotHlink: "Hyperlink",
  slotFolHlink: "Followed hyperlink",
});

/** The twelve slots in the order a theme writes them, with their words. */
export const THEME_SLOT_LABELS = [
  ["dk1", M.slotDk1],
  ["lt1", M.slotLt1],
  ["dk2", M.slotDk2],
  ["lt2", M.slotLt2],
  ["accent1", M.slotAccent1],
  ["accent2", M.slotAccent2],
  ["accent3", M.slotAccent3],
  ["accent4", M.slotAccent4],
  ["accent5", M.slotAccent5],
  ["accent6", M.slotAccent6],
  ["hlink", M.slotHlink],
  ["folHlink", M.slotFolHlink],
] as const;

/** The `theme` collection's row (the engine's `Theme`, `source` as a size). */
export interface ThemeRow {
  name: string;
  colorSchemeName?: string | null;
  colors: { slot: string; value: string; system?: string | null }[];
  fontSchemeName?: string | null;
  major: ThemeFontsRow;
  minor: ThemeFontsRow;
}
export interface ThemeFontsRow {
  latin?: string | null;
  eastAsian?: string | null;
  complex?: string | null;
  scripts?: [string, string][];
}
interface PresetRow {
  id: string;
  theme: ThemeRow;
}

/** A theme row as the `setTheme` / `setThemeFonts` wire shape. */
function fontsSpec(f: ThemeFontsRow) {
  return {
    latin: f.latin ?? null,
    eastAsian: f.eastAsian ?? null,
    complex: f.complex ?? null,
    scripts: (f.scripts ?? []).map(([script, typeface]) => ({
      script,
      typeface,
    })),
  };
}
export function themeSpec(t: ThemeRow) {
  return {
    name: t.name,
    colorSchemeName: t.colorSchemeName ?? null,
    colors: t.colors.map((c) => ({
      slot: c.slot,
      value: c.value,
      system: c.system ?? null,
    })),
    fontSchemeName: t.fontSchemeName ?? null,
    major: fontsSpec(t.major),
    minor: fontsSpec(t.minor),
  };
}

const colorOf = (t: ThemeRow, slot: string) =>
  t.colors.find((c) => c.slot === slot)?.value ?? "000000";

export function ThemePanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const theme = useCollection<ThemeRow>("theme");
  const presets = useCollection<PresetRow>("themePresets");
  const swatches = useCollection<SwatchSummary>("swatches");
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState("");
  const [relink, setRelink] = useState(true);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [name, setName] = useState("");

  const current = theme?.[0] ?? null;
  const run = (m: unknown) => {
    setError(null);
    client.mutate(m as never).catch((e: unknown) => {
      setError(strings.t(M.failed, { error: String(e) }));
    });
  };

  const applyPreset = () => {
    const p = (presets ?? []).find((r) => r.id === preset);
    if (p) run({ op: "setTheme", args: { theme: themeSpec(p.theme) } });
  };
  const setFont = (which: "major" | "minor", latin: string) => {
    if (!current) return;
    run({
      op: "setThemeFonts",
      args: { which, fonts: { ...fontsSpec(current[which]), latin } },
    });
  };
  const create = () => {
    const slots = Object.entries(picks)
      .filter(([, swatch]) => swatch !== "")
      .map(([slot, swatch]) => ({ slot, swatch }));
    run({
      op: "createThemeFromSwatches",
      args: { name, slots, relink },
    });
  };
  const propose = () => {
    const usable = (swatches ?? []).filter((s) => s.kind === "process");
    const next: Record<string, string> = {};
    THEME_SLOT_LABELS.forEach(([slot], i) => {
      const s = usable[i];
      if (s) next[slot] = s.selfId;
    });
    setPicks(next);
  };

  const presetPicker = (
    <div className="flex items-center gap-2" data-theme-section="presets">
      <select
        className="text-xs border border-input rounded px-1 py-0.5"
        data-action="preset"
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
      >
        <option value="">{strings.t(M.presets)}</option>
        {(presets ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.theme.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="text-xs border border-input rounded px-2 py-0.5"
        data-action="apply-preset"
        disabled={preset === ""}
        onClick={applyPreset}
      >
        {strings.t(M.apply)}
      </button>
    </div>
  );

  return (
    <div
      className="p-3 text-sm flex flex-col gap-3"
      data-theme-panel={theme === null ? "loading" : "ready"}
    >
      {presetPicker}
      {current ? (
        <>
          <div className="text-xs font-medium" data-theme-name="">
            {current.name}
          </div>
          <div data-theme-section="colours">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {strings.t(M.colours)}
            </div>
            <ul className="grid grid-cols-2 gap-1 text-xs">
              {THEME_SLOT_LABELS.map(([slot, label]) => (
                <li key={slot} className="flex items-center gap-2">
                  <input
                    type="color"
                    data-theme-slot={slot}
                    value={`#${colorOf(current, slot)}`}
                    onChange={(e) =>
                      run({
                        op: "setThemeColor",
                        args: { slot, value: e.target.value.slice(1) },
                      })
                    }
                  />
                  <span>{strings.t(label)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div data-theme-section="fonts" className="flex flex-col gap-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {strings.t(M.fonts)}
            </div>
            {(["major", "minor"] as const).map((which) => (
              <label key={which} className="flex items-center gap-2 text-xs">
                <span className="w-16">
                  {strings.t(which === "major" ? M.major : M.minor)}
                </span>
                <input
                  type="text"
                  className="border border-input rounded px-1 py-0.5 flex-1"
                  data-theme-font={which}
                  defaultValue={current[which].latin ?? ""}
                  key={`${which}:${current[which].latin ?? ""}`}
                  onBlur={(e) => {
                    if (e.target.value !== (current[which].latin ?? ""))
                      setFont(which, e.target.value);
                  }}
                />
              </label>
            ))}
          </div>
        </>
      ) : (
        <div data-theme-section="from-swatches" className="flex flex-col gap-2">
          <div className="text-xs text-muted-foreground" data-theme="none">
            {strings.t(M.noTheme)}
          </div>
          <div className="text-xs font-medium">{strings.t(M.fromSwatches)}</div>
          <div className="text-[11px] text-muted-foreground">
            {strings.t(M.fromSwatchesHint)}
          </div>
          <input
            type="text"
            className="text-xs border border-input rounded px-1 py-0.5"
            data-action="theme-name"
            placeholder={strings.t(M.name)}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <ul className="grid grid-cols-2 gap-1 text-xs">
            {THEME_SLOT_LABELS.map(([slot, label]) => (
              <li key={slot} className="flex items-center gap-1">
                <span className="w-16 truncate">{strings.t(label)}</span>
                <select
                  className="border border-input rounded px-1 py-0.5 flex-1 min-w-0"
                  data-pick-slot={slot}
                  value={picks[slot] ?? ""}
                  onChange={(e) =>
                    setPicks({ ...picks, [slot]: e.target.value })
                  }
                >
                  <option value="">{strings.t(M.none)}</option>
                  {(swatches ?? [])
                    .filter((s) => s.kind === "process")
                    .map((s) => (
                      <option key={s.selfId} value={s.selfId}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-action="relink"
              checked={relink}
              onChange={(e) => setRelink(e.target.checked)}
            />
            {strings.t(M.relink)}
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs border border-input rounded px-2 py-0.5"
              data-action="propose"
              onClick={propose}
            >
              {strings.t(M.proposeSwatches)}
            </button>
            <button
              type="button"
              className="text-xs border border-input rounded px-2 py-0.5"
              data-action="create-theme"
              onClick={create}
            >
              {strings.t(M.create)}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="text-xs text-red-600" role="alert" data-theme-error="">
          {error}
        </div>
      )}
    </div>
  );
}
