// The paged.draw FILL panel — the SECOND v1 declarative schema panel,
// converted from the design prototype `panels/fill.panel.json` now that
// gradient assignment is VERIFIED engine-side (B-03 resolved; the
// wire-path proof is `test/conformance/gradient-fill.spec.ts`: a
// `setElementProperty{ frameFillColor, colorRef: "Gradient/…" }` is a
// plain ref assignment — gradients share the swatch namespace).
//
// The stroke-panel pattern, applied:
//   · rows are CATALOG widgets with `value` bindings on the §11.5
//     ceiling (`selectionProperty` + coerce) — fill color rides the
//     color-swatch widget on `frameFillColor` exactly as the stroke
//     panel does for `frameStrokeColor`; tint is a `%`-coerced scrub;
//   · the GRADIENT section's visibility is a PUBLISHED BINDING the
//     bundle computes from real document state (is the first selected
//     element's fill a `Gradient/` ref?) — a derived bound value, NOT
//     a `visibleWhen` conditional (the B-01 rule);
//   · gradient ASSIGNMENT (create-stops + create-gradient + point the
//     fill at it) is a multi-mutation, array-valued flow ABOVE the
//     scalar binding ceiling, so it is COMMAND-driven (the dash.ts
//     precedent) — see `./commands/fill-gradient.ts`. The angle/length
//     scrubs here steer an ALREADY-gradient fill (scalar `length`
//     values, on the ceiling).

import type {
  BundleHost,
  Disposable,
  ElementId,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";

import { BIND_HAS_SELECTION } from "./stroke-panel";

export const FILL_PANEL_ID = "media.paged.draw.panel.fill";

/** Published binding gating the gradient section: true when the FIRST
 *  selected element's fill is a `Gradient/` ref. The bundle computes it
 *  (`installFillPanelBindings`); the host looks it up. */
export const BIND_GRADIENT_CONTROLS_VISIBLE =
  "media.paged.draw.gradientControlsVisible";

export const fillPanel: SchemaPanelContribution = {
  id: FILL_PANEL_ID,
  title: "Fill",
  icon: "swatch-fill",
  defaultDock: "right",
  defaultGroup: "draw",
  schema: {
    id: FILL_PANEL_ID,
    title: "Fill",
    sections: [
      {
        rows: [
          {
            widget: "paged.input.color-swatch",
            props: { label: "Color" },
            value: {
              kind: "selectionProperty",
              path: "frameFillColor",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Tint", suffix: "%", min: 0, max: 100 },
            value: {
              kind: "selectionProperty",
              path: "frameFillTint",
              coerce: "%",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
        ],
      },
      {
        // Visible only while the selection's fill IS a gradient — the
        // angle/length axis properties are meaningless on a solid fill.
        // Assigning a gradient in the first place is command-driven
        // (Fill: Linear/Radial gradient), pointed at by the readout.
        title: "Gradient",
        visible: { bind: BIND_GRADIENT_CONTROLS_VISIBLE },
        rows: [
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Angle", suffix: "°" },
            value: {
              kind: "selectionProperty",
              path: "frameGradientFillAngle",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Length", suffix: "pt" },
            value: {
              kind: "selectionProperty",
              path: "frameGradientFillLength",
              coerce: "pt",
            },
            enabled: { bind: BIND_HAS_SELECTION },
          },
        ],
      },
    ],
  },
};

/** Read the first selected element's `frameFillColor` ref (or null).
 *
 *  GAP (named, not faked): the `host.document` facade has NO
 *  element-properties read door — `requestElementProperties` is wire-
 *  only (the facade exposes pathAnchors / geometry / tree / collections,
 *  not the typed property snapshot). This read therefore goes through
 *  the MARKED v0 escape hatch `host.editor.client.send` (DESIGN.md
 *  §4.9); the missing facade door belongs to the cross-repo RFI
 *  (`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`) and
 *  this call site is the consumer evidence. Failure ⇒ `null` (the
 *  binding then reads false — a hidden section, never a throw). */
async function fillRefOf(
  host: BundleHost,
  id: ElementId,
): Promise<string | null> {
  try {
    const reply = await host.editor.client.send({
      kind: "requestElementProperties",
      payload: { id },
    });
    if (reply.kind !== "elementProperties" || !reply.payload.result) {
      return null;
    }
    for (const entry of reply.payload.result.entries) {
      const v = entry.value;
      if (entry.path === "frameFillColor" && v && v.type === "colorRef") {
        return v.value;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wire the fill panel's published binding to REAL state (the
 * `installStrokePanelBindings` pattern). Recomputes on BOTH selection
 * changes AND document changes — a "Fill: Linear gradient" command (or
 * an undo of one) flips the fill ref without touching the selection,
 * and the gradient section must follow. Publishes:
 *   · `gradientControlsVisible` — does the FIRST selected element's
 *     `frameFillColor` reference a `Gradient/` self-id?
 * (`hasSelection` is published by the stroke panel's driver — one
 * derivation, shared by name; both drivers are installed by activate.)
 *
 * Returns a Disposable dropping both subscriptions.
 */
export function installFillPanelBindings(host: BundleHost): Disposable {
  const recompute = async (ids: ElementId[] | undefined): Promise<void> => {
    const selection = ids ?? host.selection.get();
    if (selection.length === 0) {
      host.bindings.publish(BIND_GRADIENT_CONTROLS_VISIBLE, false);
      return;
    }
    const ref = await fillRefOf(host, selection[0]);
    host.bindings.publish(
      BIND_GRADIENT_CONTROLS_VISIBLE,
      ref !== null && ref.startsWith("Gradient/"),
    );
  };

  // Prime from the current selection, then track selection AND document.
  void recompute(undefined);
  const selSub = host.selection.onDidChange((ids) => {
    void recompute(ids);
  });
  const docSub = host.document.onDidChange(() => {
    void recompute(undefined);
  });
  return {
    dispose() {
      docSub.dispose();
      selSub.dispose();
    },
  };
}
