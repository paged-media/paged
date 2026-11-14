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

// Extensions ADR 1111 — what the open document's pages are called: the noun
// the document context declares (a deck's pages are slides), else the
// editor's own words, exactly as before.

import { describe, expect, test } from "bun:test";

import type { PageId, SpreadSummary } from "@paged-media/client";

import { groupSpreads } from "../../src/cockpit/spread-grouping";
import { createDocumentContextStore } from "../../src/registries/context-bar";
import { createEditContextRegistry } from "../../src/registries/edit-context";
import { capitalise, declaredPageNoun } from "../../src/state/page-noun";

const SLIDES = { one: "slide", other: "slides" };
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `p${i + 1}`) as unknown as PageId[];
const spread = (selfId: string, pageCount: number) =>
  ({ selfId, pageCount, label: null }) as unknown as SpreadSummary;

describe("the page noun", () => {
  test("the document context's declaration names the pages; none, or a blank one, keeps pages", () => {
    const documentContext = createDocumentContextStore();
    const editContexts = createEditContextRegistry();
    editContexts.register({
      type: "deck",
      entry: "doubleClick",
      matches: () => false,
      pageNoun: SLIDES,
    });
    editContexts.register({
      type: "blank",
      entry: "doubleClick",
      matches: () => false,
      pageNoun: { one: " ", other: "slides" },
    });
    editContexts.register({ type: "word", entry: "doubleClick" });
    expect(declaredPageNoun(documentContext, editContexts)).toBeNull();
    documentContext.set("deck.plugin", "deck");
    expect(declaredPageNoun(documentContext, editContexts)).toBe(
      editContexts.get("deck")!.pageNoun!,
    );
    documentContext.set("deck.plugin", "blank");
    expect(declaredPageNoun(documentContext, editContexts)).toBeNull();
    documentContext.set("word.plugin", "word");
    expect(declaredPageNoun(documentContext, editContexts)).toBeNull();
    documentContext.clear();
    expect(declaredPageNoun(documentContext, editContexts)).toBeNull();
  });

  test("a label starts with a capital, in any script that has one", () => {
    expect(capitalise("slide")).toBe("Slide");
    expect(capitalise("Folie")).toBe("Folie");
    expect(capitalise("ėlement")).toBe("Ėlement");
    expect(capitalise("")).toBe("");
  });

  test("the document map's rows: Slide 1 (no cover), Slides 2–3; without a noun Cover and Page as before", () => {
    const spreads = [spread("s1", 1), spread("s2", 2)];
    expect(groupSpreads(ids(3), spreads, SLIDES).map((e) => e.name)).toEqual([
      "Slide 1",
      "Slides 2–3",
    ]);
    expect(groupSpreads(ids(2), null, SLIDES).map((e) => e.name)).toEqual([
      "Slide 1",
      "Slide 2",
    ]);
    expect(groupSpreads(ids(3), spreads).map((e) => e.name)).toEqual([
      "Cover",
      "Pages 2–3",
    ]);
    expect(groupSpreads(ids(2), null).map((e) => e.name)).toEqual([
      "Cover",
      "Page 2",
    ]);
  });
});
