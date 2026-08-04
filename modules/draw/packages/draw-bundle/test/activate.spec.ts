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

// Registration-wiring test: activate the real bundle against the
// real in-process host adapter over a minimal fake editor. Covers
// the D3 contract — three anchor tools (activation commands +
// shortcuts host-derived per B-15) AND the W3.1 declarative stroke
// SCHEMA panel — and the honesty smoke test (dispose leaves the
// registries empty). Engine behavior is NOT faked here (that's the
// reserved harness's job); this exercises wiring only.

import { describe, expect, it } from "vitest";

import type { PagedEditor } from "@paged-media/plugin-api";
import { loadBundle } from "@paged-media/plugin-sdk";

import { drawBundle } from "../src";

function fakeRegistry() {
  const byId = new Map<string, unknown>();
  return {
    ids: () => Array.from(byId.keys()),
    register(c: { id: string }) {
      if (byId.has(c.id)) throw new Error(`duplicate id ${c.id}`);
      byId.set(c.id, c);
      return {
        dispose() {
          byId.delete(c.id);
        },
      };
    },
  };
}

function fakeKeybindings() {
  const items: unknown[] = [];
  return {
    count: () => items.length,
    register(c: unknown) {
      items.push(c);
      return {
        dispose() {
          const i = items.indexOf(c);
          if (i >= 0) items.splice(i, 1);
        },
      };
    },
  };
}

// W3.2 — edit-context/object-type registries key off `type`, not `id`.
function fakeTypeRegistry() {
  const byType = new Map<string, { type: string }>();
  return {
    types: () => Array.from(byType.keys()),
    get: (t: string) => byType.get(t),
    register(c: { type: string }) {
      byType.set(c.type, c);
      return {
        dispose() {
          byType.delete(c.type);
        },
      };
    },
  };
}

