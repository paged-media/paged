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

// The palette commands and menu entries (commands.ts, menu.ts), UNIT,
// against a recording host and a stand-in for the slides store: each
// command's `when` (offered only where it applies), what its handler asks
// of the host, and that a bare invoke that cannot act logs and returns
// instead of throwing. The typed commands they run are the object model's
// suites (commands-unit, headless/object-model); the real menu bar is
// apps/canvas/tests/plugin-surface/menus-slide.spec.ts.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type {
  BundleHost,
  CommandContribution,
  MenuContribution,
  MutationInput,
} from "@paged-media/plugin-api";

import { activate } from "../src/activate";
import {
  CMD,
  COMMAND_PREFIX,
  PPTX_ACCEPT,
  contributeSlideCommands,
} from "../src/commands";
import { contributeMenu, MENU_ENTRIES } from "../src/menu";
import {
  DUPLICATE_SLIDE_COMMAND,
  NEW_SLIDE_COMMAND,
} from "../src/object-model";
import type { Slide, SlidesStore } from "../src/slides-model";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as { contributes: { commands: string[] } };

/** A deck of `n` slides with slide `active` (1-based, 0 = none) active. */
function fakeStore(deck: boolean, n: number, active: number) {
  const slides: Slide[] = Array.from({ length: n }, (_, i) => ({
    pageId: `p${i + 1}`,
    number: i + 1,
    sizePt: [960, 540],
    state: {},
  }));
  const state = { deck, slides, active };
  const store = {
    isDeck: () => state.deck,
    list: () => state.slides,
    activeSlide: () => state.slides[state.active - 1] ?? null,
  } as unknown as SlidesStore;
  return { store, state };
}

