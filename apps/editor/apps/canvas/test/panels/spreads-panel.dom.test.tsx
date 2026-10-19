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

// Spreads (paged.spreads): one row per spread with its page count; an
// unnamed spread is "Spread n", never its id or folio. Read-only.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { SpreadsPanel } from "../../src/panels/spreads-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import { rows } from "./support/structure";

afterEach(unmountAll);

describe("Spreads panel", () => {
  test("no document: the empty state", async () => {
    covers("panel:paged.spreads");
    const h = await mountPanel(SpreadsPanel, {
      id: "paged.spreads",
      document: "none",
    });
    expect(h.root.querySelector("[data-empty-spreads]")?.textContent).toBe(
      "No spreads.",
    );
  });

  test("an unnamed spread whose label is its folio reads as Spread n", async () => {
    covers("panel:paged.spreads");
    const h = await mountPanel(SpreadsPanel, {
      id: "paged.spreads",
      scene: richScene,
    });
    expect(rows(h.root)[0]).toMatchObject({
      primary: "Spread 1",
      secondary: "1 page",
    });
    expect(rows(h.root)).toHaveLength(2);
  });

  test("follows the model: a page inserted makes a spread", async () => {
    covers("panel:paged.spreads");
    const h = await mountPanel(SpreadsPanel, {
      id: "paged.spreads",
      document: "blank",
    });
    expect(rows(h.root)).toHaveLength(1);
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(rows(h.root)).toHaveLength(2);
  });

  // The panel's rule is that a folio is not a name ("Spread n" instead);
  // a folio with a section prefix slips through it, so the second spread
  // of the rich scene (section "B-") reads "B-1" beside "Spread 1".
  test.failing(
    "PN-107: a spread whose folio has a section prefix also reads as Spread n",
    async () => {
      covers("panel:paged.spreads");
      const h = await mountPanel(SpreadsPanel, {
        id: "paged.spreads",
        scene: richScene,
      });
      expect(rows(h.root).map((r) => r.primary)).toEqual([
        "Spread 1",
        "Spread 2",
      ]);
    },
  );
});
