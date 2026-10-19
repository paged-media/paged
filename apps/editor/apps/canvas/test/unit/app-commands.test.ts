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

// The canvas app's own command set (app-commands.ts): each command routes
// to exactly the handler the app binds for it, through the registry, and
// the View toggles flip the module-scope store their overlays read.

import { afterEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";
import {
  createCommandRegistry,
  getViewToggle,
  resetViewToggles,
} from "@paged-media/shell";

import {
  buildAppCommands,
  type AppCommandHandlers,
} from "../../src/app-commands";

type HandlerName = keyof AppCommandHandlers;

function harness() {
  const calls: HandlerName[] = [];
  const handlers = Object.fromEntries(
    (
      [
        "undo",
        "redo",
        "openPdf",
        "saveAsIdml",
        "savePaged",
        "zoomIn",
        "zoomOut",
        "zoom100",
        "zoomFit",
      ] as const
    ).map((name) => [name, () => void calls.push(name)]),
  ) as unknown as AppCommandHandlers;
  const registry = createCommandRegistry(() => ({}));
  for (const c of buildAppCommands(handlers)) registry.register(c);
  return { calls, registry };
}

afterEach(() => {
  resetViewToggles();
  unstubAllGlobals();
});

describe("app commands route to their handler, once", () => {
  const routes: Array<[string, HandlerName]> = [
    ["paged.editor.undo", "undo"],
    ["paged.editor.redo", "redo"],
    ["paged.file.openPdf", "openPdf"],
    ["paged.file.saveAsIdml", "saveAsIdml"],
    ["paged.file.savePaged", "savePaged"],
    ["paged.view.zoomIn", "zoomIn"],
    ["paged.view.zoomOut", "zoomOut"],
    ["paged.view.zoom100", "zoom100"],
    ["paged.view.zoomFit", "zoomFit"],
  ];

  test("each id invokes its own handler and no other", async () => {
    covers(
      "command:paged.editor.undo",
      "command:paged.editor.redo",
      "command:paged.file.openPdf",
      "command:paged.file.saveAsIdml",
      "command:paged.file.savePaged",
      "command:paged.view.zoomIn",
      "command:paged.view.zoomOut",
      "command:paged.view.zoom100",
      "command:paged.view.zoomFit",
    );
    for (const [id, handler] of routes) {
      const { calls, registry } = harness();
      await registry.invoke(id);
      expect({ id, calls }).toEqual({ id, calls: [handler] });
    }
  });

  test("none of them is gated: they run with no document state at all", async () => {
    const { calls, registry } = harness();
    for (const [id] of routes) {
      expect(registry.get(id)?.when).toBeUndefined();
      await registry.invoke(id);
    }
    expect(calls).toHaveLength(routes.length);
  });
});

describe("View toggles flip the store their overlay reads", () => {
  test("text threads, snap to points, heading anchors: each id flips its own flag", async () => {
    covers(
      "command:paged.view.toggleTextThreads",
      "command:paged.view.toggleSnapToPoints",
      "command:paged.view.toggleHeadingAnchors",
    );
    const { registry } = harness();
    const flags = () => ({
      textThreads: getViewToggle("textThreads"),
      snapToPoints: getViewToggle("snapToPoints"),
      headingAnchors: getViewToggle("headingAnchors"),
    });
    const defaults = {
      textThreads: false,
      snapToPoints: true,
      headingAnchors: false,
    };
    expect(flags()).toEqual(defaults);
    await registry.invoke("paged.view.toggleTextThreads");
    expect(flags()).toEqual({ ...defaults, textThreads: true });
    await registry.invoke("paged.view.toggleSnapToPoints");
    expect(flags()).toEqual({
      ...defaults,
      textThreads: true,
      snapToPoints: false,
    });
    await registry.invoke("paged.view.toggleHeadingAnchors");
    expect(flags()).toEqual({
      textThreads: true,
      snapToPoints: false,
      headingAnchors: true,
    });
    // A second press puts each back.
    await registry.invoke("paged.view.toggleTextThreads");
    await registry.invoke("paged.view.toggleSnapToPoints");
    await registry.invoke("paged.view.toggleHeadingAnchors");
    expect(flags()).toEqual(defaults);
  });
});

describe("Help opens the documentation in a new, unlinked tab", () => {
  const openedBy = async (id: string) => {
    const opened: unknown[][] = [];
    stubGlobal("window", {
      open: (...args: unknown[]) => void opened.push(args),
    });
    const { registry, calls } = harness();
    await registry.invoke(id);
    expect(calls).toEqual([]);
    return opened;
  };

  test("Documentation and IDML reference open their sites with noopener", async () => {
    covers("command:paged.help.docs", "command:paged.help.idmlReference");
    expect(await openedBy("paged.help.docs")).toEqual([
      ["https://docs.paged.media/", "_blank", "noopener,noreferrer"],
    ]);
    expect(await openedBy("paged.help.idmlReference")).toEqual([
      ["https://idml.paged.media/", "_blank", "noopener,noreferrer"],
    ]);
  });

  test("Report an issue opens a new-issue form in a new tab", async () => {
    covers("command:paged.help.reportIssue");
    const opened = await openedBy("paged.help.reportIssue");
    expect(opened).toHaveLength(1);
    expect(opened[0][0]).toMatch(
      /^https:\/\/github\.com\/paged-media\/.+\/issues\/new$/,
    );
    expect(opened[0].slice(1)).toEqual(["_blank", "noopener,noreferrer"]);
  });

  // Finding SH-1: the product's code moved into the paged-media/paged
  // monorepo; the pre-monorepo editor repository is frozen ("moved"
  // README, archive pending), so an issue filed there reaches nobody.
  test.failing(
    "SH-1: Report an issue files into the monorepo's tracker",
    async () => {
      covers("command:paged.help.reportIssue");
      expect(await openedBy("paged.help.reportIssue")).toEqual([
        [
          "https://github.com/paged-media/paged/issues/new",
          "_blank",
          "noopener,noreferrer",
        ],
      ]);
    },
  );
});
