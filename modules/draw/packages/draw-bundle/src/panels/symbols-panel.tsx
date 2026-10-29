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
import {
  engineSymbols,
  instancesIn,
  readEngineSymbols,
} from "../commands/symbols-engine";
import { usePanelReload } from "./use-panel-reload";
import {
  About,
  color,
  ConfirmButton,
  font,
  Refusal,
  useActionFeedback,
} from "@paged-media/panel-kit";
import { PanelIntro, tokenLabel } from "./panel-parts";
import { defineMessages, t, useStrings } from "@paged-media/strings";

const M = defineMessages("draw.symbolsPanel", {
  summary:
    "Save artwork as a named symbol and place linked copies of it; Redefine updates every copy.",
  note: "Placing a symbol adds an instance linked to its definition. Redefine rebuilds every instance, so changes made to an instance are lost. Reset transform rebuilds the selected instance where it is, undoing any scaling or edits. Break link keeps the artwork and drops the link. The library is saved in the document. Defining, renaming and deleting a symbol cannot be undone. Text cannot go into a symbol, and live corners, placed images, gradients and appearance stacks are not kept.",
  rowLabel:
    "{pieces, plural, one {# piece} other {# pieces}} · {registration} registration · {instances, plural, one {# instance} other {# instances}}",
  heading: "Symbols",
  defineHint:
    "Save the selection as a new symbol (the selection itself is not changed)",
  selectArtwork: "Select artwork first",
  fromSelection: "+ From selection",
  resetHint:
    "Rebuild the selected instance where it is, undoing any scaling or edits",
  selectInstance: "Select a symbol instance first",
  resetTransform: "Reset transform",
  breakHint: "Keep the selected instance's artwork and drop its link",
  breakLink: "Break link",
  degraded:
    "This editor cannot save data into the document, so symbols are not available here.",
  selectHint:
    "Select artwork to capture it as a symbol, or select an instance to reset or unlink it.",
  library: "Library",
  empty: "No symbols yet — select artwork and capture its definition.",
  instance: "instance",
  placeHint: "Place an instance at the definition's capture point",
  place: "Place",
  redefineHint:
    "Redefine from the selection: {count, plural, one {# instance is rebuilt and loses its own edits} other {# instances are rebuilt and lose their own edits}}",
  redefine: "Redefine",
  delete: "Delete",
  deleteHint:
    "Delete the symbol and unlink its instances (the placed artwork stays). Cannot be undone.",
  title: "Symbols",
  noteEngine:
    "Symbols are kept by the document: an instance draws its symbol, text, gradients and placed images included, and Redefine updates every instance at once. Reset transform returns the selected instance to the symbol's own size and angle where it is. Break link turns an instance back into ordinary artwork. Every action can be undone. IDML has no symbols: an exported file carries the artwork, and reopening it in paged brings the instances back.",
});

export const SYMBOLS_PANEL_ID = "media.paged.draw.panel.symbols";

/** What the panel is for, in one sentence (shown at the top). */
export const SYMBOLS_SUMMARY = M.summary;

/** The "About" text. Exported so the conformance spec pins the wording. */
export const SYMBOLS_NOTE = M.note;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: `12px ${font.sans}`,
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 3px",
  font: `12px ${font.sans}`,
  color: color.fg,
};
const sectionStyle: React.CSSProperties = {
  font: `11px ${font.sans}`,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.65,
  paddingTop: 8,
};
const tagStyle: React.CSSProperties = {
  font: `10px ${font.sans}`,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  border: `1px solid ${color.border}`,
  borderRadius: 2,
  padding: "0 3px",
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: `12px ${font.sans}`,
};

/** The one-line summary a symbol row shows: how much artwork the
 *  definition carries, where its registration point sits, and how many
 *  instances follow it. Pure — exported so the conformance spec pins the
 *  wording without a DOM. */
export function symbolRowLabel(
  symbol: SymbolDefinition,
  instances: number,
  pieceCount?: number,
): string {
  const pieces = pieceCount ?? symbol.pieces.length;
  return t(M.rowLabel, {
    pieces,
    registration: tokenLabel(symbol.registration).toLowerCase(),
    instances,
  });
}

