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
import { usePanelReload } from "./use-panel-reload";
import {
  ConfirmButton,
  humanize,
  PanelAbout,
  PanelIntro,
  Refusal,
  useActionFeedback,
} from "./panel-kit";

export const SYMBOLS_PANEL_ID = "media.paged.draw.panel.symbols";

/** What the panel is for, in one sentence (shown at the top). */
export const SYMBOLS_SUMMARY =
  "Save artwork as a named symbol and place linked copies of it; " +
  "Redefine updates every copy.";

/** The "About" text. Exported so the conformance spec pins the wording. */
export const SYMBOLS_NOTE =
  "Placing a symbol adds an instance linked to its definition. Redefine " +
  "rebuilds every instance, so changes made to an instance are lost. " +
  "Reset transform rebuilds the selected instance where it is, undoing " +
  "any scaling or edits. Break link keeps the artwork and drops the link. " +
  "The library is saved in the document. Defining, renaming and deleting " +
  "a symbol cannot be undone. Text cannot go into a symbol, and live " +
  "corners, placed images, gradients and appearance stacks are not kept.";

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
    `${humanize(symbol.registration).toLowerCase()} registration · ` +
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

    // WHAT A RELOAD COSTS (`test/panels/symbols-panel.spec.tsx`, and it
    // may only go down): the library part once, and the document's links
    // once per document REVISION, out of the walk every panel shares.
    // Which instances the selection touches is a lookup in that same
    // walk — it used to be a second walk, and a third tree read.
    const reload = usePanelReload(host, "symbols", async ({ live, selection }) => {
      const library = await readSymbolLibrary(host);
      if (!live()) return;
      const tally: Record<string, number> = {};
      for (const instance of await symbolInstances(host)) {
        tally[instance.symbol] = (tally[instance.symbol] ?? 0) + 1;
      }
      if (!live()) return;
      let touched: string[] = [];
      try {
        touched = (await selectedSymbolInstances(host)).map((i) => i.symbol);
      } catch {
        touched = [];
      }
      if (!live()) return;
      setPortable(host.supports(SYMBOLS_FEATURE));
      setSymbols(library.symbols);
      setCounts(tally);
      setHasSelection(selection.length > 0);
      setSelected(touched);
    });

    const { refusal, run } = useActionFeedback(host, reload);

    const isInstance = selected.length > 0;

    return (
      <div
        style={{ padding: 12 }}
        data-draw-symbols-panel={symbols.length}
        data-draw-symbols-portable={portable ? "true" : "false"}
        data-draw-symbol-selected={selected[0] ?? ""}
      >
        <PanelIntro summary={SYMBOLS_SUMMARY} attr="data-draw-symbols-intro" />
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Symbols ({symbols.length})
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={iconBtn}
              title={
                hasSelection
                  ? "Save the selection as a new symbol (the selection itself is not changed)"
                  : "Select artwork first"
              }
              data-draw-symbol-define
              disabled={!hasSelection}
              onClick={() => void run(() => applyDefineSymbol(host))}
            >
              + From selection
            </button>
            <button
              type="button"
              style={iconBtn}
              title={
                isInstance
                  ? "Rebuild the selected instance where it is, undoing any scaling or edits"
                  : "Select a symbol instance first"
              }
              data-draw-symbol-reset
              disabled={!isInstance}
              onClick={() => void run(() => applyResetSymbolTransform(host))}
            >
              Reset transform
            </button>
            <button
              type="button"
              style={iconBtn}
              title={
                isInstance
                  ? "Keep the selected instance's artwork and drop its link"
                  : "Select a symbol instance first"
              }
              data-draw-symbol-break
              disabled={!isInstance}
              onClick={() => void run(() => applyBreakSymbolLink(host))}
            >
              Break link
            </button>
          </span>
        </div>

        <Refusal text={refusal} />

        {!portable && (
          <div style={mutedStyle} data-draw-symbols-degraded>
            This editor cannot save data into the document, so symbols are not
            available here.
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
                    void run(() => applyPlaceSymbolInstance(host, symbol.id))
                  }
                >
                  Place
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={
                    hasSelection
                      ? `Redefine from the selection: ${instances} instance${instances === 1 ? " is" : "s are"} rebuilt and lose their own edits`
                      : "Select artwork first"
                  }
                  data-draw-symbol-redefine
                  disabled={!hasSelection}
                  onClick={() => void run(() => applyRedefineSymbol(host, symbol.id))}
                >
                  Redefine
                </button>
                <ConfirmButton
                  style={iconBtn}
                  label="Delete"
                  title="Delete the symbol and unlink its instances (the placed artwork stays). Cannot be undone."
                  data-draw-symbol-delete
                  onConfirm={() => void run(() => applyDeleteSymbol(host, symbol.id))}
                />
              </div>
            );
          })
        )}

        <PanelAbout text={SYMBOLS_NOTE} attr="data-draw-symbols-note" />
      </div>
    );
  };
  return {
    title: "Symbols",
    component: Component,
    defaultDock: "right",
  };
}
