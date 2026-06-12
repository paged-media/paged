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
// W3.2 — the vectorGraphic edit context (closes B-02), exported for the
// conformance spec.
export {
  vectorGraphicEditContext,
  VECTOR_GRAPHIC_CONTEXT,
} from "./edit-context";
// B-12 — the stroke DASH presets + their mutation builder, exported for
// the conformance spec (so it asserts the EXACT mutation a command
// emits — no second copy to drift from).
export {
  DASH_PRESETS,
  DASH_COMMAND_IDS,
  DASH_COMMAND_CATEGORY,
  dashMutationFor,
  applyDashPreset,
  contributeDashCommands,
  type DashPreset,
} from "./commands/dash";
// Phase 2d — Group selection / Ungroup (B-04 consumers; clipping masks
// honestly omitted — not wire-representable, see commands/group.ts),
// exported for the conformance spec.
export {
  GROUP_COMMAND_ID,
  UNGROUP_COMMAND_ID,
  GROUP_COMMAND_IDS,
  GROUP_COMMAND_CATEGORY,
  groupMutationFor,
  ungroupMutationFor,
  applyGroupSelection,
  applyUngroup,
  contributeGroupCommands,
} from "./commands/group";
// Phase 2d — the v1 declarative FILL panel (B-03 consumer) + its
// binding driver, exported for the conformance spec.
export {
  fillPanel,
  installFillPanelBindings,
  FILL_PANEL_ID,
  BIND_GRADIENT_CONTROLS_VISIBLE,
} from "./panels/fill-panel";
// Phase 2d — the gradient-fill preset commands + their mutation
// builder, exported for the conformance spec (so it asserts the EXACT
// mutations a command emits — no second copy to drift from).
export {
  FILL_GRADIENT_PRESETS,
  FILL_GRADIENT_COMMAND_IDS,
  FILL_COMMAND_CATEGORY,
  mintFillGradientIds,
  fillGradientMutationsFor,
  applyFillGradientPreset,
  contributeFillGradientCommands,
  type FillGradientPreset,
} from "./commands/fill-gradient";
