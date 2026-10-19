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

// Info (paged.info): the document-meta readout. Read-only, so its tests
// are the states and the model it follows; it has no controls.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { InfoPanel } from "../../src/panels/info-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = (document?: "none" | "blank") =>
  mountPanel(InfoPanel, { id: "paged.info", document });

/** Row label → the value it shows. */
function rows(h: PanelHarness<unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of h.root.querySelectorAll("[data-info-row]")) {
    out[row.getAttribute("data-info-row")!] =
      row.querySelector("[data-info-value]")?.textContent ?? "";
  }
  return out;
}

describe("Info panel", () => {
  test("no document: zero pages and dashes, never a stale document", async () => {
    covers("panel:paged.info");
    const h = await mount("none");
    expect(rows(h)).toEqual({
      Document: "—",
      Pages: "0",
      "Active page": "—",
      Units: "—",
      "Color mode": "—",
      Dirty: "no",
    });
  });

  test("a blank document: one page, clean", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    expect(rows(h)).toMatchObject({ Pages: "1", Dirty: "no" });
    expect(h.sent("requestDocumentMeta").length).toBeGreaterThan(0);
  });

  test("follows the model: a page inserted reads two pages", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(rows(h).Pages).toBe("2");
  });

  test("the active page reads as its position, not its IDML id", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    const first = h.handle!.pageIds[0];
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: first, masterId: null },
    } as never);
    const pages = (await h.client.collection("pages")) as Array<{
      selfId: string;
    }>;
    await h.act(() => h.client.setActivePage(pages[1].selfId));
    // The active page is host state: nothing re-reads it until the next
    // model change, which is what the Pages panel's navigation sends.
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: first, masterId: null },
    } as never);
    expect(rows(h)["Active page"]).toBe("Page 3");
  });

  test("an edit reads dirty; a save reads clean until the next edit", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(rows(h).Dirty).toBe("yes");
    await h.act(() => h.client.markSaved());
    expect(rows(h).Dirty).toBe("no");
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(rows(h).Dirty).toBe("yes");
  });
});
