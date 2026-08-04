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

// The APPEARANCE panel — the view over the appearance STACK that
// `commands/appearance.ts` already models (an `appearance` envelope in
// this plugin's `x-paged:media.paged.draw` metadata carrier, plus the
// FRONT-MOST-layer bake to the frame's real fill/stroke).
//
// An expert-leaf REACT panel for the same reason the Layers panel is one
// (B-01): a reorderable LIST is above the v1 schema panel's scalar
// binding ceiling. It reads the selection's stack on
// `selection.onDidChange` + `document.onDidChange` (undo/redo and
// foreign edits included — no polling) and writes through the EXACT
// appliers the appearance COMMANDS use, so there is no second write path
// to drift from.
//
// THE HONESTY THE UI MUST CARRY (gap B-24, and the reason this panel
// exists at all). There are now TWO states, and the panel names both:
//
//   UNBAKED — the stack is plugin metadata. The engine gives a frame ONE
//   fill slot and ONE stroke slot, so only the FRONT-MOST fill + stroke
//   sit in the document's own paint; the layers below travel in the
//   `.paged` file and reopen here but are not what renders.
//
//   BAKED — `bakeAppearance` lowered the stack onto REAL stacked page
//   items (one derived path per layer, sharing this shape's geometry,
//   inside a group). Every layer renders, on canvas, in a PDF export and
//   through an IDML save-back (C-19 taught the writer to emit
//   scene-created groups; C-20 gave a derived Polygon its tint and blend
//   mode). The panel keeps editing the METADATA stack — it stays the
//   source of truth — and an edit RE-BAKES rather than letting the model
//   and the page diverge.
//
// The note block spells out what the bake still costs (a group of derived
// paths, every edit replacing them, and an IDML save placing the group at
// the spread's close rather than in the carrier's z-slot). Hiding any of
// that behind a convincing stack would be the exact fiction this repo
// refuses.

import type { BundleHost, ElementId, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

import {
  appearanceOf,
  applyAppearanceCommand,
  applyAppearanceEdit,
  moveAppearanceLayer,
  removeAppearanceLayer,
  APPEARANCE_ADD_FILL_COMMAND_ID,
  APPEARANCE_ADD_STROKE_COMMAND_ID,
  APPEARANCE_CLEAR_COMMAND_ID,
  APPEARANCE_MOVE_LAYER_COMMAND_ID,
  APPEARANCE_REMOVE_LAYER_COMMAND_ID,
  type AppearanceStack,
  type FillLayer,
  type StrokeLayer,
} from "../commands/appearance";
import {
  appearanceBakeOf,
  bakeAppearance,
  releaseAppearance,
  resolveAppearanceCarrier,
} from "../commands/appearance-bake";

export const APPEARANCE_PANEL_ID = "media.paged.draw.panel.appearance";

/** The limitation the panel renders inline. Exported so the conformance
 *  spec pins the WORDING (an honesty note that can be edited away
 *  silently is not a guarantee). */
export const APPEARANCE_BAKE_NOTE =
  "Unbaked, this stack is metadata only: the engine gives each frame one " +
  "fill slot and one stroke slot, so only the front-most fill and stroke " +
  "are in the document's own paint — the layers below travel in the .paged " +
  "file and reopen here, but they are not what renders. Bake makes the " +
  "stack real: one derived path per layer, sharing this shape's geometry, " +
  "stacked back-to-front in a group, which is ordinary IDML — so every " +
  "layer renders on the canvas, in a PDF export and through an IDML " +
  "save-back, per-layer tint, opacity and blend mode included. What the " +
  "bake costs: the object becomes a GROUP of derived paths (direct-" +
  "selecting inside it edits one derived layer, and every edit re-bakes — " +
  "the derived paths are replaced, not patched), and an IDML save writes " +
  "the group at the end of the spread, so it reopens above the page items " +
  "the file already carried. Release is a choice, not a prerequisite for " +
  "saving: it restores the single frame with the front-most layer on its " +
  "own attributes (gap B-24).";

const EMPTY: AppearanceStack = { fills: [], strokes: [] };

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
const bakeTagStyle: React.CSSProperties = {
  font: "10px var(--font-sans, sans-serif)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.5))",
  borderRadius: 2,
  padding: "0 3px",
};

const swatchChip = (color: string): React.CSSProperties => ({
  width: 10,
  height: 10,
  flex: "0 0 auto",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.6))",
  // The colorRef is a swatch SELF-ID, not a resolvable CSS colour (the
  // engine owns the colour book) — the chip is a marker, never a lie
  // about the rendered paint.
  background: color === "Color/Paper" ? "#fff" : "transparent",
});

