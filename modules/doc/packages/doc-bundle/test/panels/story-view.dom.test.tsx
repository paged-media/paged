/*
 * This file is part of paged (https://paged.media).
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

// Doc ADR 630 — the Story view and the Story Map, rendered (happy-dom)
// over fake doors: the view shows the engine's paragraphs, a typed edit
// becomes one write at the paragraph's offsets, Enter splits through the
// engine, Layout view closes; the map lists threads, overset and stories
// placed nowhere, and its chips navigate.

import { afterEach, describe, expect, it } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type { Mutation } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  StoryView,
  createStoryFocus,
  type StoryDoors,
} from "../../src/story/story-view";
import { StoryMapPanel } from "../../src/story/story-map-panel";
import { storyMap, type MapFrame } from "../../src/story/story-map-model";

afterEach(() => cleanup());

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

function fakeDoors() {
  let paragraphs = [
    { paragraphStyle: "Heading 1", runs: [{ text: "Title" }] },
    { runs: [{ text: "First line." }] },
    { runs: [{ text: "Second line." }] },
  ];
  const writes: Mutation[] = [];
  const listeners = new Set<() => void>();
  const shown: Array<[string, number, number]> = [];
  const history: string[] = [];
  const doors: StoryDoors = {
    stories: async () => [{ storyId: "s1", preview: "Title First line." }],
    read: async () => ({ content: { paragraphs }, oversetParagraph: 2 }),
    write: async (m) => {
      writes.push(m);
      return true;
    },
    onDidChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    showInLayout: (id, s, e) => shown.push([id, s, e]),
    undo: () => history.push("undo"),
    redo: () => history.push("redo"),
  };
  const change = (next: typeof paragraphs) => {
    paragraphs = next;
    for (const l of listeners) l();
  };
  return { doors, writes, shown, history, change };
}

describe("story view", () => {
  it("shows the story as headings and paragraphs, with the overset rule", async () => {
    const { doors } = fakeDoors();
    const focus = createStoryFocus();
    focus.set("s1");
    const r = render(
      <StoryView doors={doors} focus={focus} close={() => {}} />,
    );
    await settle();
    const fields = r.container.querySelectorAll("textarea");
    expect([...fields].map((f) => f.value)).toEqual([
      "Title",
      "First line.",
      "Second line.",
    ]);
    expect(
      r.container
        .querySelector('[data-story-block="0"]')!
        .getAttribute("data-story-shape"),
    ).toBe("heading");
    expect(
      r.container.querySelector("[data-story-overset-rule]"),
    ).not.toBeNull();
    expect(
      r.container
        .querySelector('[data-story-block="2"]')!
        .getAttribute("data-story-overset"),
    ).toBe("true");
    expect(r.container.querySelector("[data-story-outline]")!.textContent).toBe(
      "Title",
    );
  });

  it("a typed edit is one write at the paragraph's offsets; Enter splits through the engine", async () => {
    const { doors, writes } = fakeDoors();
    const focus = createStoryFocus();
    focus.set("s1");
    const r = render(
      <StoryView doors={doors} focus={focus} close={() => {}} />,
    );
    await settle();
    const second = r.container.querySelector(
      '[data-story-paragraph="1"]',
    ) as HTMLTextAreaElement;
    second.focus();
    second.value = "First line, edited.";
    fireEvent.input(second);
    fireEvent.blur(second);
    await settle();
    expect(writes).toEqual([
      {
        op: "insertText",
        args: { storyId: "s1", offset: 16, text: ", edited" },
      },
    ]);
    // Enter in the middle: a paragraph break where the caret is.
    second.focus();
    second.setSelectionRange(5, 5);
    fireEvent.keyDown(second, { key: "Enter" });
    await settle();
    expect(writes[1]).toEqual({
      op: "insertText",
      args: { storyId: "s1", offset: 11, text: "\n" },
    });
  });

  it("Cmd+Z is the document's undo; Layout view closes the view", async () => {
    const { doors, history } = fakeDoors();
    const focus = createStoryFocus();
    focus.set("s1");
    let closed = 0;
    const r = render(
      <StoryView doors={doors} focus={focus} close={() => (closed += 1)} />,
    );
    await settle();
    const first = r.container.querySelector(
      '[data-story-paragraph="0"]',
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(first, { key: "z", metaKey: true });
    await settle();
    expect(history).toEqual(["undo"]);
    fireEvent.click(r.container.querySelector("[data-story-view-close]")!);
    expect(closed).toBe(1);
  });

  it("shows what the engine holds after a change made elsewhere", async () => {
    const { doors, change } = fakeDoors();
    const focus = createStoryFocus();
    focus.set("s1");
    const r = render(
      <StoryView doors={doors} focus={focus} close={() => {}} />,
    );
    await settle();
    change([{ runs: [{ text: "Only this." }] }]);
    await settle();
    expect(
      [...r.container.querySelectorAll("textarea")].map((f) => f.value),
    ).toEqual(["Only this."]);
  });
});

describe("story map panel", () => {
  it("lists threads with overset and unplaced stories, and its chips navigate", async () => {
    covers("panel:media.paged.doc.panel.storyMap");
    const map = storyMap(
      [
        { selfId: "a", characterCount: 50, paragraphCount: 2 },
        {
          selfId: "b",
          characterCount: 500,
          paragraphCount: 5,
          overset: true,
          oversetAt: { paragraph: 3, line: 0 },
        },
        { selfId: "c", characterCount: 5, paragraphCount: 1 },
      ],
      new Map([
        ["a", ["fa"]],
        ["b", ["fb1", "fb2"]],
      ]),
      new Map([
        ["fa", { pageId: "p1", pageIndex: 0 }],
        ["fb1", { pageId: "p1", pageIndex: 0 }],
        ["fb2", { pageId: "p2", pageIndex: 1 }],
      ]),
    );
    const went: MapFrame[] = [];
    const opened: string[] = [];
    const r = render(
      <StoryMapPanel
        doors={{
          read: async () => map,
          onDidChange: () => () => {},
          goToFrame: (f) => went.push(f),
          openStory: (id) => opened.push(id),
          pageLabel: (i) => String(i + 1),
        }}
      />,
    );
    await settle();
    expect(
      r.container.querySelector("[data-story-map-summary]")!.textContent,
    ).toBe("3 stories · 1 overset · 1 not placed");
    const rows = [...r.container.querySelectorAll("[data-story-map-story]")];
    expect(rows.map((x) => x.getAttribute("data-story-map-story"))).toEqual([
      "b",
      "c",
      "a",
    ]);
    fireEvent.click(r.container.querySelector('[data-story-map-frame="fb2"]')!);
    expect(went.map((f) => f.frameId)).toEqual(["fb2"]);
    fireEvent.click(r.container.querySelector('[data-story-map-overset="b"]')!);
    expect(went.map((f) => f.frameId)).toEqual(["fb2", "fb2"]);
    expect(r.container.querySelector("[data-story-map-loose]")).not.toBeNull();
    fireEvent.click(r.container.querySelector('[data-story-map-open="a"]')!);
    expect(opened).toEqual(["a"]);
  });
});
