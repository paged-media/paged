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

// THE RECIPE COMMANDS against the real engine — blends, repeats,
// patterns, objects on a path, live paint, symbols, graphic styles, the
// appearance stack and Image Trace — held to the kit's contract
// (`command-kit.ts`): every command that builds, edits, expands or
// releases a record is ONE undo step that undoes and redoes exactly, a
// command whose effect is the selection leaves the model alone, and with
// no record selected every one of them refuses. Each family's domain
// assertions (geometry, ordinals, metadata) are in its own spec here.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  F1_MULTI_SHAPE,
  F4_OVERLAP,
  F6_RING_PAIR,
  F7_PLACED_IMAGE,
} from "../fixtures/corpus";
import {
  brokenInvariant,
  commandRig,
  el,
  expectApplies,
  expectLibraryOnly,
  expectRefuses,
  expectSelects,
  undoStepsOf,
  type CommandRig,
} from "./command-kit";
import { installPngRealm } from "./raster-realm";

const C = "media.paged.draw.command";
const RECT = el("rectangle", "urect");
const POLY = el("polygon", "upoly");
const A = el("polygon", "ua");
const B = el("polygon", "ub");
const OUTER = el("polygon", "uouter");
const INNER = el("polygon", "uinner");
const OPEN = el("polygon", "uopen");
const F1 = () => F1_MULTI_SHAPE.bytes();
const F4 = () => F4_OVERLAP.bytes();
const F6 = () => F6_RING_PAIR.bytes();

const corner = (x: number, y: number) => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

