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

// The SYMBOLS panel — the view over the document-resident symbol library
// that `commands/symbols.ts` models, and over the INSTANCE the selection
// is (or is not) part of.
//
// An expert-leaf REACT panel for the Layers / Appearance / Graphic Styles
// reason (B-01): a LIST of named records with per-row actions is above
// the v1 schema panel's scalar binding ceiling. It reloads on BOTH
// `selection.onDidChange` and `document.onDidChange` (so undo/redo, a
// place and a redefine all move the instance counts with no polling) and
// writes through the EXACT appliers the commands use — no second write
// path to drift from.
//
// WHAT THE ROWS SAY, and why each word is load-bearing:
//   · the INSTANCE count per row — how many objects a Redefine will
//     rebuild. Redefine is destructive to every one of them (an instance
//     is static in v0), so the number is the blast radius and the panel
//     shows it before the click.
//   · "registration" — the nine-point anchor the definition was captured
//     around. It is where Place puts the instance and what Reset
//     re-anchors to, so it is not decoration.
//   · Reset transform is enabled only when the SELECTION is an instance,
//     because it operates on the selection, not on the row.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

import {
  applyBreakSymbolLink,
  applyDefineSymbol,
  applyDeleteSymbol,
  applyPlaceSymbolInstance,
  applyRedefineSymbol,
  applyResetSymbolTransform,
  readSymbolLibrary,
  selectedSymbolInstances,
  symbolInstances,
  SYMBOLS_FEATURE,
  type SymbolDefinition,
} from "../commands/symbols";

export const SYMBOLS_PANEL_ID = "media.paged.draw.panel.symbols";

/** The limitation the panel renders inline. Exported so the conformance
 *  spec pins the WORDING — an honesty note that can be edited away
 *  silently is not a guarantee. */
export const SYMBOLS_NOTE =
  "A symbol stores artwork as a named DEFINITION; placing one re-emits " +
  "that artwork as an INSTANCE linked back to it. Redefine rebuilds every " +
  "instance in the document, Reset transform re-emits the selected " +
  "instance in place (discarding whatever scaling or editing its artwork " +
  "picked up, keeping its position), and Break link keeps the artwork and " +
  "drops the reference. Instances are STATIC in v0: there are no " +
  "per-instance overrides, so a redefine overwrites every local change. " +
  "The library lives in the document, as the container part " +
  "paged/media.paged.draw/symbols.json, so it travels with the file — but " +
  "a container write is not an engine mutation, so DEFINE, RENAME and " +
  "DELETE are NOT UNDOABLE (only the per-object writes they perform are). " +
  "What a symbol cannot hold is named rather than implied: the engine and " +
  "IDML have no symbol primitive and no element-duplicate op, so an " +
  "instance is re-emitted geometry and flat paint — TEXT IS REFUSED (a " +
  "story cannot be copied), and live corners, placed images, gradients " +
  "and the appearance stack do not ride along. A rebuild mints new " +
  "element ids. And this row builds define / place / redefine / break / " +
  "reset / rename / delete only — the eight symbol-SET tools (Sprayer, " +
  "Shifter, Scruncher, Sizer, Spinner, Stainer, Screener, Styler), " +
  "nine-slice scaling and 3D mapping are NOT built.";

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
const tagStyle: React.CSSProperties = {
  font: "10px var(--font-sans, sans-serif)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.5))",
  borderRadius: 2,
  padding: "0 3px",
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: "12px var(--font-sans, sans-serif)",
};

/** The one-line summary a symbol row shows: how much artwork the
 *  definition carries, where its registration point sits, and how many
 *  instances follow it. Pure — exported so the conformance spec pins the
 *  wording without a DOM. */
export function symbolRowLabel(
  symbol: SymbolDefinition,
  instances: number,
): string {
  const pieces = symbol.pieces.length;
  return (
    `${pieces} piece${pieces === 1 ? "" : "s"} · ` +
    `${symbol.registration} registration · ` +
    `${instances} instance${instances === 1 ? "" : "s"}`
  );
}

