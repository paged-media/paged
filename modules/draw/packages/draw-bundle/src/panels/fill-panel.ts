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

import { createReloader, publishChanges } from "./reload";
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
  icon: "ui-swatch-fill",
  defaultDock: "right",
  defaultGroup: "draw",
  schema: {
    id: FILL_PANEL_ID,
    title: "Fill",
    sections: [
      {
        rows: [
          {
            // ADR 323 — an object-model property row: the host renders
            // the core row with its schema-driven PropertyField over
            // host.objects (one undo step, Bind to data…).
            field: "property",
            address: "selection",
            path: "frameFillColor",
            label: "Color",
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            // ADR 323 — an object-model property row: the host renders
            // the core row with its schema-driven PropertyField over
            // host.objects (one undo step, Bind to data…).
            field: "property",
            address: "selection",
            path: "frameFillTint",
            label: "Tint",
            props: { suffix: "%", min: 0, max: 100 },
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
            // ADR 323 — an object-model property row: the host renders
            // the core row with its schema-driven PropertyField over
            // host.objects (one undo step, Bind to data…).
            field: "property",
            address: "selection",
            path: "frameGradientFillAngle",
            label: "Angle",
            props: { suffix: "°" },
            enabled: { bind: BIND_HAS_SELECTION },
          },
          {
            // ADR 323 — an object-model property row: the host renders
            // the core row with its schema-driven PropertyField over
            // host.objects (one undo step, Bind to data…).
            field: "property",
            address: "selection",
            path: "frameGradientFillLength",
            label: "Length",
            props: { suffix: "pt" },
            enabled: { bind: BIND_HAS_SELECTION },
          },
        ],
      },
    ],
  },
};

/** Read the first selected element's `frameFillColor` ref (or null).
 *
 *  B-19 RESOLVED: the typed `host.document.elementProperties` facade
 *  read (plugin-api 0.2.12) replaced the marked v0
 *  `host.editor.client.send` escape hatch this call site carried as
 *  consumer evidence. Failure ⇒ `null` (the binding then reads false —
 *  a hidden section, never a throw). */
async function fillRefOf(
  host: BundleHost,
  id: ElementId,
): Promise<string | null> {
  try {
    const props = await host.document.elementProperties(id);
    if (!props) return null;
    for (const entry of props.entries) {
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
 * WHEN IT RECOMPUTES, and what that fixed (`./reload.ts`, the scheduler
 * the React panels share). The gate is published AFTER an awaited read,
 * an empty selection publishes `false` WITHOUT one, and nothing sequenced
 * the two: select a gradient-filled object and then clear the selection,
 * and the clear's `false` landed first with the older read's `true` on
 * top of it — the Gradient section stayed up with nothing selected. A
 * recompute now holds a ticket and publishes nothing once a newer one has
 * started; changes that arrive together are one recompute; and the gate
 * is not re-published when its value did not move.
 *
 * Returns a Disposable dropping both subscriptions.
 */
export function installFillPanelBindings(host: BundleHost): Disposable {
  const publish = publishChanges(host);
  const reloader = createReloader(
    host,
    "fill panel bindings",
    async ({ live, selection }) => {
      if (selection.length === 0) {
        publish(BIND_GRADIENT_CONTROLS_VISIBLE, false);
        return;
      }
      const ref = await fillRefOf(host, selection[0]);
      // The selection moved on while that read was out: its answer is
      // about an element the gate no longer describes.
      if (!live()) return;
      publish(
        BIND_GRADIENT_CONTROLS_VISIBLE,
        ref !== null && ref.startsWith("Gradient/"),
      );
    },
  );

  // Prime from the current selection AT ONCE, then track selection AND
  // document. A document change re-derives the gate for the selection
  // the host last handed over.
  reloader.now();
  const selSub = host.selection.onDidChange((ids) => reloader.request(ids));
  const docSub = host.document.onDidChange(() => reloader.request());
  return {
    dispose() {
      docSub.dispose();
      selSub.dispose();
      reloader.dispose();
    },
  };
}