function makeFakeEditor() {
  const tools = fakeRegistry();
  const commands = fakeRegistry();
  const panels = fakeRegistry();
  const keybindings = fakeKeybindings();
  const editContexts = fakeTypeRegistry();
  const objectTypes = fakeTypeRegistry();
  // Minimal client for the schema panel's binding driver: it subscribes
  // for selection changes and (on a non-empty selection) reads
  // pathAnchors. At install over the empty fake selection it only
  // publishes hasSelection=false, so the stubs below suffice.
  let selectionIds: unknown[] = [];
  const client = {
    subscribe: (_l: (msg: unknown) => void) => () => {},
    pathAnchors: async () => null,
    setElementSelection: async (ids: unknown[]) => ids,
  };
  const editor = {
    client,
    registries: {
      tools,
      commands,
      panels,
      keybindings,
      editContexts,
      objectTypes,
    },
    selection: {
      elementSelection: selectionIds,
      setElementSelection: (ids: unknown[]) => {
        selectionIds = ids;
      },
      setElementGeometry: () => {},
    },
    camera: { camera: { scale: 1, tx: 0, ty: 0 } },
  };
  return {
    editor: editor as unknown as PagedEditor,
    tools,
    commands,
    panels,
    keybindings,
    editContexts,
    objectTypes,
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

describe("drawBundle.activate", () => {
  it("registers the 3 anchor tools + the pro set + the v0 brushes + the wave-2 trio (pen built-in per W2.5; activation host-derived per B-15)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.tools.ids()).toEqual([
      "media.paged.draw.tool.addAnchor",
      "media.paged.draw.tool.deleteAnchor",
      "media.paged.draw.tool.convertAnchor",
      "media.paged.draw.tool.curvature",
      "media.paged.draw.tool.pencil",
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
      // LIVE PAINT v0 — the bucket + the face-selection tool.
      "media.paged.draw.tool.livePaintBucket",
      "media.paged.draw.tool.livePaintSelect",
      // C-29 (engine v58) — Type on a Path. Joins the built-in `type`
      // group beside the editor's INERT `paged.tool.typePath`
      // placeholder (a rail entry with no gesture, which a bundle
      // cannot attach behaviour to).
      "media.paged.draw.tool.typeOnPath",
    ]);
    // B-15: TOOL activation commands + shortcuts are HOST-derived from
    // the registry — the bundle registers tools only. The commands it
    // DOES register are the B-12 dash presets, the Phase 2d group pair
    // (B-04), the gradient-fill pair (B-03), and the Phase 4c families
    // (path ops, join/average, pathfinder) — not tool activations.
    expect(fake.commands.ids()).toEqual([
      "media.paged.draw.command.strokeDashSolid",
      "media.paged.draw.command.strokeDashDashed",
      "media.paged.draw.command.strokeDashDotted",
      "media.paged.draw.command.strokeDashDashDot",
      "media.paged.draw.command.groupSelection",
      "media.paged.draw.command.ungroup",
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
      // B-22 (engine v57) — the REGION Pathfinder row.
      "media.paged.draw.command.pathfinderDivide",
      "media.paged.draw.command.pathfinderTrim",
      "media.paged.draw.command.pathfinderMerge",
      "media.paged.draw.command.pathfinderCrop",
      "media.paged.draw.command.pathfinderOutline",
      "media.paged.draw.command.pathfinderMinusBack",
      // Illustrator Phase 2 — compound paths (Make / Release).
      "media.paged.draw.command.makeCompoundPath",
      "media.paged.draw.command.releaseCompoundPath",
      // Illustrator Phase 2 — PATTERN EDITING v1 (a re-editable tile
      // FIELD; the swatch half of the catalog row is not buildable on
      // this engine — RFI C-31).
      "media.paged.draw.command.makePatternFromSelection",
      "media.paged.draw.command.editPatternField",
      "media.paged.draw.command.selectPatternTiles",
      "media.paged.draw.command.deletePatternTiles",
      "media.paged.draw.command.releasePatternField",
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
      // B-24 — the group bake + its inverse.
      "media.paged.draw.command.bakeAppearance",
      "media.paged.draw.command.releaseAppearance",
      // Illustrator Phase 2 — graphic styles (the named, LINKED complete
      // appearance; library = a `.paged` container part).
      "media.paged.draw.command.saveGraphicStyle",
      "media.paged.draw.command.applyGraphicStyle",
      "media.paged.draw.command.redefineGraphicStyle",
      "media.paged.draw.command.breakGraphicStyleLink",
      "media.paged.draw.command.renameGraphicStyle",
      "media.paged.draw.command.deleteGraphicStyle",
      // Illustrator Phase 2 (§16.1) — symbols v0 (a definition in a
      // container part; an instance is re-emitted artwork carrying a link).
      "media.paged.draw.command.defineSymbol",
      "media.paged.draw.command.placeSymbolInstance",
      "media.paged.draw.command.redefineSymbol",
      "media.paged.draw.command.breakSymbolLink",
      "media.paged.draw.command.resetSymbolTransform",
      "media.paged.draw.command.renameSymbol",
      "media.paged.draw.command.deleteSymbol",
      // Illustrator Phase 2 (the last unbuilt row) — LIVE PAINT v0 (a
      // REGENERABLE recipe in a container part + real artwork per
      // painted face; no gap handling and no edges — see
      // commands/live-paint.ts).
      "media.paged.draw.command.makeLivePaintGroup",
      "media.paged.draw.command.fillLivePaintFace",
      "media.paged.draw.command.regenerateLivePaint",
      "media.paged.draw.command.selectLivePaintFaces",
      "media.paged.draw.command.deleteLivePaintFace",
      "media.paged.draw.command.releaseLivePaint",
      // Illustrator Phase 2 (the Transparency row) — opacity masks
      // (C-28, engine v58). EXPORT-ONLY: the canvas backend does not
      // honour the mask, and the command title says so.
      "media.paged.draw.command.makeOpacityMask",
      "media.paged.draw.command.releaseOpacityMask",
      // C-29 (engine v58) — type on a path: flow an EXISTING story
      // along an EXISTING path, and its exact inverse.
      "media.paged.draw.command.attachTextToPath",
      "media.paged.draw.command.detachTextFromPath",
      "media.paged.draw.command.selectSameFill",
      "media.paged.draw.command.selectSameStroke",
      "media.paged.draw.command.selectSameStrokeWeight",
      "media.paged.draw.command.insertArc",
      "media.paged.draw.command.insertSpiral",
      "media.paged.draw.command.insertRectGrid",
      "media.paged.draw.command.insertPolarGrid",
      "media.paged.draw.command.blendSelected",
      "media.paged.draw.command.selectParentGroup",
      // Illustrator Phase 2 (last row) — Image Trace v0 (the wasm lane).
      "media.paged.draw.command.imageTrace",
    ]);
    expect(fake.keybindings.count()).toBe(0);
  });

  it("registers the stroke + fill SCHEMA panels and the appearance + graphic-styles + symbols + live-paint + pattern React panels — and NO Layers panel", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    // The schema panels register through the panels registry as
    // synthesized PanelContributions; the five React panels —
    // appearance (the metadata stack + its one-fill/one-stroke honesty
    // note), graphic styles (the document-resident style library + the
    // selection's link into it), symbols (the document-resident artwork
    // library + the instances that follow it), live paint (the
    // document-resident face RECIPES + the artwork each painted face
    // materialised as) and pattern (the tile-field OPTIONS form + the
    // not-a-swatch boundary) — register directly, all expert-leaf per
    // B-01's list-widget limit.
    //
    // THERE IS NO LAYERS PANEL, and its absence is the assertion: ADR
    // 023 phase D retired it behind the binding-provider seam
    // (`binding-provider/layers-provider.ts`, whose behaviour is pinned
    // in `conformance/layers-provider.spec.ts`). A Layers panel
    // reappearing here would be the duplication coming back.
    expect(fake.panels.ids()).toEqual([
      "media.paged.draw.panel.stroke",
      "media.paged.draw.panel.fill",
      "media.paged.draw.panel.appearance",
      "media.paged.draw.panel.graphicStyles",
      "media.paged.draw.panel.symbols",
      "media.paged.draw.panel.livePaint",
      "media.paged.draw.panel.pattern",
    ]);
  });

  it("registered ids match the manifest's contributes declaration", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.tools.ids()).toEqual(drawBundle.manifest.contributes?.tools);
    // The schema panel's id matches the manifest's panel declaration.
    expect(fake.panels.ids()).toEqual(drawBundle.manifest.contributes?.panels);
    expect(fake.commands.ids()).toEqual(
      drawBundle.manifest.contributes?.commands ?? [],
    );
  });

  it("registers the W3.2 vectorGraphic edit context (B-02 RESOLVED)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.editContexts.types()).toEqual(["vectorGraphic"]);
    const ec = fake.editContexts.get("vectorGraphic") as unknown as {
      entry: string;
      toolIds: string[];
      panelIds: string[];
      matches?: (c: unknown) => boolean;
      metadataKey?: string;
    };
    expect(ec.entry).toBe("doubleClick");
    // The anchor-editing tool-set the context focuses.
    expect(ec.toolIds).toEqual([
      "media.paged.draw.tool.addAnchor",
      "media.paged.draw.tool.deleteAnchor",
      "media.paged.draw.tool.convertAnchor",
    ]);
    // The stroke panel the cockpit raises on enter.
    expect(ec.panelIds).toEqual(["media.paged.draw.panel.stroke"]);
    // The host stamped the own-namespace metadata key.
    expect(ec.metadataKey).toBe("x-paged:media.paged.draw");
    // Kind-claimed: a polygon matches, an oval (no path) does not.
    expect(ec.matches?.({ kind: "polygon", groupChain: [], metadata: null })).toBe(
      true,
    );
    expect(ec.matches?.({ kind: "oval", groupChain: [], metadata: null })).toBe(
      false,
    );
    // paged.web declares NO objectType here; a webFrame is just a
    // rectangle to draw — rectangles ARE a path kind, so this context
    // claims them. (In the live editor paged.web's objectType claims a
    // webFrame FIRST via metadata; see the resolveDoubleClick ordering.)
    expect(
      ec.matches?.({ kind: "rectangle", groupChain: [], metadata: null }),
    ).toBe(true);
  });

  it("dispose leaves the shell exactly as found (honesty smoke test)", () => {
    const fake = makeFakeEditor();
    const loaded = loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    loaded.dispose();
    expect(fake.tools.ids()).toHaveLength(0);
    expect(fake.panels.ids()).toHaveLength(0);
    expect(fake.commands.ids()).toHaveLength(0);
    expect(fake.keybindings.count()).toBe(0);
    expect(fake.editContexts.types()).toHaveLength(0);
  });
});
