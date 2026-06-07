// The paged.draw bundle entry — D-milestone status: D3 + W3.1.
//
// Registration happens HERE, through the public contribution surface:
// the three anchor-editing tools (Add/Delete/Convert — the Pen itself
// is a built-in core-document tool per the W2.5 division), each with
// its activation command and text-suppressed shortcut via
// `contributeTool`; AND the STROKE panel as a v1 declarative SCHEMA
// (W3.1, closes BREAKAGE_LOG B-01) — `contributeSchemaPanel` registers
// pure data (no React), and `installStrokePanelBindings` publishes the
// reactive booleans the schema's visibility/enablement gates look up.
// The host tracks every registration; removing the editor's
// `loadBundle` call removes draw cleanly — the platform-honesty smoke
// test.
//
// The OTHER prototypes (`panels/fill.panel.json`, `panels/layers.panel.
// json`) stay design prototypes pending the v1 mechanism: fill awaits
// gradient-assignment verification (B-03) and layers is expert-leaf
// list territory the schema can't express yet (see B-01 closure +
// DESIGN.md §12 honest limits). The edit-context claim in the manifest
// stays declarative until the shell grows the registry (B-02).

import type { BundleHandle, BundleHost } from "@paged-media/plugin-api";
import { contributeSchemaPanel, contributeTool } from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";

import { DRAW_TOOLS } from "./tools";
import { installStrokePanelBindings, strokePanel } from "./panels/stroke-panel";

export function activate(host: BundleHost): BundleHandle {
  for (const tool of DRAW_TOOLS) {
    contributeTool(host, tool);
  }
  // The v1 schema panel + its binding driver (the dynamic gate source).
  contributeSchemaPanel(host, strokePanel);
  const bindingSub = installStrokePanelBindings(host);
  host.log.info(
    `activated — ${DRAW_TOOLS.length} tools + 1 schema panel ` +
      `(apiVersion ${manifest.apiVersion})`,
  );
  // The contributions tear down structurally via the host; the binding
  // subscription is the one thing allocated OUTSIDE a facade-tracked
  // registration, so dispose it here.
  return {
    dispose() {
      bindingSub.dispose();
    },
  };
}

export { manifest };
