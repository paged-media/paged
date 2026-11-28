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
// timeline (engine ADR 1030) listed oldest first with the current step
// marked; a click goes back (one `undoTo`) or forward (one `redoTo`);
// snapshots restore as ONE new undo step; the depth preference reaches the
// engine; and an active edit context's own steps replace the list. The
// list is windowed: a long timeline costs a screenful of rows, the current
// step's among them.

import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { covers } from "@paged-media/test-kit";

import {
  editorStorage,
  useEditContextStack,
  type EditContextStackValue,
} from "@paged-media/shell";

import type { UndoLog } from "@paged-media/client";

import { HISTORY_ROW_PX, HistoryPanel } from "../../src/panels/history-panel";
import { historyStoreOf } from "../../src/panels/history-store";
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

  // A timeline of `undo` done steps (seq 1..undo) and `redo` undone ones,
  // answered in place of the engine's (the panel only reads it).
  const longLog = (undo: number, redo: number): UndoLog =>
    ({
      undo: Array.from({ length: undo }, (_, i) => ({
        appliedSeq: i + 1,
        label: `Step ${i + 1}`,
        key: null,
      })),
      redo: Array.from({ length: redo }, (_, i) => ({
        appliedSeq: undo + i + 1,
        label: `Step ${undo + i + 1}`,
        key: null,
      })),
      undoLen: undo,
      redoLen: redo,
      evicted: 0,
      depth: 10000,
    }) as unknown as UndoLog;

  async function withLog(h: PanelHarness<unknown>, log: UndoLog) {
    (h.client as { undoLog: unknown }).undoLog = async () => log;
    await h.act(() => historyStoreOf(h.client).refresh());
  }

  const listItems = (h: PanelHarness<unknown>) => [
    ...h.root.querySelectorAll<HTMLElement>('[role="listitem"]'),
  ];

  test("[editor-shell.panels.history] windowed: 5,000 steps draw a screenful of rows, the current one among them, each saying its place", async () => {
    covers("panel:paged.history");
    const h = await mount();
    await h.settle();
    // 4,000 done, 1,000 undone: the current step is row 4,001 of 5,001
    // (the opened document is row 1).
    await withLog(h, longLog(4000, 1000));
    const list = h.root.querySelector<HTMLElement>("[data-history-list]")!;
    expect(list.getAttribute("role")).toBe("list");
    expect(list.getAttribute("aria-label")).toBe("History steps");
    expect(list.getAttribute("data-history-count")).toBe("5001");
    // A bounded number of rows, not five thousand.
    expect(listItems(h).length).toBeLessThan(80);
    expect(stepButtons(h).length).toBeLessThan(80);
    // The spacer still has the whole timeline's height (the scrollbar).
    expect((list.firstElementChild as HTMLElement).style.height).toBe(
      `${5001 * HISTORY_ROW_PX}px`,
    );
    // The current step is drawn, marked, and in the scrolled-to window.
    const current = h.root.querySelector<HTMLButtonElement>(
      '[data-history-step][data-history-state="current"]',
    )!;
    expect(current.textContent).toBe("Step 4000");
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(current.disabled).toBe(false);
    const item = current.closest<HTMLElement>('[role="listitem"]')!;
    expect(item.getAttribute("aria-posinset")).toBe("4001");
    expect(item.getAttribute("aria-setsize")).toBe("5001");
    expect(item.style.top).toBe(`${4000 * HISTORY_ROW_PX}px`);
    const top = list.scrollTop;
    expect(top).toBeGreaterThan(0);
    expect(4000 * HISTORY_ROW_PX).toBeGreaterThanOrEqual(top);
    // Its neighbours on both sides are there; the far ends are not.
    const texts = stepButtons(h).map((b) => b.textContent);
    expect(texts).toContain("Step 3999");
    expect(texts).toContain("Step 4001");
    expect(texts).not.toContain("Step 1");
    expect(texts).not.toContain("Step 5000");
    expect(h.root.querySelector("[data-history-origin]")).toBeNull();
  });

  test("[editor-shell.panels.history] windowed: a click on a drawn row sends the same jump; the list follows the current step", async () => {
    covers("panel:paged.history");
    const h = await mount();
    await h.settle();
    await withLog(h, longLog(4000, 1000));
    const byText = (text: string) =>
      stepButtons(h).find((b) => b.textContent === text)!;

    // Back to the state after step 3,990: ONE undoTo, of the step after it.
    let mark = h.mark();
    await h.click(byText("Step 3990"));
    expect(h.sent("undoTo", mark)).toHaveLength(1);
    expect(h.sent("undoTo", mark)[0]).toMatchObject({
      payload: { appliedSeq: 3991 },
    });
    expect(h.sent("undo", mark)).toHaveLength(0);

    // Forward: ONE redoTo, of the clicked step.
    mark = h.mark();
    await h.click(byText("Step 4005"));
    expect(h.sent("redoTo", mark)).toHaveLength(1);
    expect(h.sent("redoTo", mark)[0]).toMatchObject({
      payload: { appliedSeq: 4005 },
    });

    // The current step moves far away (an undo to step 10): the list
    // scrolls to it and draws it, still a screenful.
    await withLog(h, longLog(10, 4990));
    const current = h.root.querySelector<HTMLButtonElement>(
      '[data-history-step][data-history-state="current"]',
    )!;
    expect(current.textContent).toBe("Step 10");
    const list = h.root.querySelector<HTMLElement>("[data-history-list]")!;
    expect(list.scrollTop).toBeLessThanOrEqual(10 * HISTORY_ROW_PX);
    expect(listItems(h).length).toBeLessThan(80);
    const texts = stepButtons(h).map((x) => x.textContent);
    expect(texts).toContain("Step 9");
    expect(texts).toContain("Step 11");
    expect(texts).not.toContain("Step 4000");
  });

  test("windowed: Down, Up, Home and End move focus along the rows, drawing the row they reach", async () => {
    covers("panel:paged.history");
    const h = await mount();
    await h.settle();
    await withLog(h, longLog(4000, 1000));
    const current = h.root.querySelector<HTMLButtonElement>(
      '[data-history-state="current"]',
    )!;
    await h.act(() => current.focus());
    const focused = () => document.activeElement?.textContent;
    await h.user.keyboard("{ArrowDown}");
    await h.settle();
    expect(focused()).toBe("Step 4001");
    await h.user.keyboard("{ArrowUp}{ArrowUp}");
    await h.settle();
    expect(focused()).toBe("Step 3999");
    await h.user.keyboard("{End}");
    await h.settle();
    expect(focused()).toBe("Step 5000");
    expect(listItems(h).length).toBeLessThan(80);
    await h.user.keyboard("{Home}");
    await h.settle();
    expect(focused()).toBe("Opened document");
    expect(listItems(h).length).toBeLessThan(80);
  });
});
