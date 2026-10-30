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

// PLUGIN SURFACE — paged.draw.
//
// WHY THIS TIER EXISTS, SEPARATE FROM THE JOURNEYS.
//
//   The journey tier asks "can a designer do the job" and drives a few
//   deep verticals. This tier asks the question `scripts/surface-coverage.mjs`
//   asks: of the 131 things `@paged-media/draw`'s manifest DECLARES it
//   injects, how many has any spec ever met? Before this file the answer
//   was 39 — the worst of the eight loaded bundles — which means 92 of the
//   things a user can reach had never been named, let alone exercised.
//
//   The tool rail already shipped that exact defect once: fifteen of
//   thirty-one rail entries accepted a click and silently did nothing.
//   A slot nobody has ever selected is the shape of that bug, and only a
//   gate that COUNTS SLOTS catches it. So the first three tests here are
//   deliberately broad rather than deep — registry parity, every tool
//   reachable in the rail, every panel openable — and the rest go after
//   the highest-value commands the journeys never touched.
//
// WHAT THE MANIFEST DECLARES (the resolved bundle the app loads:
// `apps/canvas/node_modules/@paged-media/draw/manifest.json`, v0.5.0;
// grown by canary.12's path-options panel, its eight "…Options" verbs and
// Reverse path direction, then canary.14's Knife, Scissors (any point),
// Reflect, Transform again, Create outlines and the Dashes…/Reflect…
// sections):
//   21 tools · 10 panels · 107 commands · 1 importer · 1 exporter ·
//   7 partTypes · 1 editContext  =  147 contributions.
//
// THE ID LISTS BELOW ARE TRANSCRIBED FROM THAT MANIFEST ON PURPOSE.
//   Reading the manifest at runtime would name zero ids in this file, and
//   the coverage gate greps the spec text. A hard-coded list also fails
//   LOUDLY when the published bundle adds or renames a contribution — see
//   the parity assertion in the first test, which is the thing that keeps
//   these lists honest.

import { expect, test } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { mutate } from "../e2e/harness/ui";
import { dragMouse, screenPoint } from "../e2e/harness/viewport";
import { Designer } from "../journey/driver/designer";

type Page = import("@playwright/test").Page;

// ── the declared surface ────────────────────────────────────────────

const TOOLS = [
  "media.paged.draw.tool.addAnchor",
  "media.paged.draw.tool.deleteAnchor",
  "media.paged.draw.tool.convertAnchor",
  "media.paged.draw.tool.curvature",
  "media.paged.draw.tool.gradientAnnotator",
  "media.paged.draw.tool.measure",
  "media.paged.draw.tool.shapeBuilder",
  "media.paged.draw.tool.cornerRadius",
  "media.paged.draw.tool.paintbrush",
  "media.paged.draw.tool.blobBrush",
  "media.paged.draw.tool.eraserBrush",
  "media.paged.draw.tool.eyedropper",
  "media.paged.draw.tool.width",
  "media.paged.draw.tool.lassoSelect",
  "media.paged.draw.tool.livePaintBucket",
  "media.paged.draw.tool.livePaintSelect",
  "media.paged.draw.tool.typeOnPath",
  "media.paged.draw.tool.repeat",
  // canary.14 — the cutting pair in the host's Scissors flyout (driven
  // end to end in journey/plugins/draw-tools.journey.spec.ts).
  "media.paged.draw.tool.knife",
  "media.paged.draw.tool.scissorsAnyPoint",
  // WP6.1 — keyless, in the host's transform / pencil / shape flyouts.
  "media.paged.draw.tool.reflect",
  "media.paged.draw.tool.reshape",
  "media.paged.draw.tool.shaper",
  "media.paged.draw.tool.pathEraser",
  "media.paged.draw.tool.join",
  "media.paged.draw.tool.star",
  "media.paged.draw.tool.flare",
  // WP6.7 — keyless: the Liquify flyout, Puppet Warp in the host's Free
  // Transform flyout, the Perspective pair in a flyout of their own.
  "media.paged.draw.tool.warp",
  "media.paged.draw.tool.twirl",
  "media.paged.draw.tool.pucker",
  "media.paged.draw.tool.bloat",
  "media.paged.draw.tool.scallop",
  "media.paged.draw.tool.crystallize",
  "media.paged.draw.tool.wrinkle",
  "media.paged.draw.tool.puppetWarp",
  "media.paged.draw.tool.perspectiveGrid",
  "media.paged.draw.tool.perspectiveSelect",
  // WP6.8 — keyless: the Symbolism flyout (Sprayer, six modifiers and the
  // 9-Slice Guides tool), draw ADR 365.
  "media.paged.draw.tool.symbolSprayer",
  "media.paged.draw.tool.symbolShifter",
  "media.paged.draw.tool.symbolScruncher",
  "media.paged.draw.tool.symbolSizer",
  "media.paged.draw.tool.symbolSpinner",
  "media.paged.draw.tool.symbolStainer",
  "media.paged.draw.tool.symbolScreener",
  "media.paged.draw.tool.symbolNineSlice",
] as const;

// "Vector stroke" (`panel.stroke`) and "Vector fill" (`panel.fill`) are
// no longer contributed: every row they carried is a core frame property,
// and the host's Stroke, Object Options and Gradients panels carry them
// (asserted ABSENT below, driven in journey/plugins/draw-panels).
const RETIRED_PANELS = [
  "media.paged.draw.panel.stroke",
  "media.paged.draw.panel.fill",
] as const;

const PANELS = [
  "media.paged.draw.panel.appearance",
  "media.paged.draw.panel.graphicStyles",
  "media.paged.draw.panel.symbols",
  "media.paged.draw.panel.livePaint",
  "media.paged.draw.panel.pattern",
  "media.paged.draw.panel.repeat",
  "media.paged.draw.panel.blend",
  "media.paged.draw.panel.objectsOnPath",
  "media.paged.draw.panel.pathOptions",
  // WP6.6 / WP6.5 — Image Trace options, Recolor Artwork, Color Guide.
  "media.paged.draw.panel.imageTrace",
  "media.paged.draw.panel.recolorArtwork",
  "media.paged.draw.panel.colorGuide",
  "media.paged.draw.panel.properties",
] as const;

