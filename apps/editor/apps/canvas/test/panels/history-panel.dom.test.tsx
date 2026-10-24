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

// History (paged.history, editor ADR 285): the engine's named undo
// timeline (engine ADR 1016) listed oldest first with the current step
// marked; a click goes back (one `undoTo`) or forward (one `redoTo`);
// snapshots restore as ONE new undo step; the depth preference reaches the
// engine; and an active edit context's own steps replace the list.

import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { covers } from "@paged-media/test-kit";

import {
  editorStorage,
  useEditContextStack,
  type EditContextStackValue,
} from "@paged-media/shell";

import { HistoryPanel } from "../../src/panels/history-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = (document: "none" | "blank" = "blank") =>
  mountPanel(HistoryPanel, { id: "paged.history", document });

async function pageId(h: PanelHarness<unknown>): Promise<string> {
  return h.handle!.pageIds[0]!;
}

async function threeEdits(h: PanelHarness<unknown>) {
  const page = await pageId(h);
  for (const x of [20, 150, 300]) {
    await h.mutate({
      op: "insertTextFrame",
      args: { pageId: page, bounds: [x, 20, x + 80, 100] },
    } as never);
  }
  await h.settle();
}

const rows = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLButtonElement>("[data-history-step]")].map(
    (b) => ({
      text: b.textContent,
      state: b.getAttribute("data-history-state"),
    }),
  );

const stepButtons = (h: PanelHarness<unknown>) => [
  ...h.root.querySelectorAll<HTMLButtonElement>("[data-history-step]"),
];

const undoLen = async (h: PanelHarness<unknown>) =>
  (await h.client.undoLog()).undoLen;

// The History panel with the editor's context stack in reach, so a test
// can enter a context the way a double-click does.
// Handed out from an effect: a render must not write outside itself.
const stacks: EditContextStackValue[] = [];
function HistoryWithStack(props: Parameters<typeof HistoryPanel>[0]) {
  const s = useEditContextStack();
  useEffect(() => {
    stacks.push(s);
  }, [s]);
  return <HistoryPanel {...props} />;
}

describe("History panel", () => {
  test("no document: says so", async () => {
    covers("panel:paged.history");
    const h = await mount("none");
    expect(h.root.textContent).toContain("No document loaded.");
  });

  test("an untouched document: the empty line", async () => {
    covers("panel:paged.history");
    const h = await mount();
    await h.settle();
    expect(h.root.querySelector("[data-history-empty]")).not.toBeNull();
  });

  test("[editor-shell.panels.history] steps by name, oldest first, the current one marked", async () => {
    covers("panel:paged.history");
    const h = await mount();
    await threeEdits(h);
    expect(rows(h)).toEqual([
      { text: "Insert text frame", state: "done" },
      { text: "Insert text frame", state: "done" },
      { text: "Insert text frame", state: "current" },
    ]);
    expect(h.root.querySelector("[data-history-origin]")?.textContent).toBe(
      "Opened document",
    );
  });

  test("[editor-shell.panels.history] a click goes back in ONE round trip; a click on an undone step redoes", async () => {
    covers("panel:paged.history");
    const h = await mount();
    await threeEdits(h);
    const mark = h.mark();
    await h.click(stepButtons(h)[0]!);
    // One message, not two undos.
    expect(h.sent("undoTo", mark)).toHaveLength(1);
    expect(h.sent("undo", mark)).toHaveLength(0);
    expect(rows(h).map((r) => r.state)).toEqual([
      "current",
      "undone",
      "undone",
    ]);
    expect(await undoLen(h)).toBe(1);

    await h.click(stepButtons(h)[2]!);
    expect(h.sent("redoTo", mark)).toHaveLength(1);
    expect(rows(h).map((r) => r.state)).toEqual(["done", "done", "current"]);

    // Back to the opened document.
    await h.click(h.root.querySelector("[data-history-origin]")!);
    expect(rows(h).map((r) => r.state)).toEqual(["undone", "undone", "undone"]);
    expect(await undoLen(h)).toBe(0);
  });

  test("[editor-shell.panels.history] a snapshot restores as one new, undoable step", async () => {
    covers("panel:paged.history");
    const h = await mount();
    const page = await pageId(h);
    await h.mutate({
      op: "insertTextFrame",
      args: { pageId: page, bounds: [20, 20, 100, 100] },
    } as never);
    await h.settle();
    await h.click(
      h.root.querySelector('[data-toolbar-btn="history-new-snapshot"]')!,
    );
    const snap = h.root.querySelector("[data-history-snapshot]");
    expect(snap?.textContent).toContain("Snapshot 1");
    const restore = snap!.querySelector<HTMLButtonElement>(
      "[data-history-snapshot-restore]",
    )!;
    expect(restore.disabled).toBe(true); // the document IS the snapshot
    await h.mutate({
      op: "insertTextFrame",
      args: { pageId: page, bounds: [200, 20, 280, 100] },
    } as never);
    await h.settle();
    expect(restore.disabled).toBe(false);
    const mark = h.mark();
    await h.click(restore);
    expect(h.sent("restoreTo", mark)).toHaveLength(1);
    expect(rows(h).at(-1)).toEqual({
      text: "Restore Snapshot 1",
      state: "current",
    });
    expect(rows(h)).toHaveLength(3);
    // The restore is one step: one undo takes it back.
    await h.act(() => h.client.undo());
    expect(rows(h).at(-1)?.state).toBe("undone");
    expect(await undoLen(h)).toBe(2);
  });

  test("the depth preference reaches the engine", async () => {
    covers("panel:paged.history", "setting:paged.history.depth");
    const h = await mount();
    await threeEdits(h);
    const depth = h.root.querySelector<HTMLSelectElement>(
      "[data-history-depth]",
    )!;
    await h.choose(depth, "50");
    expect((await h.client.undoLog()).depth).toBe(50);
    // Kept in the editor's storage, under the inventory's key.
    expect(editorStorage(h.scope).getItem("paged.history.depth")).toBe("50");
  });

  test("[editor-shell.panels.history] an active edit context's own steps replace the document's", async () => {
    covers("panel:paged.history");
    const h = await mountPanel(HistoryWithStack, { id: "paged.history" });
    await threeEdits(h);
    const listeners = new Set<() => void>();
    let undo = ["Brush stroke", "Fill"];
    let redo: string[] = [];
    const moves: number[] = [];
    const contribution = {
      type: "testPixels",
      historySteps: () => ({
        undo,
        redo,
        step: (delta: number) => {
          moves.push(delta);
          if (delta < 0) {
            redo = [...undo.slice(undo.length + delta), ...redo];
            undo = undo.slice(0, undo.length + delta);
          }
          for (const l of listeners) l();
        },
      }),
      onDidChangeHistory: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    await h.act(() => {
      stacks
        .at(-1)!
        .enter(contribution as never, { kind: "rectangle", id: "u1" } as never);
    });
    expect(
      h.root
        .querySelector("[data-history-panel]")
        ?.getAttribute("data-history-source"),
    ).toBe("context");
    expect(rows(h).map((r) => r.text)).toEqual(["Brush stroke", "Fill"]);
    await h.click(stepButtons(h)[0]!);
    expect(moves).toEqual([-1]);
    expect(rows(h).map((r) => r.state)).toEqual(["current", "undone"]);
  });
});
