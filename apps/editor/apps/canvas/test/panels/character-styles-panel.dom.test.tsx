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

// Character Styles (paged.character-styles): the shared style-manager surface over the
// `appliedCharacterStyle` object-model field (support/style-apply-suite.ts),
// plus what is particular to this family.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { CharacterStylesPanel } from "../../src/panels/character-styles-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import { styleApplySuite } from "./support/style-apply-suite";
import { applyItem, appliedItem, applySelect } from "./support/styles";

afterEach(unmountAll);

styleApplySuite({
  panel: CharacterStylesPanel,
  id: "paged.character-styles",
  collection: "characterStyles",
  path: "appliedCharacterStyle",
  scope: "content",
  createOp: "createCharacterStyle",
  deleteOp: "deleteCharacterStyle",
  newName: "New character style",
  rootLabel: "[No character style]",
  styleOf: (s) => s.characterStyle,
  tag: () => covers("panel:paged.character-styles"),
  // A character style applies to a range ("world"); a caret has no
  // characters of its own (the caret case is below).
  range: [6, 11],
});

const mount = () =>
  mountPanel(CharacterStylesPanel, {
    id: "paged.character-styles",
    scene: richScene,
  });

describe("paged.character-styles: the model's runs", () => {
  test("a range inside the Bold run reads Bold applied", async () => {
    covers("panel:paged.character-styles");
    const h = await mount();
    await h.selectText(h.scene.storyId, 1, 4);
    expect(appliedItem(h)).toBe(h.scene.characterStyle);
    expect(applySelect(h).value).toBe(h.scene.characterStyle);
  });

  test("a range over Bold and plain text reads mixed: no row is marked", async () => {
    covers("panel:paged.character-styles");
    const h = await mount();
    await h.selectText(h.scene.storyId, 0, 11);
    expect(
      h.root
        .querySelector("[data-style-apply]")
        ?.getAttribute("data-binding-state"),
    ).toBe("mixed");
    expect(appliedItem(h)).toBeNull();
  });
});

describe("paged.character-styles: findings", () => {
  // InDesign keeps a style chosen at an insertion point for the text
  // typed there. Here the panel sends the write, the engine stores
  // nothing for an empty range, and the list shows nothing applied.
  test.failing(
    "PN-152: a style chosen at a caret is kept for the caret (the list marks it applied)",
    async () => {
      covers("panel:paged.character-styles");
      const h = await mount();
      await h.caret(h.scene.storyId, 8);
      await h.click(applyItem(h, h.scene.characterStyle));
      expect(appliedItem(h)).toBe(h.scene.characterStyle);
    },
  );

  // A mixed range shows the "[None]" option, which says no style is
  // applied, when two different ones are.
  test.failing(
    "PN-153: a mixed range does not show [None] as the applied style",
    async () => {
      covers("panel:paged.character-styles");
      const h = await mount();
      await h.selectText(h.scene.storyId, 0, 11);
      const select = applySelect(h);
      expect(select.options[select.selectedIndex]?.textContent).not.toBe(
        "[None]",
      );
    },
  );
});
