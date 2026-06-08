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
