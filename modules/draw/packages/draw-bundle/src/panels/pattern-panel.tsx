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

// The PATTERN OPTIONS panel — the EDITING MODE the catalog row asks for,
// which is the only half of that row this engine can carry. Every knob
// here is a real `PatternParams` field the recipe persists, and the
// panel's Bake / Re-plan buttons drive the SAME appliers the commands do
// — no second write path to drift from.
//
// An expert-leaf REACT panel for the Layers / Appearance / Graphic
// Styles / Symbols / Live Paint reason (B-01): a list of records with
// per-row actions, plus an enum + numeric form, is above the v1 schema
// panel's scalar binding ceiling.
//
// The panel is ALSO where the hard boundary is put in front of the user,
// because the word "pattern" promises a swatch this engine has no paint
// type for. `PATTERN_SWATCH_NOTE` says so verbatim and its wording is
// pinned by a conformance test.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

import {
  applyDeletePatternTiles,
  applyEditPattern,
  applyMakePattern,
  applyReleasePattern,
  applySelectPatternTiles,
  patternLinks,
  readPatternLibrary,
  resolvePatternField,
  PATTERN_DEFAULTS,
  PATTERN_FEATURE,
  PATTERN_LEGACY_FIELD,
  PATTERN_SWATCH_NOTE,
  type PatternField,
  type PatternLayout,
  type PatternParams,
} from "../commands/pattern";

export const PATTERN_PANEL_ID = "media.paged.draw.panel.pattern";

/** What the panel says under the form, verbatim. Exported so the
 *  conformance spec pins the WORDING — an honesty note that can be
 *  edited away silently is not a guarantee. */
export const PATTERN_PANEL_NOTE =
  `${PATTERN_SWATCH_NOTE} Two more things this form cannot hide. The COPIES ` +
  "always paint ABOVE the source: an inserted item lands at the top of the " +
  "page's z-order and pattern v1 does not restack it, so \"in front\" can " +
  "only order the copies among themselves (and the vertical choice wins, " +
  "because rows are the outer loop). And DIMMING is a real frameOpacity " +
  "written on every copy — Illustrator dims copies only while its pattern " +
  "editor is open, and this engine has no such mode, so the value is what " +
  "the document keeps. Baking and re-planning are TWO undo steps each; " +
  "releasing and deleting the tiles are one; the recipe itself is a " +
  "container write and is not on the undo stack at all.";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: "12px var(--font-sans, sans-serif)",
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 3px",
  font: "12px var(--font-sans, sans-serif)",
  color: "var(--pg-fg, currentColor)",
};
const sectionStyle: React.CSSProperties = {
  font: "11px var(--font-sans, sans-serif)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.65,
  paddingTop: 8,
};
const noteStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "6px 8px",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.4))",
  borderRadius: 3,
  font: "11px/1.45 var(--font-sans, sans-serif)",
  opacity: 0.8,
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: "12px var(--font-sans, sans-serif)",
};
const inputStyle: React.CSSProperties = {
  width: 64,
  font: "12px var(--font-sans, sans-serif)",
};

/** The one-line summary a field row shows: its layout, its requested
 *  copy count and how many tiles are actually on the page. Pure —
 *  exported so the conformance spec pins the wording without a DOM. */
export function patternRowLabel(field: PatternField, placed: number): string {
  const requested = field.params.columns * field.params.rows - 1;
  return (
    `${field.params.layout} · ${field.params.columns} × ${field.params.rows} ` +
    `(${requested} cop${requested === 1 ? "y" : "ies"} requested, ${placed} placed)`
  );
}

const LAYOUTS: readonly PatternLayout[] = ["grid", "brick", "hex"];

