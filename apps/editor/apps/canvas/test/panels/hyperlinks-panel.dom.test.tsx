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

// Hyperlinks (paged.hyperlinks): the document's hyperlinks with their
// destinations. Read-only; it follows the model as links are added.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { HyperlinksPanel } from "../../src/panels/hyperlinks-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import { rows } from "./support/structure";

afterEach(unmountAll);

describe("Hyperlinks panel", () => {
  test("no document: the empty state", async () => {
    covers("panel:paged.hyperlinks");
    const h = await mountPanel(HyperlinksPanel, {
      id: "paged.hyperlinks",
      document: "none",
    });
    expect(h.root.querySelector("[data-empty-hyperlinks]")?.textContent).toBe(
      "No hyperlinks in this document.",
    );
  });

  test("a document with a hyperlink lists it", async () => {
    covers("panel:paged.hyperlinks");
    const h = await mountPanel(HyperlinksPanel, {
      id: "paged.hyperlinks",
      scene: richScene,
    });
    const list = rows(h.root);
    expect(list.map((r) => r.key)).toEqual([h.scene.hyperlink]);
    expect(list[0].secondary?.startsWith("→ ")).toBe(true);
  });

  test("follows the model: a hyperlink added on the text is listed", async () => {
    covers("panel:paged.hyperlinks");
    const h = await mountPanel(HyperlinksPanel, {
      id: "paged.hyperlinks",
      scene: richScene,
    });
    await h.mutate({
      op: "insertHyperlink",
      args: {
        storyId: h.scene.storyId,
        start: 6,
        end: 11,
        url: "https://example.org/second",
      },
    } as never);
    expect(rows(h.root)).toHaveLength(2);
  });

  // HyperlinkSummary carries destinationUrl; the panel prints
  // `destination`, the destination OBJECT's id
  // ("HyperlinkURLDestination/u…").
  test.failing(
    "PN-102: a URL hyperlink's destination reads as its URL",
    async () => {
      covers("panel:paged.hyperlinks");
      const h = await mountPanel(HyperlinksPanel, {
        id: "paged.hyperlinks",
        scene: richScene,
      });
      expect(rows(h.root)[0].secondary).toBe("→ https://example.com");
    },
  );

  // A hyperlink made in the editor is named by its id ("Hyperlink/u…");
  // InDesign names it after the link ("Hyperlink 1" or the URL).
  test.failing(
    "PN-103: a hyperlink made in the editor is listed by a name, not its id",
    async () => {
      covers("panel:paged.hyperlinks");
      const h = await mountPanel(HyperlinksPanel, {
        id: "paged.hyperlinks",
        scene: richScene,
      });
      expect(rows(h.root)[0].primary).not.toContain("Hyperlink/");
    },
  );
});
