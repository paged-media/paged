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

// Articles (paged.articles): the document's articles in reading order
// with their member counts. Read-only.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ArticlesPanel } from "../../src/panels/articles-panel";
import { mountPanel, unmountAll } from "./harness";
import { rows, structureIdml, STRUCTURE } from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(ArticlesPanel, { id: "paged.articles", document });

describe("Articles panel", () => {
  test("no document: the empty state", async () => {
    covers("panel:paged.articles");
    const h = await mount("none");
    expect(h.root.querySelector("[data-empty-articles]")?.textContent).toBe(
      "No articles in this document.",
    );
  });

  test("a document without articles: the empty state and the reading-order note", async () => {
    covers("panel:paged.articles");
    const h = await mount("blank");
    expect(h.root.querySelector("[data-empty-articles]")).not.toBeNull();
    expect(h.root.textContent).toContain(
      "Order drives accessible-PDF reading order.",
    );
  });

  test("lists each article with its position and member count", async () => {
    covers("panel:paged.articles");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary, r.secondary])).toEqual([
      [STRUCTURE.article, "Main article", "1 · 2 members"],
    ]);
    // Rows are read-only: there is nothing to press.
    expect(h.root.querySelectorAll("button")).toHaveLength(0);
  });
});
