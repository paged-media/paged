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

// WP4.11 — File ▸ Automate ▸ Batch…: the dialog the command opens, over
// the real engine. Two generated documents are picked, an action runs
// over each, each result is delivered as a download named after its file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ActionsPanel } from "../../src/panels/actions-panel";
import {
  BATCH_COMMAND,
  BatchDialog,
  buildBatchCommands,
} from "../../src/panels/batch-dialog";
import { mountPanel, unmountAll } from "./harness";

beforeEach(() => localStorage.clear());
afterEach(unmountAll);

function Both() {
  return (
    <>
      <ActionsPanel />
      <BatchDialog />
    </>
  );
}

describe("Batch dialog [editor-shell.actions-batch]", () => {
  test("opens from its command, runs the action over two files and logs each result", async () => {
    covers("command:paged.actions.batch");
    covers("panel:paged.actions");
    const h = await mountPanel(Both, {
      id: "paged.actions",
      document: "blank",
      registries: (r) => {
        for (const c of buildBatchCommands()) r.commands.register(c);
        r.commands.register({
          id: "test.stamp",
          title: "Stamp",
          handler: async () => {
            await h.client.mutate({
              op: "createSwatch",
              args: {
                spec: {
                  name: "Stamp",
                  space: "CMYK",
                  value: [0, 0, 0, 20],
                  model: "Process",
                },
              },
            } as never);
          },
        });
      },
    });
    // Record a one-step action.
    await h.click(
      h.root.querySelector('[data-cockpit-action="actions-record"]')!,
    );
    await h.act(() => h.registries.commands.invoke("test.stamp"));
    await h.click(
      h.root.querySelector('[data-cockpit-action="actions-stop"]')!,
    );
    // Two generated documents.
    const files: File[] = [];
    for (const name of ["One", "Two"]) {
      await h.act(() => h.client.newBlankDocument(612, 792));
      files.push(
        new File([(await h.client.exportIdml()).slice()], `${name}.idml`),
      );
    }
    h.client.markSaved();
    const downloads: string[] = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    try {
      await h.act(() => h.registries.commands.invoke(BATCH_COMMAND));
      const dialog = document.querySelector<HTMLElement>(
        "[data-batch-dialog]",
      )!;
      expect(dialog).not.toBeNull();
      expect(
        dialog.querySelector<HTMLSelectElement>("[data-batch-action]")!.value,
      ).not.toBe("");
      await h.user.upload(
        dialog.querySelector<HTMLInputElement>("[data-batch-files]")!,
        files,
      );
      await h.settle();
      expect(dialog.querySelector("[data-batch-file-count]")?.textContent).toBe(
        "2 files",
      );
      await h.user.selectOptions(
        dialog.querySelector<HTMLSelectElement>("[data-batch-format]")!,
        "idml",
      );
      await h.click(dialog.querySelector("[data-batch-run]")!);
      for (
        let i = 0;
        i < 40 && !dialog.querySelector("[data-batch-summary]");
        i++
      )
        await h.settle();
      expect(dialog.querySelector("[data-batch-summary]")?.textContent).toBe(
        "2 saved, 0 failed",
      );
      expect(
        [...dialog.querySelectorAll("[data-batch-log-entry]")].map((e) =>
          e.getAttribute("data-batch-log-entry"),
        ),
      ).toEqual(["ok", "ok"]);
      expect(downloads).toEqual(["One.idml", "Two.idml"]);
      // The last result is the open document, with the action applied.
      const names = (
        await h.client.collection<{ name: string | null }>("swatches")
      ).map((s) => s.name);
      expect(names).toContain("Stamp");
      await h.click(dialog.querySelector("[data-batch-close]")!);
      expect(document.querySelector("[data-batch-dialog]")).toBeNull();
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
  });
});
