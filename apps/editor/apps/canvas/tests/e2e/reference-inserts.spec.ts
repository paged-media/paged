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

// E2E — the reference inserts are the host's (P2): `paged.insert.footnote`,
// `bookmark` (a named destination), `crossReference` and `indexEntry` write
// at the text cursor in any document, one undo step each, and the
// Cross-References and Index panels carry their forms. paged.doc's
// Word-styled References dialog calls the same commands (its spec:
// modules/doc structure-commands.spec.ts).

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";

interface CommandsGlobal {
  __canvas: {
    registries: {
      commands: { invoke(id: string, payload?: unknown): Promise<unknown> };
    };
    client: { undoLog(): Promise<{ undoLen: number }> };
  };
}

const run = (page: Page, id: string, payload?: unknown) =>
  page.evaluate(
    ([i, p]) =>
      (
        globalThis as unknown as CommandsGlobal
      ).__canvas.registries.commands.invoke(i as string, p),
    [id, payload] as const,
  );

const undoLen = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (
          globalThis as unknown as CommandsGlobal
        ).__canvas.client.undoLog()
      ).undoLen,
  );

test.describe("reference inserts are host commands", () => {
  test("a footnote, a destination, a cross-reference and an index entry at the cursor, one undo step each @feat:cross-references-hyperlinks.cross-references @feat:cross-references-hyperlinks.index @feat:stories-text.footnotes @level:happy", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    covers(
      "command:paged.insert.footnote",
      "command:paged.insert.bookmark",
      "command:paged.insert.crossReference",
      "command:paged.insert.indexEntry",
      "panel:paged.cross-references",
      "panel:paged.index",
    );
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const { storyId } = await designer.addTextFrame({
      x0: 100,
      y0: 100,
      x1: 420,
      y1: 300,
    });
    expect(storyId).toBeTruthy();
    await designer.placeCaret(storyId!, 0);
    await designer.typeText("Alpha beta gamma");
    await expect.poll(() => designer.storyChars(storyId!)).toBeGreaterThan(10);
    await designer.placeCaret(storyId!, 5);

    const count = async (name: string) =>
      (await designer.collection(name)).length;
    const step = async (
      what: string,
      id: string,
      payload: unknown,
      collection: string | null,
    ) => {
      const before = await undoLen(page);
      const had = collection ? await count(collection) : 0;
      await run(page, id, payload);
      await expect
        .poll(() => undoLen(page), { message: `${what}: one undo step` })
        .toBe(before + 1);
      if (collection)
        await expect
          .poll(() => count(collection), { message: what })
          .toBe(had + 1);
    };
    await step("footnote", "paged.insert.footnote", { text: "" }, "footnotes");
    await step("destination", "paged.insert.bookmark", { name: "Here" }, null);
    await step(
      "cross-reference",
      "paged.insert.crossReference",
      { bookmark: "Here", referTo: "pageNumber" },
      "crossReferences",
    );
    await step(
      "index entry",
      "paged.insert.indexEntry",
      { topic: ["Alpha", "Beta"] },
      "indexTopics",
    );

    // The panels carry the forms (a bare command opens its panel).
    await run(page, "paged.insert.crossReference");
    await expect(
      page.locator(
        '[data-cross-references-panel="ready"] [data-cross-reference-insert]',
      ),
    ).toBeVisible();
    await run(page, "paged.insert.indexEntry");
    await expect(
      page.locator('[data-index-panel="ready"] [data-index-entry-insert]'),
    ).toBeVisible();
  });
});