describe("paged.draw commands — recipes (real engine)", () => {
  let rig: CommandRig;
  beforeAll(async () => {
    rig = await commandRig();
  }, 60_000);
  afterAll(() => rig?.dispose());

  /** Insert a path into the open document and return its id. */
  async function insertPath(
    pageId: string,
    anchors: ReturnType<typeof corner>[],
    open: boolean,
  ): Promise<ElementId> {
    const out = await rig.h.host.document.mutate({
      op: "insertPath",
      args: { pageId, anchors, open },
    } as unknown as Mutation);
    if (!out.applied || !out.createdId) throw new Error("insertPath failed");
    return out.createdId as unknown as ElementId;
  }

  /** F4 with a two-step blend between its quads, the blend selected. */
  async function withBlend(): Promise<void> {
    await rig.open(F4(), [A, B]);
    await rig.run(`${C}.blendSelected`, { steps: 2 });
    await rig.h.host.selection.set([A, B]);
  }

  describe("blends", () => {
    it("Blend makes the steps between the two selected paths; one path is refused", async () => {
      covers("command:media.paged.draw.command.blendSelected");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.blendSelected`, { steps: 2 });
      await expectRefuses(rig, F4(), [A], `${C}.blendSelected`);
    });

    it("Update blend rebuilds it with new options; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.updateBlend");
      await withBlend();
      await expectApplies(rig, `${C}.updateBlend`, { steps: 5 });
      await expectRefuses(rig, F4(), [A], `${C}.updateBlend`);
    });

    it("Replace spine runs the blend along the selected path; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.replaceBlendSpine");
      await withBlend();
      const spine = await insertPath(
        F4_OVERLAP.pageId,
        [corner(200, 200), corner(250, 500), corner(300, 300)],
        true,
      );
      await rig.h.host.selection.set([spine]);
      await expectApplies(rig, `${C}.replaceBlendSpine`);
      await expectRefuses(rig, F4(), [], `${C}.replaceBlendSpine`);
    });

    it("Reverse spine moves the steps to the far end; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.reverseBlendSpine");
      await withBlend();
      await expectApplies(rig, `${C}.reverseBlendSpine`);
      await expectRefuses(rig, F4(), [A], `${C}.reverseBlendSpine`);
    });

    it("Reverse front to back flips the stacking order; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.reverseBlendFrontToBack");
      await withBlend();
      await expectApplies(rig, `${C}.reverseBlendFrontToBack`);
      await expectRefuses(rig, F4(), [A], `${C}.reverseBlendFrontToBack`);
    });

    it("Select blend objects selects its keys and changes nothing; a plain path selects nothing new", async () => {
      covers("command:media.paged.draw.command.selectBlendObjects");
      await withBlend();
      await expectSelects(rig, `${C}.selectBlendObjects`, (s) =>
        expect(s.map((e) => String(e.id)).sort()).toEqual(["ua", "ub"]),
      );
      await expectRefuses(rig, F4(), [A], `${C}.selectBlendObjects`);
    });

    it("Expand blend turns the steps into plain paths; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.expandBlend");
      await withBlend();
      await expectApplies(rig, `${C}.expandBlend`);
      await expectRefuses(rig, F4(), [A], `${C}.expandBlend`);
    });

    it("Release blend deletes the steps and keeps the keys; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.releaseBlend");
      await withBlend();
      await expectApplies(rig, `${C}.releaseBlend`);
      await expectRefuses(rig, F4(), [A], `${C}.releaseBlend`);
    });
  });

  describe("repeats", () => {
    async function withRepeat(): Promise<void> {
      await rig.open(F6(), [INNER]);
      await rig.run(`${C}.makeRadialRepeat`, { count: 4 });
      await rig.h.host.selection.set([INNER]);
    }

    it("Radial repeat copies the selection around a centre; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.makeRadialRepeat");
      await rig.open(F6(), [INNER]);
      await expectApplies(rig, `${C}.makeRadialRepeat`);
      await expectRefuses(rig, F6(), [], `${C}.makeRadialRepeat`);
    });

    it("Grid repeat tiles the selection; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.makeGridRepeat");
      await rig.open(F6(), [INNER]);
      await expectApplies(rig, `${C}.makeGridRepeat`, { columns: 2, rows: 1 });
      await expectRefuses(rig, F6(), [], `${C}.makeGridRepeat`);
    });

    it("Mirror repeat mirrors the selection; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.makeMirrorRepeat");
      await rig.open(F6(), [INNER]);
      await expectApplies(rig, `${C}.makeMirrorRepeat`);
      await expectRefuses(rig, F6(), [], `${C}.makeMirrorRepeat`);
    });

    it("Update repeat rebuilds it with new options; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.updateRepeat");
      await withRepeat();
      await expectApplies(rig, `${C}.updateRepeat`, { count: 6 });
      await expectRefuses(rig, F6(), [OUTER], `${C}.updateRepeat`);
    });

    it("Select repeat instances selects the copies and changes nothing", async () => {
      covers("command:media.paged.draw.command.selectRepeatInstances");
      await withRepeat();
      await expectSelects(rig, `${C}.selectRepeatInstances`, (s) =>
        expect(s.length).toBeGreaterThan(1),
      );
      await expectRefuses(rig, F6(), [OUTER], `${C}.selectRepeatInstances`);
    });

    it("Expand repeat turns the copies into plain paths; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.expandRepeat");
      await withRepeat();
      await expectApplies(rig, `${C}.expandRepeat`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.expandRepeat`);
    });

    it("Release repeat deletes the copies and keeps the source; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.releaseRepeat");
      await withRepeat();
      await expectApplies(rig, `${C}.releaseRepeat`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.releaseRepeat`);
    });
  });

  describe("patterns", () => {
    async function withPattern(): Promise<void> {
      await rig.open(F6(), [INNER]);
      await rig.run(`${C}.makePatternFromSelection`, { columns: 2, rows: 2 });
      await rig.h.host.selection.set([INNER]);
    }

    it("Make pattern tiles the selection into a pattern field; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.makePatternFromSelection");
      await rig.open(F6(), [INNER]);
      await expectApplies(rig, `${C}.makePatternFromSelection`, {
        columns: 2,
        rows: 2,
      });
      await expectRefuses(rig, F6(), [], `${C}.makePatternFromSelection`);
    });

    it("Edit pattern rebuilds the field with new options; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.editPatternField");
      await withPattern();
      await expectApplies(rig, `${C}.editPatternField`, {
        columns: 3,
        rows: 1,
      });
      await expectRefuses(rig, F6(), [OUTER], `${C}.editPatternField`);
    });

    it("Select pattern tiles selects the tiles and changes nothing", async () => {
      covers("command:media.paged.draw.command.selectPatternTiles");
      await withPattern();
      await expectSelects(rig, `${C}.selectPatternTiles`, (s) =>
        expect(s.length).toBeGreaterThan(1),
      );
      await expectRefuses(rig, F6(), [OUTER], `${C}.selectPatternTiles`);
    });

    it("Delete pattern tiles removes the tiles; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.deletePatternTiles");
      await withPattern();
      await expectApplies(rig, `${C}.deletePatternTiles`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.deletePatternTiles`);
    });

    it("Release pattern field keeps the tiles as plain paths; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.releasePatternField");
      await withPattern();
      await expectApplies(rig, `${C}.releasePatternField`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.releasePatternField`);
    });
  });

  describe("objects on a path", () => {
    async function smalls(): Promise<[ElementId, ElementId]> {
      const square = (x: number, y: number) => [
        corner(x, y),
        corner(x + 20, y),
        corner(x + 20, y + 20),
        corner(x, y + 20),
      ];
      return [
        await insertPath(F6_RING_PAIR.pageId, square(20, 20), false),
        await insertPath(F6_RING_PAIR.pageId, square(20, 120), false),
      ];
    }
    async function withOnPath(): Promise<void> {
      await rig.open(F6(), []);
      const [a, b] = await smalls();
      await rig.h.host.selection.set([a, b, OPEN]);
      await rig.run(`${C}.makeObjectsOnPath`, { alignToPath: false });
      await rig.h.host.selection.set([OPEN]);
    }

    it("Objects on path distributes the objects along the open path; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.makeObjectsOnPath");
      await rig.open(F6(), []);
      const [a, b] = await smalls();
      await rig.h.host.selection.set([a, b, OPEN]);
      await expectApplies(rig, `${C}.makeObjectsOnPath`, {
        alignToPath: false,
      });
      await expectRefuses(rig, F6(), [], `${C}.makeObjectsOnPath`);
    });

    it("Update objects on path re-places them with new options; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.updateObjectsOnPath");
      await withOnPath();
      await expectApplies(rig, `${C}.updateObjectsOnPath`, {
        startOffsetPt: 30,
      });
      await expectRefuses(rig, F6(), [OUTER], `${C}.updateObjectsOnPath`);
    });

    it("Select objects on path selects the objects and changes nothing", async () => {
      covers("command:media.paged.draw.command.selectObjectsOnPath");
      await withOnPath();
      await expectSelects(rig, `${C}.selectObjectsOnPath`, (s) =>
        expect(s.length).toBeGreaterThan(1),
      );
      await expectRefuses(rig, F6(), [OUTER], `${C}.selectObjectsOnPath`);
    });

    it("Expand objects on path keeps them as plain paths; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.expandObjectsOnPath");
      await withOnPath();
      await expectApplies(rig, `${C}.expandObjectsOnPath`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.expandObjectsOnPath`);
    });

    it("Release objects on path takes the objects off the path; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.releaseObjectsOnPath");
      await withOnPath();
      await expectApplies(rig, `${C}.releaseObjectsOnPath`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.releaseObjectsOnPath`);
    });
  });

  describe("live paint", () => {
    const OVERLAP = "0-1#0";
    async function withLivePaint(): Promise<void> {
      await rig.open(F4(), [A, B]);
      await rig.run(`${C}.makeLivePaintGroup`);
    }

    it("Make live paint group turns the overlapping pair into a live paint group; one path is refused", async () => {
      covers("command:media.paged.draw.command.makeLivePaintGroup");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.makeLivePaintGroup`);
      await expectRefuses(rig, F4(), [A], `${C}.makeLivePaintGroup`);
    });

    it("Fill face paints the overlap region; with no group it is refused", async () => {
      covers("command:media.paged.draw.command.fillLivePaintFace");
      await withLivePaint();
      await expectApplies(rig, `${C}.fillLivePaintFace`, { face: OVERLAP });
      await expectRefuses(rig, F4(), [A], `${C}.fillLivePaintFace`, {
        face: OVERLAP,
      });
    });

    it("Regenerate re-cuts the faces after an edit; with no group it is refused", async () => {
      covers("command:media.paged.draw.command.regenerateLivePaint");
      await withLivePaint();
      await rig.run(`${C}.fillLivePaintFace`, { face: OVERLAP });
      await rig.h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: B,
          path: "frameBounds",
          value: { type: "rect", value: [220, 220, 420, 420] },
        },
      } as unknown as Mutation);
      await expectApplies(rig, `${C}.regenerateLivePaint`, {
        groupId: "lp-1",
      });
      await expectRefuses(rig, F4(), [A], `${C}.regenerateLivePaint`, {
        groupId: "lp-1",
      });
    });

    it("Select faces selects the group's painted faces and changes nothing", async () => {
      covers("command:media.paged.draw.command.selectLivePaintFaces");
      await withLivePaint();
      await rig.run(`${C}.fillLivePaintFace`, { face: OVERLAP });
      await expectSelects(
        rig,
        `${C}.selectLivePaintFaces`,
        (s) => expect(s.length).toBeGreaterThan(0),
        { groupId: "lp-1" },
      );
    });

    it("Delete face removes a painted face; with no group it is refused", async () => {
      covers("command:media.paged.draw.command.deleteLivePaintFace");
      await withLivePaint();
      await rig.run(`${C}.fillLivePaintFace`, { face: OVERLAP });
      await expectApplies(rig, `${C}.deleteLivePaintFace`, {
        groupId: "lp-1",
        face: OVERLAP,
      });
      await expectRefuses(rig, F4(), [A], `${C}.deleteLivePaintFace`, {
        groupId: "lp-1",
        face: OVERLAP,
      });
    });

    it("Release live paint keeps the paths and drops the group; with no group it is refused", async () => {
      covers("command:media.paged.draw.command.releaseLivePaint");
      await withLivePaint();
      await rig.run(`${C}.fillLivePaintFace`, { face: OVERLAP });
      await expectApplies(rig, `${C}.releaseLivePaint`, { groupId: "lp-1" });
      await expectRefuses(rig, F4(), [A], `${C}.releaseLivePaint`, {
        groupId: "lp-1",
      });
    });
  });

  describe("symbols", () => {
    async function withSymbol(): Promise<void> {
      await rig.open(F6(), [INNER]);
      await rig.run(`${C}.defineSymbol`, { name: "Tile" });
    }
    async function placed(): Promise<ElementId> {
      const before = new Set(
        (await rig.h.host.document.tree()).flatMap(function ids(n): string[] {
          return [
            ...(n.id ? [String(n.id.id)] : []),
            ...(n.children ?? []).flatMap(ids),
          ];
        }),
      );
      await rig.run(`${C}.placeSymbolInstance`, {
        symbolId: "sym-1",
        x: 500,
        y: 500,
      });
      const after = (await rig.h.host.document.tree()).flatMap(
        function nodes(n): NonNullable<(typeof n)["id"]>[] {
          return [
            ...(n.id ? [n.id] : []),
            ...(n.children ?? []).flatMap(nodes),
          ];
        },
      );
      const fresh = after.find((id) => !before.has(String(id.id)));
      if (!fresh) throw new Error("placeSymbolInstance placed nothing");
      return fresh;
    }

    it("Define symbol writes the selection into the symbol library and leaves the document alone; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.defineSymbol");
      await rig.open(F6(), [INNER]);
      const library = await expectLibraryOnly(rig, `${C}.defineSymbol`, {
        name: "Tile",
      });
      expect(library).toContain("Tile");
      await expectRefuses(rig, F6(), [], `${C}.defineSymbol`);
    });

    it("Place instance places a linked copy; an unknown symbol is refused", async () => {
      covers("command:media.paged.draw.command.placeSymbolInstance");
      await withSymbol();
      await expectApplies(rig, `${C}.placeSymbolInstance`, {
        symbolId: "sym-1",
        x: 500,
        y: 500,
      });
      await expectRefuses(rig, F6(), [], `${C}.placeSymbolInstance`, {
        symbolId: "sym-404",
        x: 500,
        y: 500,
      });
    });

    it("Redefine symbol rebuilds every placed instance from the selection; an unknown symbol is refused", async () => {
      covers("command:media.paged.draw.command.redefineSymbol");
      await withSymbol();
      await placed();
      await rig.h.host.selection.set([OUTER]);
      await expectApplies(rig, `${C}.redefineSymbol`, { symbolId: "sym-1" });
      await expectRefuses(rig, F6(), [OUTER], `${C}.redefineSymbol`, {
        symbolId: "sym-404",
      });
    });

    it("Break link turns an instance into plain art; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.breakSymbolLink");
      await withSymbol();
      const instance = await placed();
      await rig.h.host.selection.set([instance]);
      await expectApplies(rig, `${C}.breakSymbolLink`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.breakSymbolLink`);
    });

    it("Reset transform undoes an instance's transform; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.resetSymbolTransform");
      await withSymbol();
      const instance = await placed();
      await rig.h.host.selection.set([instance]);
      await rig.run(`${C}.reflectVertical`);
      await rig.h.host.selection.set([instance]);
      await expectApplies(rig, `${C}.resetSymbolTransform`);
      await expectRefuses(rig, F6(), [OUTER], `${C}.resetSymbolTransform`);
    });

    it("Rename symbol renames it in the library only; an unknown symbol is refused", async () => {
      covers("command:media.paged.draw.command.renameSymbol");
      await withSymbol();
      const library = await expectLibraryOnly(rig, `${C}.renameSymbol`, {
        symbolId: "sym-1",
        name: "Badge",
      });
      expect(library).toContain("Badge");
      await expectRefuses(rig, F6(), [], `${C}.renameSymbol`, {
        symbolId: "sym-404",
        name: "Badge",
      });
    });

    it("Delete symbol removes an unplaced symbol from the library only; an unknown symbol is refused", async () => {
      covers("command:media.paged.draw.command.deleteSymbol");
      await withSymbol();
      const library = await expectLibraryOnly(rig, `${C}.deleteSymbol`, {
        symbolId: "sym-1",
      });
      expect(library).not.toContain("Tile");
      await expectRefuses(rig, F6(), [], `${C}.deleteSymbol`, {
        symbolId: "sym-404",
      });
    });
  });

  describe("graphic styles", () => {
    async function withStyle(): Promise<void> {
      await rig.open(F1(), [RECT]);
      await rig.run(`${C}.saveGraphicStyle`, { name: "Heavy" });
    }

    it("Save style captures the selection's appearance as a style; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.saveGraphicStyle");
      await rig.open(F1(), [RECT]);
      await expectApplies(rig, `${C}.saveGraphicStyle`, { name: "Heavy" });
      await expectRefuses(rig, F1(), [], `${C}.saveGraphicStyle`, {
        name: "Heavy",
      });
    });

    it("Apply style paints the selection with it; an unknown style is refused", async () => {
      covers("command:media.paged.draw.command.applyGraphicStyle");
      await withStyle();
      await rig.h.host.selection.set([POLY]);
      await expectApplies(rig, `${C}.applyGraphicStyle`, { styleId: "gs-1" });
      await expectRefuses(rig, F1(), [POLY], `${C}.applyGraphicStyle`, {
        styleId: "gs-404",
      });
    });

    it("Redefine style repaints the linked element from the selection; an unknown style is refused", async () => {
      covers("command:media.paged.draw.command.redefineGraphicStyle");
      await withStyle();
      // Keep ONE link: the source's is broken, the polygon's is made.
      await rig.h.host.selection.set([RECT]);
      await rig.run(`${C}.breakGraphicStyleLink`);
      await rig.h.host.selection.set([POLY]);
      await rig.run(`${C}.applyGraphicStyle`, { styleId: "gs-1" });
      await rig.h.host.selection.set([el("graphicLine", "uline")]);
      await expectApplies(rig, `${C}.redefineGraphicStyle`, {
        styleId: "gs-1",
      });
      await expectRefuses(rig, F1(), [POLY], `${C}.redefineGraphicStyle`, {
        styleId: "gs-404",
      });
    });

    it.failing(
      "DRW-3 — Redefine style with two linked elements is ONE undo step (it is one per element)",
      async () => {
        covers("command:media.paged.draw.command.redefineGraphicStyle");
        await withStyle();
        await rig.h.host.selection.set([POLY]);
        await rig.run(`${C}.applyGraphicStyle`, { styleId: "gs-1" });
        await rig.h.host.selection.set([el("graphicLine", "uline")]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.redefineGraphicStyle`, { styleId: "gs-1" }),
        );
      },
    );

    it("Break style link unlinks the selection from its style; an unlinked path is refused", async () => {
      covers("command:media.paged.draw.command.breakGraphicStyleLink");
      await withStyle();
      await rig.h.host.selection.set([POLY]);
      await rig.run(`${C}.applyGraphicStyle`, { styleId: "gs-1" });
      await rig.h.host.selection.set([POLY]);
      await expectApplies(rig, `${C}.breakGraphicStyleLink`);
      await expectRefuses(rig, F1(), [POLY], `${C}.breakGraphicStyleLink`);
    });

    it("Rename style renames it in the library only; an unknown style is refused", async () => {
      covers("command:media.paged.draw.command.renameGraphicStyle");
      await withStyle();
      const library = await expectLibraryOnly(rig, `${C}.renameGraphicStyle`, {
        styleId: "gs-1",
        name: "Heavy rule",
      });
      expect(library).toContain("Heavy rule");
      await expectRefuses(rig, F1(), [], `${C}.renameGraphicStyle`, {
        styleId: "gs-404",
        name: "x",
      });
    });

    it("Delete style removes it; an unknown style is refused", async () => {
      covers("command:media.paged.draw.command.deleteGraphicStyle");
      await withStyle();
      await expectApplies(rig, `${C}.deleteGraphicStyle`, { styleId: "gs-1" });
      await expectRefuses(rig, F1(), [], `${C}.deleteGraphicStyle`, {
        styleId: "gs-404",
      });
    });
  });

  describe("the appearance stack", () => {
    // DRW-4: an appearance edit that leaves a stack to paint is two undo
    // steps: the stack in the plugin metadata, then the batch that
    // paints its front-most layer onto the frame.
    it("Add fill refuses an empty selection", async () => {
      covers("command:media.paged.draw.command.appearanceAddFill");
      await expectRefuses(rig, F1(), [], `${C}.appearanceAddFill`);
    });

    it.failing("DRW-4 — Add fill is ONE undo step (it is two)", async () => {
      covers("command:media.paged.draw.command.appearanceAddFill");
      await rig.open(F1(), [RECT]);
      await brokenInvariant("INV-4", () =>
        expectApplies(rig, `${C}.appearanceAddFill`),
      );
    });

    it("Add stroke refuses an empty selection", async () => {
      covers("command:media.paged.draw.command.appearanceAddStroke");
      await expectRefuses(rig, F1(), [], `${C}.appearanceAddStroke`);
    });

    it.failing("DRW-4 — Add stroke is ONE undo step (it is two)", async () => {
      covers("command:media.paged.draw.command.appearanceAddStroke");
      await rig.open(F1(), [RECT]);
      await brokenInvariant("INV-4", () =>
        expectApplies(rig, `${C}.appearanceAddStroke`),
      );
    });

    it("DRW-4, measured: Add fill and Add stroke take two undo steps each", async () => {
      covers(
        "command:media.paged.draw.command.appearanceAddFill",
        "command:media.paged.draw.command.appearanceAddStroke",
      );
      await rig.open(F1(), [RECT]);
      expect(
        await undoStepsOf(rig, () => rig.run(`${C}.appearanceAddFill`)),
      ).toBe(2);
      await rig.open(F1(), [RECT]);
      expect(
        await undoStepsOf(rig, () => rig.run(`${C}.appearanceAddStroke`)),
      ).toBe(2);
    });

    it("Clear appearance empties the stack; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.appearanceClear");
      await rig.open(F1(), [RECT]);
      await rig.run(`${C}.appearanceAddFill`);
      await expectApplies(rig, `${C}.appearanceClear`);
      await expectRefuses(rig, F1(), [], `${C}.appearanceClear`);
    });

    it("Remove layer drops one fill from the stack; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.appearanceRemoveLayer");
      await rig.open(F1(), [RECT]);
      await rig.run(`${C}.appearanceAddFill`);
      await expectApplies(rig, `${C}.appearanceRemoveLayer`, {
        kind: "fill",
        index: 0,
      });
      await expectRefuses(rig, F1(), [], `${C}.appearanceRemoveLayer`, {
        kind: "fill",
        index: 0,
      });
    });

    it("Move layer refuses an empty selection", async () => {
      covers("command:media.paged.draw.command.appearanceMoveLayer");
      await expectRefuses(rig, F1(), [], `${C}.appearanceMoveLayer`, {
        kind: "fill",
        index: 0,
        delta: 1,
      });
    });

    it.failing("DRW-4 — Move layer is ONE undo step (it is two)", async () => {
      covers("command:media.paged.draw.command.appearanceMoveLayer");
      await rig.open(F1(), [RECT]);
      await rig.h.host.document.setMetadata(RECT, {
        v: 1,
        data: {
          appearance: {
            fills: [
              { color: "Color/Black", tint: 100 },
              { color: "Color/Black", tint: 40 },
            ],
            strokes: [],
          },
        },
      });
      await brokenInvariant("INV-4", () =>
        expectApplies(rig, `${C}.appearanceMoveLayer`, {
          kind: "fill",
          index: 0,
          delta: 1,
        }),
      );
    });

    // DRW-5: a bake is two batches and two undo steps (ADR 354 names the
    // cost: the bake has not been moved onto `bindCreated`).
    it("Bake appearance refuses an empty selection", async () => {
      covers("command:media.paged.draw.command.bakeAppearance");
      await expectRefuses(rig, F1(), [], `${C}.bakeAppearance`);
    });

    it.failing(
      "DRW-5 — Bake appearance is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.bakeAppearance");
        await rig.open(F1(), [RECT]);
        await rig.run(`${C}.appearanceAddFill`);
        await rig.run(`${C}.appearanceAddStroke`);
        await rig.h.host.selection.set([RECT]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.bakeAppearance`),
        );
      },
    );

    it("Release appearance gives the baked stack back; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.releaseAppearance");
      await rig.open(F1(), [RECT]);
      await rig.run(`${C}.appearanceAddFill`);
      await rig.run(`${C}.appearanceAddStroke`);
      await rig.h.host.selection.set([RECT]);
      await rig.run(`${C}.bakeAppearance`);
      await rig.h.host.selection.set([RECT]);
      await expectApplies(rig, `${C}.releaseAppearance`);
      await expectRefuses(rig, F1(), [], `${C}.releaseAppearance`);
    });
  });

  // DRW-6: a trace is TWO batches — the paths, then their paint and the
  // group — so two undo steps (the module header states it).
  describe("Image Trace", () => {
    it("refuses a selection with no placed image", async () => {
      covers("command:media.paged.draw.command.imageTrace");
      await expectRefuses(rig, F1(), [POLY], `${C}.imageTrace`);
    });

    it("DRW-6, measured: tracing the selected ring takes two undo steps to take back", async () => {
      covers("command:media.paged.draw.command.imageTrace");
      const uninstall = installPngRealm();
      try {
        const image = el("rectangle", F7_PLACED_IMAGE.ids.rectangle!);
        await rig.open(F7_PLACED_IMAGE.bytes(), [image]);
        const before = await rig.channel.dump();
        expect(
          await undoStepsOf(rig, () =>
            rig.run(`${C}.imageTrace`, { mode: "bw" }),
          ),
        ).toBe(2);
        await rig.h.host.editor.client.send({ kind: "redo" });
        await rig.h.host.editor.client.send({ kind: "redo" });
        expect(await rig.channel.dump()).not.toBe(before);
      } finally {
        uninstall();
      }
    });

    it.failing("DRW-6 — Image Trace is ONE undo step (it is two)", async () => {
      covers("command:media.paged.draw.command.imageTrace");
      const uninstall = installPngRealm();
      try {
        const image = el("rectangle", F7_PLACED_IMAGE.ids.rectangle!);
        await rig.open(F7_PLACED_IMAGE.bytes(), [image]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.imageTrace`, { mode: "bw" }),
        );
      } finally {
        uninstall();
      }
    });
  });
});