const COMMANDS = [
  "media.paged.draw.command.strokeDashSolid",
  "media.paged.draw.command.strokeDashDashed",
  "media.paged.draw.command.strokeDashDotted",
  "media.paged.draw.command.strokeDashDashDot",
  "media.paged.draw.command.fillGradientLinear",
  "media.paged.draw.command.fillGradientRadial",
  "media.paged.draw.command.outlineStroke",
  "media.paged.draw.command.offsetPath",
  "media.paged.draw.command.simplifyPath",
  "media.paged.draw.command.joinEndpoints",
  "media.paged.draw.command.closePath",
  "media.paged.draw.command.averageEndpoints",
  "media.paged.draw.command.pathfinderUnite",
  "media.paged.draw.command.pathfinderSubtract",
  "media.paged.draw.command.pathfinderIntersect",
  "media.paged.draw.command.pathfinderExclude",
  "media.paged.draw.command.pathfinderDivide",
  "media.paged.draw.command.pathfinderTrim",
  "media.paged.draw.command.pathfinderMerge",
  "media.paged.draw.command.pathfinderCrop",
  "media.paged.draw.command.pathfinderOutline",
  "media.paged.draw.command.pathfinderMinusBack",
  "media.paged.draw.command.makeCompoundPath",
  "media.paged.draw.command.releaseCompoundPath",
  "media.paged.draw.command.makePatternFromSelection",
  "media.paged.draw.command.editPatternField",
  "media.paged.draw.command.selectPatternTiles",
  "media.paged.draw.command.deletePatternTiles",
  "media.paged.draw.command.releasePatternField",
  "media.paged.draw.command.makeRadialRepeat",
  "media.paged.draw.command.makeGridRepeat",
  "media.paged.draw.command.makeMirrorRepeat",
  "media.paged.draw.command.updateRepeat",
  "media.paged.draw.command.selectRepeatInstances",
  "media.paged.draw.command.expandRepeat",
  "media.paged.draw.command.releaseRepeat",
  "media.paged.draw.command.cornersRounded",
  "media.paged.draw.command.cornersInverseRounded",
  "media.paged.draw.command.cornersBevel",
  "media.paged.draw.command.cornersFancy",
  "media.paged.draw.command.cornersNone",
  "media.paged.draw.command.appearanceAddFill",
  "media.paged.draw.command.appearanceAddStroke",
  "media.paged.draw.command.appearanceClear",
  "media.paged.draw.command.appearanceRemoveLayer",
  "media.paged.draw.command.appearanceMoveLayer",
  "media.paged.draw.command.bakeAppearance",
  "media.paged.draw.command.releaseAppearance",
  "media.paged.draw.command.saveGraphicStyle",
  "media.paged.draw.command.applyGraphicStyle",
  "media.paged.draw.command.redefineGraphicStyle",
  "media.paged.draw.command.breakGraphicStyleLink",
  "media.paged.draw.command.renameGraphicStyle",
  "media.paged.draw.command.deleteGraphicStyle",
  "media.paged.draw.command.defineSymbol",
  "media.paged.draw.command.placeSymbolInstance",
  "media.paged.draw.command.redefineSymbol",
  "media.paged.draw.command.breakSymbolLink",
  "media.paged.draw.command.resetSymbolTransform",
  "media.paged.draw.command.renameSymbol",
  "media.paged.draw.command.deleteSymbol",
  // WP6.8 — Replace Symbol and Symbol Options (engine symbols).
  "media.paged.draw.command.replaceSymbol",
  "media.paged.draw.command.symbolOptions",
  "media.paged.draw.command.makeLivePaintGroup",
  "media.paged.draw.command.fillLivePaintFace",
  "media.paged.draw.command.regenerateLivePaint",
  "media.paged.draw.command.selectLivePaintFaces",
  "media.paged.draw.command.deleteLivePaintFace",
  "media.paged.draw.command.releaseLivePaint",
  "media.paged.draw.command.makeOpacityMask",
  "media.paged.draw.command.releaseOpacityMask",
  "media.paged.draw.command.attachTextToPath",
  "media.paged.draw.command.detachTextFromPath",
  "media.paged.draw.command.selectSameFill",
  "media.paged.draw.command.selectSameStroke",
  "media.paged.draw.command.selectSameStrokeWeight",
  // WP6.1 — Select same past paint, and Global Edit (the selection half).
  "media.paged.draw.command.selectSameOpacity",
  "media.paged.draw.command.selectSameBlendMode",
  "media.paged.draw.command.selectSameAppearance",
  "media.paged.draw.command.selectSameGraphicStyle",
  "media.paged.draw.command.selectSameSymbolInstance",
  "media.paged.draw.command.selectSameShapeKind",
  "media.paged.draw.command.globalEdit",
  "media.paged.draw.command.insertArc",
  "media.paged.draw.command.insertSpiral",
  "media.paged.draw.command.insertRectGrid",
  "media.paged.draw.command.insertPolarGrid",
  "media.paged.draw.command.blendSelected",
  "media.paged.draw.command.updateBlend",
  "media.paged.draw.command.replaceBlendSpine",
  "media.paged.draw.command.reverseBlendSpine",
  "media.paged.draw.command.reverseBlendFrontToBack",
  "media.paged.draw.command.selectBlendObjects",
  "media.paged.draw.command.expandBlend",
  "media.paged.draw.command.releaseBlend",
  "media.paged.draw.command.makeObjectsOnPath",
  "media.paged.draw.command.updateObjectsOnPath",
  "media.paged.draw.command.selectObjectsOnPath",
  "media.paged.draw.command.expandObjectsOnPath",
  "media.paged.draw.command.releaseObjectsOnPath",
  "media.paged.draw.command.imageTrace",
  // canary.12 — the parameter surfaces for verbs that used to run on
  // defaults only: each opens the path-options panel at its section.
  "media.paged.draw.command.offsetPathOptions",
  "media.paged.draw.command.simplifyPathOptions",
  "media.paged.draw.command.outlineStrokeOptions",
  "media.paged.draw.command.insertArcOptions",
  "media.paged.draw.command.insertSpiralOptions",
  "media.paged.draw.command.insertRectGridOptions",
  "media.paged.draw.command.insertPolarGridOptions",
  "media.paged.draw.command.selectSameStrokeWeightOptions",
  "media.paged.draw.command.reversePathDirection",
  // canary.14 — Dashes… / Reflect… raise their Path Options sections;
  // Reflect / Transform again (journey/plugins/draw-transform), Create
  // outlines (journey/plugins/draw-outlines), Dashes… (draw-dash).
  "media.paged.draw.command.strokeDashOptions",
  "media.paged.draw.command.reflectOptions",
  "media.paged.draw.command.createOutlines",
  "media.paged.draw.command.reflectHorizontal",
  "media.paged.draw.command.reflectVertical",
  "media.paged.draw.command.transformAgain",
  // G4 — the tool-only cuts as commands, the width profile as data, and
  // the update of the recipes a changed source feeds.
  "media.paged.draw.command.knife",
  "media.paged.draw.command.scissorsAt",
  "media.paged.draw.command.shapeBuild",
  "media.paged.draw.command.widthProfile",
  "media.paged.draw.command.updateLinkedRecipes",
  // WP6.1 (tools' commands, Select same, Global Edit), WP6.6 (Re-trace,
  // Image Trace options) and WP6.5 (Recolor Artwork, the Color Guide).
  "media.paged.draw.command.insertStarOptions",
  "media.paged.draw.command.insertFlareOptions",
  "media.paged.draw.command.joinScrub",
  "media.paged.draw.command.pathErase",
  "media.paged.draw.command.reshapeAt",
  "media.paged.draw.command.shaperStroke",
  "media.paged.draw.command.insertStar",
  "media.paged.draw.command.insertFlare",
  "media.paged.draw.command.retraceImage",
  "media.paged.draw.command.imageTraceOptions",
  "media.paged.draw.command.recolorArtwork",
  "media.paged.draw.command.recolorArtworkOptions",
  "media.paged.draw.command.applyGuideColor",
  // Object ▸ Rasterize (extensions ADR 338) and its "…" raiser.
  "media.paged.draw.command.rasterize",
  "media.paged.draw.command.rasterizeOptions",
  // WP6.7 — the distortion tools' gestures as data, the Puppet Warp tool
  // switch, and the perspective grid's View / Object verbs.
  "media.paged.draw.command.liquifyStroke",
  "media.paged.draw.command.puppetWarp",
  "media.paged.draw.command.puppetWarpTool",
  "media.paged.draw.command.perspectiveShowGrid",
  "media.paged.draw.command.perspectiveHideGrid",
  "media.paged.draw.command.perspectiveLockGrid",
  "media.paged.draw.command.perspectiveUnlockGrid",
  "media.paged.draw.command.perspectiveOnePoint",
  "media.paged.draw.command.perspectiveTwoPoint",
  "media.paged.draw.command.perspectiveThreePoint",
  "media.paged.draw.command.perspectiveSetPlane",
  "media.paged.draw.command.attachToPerspective",
  "media.paged.draw.command.releaseFromPerspective",
  "media.paged.draw.command.moveOnPerspective",
  "media.paged.draw.command.drawOnPerspective",
] as const;

const IMPORTER = "media.paged.draw.importer.svg";
const EXPORTER = "media.paged.draw.exporter.svg";
const EDIT_CONTEXT = "vectorGraphic";

/** The eight `contributes.partTypes[]` this bundle persists into the
 *  `.paged` container. They are declared capability, not runtime
 *  registry rows — there is no host part-type registry to read them
 *  back from — so this list exists to NAME them (the coverage gate's
 *  unit) and to pin the count the manifest promises. */
const PART_TYPES = [
  "graphicStyleLibrary",
  "symbolLibrary",
  "livePaintRecipe",
  "patternRecipe",
  "repeatRecipe",
  "blendRecipe",
  "objectsOnPathRecipe",
  // WP6.7 — the per-page perspective grids (ADR 363).
  "perspectiveGrid",
] as const;

/** Rail slot (`data-tool-slot`) each tool lands in. `pen`, `type` and
 *  `eyedropper` are shared with HOST tools — the draw entry is then a
 *  flyout member, not the slot face. */
const TOOL_SLOT: Record<string, string> = {
  "media.paged.draw.tool.addAnchor": "pen",
  "media.paged.draw.tool.deleteAnchor": "pen",
  "media.paged.draw.tool.convertAnchor": "pen",
  "media.paged.draw.tool.curvature": "pen",
  "media.paged.draw.tool.paintbrush": "pen",
  "media.paged.draw.tool.blobBrush": "pen",
  "media.paged.draw.tool.eraserBrush": "pen",
  "media.paged.draw.tool.gradientAnnotator": "gradientAnnotator",
  "media.paged.draw.tool.measure": "measure",
  "media.paged.draw.tool.shapeBuilder": "shapeBuilder",
  "media.paged.draw.tool.cornerRadius": "cornerRadius",
  "media.paged.draw.tool.eyedropper": "eyedropper",
  "media.paged.draw.tool.width": "width",
  "media.paged.draw.tool.lassoSelect": "lassoSelect",
  "media.paged.draw.tool.livePaintBucket": "livePaintBucket",
  "media.paged.draw.tool.livePaintSelect": "livePaintSelect",
  "media.paged.draw.tool.typeOnPath": "type",
  "media.paged.draw.tool.repeat": "repeat",
  "media.paged.draw.tool.knife": "scissors",
  "media.paged.draw.tool.scissorsAnyPoint": "scissors",
  "media.paged.draw.tool.reflect": "transform",
  "media.paged.draw.tool.reshape": "transform",
  "media.paged.draw.tool.shaper": "pencil",
  "media.paged.draw.tool.pathEraser": "pencil",
  "media.paged.draw.tool.join": "pencil",
  "media.paged.draw.tool.star": "shape",
  "media.paged.draw.tool.flare": "shape",
  "media.paged.draw.tool.warp": "liquify",
  "media.paged.draw.tool.twirl": "liquify",
  "media.paged.draw.tool.pucker": "liquify",
  "media.paged.draw.tool.bloat": "liquify",
  "media.paged.draw.tool.scallop": "liquify",
  "media.paged.draw.tool.crystallize": "liquify",
  "media.paged.draw.tool.wrinkle": "liquify",
  "media.paged.draw.tool.puppetWarp": "transform",
  "media.paged.draw.tool.perspectiveGrid": "perspective",
  "media.paged.draw.tool.perspectiveSelect": "perspective",
  "media.paged.draw.tool.symbolSprayer": "symbolism",
  "media.paged.draw.tool.symbolShifter": "symbolism",
  "media.paged.draw.tool.symbolScruncher": "symbolism",
  "media.paged.draw.tool.symbolSizer": "symbolism",
  "media.paged.draw.tool.symbolSpinner": "symbolism",
  "media.paged.draw.tool.symbolStainer": "symbolism",
  "media.paged.draw.tool.symbolScreener": "symbolism",
  "media.paged.draw.tool.symbolNineSlice": "symbolism",
};

/** Root DOM marker each panel renders. The SCHEMA panel ("Draw
 *  settings") comes from the host catalog renderer; the nine React panels
 *  stamp their own. */