export function makePatternPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [fields, setFields] = React.useState<PatternField[]>([]);
    const [active, setActive] = React.useState<string | null>(null);
    const [placed, setPlaced] = React.useState<Record<string, number>>({});
    const [hasSelection, setHasSelection] = React.useState(false);
    const [portable, setPortable] = React.useState(true);
    const [draft, setDraft] = React.useState<PatternParams>(PATTERN_DEFAULTS);

    const reload = React.useCallback(async () => {
      setPortable(host.supports(PATTERN_FEATURE));
      const library = await readPatternLibrary(host);
      setFields(library.fields);
      setHasSelection(host.selection.get().length > 0);
      const field = await resolvePatternField(host, undefined);
      setActive(field);
      const tally: Record<string, number> = {};
      const links = await patternLinks(host);
      for (const tile of links.tiles) {
        tally[tile.ref.pattern] = (tally[tile.ref.pattern] ?? 0) + 1;
      }
      setPlaced(tally);
      const saved = library.fields.find((f) => f.id === field);
      if (saved) setDraft(saved.params);
    }, []);

    React.useEffect(() => {
      void reload();
      const subs = [
        host.selection.onDidChange(() => void reload()),
        host.document.onDidChange(() => void reload()),
      ];
      return () => {
        for (const s of subs) s.dispose();
      };
    }, [reload]);

    const run = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (e) {
        host.log.warn(`pattern panel: ${String(e)}`);
      }
      void reload();
    };

    const numberRow = (
      label: string,
      value: number,
      onChange: (n: number) => void,
      attr: string,
      step = 1,
    ) => (
      <div style={rowStyle}>
        <span style={{ flex: 1 }}>{label}</span>
        <input
          type="number"
          step={step}
          style={inputStyle}
          data-draw-pattern-field={attr}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    );

    return (
      <div
        style={{ padding: 12 }}
        data-draw-pattern-panel={fields.length}
        data-draw-pattern-portable={portable ? "true" : "false"}
        data-draw-pattern-active={active ?? ""}
      >
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Pattern fields ({fields.length})
          </span>
          <button
            type="button"
            style={iconBtn}
            title="Bake the selection into a re-editable tile field — artwork, not a swatch"
            data-draw-pattern-make
            disabled={!hasSelection}
            onClick={() => void run(applyMakePattern(host, draft))}
          >
            + From selection
          </button>
        </div>

        {!portable && (
          <div style={mutedStyle} data-draw-pattern-degraded>
            This host wires no .paged container writer, so a field's parameters
            cannot be saved — it stays releasable and un-bakeable, but a
            re-plan has to name them again.
          </div>
        )}

        <div style={sectionStyle}>Tile</div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>Layout</span>
          <select
            style={{ font: "12px var(--font-sans, sans-serif)" }}
            data-draw-pattern-layout
            value={draft.layout}
            onChange={(e) =>
              setDraft({ ...draft, layout: e.target.value as PatternLayout })
            }
          >
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {numberRow(
          "H spacing (pt, negative overlaps)",
          draft.spacing[0],
          (n) => setDraft({ ...draft, spacing: [n, draft.spacing[1]] }),
          "spacingX",
        )}
        {numberRow(
          "V spacing (pt, negative overlaps)",
          draft.spacing[1],
          (n) => setDraft({ ...draft, spacing: [draft.spacing[0], n] }),
          "spacingY",
        )}
        {numberRow(
          "Row shift (0–1, brick + hex)",
          draft.offset,
          (n) => setDraft({ ...draft, offset: n }),
          "offset",
          0.05,
        )}

        <div style={sectionStyle}>Copies</div>
        {numberRow(
          "Columns",
          draft.columns,
          (n) => setDraft({ ...draft, columns: n }),
          "columns",
        )}
        {numberRow("Rows", draft.rows, (n) => setDraft({ ...draft, rows: n }), "rows")}
        {numberRow(
          "Dim copies to (%)",
          draft.dim,
          (n) => setDraft({ ...draft, dim: n }),
          "dim",
        )}
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>Overlap (which copy is in front)</span>
          <select
            style={{ font: "12px var(--font-sans, sans-serif)" }}
            data-draw-pattern-overlap-h
            value={draft.overlap.horizontal}
            onChange={(e) =>
              setDraft({
                ...draft,
                overlap: {
                  ...draft.overlap,
                  horizontal: e.target
                    .value as PatternParams["overlap"]["horizontal"],
                },
              })
            }
          >
            <option value="rightInFront">right in front</option>
            <option value="leftInFront">left in front</option>
          </select>
          <select
            style={{ font: "12px var(--font-sans, sans-serif)" }}
            data-draw-pattern-overlap-v
            value={draft.overlap.vertical}
            onChange={(e) =>
              setDraft({
                ...draft,
                overlap: {
                  ...draft.overlap,
                  vertical: e.target
                    .value as PatternParams["overlap"]["vertical"],
                },
              })
            }
          >
            <option value="bottomInFront">bottom in front</option>
            <option value="topInFront">top in front</option>
          </select>
        </div>
        <div style={rowStyle}>
          <label style={{ flex: 1 }} htmlFor="draw-pattern-fit">
            Keep tiles on the page
          </label>
          <input
            id="draw-pattern-fit"
            type="checkbox"
            data-draw-pattern-fit
            checked={draft.fitToArtboard}
            onChange={(e) =>
              setDraft({ ...draft, fitToArtboard: e.target.checked })
            }
          />
        </div>

        {fields.length === 0 ? (
          <div style={mutedStyle}>
            No pattern fields yet — select artwork and bake one.
          </div>
        ) : (
          fields.map((field) => (
            <div key={field.id} data-draw-pattern-row={field.id}>
              <div style={{ ...rowStyle, paddingTop: 8 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={patternRowLabel(field, placed[field.id] ?? 0)}
                >
                  {field.name}
                </span>
                <button
                  type="button"
                  style={iconBtn}
                  title="Rebuild this field with the parameters above and the sources' CURRENT geometry — every tile gets a new element id"
                  data-draw-pattern-replan
                  onClick={() =>
                    void run(
                      applyEditPattern(host, { patternId: field.id, ...draft }),
                    )
                  }
                >
                  Re-plan
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Select this field's tiles"
                  data-draw-pattern-select
                  onClick={() =>
                    void run(
                      applySelectPatternTiles(host, { patternId: field.id }),
                    )
                  }
                >
                  Select
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Remove every copy and keep the sources exactly as they are"
                  data-draw-pattern-unbake
                  onClick={() =>
                    void run(
                      applyDeletePatternTiles(host, { patternId: field.id }),
                    )
                  }
                >
                  Delete tiles
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Drop the recipe and every link — all the artwork stays"
                  data-draw-pattern-release
                  onClick={() =>
                    void run(applyReleasePattern(host, { patternId: field.id }))
                  }
                >
                  Release
                </button>
              </div>
              <div style={mutedStyle}>
                {patternRowLabel(field, placed[field.id] ?? 0)}
              </div>
            </div>
          ))
        )}

        {(placed[PATTERN_LEGACY_FIELD] ?? 0) > 0 && (
          <div style={mutedStyle} data-draw-pattern-legacy>
            {placed[PATTERN_LEGACY_FIELD]} tile(s) were baked by patterns v0,
            which saved no parameters — they can be released or un-baked, but
            not re-planned.
          </div>
        )}

        <div style={noteStyle} data-draw-pattern-note>
          {PATTERN_PANEL_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Pattern Options (draw)",
    component: Component,
    defaultDock: "right",
  };
}
