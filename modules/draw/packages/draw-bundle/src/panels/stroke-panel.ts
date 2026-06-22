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

// The paged.draw STROKE panel — the FIRST real adoption of the v1
// declarative panel-schema mechanism (plugin-sdk W3.1, closes
// BREAKAGE_LOG B-01). Converted from the design prototype
// `panels/stroke.panel.json`.
//
// THE B-01 RESOLUTION, made real:
//   · the panel is a `SchemaPanelContribution` — pure data, NO React
//     crosses the boundary (the isolate-ready panel form);
//   · its rows are CATALOG widgets (`paged.input.numeric-scrub`,
//     `paged.input.color-swatch`, `paged.input.toggle-group`,
//     `paged.readout`) with `value` bindings on the §11.5 ceiling
//     (`selectionProperty` + coerce) — UNCHANGED;
//   · the dash SECTION's visibility and the weight/cap rows'
//     enablement are DRIVEN BY PUBLISHED BINDINGS the bundle computes
//     from real selection + document state (`installStrokePanelBindings`
//     below) — a derived bound value, NOT the rejected `visibleWhen`
//     conditional language.
//
// The prototype's `{ kind: "derived" }` dash rows are dropped (no
// dash-pattern PropertyPath exists yet — B-12); the dash section is a
// READOUT seam whose VISIBILITY is the live demonstration of the
// binding-driven gate (it shows only when the selection has a stroke).

