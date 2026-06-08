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
import {
  contributeEditContext,
  contributeSchemaPanel,
  contributeTool,
} from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";

import { drawTools } from "./tools";
import { contributeDashCommands, DASH_COMMAND_IDS } from "./commands/dash";
import { vectorGraphicEditContext } from "./edit-context";
import { installStrokePanelBindings, strokePanel } from "./panels/stroke-panel";

export function activate(host: BundleHost): BundleHandle {
  // B-17 — the anchor-edit tools are built from a host-bound factory;
  // each gesture handler reaches the engine through the `host.*`
  // facades only (no raw spine — the dogfooding proof, DESIGN.md §4.9).
  const tools = drawTools(host);
  for (const tool of tools) {
    contributeTool(host, tool);
  }
  // The v1 schema panel + its binding driver (the dynamic gate source).
  contributeSchemaPanel(host, strokePanel);
  const bindingSub = installStrokePanelBindings(host);
  // B-12 — the stroke DASH presets as commands (the schema binding
  // ceiling is scalar, a dash array is a vector → command-driven). Each
  // commits `setElementProperty{ frameStrokeDashArray, lengths }` to
  // the selection through the document door.
  const dashCommandsSub = contributeDashCommands(host);
  // W3.2 — the vectorGraphic edit context (closes B-02): double-click a
  // path enters anchor-editing (the anchor tools focused, the stroke
  // panel raised, a breadcrumb, Esc exits).
  contributeEditContext(host, vectorGraphicEditContext);
  host.log.info(
    `activated — ${tools.length} tools + 1 schema panel + ` +
      `${DASH_COMMAND_IDS.length} dash commands + 1 edit context ` +
      `(apiVersion ${manifest.apiVersion})`,
  );
  // The contributions tear down structurally via the host; the binding
  // subscription is the one thing allocated OUTSIDE a facade-tracked
  // registration, so dispose it (and the dash command group) here.
  return {
    dispose() {
      dashCommandsSub.dispose();
      bindingSub.dispose();
    },
  };
}

export { manifest };
