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

// Doc ADR 630 — the Story view's, Story Map's and overset commands over a
// fake host: the view toggles with the canvas, the map opens its panel, and
// Go to next overset story selects the overset story's last frame and
// brings its page into view.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  NEXT_OVERSET_COMMAND,
  STORY_MAP_COMMAND,
  STORY_MAP_PANEL_ID,
  STORY_VIEW_COMMAND,
  STORY_VIEW_ID,
  contributeStory,
} from "../src/story/contribute";

function fakeHost() {
  const commands = new Map<string, () => unknown>();
  const calls: unknown[][] = [];
  let view: string | null = null;
  const host = {
    supports: (f: string) =>
      [
        "shell.views@1",
        "viewport.pages@1",
        "document.readStory@1",
        "text.caret@1",
      ].includes(f),
    contribute: {
      view: () => ({ dispose() {} }),
      panel: () => ({ dispose() {} }),
      menu: () => ({ dispose() {} }),
      command: (c: { id: string; handler: () => unknown }) => {
        commands.set(c.id, c.handler);
        return { dispose() {} };
      },
    },
    shell: {
      showView: (id: string | null) => {
        view = id;
        calls.push(["showView", id]);
        return true;
      },
      activeView: () => view,
      openPanel: (id: string) => calls.push(["openPanel", id]),
    },
    text: { caret: () => ({ storyId: "s2", offset: 0 }) },
    selection: {
      set: async (ids: unknown[]) => {
        calls.push(["select", ids]);
        return ids;
      },
    },
    viewport: {
      goToPage: async (id: string) => {
        calls.push(["goToPage", id]);
        return true;
      },
    },
    document: {
      onDidChange: () => ({ dispose() {} }),
      storyContent: async () => ({ paragraphs: [{ runs: [{ text: "x" }] }] }),
      collection: async (name: string) =>
        name === "pages"
          ? [{ selfId: "p1" }, { selfId: "p2" }]
          : [
              { selfId: "s1", characterCount: 3, paragraphCount: 1 },
              {
                selfId: "s2",
                characterCount: 900,
                paragraphCount: 9,
                overset: true,
                oversetAt: { paragraph: 4, line: 0 },
              },
            ],
      frameChain: async (id: string) =>
        id === "s2"
          ? [
              { frameId: "f1", next: "f2", overflow: false },
              { frameId: "f2", next: null, overflow: true },
            ]
          : [],
      elementGeometry: async (ids: Array<{ id: string }>) =>
        ids.map((x) => ({ pageId: x.id === "f2" ? "p2" : "p1" })),
    },
  } as unknown as BundleHost;
  return { host, commands, calls };
}

describe("story commands", () => {
  it("Story view shows the view on the caret's story and gives the canvas back", async () => {
    covers("command:media.paged.doc.command.storyView");
    const { host, commands, calls } = fakeHost();
    contributeStory(host);
    await commands.get(STORY_VIEW_COMMAND)!();
    expect(calls).toEqual([["showView", STORY_VIEW_ID]]);
    await commands.get(STORY_VIEW_COMMAND)!();
    expect(calls[1]).toEqual(["showView", null]);
  });

  it("Story map opens its panel", async () => {
    covers("command:media.paged.doc.command.storyMap");
    const { host, commands, calls } = fakeHost();
    contributeStory(host);
    await commands.get(STORY_MAP_COMMAND)!();
    expect(calls).toEqual([["openPanel", STORY_MAP_PANEL_ID]]);
  });

  it("Go to next overset story selects its last frame and goes to its page", async () => {
    covers("command:media.paged.doc.command.nextOverset");
    const { host, commands, calls } = fakeHost();
    contributeStory(host);
    expect(await commands.get(NEXT_OVERSET_COMMAND)!()).toBe(true);
    expect(calls).toEqual([
      ["select", [{ kind: "textFrame", id: "f2" }]],
      ["goToPage", "p2"],
    ]);
  });
});
