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

// Glyphs (paged.glyphs): the glyph grid inserts at the text caret through
// `insertText`; the font scope and the character map are honest seams.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { GlyphsPanel } from "../../src/panels/concept/glyphs-panel";
import { richScene, TEXT, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(GlyphsPanel, { id: "paged.glyphs", scene: richScene });

const glyph = (h: H, g: string, grid = "all") =>
  h.root.querySelector<HTMLButtonElement>(
    `[data-glyph-grid="${grid}"] [data-glyph="${g}"]`,
  ) ?? h.root.querySelector<HTMLButtonElement>(`[data-glyph="${g}"]`)!;

/** The story's text as the model holds it. */
async function storyText(h: H): Promise<string> {
  const reply = (await h.client.send({
    kind: "requestStoryContent",
    payload: { storyId: h.scene.storyId },
  } as never)) as {
    payload: {
      content: { paragraphs: Array<{ runs: Array<{ text: string }> }> };
    };
  };
  return reply.payload.content.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join("\n");
}

describe("Glyphs: states", () => {
  test("no caret: the grid is disabled and says why", async () => {
    covers("panel:paged.glyphs");
    const h = await mount();
    expect(h.root.querySelector("[data-glyphs-hint]")!.textContent).toBe(
      "Place a text caret to insert glyphs.",
    );
    const buttons = h.root.querySelectorAll<HTMLButtonElement>("[data-glyph]");
    expect(buttons.length).toBe(32);
    for (const b of buttons) expect(b.disabled).toBe(true);
    const from = h.mark();
    await h.click(glyph(h, "—"));
    expect(h.mutations(from)).toEqual([]);
  });

  test("the seams: Show, the font (no document fonts listed) and the style are disabled", async () => {
    covers("panel:paged.glyphs");
    const h = await mount();
    const seams =
      h.root.querySelectorAll<HTMLSelectElement>("select[data-seam]");
    expect(seams.length).toBe(3);
    for (const s of seams) expect(s.disabled).toBe(true);
  });

  test("a caret: the grid is live, each glyph named for what it inserts", async () => {
    covers("panel:paged.glyphs");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    expect(h.root.querySelector("[data-glyphs-hint]")).toBe(null);
    expect(glyph(h, "©").disabled).toBe(false);
    expect(glyph(h, "©").title).toBe("Insert ©");
  });
});

describe("Glyphs: inserting", () => {
  test("a glyph goes in at the caret, and joins Recently used", async () => {
    covers("panel:paged.glyphs");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    const from = h.mark();
    await h.click(glyph(h, "—"));
    expect(h.mutations(from)).toEqual([
      {
        op: "insertText",
        args: { storyId: h.scene.storyId, offset: 2, text: "—" },
      },
    ] as never);
    expect(await storyText(h)).toBe(`He—${TEXT.slice(2)}`);
    const recent = h.root.querySelectorAll(
      "[data-glyph-grid=recent] [data-glyph]",
    );
    expect([...recent].map((b) => b.getAttribute("data-glyph"))).toEqual(["—"]);
  });

  test("Recently used keeps the latest first, once each", async () => {
    covers("panel:paged.glyphs");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    await h.click(glyph(h, "—"));
    await h.click(glyph(h, "©"));
    await h.click(glyph(h, "—"));
    const recent = h.root.querySelectorAll(
      "[data-glyph-grid=recent] [data-glyph]",
    );
    expect([...recent].map((b) => b.getAttribute("data-glyph"))).toEqual([
      "—",
      "©",
    ]);
  });

  // The insert never moves the caret: each click inserts at the same
  // offset, so "— ©" lands as "©—".
  test.failing(
    "PN-210: two glyphs clicked in a row land in the order clicked",
    async () => {
      covers("panel:paged.glyphs");
      const h = await mount();
      await h.caret(h.scene.storyId, 2);
      await h.click(glyph(h, "—"));
      await h.click(glyph(h, "©"));
      expect(await storyText(h)).toBe(`He—©${TEXT.slice(2)}`);
    },
  );

  // With a range selected the glyph is inserted after it; in a text
  // editor (InDesign included) a typed or inserted character replaces
  // the selection.
  test.failing(
    "PN-211: a glyph inserted over a selected range replaces it",
    async () => {
      covers("panel:paged.glyphs");
      const h = await mount();
      await h.selectText(h.scene.storyId, 0, 5);
      await h.click(glyph(h, "©"));
      expect(await storyText(h)).toBe(`©${TEXT.slice(5)}`);
    },
  );
});