const PANEL_MARKER: Record<string, string> = {
  "media.paged.draw.panel.appearance": "[data-draw-appearance-panel]",
  "media.paged.draw.panel.graphicStyles": "[data-draw-graphic-styles-panel]",
  "media.paged.draw.panel.symbols": "[data-draw-symbols-panel]",
  "media.paged.draw.panel.livePaint": "[data-draw-live-paint-panel]",
  "media.paged.draw.panel.pattern": "[data-draw-pattern-panel]",
  "media.paged.draw.panel.repeat": "[data-draw-repeat-panel]",
  "media.paged.draw.panel.blend": "[data-draw-blend-panel]",
  "media.paged.draw.panel.objectsOnPath": "[data-draw-onpath-panel]",
  "media.paged.draw.panel.pathOptions": "[data-draw-pathopts-panel]",
  "media.paged.draw.panel.imageTrace": "[data-draw-image-trace-panel]",
  "media.paged.draw.panel.recolorArtwork": "[data-draw-recolor-panel]",
  "media.paged.draw.panel.colorGuide": "[data-draw-color-guide-panel]",
  // ADR 323 — object properties as host PropertyFields (a schema panel).
  "media.paged.draw.panel.properties":
    '[data-schema-panel="media.paged.draw.panel.properties"]',
};

// ── helpers ─────────────────────────────────────────────────────────

interface RegistrySnapshot {
  tools: string[];
  panels: string[];
  commands: string[];
  importers: string[];
  exporters: string[];
  editContexts: string[];
}

async function registrySnapshot(page: Page): Promise<RegistrySnapshot> {
  return page.evaluate(() => {
    const r = (
      globalThis as unknown as {
        __canvas: {
          registries: {
            tools: { list: () => Array<{ id: string }> };
            panels: { list: () => Array<{ id: string }> };
            commands: { list: () => Array<{ id: string }> };
            importers: { list: () => Array<{ id: string }> };
            exporters: { list: () => Array<{ id: string }> };
            editContexts: { list: () => Array<{ type: string }> };
          };
        };
      }
    ).__canvas.registries;
    return {
      tools: r.tools.list().map((t) => t.id),
      panels: r.panels.list().map((p) => p.id),
      commands: r.commands.list().map((c) => c.id),
      importers: r.importers.list().map((i) => i.id),
      exporters: r.exporters.list().map((e) => e.id),
      editContexts: r.editContexts.list().map((e) => e.type),
    };
  });
}

/** Command titles + categories as the palette would show them. */
async function commandMeta(
  page: Page,
): Promise<Array<{ id: string; title: string; category: string }>> {
  return page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: {
          registries: {
            commands: {
              list: () => Array<{
                id: string;
                title: string;
                category?: string;
              }>;
            };
          };
        };
      }
    ).__canvas.registries.commands
      .list()
      .map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category ?? "Other",
      })),
  );
}

/** The panel ids the cockpit currently holds as right-dock tabs. */
const openPanels = (page: Page) =>
  page.evaluate(() => {
    const p = (
      globalThis as unknown as {
        __canvas: {
          debugContext: () => {
            panels: { open: string[]; active: string | null };
          };
        };
      }
    ).__canvas.debugContext().panels;
    return [p.active, ...p.open].filter(Boolean) as string[];
  });

/** The tool the RAIL is acting as.
 *
 *  NOT `__canvas.activeTool` — that field is `legacyToolFor(effective)`,
 *  a mapping onto the pre-registry tool names, and it answers "select"
 *  for every plugin tool no matter which one is live. A spec asserting
 *  it would report all 19 draw tools as refusing activation when in
 *  fact all 19 activate. `debugContext().tools.effective` is the value
 *  the canvas dispatches pointer events on. */
const effectiveTool = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: {
            debugContext: () => { tools: { effective: string | null } };
          };
        }
      ).__canvas.debugContext().tools.effective,
  );

/** A content digest of the whole document, taken through the real IDML
 *  export. This is the only oracle that sees an IN-PLACE geometry
 *  rewrite: `pathfinderTrim` removes the hidden part of the object
 *  BEHIND, which by construction changes no pixel and keeps every
 *  element id — a render diff and an id-set diff both read it as a
 *  no-op, and calling it one would be wrong (the export shrinks by the
 *  anchors it dropped). */
const documentDigest = (page: Page) =>
  page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: { client: { exportIdml: () => Promise<Uint8Array> } };
      }
    ).__canvas;
    const bytes = await c.client.exportIdml();
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619);
    }
    return `${bytes.byteLength}:${(h >>> 0).toString(16)}`;
  });

/** Dismiss an open tool flyout the way a user does — a pointer-down
 *  somewhere else. Escape is NOT wired to the flyout. */
async function dismissFlyout(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    ),
  );
  await page.waitForTimeout(30);
}

/**
 * Close and re-open a panel.
 *
 * THIS IS A WORKAROUND FOR A REPORTED DEFECT, not a convenience. draw's
 * library panels (Repeat, Symbols, Live Paint, Pattern, Blend, Objects
 * on Path) read their record list when they MOUNT and never re-read it
 * when the underlying recipe part is written from outside. Run
 * `makeRadialRepeat` from the command palette — the ONLY host-wide home
 * a plugin command has, since the contract ships no `contribute.menu` —
 * and the Repeat panel still says "REPEATS (0) · No repeats yet" while
 * its own `data-draw-repeat-active` attribute already names `rep-1`.
 * Every follow-up verb (Update / Select instances / Expand / Release) is
 * a row in that empty list, so they are unreachable until the panel is
 * closed and re-opened. Measured: 0 records after the command, 1 after
 * a re-open. The panel's OWN buttons refresh correctly — it is the
 * command → panel seam that is broken.
 *
 * The specs below re-open rather than assert the stale value, so this
 * file does not pin the bug in place as though it were the contract.
 */
async function reopenPanel(
  page: Page,
  designer: Designer,
  id: string,
): Promise<void> {
  await page.evaluate(
    (pid) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke: (id: string) => Promise<void> } };
          };
        }
      ).__canvas.registries.commands.invoke(`paged.panel.hide.${pid}`),
    id,
  );
  await page.waitForTimeout(200);
  await designer.openPanel(id);
  await page.waitForTimeout(400);
}

/** Invoke a plugin tool's activation command (the id the SDK's
 *  `contributeTool` mints alongside the rail entry). */
async function activateToolCommand(page: Page, toolId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const cmd = (
      globalThis as unknown as {
        __canvas: {
          registries: { commands: { invoke: (id: string) => Promise<void> } };
        };
      }
    ).__canvas.registries.commands;
    await cmd.invoke(`paged.tool.activate.${id}`);
  }, toolId);
}

/** Invoke a command with a payload (the panel rows' path: a symbol id,
 *  a page point). */
async function runWithPayload(
  page: Page,
  id: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ({ id, payload }) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: {
              commands: {
                invoke(id: string, payload?: unknown): Promise<unknown>;
              };
            };
          };
        }
      ).__canvas.registries.commands.invoke(id, payload),
    { id, payload },
  );
}

/** All element ids of one kind, in document order. */
async function idsOfKind(page: Page, kind: string): Promise<string[]> {
  return page.evaluate(async (k) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            executeScript: (
              s: string,
            ) => Promise<{ output: string[]; error: string | null }>;
          };
        };
      }
    ).__canvas;
    const r = await c.client.executeScript("paged.tree()");
    const tree = JSON.parse(r.output[0] ?? "[]") as Array<{
      id?: { kind: string; id: string } | null;
      children?: unknown[];
    }>;
    const out: string[] = [];
    const visit = (n: {
      id?: { kind: string; id: string } | null;
      children?: unknown[];
    }) => {
      if (n.id && n.id.kind === k) out.push(n.id.id);
      for (const ch of (n.children ?? []) as typeof tree) visit(ch);
    };
    for (const root of tree) visit(root);
    return out;
  }, kind);
}

/** Total page items across the kinds paged.draw mints. */
async function artworkCount(page: Page): Promise<number> {
  let n = 0;
  // A symbol instance is a page item of its own (engine ADR 1039).
  for (const kind of [
    "polygon",
    "rectangle",
    "oval",
    "graphicLine",
    "instance",
  ]) {
    n += (await idsOfKind(page, kind)).length;
  }
  return n;
}

// ── 1. registry parity ──────────────────────────────────────────────

