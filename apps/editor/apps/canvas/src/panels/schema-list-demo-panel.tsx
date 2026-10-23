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

// B-01 list widget + G3 applyEntity — the IN-REPO CONSUMER PROOF.
//
// A schema-driven panel (pure data, rendered through the SAME
// `SchemaPanelRenderer` the bundle host injects) exercising the
// schema v1.1 collection tier end-to-end against a REAL document
// collection:
//
//   · a `paged.list` row bound to `documentCollection:swatches` —
//     row label from `name`, mono secondary from `kind`, id from
//     `selfId`;
//   · row SELECTION published back through the panel's bindings
//     (`demo.selectedSwatch`) — proven by the gated readout row
//     below it, which appears only once a row is selected (the
//     B-01 derived-bound-value gate, unchanged);
//   · a G3 `applyEntity` action ("Fill") applying the row's swatch
//     id to the element selection's `frameFillColor` as a ColorRef —
//     the standard setElementProperty mutation channel;
//   · a COMMAND action ("Stroke") dispatching a registered command
//     with the row id as payload; the handler (registered on panel
//     mount) applies the swatch to `frameStrokeColor`, so the
//     command lane does something real, never fake-interactive.
//
// Driven end-to-end by tests/e2e/schema-list-panel.spec.ts.

import { useEffect, useEffectEvent } from "react";

import {
  CatalogRegistryProvider,
  createLocalBindingsSurface,
  PAGED_LIST,
  PAGED_READOUT,
  SchemaPanelRenderer,
  useCanvasClient,
  useRegistries,
  useSelection,
  type ShellPanelSchema,
} from "@paged-media/shell";
import type { Mutation, Value } from "@paged-media/client";
import {
  defineMessages,
  t,
  useStrings,
  type Strings,
} from "@paged-media/strings";

import { appCatalogRegistry } from "./catalog-registry";

export const SCHEMA_LIST_DEMO_PANEL_ID = "paged.schema-list-demo";
export const DEMO_APPLY_STROKE_COMMAND = "paged.demo.applySwatchStroke";
const SELECTED_BINDING = "demo.selectedSwatch";

// Module-scoped: the panel's published-bindings store survives dock
// tab close/reopen (selection state is UI state, not document state).
const demoBindings = createLocalBindingsSurface();

const M = defineMessages("app.schemaListDemoPanel", {
  title: "Swatch List (schema)",
  swatches: "Swatches",
  fill: "Fill",
  stroke: "Stroke",
  selected: "Selected",
  rowSelected: "swatch row selected",
  applyStroke: "Apply swatch to stroke (schema demo)",
});

// The palette shows a command's category through `commandCategory.<cat>`;
// the category itself stays English (an identity). The tree demo's
// commands share it.
defineMessages("commandCategory", {
  Demo: "Demo",
});

const demoSchema = (strings: Strings): ShellPanelSchema => ({
  id: SCHEMA_LIST_DEMO_PANEL_ID,
  title: strings.t(M.title),
  sections: [
    {
      title: strings.t(M.swatches),
      rows: [
        {
          widget: PAGED_LIST,
          list: {
            items: { kind: "documentCollection", collection: "swatches" },
            labelField: "name",
            secondaryField: "kind",
            idField: "selfId",
            selectionBinding: SELECTED_BINDING,
            actions: [
              {
                label: strings.t(M.fill),
                action: {
                  kind: "applyEntity",
                  path: "frameFillColor",
                  valueType: "colorRef",
                },
              },
              {
                label: strings.t(M.stroke),
                action: { kind: "command", command: DEMO_APPLY_STROKE_COMMAND },
              },
            ],
          },
        },
        {
          // Gated on the list's published selection binding — renders
          // only once a row is selected (the publish-back proof).
          widget: PAGED_READOUT,
          props: {
            label: strings.t(M.selected),
            text: strings.t(M.rowSelected),
          },
          visible: { bind: SELECTED_BINDING },
        },
      ],
    },
  ],
});

export function SchemaListDemoPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const registries = useRegistries();
  const { elementSelection } = useSelection();
  // The command handler reads the CURRENT selection, not the mount-time
  // snapshot.
  const currentSelection = useEffectEvent(() => elementSelection);

  useEffect(() => {
    // Idempotent under a re-mount race (dockview can briefly hold two
    // instances across a layout swap; the registry throws on dup ids).
    if (registries.commands.get(DEMO_APPLY_STROKE_COMMAND)) return;
    const handle = registries.commands.register({
      id: DEMO_APPLY_STROKE_COMMAND,
      title: t(M.applyStroke),
      category: "Demo",
      handler: (_paged, payload) => {
        const swatchId = typeof payload === "string" ? payload : null;
        if (!swatchId) return;
        const value = { type: "colorRef", value: swatchId } as Value;
        // One batch over the selection: one undo step (PN-356).
        const ops: Mutation[] = currentSelection().map((id) => ({
          op: "setElementProperty",
          args: { elementId: id, path: "frameStrokeColor", value },
        }));
        if (ops.length === 0) return;
        void client.mutate(
          ops.length === 1 ? ops[0]! : { op: "batch", args: { ops } },
        );
      },
    });
    return () => handle.dispose();
  }, [registries, client]);

  return (
    <CatalogRegistryProvider registry={appCatalogRegistry()}>
      <SchemaPanelRenderer
        schema={demoSchema(strings)}
        bindings={demoBindings}
      />
    </CatalogRegistryProvider>
  );
}