export function makeSymbolsPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [symbols, setSymbols] = React.useState<SymbolDefinition[]>([]);
    const [counts, setCounts] = React.useState<Record<string, number>>({});
    const [selected, setSelected] = React.useState<string[]>([]);
    const [hasSelection, setHasSelection] = React.useState(false);
    const [portable, setPortable] = React.useState(true);

    const reload = React.useCallback(async () => {
      setPortable(host.supports(SYMBOLS_FEATURE));
      setSymbols((await readSymbolLibrary(host)).symbols);

      const tally: Record<string, number> = {};
      for (const instance of await symbolInstances(host)) {
        tally[instance.symbol] = (tally[instance.symbol] ?? 0) + 1;
      }
      setCounts(tally);

      setHasSelection(host.selection.get().length > 0);
      try {
        setSelected(
          (await selectedSymbolInstances(host)).map((i) => i.symbol),
        );
      } catch {
        setSelected([]);
      }
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
        host.log.warn(`symbols panel: ${String(e)}`);
      }
      void reload();
    };

    const isInstance = selected.length > 0;

    return (
      <div
        style={{ padding: 12 }}
        data-draw-symbols-panel={symbols.length}
        data-draw-symbols-portable={portable ? "true" : "false"}
        data-draw-symbol-selected={selected[0] ?? ""}
      >
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Symbols ({symbols.length})
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={iconBtn}
              title="Capture the selection as a new symbol definition (the selection itself is not changed)"
              data-draw-symbol-define
              disabled={!hasSelection}
              onClick={() => void run(applyDefineSymbol(host))}
            >
              + From selection
            </button>
            <button
              type="button"
              style={iconBtn}
              title="Re-emit the selected instance from its definition, in place — discards any scaling or editing of its artwork"
              data-draw-symbol-reset
              disabled={!isInstance}
              onClick={() => void run(applyResetSymbolTransform(host))}
            >
              Reset transform
            </button>
            <button
              type="button"
              style={iconBtn}
              title="Drop the selected instance's reference and keep its artwork"
              data-draw-symbol-break
              disabled={!isInstance}
              onClick={() => void run(applyBreakSymbolLink(host))}
            >
              Break link
            </button>
          </span>
        </div>

        {!portable && (
          <div style={mutedStyle} data-draw-symbols-degraded>
            This host wires no .paged container writer, so the symbol library
            cannot be read or saved here — nothing would travel with the file.
          </div>
        )}

        {!hasSelection && (
          <div style={mutedStyle}>
            Select artwork to capture it as a symbol, or select an instance to
            reset or unlink it.
          </div>
        )}

        <div style={sectionStyle}>Library</div>
        {symbols.length === 0 ? (
          <div style={mutedStyle}>
            No symbols yet — select artwork and capture its definition.
          </div>
        ) : (
          symbols.map((symbol) => {
            const instances = counts[symbol.id] ?? 0;
            const followed = selected.includes(symbol.id);
            return (
              <div
                key={symbol.id}
                style={rowStyle}
                data-draw-symbol-row={symbol.id}
                data-draw-symbol-instance-count={instances}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={symbolRowLabel(symbol, instances)}
                >
                  {symbol.name}
                </span>
                {followed && <span style={tagStyle}>instance</span>}
                <button
                  type="button"
                  style={iconBtn}
                  title="Place an instance at the definition's capture point"
                  data-draw-symbol-place
                  onClick={() =>
                    void run(applyPlaceSymbolInstance(host, symbol.id))
                  }
                >
                  Place
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={`Redefine from the selection — ${instances} instance(s) are REBUILT, local edits included`}
                  data-draw-symbol-redefine
                  disabled={!hasSelection}
                  onClick={() => void run(applyRedefineSymbol(host, symbol.id))}
                >
                  Redefine
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Delete the definition and unlink every instance (the placed artwork stays)"
                  data-draw-symbol-delete
                  onClick={() => void run(applyDeleteSymbol(host, symbol.id))}
                >
                  Delete
                </button>
              </div>
            );
          })
        )}

        <div style={noteStyle} data-draw-symbols-note>
          {SYMBOLS_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Symbols",
    component: Component,
    defaultDock: "right",
  };
}
