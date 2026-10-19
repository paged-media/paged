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

// THE OBJECT COMMANDS against the real engine — Pathfinder, compound
// paths, inserted shapes, Select Same, opacity masks, type on a path,
// Create Outlines and the Path Options "…" commands — held to the kit's
// contract (`command-kit.ts`): one undo step that undoes and redoes
// exactly, and no change where the command does not apply.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { buildIdml } from "../fixtures/build-idml";
import { F1_MULTI_SHAPE, F4_OVERLAP, F6_RING_PAIR } from "../fixtures/corpus";
import {
  commandRig,
  el,
  expectApplies,
  expectRefuses,
  expectSelects,
  type CommandRig,
} from "./command-kit";

const C = "media.paged.draw.command";
const RECT = el("rectangle", "urect");
const POLY = el("polygon", "upoly");
const LINE = el("graphicLine", "uline");
const A = el("polygon", "ua");
const B = el("polygon", "ub");
const OUTER = el("polygon", "uouter");
const INNER = el("polygon", "uinner");
const F1 = () => F1_MULTI_SHAPE.bytes();
const F4 = () => F4_OVERLAP.bytes();

const HERE = dirname(fileURLToPath(import.meta.url));
const LORA = new Uint8Array(
  readFileSync(join(HERE, "../fixtures/fonts/Lora.ttf")),
);

/** One text frame (`tf`) of two glyph runs in Lora, for Create Outlines. */
const TEXT_DOC = (): Uint8Array =>
  buildIdml([
    {
      name: "mimetype",
      data: "application/vnd.adobe.indesign-idml-package",
      store: true,
    },
    {
      name: "designmap.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0" Self="d">
<idPkg:Graphic src="Resources/Graphic.xml"/>
<idPkg:Spread src="Spreads/Spread_s.xml"/>
<idPkg:Story src="Stories/Story_st.xml"/>
</Document>`,
    },
    {
      name: "Resources/Graphic.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
</idPkg:Graphic>`,
    },
    {
      name: "Spreads/Spread_s.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Spread Self="s" PageCount="1" ItemTransform="1 0 0 1 0 0">
<Page Self="p" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf" ParentStory="st" GeometricBounds="300 40 380 400" ItemTransform="1 0 0 1 0 0" StrokeWeight="0"/>
</Spread>
</idPkg:Spread>`,
    },
    {
      name: "Stories/Story_st.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Story Self="st"><ParagraphStyleRange>
<CharacterStyleRange AppliedFont="Lora" PointSize="36" FillColor="Color/Black"><Content>Ho</Content></CharacterStyleRange>
</ParagraphStyleRange></Story>
</idPkg:Story>`,
    },
  ]);

