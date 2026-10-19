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

// Journal (paged.journal): the editor's local flight recorder, the shell
// journal buffer from @paged-media/client. The tests record through the
// buffer as the editor's emitters do, and read the panel against it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { journal } from "@paged-media/client";

import { JournalPanel } from "../../src/panels/journal-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

beforeEach(() => {
  journal.take();
});
afterEach(unmountAll);

const mount = () =>
  mountPanel(JournalPanel, { id: "paged.journal", document: "none" });

const shown = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll("[data-journal-entry]")].map((e) => ({
    code: e.getAttribute("data-journal-code"),
    severity: e.getAttribute("data-journal-severity"),
  }));

const summary = (h: PanelHarness<unknown>) =>
  h.root.querySelector("[data-journal-summary]")?.textContent;

async function record(h: PanelHarness<unknown>) {
  await h.act(() => {
    journal.take();
    journal.record({ code: "plugin.log", severity: "info" });
    journal.record({ code: "worker.dispatch.error", severity: "error" });
    journal.record({ code: "client.pending.stalled", severity: "warn" });
  });
}

describe("Journal panel", () => {
  test("an empty journal: zero counts and the empty line", async () => {
    covers("panel:paged.journal");
    const h = await mount();
    await h.act(() => journal.take());
    expect(summary(h)).toBe("0 entries · 0 errors · 0 warnings");
    expect(h.root.querySelector("[data-journal-empty]")?.textContent).toBe(
      "Nothing recorded at this severity yet.",
    );
  });

  test("recorded entries: counted, newest first, each with its code and severity", async () => {
    covers("panel:paged.journal");
    const h = await mount();
    await record(h);
    expect(summary(h)).toBe("3 entries · 1 error · 1 warning");
    expect(shown(h)).toEqual([
      { code: "client.pending.stalled", severity: "warn" },
      { code: "worker.dispatch.error", severity: "error" },
      { code: "plugin.log", severity: "info" },
    ]);
  });

  test("the severity filter narrows the list, and all restores it", async () => {
    covers("panel:paged.journal");
    const h = await mount();
    await record(h);
    const filter = h.view.getByRole("combobox", { name: "Minimum severity" });
    await h.choose(filter as HTMLElement, "error");
    expect(shown(h).map((e) => e.severity)).toEqual(["error"]);
    await h.choose(filter as HTMLElement, "warn");
    expect(shown(h).map((e) => e.severity)).toEqual(["warn", "error"]);
    await h.choose(filter as HTMLElement, "all");
    expect(shown(h)).toHaveLength(3);
    // The counts are the journal's, whatever the filter shows.
    expect(summary(h)).toBe("3 entries · 1 error · 1 warning");
  });

  test("an entry recorded while the panel is open shows at once", async () => {
    covers("panel:paged.journal");
    const h = await mount();
    await record(h);
    await h.act(() =>
      journal.record({ code: "shell.panel.crash", severity: "error" }),
    );
    expect(shown(h)[0]).toEqual({
      code: "shell.panel.crash",
      severity: "error",
    });
  });

  test("Export… opens the dialog with a preview of what would leave; Cancel closes it", async () => {
    covers("panel:paged.journal");
    const h = await mount();
    await record(h);
    await h.click(h.root.querySelector("[data-journal-export]")!);
    const dialog = h.root.querySelector("[data-journal-export-dialog]");
    expect(dialog).not.toBeNull();
    const preview =
      h.root.querySelector("[data-journal-preview]")?.textContent ?? "";
    expect(preview).toContain("worker.dispatch.error");
    await h.click(h.root.querySelector("[data-journal-export-cancel]")!);
    expect(h.root.querySelector("[data-journal-export-dialog]")).toBeNull();
  });

  test("what would leave holds no document text: a path in an entry's data is dropped and counted", async () => {
    covers("panel:paged.journal");
    const h = await mount();
    await h.act(() => {
      journal.take();
      journal.record({
        code: "plugin.log",
        severity: "info",
        data: { file: "/home/someone/brochure.idml" },
      });
    });
    await h.click(h.root.querySelector("[data-journal-export]")!);
    const preview =
      h.root.querySelector("[data-journal-preview]")?.textContent ?? "";
    expect(preview).toContain("plugin.log");
    expect(preview).not.toContain("brochure");
    expect(preview).not.toContain("/home/");
    expect(journal.getLedger().rejectedData).toBeGreaterThan(0);
  });
});
