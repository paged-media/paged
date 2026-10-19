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

// Bookmarks (paged.bookmarks): the document's bookmarks with their
// destinations. Read-only; it follows the model.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { BookmarksPanel } from "../../src/panels/bookmarks-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import { rows } from "./support/structure";

afterEach(unmountAll);

const mount = () =>
  mountPanel(BookmarksPanel, { id: "paged.bookmarks", scene: richScene });

describe("Bookmarks panel", () => {
  test("no document: the empty state", async () => {
    covers("panel:paged.bookmarks");
    const h = await mountPanel(BookmarksPanel, {
      id: "paged.bookmarks",
      document: "none",
    });
    expect(h.root.querySelector("[data-empty-bookmarks]")?.textContent).toBe(
      "No bookmarks in this document.",
    );
  });

  test("lists the bookmark by name", async () => {
    covers("panel:paged.bookmarks");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary])).toEqual([
      [h.scene.bookmark, "Start"],
    ]);
  });

  test("follows the model: a rename and a delete", async () => {
    covers("panel:paged.bookmarks");
    const h = await mount();
    await h.mutate({
      op: "renameBookmark",
      args: { bookmarkId: h.scene.bookmark, name: "Opening" },
    } as never);
    expect(rows(h.root).map((r) => r.primary)).toEqual(["Opening"]);
    await h.mutate({
      op: "deleteBookmark",
      args: { bookmarkId: h.scene.bookmark },
    } as never);
    expect(h.root.querySelector("[data-empty-bookmarks]")).not.toBeNull();
  });

  // The secondary line prints the destination object's id
  // ("→ HyperlinkPageDestination/u…"); the user needs the page.
  test.failing(
    "PN-104: a page bookmark's destination reads as its page",
    async () => {
      covers("panel:paged.bookmarks");
      const h = await mount();
      expect(rows(h.root)[0].secondary).toBe("→ Page 1");
    },
  );
});
