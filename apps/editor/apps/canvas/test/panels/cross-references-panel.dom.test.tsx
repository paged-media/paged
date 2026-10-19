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

// Cross References (paged.cross-references): every cross-reference
// source with the format it uses. Read-only.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { CrossReferencesPanel } from "../../src/panels/cross-references-panel";
import { mountPanel, unmountAll } from "./harness";
import { rows, structureIdml, STRUCTURE } from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(CrossReferencesPanel, { id: "paged.cross-references", document });

describe("Cross References panel", () => {
  test("no document: the empty state", async () => {
    covers("panel:paged.cross-references");
    const h = await mount("none");
    expect(
      h.root.querySelector("[data-empty-cross-references]")?.textContent,
    ).toBe("No cross-references in this document.");
  });

  test("a document without cross-references: the empty state", async () => {
    covers("panel:paged.cross-references");
    const h = await mount("blank");
    expect(
      h.root.querySelector("[data-empty-cross-references]"),
    ).not.toBeNull();
  });

  test("lists each source by name", async () => {
    covers("panel:paged.cross-references");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary])).toEqual([
      [STRUCTURE.crossReference, "See the photo"],
    ]);
  });

  // The format column prints the format's id
  // ("CrossReferenceFormat/u1") where the format has a name.
  test.failing(
    "PN-105: a cross-reference's format reads as the format's name",
    async () => {
      covers("panel:paged.cross-references");
      const h = await mount();
      expect(rows(h.root)[0].secondary).toBe("Page Number");
    },
  );
});
