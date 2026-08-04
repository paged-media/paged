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
  contributeSymbolCommands,
  SYMBOLS_COMMAND_IDS,
} from "./commands/symbols";
import {
  contributeLivePaintCommands,
  LIVE_PAINT_COMMAND_IDS,
} from "./commands/live-paint";
import {
  contributeOpacityMaskCommands,
  OPACITY_MASK_COMMAND_IDS,
} from "./commands/opacity-mask";
import {
  contributeTextOnPathCommands,
  TEXT_ON_PATH_COMMAND_IDS,
} from "./commands/text-on-path";
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
import { makeLayersBindingProvider } from "./binding-provider/layers-provider";
import { registerBindingProvider } from "./binding-provider/adr023-seam";
import {
  makeAppearancePanel,
  APPEARANCE_PANEL_ID,
} from "./panels/appearance-panel";
import {
  makeGraphicStylesPanel,
  GRAPHIC_STYLES_PANEL_ID,
} from "./panels/graphic-styles-panel";
import { makeSymbolsPanel, SYMBOLS_PANEL_ID } from "./panels/symbols-panel";
import {
  makeLivePaintPanel,
  LIVE_PAINT_PANEL_ID,
} from "./panels/live-paint-panel";
import { makePatternPanel, PATTERN_PANEL_ID } from "./panels/pattern-panel";
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
  //
  // ADR 023 phase D: this panel is BEING RETIRED behind the
  // binding-provider seam below. It is still registered in THIS commit
  // on purpose — the coverage moves first, so there is a point to roll
  // back to if the seam turns out to be wrong.
  host.contribute.panel({
    id: "media.paged.draw.panel.layers",
    icon: "panel-layers",
    ...makeLayersPanel(host),
  });
  // ADR 023 phase D — the replacement, and it is NOT another panel.
  // While the `vectorGraphic` context is active, this bundle RESOLVES
  // what the HOST's own Layers panel binds to
  // (`binding-provider/layers-provider.ts`): one panel in the rail,
  // retargeting on selection, instead of a second copy of the same
  // seven ops in a second dock tab.
  //
  // Registration happens WITH the edit context further down (phase A
  // enforces the ordering: a provider on an unregistered context type
  // could never activate, so the door refuses it).
  const layersProvider = makeLayersBindingProvider(host);
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
  // Illustrator Phase 2 (§16.1) — SYMBOLS v0: a named artwork DEFINITION
  // in a second `.paged` container part, plus INSTANCES re-emitted from
  // it. Same React reason as the rows above (a list of named records with
  // per-row actions is above the v1 schema panel's scalar ceiling).
  // (`panel-links` is a REAL glyph in the host's kebab-case map — there is
  // no `panel-symbols`, and an invented token renders the dock tab
  // ICONLESS, the stroke panel's recorded lesson. It is also the honest
  // metaphor: an instance is a LINK to a definition.)
  host.contribute.panel({
    id: SYMBOLS_PANEL_ID,
    icon: "panel-links",
    ...makeSymbolsPanel(host),
  });
  // Illustrator Phase 2 (the last unbuilt row) — LIVE PAINT v0. The
  // panel is where the honest framing lives, because the feature NAME
  // promises a document-resident face/edge object this engine does not
  // have: what is built is a REGENERABLE RECIPE (the ordered members +
  // a paint per face id, in a third `.paged` container part) plus real
  // artwork inserted over each painted face. commands/live-paint.ts
  // states the measured undo counts, the 12-input / 256-face refusals,
  // and the two catalog halves that are NOT built — gap tolerance (the
  // arrangement door takes no tolerance and the kernel names gap
  // detection as out of scope) and edge stroking (there are no edge ids
  // on the wire at all).
  // (`panel-swatches` is a REAL glyph in the host's kebab-case map;
  // there is no `panel-live-paint`, and an invented token renders the
  // dock tab ICONLESS — the stroke panel's recorded lesson.)
  host.contribute.panel({
    id: LIVE_PAINT_PANEL_ID,
    icon: "panel-swatches",
    ...makeLivePaintPanel(host),
  });
  // Illustrator Phase 2 — PATTERN EDITING v1: the Pattern Options form.
  // The panel exists because the catalog row is an EDITING MODE (layout,
  // size, spacing, overlap, copies, dimming) and the SWATCH half of that
  // row is not buildable at all — there is no pattern paint type in
  // IDML, in `paged_model::Graphic` or on the wire (RFI C-31). So the
  // panel carries the boundary verbatim (`PATTERN_PANEL_NOTE`, pinned by
  // a conformance test) next to the knobs that ARE real.
  // (There is no `panel-pattern` glyph in the host's kebab-case map, and
  // an invented token renders the dock tab ICONLESS — the stroke panel's
  // recorded lesson. So this REUSES `panel-object-styles`, which the
  // graphic-styles panel also carries; a shared glyph is honest, an
  // invented one is not. Deliberately NOT `panel-swatches`: a swatch
  // icon is exactly the promise this feature cannot keep.)
  host.contribute.panel({
    id: PATTERN_PANEL_ID,
    icon: "panel-object-styles",
    ...makePatternPanel(host),
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
  // Illustrator Phase 2 — PATTERN EDITING v1 (bake / re-plan / select /
  // delete tiles / release). The catalog row's "save as a pattern
  // swatch" half is NOT BUILDABLE and is not faked: there is no pattern
  // paint type in IDML, none in `paged_model::Graphic` and none on the
  // wire (RFI C-31), so what a field produces is ARTWORK. What v1 does
  // deliver is the editing MODE v0 lacked — grid/brick/hex layouts,
  // tile size, spacing (negative = overlap), overlap ORDER, copy counts
  // and dimming, all persisted in a `.paged` container part — plus an
  // ARTBOARD-AWARE tile count that closes v0's off-page residual
  // (RFI C-23) and a release/re-plan/un-bake path so undo is no longer
  // the only way back. commands/pattern.ts states the measured undo
  // counts and the two batch-ordering rules the engine enforces.
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
  // Illustrator Phase 2 (§16.1) — SYMBOLS v0 (define / place / redefine /
  // break link / reset transform / rename / delete). Core has NO symbol
  // or instance model and IDML has no such primitive, and there is no
  // element-duplicate op on the wire — so a definition is a document
  // container part and an INSTANCE is real artwork re-emitted through
  // `insertPath` and stamped with a link on every leaf (a group cannot
  // carry metadata). commands/symbols.ts states the measured undo counts,
  // the text refusal and everything v0 deliberately does not build (the
  // eight symbol-SET tools, nine-slice scaling, 3D mapping).
  const symbolCommandsSub = contributeSymbolCommands(host);
  // Illustrator Phase 2 (the last unbuilt row) — LIVE PAINT v0 (make
  // group / fill face / regenerate / select faces / delete face /
  // release). Faces come from the B-22 planar arrangement, which is a
  // per-call QUERY: its ids are indices into the ordered member list, so
  // nothing here survives a member edit by itself. The recipe is a
  // document container part and a painted face is inserted artwork —
  // see commands/live-paint.ts for why that is the honest shape, and
  // RFI C-30 for the persistent object it is standing in for.
  const livePaintCommandsSub = contributeLivePaintCommands(host);
  // Illustrator Phase 2 (the Transparency panel row) — OPACITY MASKS
  // over the C-28 protocol-58 pair. The mask is honoured by the CPU
  // rasterizer and by PDF EXPORT but NOT by the Vello/WebGPU backend the
  // canvas draws through, so there is deliberately no panel, no overlay
  // and no preview here — the command TITLE carries the gap the way
  // pattern.ts's title carries "copies, not a live fill". Core's seven
  // refusals (text frame, self, cross-spread, already-masked,
  // already-a-mask, pasted-in, grouped) are surfaced with the engine's
  // own sentence rather than re-implemented — see commands/opacity-mask.ts.
  const opacityMaskCommandsSub = contributeOpacityMaskCommands(host);
  // Illustrator/InDesign Phase 2 — TYPE ON A PATH over the C-29
  // protocol-58 pair (plus the tool above). The renderer has always
  // CONSUMED `<TextPath>`; v58 is the first way to create one, so every
  // knob offered here is one the renderer honours and `PathEffect` is
  // deliberately absent (only Rainbow renders). It FLOWS AN EXISTING
  // story — the wire has no create-story op — and says so.
  const textOnPathCommandsSub = contributeTextOnPathCommands(host);
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
  //
  // ADR 023: the context's own hooks now also tell the Layers provider
  // WHICH element was entered — its scope root, whose siblings are the
  // object stack the host Layers panel shows. Note this is NOT the
  // provider's lifetime: that is BORROWED, wrapped by the SDK adapter
  // around these same hooks, so the shell's context stack stays the
  // single source of "who is active". The declaration itself is spread
  // from the shared const, so `edit-context.ts` (and the specs pinning
  // its matcher / tool set / panel set) are untouched.
  contributeEditContext(host, {
    ...vectorGraphicEditContext,
    onEnter: (ctx) => {
      vectorGraphicEditContext.onEnter?.(ctx);
      layersProvider.enter(ctx.id);
    },
    onExit: (ctx) => {
      vectorGraphicEditContext.onExit?.(ctx);
      layersProvider.exit();
    },
  });
  // …and only NOW the provider: phase A refuses a provider whose edit
  // context this bundle has not registered yet, because it could never
  // activate. `null` back means the host predates phase A — draw then
  // contributes no provider and the host Layers panel keeps reading
  // core, which is exactly the pre-ADR behaviour.
  const layersProviderHandle = registerBindingProvider(
    host,
    vectorGraphicEditContext.type,
    layersProvider.provider,
  );
  // Phase 8 — SVG interchange (K-2): an `.svg` importer (parse → insert
  // the shapes through the existing insertPath lane) + an `.svg` exporter
  // (selection → SVG bytes). Capability-gated; degrades honestly when the
  // host predates the importer/exporter doors.
  const svgIoSub = contributeSvgIo(host);
  host.log.info(
    `activated — ${tools.length} tools + 2 schema panels + 6 React panels + ` +
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
        SYMBOLS_COMMAND_IDS.length +
        LIVE_PAINT_COMMAND_IDS.length +
        OPACITY_MASK_COMMAND_IDS.length +
        TEXT_ON_PATH_COMMAND_IDS.length +
        SELECT_SAME_COMMAND_IDS.length +
        INSERT_SHAPE_COMMAND_IDS.length +
        IMAGE_TRACE_COMMAND_IDS.length +
        2 // blendSelected + selectParentGroup
      } commands + 1 edit context + ` +
      `${layersProviderHandle ? 1 : 0} binding providers ` +
      `(apiVersion ${manifest.apiVersion})`,
  );
  // The contributions tear down structurally via the host; the binding
  // subscriptions are allocated OUTSIDE a facade-tracked registration,
  // so dispose them (and the command groups) here.
  return {
    dispose() {
      // ADR 023 — disposing the provider handle removes the provider
      // WITHOUT touching the edit context it borrowed activation from.
      // That separation is what makes phase D a migration with a
      // rollback point rather than a deletion.
      layersProviderHandle?.dispose();
      svgIoSub.dispose();
      imageTraceCommandSub.dispose();
      selectParentGroupCommandSub.dispose();
      blendCommandSub.dispose();
      insertShapeCommandsSub.dispose();
      selectSameCommandsSub.dispose();
      textOnPathCommandsSub.dispose();
      opacityMaskCommandsSub.dispose();
      livePaintCommandsSub.dispose();
      symbolCommandsSub.dispose();
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