test.describe("plugin surface · paged.draw", () => {
  test("every contribution the manifest declares reaches a host registry @feat:plugin-draw.bundle-manifest @feat:plugin-platform.bundle-lifecycle @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    const reg = await registrySnapshot(page);

    // TOOLS — all 45 registered.
    const missingTools = TOOLS.filter((id) => !reg.tools.includes(id));
    expect(missingTools, "every declared tool is in the tool registry").toEqual(
      [],
    );

    // PANELS — all 10 registered.
    const missingPanels = PANELS.filter((id) => !reg.panels.includes(id));
    expect(
      missingPanels,
      "every declared panel is in the panel registry",
    ).toEqual([]);
    // …and the two merged into the host's panels are gone, so the user
    // never sees two Stroke panels for one stroke.
    const lingering = RETIRED_PANELS.filter((id) => reg.panels.includes(id));
    expect(
      lingering,
      "Vector stroke / Vector fill are no longer registered",
    ).toEqual([]);

    // COMMANDS — all 151 registered.
    const missingCommands = COMMANDS.filter((id) => !reg.commands.includes(id));
    expect(
      missingCommands,
      "every declared command is in the command registry",
    ).toEqual([]);

    // IMPORTER / EXPORTER / EDIT CONTEXT.
    expect(reg.importers, "the SVG importer registered").toContain(IMPORTER);
    expect(reg.exporters, "the SVG exporter registered").toContain(EXPORTER);
    expect(
      reg.editContexts,
      "the vectorGraphic edit context registered",
    ).toContain(EDIT_CONTEXT);

    // PART TYPES — declared-only capability (no host registry mirrors
    // them). Pin the count so a manifest that grows a part type without
    // a spec noticing still trips something.
    expect(PART_TYPES).toHaveLength(8);

    // PARITY THE OTHER WAY. The lists above are transcribed by hand;
    // a bundle that GAINS a contribution must not slip past unnamed,
    // which is the exact failure mode the surface-coverage gate exists
    // to stop. Anything the bundle registered under its own namespace
    // that this file does not list is a gap in this file.
    const declared = new Set<string>([...TOOLS, ...PANELS, ...COMMANDS]);
    const registeredByDraw = [
      ...reg.tools,
      ...reg.panels,
      ...reg.commands,
    ].filter((id) => id.startsWith("media.paged.draw."));
    const unlisted = registeredByDraw.filter((id) => !declared.has(id));
    expect(
      unlisted,
      "the bundle registered something this spec does not name — add it here",
    ).toEqual([]);

    // And the totals the campaign quotes, so a silent shrink is loud.
    // 20 since the Pencil became the host's alone (draw ADR 359).
    expect(TOOLS).toHaveLength(45);
    expect(PANELS).toHaveLength(13);
    expect(COMMANDS).toHaveLength(151);
  });

  // ── 2. the rail ───────────────────────────────────────────────────

  test("all 45 tools reach the tool rail and activate @feat:plugin-platform.tool-registration @feat:plugin-platform.bundle-lifecycle @level:gesture", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // REACHABLE — each tool is either the face of its slot or one
    // right-click away in that slot's flyout. A registered tool with no
    // rail entry is unreachable by pointer, which is the defect the rail
    // shipped before: an affordance the user cannot find.
    const unreachable: string[] = [];
    for (const id of TOOLS) {
      const slot = TOOL_SLOT[id];
      const slotButton = page.locator(`[data-tool-slot="${slot}"]`);
      if ((await slotButton.count()) === 0) {
        unreachable.push(`${id} (no slot "${slot}")`);
        continue;
      }
      if ((await page.locator(`[data-tool="${id}"]`).count()) > 0) continue;
      // Not the face — open the flyout (right-click, the rail's own
      // affordance) and look for it there.
      await slotButton.first().click({ button: "right" });
      const member = page.locator(
        `[data-tool-flyout="${slot}"] [data-tool="${id}"]`,
      );
      if ((await member.count()) === 0)
        unreachable.push(`${id} (not in "${slot}" flyout)`);
      await dismissFlyout(page);
    }
    expect(unreachable, "every declared tool has a rail entry").toEqual([]);

    // ACTIVATES — invoking the activation command the rail's own click
    // handler dispatches makes each tool the effective tool. A tool that
    // registers but refuses activation is the silent-dead-slot bug.
    const refused: string[] = [];
    for (const id of TOOLS) {
      await activateToolCommand(page, id);
      const got = await effectiveTool(page);
      if (got !== id) refused.push(`${id} → ${got}`);
    }
    expect(refused, "every declared tool becomes the effective tool").toEqual(
      [],
    );
  });

  // ── 3. the panels ─────────────────────────────────────────────────

  test("all 10 panels open as dock tabs and mount their body @feat:plugin-platform.panel-registration @feat:plugin-platform.bundle-lifecycle @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // Give the selection-driven panels something to resolve against so
    // a panel that guards on "no selection" still renders its body.
    const rectId = await designer.drawRectangle({
      x0: 150,
      y0: 150,
      x1: 380,
      y1: 320,
    });
    expect(rectId, "drew a rectangle to select").not.toBe("");
    await designer.applyFill("rectangle", rectId);
    await designer.selectElement("rectangle", rectId);

    const failures: string[] = [];
    for (const id of PANELS) {
      await designer.openPanel(id);
      try {
        await expect
          .poll(async () => (await openPanels(page)).includes(id), {
            timeout: 8_000,
          })
          .toBe(true);
        await expect(page.locator(PANEL_MARKER[id]).first()).toBeVisible({
          timeout: 8_000,
        });
      } catch (err) {
        failures.push(`${id}: ${String(err).split("\n")[0]}`);
      }
    }
    expect(failures, "every declared panel opens and mounts").toEqual([]);
  });

  // ── 4. Insert ─────────────────────────────────────────────────────

  test("the four Insert commands mint real paths @feat:plugin-draw.tool-wave-2 @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // Each command carries its own defaults (arc 270°/r100, spiral 3
    // turns, 4x4 rect grid = 10 lines, polar grid 3 rings + 6 radials =
    // 9 paths), so they are payload-free from the palette — which is the
    // only place a user can reach them.
    const expectations: Array<[string, number]> = [
      ["media.paged.draw.command.insertArc", 1],
      ["media.paged.draw.command.insertSpiral", 1],
      ["media.paged.draw.command.insertRectGrid", 10],
      ["media.paged.draw.command.insertPolarGrid", 9],
    ];

    const before = await designer.renderBytes();
    for (const [id, minNew] of expectations) {
      const n0 = (await idsOfKind(page, "polygon")).length;
      await designer.runCommand(id);
      await expect
        .poll(async () => (await idsOfKind(page, "polygon")).length, {
          timeout: 10_000,
        })
        .toBeGreaterThanOrEqual(n0 + minNew);
    }
    // 21 new paths carrying the document's default paint move real ink.
    const after = await designer.renderBytes();
    await designer.expectRenderChanged(before, after);
  });

  // ── 5. compound paths + the untested pathfinder ops ───────────────

  test("compound path and the six remaining pathfinder ops rewrite the artwork @feat:plugin-draw.pro-path-toolset @feat:plugin-draw.compound-paths @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    /** Two overlapping filled rectangles, back one first. */
    const pair = async (y: number) => {
      const back = await designer.drawRectangle({
        x0: 120,
        y0: y,
        x1: 300,
        y1: y + 120,
      });
      const front = await designer.drawRectangle({
        x0: 220,
        y0: y + 40,
        x1: 400,
        y1: y + 160,
      });
      await designer.applyFill("rectangle", back);
      await designer.applyFill("rectangle", front, "Color/Paper");
      await designer.selectElements([
        { kind: "rectangle", id: back },
        { kind: "rectangle", id: front },
      ]);
      return [back, front];
    };

    // ── COMPOUND PATH — two rectangles become one element, then the
    //    release puts them back. Element COUNT is the oracle: a
    //    compound path is fewer page items than its operands. ──
    await pair(120);
    const beforeCompound = await artworkCount(page);
    await designer.runCommand("media.paged.draw.command.makeCompoundPath");
    await expect
      .poll(() => artworkCount(page), { timeout: 10_000 })
      .toBeLessThan(beforeCompound);
    await designer.runCommand("media.paged.draw.command.releaseCompoundPath");

    // ── THE SIX PATHFINDER OPS the journeys never drove. Each runs on
    //    its own fresh overlapping pair; collected per-op so one refused
    //    op does not hide the other five.
    //
    //    THE ORACLE IS THE EXPORTED DOCUMENT, not the render. Trim
    //    removes the hidden part of the object BEHIND — an operation
    //    that is invisible BY DEFINITION and keeps both element ids, so
    //    a pixel diff and an id-set diff both call it a no-op and both
    //    are wrong. Measured directly: with the front object filled the
    //    render moves 0 px while the exported IDML drops from 3,336 to
    //    3,323 bytes, and with the front object UNFILLED the same op
    //    removes 11,449 px of ink. An export digest sees all six. ──
    const ops = [
      "media.paged.draw.command.pathfinderDivide",
      "media.paged.draw.command.pathfinderTrim",
      "media.paged.draw.command.pathfinderMerge",
      "media.paged.draw.command.pathfinderCrop",
      "media.paged.draw.command.pathfinderOutline",
      "media.paged.draw.command.pathfinderMinusBack",
    ];
    const inert: string[] = [];
    let y = 300;
    for (const op of ops) {
      await pair(y);
      y += 40;
      const before = await documentDigest(page);
      await designer.runCommand(op);
      await page.waitForTimeout(500);
      const after = await documentDigest(page);
      if (before === after)
        inert.push(`${op} (document byte-identical: ${before})`);
    }
    expect(inert, "every pathfinder op changes the document").toEqual([]);
  });

  // ── 6. the appearance stack ───────────────────────────────────────

  test("the appearance stack adds, reorders, removes, bakes and releases @feat:plugin-draw.appearance @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    const id = await designer.drawRectangle({
      x0: 150,
      y0: 150,
      x1: 400,
      y1: 330,
    });
    await designer.applyFill("rectangle", id);
    await designer.applyStroke("rectangle", id, "Color/Black", 4);
    await designer.selectElement("rectangle", id);
    await designer.openPanel("media.paged.draw.panel.appearance");
    const panel = page.locator("[data-draw-appearance-panel]");
    await expect(panel).toBeVisible({ timeout: 8_000 });

    /** The panel's root marker IS the layer count. */
    const layers = async () =>
      Number(
        (await panel.first().getAttribute("data-draw-appearance-panel")) ?? "0",
      );

    // ADD two layers on top of the frame's own paint.
    await designer.runCommand("media.paged.draw.command.appearanceAddFill");
    await designer.runCommand("media.paged.draw.command.appearanceAddStroke");
    await expect.poll(layers, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
    const stacked = await layers();

    // REORDER — the stack survives a move (the row order is what the
    // renderer paints in, so a move that silently no-ops is a defect).
    await designer.runCommand("media.paged.draw.command.appearanceMoveLayer");
    await expect.poll(layers, { timeout: 8_000 }).toBe(stacked);

    // BAKE → the stack becomes REAL stacked page items (a group of
    // derived paths), then RELEASE takes them away again.
    //
    // THE ORACLE IS THE ITEM COUNT, NOT THE PIXELS. A bake is a lossless
    // flatten: it renders identically by design, so `expectRenderChanged`
    // here would assert that a correct implementation is broken.
    // Measured: 2 page items → 5 on bake, back to 2 on release.
    const itemsBeforeBake = await artworkCount(page);
    await designer.runCommand("media.paged.draw.command.bakeAppearance");
    await expect
      .poll(
        async () =>
          (await panel.first().getAttribute("data-draw-appearance-baked")) ??
          "false",
        { timeout: 10_000 },
      )
      .toBe("true");
    await expect
      .poll(() => artworkCount(page), { timeout: 10_000 })
      .toBeGreaterThan(itemsBeforeBake);

    await designer.runCommand("media.paged.draw.command.releaseAppearance");
    await expect
      .poll(
        async () =>
          (await panel.first().getAttribute("data-draw-appearance-baked")) ??
          "false",
        { timeout: 10_000 },
      )
      .toBe("false");
    await expect
      .poll(() => artworkCount(page), { timeout: 10_000 })
      .toBe(itemsBeforeBake);

    // REMOVE + CLEAR bring the stack back to the frame's own paint.
    await designer.runCommand("media.paged.draw.command.appearanceRemoveLayer");
    await designer.runCommand("media.paged.draw.command.appearanceClear");
    await expect.poll(layers, { timeout: 8_000 }).toBeLessThan(stacked);
  });

  // ── 7. graphic styles + symbols ───────────────────────────────────

  test("a graphic style saves, applies and breaks; a symbol defines and places @feat:plugin-draw.graphic-styles @feat:plugin-draw.symbols @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    const source = await designer.drawRectangle({
      x0: 130,
      y0: 130,
      x1: 330,
      y1: 270,
    });
    await designer.applyFill("rectangle", source);
    await designer.applyStroke("rectangle", source, "Color/Black", 6);
    await designer.selectElement("rectangle", source);

    // ── GRAPHIC STYLES — the panel's root marker is the style count. ──
    await designer.openPanel("media.paged.draw.panel.graphicStyles");
    const styles = page.locator("[data-draw-graphic-styles-panel]");
    await expect(styles).toBeVisible({ timeout: 8_000 });
    const styleCount = async () =>
      Number(
        (await styles.first().getAttribute("data-draw-graphic-styles-panel")) ??
          "0",
      );

    await designer.runCommand("media.paged.draw.command.saveGraphicStyle");
    await expect.poll(styleCount, { timeout: 10_000 }).toBeGreaterThan(0);

    // The saved style LINKS the selection — the panel says which.
    await expect
      .poll(
        async () =>
          (await styles
            .first()
            .getAttribute("data-draw-graphic-style-linked")) ?? "",
        { timeout: 8_000 },
      )
      .not.toBe("");

    // Apply it to a SECOND rectangle through the panel's own row button
    // (the payload-bearing path — the command needs a style id, which
    // only the panel supplies).
    const target = await designer.drawRectangle({
      x0: 360,
      y0: 130,
      x1: 540,
      y1: 270,
    });
    await designer.selectElement("rectangle", target);
    const beforeApply = await designer.renderBytes();
    await styles.locator("[data-draw-graphic-style-apply]").first().click();
    await designer.expectRenderChangesFrom(beforeApply);

    // Redefine / break-link / rename / delete all run off the same rows.
    await styles.locator("[data-draw-graphic-style-redefine]").first().click();
    await page.waitForTimeout(300);
    await styles.locator("[data-draw-graphic-style-break]").first().click();
    await expect
      .poll(
        async () =>
          (await styles
            .first()
            .getAttribute("data-draw-graphic-style-linked")) ?? "",
        { timeout: 8_000 },
      )
      .toBe("");

    // ── SYMBOLS — define from the selection, then place an instance. ──
    await designer.selectElement("rectangle", source);
    await designer.openPanel("media.paged.draw.panel.symbols");
    const symbols = page.locator("[data-draw-symbols-panel]");
    await expect(symbols).toBeVisible({ timeout: 8_000 });
    const symbolCount = async () =>
      Number(
        (await symbols.first().getAttribute("data-draw-symbols-panel")) ?? "0",
      );

    await designer.runCommand("media.paged.draw.command.defineSymbol");
    // See `reopenPanel` — the command writes the definition, the panel
    // does not notice until it remounts.
    await reopenPanel(page, designer, "media.paged.draw.panel.symbols");
    await expect.poll(symbolCount, { timeout: 10_000 }).toBeGreaterThan(0);

    // Placing an instance is artwork: the page item count must grow.
    const itemsBefore = await artworkCount(page);
    await symbols.locator("[data-draw-symbol-place]").first().click();
    await expect
      .poll(() => artworkCount(page), { timeout: 10_000 })
      .toBeGreaterThan(itemsBefore);
  });

  // ── 7a. WP6.8 — the Symbolism tools on the canvas ─────────────────

  test("the Symbolism tools spray, shift, scrunch, size, spin, stain and screen instances, and the 9-Slice Guides tool drags a guide @feat:plugin-draw.symbols @level:gesture", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const source = await designer.drawRectangle({
      x0: 100,
      y0: 100,
      x1: 160,
      y1: 160,
    });
    await designer.applyFill("rectangle", source);
    await designer.selectElement("rectangle", source);
    await designer.runCommand("media.paged.draw.command.defineSymbol");
    type Row = { id: string; instances: string[]; nineSlice: number[] | null };
    const rows = async () =>
      (await designer.collection("symbols")) as unknown as Row[];
    await expect.poll(async () => (await rows()).length).toBe(1);
    const symbolId = (await rows())[0]!.id;
    await page.evaluate(
      async ([id]) => {
        await (
          globalThis as unknown as {
            __canvas: {
              registries: {
                commands: { invoke: (id: string, p: unknown) => Promise<void> };
              };
            };
          }
        ).__canvas.registries.commands.invoke(
          "media.paged.draw.command.placeSymbolInstance",
          { symbolId: id, x: 300, y: 300 },
        );
      },
      [symbolId],
    );
    await expect.poll(async () => (await rows())[0]!.instances.length).toBe(1);
    const instance = (await rows())[0]!.instances[0]!.slice("instance:".length);
    // What the instance carries now: its transform, tint and opacity.
    const carried = () =>
      page.evaluate(async (id) => {
        const props = await (
          globalThis as unknown as {
            __canvas: {
              client: {
                elementProperties: (id: unknown) => Promise<{
                  entries: { path: string; value: { value: unknown } }[];
                } | null>;
              };
            };
          }
        ).__canvas.client.elementProperties({ kind: "instance", id });
        const v = (path: string) =>
          props?.entries.find((e) => e.path === path)?.value?.value ?? null;
        return {
          t: v("frameTransform") as number[],
          tint: v("symbolInstanceTint") as number[],
          opacity: v("frameOpacity") as number | null,
        };
      }, instance);
    const stroke = async (from: [number, number], to: [number, number]) => {
      const a = await screenPoint(page, from[0], from[1]);
      const b = await screenPoint(page, to[0], to[1]);
      await dragMouse(page, a, b, { steps: 8 });
    };
    const S = "media.paged.draw.tool.symbol";

    covers("tool:media.paged.draw.tool.symbolSprayer");
    await activateToolCommand(page, `${S}Sprayer`);
    await stroke([150, 450], [260, 450]);
    // The first write on a cold dev server can take a while.
    await expect
      .poll(async () => (await rows())[0]!.instances.length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(1);

    covers("tool:media.paged.draw.tool.symbolShifter");
    covers("tool:media.paged.draw.tool.symbolScruncher");
    covers("tool:media.paged.draw.tool.symbolSizer");
    covers("tool:media.paged.draw.tool.symbolSpinner");
    covers("tool:media.paged.draw.tool.symbolStainer");
    covers("tool:media.paged.draw.tool.symbolScreener");
    const cases: [
      string,
      [number, number],
      [number, number],
      (
        b: Awaited<ReturnType<typeof carried>>,
        a: Awaited<ReturnType<typeof carried>>,
      ) => boolean,
    ][] = [
      ["Shifter", [300, 300], [320, 300], (b, a) => a.t[4]! > b.t[4]!],
      ["Scruncher", [320, 300], [322, 300], (b, a) => a.t[4]! !== b.t[4]!],
      ["Sizer", [300, 300], [302, 300], (b, a) => a.t[0]! > b.t[0]!],
      [
        "Spinner",
        [300, 300],
        [300, 330],
        (b, a) => Math.abs(a.t[1]! - b.t[1]!) > 1e-4,
      ],
      ["Stainer", [300, 300], [302, 300], (_b, a) => a.tint.length === 4],
      ["Screener", [300, 300], [302, 300], (_b, a) => (a.opacity ?? 100) < 100],
    ];
    for (const [name, from, to, changed] of cases) {
      await designer.selectElements([{ kind: "instance", id: instance }]);
      const before = await carried();
      await activateToolCommand(page, `${S}${name}`);
      const t = before.t;
      // Follow the instance: it may have moved under the earlier tools.
      const dx = t[4]! - 300;
      const dy = t[5]! - 300;
      await stroke([from[0] + dx, from[1] + dy], [to[0] + dx, to[1] + dy]);
      await expect
        .poll(async () => changed(before, await carried()), { timeout: 10_000 })
        .toBe(true);
    }

    // The 9-Slice Guides tool: the left guide of the selected instance's
    // symbol is drawn a quarter in; a drag sets the symbol's guides.
    covers("tool:media.paged.draw.tool.symbolNineSlice");
    await designer.selectElements([{ kind: "instance", id: instance }]);
    await activateToolCommand(page, `${S}NineSlice`);
    const now = await carried();
    const [a, b, c, d, e, f] = now.t;
    const sx = Math.hypot(a!, b!);
    // The definition is the 60 pt square centred on its origin: its left
    // edge at −30, the default guide 15 in, both through the instance.
    const at = (x: number, y: number): [number, number] => [
      a! * x + c! * y + e!,
      b! * x + d! * y + f!,
    ];
    const guide = at((-30 * sx + 15) / sx, 0);
    await stroke(guide, [guide[0] + 4, guide[1]]);
    await expect
      .poll(async () => (await rows())[0]!.nineSlice !== null, {
        timeout: 10_000,
      })
      .toBe(true);
  });

  // ── 7b. Select same past paint, and Global Edit ───────────────────

  test("Select same by opacity, blending mode, appearance, graphic style, symbol and shape kind, and Global Edit, select exactly the matches @feat:plugin-draw.select-same @level:happy", async ({
    page,
  }) => {
    covers("command:media.paged.draw.command.selectSameAppearance");
    covers("command:media.paged.draw.command.selectSameShapeKind");
    covers("command:media.paged.draw.command.globalEdit");
    covers("command:media.paged.draw.command.selectSameOpacity");
    covers("command:media.paged.draw.command.selectSameBlendMode");
    covers("command:media.paged.draw.command.selectSameGraphicStyle");
    covers("command:media.paged.draw.command.selectSameSymbolInstance");
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // Three rectangles of three different sizes and one pen path: r1 and
    // r2 painted alike, r3 red.
    const r1 = await designer.drawRectangle({
      x0: 80,
      y0: 90,
      x1: 200,
      y1: 200,
    });
    const r2 = await designer.drawRectangle({
      x0: 240,
      y0: 90,
      x1: 380,
      y1: 230,
    });
    const r3 = await designer.drawRectangle({
      x0: 420,
      y0: 90,
      x1: 520,
      y1: 170,
    });
    const p = await designer.drawPath([
      [100, 300],
      [220, 340],
      [160, 420],
    ]);
    for (const id of [r1, r2, r3, p]) expect(id, "drew the shape").not.toBe("");
    await designer.applyFill("rectangle", r1);
    await designer.applyFill("rectangle", r2);
    const red = await designer.createSwatch("select-same-red", [220, 20, 20]);
    await designer.applyFill("rectangle", r3, red);

    const rect = (id: string) => ({ kind: "rectangle", id });
    /** Select `refs`, run `command`, and wait for the selection it sets. */
    const selects = async (
      refs: Array<{ kind: string; id: string }>,
      command: string,
      expected: string[],
      message: string,
    ) => {
      await designer.selectElements(refs);
      await designer.runCommand(command);
      await expect
        .poll(
          async () =>
            (await designer.elementSelection()).map((e) => e.id).sort(),
          { message, timeout: 8_000 },
        )
        .toEqual([...expected].sort());
    };
    const C = "media.paged.draw.command";
    const setProperty = (
      id: string,
      path: "frameOpacity" | "frameBlendMode",
      value: number | string,
    ) =>
      mutate(page, {
        op: "setElementProperty",
        args: {
          elementId: rect(id),
          path,
          value:
            typeof value === "number"
              ? { type: "length", value }
              : { type: "text", value },
        },
      });

    // APPEARANCE — the complete paint: r2 shares r1's, red r3 does not.
    await designer.selectElements([rect(r1)]);
    await designer.runCommand(`${C}.selectSameAppearance`);
    await expect
      .poll(async () => (await designer.elementSelection()).map((e) => e.id), {
        timeout: 8_000,
      })
      .toContain(r2);
    const sameAppearance = (await designer.elementSelection()).map((e) => e.id);
    expect(sameAppearance, "the reference is in its own match").toContain(r1);
    expect(
      sameAppearance,
      "a red rectangle is another appearance",
    ).not.toContain(r3);

    // SHAPE KIND — every rectangle, whatever its paint or size; not the path.
    await selects(
      [rect(r1)],
      `${C}.selectSameShapeKind`,
      [r1, r2, r3],
      "same shape kind: the three rectangles, not the pen path",
    );

    // GLOBAL EDIT — a copy of r1 moved elsewhere is the same geometry;
    // r2 and r3 are rectangles of other sizes and are not.
    const before = await idsOfKind(page, "rectangle");
    await mutate(page, {
      op: "duplicateElements",
      args: { elementIds: [rect(r1)], offset: [0, 260] },
    });
    await expect
      .poll(async () => (await idsOfKind(page, "rectangle")).length)
      .toBe(before.length + 1);
    const copy = (await idsOfKind(page, "rectangle")).find(
      (id) => !before.includes(id),
    )!;
    await selects(
      [rect(r1)],
      `${C}.globalEdit`,
      [r1, copy],
      "Global Edit: the reference and its moved copy, no other size",
    );

    // OPACITY — r1 and r3 at 40 %; r2 and the copy keep the default 100 %.
    await setProperty(r1, "frameOpacity", 40);
    await setProperty(r3, "frameOpacity", 40);
    await selects(
      [rect(r1)],
      `${C}.selectSameOpacity`,
      [r1, r3],
      "same opacity: the two 40 % rectangles",
    );

    // BLENDING MODE — r1 and r2 multiply; the rest stay Normal.
    await setProperty(r1, "frameBlendMode", "Multiply");
    await setProperty(r2, "frameBlendMode", "Multiply");
    await selects(
      [rect(r1)],
      `${C}.selectSameBlendMode`,
      [r1, r2],
      "same blending mode: the two Multiply rectangles",
    );

    // GRAPHIC STYLE — saving a style from r2 + r3 links both; r1 stays
    // unlinked, so from it the command has nothing to match and the
    // selection is left as it was.
    await designer.selectElements([rect(r2), rect(r3)]);
    await designer.runCommand(`${C}.saveGraphicStyle`);
    await selects(
      [rect(r2)],
      `${C}.selectSameGraphicStyle`,
      [r2, r3],
      "same graphic style: the two linked rectangles",
    );
    await selects(
      [rect(r1)],
      `${C}.selectSameGraphicStyle`,
      [r1],
      "an unlinked reference matches no style: the selection stays",
    );

    // SYMBOL — two instances of a symbol defined from r1 select each
    // other; the source r1 is not an instance. On the engine's symbols
    // (engine ADR 1039) an instance is one `instance` page item.
    await designer.selectElements([rect(r1)]);
    await designer.runCommand(`${C}.defineSymbol`);
    await expect
      .poll(async () => (await designer.collection("symbols")).length)
      .toBe(1);
    const symbolId = (
      (await designer.collection("symbols")) as unknown as { id: string }[]
    )[0]!.id;
    const placed: string[] = [];
    for (const x of [300, 450]) {
      const ids = await idsOfKind(page, "instance");
      await runWithPayload(page, `${C}.placeSymbolInstance`, {
        symbolId,
        x,
        y: 400,
      });
      await expect
        .poll(async () => (await idsOfKind(page, "instance")).length, {
          message: "placing an instance adds an instance page item",
        })
        .toBe(ids.length + 1);
      placed.push(
        (await idsOfKind(page, "instance")).find((id) => !ids.includes(id))!,
      );
    }
    await selects(
      [{ kind: "instance", id: placed[0]! }],
      `${C}.selectSameSymbolInstance`,
      placed,
      "same symbol: both instances, not the source",
    );
  });

  // ── 8. the recipe families ────────────────────────────────────────

  test("repeat, blend and live paint build real artwork from a selection @feat:plugin-draw.repeats @feat:plugin-draw.blends @feat:plugin-draw.live-paint @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // ── RADIAL REPEAT — one source, many instances. ──
    const seed = await designer.drawRectangle({
      x0: 260,
      y0: 120,
      x1: 320,
      y1: 170,
    });
    await designer.applyFill("rectangle", seed);
    await designer.selectElement("rectangle", seed);
    await designer.openPanel("media.paged.draw.panel.repeat");
    await expect(page.locator("[data-draw-repeat-panel]")).toBeVisible({
      timeout: 8_000,
    });

    const beforeRepeat = await artworkCount(page);
    await designer.runCommand("media.paged.draw.command.makeRadialRepeat");
    await expect
      .poll(() => artworkCount(page), { timeout: 12_000 })
      .toBeGreaterThan(beforeRepeat);

    // The recipe exists the moment the command returns — the panel's own
    // `data-draw-repeat-active` names it. Its RECORD LIST, though, is
    // stale until the panel remounts (see `reopenPanel`), and every
    // follow-up verb is a row in that list.
    const repeatPanel = page.locator("[data-draw-repeat-panel]");
    await expect
      .poll(
        async () =>
          (await repeatPanel.first().getAttribute("data-draw-repeat-active")) ??
          "",
        { timeout: 10_000 },
      )
      .not.toBe("");
    await reopenPanel(page, designer, "media.paged.draw.panel.repeat");
    await expect
      .poll(
        async () =>
          Number(
            (await repeatPanel
              .first()
              .getAttribute("data-draw-repeat-panel")) ?? "0",
          ),
        { timeout: 8_000 },
      )
      .toBeGreaterThan(0);
    await designer.runCommand("media.paged.draw.command.updateRepeat");
    await designer.runCommand("media.paged.draw.command.selectRepeatInstances");
    await expect
      .poll(async () => (await designer.elementSelection()).length, {
        timeout: 8_000,
      })
      .toBeGreaterThan(0);
    await designer.runCommand("media.paged.draw.command.expandRepeat");
    await designer.runCommand("media.paged.draw.command.releaseRepeat");

    // ── BLEND — two keys, intermediates between them.
    //
    //    THE KEYS ARE PATHS, NOT RECTANGLES, and that is not a stylistic
    //    choice: `blendSelected` refuses a rectangle outright —
    //    "rectangle ue exposes no readable path geometry — no-op". A
    //    designer who draws two squares with the Rectangle tool and asks
    //    for a blend gets a console line and nothing else, which is
    //    worth knowing and is why the fixture is explicit about it. ──
    const k1 = await designer.drawPath([
      [120, 420],
      [190, 420],
      [155, 490],
    ]);
    const k2 = await designer.drawPath([
      [460, 420],
      [530, 420],
      [495, 490],
    ]);
    await designer.applyFill("polygon", k1);
    await designer.applyFill("polygon", k2);
    await designer.selectElements([
      { kind: "polygon", id: k1 },
      { kind: "polygon", id: k2 },
    ]);
    await designer.openPanel("media.paged.draw.panel.blend");
    await expect(page.locator("[data-draw-blend-panel]")).toBeVisible({
      timeout: 8_000,
    });

    const beforeBlend = await artworkCount(page);
    await designer.runCommand("media.paged.draw.command.blendSelected");
    await expect
      .poll(() => artworkCount(page), { timeout: 12_000 })
      .toBeGreaterThan(beforeBlend);
    await designer.runCommand(
      "media.paged.draw.command.reverseBlendFrontToBack",
    );
    await designer.runCommand("media.paged.draw.command.selectBlendObjects");
    await designer.runCommand("media.paged.draw.command.expandBlend");
    await designer.runCommand("media.paged.draw.command.releaseBlend");

    // ── LIVE PAINT — two crossing paths become a recipe with faces. ──
    const p1 = await designer.drawPath([
      [140, 600],
      [520, 600],
    ]);
    const p2 = await designer.drawPath([
      [330, 540],
      [330, 680],
    ]);
    await designer.applyStroke("polygon", p1, "Color/Black", 3);
    await designer.applyStroke("polygon", p2, "Color/Black", 3);
    await designer.selectElements([
      { kind: "polygon", id: p1 },
      { kind: "polygon", id: p2 },
    ]);
    await designer.openPanel("media.paged.draw.panel.livePaint");
    const livePaint = page.locator("[data-draw-live-paint-panel]");
    await expect(livePaint).toBeVisible({ timeout: 8_000 });
    await designer.runCommand("media.paged.draw.command.makeLivePaintGroup");
    await reopenPanel(page, designer, "media.paged.draw.panel.livePaint");
    await expect
      .poll(
        async () =>
          Number(
            (await livePaint
              .first()
              .getAttribute("data-draw-live-paint-panel")) ?? "0",
          ),
        { timeout: 12_000 },
      )
      .toBeGreaterThan(0);
    await designer.runCommand("media.paged.draw.command.regenerateLivePaint");
    await designer.runCommand("media.paged.draw.command.selectLivePaintFaces");
    await designer.runCommand("media.paged.draw.command.releaseLivePaint");
  });

  // ── 8b. a recipe follows its source, in the edit's undo step ──────

  test("editing a repeat's source rebuilds it, and one undo restores both @feat:plugin-draw.repeats @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const seed = await designer.drawRectangle({
      x0: 260,
      y0: 120,
      x1: 320,
      y1: 170,
    });
    await designer.applyFill("rectangle", seed);
    await designer.selectElement("rectangle", seed);
    await designer.runCommand("media.paged.draw.command.makeRadialRepeat");
    await expect
      .poll(async () => (await idsOfKind(page, "polygon")).length, {
        timeout: 12_000,
      })
      .toBeGreaterThan(0);
    // Let the update take its first look at the new recipe.
    await page.waitForTimeout(500);
    const made = (await idsOfKind(page, "polygon")).join(",");

    const client = async (verb: "undo" | "redo") =>
      page.evaluate(async (v) => {
        const c = (
          globalThis as unknown as {
            __canvas: { client: Record<string, () => Promise<unknown>> };
          }
        ).__canvas.client;
        await c[v]!();
      }, verb);
    const opacity = (value: number) =>
      page.evaluate(
        async (v) => {
          const c = (
            globalThis as unknown as {
              __canvas: {
                client: { mutate: (m: unknown) => Promise<unknown> };
              };
            }
          ).__canvas.client;
          return c.mutate({
            op: "setElementProperty",
            args: {
              elementId: { kind: "rectangle", id: v.seed },
              path: "frameOpacity",
              value: { type: "length", value: v.value },
            },
          });
        },
        { seed, value },
      );

    // An edit of the source: the instances are rebuilt (new ids)…
    await opacity(40);
    await expect
      .poll(async () => (await idsOfKind(page, "polygon")).join(","), {
        timeout: 12_000,
      })
      .not.toBe(made);
    const rebuilt = (await idsOfKind(page, "polygon")).join(",");

    // …and ONE undo brings back the old instances with the old source.
    await client("undo");
    await expect
      .poll(async () => (await idsOfKind(page, "polygon")).join(","), {
        timeout: 8_000,
      })
      .toBe(made);
    // Nothing rebuilt on the undo: the redo replays edit and rebuild.
    await page.waitForTimeout(500);
    await client("redo");
    await expect
      .poll(async () => (await idsOfKind(page, "polygon")).join(","), {
        timeout: 8_000,
      })
      .toBe(rebuilt);
  });

  // ── 8c. the automatic update's checkbox ────────────────────────────

  test("the recipe panels' checkbox turns the automatic update off and on @feat:plugin-draw.repeats @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const seed = await designer.drawRectangle({
      x0: 260,
      y0: 120,
      x1: 320,
      y1: 170,
    });
    await designer.applyFill("rectangle", seed);
    await designer.selectElement("rectangle", seed);
    await designer.runCommand("media.paged.draw.command.makeRadialRepeat");
    await expect
      .poll(async () => (await idsOfKind(page, "polygon")).length, {
        timeout: 12_000,
      })
      .toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const made = (await idsOfKind(page, "polygon")).join(",");

    await designer.openPanel("media.paged.draw.panel.repeat");
    const box = page.locator('[data-draw-recipe-auto-update="repeat"]');
    await expect(box).toBeVisible({ timeout: 8_000 });
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();

    const opacity = (value: number) =>
      page.evaluate(
        async (v) => {
          const c = (
            globalThis as unknown as {
              __canvas: {
                client: { mutate: (m: unknown) => Promise<unknown> };
              };
            }
          ).__canvas.client;
          return c.mutate({
            op: "setElementProperty",
            args: {
              elementId: { kind: "rectangle", id: v.seed },
              path: "frameOpacity",
              value: { type: "length", value: v.value },
            },
          });
        },
        { seed, value },
      );

    // Off: an edit of the source leaves the copies as they were.
    await opacity(40);
    await page.waitForTimeout(1_000);
    expect((await idsOfKind(page, "polygon")).join(",")).toBe(made);

    // On again: the next edit rebuilds them.
    await box.check();
    await expect(box).toBeChecked();
    await opacity(60);
    await expect
      .poll(async () => (await idsOfKind(page, "polygon")).join(","), {
        timeout: 12_000,
      })
      .not.toBe(made);
    await designer.runCommand("media.paged.draw.command.releaseRepeat");
  });

  // ── 9. pattern + objects-on-path ──────────────────────────────────

  test("a pattern field bakes from the selection and objects distribute onto a path @feat:plugin-draw.pattern-bake @feat:plugin-draw.objects-on-path @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // ── PATTERN — bake a re-editable tile field (artwork, not a
    //    swatch), then re-plan / select / delete / release it. ──
    const tile = await designer.drawRectangle({
      x0: 140,
      y0: 140,
      x1: 200,
      y1: 200,
    });
    await designer.applyFill("rectangle", tile);
    await designer.selectElement("rectangle", tile);
    await designer.openPanel("media.paged.draw.panel.pattern");
    const pattern = page.locator("[data-draw-pattern-panel]");
    await expect(pattern).toBeVisible({ timeout: 8_000 });

    const beforePattern = await artworkCount(page);
    await designer.runCommand(
      "media.paged.draw.command.makePatternFromSelection",
    );
    await expect
      .poll(() => artworkCount(page), { timeout: 12_000 })
      .toBeGreaterThan(beforePattern);
    await designer.runCommand("media.paged.draw.command.editPatternField");
    await designer.runCommand("media.paged.draw.command.selectPatternTiles");
    await designer.runCommand("media.paged.draw.command.deletePatternTiles");
    await designer.runCommand("media.paged.draw.command.releasePatternField");

    // ── OBJECTS ON PATH — the LAST selected item is the path; the
    //    objects MOVE onto it. Ink moves, so the render moves. ──
    const o1 = await designer.drawRectangle({
      x0: 130,
      y0: 430,
      x1: 175,
      y1: 475,
    });
    const o2 = await designer.drawRectangle({
      x0: 200,
      y0: 430,
      x1: 245,
      y1: 475,
    });
    await designer.applyFill("rectangle", o1);
    await designer.applyFill("rectangle", o2);
    const spine = await designer.drawPath([
      [140, 620],
      [340, 560],
      [540, 620],
    ]);
    await designer.applyStroke("polygon", spine, "Color/Black", 2);
    await designer.selectElements([
      { kind: "rectangle", id: o1 },
      { kind: "rectangle", id: o2 },
      { kind: "polygon", id: spine },
    ]);
    await designer.openPanel("media.paged.draw.panel.objectsOnPath");
    const onPath = page.locator("[data-draw-onpath-panel]");
    await expect(onPath).toBeVisible({ timeout: 8_000 });

    const beforeOnPath = await designer.renderBytes();
    await designer.runCommand("media.paged.draw.command.makeObjectsOnPath");
    await expect
      .poll(
        async () =>
          Number(
            (await onPath.first().getAttribute("data-draw-onpath-panel")) ??
              "0",
          ),
        { timeout: 12_000 },
      )
      .toBeGreaterThan(0);
    const afterOnPath = await designer.renderBytes();
    await designer.expectRenderChanged(beforeOnPath, afterOnPath);

    await designer.runCommand("media.paged.draw.command.updateObjectsOnPath");
    await designer.runCommand("media.paged.draw.command.selectObjectsOnPath");
    await designer.runCommand("media.paged.draw.command.expandObjectsOnPath");
    await designer.runCommand("media.paged.draw.command.releaseObjectsOnPath");
  });

  // ── 10. the remaining single-shot commands ────────────────────────

  test("close path, radial gradient, opacity mask and text-on-path all commit @feat:plugin-draw.path-weld @feat:plugin-draw.opacity-mask-commands @feat:frames-paths.text-on-path @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // ── CLOSE PATH — an open three-point path welds shut; closing it
    //    encloses area, so a stroked path's render changes. ──
    const open = await designer.drawPath([
      [160, 160],
      [380, 200],
      [260, 340],
    ]);
    await designer.applyStroke("polygon", open, "Color/Black", 4);
    await designer.selectElement("polygon", open);
    const beforeClose = await designer.renderBytes();
    await designer.runCommand("media.paged.draw.command.closePath");
    await designer.expectRenderChangesFrom(beforeClose);

    // ── RADIAL GRADIENT — the sibling the journeys never ran (only the
    //    linear one). The fill becomes a Gradient/ reference. ──
    const rid = await designer.drawRectangle({
      x0: 150,
      y0: 400,
      x1: 420,
      y1: 560,
    });
    await designer.selectElement("rectangle", rid);
    await designer.runCommand("media.paged.draw.command.fillGradientRadial");
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (ref) => {
              const c = (
                globalThis as unknown as {
                  __canvas: {
                    client: {
                      elementProperties: (id: unknown) => Promise<{
                        entries?: Array<{
                          path: string;
                          value?: { value?: unknown } | null;
                        }>;
                      } | null>;
                    };
                  };
                }
              ).__canvas;
              const props = await c.client
                .elementProperties(ref)
                .catch(() => null);
              for (const e of props?.entries ?? []) {
                if (e.path === "frameFillColor")
                  return String(e.value?.value ?? "");
              }
              return "";
            },
            { kind: "rectangle", id: rid },
          ),
        { timeout: 10_000 },
      )
      .toEqual(expect.stringContaining("Gradient/"));

    // ── OPACITY MASK — the TOPMOST of exactly two selected items
    //    becomes the mask; the one below is masked. Real ink change. ──
    const masked = await designer.drawRectangle({
      x0: 150,
      y0: 600,
      x1: 420,
      y1: 720,
    });
    await designer.applyFill("rectangle", masked);
    const mask = await designer.drawRectangle({
      x0: 220,
      y0: 630,
      x1: 350,
      y1: 700,
    });
    await designer.applyFill("rectangle", mask, "Color/Paper");
    await designer.selectElements([
      { kind: "rectangle", id: masked },
      { kind: "rectangle", id: mask },
    ]);
    const beforeMask = await designer.renderBytes();
    await designer.runCommand("media.paged.draw.command.makeOpacityMask");
    await designer.expectRenderChangesFrom(beforeMask);
    await designer.runCommand("media.paged.draw.command.releaseOpacityMask");
    await page.waitForTimeout(600);

    // ── TEXT ON PATH — attach an EXISTING story to a path, then
    //    detach it (the story survives, unflowed). ──
    const { frameId } = await designer.addTextFrame({
      x0: 60,
      y0: 60,
      x1: 300,
      y1: 110,
    });
    expect(frameId, "authored a text frame with a story").not.toBe("");
    const carrier = await designer.drawPath([
      [140, 760],
      [340, 720],
      [540, 760],
    ]);
    await designer.selectElements([
      { kind: "polygon", id: carrier },
      { kind: "textFrame", id: frameId },
    ]);
    await designer.runCommand("media.paged.draw.command.attachTextToPath");
    await page.waitForTimeout(600);
    await designer.runCommand("media.paged.draw.command.detachTextFromPath");
    await page.waitForTimeout(400);
  });

  // ── 11. select-same, corners, dashes, outline/offset/simplify ─────
  //
  // These carry journeys already; what is NOT covered anywhere is that
  // the whole SET stays invokable — a command that throws on invoke is
  // a dead palette row, and the palette is the ONLY home a plugin
  // command has (the contract ships no `contribute.menu`).

  test("no declared command throws when invoked from the palette @feat:plugin-platform.command-registration @level:edge", async ({
    page,
  }) => {
    // Nine of the 107 can only ever be a no-op from the palette because
    // they take an id the palette cannot supply (a style id, a symbol
    // id, a Live Paint face). They are REACHABLE from Cmd+K — they are
    // listed, searchable, selectable — and INERT there, which is the
    // dead-affordance shape: the user reads their own input as the
    // fault. Their working home is a panel row that hands the id in.
    //
    // This is a RATCHET, not an endorsement: the list must never grow.
    // A tenth id appearing here means a new command shipped with no
    // reachable surface at all.
    const KNOWN_PALETTE_INERT = new Set<string>([
      "media.paged.draw.command.applyGraphicStyle",
      "media.paged.draw.command.redefineGraphicStyle",
      "media.paged.draw.command.renameGraphicStyle",
      "media.paged.draw.command.deleteGraphicStyle",
      "media.paged.draw.command.placeSymbolInstance",
      "media.paged.draw.command.redefineSymbol",
      "media.paged.draw.command.renameSymbol",
      "media.paged.draw.command.deleteSymbol",
      "media.paged.draw.command.deleteLivePaintFace",
    ]);

    const warnings: string[] = [];
    page.on("console", (m) => {
      const text = m.text();
      if (text.includes("[media.paged.draw]")) warnings.push(text);
    });

    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // A representative selection so the guards have something to read:
    // two overlapping filled rectangles and a real path.
    const a = await designer.drawRectangle({
      x0: 140,
      y0: 140,
      x1: 320,
      y1: 280,
    });
    const b = await designer.drawRectangle({
      x0: 240,
      y0: 200,
      x1: 420,
      y1: 340,
    });
    await designer.applyFill("rectangle", a);
    await designer.applyFill("rectangle", b);
    await designer.selectElements([
      { kind: "rectangle", id: a },
      { kind: "rectangle", id: b },
    ]);

    // EVERY command, invoked with no payload — exactly what Cmd+K does.
    // The contract is "no-op honestly, never throw": a plugin command
    // that throws surfaces to the user as a dead row with a console
    // stack, and there is no second surface to reach it from.
    const threw = await page.evaluate(
      async (ids) => {
        const cmd = (
          globalThis as unknown as {
            __canvas: {
              registries: {
                commands: { invoke: (id: string) => Promise<void> };
              };
            };
          }
        ).__canvas.registries.commands;
        const bad: string[] = [];
        for (const id of ids) {
          try {
            await cmd.invoke(id);
          } catch (err) {
            bad.push(`${id}: ${String(err).split("\n")[0]}`);
          }
        }
        return bad;
      },
      COMMANDS as unknown as string[],
    );

    expect(threw, "every draw command survives a payload-free invoke").toEqual(
      [],
    );

    // The ratchet. Anything that refused for want of a payload must be
    // on the known list; a NEW id here is a command with no working
    // surface anywhere.
    //
    // The pattern is narrow ON PURPOSE. Several commands also mention a
    // payload while refusing — `attachTextToPath`, `releaseOpacityMask`,
    // `fillLivePaintFace`, `detachTextFromPath` all say "nothing
    // selected and no elementId in the payload" — but those are
    // STATE-dependent: give them the right selection and they work from
    // the palette. Only a LIBRARY id (a style, a symbol, a Live Paint
    // face) is something the palette structurally cannot supply.
    const LIBRARY_ID_REFUSAL =
      /no (styleId|symbolId) in the payload|no face named in the payload/;
    const inertNow = new Set(
      COMMANDS.filter((id) =>
        warnings.some((w) => w.includes(id) && LIBRARY_ID_REFUSAL.test(w)),
      ),
    );
    const unexpected = [...inertNow].filter(
      (id) => !KNOWN_PALETTE_INERT.has(id),
    );
    expect(
      unexpected,
      "a command that is inert from the palette and not on the known list",
    ).toEqual([]);
  });

  // ── 12. how a user would FIND any of this ─────────────────────────

  test("every command is reachable from the palette, and only from there @feat:plugin-platform.command-registration @feat:plugin-platform.bundle-lifecycle @level:edge", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    const meta = await commandMeta(page);
    const byId = new Map(meta.map((c) => [c.id, c]));

    // Every command carries a title + a category, because the palette
    // renders exactly those two and nothing else. A missing category
    // buckets the row under "Other" — findable only by exact text.
    const untitled = COMMANDS.filter(
      (id) => !(byId.get(id)?.title ?? "").trim(),
    );
    expect(untitled, "every draw command has a palette title").toEqual([]);
    const uncategorised = COMMANDS.filter(
      (id) => (byId.get(id)?.category ?? "Other") === "Other",
    );
    expect(uncategorised, "every draw command has a palette category").toEqual(
      [],
    );

    // THE MENU BAR NOW CARRIES THEM — and this assertion is the INVERSE
    // of what it said until 2026-08-23, deliberately.
    //
    // It used to pin the opposite fact: "no draw command reaches the
    // menu bar, Cmd+K is the only home", because the contract shipped
    // eleven contribution doors and `menu` was not one of them. It said
    // in its own comment that if the contract ever gained a menu door
    // and draw used it, this should FAIL so someone inverted it
    // deliberately rather than letting "commands are unreachable" rot
    // into "commands used to be unreachable". That is exactly what
    // happened — `contribute.menu()` landed in plugin-api 0.2.33, draw
    // contributed 72 entries in canary.10, and this went red on the
    // first CI run afterwards. The spec worked.
    const drawMenuItems = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: {
              menus: { list: () => Array<{ path: string; command: string }> };
            };
          };
        }
      ).__canvas.registries.menus
        .list()
        .filter((m) => m.command.startsWith("media.paged.draw.command."))
        .map((m) => m.path),
    );
    expect(
      drawMenuItems.length,
      "draw's verbs reach the menu bar, not just Cmd+K",
    ).toBeGreaterThan(50);
    // Under a `Draw` top level, plus the deliberate merges into the
    // host's own Object and Edit menus.
    expect(drawMenuItems.some((p) => p.startsWith("Draw/"))).toBe(true);
    expect(
      drawMenuItems.some(
        (p) => p.startsWith("Object/") || p.startsWith("Edit/"),
      ),
      "the insert and select-same verbs merge into host menus",
    ).toBe(true);
  });
});
