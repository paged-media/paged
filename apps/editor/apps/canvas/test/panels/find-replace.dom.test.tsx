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

// Editor ADR 303 — Find & Replace over the real engine: the results panel
// lists every hit with its context and a click selects the hit; the dialog
// finds next, replaces the hit the selection stands on (one undo step) and
// replaces all in ONE undo step; the Go To dialog takes a page number.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { fireEvent } from "@testing-library/react";

import {
  FindReplaceDialog,
  FindResultsPanel,
  FIND_RESULTS_PANEL,
  GoToDialog,
} from "../../src/find/find-ui";
import { findStoreOf, patchFind } from "../../src/find/find-state";
import { textScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

async function storyText(
  h: PanelHarness<{ storyId: string }>,
): Promise<string> {
  const r = (await h.client.send({
    kind: "requestStoryContent",
    payload: { storyId: h.scene.storyId },
  } as never)) as {
    payload: {
      content: { paragraphs: Array<{ runs: Array<{ text: string }> }> };
    };
  };
  return r.payload.content.paragraphs
    .map((p) => p.runs.map((x) => x.text).join(""))
    .join("\n");
}

const q = (_h: PanelHarness<unknown>, sel: string) =>
  document.querySelector(sel) as HTMLElement;

async function type(
  h: PanelHarness<unknown>,
  el: HTMLElement,
  value: string,
): Promise<void> {
  await h.act(() => {
    fireEvent.change(el, { target: { value } });
  });
}

function Dialogs() {
  return (
    <>
      <FindReplaceDialog />
      <GoToDialog />
    </>
  );
}

describe("paged.find-results", () => {
  test("lists every hit with its context, and a click selects the hit", async () => {
    covers("panel:paged.find-results");
    const h = await mountPanel(FindResultsPanel, {
      id: FIND_RESULTS_PANEL,
      scene: textScene,
    });
    const field = q(h, "[data-find-search]");
    await type(h, field, "o");
    await h.act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await h.settle();
    // "Hello world\nSecond paragraph": o in Hello, world, Second.
    const hits = document.querySelectorAll("[data-find-hit]");
    expect(hits).toHaveLength(3);
    expect(q(h, "[data-find-count]").getAttribute("data-find-count")).toBe("3");
    expect(hits[2]!.querySelector("mark")!.textContent).toBe("o");
    expect(hits[2]!.textContent).toBe("Second paragraph");
    await h.click(hits[2]!);
    // "Second" starts at 12; its "o" is at 15.
    expect(h.paged.contentSelection.contentSelectionRef.current).toMatchObject({
      storyId: h.scene.storyId,
      start: 15,
      end: 16,
    });
    expect(hits[2]!.getAttribute("aria-current")).toBe("true");
  });

  test("match case and whole word narrow the hits; the hits follow edits", async () => {
    covers("panel:paged.find-results");
    const h = await mountPanel(FindResultsPanel, {
      id: FIND_RESULTS_PANEL,
      scene: textScene,
    });
    const field = q(h, "[data-find-search]");
    await type(h, field, "Hello");
    await h.act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await h.settle();
    expect(document.querySelectorAll("[data-find-hit]")).toHaveLength(1);
    await type(h, field, "hello");
    await h.click(q(h, '[data-find-option="matchCase"]'));
    await h.act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await h.settle();
    expect(document.querySelectorAll("[data-find-hit]")).toHaveLength(0);
    expect(q(h, "[data-find-count]").textContent).toBe("No results");
    // An edit re-runs the search.
    await h.mutate({
      op: "insertText",
      args: { storyId: h.scene.storyId, offset: 0, text: "hello " },
    } as never);
    await h.act(() => new Promise((r) => setTimeout(r, 400)));
    await h.settle();
    expect(document.querySelectorAll("[data-find-hit]")).toHaveLength(1);
  });
});

describe("Find & Replace dialog", () => {
  test("find next walks the hits and wraps", async () => {
    const h = await mountPanel(Dialogs, { scene: textScene });
    await h.act(() => patchFind(findStoreOf(h.scope), { dialog: true }));
    expect(q(h, "[data-find-dialog]")).not.toBeNull();
    await type(h, q(h, '[data-find-input="find"]'), "o");
    const sel = () => h.paged.contentSelection.contentSelectionRef.current;
    await h.click(q(h, '[data-find-action="next"]'));
    expect(sel()).toMatchObject({ start: 4, end: 5 });
    await h.click(q(h, '[data-find-action="next"]'));
    expect(sel()).toMatchObject({ start: 7, end: 8 });
    await h.click(q(h, '[data-find-action="next"]'));
    expect(sel()).toMatchObject({ start: 15, end: 16 });
    await h.click(q(h, '[data-find-action="next"]'));
    expect(sel()).toMatchObject({ start: 4, end: 5 });
    expect(q(h, "[data-find-status]").textContent).toBe("1 of 3");
    await h.click(q(h, '[data-find-action="previous"]'));
    expect(sel()).toMatchObject({ start: 15, end: 16 });
  });

  test("replace changes the selected hit only, in one undo step", async () => {
    const h = await mountPanel(Dialogs, { scene: textScene });
    await h.act(() => patchFind(findStoreOf(h.scope), { dialog: true }));
    await type(h, q(h, '[data-find-input="find"]'), "o");
    await type(h, q(h, '[data-find-input="replace"]'), "0");
    // The first Replace finds; the second replaces the hit it stands on.
    await h.click(q(h, '[data-find-action="replace"]'));
    await h.click(q(h, '[data-find-action="next"]'));
    const from = h.mark();
    await h.click(q(h, '[data-find-action="replace"]'));
    expect(await storyText(h)).toBe("Hello w0rld\nSecond paragraph");
    expect(h.mutations(from)).toHaveLength(1);
    await h.client.undo();
    expect(await storyText(h)).toBe("Hello world\nSecond paragraph");
  });

  test("replace all is one undo step, with ^p in the pattern", async () => {
    const h = await mountPanel(Dialogs, { scene: textScene });
    await h.act(() => patchFind(findStoreOf(h.scope), { dialog: true }));
    await type(h, q(h, '[data-find-input="find"]'), "o");
    await type(h, q(h, '[data-find-input="replace"]'), "0");
    const from = h.mark();
    await h.click(q(h, '[data-find-action="replaceAll"]'));
    expect(await storyText(h)).toBe("Hell0 w0rld\nSec0nd paragraph");
    expect(h.mutations(from).map((m) => m.op)).toEqual(["findReplace"]);
    expect(q(h, "[data-find-status]").textContent).toBe("3 replacements");
    await h.client.undo();
    expect(await storyText(h)).toBe("Hello world\nSecond paragraph");
    // The specials: a paragraph break joined into a space.
    await type(h, q(h, '[data-find-input="find"]'), "world^pSecond");
    await type(h, q(h, '[data-find-input="replace"]'), "world Second");
    await h.click(q(h, '[data-find-action="replaceAll"]'));
    expect(await storyText(h)).toBe("Hello world Second paragraph");
  });

  test("wildcards, whole word and the special menu", async () => {
    const h = await mountPanel(Dialogs, { scene: textScene });
    await h.act(() => patchFind(findStoreOf(h.scope), { dialog: true }));
    const find = q(h, '[data-find-input="find"]');
    await h.act(() => {
      fireEvent.focus(find);
    });
    await h.act(() => {
      fireEvent.change(q(h, "[data-find-special]"), {
        target: { value: "^p" },
      });
    });
    expect((find as HTMLInputElement).value).toBe("^p");
    await type(h, find, "<[A-Z]*>");
    await h.act(() => {
      fireEvent.change(q(h, "[data-find-mode]"), {
        target: { value: "wildcards" },
      });
    });
    await h.click(q(h, '[data-find-option="matchCase"]'));
    await h.click(q(h, '[data-find-action="next"]'));
    const store = findStoreOf(h.scope);
    expect(store.get().hits.map((x) => x.text)).toEqual(["Hello", "Second"]);
    await type(h, find, "Sec");
    await h.act(() => {
      fireEvent.change(q(h, "[data-find-mode]"), {
        target: { value: "literal" },
      });
    });
    await h.click(q(h, '[data-find-option="wholeWord"]'));
    await h.click(q(h, '[data-find-action="next"]'));
    expect(q(h, "[data-find-status]").textContent).toBe("Not found");
  });

  test("Go to takes a page number", async () => {
    const h = await mountPanel(Dialogs, { scene: textScene });
    await h.act(() => patchFind(findStoreOf(h.scope), { goTo: true }));
    const input = q(h, "[data-goto-input]");
    await type(h, input, "9");
    expect(
      (q(h, '[data-find-action="go"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    await type(h, input, "1");
    await h.click(q(h, '[data-find-action="go"]'));
    expect(findStoreOf(h.scope).get().goTo).toBe(false);
  });
});
