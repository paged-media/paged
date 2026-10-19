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

// Control (paged.control): the horizontal strip of the same sections the
// Properties panel routes (Object, Stroke for a selection; Character,
// Paragraph for text). The route and one write per section are asserted;
// the fields themselves are tested in their own panels' files.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ControlPanel } from "../../src/panels/control-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ControlPanel, { id: "paged.control", scene: richScene });

const sections = (h: H) =>
  [...h.root.querySelectorAll("[data-control-section]")].map((s) =>
    s.getAttribute("data-control-section"),
  );

describe("Control panel", () => {
  test("nothing selected: the hint and no sections", async () => {
    covers("panel:paged.control");
    const h = await mount();
    expect(h.root.querySelector("[data-control-empty]")?.textContent).toBe(
      "Select a frame or place a text caret.",
    );
    expect(sections(h)).toEqual([]);
  });

  test("no document: the hint", async () => {
    covers("panel:paged.control");
    const h = await mountPanel(ControlPanel, {
      id: "paged.control",
      document: "none",
    });
    expect(h.root.querySelector("[data-control-empty]")).not.toBeNull();
  });

  test("a frame: Object and Stroke", async () => {
    covers("panel:paged.control");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(sections(h)).toEqual(["object", "stroke"]);
    expect(h.root.querySelector("[data-control-empty]")).toBeNull();
  });

  test("a caret: Character and Paragraph", async () => {
    covers("panel:paged.control");
    const h = await mount();
    await h.caret(h.scene.storyId, 1);
    expect(sections(h)).toEqual(["character", "paragraph"]);
  });

  test("a caret in a selected frame: all four", async () => {
    covers("panel:paged.control");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    await h.caret(h.scene.storyId, 1);
    expect(sections(h)).toEqual(["object", "stroke", "character", "paragraph"]);
  });

  test("the Stroke section writes the selected frame", async () => {
    covers("panel:paged.control");
    const h = await mount();
    await h.select([h.scene.oval]);
    const from = h.mark();
    await h.typeInto("frameStrokeWeight", "2");
    const address = `oval:${h.scene.oval.id}`;
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address,
          path: "frameStrokeWeight",
          value: { type: "length", value: 2 },
        },
      },
    ] as never);
    expect(await h.get(address, "frameStrokeWeight")).toEqual({
      type: "length",
      value: 2,
    });
  });

  test("the Character section writes the selected text", async () => {
    covers("panel:paged.control");
    const h = await mount();
    await h.selectText(h.scene.storyId, 6, 11);
    const from = h.mark();
    await h.typeInto("characterFontSize", "9");
    const address = `storyRange:${h.scene.storyId}@6..11`;
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address,
          path: "characterFontSize",
          value: { type: "length", value: 9 },
        },
      },
    ] as never);
    expect(await h.get(address, "characterFontSize")).toEqual({
      type: "length",
      value: 9,
    });
  });
});