/** The label one stack row shows: the swatch ref plus the numeric the
 *  model actually carries (fills: tint %, strokes: weight pt). */
export function appearanceRowLabel(
  kind: "fill" | "stroke",
  layer: FillLayer | StrokeLayer,
): string {
  if (kind === "fill") {
    const fill = layer as FillLayer;
    return typeof fill.tint === "number"
      ? `${fill.color} · ${fill.tint}%`
      : fill.color;
  }
  const stroke = layer as StrokeLayer;
  return `${stroke.color} · ${stroke.weight} pt`;
}

export function makeAppearancePanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [target, setTarget] = React.useState<ElementId | null>(null);
    const [extra, setExtra] = React.useState(0);
    const [stack, setStack] = React.useState<AppearanceStack>(EMPTY);
    const [baked, setBaked] = React.useState(false);

    const reload = React.useCallback(async () => {
      const selection = host.selection.get();
      const first = selection[0] ?? null;
      setExtra(Math.max(0, selection.length - 1));
      if (!first) {
        setTarget(null);
        setStack(EMPTY);
        setBaked(false);
        return;
      }
      try {
        // A baked stack can be selected as its group or as one of its
        // derived layers — both resolve to the CARRIER that owns the
        // (still editable) metadata stack.
        const carrier = await resolveAppearanceCarrier(host, first);
        const env = await host.document.getMetadata(carrier);
        setTarget(carrier);
        setStack(appearanceOf(env));
        setBaked(appearanceBakeOf(env) !== null);
      } catch {
        setTarget(first);
        setStack(EMPTY);
        setBaked(false);
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

    const run = async (work: Promise<void>) => {
      try {
        await work;
      } catch (e) {
        host.log.warn(`appearance panel: ${String(e)}`);
      }
      void reload();
    };

    const edit = (
      commandId: string,
      transform: (s: AppearanceStack) => AppearanceStack,
    ) => void run(applyAppearanceEdit(host, commandId, transform));

    // Rows render FRONT-MOST FIRST (the bake order the note explains):
    // the model list is bottom-to-top, so the view reverses it and maps
    // the row back to its model index.
    const rows = (kind: "fill" | "stroke") => {
      const list: ReadonlyArray<FillLayer | StrokeLayer> =
        kind === "fill" ? stack.fills : stack.strokes;
      return list
        .map((layer, index) => ({ layer, index }))
        .reverse()
        .map(({ layer, index }, position) => {
          const top = index === list.length - 1;
          // BAKED: every layer is a real page item, so no row is dimmed
          // and every row is tagged. UNBAKED: only the front-most one
          // reaches the frame's own paint.
          const real = baked || top;
          return (
            <div
              key={`${kind}-${index}`}
              style={{ ...rowStyle, opacity: real ? 1 : 0.6 }}
              data-draw-appearance-row={`${kind}:${index}`}
              data-draw-appearance-bakes={real ? "true" : "false"}
            >
              <span style={swatchChip(layer.color)} aria-hidden="true" />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={
                  baked
                    ? "Baked — this layer is a real derived path in the group"
                    : top
                      ? "Front-most layer — this one bakes into the document"
                      : "Metadata only — this layer does not reach the document paint"
                }
              >
                {appearanceRowLabel(kind, layer)}
              </span>
              {real && (
                <span style={bakeTagStyle}>{baked ? "baked" : "bakes"}</span>
              )}
              <button
                type="button"
                style={iconBtn}
                title="Move toward the front"
                disabled={position === 0}
                data-draw-appearance-up
                onClick={() =>
                  edit(APPEARANCE_MOVE_LAYER_COMMAND_ID, (s) =>
                    moveAppearanceLayer(s, kind, index, 1),
                  )
                }
              >
                Up
              </button>
              <button
                type="button"
                style={iconBtn}
                title="Move toward the back"
                disabled={index === 0}
                data-draw-appearance-down
                onClick={() =>
                  edit(APPEARANCE_MOVE_LAYER_COMMAND_ID, (s) =>
                    moveAppearanceLayer(s, kind, index, -1),
                  )
                }
              >
                Down
              </button>
              <button
                type="button"
                style={iconBtn}
                title="Remove this layer"
                data-draw-appearance-remove
                onClick={() =>
                  edit(APPEARANCE_REMOVE_LAYER_COMMAND_ID, (s) =>
                    removeAppearanceLayer(s, kind, index),
                  )
                }
              >
                Remove
              </button>
            </div>
          );
        });
    };

    const total = stack.fills.length + stack.strokes.length;

    return (
      <div
        style={{ padding: 12 }}
        data-draw-appearance-panel={total}
        data-draw-appearance-baked={baked ? "true" : "false"}
      >
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Appearance ({total})
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={iconBtn}
              title="Add a fill layer (seeded from the frame's fill)"
              data-draw-appearance-add-fill
              disabled={!target}
              onClick={() =>
                void run(
                  applyAppearanceCommand(
                    host,
                    APPEARANCE_ADD_FILL_COMMAND_ID,
                    "fill",
                  ),
                )
              }
            >
              + Fill
            </button>
            <button
              type="button"
              style={iconBtn}
              title="Add a stroke layer (seeded from the frame's stroke)"
              data-draw-appearance-add-stroke
              disabled={!target}
              onClick={() =>
                void run(
                  applyAppearanceCommand(
                    host,
                    APPEARANCE_ADD_STROKE_COMMAND_ID,
                    "stroke",
                  ),
                )
              }
            >
              + Stroke
            </button>
            <button
              type="button"
              style={iconBtn}
              title="Clear every extra layer"
              data-draw-appearance-clear
              disabled={!target || total === 0}
              onClick={() =>
                void run(
                  applyAppearanceCommand(
                    host,
                    APPEARANCE_CLEAR_COMMAND_ID,
                    "clear",
                  ),
                )
              }
            >
              Clear
            </button>
          </span>
        </div>

        <div style={{ ...rowStyle, justifyContent: "flex-end", gap: 4 }}>
          <button
            type="button"
            style={iconBtn}
            title="Bake the stack into real stacked page items (a group of derived paths)"
            data-draw-appearance-bake
            disabled={!target || baked || total === 0}
            onClick={() =>
              void run(
                bakeAppearance(host, target!).then(() => undefined),
              )
            }
          >
            Bake
          </button>
          <button
            type="button"
            style={iconBtn}
            title="Release the baked group back to a single frame carrying the stack"
            data-draw-appearance-release
            disabled={!target || !baked}
            onClick={() =>
              void run(
                releaseAppearance(host, target!).then(() => undefined),
              )
            }
          >
            Release
          </button>
        </div>

        {!target && (
          <div style={{ opacity: 0.6, font: "12px var(--font-sans, sans-serif)" }}>
            Select an object to see its appearance stack.
          </div>
        )}

        {target && (
          <>
            {extra > 0 && (
              <div style={{ opacity: 0.6, font: "11px var(--font-sans, sans-serif)" }}>
                Showing the first of {extra + 1} selected objects; edits apply
                to all of them.
              </div>
            )}
            <div style={sectionStyle}>Fills</div>
            {stack.fills.length === 0 ? (
              <div style={{ opacity: 0.6, font: "12px var(--font-sans, sans-serif)" }}>
                No extra fill layers — the frame's own fill is what renders.
              </div>
            ) : (
              rows("fill")
            )}
            <div style={sectionStyle}>Strokes</div>
            {stack.strokes.length === 0 ? (
              <div style={{ opacity: 0.6, font: "12px var(--font-sans, sans-serif)" }}>
                No extra stroke layers — the frame's own stroke is what renders.
              </div>
            ) : (
              rows("stroke")
            )}
          </>
        )}

        <div style={noteStyle} data-draw-appearance-note>
          {APPEARANCE_BAKE_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Appearance (draw)",
    component: Component,
    defaultDock: "right",
  };
}
