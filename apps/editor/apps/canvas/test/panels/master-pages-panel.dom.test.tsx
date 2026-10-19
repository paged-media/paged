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

// Master Pages (paged.master-pages): the master spreads with their page
// counts; New / Apply / Rename open the typed core command form
// (CoreCommandDialog, mounted beside the panel as the app mounts it),
// Delete runs core.deleteMaster directly.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { CoreCommandDialog } from "../../src/core-command-dialog";
import { MasterPagesPanel } from "../../src/panels/master-pages-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { rows } from "./support/structure";

afterEach(unmountAll);

/** The panel with the app's command form beside it (main.tsx mounts the
 *  form once at the app root). */
function MasterPagesWithForm() {
  return (
    <>
      <MasterPagesPanel />
      <CoreCommandDialog />
    </>
  );
}

const mount = (document: "none" | "blank" = "blank") =>
  mountPanel(MasterPagesWithForm, { id: "paged.master-pages", document });

const action = (root: Element, name: string, index = 0) =>
  root.querySelectorAll<HTMLButtonElement>(`[data-cockpit-action="${name}"]`)[
    index
  ]!;
const formArg = (name: string) =>
  document.querySelector<HTMLInputElement>(`[data-core-command-arg="${name}"]`);
const run = (h: PanelHarness<unknown>) =>
  h.click(document.querySelector("[data-core-command-run]")!);

describe("Master Pages panel: states", () => {
  test("no document: the empty state and New master", async () => {
    covers("panel:paged.master-pages");
    const h = await mount("none");
    expect(h.root.querySelector("[data-empty-master-pages]")?.textContent).toBe(
      "No master pages.",
    );
    expect(action(h.root, "master-new").textContent).toBe("New master…");
  });

  test("a document: each master with its page count and its three actions", async () => {
    covers("panel:paged.master-pages");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary, r.secondary])).toEqual([
      ["um", "A", "1 page"],
    ]);
    expect(
      [...h.root.querySelectorAll('[data-master-row="um"] button')].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Apply…", "Rename…", "Delete"]);
  });
});

describe("Master Pages panel: controls", () => {
  test("New master opens the form at the page size; Run creates it and the list follows", async () => {
    covers("panel:paged.master-pages");
    const h = await mount();
    await h.click(action(h.root, "master-new"));
    expect(
      document
        .querySelector("[data-core-command-dialog]")
        ?.getAttribute("data-core-command-dialog"),
    ).toBe("createMaster");
    expect(formArg("name")?.value).toBe("B-Master");
    expect(formArg("widthPt")?.value).toBe("612");
    expect(formArg("heightPt")?.value).toBe("792");
    const master = formArg("master")!.value;
    expect(master).toMatch(/^u[0-9a-z]+$/);
    const from = h.mark();
    await run(h);
    expect(h.mutations(from)).toEqual([
      {
        op: "createMaster",
        args: { master, name: "B-Master", widthPt: 612, heightPt: 792 },
      },
    ] as never);
    expect(document.querySelector("[data-core-command-dialog]")).toBeNull();
    expect(rows(h.root).map((r) => r.primary)).toEqual(["A", "B-Master"]);
  });

  test("Rename opens the form with the current name; Run renames it", async () => {
    covers("panel:paged.master-pages");
    const h = await mount();
    await h.click(action(h.root, "master-rename"));
    expect(formArg("master")?.value).toBe("master:um");
    expect(formArg("name")?.value).toBe("A");
    await h.user.clear(formArg("name")!);
    await h.user.type(formArg("name")!, "Body");
    const from = h.mark();
    await run(h);
    expect(h.mutations(from)).toEqual([
      { op: "renameMaster", args: { master: "um", name: "Body" } },
    ] as never);
    const model = (await h.client.collection("masterPages")) as Array<{
      label: string;
    }>;
    expect(model.map((m) => m.label)).toEqual(["Body"]);
    expect(rows(h.root)[0].primary).toBe("Body");
  });

  test("Apply asks for the page; with one given it applies the master to it", async () => {
    covers("panel:paged.master-pages");
    const h = await mount();
    await h.click(action(h.root, "master-new"));
    await run(h);
    // Apply the NEW master (row 2) to the first page.
    await h.click(action(h.root, "master-apply", 1));
    expect(formArg("page")?.value).toBe("");
    let from = h.mark();
    await run(h);
    expect(h.mutations(from)).toEqual([]);
    expect(
      document.querySelector("[data-core-command-error]")?.textContent,
    ).toBe("page is required");
    await h.user.type(formArg("page")!, `page:${h.handle!.pageIds[0]}`);
    from = h.mark();
    await run(h);
    const created = rows(h.root)[1].key;
    expect(h.mutations(from)).toEqual([
      {
        op: "applyMasterToPage",
        args: { page: h.handle!.pageIds[0], master: created },
      },
    ] as never);
  });

  test("Delete removes a master directly (one invoke, no form) and one undo restores it", async () => {
    covers("panel:paged.master-pages");
    const h = await mount();
    await h.click(action(h.root, "master-new"));
    await run(h);
    const created = rows(h.root)[1].key;
    const from = h.mark();
    await h.click(action(h.root, "master-delete", 1));
    expect(document.querySelector("[data-core-command-dialog]")).toBeNull();
    expect(h.mutations(from)).toEqual([
      { op: "deleteMaster", args: { master: created } },
    ] as never);
    expect(rows(h.root).map((r) => r.primary)).toEqual(["A"]);
    await h.act(() => h.client.undo());
    expect(rows(h.root).map((r) => r.primary)).toEqual(["A", "B-Master"]);
  });

  test("Cancel closes the form and sends nothing", async () => {
    covers("panel:paged.master-pages");
    const h = await mount();
    await h.click(action(h.root, "master-new"));
    const from = h.mark();
    await h.click(document.querySelector("[data-core-command-cancel]")!);
    expect(document.querySelector("[data-core-command-dialog]")).toBeNull();
    expect(h.mutations(from)).toEqual([]);
  });
});
