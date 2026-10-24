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

// Actions (paged.actions): record a sequence of commands, keep it, play it
// back. The recorder is the shell's ActionsProvider (it taps the command
// registry); the tests run commands through that registry, as the menus,
// the palette and the panels do.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { notifyImported } from "@paged-media/shell";

import { ActionsPanel } from "../../src/panels/actions-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

beforeEach(() => {
  // The library persists to localStorage; each test starts empty.
  localStorage.clear();
});
afterEach(unmountAll);

type H = PanelHarness<unknown>;

/** The panel with two plain commands registered, and their calls. */
async function mount() {
  const calls: Array<{ id: string; payload: unknown }> = [];
  const h = await mountPanel(ActionsPanel, {
    id: "paged.actions",
    document: "blank",
    registries: (r) => {
      for (const id of ["test.nudge", "test.tint"]) {
        r.commands.register({
          id,
          title: id === "test.nudge" ? "Nudge" : "Tint",
          handler: (_p: unknown, payload?: unknown) => {
            calls.push({ id, payload });
          },
        });
      }
    },
  });
  return { h, calls };
}

const action = (h: H, name: string) =>
  h.root.querySelector<HTMLElement>(`[data-cockpit-action="${name}"]`)!;
const rows = (h: H) =>
  [...h.root.querySelectorAll("[data-actions-row]")].map(
    (r) => r.querySelector("[data-actions-open]")?.textContent,
  );

async function recordTwo(h: H, name: string) {
  await h.click(action(h, "actions-record"));
  await h.act(async () => {
    await h.registries.commands.invoke("test.nudge", { dx: 10 });
    await h.registries.commands.invoke("test.tint", { tint: 50 });
  });
  await h.user.type(
    h.root.querySelector<HTMLInputElement>("[data-actions-name]")!,
    name,
  );
  await h.click(action(h, "actions-stop"));
}