export function makeSymbolsPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [symbols, setSymbols] = React.useState<SymbolDefinition[]>([]);
    const [counts, setCounts] = React.useState<Record<string, number>>({});
    const [selected, setSelected] = React.useState<string[]>([]);
    const [hasSelection, setHasSelection] = React.useState(false);
    const [portable, setPortable] = React.useState(true);
    // Engine ADR 1039 — the engine keeps the symbols (`document.symbols@1`);
    // the rows then come from its `symbols` collection.
    const [engine, setEngine] = React.useState(false);
    const [pieceCounts, setPieceCounts] = React.useState<
      Record<string, number>
    >({});

    // WHAT A RELOAD COSTS (`test/panels/symbols-panel.dom.test.tsx`, and it
    // may only go down): the library part once, and the document's links
    // once per document REVISION, out of the walk every panel shares.
    // Which instances the selection touches is a lookup in that same
    // walk — it used to be a second walk, and a third tree read.
    const reload = usePanelReload(
      host,
      "symbols",
      async ({ live, selection }) => {
        if (engineSymbols(host)) {
          const rows = await readEngineSymbols(host);
          if (!live()) return;
          const picked = new Set(
            instancesIn(selection).map((e) => `instance:${e.id}`),
          );
          setEngine(true);
          setPortable(true);
          setSymbols(
            rows.map((r) => ({
              id: r.id,
              name: r.name,
              registration: "center",
              origin: [0, 0],
              pieces: [],
            })),
          );
          setPieceCounts(
            Object.fromEntries(rows.map((r) => [r.id, r.itemCount])),
          );
          setCounts(
            Object.fromEntries(rows.map((r) => [r.id, r.instances.length])),
          );
          setHasSelection(selection.length > 0);
          setSelected(
            rows
              .filter((r) => r.instances.some((i) => picked.has(i)))
              .map((r) => r.id),
          );
          return;
        }
        setEngine(false);
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
      },
    );

    const { refusal, run } = useActionFeedback(host, reload, "draw panel");

    const isInstance = selected.length > 0;

    return (
      <div
        style={{ padding: 12 }}
        data-draw-symbols-panel={symbols.length}
        data-draw-symbols-portable={portable ? "true" : "false"}
        data-draw-symbols-engine={engine ? "true" : "false"}
        data-draw-symbol-selected={selected[0] ?? ""}
      >
        <PanelIntro
          summary={s.t(SYMBOLS_SUMMARY)}
          attr="data-draw-symbols-intro"
        />
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            {s.t(M.heading)} ({symbols.length})
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={iconBtn}
              title={hasSelection ? s.t(M.defineHint) : s.t(M.selectArtwork)}
              data-draw-symbol-define
              disabled={!hasSelection}
              onClick={() => void run(() => applyDefineSymbol(host))}
            >
              {s.t(M.fromSelection)}
            </button>
            <button
              type="button"
              style={iconBtn}
              title={isInstance ? s.t(M.resetHint) : s.t(M.selectInstance)}
              data-draw-symbol-reset
              disabled={!isInstance}
              onClick={() => void run(() => applyResetSymbolTransform(host))}
            >
              {s.t(M.resetTransform)}
            </button>
            <button
              type="button"
              style={iconBtn}
              title={isInstance ? s.t(M.breakHint) : s.t(M.selectInstance)}
              data-draw-symbol-break
              disabled={!isInstance}
              onClick={() => void run(() => applyBreakSymbolLink(host))}
            >
              {s.t(M.breakLink)}
            </button>
          </span>
        </div>

        <Refusal text={refusal} />

        {!portable && (
          <div style={mutedStyle} data-draw-symbols-degraded>
            {s.t(M.degraded)}
          </div>
        )}

        {!hasSelection && <div style={mutedStyle}>{s.t(M.selectHint)}</div>}

        <div style={sectionStyle}>{s.t(M.library)}</div>
        {symbols.length === 0 ? (
          <div style={mutedStyle}>{s.t(M.empty)}</div>
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
                  title={symbolRowLabel(
                    symbol,
                    instances,
                    engine ? pieceCounts[symbol.id] : undefined,
                  )}
                >
                  {symbol.name}
                </span>
                {followed && <span style={tagStyle}>{s.t(M.instance)}</span>}
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.placeHint)}
                  data-draw-symbol-place
                  onClick={() =>
                    void run(() => applyPlaceSymbolInstance(host, symbol.id))
                  }
                >
                  {s.t(M.place)}
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={
                    hasSelection
                      ? s.t(M.redefineHint, { count: instances })
                      : s.t(M.selectArtwork)
                  }
                  data-draw-symbol-redefine
                  disabled={!hasSelection}
                  onClick={() =>
                    void run(() => applyRedefineSymbol(host, symbol.id))
                  }
                >
                  {s.t(M.redefine)}
                </button>
                <ConfirmButton
                  style={iconBtn}
                  label={s.t(M.delete)}
                  title={s.t(M.deleteHint)}
                  data-draw-symbol-delete
                  onConfirm={() =>
                    void run(() => applyDeleteSymbol(host, symbol.id))
                  }
                />
              </div>
            );
          })
        )}

        <About attr="data-draw-symbols-note">
          {s.t(engine ? M.noteEngine : SYMBOLS_NOTE)}
        </About>
      </div>
    );
  };
  return {
    title: t(M.title),
    component: Component,
    defaultDock: "right",
  };
}
