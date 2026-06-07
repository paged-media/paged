// @paged-media/draw-bundle — the paged.draw plugin bundle.

import { defineBundle } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";

import { activate } from "./activate";
import manifestJson from "../manifest.json";

export const drawBundle = defineBundle({
  manifest: manifestJson as PluginManifest,
  activate,
});

export { activate };
// The plan→Mutation translation, exported for the conformance replay
// harness (so it replays the EXACT mutation the live tool emits — no
// second copy to drift from).
export { mutationFor, type AnchorEditMode } from "./handlers/anchors";
// W3.1 — the v1 declarative stroke panel (closes B-01) + its binding
// driver, exported for the conformance spec.
export {
  strokePanel,
  installStrokePanelBindings,
  STROKE_PANEL_ID,
  BIND_HAS_SELECTION,
  BIND_DASH_CONTROLS_VISIBLE,
} from "./panels/stroke-panel";
