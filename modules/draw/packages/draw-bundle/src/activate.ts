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
// Phase 2d adds: the FILL schema panel (B-03 consumer — the
// `panels/fill.panel.json` prototype made real, gradient section gated
// by a published binding), the gradient-fill preset commands (gradient
// assignment is a multi-mutation flow above the binding ceiling — the
// dash precedent), and the GROUP/UNGROUP commands (B-04 consumers;
// clipping masks are NOT wire-representable — see commands/group.ts).
//
// The layers prototype (`panels/layers.panel.json`) stays a design
// prototype: expert-leaf list territory the schema can't express yet
// (see B-01 closure + DESIGN.md §12 honest limits).
//
// Phase 4c adds the PRO TOOLSET: four tools (Curvature + Pencil — pure
// machines over draw-geometry committing one insertPath; Gradient
// Annotator — axis display + drag steering the B-03 angle/length lane;
// Measure — read-only, with named honest subsets in handlers/measure.ts),
// nine commands (Outline stroke / Offset path / Simplify — the v30
// kernel ops; Join/Average endpoints — the pathPointSet subset, true
// join being a named engine-op gap; Pathfinder ×4 — pathfinderBoolean),
// and the stroke panel's Line ends section (the v43 GraphicLine
// arrowhead properties, gated by a published kind binding).

import type { BundleHandle, BundleHost } from "@paged-media/plugin-api";
import {
  contributeEditContext,
  contributeSchemaPanel,
  contributeTool,
} from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";

import { drawTools } from "./tools";
import {
  contributeAppearanceCommands,
  APPEARANCE_COMMAND_IDS,
} from "./commands/appearance";
import { contributeDashCommands, DASH_COMMAND_IDS } from "./commands/dash";
import {
  contributeLiveCornerCommands,
  LIVE_CORNER_COMMAND_IDS,
} from "./commands/live-corners";
import {
  contributeSelectSameCommands,
  SELECT_SAME_COMMAND_IDS,
} from "./commands/select-same";
import {
  contributeFillGradientCommands,
  FILL_GRADIENT_COMMAND_IDS,
} from "./commands/fill-gradient";
import { contributeGroupCommands, GROUP_COMMAND_IDS } from "./commands/group";
import {
  contributeJoinAverageCommands,
  JOIN_AVERAGE_COMMAND_IDS,
} from "./commands/join-average";
import {
  contributePathOpsCommands,
  PATH_OPS_COMMAND_IDS,
} from "./commands/path-ops";
import {
  contributePathfinderCommands,
  PATHFINDER_COMMAND_IDS,
} from "./commands/pathfinder";
import { vectorGraphicEditContext } from "./edit-context";
import { fillPanel, installFillPanelBindings } from "./panels/fill-panel";
import { installStrokePanelBindings, strokePanel } from "./panels/stroke-panel";
import { contributeSvgIo } from "./io/svg";

