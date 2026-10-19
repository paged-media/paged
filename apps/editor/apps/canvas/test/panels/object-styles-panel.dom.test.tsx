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

// Object Styles (paged.object-styles): the shared style-manager surface over the
// `appliedObjectStyle` object-model field (support/style-apply-suite.ts),
// plus what is particular to this family.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ObjectStylesPanel } from "../../src/panels/object-styles-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import { styleApplySuite } from "./support/style-apply-suite";
import { applyItem, appliedItem } from "./support/styles";

afterEach(unmountAll);

styleApplySuite({
  panel: ObjectStylesPanel,
  id: "paged.object-styles",
  collection: "objectStyles",
  path: "appliedObjectStyle",
  scope: "element",
  createOp: "createObjectStyle",
  deleteOp: "deleteObjectStyle",
  newName: "New object style",
  rootLabel: "Box",
  styleOf: (s) => s.objectStyle,
  tag: () => covers("panel:paged.object-styles"),
});

describe("paged.object-styles: selections", () => {
  test("two frames: one batch applies the style to both, one undo takes it back", async () => {
    covers("panel:paged.object-styles");
    const h = await mountPanel(ObjectStylesPanel, {
      id: "paged.object-styles",
      scene: richScene,
    });
    await h.select([h.scene.rect, h.scene.oval]);
    const style = h.scene.objectStyle;
    const from = h.mark();
    await h.click(applyItem(h, style));
    const set = (address: string) => ({
      op: "set",
      args: {
        address,
        path: "appliedObjectStyle",
        value: { type: "text", value: style },
      },
    });
    const rect = `rectangle:${String(h.scene.rect.id)}`;
    const oval = `oval:${String(h.scene.oval.id)}`;
    expect(h.mutations(from)).toEqual([
      { op: "batch", args: { ops: [set(rect), set(oval)] } },
    ] as never);
    expect(appliedItem(h)).toBe(style);
    await h.act(() => h.client.undo());
    for (const a of [rect, oval]) {
      expect(await h.get(a, "appliedObjectStyle")).not.toEqual({
        type: "text",
        value: style,
      });
    }
  });

  test("frames with different styles read mixed: no row is marked", async () => {
    covers("panel:paged.object-styles");
    const h = await mountPanel(ObjectStylesPanel, {
      id: "paged.object-styles",
      scene: richScene,
    });
    await h.select([h.scene.rect]);
    await h.click(applyItem(h, h.scene.objectStyle));
    await h.select([h.scene.rect, h.scene.oval]);
    expect(
      h.root
        .querySelector("[data-style-apply]")
        ?.getAttribute("data-binding-state"),
    ).toBe("mixed");
    expect(appliedItem(h)).toBeNull();
  });
});
