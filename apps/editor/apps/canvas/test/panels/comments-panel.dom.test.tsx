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

// Comments (paged.comments), engine ADR 1055: the document's comment threads
// whatever they are attached to; reply, resolve, delete; a new comment on the
// selected text or object. The model is `comments-model.test.ts`; this mounts
// the panel on a real engine.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { CommentsPanel } from "../../src/panels/comments-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

const mount = () =>
  mountPanel(CommentsPanel, { id: "paged.comments", scene: richScene });

const thread = (id: string, item: string, text: string) =>
  ({
    op: "insertCommentThread",
    args: {
      anchor: { kind: "item", item },
      comment: {
        id,
        author: "Ann Author",
        initials: "AA",
        date: "2026-11-01T09:00:00Z",
        text,
      },
    },
  }) as never;

/** The string id of the scene's rectangle. */
const rectId = (h: { scene: { rect: { id: unknown } } }): string => {
  const id = h.scene.rect.id;
  if (typeof id !== "string")
    throw new Error("the scene's rectangle has no plain id");
  return id;
};

const q = (root: Element, selector: string) => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el as HTMLElement;
};

describe("Comments panel", () => {
  test("a document with no comments says so and offers no comment without a target", async () => {
    covers("panel:paged.comments");
    const h = await mount();
    expect(h.root.querySelector("[data-comments-panel]")).not.toBeNull();
    expect(h.root.textContent).toContain("No comments yet");
    expect(q(h.root, "[data-new-comment-add]").hasAttribute("disabled")).toBe(
      true,
    );
    expect(q(h.root, "[data-new-comment-hint]").textContent).toBe(
      "Select text or one object to comment on.",
    );
  });

  test("lists a thread on an object with its author and text, following the model", async () => {
    covers("panel:paged.comments");
    const h = await mount();
    await h.mutate(thread("t1", rectId(h), "Check the margin"));
    const card = q(h.root, '[data-thread="t1"]');
    expect(card.getAttribute("data-where")).toBe("item");
    expect(card.textContent).toContain("Ann Author");
    expect(card.textContent).toContain("Check the margin");
    expect(card.textContent).toContain("On an object");
    // Initials from the comment.
    expect(q(card, "[data-initials]").textContent).toBe("AA");
  });

  test("a reply, a resolve, the filter and a delete are engine mutations that the panel follows", async () => {
    covers("panel:paged.comments");
    const h = await mount();
    await h.mutate(thread("t1", rectId(h), "Check the margin"));
    const from = h.mark();

    await h.typeInto(q(h.root, "[data-reply-input]"), "Fixed");
    const sent = h.mutations(from);
    expect(sent.map((m) => (m as { op: string }).op)).toEqual(["replyComment"]);
    expect(
      (sent[0] as unknown as { args: { parentId: string } }).args.parentId,
    ).toBe("t1");
    expect(q(h.root, '[data-thread="t1"]').textContent).toContain("Fixed");

    await h.click(q(h.root, "[data-resolve]"));
    expect(q(h.root, '[data-thread="t1"]').getAttribute("data-resolved")).toBe(
      "true",
    );
    // The Open filter hides a resolved thread; Resolved shows it.
    await h.click(q(h.root, '[data-filter="open"]'));
    expect(h.root.querySelector('[data-thread="t1"]')).toBeNull();
    expect(h.root.querySelector("[data-no-match]")).not.toBeNull();
    await h.click(q(h.root, '[data-filter="resolved"]'));
    expect(h.root.querySelector('[data-thread="t1"]')).not.toBeNull();

    // Deleting the root takes the thread.
    await h.click(q(h.root, '[data-filter="all"]'));
    await h.click(
      q(h.root, '[data-thread="t1"] [data-comment="t1"] [data-delete]'),
    );
    expect(h.root.querySelector('[data-thread="t1"]')).toBeNull();
  });

  test("a new comment goes on the selected object", async () => {
    covers("panel:paged.comments");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(q(h.root, "[data-new-comment-input]"), "Looks off");
    await h.click(q(h.root, "[data-new-comment-add]"));
    const sent = h.mutations(from) as unknown as {
      op: string;
      args: {
        anchor: { kind: string; item: string };
        comment: { text: string };
      };
    }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.op).toBe("insertCommentThread");
    expect(sent[0]!.args.anchor).toEqual({
      kind: "item",
      item: rectId(h),
    });
    expect(sent[0]!.args.comment.text).toBe("Looks off");
    expect(h.root.querySelector('[data-where="item"]')).not.toBeNull();
  });

  test("a new comment goes on the selected text range", async () => {
    covers("panel:paged.comments");
    const h = await mount();
    await h.selectText(h.scene.storyId, 0, 4);
    const from = h.mark();
    await h.typeInto(q(h.root, "[data-new-comment-input]"), "Why this word?");
    await h.click(q(h.root, "[data-new-comment-add]"));
    const sent = h.mutations(from) as unknown as {
      op: string;
      args: { storyId: string; start: number; end: number };
    }[];
    expect(sent.map((m) => m.op)).toEqual(["insertComment"]);
    expect(sent[0]!.args).toMatchObject({
      storyId: h.scene.storyId,
      start: 0,
      end: 4,
    });
    expect(h.root.querySelector('[data-where="text"]')).not.toBeNull();
  });
});
