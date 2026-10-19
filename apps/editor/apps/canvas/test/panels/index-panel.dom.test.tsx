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

// Index (paged.index): the index topics, and Generate index, which
// writes the index into the story holding the text cursor (replacing its
// text). The button needs a caret in a story's body text.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { IndexPanel } from "../../src/panels/index-panel";
import { mountPanel, unmountAll } from "./harness";
import { rows, structureIdml, STRUCTURE } from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(IndexPanel, { id: "paged.index", document });

const generate = (root: Element) =>
  root.querySelector<HTMLButtonElement>("[data-generate-index]")!;

describe("Index panel: states", () => {
  test("no document: the empty state, Generate disabled", async () => {
    covers("panel:paged.index");
    const h = await mount("none");
    expect(h.root.querySelector("[data-empty-index]")?.textContent).toBe(
      "No index topics in this document.",
    );
    expect(generate(h.root).disabled).toBe(true);
  });

  test("lists the topics with their sort order", async () => {
    covers("panel:paged.index");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary, r.secondary])).toEqual([
      [STRUCTURE.topics[0], "Apples", "apples"],
      [STRUCTURE.topics[1], "Bananas", ""],
    ]);
  });

  test("Generate needs a caret: disabled with none, its title says where to click", async () => {
    covers("panel:paged.index");
    const h = await mount();
    expect(generate(h.root).disabled).toBe(true);
    expect(generate(h.root).title).toBe(
      "Place the text cursor in the story that will hold the index",
    );
  });

  test("a caret in a story enables it; leaving the text disables it again", async () => {
    covers("panel:paged.index");
    const h = await mount();
    await h.caret(STRUCTURE.story, 3);
    expect(generate(h.root).disabled).toBe(false);
    expect(generate(h.root).title).toContain("its text is replaced");
    await h.leaveText();
    expect(generate(h.root).disabled).toBe(true);
  });
});

describe("Index panel: controls", () => {
  test("Generate index writes the index into the caret's story", async () => {
    covers("panel:paged.index");
    const h = await mount();
    await h.caret(STRUCTURE.story, 3);
    const from = h.mark();
    await h.click(generate(h.root));
    expect(h.mutations(from)).toEqual([
      { op: "generateIndex", args: { storyId: STRUCTURE.story } },
    ] as never);
    const content = (await h.client.send({
      kind: "requestStoryContent",
      payload: { storyId: STRUCTURE.story },
    } as never)) as {
      payload: {
        content: {
          paragraphs: Array<{
            paragraphStyle?: string;
            runs: Array<{ text: string }>;
          }>;
        };
      };
    };
    const first = content.payload.content.paragraphs[0];
    expect(first.paragraphStyle).toBe("ParagraphStyle/$ID/Index Title");
    expect(first.runs.map((r) => r.text).join("")).toBe("Index");
    expect(h.root.querySelector("[data-generate-index-error]")).toBeNull();
  });

  test("disabled, it sends nothing", async () => {
    covers("panel:paged.index");
    const h = await mount();
    const from = h.mark();
    await h.click(generate(h.root));
    expect(h.mutations(from)).toEqual([]);
  });
});