describe("Actions panel", () => {
  test("nothing recorded: the hint, Record offered, Export all disabled", async () => {
    covers("panel:paged.actions");
    const { h } = await mount();
    expect(h.root.textContent).toContain("0 saved");
    expect(h.root.textContent).toContain("No actions yet.");
    expect(action(h, "actions-record")).not.toBeNull();
    expect(
      (h.view.getByRole("button", { name: "Export all" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("Record captures each command run through the registry, Stop keeps it under its name", async () => {
    covers("panel:paged.actions");
    const { h } = await mount();
    await h.click(action(h, "actions-record"));
    expect(
      h.root.querySelector('[data-status-pill="actions-recording"]'),
    ).not.toBeNull();
    await h.act(() => h.registries.commands.invoke("test.nudge", { dx: 10 }));
    expect(h.root.querySelector("[data-actions-step-count]")?.textContent).toBe(
      "1",
    );
    await h.act(() => h.registries.commands.invoke("test.tint", { tint: 50 }));
    expect(h.root.querySelector("[data-actions-step-count]")?.textContent).toBe(
      "2",
    );
    await h.user.type(
      h.root.querySelector<HTMLInputElement>("[data-actions-name]")!,
      "Nudge and tint",
    );
    await h.click(action(h, "actions-stop"));
    expect(rows(h)).toEqual(["Nudge and tint"]);
    expect(h.root.textContent).toContain("1 saved");
  });

  test("Stop with nothing run keeps nothing and says why", async () => {
    covers("panel:paged.actions");
    const { h } = await mount();
    await h.click(action(h, "actions-record"));
    await h.click(action(h, "actions-stop"));
    expect(rows(h)).toEqual([]);
    expect(
      h.root.querySelector("[data-actions-notice]")?.textContent,
    ).toContain("Nothing recorded");
  });

  test("Discard ends the recording without keeping it", async () => {
    covers("panel:paged.actions");
    const { h } = await mount();
    await h.click(action(h, "actions-record"));
    await h.act(() => h.registries.commands.invoke("test.nudge", { dx: 1 }));
    await h.click(h.view.getByRole("button", { name: "Discard" }));
    expect(rows(h)).toEqual([]);
    expect(h.root.querySelector("[data-actions-recording]")).toBeNull();
  });

  test("Play runs the recorded commands again, in order, with their payloads", async () => {
    covers("panel:paged.actions");
    const { h, calls } = await mount();
    await recordTwo(h, "Twice");
    calls.length = 0;
    const id = h.root
      .querySelector("[data-actions-row]")!
      .getAttribute("data-actions-row")!;
    await h.click(action(h, `actions-play-${id}`));
    expect(calls).toEqual([
      { id: "test.nudge", payload: { dx: 10 } },
      { id: "test.tint", payload: { tint: 50 } },
    ]);
  });

  test("a disabled step is skipped on replay, a deleted one is gone", async () => {
    covers("panel:paged.actions");
    const { h, calls } = await mount();
    await recordTwo(h, "Edit me");
    const id = h.root
      .querySelector("[data-actions-row]")!
      .getAttribute("data-actions-row")!;
    // Stop opens the new action's detail.
    expect(
      h.root.querySelector(`[data-actions-detail="${id}"]`),
    ).not.toBeNull();
    await h.click(h.view.getByRole("checkbox", { name: "Step 1 enabled" }));
    calls.length = 0;
    await h.click(action(h, `actions-play-${id}`));
    expect(calls.map((c) => c.id)).toEqual(["test.tint"]);
    await h.click(h.view.getByRole("button", { name: "Delete step 2" }));
    expect(
      h.root.querySelector(`[data-actions-row="${id}"]`)?.textContent,
    ).toContain("0/1");
  });

  test("rename and delete from the detail", async () => {
    covers("panel:paged.actions");
    const { h } = await mount();
    await recordTwo(h, "Old");
    const rename = h.root.querySelector<HTMLInputElement>(
      "[data-actions-rename]",
    )!;
    await h.user.clear(rename);
    await h.user.type(rename, "New name");
    await h.settle();
    expect(rows(h)).toEqual(["New name"]);
    await h.click(action(h, "actions-delete"));
    expect(rows(h)).toEqual([]);
    expect(h.root.textContent).toContain("0 saved");
  });

  test("the library survives a remount (it is kept in the browser)", async () => {
    covers("panel:paged.actions");
    const first = await mount();
    await recordTwo(first.h, "Kept");
    first.h.unmount();
    const { h } = await mount();
    expect(rows(h)).toEqual(["Kept"]);
  });

  test("Import reads an exported library", async () => {
    covers("panel:paged.actions");
    const source = await mount();
    await recordTwo(source.h, "Exported");
    const text = localStorage.getItem(
      Object.keys(localStorage).find((k) => k.includes("action")) ?? "",
    );
    expect(text).not.toBeNull();
    source.h.unmount();
    localStorage.clear();
    const { h } = await mount();
    const input = h.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    await h.user.upload(
      input,
      new File([text!], "paged-actions.json", { type: "application/json" }),
    );
    await h.settle();
    expect(h.root.querySelector("[data-actions-notice]")?.textContent).toBe(
      "Imported 1 action.",
    );
    expect(rows(h)).toEqual(["Exported"]);
  });

  // ── WP4.11 ─────────────────────────────────────────────────────
  const idOf = (h: H) =>
    h.root
      .querySelector("[data-actions-row]")!
      .getAttribute("data-actions-row")!;
  const swatchCount = async (h: H) =>
    (await h.client.collection("swatches")).length;

  /** A command that writes the document twice. */
  function writer(h: H) {
    h.registries.commands.register({
      id: "test.write",
      title: "Write",
      handler: async () => {
        for (const v of [10, 20]) {
          await h.client.mutate({
            op: "createSwatch",
            args: {
              spec: {
                name: `W${v}`,
                space: "CMYK",
                value: [v, 0, 0, 0],
                model: "Process",
              },
            },
          } as never);
        }
      },
    });
  }

  test("a replay is ONE undo step: the report says so and one Undo takes it all back [editor-shell.actions-batch]", async () => {
    covers("panel:paged.actions");
    const { h } = await mount();
    writer(h);
    await h.click(action(h, "actions-record"));
    await h.act(async () => {
      await h.registries.commands.invoke("test.write");
      await h.registries.commands.invoke("test.write");
    });
    await h.click(action(h, "actions-stop"));
    const before = await swatchCount(h);
    await h.click(action(h, `actions-play-${idOf(h)}`));
    await h.settle();
    expect(await swatchCount(h)).toBe(before + 4);
    expect(h.root.querySelector("[data-actions-undo]")?.textContent).toContain(
      "applied as one undo step",
    );
    await h.act(() => h.client.undo());
    expect(await swatchCount(h)).toBe(before);
  });

  test("a breakpoint pauses before its step; Continue finishes [editor-shell.actions-batch]", async () => {
    covers("panel:paged.actions");
    const { h, calls } = await mount();
    await recordTwo(h, "Paused");
    await h.click(h.view.getByRole("button", { name: "Pause before step 2" }));
    calls.length = 0;
    await h.click(action(h, `actions-play-${idOf(h)}`));
    expect(calls.map((c) => c.id)).toEqual(["test.nudge"]);
    expect(
      h.root
        .querySelector("[data-actions-playback]")
        ?.getAttribute("data-actions-playback"),
    ).toBe("paused");
    expect(
      h.root.querySelector("[data-actions-playback-message]")?.textContent,
    ).toBe("Paused before step 2.");
    await h.click(action(h, "actions-continue"));
    expect(calls.map((c) => c.id)).toEqual(["test.nudge", "test.tint"]);
    expect(h.root.querySelector("[data-actions-playback]")).toBeNull();
    expect(h.root.querySelector("[data-actions-report]")).not.toBeNull();
  });

  test("an inserted stop halts with its message; Cancel ends the replay there [editor-shell.actions-batch]", async () => {
    covers("panel:paged.actions");
    const { h, calls } = await mount();
    await recordTwo(h, "Stops");
    await h.user.type(
      h.root.querySelector<HTMLInputElement>("[data-actions-stop-message]")!,
      "Check the tint",
    );
    await h.click(action(h, "actions-insert-stop"));
    expect(
      h.root.querySelector("[data-actions-stop-step]")?.textContent,
    ).toContain("Check the tint");
    calls.length = 0;
    await h.click(action(h, `actions-play-${idOf(h)}`));
    expect(calls).toHaveLength(2);
    expect(
      h.root.querySelector("[data-actions-playback-message]")?.textContent,
    ).toContain("Check the tint");
    await h.click(action(h, "actions-cancel-playback"));
    expect(h.root.querySelector("[data-actions-playback]")).toBeNull();
    expect(h.root.querySelector("[data-actions-undo]")?.textContent).toContain(
      "Cancelled",
    );
  });

  test("Step plays one step at a time [editor-shell.actions-batch]", async () => {
    covers("panel:paged.actions");
    const { h, calls } = await mount();
    await recordTwo(h, "Stepped");
    calls.length = 0;
    await h.click(action(h, `actions-step-${idOf(h)}`));
    expect(calls.map((c) => c.id)).toEqual(["test.nudge"]);
    await h.click(action(h, "actions-step-once"));
    expect(calls.map((c) => c.id)).toEqual(["test.nudge", "test.tint"]);
    await h.click(action(h, "actions-step-once"));
    expect(h.root.querySelector("[data-actions-playback]")).toBeNull();
  });

  test("Run on import plays the action after a matching import, and only then [editor-shell.actions-batch]", async () => {
    covers("panel:paged.actions");
    const { h, calls } = await mount();
    await recordTwo(h, "Droplet");
    await h.user.type(
      h.root.querySelector<HTMLInputElement>(
        "[data-actions-import-extensions]",
      )!,
      "png, .TIF",
    );
    await h.click(h.root.querySelector("[data-actions-run-on-import]")!);
    calls.length = 0;
    await h.act(() =>
      notifyImported(h.scope, { name: "notes.txt", via: "importer" }),
    );
    expect(calls).toEqual([]);
    await h.act(() =>
      notifyImported(h.scope, { name: "Scan.tif", via: "importer" }),
    );
    expect(calls.map((c) => c.id)).toEqual(["test.nudge", "test.tint"]);
    // The rule is kept with the library.
    const stored = JSON.parse(
      localStorage.getItem(
        Object.keys(localStorage).find((k) => k.includes("action")) ?? "",
      ) ?? "{}",
    );
    expect(stored.importRules?.[0]?.extensions).toEqual(["png", "tif"]);
  });
});
