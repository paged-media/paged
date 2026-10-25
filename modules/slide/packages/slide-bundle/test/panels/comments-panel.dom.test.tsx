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

// [plugin-slide.comments] The Comments panel, RENDERED (happy-dom) against
// the real engine with a deck open: the active slide's threads, and what
// each control does to the deck's comments part (never to a mock): a new
// thread, a reply, Resolve / Reopen (resolved threads fold away), Delete,
// and the threads following the active slide.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { COMMENTS_PANEL_ID } from "../../src/activate";
import { COMMENTS_PART, parseFile } from "../../src/comments-model";
import { drive, mount, openDeck, settle, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck();
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

/** The deck's comments part as the bundle wrote it. */
async function part() {
  return parseFile(await d.host.parts.read(COMMENTS_PART));
}

async function shown() {
  const view = mount(d.panel(COMMENTS_PANEL_ID));
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-comments-panel="ready"]'),
    ).not.toBeNull(),
  );
  await settle();
  return view;
}

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) =>
  root.querySelector<T & Element>(sel) as T;

async function addThread(root: HTMLElement, text: string, author = "Ana Lima") {
  await drive(() => {
    fireEvent.change(q(root, "[data-comment-author]"), {
      target: { value: author },
    });
    fireEvent.change(q(root, "[data-comment-new]"), {
      target: { value: text },
    });
  });
  await drive(() => fireEvent.click(q(root, "[data-comment-add]")));
}

describe("[plugin-slide.comments] the Comments panel", () => {
  it("is in the panel rail once a deck is open, and says the slide has no comments", async () => {
    covers("panel:media.paged.slide.panel.comments");
    expect(d.panel(COMMENTS_PANEL_ID).rail).toBe(true);
    const view = await shown();
    const pages = await d.pageIds();
    expect(
      q(view.container, "[data-comments-panel]").dataset.commentsPage,
    ).toBe(pages[0]);
    expect(q(view.container, "[data-comments-none]")).not.toBeNull();
    // The importer kept a list for every slide.
    expect(Object.keys((await part())!.byPage).sort()).toEqual(
      [...pages].sort(),
    );
  });

  it("adds a thread on the active slide, under the name given", async () => {
    covers("panel:media.paged.slide.panel.comments");
    const view = await shown();
    await addThread(view.container, "Tighten the title");
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-comment]")).toHaveLength(1),
    );
    expect(q(view.container, "[data-comment-text]").textContent).toBe(
      "Tighten the title",
    );
    expect(view.container.textContent).toContain("Ana Lima");
    const pages = await d.pageIds();
    const saved = (await part())!.byPage[pages[0]!]!;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      author: "Ana Lima",
      initials: "AL",
      text: "Tighten the title",
      status: null,
      legacy: false,
    });
    // The new-comment box is empty again.
    expect(
      q<HTMLTextAreaElement>(view.container, "[data-comment-new]").value,
    ).toBe("");
  });

  it("replies, resolves (the thread folds away), reopens and deletes", async () => {
    covers("panel:media.paged.slide.panel.comments");
    const view = await shown();
    await addThread(view.container, "Check the date");
    const thread = () => q(view.container, "[data-comment]");
    await waitFor(() => expect(thread()).not.toBeNull());

    await drive(() =>
      fireEvent.change(q(thread(), "[data-reply-input]"), {
        target: { value: "Fixed in v2" },
      }),
    );
    await drive(() => fireEvent.click(q(thread(), "[data-reply-send]")));
    await waitFor(() =>
      expect(q(thread(), "[data-reply-text]")?.textContent).toBe("Fixed in v2"),
    );
    const page = (await d.pageIds())[0]!;
    expect(
      (await part())!.byPage[page]![0]!.replies.map((r) => r.text),
    ).toEqual(["Fixed in v2"]);

    await drive(() => fireEvent.click(q(thread(), "[data-comment-resolve]")));
    await waitFor(() => expect(thread()).toBeNull());
    expect((await part())!.byPage[page]![0]!.status).toBe("resolved");
    await drive(() =>
      fireEvent.click(q(view.container, "[data-show-resolved]")),
    );
    await waitFor(() => expect(thread()?.dataset.resolved).toBe("true"));
    await drive(() => fireEvent.click(q(thread(), "[data-comment-resolve]")));
    await waitFor(() => expect(thread()?.dataset.resolved).toBeUndefined());
    expect((await part())!.byPage[page]![0]!.status).toBeNull();

    await drive(() => fireEvent.click(q(thread(), "[data-comment-delete]")));
    await waitFor(() => expect(thread()).toBeNull());
    expect((await part())!.byPage[page]).toEqual([]);
  });

  it("follows the active slide", async () => {
    covers("panel:media.paged.slide.panel.comments");
    const view = await shown();
    await addThread(view.container, "On slide one");
    const pages = await d.pageIds();
    await drive(() => d.setActivePage(pages[1]!));
    await waitFor(() =>
      expect(
        q(view.container, "[data-comments-panel]").dataset.commentsPage,
      ).toBe(pages[1]),
    );
    expect(view.container.querySelectorAll("[data-comment]")).toHaveLength(0);
    await drive(() => d.setActivePage(pages[0]!));
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-comment]")).toHaveLength(1),
    );
  });
});

describe("[plugin-slide.comments] the Comments panel on a PowerPoint-saved deck", () => {
  it("shows the deck's threads with their replies; a resolved thread folds away", async () => {
    covers("panel:media.paged.slide.panel.comments");
    cleanup();
    d.dispose();
    d = await openDeck("comments");
    const view = await shown();
    const pages = await d.pageIds();
    // Slide 1: Ada Lovelace's comment and Grace Hopper's reply.
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-comment]")).toHaveLength(1),
    );
    const first = q(view.container, "[data-comment]");
    expect(first.dataset.comment).toBe(
      "{C0C0C0C0-0000-4000-8000-000000000001}",
    );
    expect(q(first, "[data-comment-text]").textContent).toBe("Check the title");
    expect(first.textContent).toContain("Ada Lovelace");
    expect(q(first, "[data-reply-text]").textContent).toBe("Done");
    expect(first.textContent).toContain("Grace Hopper");
    // Slide 2: its one thread is resolved, so only "Show resolved" shows it.
    await drive(() => d.setActivePage(pages[1]!));
    await waitFor(() =>
      expect(q(view.container, "[data-comments-none]")).not.toBeNull(),
    );
    await drive(() =>
      fireEvent.click(q(view.container, "[data-show-resolved]")),
    );
    await waitFor(() =>
      expect(q(view.container, "[data-comment]")?.dataset.resolved).toBe(
        "true",
      ),
    );
    expect(q(view.container, "[data-comment-text]").textContent).toBe(
      "Shorter title?",
    );
    // Slide 3: the comment PowerPoint converted from a legacy one.
    await drive(() => d.setActivePage(pages[2]!));
    await waitFor(() =>
      expect(q(view.container, "[data-comment-text]")?.textContent).toBe(
        "Legacy note",
      ),
    );
  });
});
