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

// Properties (paged.properties): the context inspector. It routes the
// selection to its sections (text: Character + Paragraph; image: Object +
// Fitting + Stroke; frame or group: Object + Stroke; nothing: the
// panel-rail steer or a hint) and titles itself for what is selected. The
// sections' own controls are tested in their panels' files; here each
// route is asserted, and one write per section proves the section is
// wired to the selection it shows.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { PropertiesPanel } from "../../src/panels/properties-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(PropertiesPanel, { id: "paged.properties", scene: richScene });

const addr = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;

const root = (h: PanelHarness<unknown>) =>
  h.root.querySelector<HTMLElement>("[data-properties-panel]")!;
const kind = (h: PanelHarness<unknown>) =>
  root(h).getAttribute("data-inspector-kind");
const sections = (h: H) =>
  [...h.root.querySelectorAll("[data-properties-section]")].map((s) =>
    s.getAttribute("data-properties-section"),
  );
const label = (h: H) =>
  h.root.querySelector("[data-selection-label]")?.textContent ?? null;

describe("Properties panel: the route follows the selection", () => {
  test("nothing selected, no steer: the hint, no sections, no assistant link", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    expect(kind(h)).toBe("none");
    expect(h.root.querySelector("[data-properties-empty]")?.textContent).toBe(
      "Select a frame or place a text caret to see its properties.",
    );
    expect(sections(h)).toEqual([]);
    expect(h.root.querySelector("[data-ai-assistant-link]")).toBeNull();
  });

  test("no document: the same hint", async () => {
    covers("panel:paged.properties");
    const h = await mountPanel(PropertiesPanel, {
      id: "paged.properties",
      document: "none",
    });
    expect(kind(h)).toBe("none");
  });

  test("a rectangle: Frame, Object and Stroke", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(kind(h)).toBe("frame");
    expect(label(h)).toBe("Frame · 1 frame");
    expect(sections(h)).toEqual(["object", "stroke"]);
    expect(h.root.querySelector("[data-ai-assistant-link]")).not.toBeNull();
  });

  test("a group: titled Group and counting what is in it", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.group]);
    expect(kind(h)).toBe("frame");
    expect(label(h)).toBe("Group · 2 objects");
    expect(sections(h)).toEqual(["object", "stroke"]);
  });

  test("a group and a frame: titled Objects", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.group, h.scene.rect]);
    expect(label(h)).toBe("Objects · 1 group, 1 frame");
  });

  test("two frames: one label, the shared sections", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.oval]);
    expect(label(h)).toBe("Frame · 2 frames");
    expect(sections(h)).toEqual(["object", "stroke"]);
  });

  test("a caret: Text, Character and Paragraph", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.caret(h.scene.storyId, 3);
    expect(kind(h)).toBe("text");
    expect(label(h)).toBe("Text selection");
    expect(sections(h)).toEqual(["character", "paragraph"]);
  });

  test("leaving the text goes back to the hint", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.caret(h.scene.storyId, 3);
    await h.leaveText();
    expect(kind(h)).toBe("none");
  });

  test("the rail's Page steer with nothing selected: the page summary from the document", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.steer("page");
    expect(kind(h)).toBe("page");
    const text = root(h).textContent ?? "";
    expect(text).toContain("Pages");
    expect(text).toContain("2");
  });

  test("the rail's Image steer on a frame without an image says so", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.steer("image");
    expect(kind(h)).toBe("image");
    expect(h.root.querySelector("[data-properties-no-image]")).not.toBeNull();
    expect(sections(h)).toEqual(["object", "stroke"]);
  });

  test("a selection wins over the steer, and a new selection drops an image steer", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.steer("image");
    await h.select([h.scene.oval]);
    expect(kind(h)).toBe("frame");
  });
});

describe("Properties panel: each section writes the selection it shows", () => {
  test("Stroke: weight on the selected rectangle", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("frameStrokeWeight", "4");
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address: addr(h.scene.rect),
          path: "frameStrokeWeight",
          value: { type: "length", value: 4 },
        },
      },
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameStrokeWeight")).toEqual({
      type: "length",
      value: 4,
    });
  });

  test("Character: size on the selected text", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.selectText(h.scene.storyId, 0, 5);
    const from = h.mark();
    await h.typeInto("characterFontSize", "16");
    const address = `storyRange:${h.scene.storyId}@0..5`;
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address,
          path: "characterFontSize",
          value: { type: "length", value: 16 },
        },
      },
    ] as never);
    expect(await h.get(address, "characterFontSize")).toEqual({
      type: "length",
      value: 16,
    });
  });

  test("Paragraph: space before on the caret's paragraph", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    const from = h.mark();
    await h.typeInto("paragraphSpaceBefore", "6");
    const sent = h.mutations(from) as unknown as Array<{
      args: { address: string; path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("paragraphSpaceBefore");
    expect(
      sent[0].args.address.startsWith(`storyRange:${h.scene.storyId}@`),
    ).toBe(true);
    expect(sent[0].args.value.value).toBe(6);
    expect(
      (
        (await h.get(sent[0].args.address, "paragraphSpaceBefore")) as {
          value: number;
        }
      ).value,
    ).toBe(6);
  });

  test("Ask the AI Assistant opens the assistant", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    const button = h.view.getByRole("button", { name: /Ask the AI Assistant/ });
    await h.click(button);
    // openAssistant routes through the shell's assistant opener; with
    // no assistant registered in this mount it must not throw.
    expect(button.isConnected).toBe(true);
  });
});

describe("Properties panel: findings", () => {
  // UX audit F-37: "Properties shows Frame and stroke rows ... before the
  // type settings". The text frame stays selected when the Type tool
  // places a caret in it, and the Object and Stroke sections render first.
  test.failing(
    "PN-22 (UX F-37): with a caret in a selected text frame, the type sections come first",
    async () => {
      covers("panel:paged.properties");
      const h = await mount();
      await h.select([h.scene.textFrame]);
      await h.caret(h.scene.storyId, 3);
      expect(kind(h)).toBe("text");
      expect(sections(h).slice(0, 2)).toEqual(["character", "paragraph"]);
    },
  );

  // The page summary says margins, bleed and columns "land with the
  // engine's page-geometry accessors", but the pages collection carries
  // them (marginTopPt, bleedTopPt, columnCount): a seam that outlived its
  // gap.
  test.failing(
    "PN-23: the page summary shows margins, bleed and columns the engine already reports",
    async () => {
      covers("panel:paged.properties");
      const h = await mount();
      const pages = (await h.client.collection("pages")) as Array<{
        marginTopPt: number;
        columnCount: number;
      }>;
      expect(pages[0]).toHaveProperty("marginTopPt");
      expect(pages[0]).toHaveProperty("columnCount");
      await h.steer("page");
      expect(root(h).textContent).not.toContain("land with the engine");
      expect(root(h).textContent).toContain("Margins");
    },
  );

  // UX audit F-39: the Page summary reads "8.5 in × 11 in" while every
  // other length in the editor is in points.
  test.failing(
    "PN-24 (UX F-39): the page size reads in the document's unit, like every other length",
    async () => {
      covers("panel:paged.properties");
      const h = await mount();
      await h.steer("page");
      expect(root(h).textContent).not.toContain(" in ×");
    },
  );
});
