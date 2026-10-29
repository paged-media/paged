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

// Doc ADR 613 — the Review panel, a margin balloon and the Track Changes
// status item, RENDERED (happy-dom) over a recording host: they read the
// review store and each button is the review command's one mutation.

import { afterEach, describe, expect, it } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type { BundleHost } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { createReviewStore } from "../../src/word/review-model";
import {
  makeBalloon,
  makeReviewPanel,
  makeTrackStatus,
  reviewCommands,
} from "../../src/word/review";

afterEach(() => cleanup());

function setup(props: Record<string, unknown>) {
  const mutations: Array<{ op: string; args: unknown }> = [];
  const host = {
    supports: () => true,
    log: { warn() {} },
    text: { selection: () => null, characterRange: async () => null },
    viewport: { revealText: async () => true },
    shell: { openPanel() {} },
    objects: {
      get: async (_a: string, path: string) =>
        path in props
          ? { kind: "value", value: props[path] }
          : { kind: "missing" },
    },
    document: {
      collection: async (name: string) =>
        name === "trackedChanges"
          ? [
              {
                storyId: "s1",
                offset: 0,
                end: 3,
                id: "7",
                kind: "delete",
                userName: "Author B",
                text: "old",
              },
            ]
          : name === "comments"
            ? [
                {
                  id: "0",
                  storyId: "s1",
                  start: 4,
                  end: 8,
                  text: "Check",
                  author: "Author C",
                },
              ]
            : [],
      storyContent: async () => ({
        selfId: "s1",
        paragraphs: [{ runs: [{ text: "old text" }] }],
      }),
      mutate: async (m: { op: string; args: unknown }) => {
        mutations.push(m);
        return { applied: true };
      },
    },
  } as unknown as BundleHost;
  const store = createReviewStore(host);
  const commands = reviewCommands(host, store, {
    docStories: async () => ["s1"],
    now: () => "2026-10-29T12:00:00Z",
  });
  return { store, commands, mutations };
}

describe("the Review panel", () => {
  it("lists the changes and threads and runs the commands", async () => {
    covers("panel:media.paged.doc.panel.review");
    const { store, commands, mutations } = setup({
      documentTrackChanges: false,
      documentMarkupView: "all",
    });
    const Panel = makeReviewPanel(store, commands);
    const view = render(<Panel />);
    await act(async () => {
      await store.refresh();
    });
    expect(
      view.container.querySelector('[data-review-change="7"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-review-thread="0"]'),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        view.container.querySelector("[data-review-accept-all]")!,
      );
    });
    await act(async () => {
      fireEvent.click(
        view.container.querySelector('[data-review-reject="7"]')!,
      );
    });
    await act(async () => {
      fireEvent.change(view.container.querySelector("[data-review-view]")!, {
        target: { value: "none" },
      });
    });
    await act(async () => {
      fireEvent.click(
        view.container.querySelector('[data-review-resolve="0"]')!,
      );
    });
    expect(mutations.map((m) => m.op)).toEqual([
      "acceptChange",
      "rejectChange",
      "set",
      "resolveComment",
    ]);
    expect(mutations[2]!.args).toEqual({
      address: "doc",
      path: "documentMarkupView",
      value: "none",
    });
  });

  it("the status item says whether changes are tracked and toggles", async () => {
    const { store, commands, mutations } = setup({
      documentTrackChanges: true,
    });
    const Status = makeTrackStatus(store, commands);
    const view = render(<Status editContext="wordDocument" />);
    await act(async () => {
      await store.refresh();
    });
    const button = view.container.querySelector(
      '[data-word-status="trackChanges"]',
    )!;
    expect(button.getAttribute("data-tracking")).toBe("on");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(mutations[0]!.op).toBe("set");
  });

  it("a comment balloon replies on Enter", async () => {
    const { store, commands, mutations } = setup({});
    await store.refresh();
    const Balloon = makeBalloon(store, commands);
    const view = render(
      <Balloon
        editContext="wordDocument"
        active={false}
        item={{ id: "comment:0", anchor: { storyId: "s1", start: 4, end: 8 } }}
      />,
    );
    const input = view.container.querySelector(
      '[data-review-reply-input="0"]',
    )!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Agreed" } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(mutations[0]).toMatchObject({
      op: "replyComment",
      args: { parentId: "0", comment: { text: "Agreed", id: "1" } },
    });
  });
});