import type {
  BundleHost,
  Disposable,
  ElementId,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";

export const STROKE_PANEL_ID = "media.paged.draw.panel.stroke";

/** Published binding names the schema gates reference. The bundle
 *  computes these from real state and publishes them; the host looks
 *  them up (no expression language). */
export const BIND_HAS_SELECTION = "media.paged.draw.hasSelection";
export const BIND_DASH_CONTROLS_VISIBLE = "media.paged.draw.dashControlsVisible";
/** Phase 4c — gates the Line ends (arrowheads) section: true when the
 *  FIRST selected element is a GraphicLine (the v43 properties are
 *  GraphicLine-only — the engine rejects them on any other kind, so the
 *  section honestly hides elsewhere). */
export const BIND_ARROWHEAD_CONTROLS_VISIBLE =
  "media.paged.draw.arrowheadControlsVisible";
/** Phase 9 (Tier B) — gates the Corners section: true when the FIRST
 *  selected element is a RECTANGLE (the engine's corner-option apply arm
 *  is Rectangle-only — see commands/live-corners.ts gap B-23; the section
 *  honestly hides elsewhere). */
export const BIND_CORNER_CONTROLS_VISIBLE =
  "media.paged.draw.cornerControlsVisible";
/** Phase 9 (Tier B) — gates the Appearance section: true when ANYTHING is
 *  selected (the appearance stack is plugin metadata applicable to any
 *  frame; the layer count itself is managed by the Appearance commands). */
export const BIND_APPEARANCE_CONTROLS_VISIBLE =
  "media.paged.draw.appearanceControlsVisible";

/** The curated arrowhead picker options (v43): wire `Value{type:"text"}`
 *  tokens from the IDML `ArrowHead` enumeration; `""` clears (the same
 *  spelling the engine reads back for a bare line). The full 11-token
 *  vocabulary stays scriptable through the same property — the picker
 *  carries the five workhorse ends. */
export const ARROWHEAD_OPTIONS = [
  { value: "", label: "None" },
  { value: "SimpleArrowHead", label: "Simple" },
  { value: "TriangleArrowHead", label: "Triangle" },
  { value: "CircleSolidArrowHead", label: "Circle" },
  { value: "BarArrowHead", label: "Bar" },
] as const;

export const strokePanel: SchemaPanelContribution = {
  id: STROKE_PANEL_ID,
  title: "Stroke",
  icon: "tool-convertAnchor",
  defaultDock: "right",
  defaultGroup: "draw",
  schema: {
    id: STROKE_PANEL_ID,
    title: "Stroke",
    sections: [
      {
        rows: [
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Weight", suffix: "pt" },
            value: {
              kind: "selectionProperty",
              path: "frameStrokeWeight",
              coerce: "pt",
            },
            // Enabled only when something is selected — the leaf's own
            // no-write-path disable agrees, but the gate makes the
            // intent explicit + demonstrates a binding-driven enable.
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.color-swatch",
            props: { label: "Color" },
            value: {
              kind: "selectionProperty",
              path: "frameStrokeColor",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.toggle-group",
            props: {
              label: "Cap",
              options: [
                { value: "ButtEndCap", label: "Butt" },
                { value: "RoundEndCap", label: "Round" },
                { value: "ProjectingEndCap", label: "Project" },
              ],
            },
            value: {
              kind: "selectionProperty",
              path: "frameStrokeEndCap",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
        ],
      },
      {
        // The dash section — its VISIBILITY is the binding-driven gate
        // (B-01's exact case: the prototype wanted `visibleWhen
        // strokeType == "dashed"`; here the bundle publishes the
        // already-derived boolean). Dash editing is now LIVE (B-12), but
        // a dash array is a VECTOR — the schema binding ceiling is scalar
        // (`literal | selectionProperty`, B-01), so it can't bind an
        // inline scrub. Dash is therefore COMMAND-driven: the readout
        // points the author at the Stroke dash-preset commands (Solid /
        // Dashed / Dotted / Dash-dot). No fake inline array scrubs.
        title: "Dashes",
        visible: { bind: BIND_DASH_CONTROLS_VISIBLE },
        rows: [
          {
            widget: "paged.readout",
            props: {
              label: "Pattern",
              text: "Dash presets: see the Stroke commands (Solid / Dashed / Dotted / Dash-dot).",
            },
          },
        ],
      },
      {
        // Phase 4c — Line ends (the v43 arrowhead properties). The
        // section's VISIBILITY is a published binding gating on the
        // selection being a GraphicLine (the engine's own kind gate);
        // the start/end pickers ride the §11.5 ceiling unchanged —
        // scalar `selectionProperty` text values from the curated
        // ArrowHead vocabulary, "" clears.
        title: "Line ends",
        visible: { bind: BIND_ARROWHEAD_CONTROLS_VISIBLE },
        rows: [
          {
            widget: "paged.input.toggle-group",
            props: { label: "Start", options: [...ARROWHEAD_OPTIONS] },
            value: {
              kind: "selectionProperty",
              path: "frameStrokeStartArrowhead",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.toggle-group",
            props: { label: "End", options: [...ARROWHEAD_OPTIONS] },
            value: {
              kind: "selectionProperty",
              path: "frameStrokeEndArrowhead",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
        ],
      },
      {
        // Phase 9 (Tier B) — Live Corners. The four per-corner RADIUS
        // scrubs ride the §11.5 scalar ceiling unchanged (each
        // `frameCornerRadius*` is a scalar `selectionProperty`, in pt);
        // the corner STYLE (Rounded / Inverse / Bevel / Fancy / None) is
        // a vector across four `frameCornerOption*` writes + a metadata
        // marker, so it is COMMAND-driven (the readout points the author
        // at the Corners commands). The whole section's VISIBILITY gates
        // on the selection being a RECTANGLE (the engine's corner apply
        // arm is Rectangle-only — gap B-23).
        title: "Corners",
        visible: { bind: BIND_CORNER_CONTROLS_VISIBLE },
        rows: [
          {
            widget: "paged.readout",
            props: {
              label: "Style",
              text: "Corner styles: see the Corners commands (Rounded / Inverse rounded / Bevel / Fancy / None).",
            },
          },
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Radius ◰", suffix: "pt", min: 0 },
            value: {
              kind: "selectionProperty",
              path: "frameCornerRadiusTopLeft",
              coerce: "pt",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Radius ◳", suffix: "pt", min: 0 },
            value: {
              kind: "selectionProperty",
              path: "frameCornerRadiusTopRight",
              coerce: "pt",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Radius ◲", suffix: "pt", min: 0 },
            value: {
              kind: "selectionProperty",
              path: "frameCornerRadiusBottomRight",
              coerce: "pt",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Radius ◱", suffix: "pt", min: 0 },
            value: {
              kind: "selectionProperty",
              path: "frameCornerRadiusBottomLeft",
              coerce: "pt",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
        ],
      },
      {
        // Phase 9 (Tier B) — Appearance (multiple fills/strokes). The
        // stack is plugin METADATA baked to the frame's top layer
        // (commands/appearance.ts) — a layer list is a vector above the
        // scalar binding ceiling, so layer management is COMMAND-driven.
        // The readout points the author at the Appearance commands; the
        // section's VISIBILITY gates on a non-empty selection.
        title: "Appearance",
        visible: { bind: BIND_APPEARANCE_CONTROLS_VISIBLE },
        rows: [
          {
            widget: "paged.readout",
            props: {
              label: "Layers",
              text: "Stacked fills/strokes: see the Appearance commands (Add fill / Add stroke / Clear). The top layer bakes to the frame.",
            },
          },
        ],
      },
    ],
  },
};

/**
 * Wire the panel's published bindings to REAL state. Subscribes to the
 * host selection; on every change it computes — in the BUNDLE's realm —
 * two booleans and publishes them, which the host then LOOKS UP for the
 * schema gates (no expression language crosses the boundary):
 *   · `hasSelection`         — is anything selected (gates the row
 *     ENABLEMENT: weight / color / cap);
 *   · `dashControlsVisible`  — is the FIRST selected element a PATH
 *     (does it expose a `pathAnchors` table)? Paths are what the draw
 *     tools edit, so the dash section is relevant for them — gating the
 *     SECTION's VISIBILITY. This is a real `host.document.pathAnchors`
 *     read (rectangles are bounds-based and expose no anchor table, so
 *     they read `false` — see BREAKAGE_LOG B-13 finding (b)).
 *
 * This is exactly B-01's resolution: the conditional (`visibleWhen`)
 * is gone; a DERIVED bound value the plugin computes drives visibility.
 *
 * Returns a Disposable that drops the subscription (the host also
 * tracks the bindings store, cleared on bundle teardown).
 */
export function installStrokePanelBindings(host: BundleHost): Disposable {
  const recompute = async (ids: ElementId[] | undefined): Promise<void> => {
    const selection = ids ?? host.selection.get();
    const has = selection.length > 0;
    host.bindings.publish(BIND_HAS_SELECTION, has);
    // Phase 4c — the Line ends section gates on the selection's KIND
    // (GraphicLine-only, the engine's own arrowhead gate). A plain
    // selection read, no document round-trip.
    host.bindings.publish(
      BIND_ARROWHEAD_CONTROLS_VISIBLE,
      has && selection[0].kind === "graphicLine",
    );
    // Phase 9 (Tier B) — the Corners section gates on the selection being
    // a RECTANGLE (the engine's corner-option apply arm is Rectangle-only,
    // gap B-23); the Appearance section gates on any non-empty selection
    // (the stack is plugin metadata applicable to any frame). Plain
    // selection reads, no document round-trip.
    host.bindings.publish(
      BIND_CORNER_CONTROLS_VISIBLE,
      has && selection[0].kind === "rectangle",
    );
    host.bindings.publish(BIND_APPEARANCE_CONTROLS_VISIBLE, has);
    if (!has) {
      host.bindings.publish(BIND_DASH_CONTROLS_VISIBLE, false);
      return;
    }
    // A path element exposes an anchor table; a rectangle does not.
    let isPath = false;
    try {
      const anchors = await host.document.pathAnchors(selection[0]);
      isPath = anchors !== null && anchors.anchors.length > 0;
    } catch {
      isPath = false;
    }
    host.bindings.publish(BIND_DASH_CONTROLS_VISIBLE, isPath);
  };

  // Prime from the current selection, then track changes.
  void recompute(undefined);
  return host.selection.onDidChange((ids) => {
    void recompute(ids);
  });
}
