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
import {
  contributeAppearanceBakeCommands,
  APPEARANCE_BAKE_COMMAND_IDS,
} from "./commands/appearance-bake";
import {
  contributeGraphicStyleCommands,
  GRAPHIC_STYLES_COMMAND_IDS,
} from "./commands/graphic-styles";
import {
  contributeCompoundPathCommands,
  COMPOUND_PATH_COMMAND_IDS,
} from "./commands/compound-path";
import { contributeDashCommands, DASH_COMMAND_IDS } from "./commands/dash";
import {
  contributePatternCommands,
  PATTERN_COMMAND_IDS,
} from "./commands/pattern";
import {
  contributeLiveCornerCommands,
  LIVE_CORNER_COMMAND_IDS,
} from "./commands/live-corners";
import {
  contributeSelectSameCommands,
  SELECT_SAME_COMMAND_IDS,
} from "./commands/select-same";
import {
  contributeInsertShapeCommands,
  INSERT_SHAPE_COMMAND_IDS,
} from "./commands/insert-shapes";
import { contributeBlendCommand } from "./commands/blend";
import {
  contributeImageTraceCommand,
  IMAGE_TRACE_COMMAND_IDS,
} from "./commands/image-trace";
import { contributeSelectParentGroupCommand } from "./commands/select-parent-group";
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
import {
  contributePathfinderRegionCommands,
  PATHFINDER_REGION_COMMAND_IDS,
} from "./commands/pathfinder-region";
import { vectorGraphicEditContext } from "./edit-context";
import { fillPanel, installFillPanelBindings } from "./panels/fill-panel";
import { makeLayersPanel } from "./panels/layers-panel";
import {
  makeAppearancePanel,
  APPEARANCE_PANEL_ID,
} from "./panels/appearance-panel";
import {
  makeGraphicStylesPanel,
  GRAPHIC_STYLES_PANEL_ID,
} from "./panels/graphic-styles-panel";
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
  // The LAYERS panel — the panels/layers.panel.json prototype made real
  // as the expert-leaf React panel its own comment prescribes (the v1
  // schema has no list widget, B-01's honest limit). Live layer list +
  // the layer wire ops (visible/lock/printable/rename/move/add/remove).
  host.contribute.panel({
    id: "media.paged.draw.panel.layers",
    icon: "panel-layers",
    ...makeLayersPanel(host),
  });
  // The APPEARANCE panel — the view over the metadata stack the
  // appearance commands already model (add/remove/reorder fills +
  // strokes), with the one-fill/one-stroke engine limit (gap B-24)
  // stated inline instead of hidden behind a convincing stack. React
  // for the same reason Layers is (a reorderable list is above the v1
  // schema panel's scalar ceiling).
  // (`panel-effects` is a REAL glyph in the host's kebab-case map — the
  // dock tab renders iconless on an invented token, the stroke panel's
  // recorded lesson.)
  host.contribute.panel({
    id: APPEARANCE_PANEL_ID,
    icon: "panel-effects",
    ...makeAppearancePanel(host),
  });
  // Illustrator Phase 2 — GRAPHIC STYLES: the named, LINKED complete
  // appearance. The library is a `.paged` CONTAINER part (it travels
  // with the file — `host.storage` is per-browser and plugin metadata is
  // per-element, so neither could hold it); the link is a reference on
  // the element's own envelope. A React panel for the Layers/Appearance
  // reason: a list of named records with per-row actions is above the v1
  // schema panel's scalar ceiling.
  // (`panel-object-styles` is a REAL glyph in the host's kebab-case map;
  // there is no `panel-graphic-styles`, and an invented token renders the
  // dock tab ICONLESS — the stroke panel's recorded lesson.)
  host.contribute.panel({
    id: GRAPHIC_STYLES_PANEL_ID,
    icon: "panel-object-styles",
    ...makeGraphicStylesPanel(host),
  });
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
  // B-22 (engine v57) — the REGION Pathfinder row: Divide / Trim /
  // Merge / Crop / Outline / Minus back over the planar arrangement.
  // `elementIds` is TOP-TO-BOTTOM, read from the scene tree's paint
  // order rather than click order — see commands/pathfinder-region.ts.
  const pathfinderRegionCommandsSub = contributePathfinderRegionCommands(host);
  // Illustrator Phase 2 — Make / Release COMPOUND PATH. No new wire op:
  // `framePath` replaces a whole anchor table (contour boundaries
  // included) and is the same door core's own `apply_pathfinder` uses.
  // The winding re-orientation that turns a nested contour into a HOLE
  // under the engine's NON-ZERO fill lives in draw-geometry — see
  // commands/compound-path.ts for the undo shape + the honest scope.
  const compoundPathCommandsSub = contributeCompoundPathCommands(host);
  // Illustrator Phase 2 — PATTERNS v0, and honestly only v0: there is
  // no pattern paint type in IDML / the engine / the wire, so this is a
  // destructive step-and-repeat BAKE (copies, not a live fill). The
  // command title says BAKE; commands/pattern.ts says why.
  const patternCommandsSub = contributePatternCommands(host);
  // Phase 9 (Tier B) — Live Corners (the frameCornerOption*/Radius* wire
  // consumers, Rectangle-only — gap B-23; each preset is an eight-write
  // batch + a metadata "live" marker).
  const liveCornerCommandsSub = contributeLiveCornerCommands(host);
  // Phase 9 (Tier B) — Appearance (multiple fills/strokes): a metadata
  // stack baked to the frame's top layer (one-fill/one-stroke engine —
  // gap B-24).
  const appearanceCommandsSub = contributeAppearanceCommands(host);
  // B-24 CLOSED — the GROUP BAKE: `bakeAppearance` lowers the metadata
  // stack onto real stacked page items (one derived path per paint,
  // sharing the source geometry, wrapped in a group with the source
  // frame as the carrier); `releaseAppearance` is its exact inverse.
  // See commands/appearance-bake.ts for the mutation/undo shape and the
  // named list of what does and does not survive the lowering.
  const appearanceBakeCommandsSub = contributeAppearanceBakeCommands(host);
  // Illustrator Phase 2 — GRAPHIC STYLES (save / apply / redefine /
  // break link / rename / delete). The library is a document-resident
  // container part (`host.parts`, declared in contributes.partTypes) and
  // the LINK is a reference on the element's own metadata envelope; a
  // direct appearance edit marks the object OVERRIDDEN without breaking
  // the link, and a redefine overwrites it. See commands/graphic-styles.ts
  // for the persistence shape, the kind projection and the honest limits.
  const graphicStyleCommandsSub = contributeGraphicStyleCommands(host);
  // Phase 9 (Tier B) — Select-same (pure selection over fill / stroke /
  // stroke-weight; no mutation).
  const selectSameCommandsSub = contributeSelectSameCommands(host);
  // Wave 2 — the parametric insert-shape commands (Arc / Spiral /
  // Rect grid / Polar grid; v0 fixed default geometry — see
  // commands/insert-shapes.ts).
  const insertShapeCommandsSub = contributeInsertShapeCommands(host);
  // Wave 2 — Blend v0 (two matching-structure paths → 3 interpolated
  // intermediates, one batch; commands/blend.ts documents the honest
  // colour scope).
  const blendCommandSub = contributeBlendCommand(host);
  // Wave 2 — group-selection cycling (parentage via the scene-tree
  // door; commands/select-parent-group.ts records the parentOf door
  // gap).
  const selectParentGroupCommandSub = contributeSelectParentGroupCommand(host);
  // Illustrator Phase 2 (last row) — IMAGE TRACE v0. The one capability
  // in this repo whose kernel is computer vision rather than path
  // algebra, so it is the one that ships a Rust/wasm artifact
  // (crates/draw-trace + crates/trace-js over `visioncortex`, declared in
  // the manifest under capabilities.wasm[]). Pixels arrive through the
  // C-5 placed-asset door; holes come out as COMPOUND paths through
  // draw-geometry's `makeCompoundTable`, because the engine fills
  // non-zero. One-shot, fills only, main-thread — commands/image-trace.ts
  // states the whole honest scope, and the command TITLE carries it.
  const imageTraceCommandSub = contributeImageTraceCommand(host);
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
    `activated — ${tools.length} tools + 2 schema panels + 3 React panels + ` +
      `${
        DASH_COMMAND_IDS.length +
        GROUP_COMMAND_IDS.length +
        FILL_GRADIENT_COMMAND_IDS.length +
        PATH_OPS_COMMAND_IDS.length +
        JOIN_AVERAGE_COMMAND_IDS.length +
        PATHFINDER_COMMAND_IDS.length +
        PATHFINDER_REGION_COMMAND_IDS.length +
        COMPOUND_PATH_COMMAND_IDS.length +
        PATTERN_COMMAND_IDS.length +
        LIVE_CORNER_COMMAND_IDS.length +
        APPEARANCE_COMMAND_IDS.length +
        APPEARANCE_BAKE_COMMAND_IDS.length +
        GRAPHIC_STYLES_COMMAND_IDS.length +
        SELECT_SAME_COMMAND_IDS.length +
        INSERT_SHAPE_COMMAND_IDS.length +
        IMAGE_TRACE_COMMAND_IDS.length +
        2 // blendSelected + selectParentGroup
      } commands + 1 edit context ` +
      `(apiVersion ${manifest.apiVersion})`,
  );
  // The contributions tear down structurally via the host; the binding
  // subscriptions are allocated OUTSIDE a facade-tracked registration,
  // so dispose them (and the command groups) here.
  return {
    dispose() {
      svgIoSub.dispose();
      imageTraceCommandSub.dispose();
      selectParentGroupCommandSub.dispose();
      blendCommandSub.dispose();
      insertShapeCommandsSub.dispose();
      selectSameCommandsSub.dispose();
      graphicStyleCommandsSub.dispose();
      appearanceBakeCommandsSub.dispose();
      appearanceCommandsSub.dispose();
      liveCornerCommandsSub.dispose();
      patternCommandsSub.dispose();
      compoundPathCommandsSub.dispose();
      pathfinderRegionCommandsSub.dispose();
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
