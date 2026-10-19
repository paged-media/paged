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

// Paragraph Styles (paged.paragraph-styles): the shared style-manager surface over the
// `appliedParagraphStyle` object-model field (support/style-apply-suite.ts),
// plus what is particular to this family.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ParagraphStylesPanel } from "../../src/panels/paragraph-styles-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import { styleApplySuite } from "./support/style-apply-suite";
import { applyAction, applyItem, appliedItem } from "./support/styles";

afterEach(unmountAll);

styleApplySuite({
  panel: ParagraphStylesPanel,
  id: "paged.paragraph-styles",
  collection: "paragraphStyles",
  path: "appliedParagraphStyle",
  scope: "content",
  createOp: "createParagraphStyle",
  deleteOp: "deleteParagraphStyle",
  newName: "New paragraph style",
  rootLabel: "[No paragraph style]",
  styleOf: (s) => s.paragraphStyle,
  tag: () => covers("panel:paged.paragraph-styles"),
});

const mount = () =>
  mountPanel(ParagraphStylesPanel, {
    id: "paged.paragraph-styles",
    scene: richScene,
  });

/** The style at an offset of the scene's story. */
const at = (storyId: string, offset: number) =>
  `storyRange:${storyId}@${offset}..${offset}`;

describe("paged.paragraph-styles: paragraphs", () => {
  test("a caret applies the style to its whole paragraph", async () => {
    covers("panel:paged.paragraph-styles");
    const h = await mount();
    await h.caret(h.scene.storyId, 3);
    await h.click(applyItem(h, h.scene.paragraphStyle));
    expect(
      await h.get(at(h.scene.storyId, 9), "appliedParagraphStyle"),
    ).toEqual({ type: "text", value: h.scene.paragraphStyle });
  });

  test("a range over two paragraphs applies the style to both, and only to them", async () => {
    covers("panel:paged.paragraph-styles");
    const h = await mount();
    // The scene's story has two paragraphs ("Hello world", "Second
    // paragraph", from 12); a third one goes after them.
    const [story] = (await h.client.collection("stories")) as Array<{
      characterCount: number;
    }>;
    await h.mutate({
      op: "insertText",
      args: {
        storyId: h.scene.storyId,
        offset: story.characterCount,
        text: "\nThird one",
      },
    } as never);
    const third = story.characterCount + 3;
    await h.selectText(h.scene.storyId, 2, 14);
    const from = h.mark();
    await h.click(applyItem(h, h.scene.paragraphStyle));
    expect(h.mutations(from)).toHaveLength(1);
    for (const offset of [2, 14]) {
      expect(
        await h.get(at(h.scene.storyId, offset), "appliedParagraphStyle"),
      ).toEqual({ type: "text", value: h.scene.paragraphStyle });
    }
    expect(
      await h.get(at(h.scene.storyId, third), "appliedParagraphStyle"),
    ).not.toEqual({ type: "text", value: h.scene.paragraphStyle });
  });
});

describe("paged.paragraph-styles: findings", () => {
  // Delete removes the style and leaves the text pointing at its id;
  // the engine then mints that id again for the next style.
  test.failing(
    "PN-150: deleting the applied style puts its text back on the root style",
    async () => {
      covers("panel:paged.paragraph-styles");
      const h = await mount();
      await h.caret(h.scene.storyId, 3);
      await h.click(applyItem(h, h.scene.paragraphStyle));
      await h.click(applyAction(h, "delete"));
      expect(
        await h.get(at(h.scene.storyId, 3), "appliedParagraphStyle"),
      ).toEqual({
        type: "text",
        value: "ParagraphStyle/$ID/[No paragraph style]",
      });
    },
  );

  test.failing(
    "PN-151: a style made after a delete is not applied to text that never received it",
    async () => {
      covers("panel:paged.paragraph-styles");
      const h = await mount();
      await h.caret(h.scene.storyId, 3);
      await h.click(applyItem(h, h.scene.paragraphStyle));
      await h.click(applyAction(h, "delete"));
      await h.click(applyAction(h, "new"));
      // The new style took the deleted one's id, so the list now says the
      // caret's paragraph carries "New paragraph style".
      expect(appliedItem(h)).toBeNull();
    },
  );
});