export function activate(host: BundleHost): BundleHandle {
  // B-17 — the anchor-edit tools are built from a host-bound factory;
  // each gesture handler reaches the engine through the `host.*`
  // facades only (no raw spine — the dogfooding proof, DESIGN.md §4.9).
  const tools = drawTools(host);
  for (const tool of tools) {
    contributeTool(host, tool);
  }
  // The v1 schema panels + their binding drivers (the dynamic gate
  // sources): STROKE (W3.1, B-01) then FILL (Phase 2d, B-03 — gradient
  // section gated by the published gradientControlsVisible binding).
  contributeSchemaPanel(host, strokePanel);
  const strokeBindingSub = installStrokePanelBindings(host);
  contributeSchemaPanel(host, fillPanel);
  const fillBindingSub = installFillPanelBindings(host);
  // B-12 — the stroke DASH presets as commands (the schema binding
  // ceiling is scalar, a dash array is a vector → command-driven). Each
  // commits `setElementProperty{ frameStrokeDashArray, lengths }` to
  // the selection through the document door.
  const dashCommandsSub = contributeDashCommands(host);
  // Phase 2d — Group selection / Ungroup (the B-04 wire consumers;
  // clipping masks are NOT representable on the wire — honest subset,
  // see commands/group.ts).
  const groupCommandsSub = contributeGroupCommands(host);
  // Phase 2d — gradient-fill presets (B-03 consumer; a gradient
  // assignment is a multi-mutation, vector-valued flow above the
  // binding ceiling → command-driven, the dash precedent).
  const fillGradientCommandsSub = contributeFillGradientCommands(host);
  // Phase 4c — the kernel path ops (Outline stroke / Offset path /
  // Simplify, the v30 wire consumers with documented pt defaults +
  // payload overrides).
  const pathOpsCommandsSub = contributePathOpsCommands(host);
  // Phase 4c — Join/Average over open-path endpoints (pathPointSet
  // consumers; the TRUE join/close is a named engine-op gap — see
  // commands/join-average.ts).
  const joinAverageCommandsSub = contributeJoinAverageCommands(host);
  // Phase 4c — Pathfinder Unite/Subtract/Intersect/Exclude (the
  // pathfinderBoolean wire consumers; first selected = kept).
  const pathfinderCommandsSub = contributePathfinderCommands(host);
  // Phase 9 (Tier B) — Live Corners (the frameCornerOption*/Radius* wire
  // consumers, Rectangle-only — gap B-23; each preset is an eight-write
  // batch + a metadata "live" marker).
  const liveCornerCommandsSub = contributeLiveCornerCommands(host);
  // Phase 9 (Tier B) — Appearance (multiple fills/strokes): a metadata
  // stack baked to the frame's top layer (one-fill/one-stroke engine —
  // gap B-24).
  const appearanceCommandsSub = contributeAppearanceCommands(host);
  // Phase 9 (Tier B) — Select-same (pure selection over fill / stroke /
  // stroke-weight; no mutation).
  const selectSameCommandsSub = contributeSelectSameCommands(host);
  // W3.2 — the vectorGraphic edit context (closes B-02): double-click a
  // path enters anchor-editing (the anchor tools focused, the stroke
  // panel raised, a breadcrumb, Esc exits).
  contributeEditContext(host, vectorGraphicEditContext);
  // Phase 8 — SVG interchange (K-2): an `.svg` importer (parse → insert
  // the shapes through the existing insertPath lane) + an `.svg` exporter
  // (selection → SVG bytes). Capability-gated; degrades honestly when the
  // host predates the importer/exporter doors.
  const svgIoSub = contributeSvgIo(host);
  host.log.info(
    `activated — ${tools.length} tools + 2 schema panels + ` +
      `${
        DASH_COMMAND_IDS.length +
        GROUP_COMMAND_IDS.length +
        FILL_GRADIENT_COMMAND_IDS.length +
        PATH_OPS_COMMAND_IDS.length +
        JOIN_AVERAGE_COMMAND_IDS.length +
        PATHFINDER_COMMAND_IDS.length +
        LIVE_CORNER_COMMAND_IDS.length +
        APPEARANCE_COMMAND_IDS.length +
        SELECT_SAME_COMMAND_IDS.length
      } commands + 1 edit context ` +
      `(apiVersion ${manifest.apiVersion})`,
  );
  // The contributions tear down structurally via the host; the binding
  // subscriptions are allocated OUTSIDE a facade-tracked registration,
  // so dispose them (and the command groups) here.
  return {
    dispose() {
      svgIoSub.dispose();
      selectSameCommandsSub.dispose();
      appearanceCommandsSub.dispose();
      liveCornerCommandsSub.dispose();
      pathfinderCommandsSub.dispose();
      joinAverageCommandsSub.dispose();
      pathOpsCommandsSub.dispose();
      fillGradientCommandsSub.dispose();
      groupCommandsSub.dispose();
      dashCommandsSub.dispose();
      fillBindingSub.dispose();
      strokeBindingSub.dispose();
    },
  };
}

export { manifest };