function recordingHost(
  features: readonly string[],
  pageIds: () => readonly string[] = () => [],
) {
  const commands = new Map<string, CommandContribution>();
  const menus: MenuContribution[] = [];
  const logs: string[] = [];
  const mutations: MutationInput[] = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const visited: string[] = [];
  const picks: unknown[] = [];
  const saves: Array<{ suggestedName: string; length: number }> = [];
  let picked: Array<{ name: string; bytes: Uint8Array; mimeType: string }> = [];
  const host = {
    supports: (f: string) => features.includes(f),
    log: {
      debug() {},
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    contribute: {
      command(c: CommandContribution) {
        commands.set(c.id, c);
        return { dispose: () => commands.delete(c.id) };
      },
      menu(c: MenuContribution) {
        menus.push(c);
        return { dispose: () => menus.splice(menus.indexOf(c), 1) };
      },
    },
    document: {
      collection: async () => pageIds().map((selfId) => ({ selfId })),
      async mutate(m: MutationInput) {
        mutations.push(m);
        return { applied: true };
      },
    },
    objects: {
      async invoke(command: string, args: unknown) {
        invoked.push({ command, args });
        return { slide: "plugin:media.paged.slide/slide/made" };
      },
    },
    viewport: {
      async goToPage(id: string) {
        visited.push(id);
        return true;
      },
    },
    shell: {
      async pickFile(options: unknown) {
        picks.push(options);
        return picked;
      },
      async saveFile(o: { suggestedName: string; bytes: Uint8Array }) {
        saves.push({ suggestedName: o.suggestedName, length: o.bytes.length });
        return true;
      },
    },
  } as unknown as BundleHost;
  return {
    host,
    commands,
    menus,
    logs,
    mutations,
    invoked,
    visited,
    picks,
    saves,
    pick(files: typeof picked) {
      picked = files;
    },
  };
}

const ALL = [
  "contribute.command@1",
  "storage.parts@1",
  "viewport.pages@1",
  "objects@1",
  "shell.pickFile@1",
  "shell.saveFile@1",
];

function setup(
  opts: {
    deck?: boolean;
    slides?: number;
    active?: number;
    features?: readonly string[];
    withStore?: boolean;
    exportDeck?: () => Promise<{
      bytes: Uint8Array;
      fileName: string;
      diagnostics: string[];
    } | null>;
  } = {},
) {
  const { store, state } = fakeStore(
    opts.deck ?? true,
    opts.slides ?? 3,
    opts.active ?? 1,
  );
  const r = recordingHost(opts.features ?? ALL, () =>
    state.slides.map((s) => s.pageId),
  );
  const opened: string[] = [];
  const handle = contributeSlideCommands(r.host, {
    store: opts.withStore === false ? null : store,
    objectModel: true,
    async openDeck(name) {
      opened.push(name);
      return null;
    },
    exportDeck:
      opts.exportDeck ??
      (async () => ({
        bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
        fileName: "Pitch.pptx",
        diagnostics: [],
      })),
  });
  const menu = contributeMenu(r.host, (id) => handle.ids.has(id));
  const when = (id: string) => {
    const c = r.commands.get(id)!;
    return typeof c.when === "function" ? c.when(null) : true;
  };
  const run = (id: string) => r.commands.get(id)!.handler(null);
  return { ...r, state, opened, handle, menu, when, run };
}

describe("paged.slide palette commands", () => {
  it("registers every command the manifest declares, with a menu entry each", () => {
    const s = setup();
    expect([...s.commands.keys()].sort()).toEqual(
      [...MANIFEST.contributes.commands].sort(),
    );
    expect(s.menus.map((m) => m.command).sort()).toEqual(
      [...MANIFEST.contributes.commands].sort(),
    );
    // The file verbs in the host's File menu, the slide verbs in Slide.
    expect(s.menus.map((m) => m.path)).toEqual(MENU_ENTRIES.map(([p]) => p));
    for (const [path] of MENU_ENTRIES)
      expect(["File", "Slide"]).toContain(path.split("/")[0]);
    s.menu.dispose();
    s.handle.dispose();
    expect(s.menus).toEqual([]);
    expect(s.commands.size).toBe(0);
  });

  it("offers the slide verbs only on a deck with a slide active", () => {
    const s = setup({ slides: 3, active: 2 });
    for (const id of [
      CMD.newSlide,
      CMD.duplicateSlide,
      CMD.deleteSlide,
      CMD.moveSlideUp,
      CMD.moveSlideDown,
      CMD.exportPptx,
      CMD.importPptx,
    ])
      expect(s.when(id), id).toBe(true);

    // The first slide has no slide above it; the last none below.
    s.state.active = 1;
    expect(s.when(CMD.moveSlideUp)).toBe(false);
    expect(s.when(CMD.moveSlideDown)).toBe(true);
    s.state.active = 3;
    expect(s.when(CMD.moveSlideUp)).toBe(true);
    expect(s.when(CMD.moveSlideDown)).toBe(false);

    // No active slide: nothing to act on.
    s.state.active = 0;
    for (const id of [
      CMD.newSlide,
      CMD.duplicateSlide,
      CMD.deleteSlide,
      CMD.moveSlideUp,
      CMD.moveSlideDown,
    ])
      expect(s.when(id), id).toBe(false);

    // The last slide cannot be deleted.
    s.state.active = 1;
    s.state.slides = s.state.slides.slice(0, 1);
    expect(s.when(CMD.deleteSlide)).toBe(false);
    expect(s.when(CMD.newSlide)).toBe(true);

    // Not a deck: only Open is offered.
    s.state.deck = false;
    for (const id of Object.values(CMD))
      expect(s.when(id), id).toBe(id === CMD.importPptx);
  });

  it("New slide and Duplicate slide run the typed commands on the active slide and go to the new one", async () => {
    covers("command:media.paged.slide.command.newSlide");
    covers("command:media.paged.slide.command.duplicateSlide");
    const s = setup({ active: 2 });
    await s.run(CMD.newSlide);
    await s.run(CMD.duplicateSlide);
    expect(s.invoked).toEqual([
      { command: NEW_SLIDE_COMMAND, args: { after: "p2" } },
      { command: DUPLICATE_SLIDE_COMMAND, args: { slide: "p2" } },
    ]);
    expect(s.visited).toEqual(["made", "made"]);
  });

  it("Delete slide deletes the active slide, one mutation", async () => {
    covers("command:media.paged.slide.command.deleteSlide");
    const s = setup({ active: 3 });
    await s.run(CMD.deleteSlide);
    expect(s.mutations).toEqual([{ op: "deletePage", args: { pageId: "p3" } }]);
  });

  it("Move slide up / down move the active slide past its neighbour and follow it", async () => {
    covers("command:media.paged.slide.command.moveSlideUp");
    covers("command:media.paged.slide.command.moveSlideDown");
    const s = setup({ slides: 3, active: 2 });
    await s.run(CMD.moveSlideUp);
    await s.run(CMD.moveSlideDown);
    expect(s.mutations).toEqual([
      { op: "movePage", args: { page: "p2", after: null } },
      { op: "movePage", args: { page: "p2", after: "p3" } },
    ]);
    expect(s.visited).toEqual(["p2", "p2"]);
  });

  it("Open PowerPoint deck asks for a deck and opens the chosen one; a cancel does nothing", async () => {
    covers("command:media.paged.slide.command.importPptx");
    const s = setup({ deck: false });
    await s.run(CMD.importPptx);
    expect(s.picks).toEqual([{ accept: PPTX_ACCEPT, multiple: false }]);
    expect(s.opened).toEqual([]);
    s.pick([{ name: "Pitch.pptx", bytes: new Uint8Array(4), mimeType: "" }]);
    await s.run(CMD.importPptx);
    expect(s.opened).toEqual(["Pitch.pptx"]);
  });

  it("Export PowerPoint deck hands the written deck to the host's saver", async () => {
    covers("command:media.paged.slide.command.exportPptx");
    const s = setup();
    await s.run(CMD.exportPptx);
    expect(s.saves).toEqual([{ suggestedName: "Pitch.pptx", length: 4 }]);
    // No deck to write: nothing is saved (exportDeck said why).
    const none = setup({ exportDeck: async () => null });
    await none.run(CMD.exportPptx);
    expect(none.saves).toEqual([]);
  });

  it("a bare invoke that cannot act logs why and returns, never throws", async () => {
    // Not a deck, no slide: each slide verb logs and changes nothing.
    const s = setup({ deck: false });
    for (const id of [
      CMD.newSlide,
      CMD.duplicateSlide,
      CMD.deleteSlide,
      CMD.moveSlideUp,
      CMD.moveSlideDown,
    ])
      await s.run(id);
    expect(s.mutations).toEqual([]);
    expect(s.invoked).toEqual([]);
    expect(s.logs.filter((l) => l.includes("not a slide deck")).length).toBe(5);

    // The last slide is not deleted; the first does not move up.
    const one = setup({ slides: 1, active: 1 });
    await one.run(CMD.deleteSlide);
    await one.run(CMD.moveSlideUp);
    await one.run(CMD.moveSlideDown);
    expect(one.mutations).toEqual([]);
    expect(one.logs.some((l) => l.includes("last slide"))).toBe(true);

    // A typed command that refuses, a host without picker or saver.
    const refusing = setup();
    (refusing.host.objects as { invoke: unknown }).invoke = async () => {
      throw new Error("failed: the new slide could not be made");
    };
    await refusing.run(CMD.newSlide);
    expect(refusing.logs.some((l) => l.includes("could not be made"))).toBe(
      true,
    );
    const bare = setup({
      features: ["contribute.command@1", "storage.parts@1", "viewport.pages@1"],
    });
    await bare.run(CMD.importPptx);
    await bare.run(CMD.exportPptx);
    await bare.run(CMD.newSlide);
    expect(bare.picks).toEqual([]);
    expect(bare.saves).toEqual([]);
    expect(bare.invoked).toEqual([]);
    expect(bare.logs.filter((l) => /has no/.test(l)).length).toBe(3);
  });

  it("without the page doors only the file verbs are contributed", () => {
    const s = setup({ withStore: false });
    expect([...s.commands.keys()].sort()).toEqual(
      [CMD.exportPptx, CMD.importPptx].sort(),
    );
    expect(s.menus.map((m) => m.command).sort()).toEqual(
      [CMD.exportPptx, CMD.importPptx].sort(),
    );
    expect(
      MENU_ENTRIES.every(([, suffix]) =>
        MANIFEST.contributes.commands.includes(`${COMMAND_PREFIX}.${suffix}`),
      ),
    ).toBe(true);
  });

  it("activate registers them on a host with the command door", () => {
    const r = recordingHost([...ALL]);
    const h = activate({
      ...r.host,
      document: {
        ...r.host.document,
        collection: async () => [],
        onDidChange: () => ({ dispose() {} }),
        onDidOpen: () => ({ dispose() {} }),
      },
      viewport: {
        ...r.host.viewport,
        activePage: () => null,
        onDidChangeActivePage: () => ({ dispose() {} }),
      },
      parts: { read: async () => null },
    } as unknown as BundleHost);
    expect(r.commands.size).toBe(MANIFEST.contributes.commands.length);
    expect(r.menus.length).toBe(MENU_ENTRIES.length);
    h.dispose();
    expect(r.commands.size).toBe(0);
    expect(r.menus.length).toBe(0);
  });
});