describe("paged.draw commands — objects (real engine)", () => {
  let rig: CommandRig;
  beforeAll(async () => {
    rig = await commandRig();
  }, 60_000);
  afterAll(() => rig?.dispose());

  /** A story that flows in no frame, for type on a path to pick up. */
  async function freeStory(text: string): Promise<void> {
    const frame = await rig.h.host.document.mutate({
      op: "insertTextFrame",
      args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [20, 20, 140, 80] },
    });
    if (!frame.applied) throw new Error("insertTextFrame failed");
    const stories = (await rig.h.host.document.collection("stories")) as {
      selfId: string;
    }[];
    const storyId = stories.at(-1)!.selfId;
    const typed = await rig.h.host.document.mutate({
      op: "insertText",
      args: { storyId, offset: 0, text },
    });
    if (!typed.applied) throw new Error("insertText failed");
    const removed = await rig.h.host.document.mutate({
      op: "deleteFrame",
      args: { frameId: String((frame.createdId as { id: unknown }).id) },
    });
    if (!removed.applied) throw new Error("deleteFrame failed");
  }

  describe("Pathfinder", () => {
    it("Unite merges the two overlapping quads; one quad is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderUnite");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderUnite`);
      await expectRefuses(rig, F4(), [A], `${C}.pathfinderUnite`);
    });

    it("Minus front cuts the front quad out of the back one; one quad is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderSubtract");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderSubtract`);
      await expectRefuses(rig, F4(), [A], `${C}.pathfinderSubtract`);
    });

    it("Intersect keeps the overlap; one quad is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderIntersect");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderIntersect`);
      await expectRefuses(rig, F4(), [A], `${C}.pathfinderIntersect`);
    });

    it("Exclude keeps everything but the overlap; one quad is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderExclude");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderExclude`);
      await expectRefuses(rig, F4(), [A], `${C}.pathfinderExclude`);
    });

    it("Divide splits the pair into its faces; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderDivide");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderDivide`);
      await expectRefuses(rig, F4(), [], `${C}.pathfinderDivide`);
    });

    it("Trim removes the hidden parts; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderTrim");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderTrim`);
      await expectRefuses(rig, F4(), [], `${C}.pathfinderTrim`);
    });

    it("Merge trims and merges same-paint faces; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderMerge");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderMerge`);
      await expectRefuses(rig, F4(), [], `${C}.pathfinderMerge`);
    });

    it("Crop keeps what the top quad covers; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderCrop");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderCrop`);
      await expectRefuses(rig, F4(), [], `${C}.pathfinderCrop`);
    });

    it("Outline turns the faces into their edges; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderOutline");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderOutline`);
      await expectRefuses(rig, F4(), [], `${C}.pathfinderOutline`);
    });

    it("Minus back cuts the back quad out of the front one; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.pathfinderMinusBack");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.pathfinderMinusBack`);
      await expectRefuses(rig, F4(), [], `${C}.pathfinderMinusBack`);
    });
  });

  describe("compound paths", () => {
    it("Make compound path joins the ring pair into one element with a hole; one path is refused", async () => {
      covers("command:media.paged.draw.command.makeCompoundPath");
      await rig.open(F6_RING_PAIR.bytes(), [OUTER, INNER]);
      await expectApplies(rig, `${C}.makeCompoundPath`);
      await expectRefuses(
        rig,
        F6_RING_PAIR.bytes(),
        [],
        `${C}.makeCompoundPath`,
      );
    });

    it("Release compound path splits it back into one element per contour; a plain path is refused", async () => {
      covers("command:media.paged.draw.command.releaseCompoundPath");
      await rig.open(F6_RING_PAIR.bytes(), [OUTER, INNER]);
      await rig.run(`${C}.makeCompoundPath`);
      await rig.h.host.selection.set([OUTER]);
      await expectApplies(rig, `${C}.releaseCompoundPath`);
      await expectRefuses(
        rig,
        F6_RING_PAIR.bytes(),
        [OUTER],
        `${C}.releaseCompoundPath`,
      );
    });
  });

  describe("inserted shapes", () => {
    it("Insert arc places a new arc path on the page", async () => {
      covers("command:media.paged.draw.command.insertArc");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertArc`);
    });

    it("Insert spiral places a new spiral path on the page", async () => {
      covers("command:media.paged.draw.command.insertSpiral");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertSpiral`);
    });

    it("Insert rectangular grid places a new grid on the page", async () => {
      covers("command:media.paged.draw.command.insertRectGrid");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertRectGrid`);
    });

    it("Insert polar grid places a new grid on the page", async () => {
      covers("command:media.paged.draw.command.insertPolarGrid");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertPolarGrid`);
    });
  });

  describe("Select Same", () => {
    const ids = (s: readonly ElementId[]) =>
      s.map((e) => `${e.kind}:${String(e.id)}`).sort();

    it("Select same fill selects every element painted like the selection; nothing selected selects nothing", async () => {
      covers("command:media.paged.draw.command.selectSameFill");
      await rig.open(F1(), [RECT]);
      await expectSelects(rig, `${C}.selectSameFill`, (s) =>
        expect(ids(s)).toContain("rectangle:urect"),
      );
      await rig.open(F1(), []);
      await expectSelects(rig, `${C}.selectSameFill`, (s) =>
        expect(s).toEqual([]),
      );
    });

    it("Select same stroke selects every element stroked like the selection; nothing selected selects nothing", async () => {
      covers("command:media.paged.draw.command.selectSameStroke");
      await rig.open(F1(), [POLY]);
      await expectSelects(rig, `${C}.selectSameStroke`, (s) =>
        expect(ids(s)).toContain("polygon:upoly"),
      );
      await rig.open(F1(), []);
      await expectSelects(rig, `${C}.selectSameStroke`, (s) =>
        expect(s).toEqual([]),
      );
    });

    it("Select same stroke weight selects every element of that weight; nothing selected selects nothing", async () => {
      covers("command:media.paged.draw.command.selectSameStrokeWeight");
      await rig.open(F1(), [POLY]);
      await expectSelects(rig, `${C}.selectSameStrokeWeight`, (s) =>
        expect(ids(s)).toContain("polygon:upoly"),
      );
      await rig.open(F1(), []);
      await expectSelects(rig, `${C}.selectSameStrokeWeight`, (s) =>
        expect(s).toEqual([]),
      );
    });
  });

  describe("opacity masks", () => {
    it("Make opacity mask masks the lower quad with the upper one; one quad is refused", async () => {
      covers("command:media.paged.draw.command.makeOpacityMask");
      await rig.open(F4(), [A, B]);
      await expectApplies(rig, `${C}.makeOpacityMask`);
      await expectRefuses(rig, F4(), [A], `${C}.makeOpacityMask`);
    });

    it("Release opacity mask gives the mask back as an element; an unmasked quad is refused", async () => {
      covers("command:media.paged.draw.command.releaseOpacityMask");
      await rig.open(F4(), [A, B]);
      await rig.run(`${C}.makeOpacityMask`);
      await rig.h.host.selection.set([A]);
      await expectApplies(rig, `${C}.releaseOpacityMask`);
      await expectRefuses(rig, F4(), [B], `${C}.releaseOpacityMask`);
    });
  });

  describe("type on a path", () => {
    it("Attach story to path flows a free story along the selected line; nothing selected is refused", async () => {
      covers("command:media.paged.draw.command.attachTextToPath");
      await rig.open(F1(), [LINE]);
      await freeStory("On a line");
      await expectApplies(rig, `${C}.attachTextToPath`);
      await expectRefuses(rig, F1(), [], `${C}.attachTextToPath`);
    });

    it("Detach text from path unflows the story and keeps it; a path carrying nothing is refused", async () => {
      covers("command:media.paged.draw.command.detachTextFromPath");
      await rig.open(F1(), [LINE]);
      await freeStory("Round trip");
      await rig.run(`${C}.attachTextToPath`);
      await rig.h.host.selection.set([LINE]);
      await expectApplies(rig, `${C}.detachTextFromPath`);
      await expectRefuses(rig, F1(), [POLY], `${C}.detachTextFromPath`);
    });
  });

  describe("Create Outlines", () => {
    it("turns the selected text frame into paths; a path is refused", async () => {
      covers("command:media.paged.draw.command.createOutlines");
      await rig.h.host.editor.client.send({
        kind: "registerFont",
        payload: { family: "Lora", style: null, bytes: Array.from(LORA) },
      } as never);
      await rig.open(TEXT_DOC(), [el("textFrame", "tf")]);
      await expectApplies(rig, `${C}.createOutlines`);
      await expectRefuses(rig, F1(), [POLY], `${C}.createOutlines`);
    });
  });

  // On a host that cannot raise a panel (this one: no shell doors), a
  // "…" command applies its operation with the last used values and says
  // so — the panel-raising branch is asserted over the fake editor in
  // `test/commands/path-options.spec.ts`.
  describe("the Path Options “…” commands, on a host without panels", () => {
    it("Offset path… offsets the selected closed path with the last used values", async () => {
      covers("command:media.paged.draw.command.offsetPathOptions");
      await rig.open(F4(), [A]);
      await expectApplies(rig, `${C}.offsetPathOptions`);
      await expectRefuses(rig, F4(), [], `${C}.offsetPathOptions`);
    });

    it("Simplify… simplifies the selected path with the last used tolerance", async () => {
      covers("command:media.paged.draw.command.simplifyPathOptions");
      await rig.open(F1(), []);
      // A middle anchor half a point off its chord: inside the default
      // 1 pt tolerance.
      const made = await rig.h.host.document.mutate({
        op: "insertPath",
        args: {
          pageId: F1_MULTI_SHAPE.pageId,
          anchors: [
            { anchor: [100, 500], left: [100, 500], right: [100, 500] },
            { anchor: [200, 500.5], left: [200, 500.5], right: [200, 500.5] },
            { anchor: [300, 500], left: [300, 500], right: [300, 500] },
          ],
          open: true,
        },
      });
      if (!made.applied || !made.createdId)
        throw new Error("insertPath failed");
      await rig.h.host.selection.set([made.createdId]);
      await expectApplies(rig, `${C}.simplifyPathOptions`);
      await expectRefuses(rig, F1(), [], `${C}.simplifyPathOptions`);
    });

    it("Outline stroke… outlines the selected path's own stroke", async () => {
      covers("command:media.paged.draw.command.outlineStrokeOptions");
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.outlineStrokeOptions`);
      await expectRefuses(rig, F1(), [], `${C}.outlineStrokeOptions`);
    });

    it("Dashes… applies the last used dash (solid, unedited) to the selection", async () => {
      covers("command:media.paged.draw.command.strokeDashOptions");
      await rig.open(F1(), [RECT]);
      await rig.run(`${C}.strokeDashDashed`);
      await expectApplies(rig, `${C}.strokeDashOptions`);
      await expectRefuses(rig, F1(), [], `${C}.strokeDashOptions`);
    });

    it("Reflect… reflects the selection about the last used axis", async () => {
      covers("command:media.paged.draw.command.reflectOptions");
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.reflectOptions`);
      await expectRefuses(rig, F1(), [], `${C}.reflectOptions`);
    });

    it("Arc… inserts an arc with the last used parameters", async () => {
      covers("command:media.paged.draw.command.insertArcOptions");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertArcOptions`);
    });

    it("Spiral… inserts a spiral with the last used parameters", async () => {
      covers("command:media.paged.draw.command.insertSpiralOptions");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertSpiralOptions`);
    });

    it("Rectangular grid… inserts a grid with the last used parameters", async () => {
      covers("command:media.paged.draw.command.insertRectGridOptions");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertRectGridOptions`);
    });

    it("Polar grid… inserts a grid with the last used parameters", async () => {
      covers("command:media.paged.draw.command.insertPolarGridOptions");
      await rig.open(F1(), []);
      await expectApplies(rig, `${C}.insertPolarGridOptions`);
    });

    it("Stroke weight within… selects by weight with the last used tolerance", async () => {
      covers("command:media.paged.draw.command.selectSameStrokeWeightOptions");
      await rig.open(F1(), [POLY]);
      await expectSelects(rig, `${C}.selectSameStrokeWeightOptions`, (s) =>
        expect(s.length).toBeGreaterThan(0),
      );
    });
  });
});
