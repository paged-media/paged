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

// The slide show as the editor offers it (show/contribute.ts), UNIT,
// against a recording host: the presentation, the five palette commands
// and when each is offered, F5 / Shift+F5 / Alt+F5, the Slide Show menu
// and View ▸ Slide Sorter, what each command asks the host to present,
// and a host that cannot present.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type {
  BundleHost,
  VisibilityPredicate,
  CommandContribution,
  KeybindingContribution,
  MenuContribution,
  PresentationContribution,
  PresentRequest,
} from "@paged-media/plugin-api";

import {
  contributeShow,
  SHOW_CMD,
  SHOW_KEYBINDINGS,
  SHOW_MENU,
  SHOW_PRESENTATION,
  SORTER_VIEW,
} from "../src/show/contribute";
import type { Slide, SlidesStore } from "../src/slides-model";

function fakeStore(deck = true, active = 2) {
  const slides: Slide[] = [1, 2, 3].map((n) => ({
    pageId: `p${n}`,
    number: n,
    sizePt: [960, 540],
    state: n === 3 ? { hidden: true } : {},
  }));
  return {
    isDeck: () => deck,
    list: () => slides,
    activeSlide: () => slides[active - 1] ?? null,
    thumbnail: () => null,
    subscribe: () => () => {},
  } as unknown as SlidesStore;
}

function recordingHost(features: string[]) {
  const commands = new Map<string, CommandContribution>();
  const keys: KeybindingContribution[] = [];
  const menus: MenuContribution[] = [];
  const presentations: PresentationContribution[] = [];
  const presented: PresentRequest[] = [];
  const views: Array<string | null> = [];
  let activeView: string | null = null;
  let presenting: string | null = null;
  let caret: unknown = null;
  const host = {
    supports: (f: string) => features.includes(f),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    contribute: {
      command(c: CommandContribution) {
        commands.set(c.id, c);
        return { dispose: () => commands.delete(c.id) };
      },
      keybinding(c: KeybindingContribution) {
        keys.push(c);
        return { dispose: () => keys.splice(keys.indexOf(c), 1) };
      },
      menu(c: MenuContribution) {
        menus.push(c);
        return { dispose: () => menus.splice(menus.indexOf(c), 1) };
      },
      presentation(c: PresentationContribution) {
        presentations.push(c);
        return {
          dispose: () => presentations.splice(presentations.indexOf(c), 1),
        };
      },
    },
    text: { caret: () => caret },
    shell: {
      async present(r: PresentRequest) {
        presented.push(r);
        presenting = r.id;
        return { presented: true, target: r.target };
      },
      presentation: () => (presenting ? { id: presenting } : null),
      showView(id: string | null) {
        views.push(id);
        activeView = id;
        return true;
      },
      activeView: () => activeView,
    },
  } as unknown as BundleHost;
  return {
    host,
    commands,
    keys,
    menus,
    presentations,
    presented,
    views,
    setCaret: (c: unknown) => (caret = c),
    endShow: () => (presenting = null),
  };
}

const ALL = [
  "contribute.command@1",
  "contribute.keybinding@1",
  "contribute.presentation@1",
  "shell.present@1",
  "shell.views@1",
  "text.caret@1",
];

/** A `when` as the function the show registers. */
const when = (w: VisibilityPredicate | undefined): boolean =>
  typeof w === "function" ? w({}) : w === undefined;

const deps = (store: SlidesStore) => ({
  store,
  readReport: async () => null,
});

describe("the slide show's commands, keys and menus [plugin-slide.slide-show]", () => {
  it("registers the presentation, five commands, their keys and their menu entries", () => {
    covers(
      "keybinding:f5→media.paged.slide.command.slideShowFromBeginning",
      "keybinding:shift+f5→media.paged.slide.command.slideShowFromCurrent",
      "keybinding:alt+f5→media.paged.slide.command.presenterView",
    );
    const r = recordingHost(ALL);
    const sorter = { dispose() {} };
    const h = contributeShow(r.host, deps(fakeStore()), () => sorter);
    expect(r.presentations.map((p) => p.id)).toEqual([SHOW_PRESENTATION]);
    expect([...r.commands.keys()].sort()).toEqual(
      Object.values(SHOW_CMD).sort(),
    );
    expect(r.keys.map((k) => `${k.key}→${k.command}`)).toEqual(
      SHOW_KEYBINDINGS.map(([k, c]) => `${k}→${c}`),
    );
    expect(r.menus.map((m) => m.path)).toEqual(SHOW_MENU.map(([p]) => p));
    // Offered in a deck with no caret and no show running.
    for (const k of r.keys) expect(when(k.when)).toBe(true);
    r.setCaret({ storyId: "s", offset: 0 });
    for (const k of r.keys) expect(when(k.when)).toBe(false);
    h.dispose();
    expect(r.commands.size).toBe(0);
    expect(r.keys.length).toBe(0);
    expect(r.menus.length).toBe(0);
  });

  it("From Beginning presents on the screen from the first slide shown", async () => {
    covers("command:media.paged.slide.command.slideShowFromBeginning");
    const r = recordingHost(ALL);
    contributeShow(r.host, deps(fakeStore()), null);
    await r.commands.get(SHOW_CMD.fromBeginning)!.handler(undefined as never);
    expect(r.presented).toEqual([
      { id: SHOW_PRESENTATION, target: "screen", options: {} },
    ]);
    // While it runs, no second show is offered.
    expect(when(r.commands.get(SHOW_CMD.fromCurrent)!.when)).toBe(false);
  });

  it("From Current Slide starts at the active slide", async () => {
    covers("command:media.paged.slide.command.slideShowFromCurrent");
    const r = recordingHost(ALL);
    contributeShow(r.host, deps(fakeStore(true, 2)), null);
    await r.commands.get(SHOW_CMD.fromCurrent)!.handler(undefined as never);
    expect(r.presented[0]).toEqual({
      id: SHOW_PRESENTATION,
      target: "screen",
      options: { from: 1 },
    });
  });

  it("Presenter View asks for the secondary target with the presenter console", async () => {
    covers("command:media.paged.slide.command.presenterView");
    const r = recordingHost(ALL);
    contributeShow(r.host, deps(fakeStore(true, 1)), null);
    await r.commands.get(SHOW_CMD.presenterView)!.handler(undefined as never);
    expect(r.presented[0]).toEqual({
      id: SHOW_PRESENTATION,
      target: "secondary",
      options: { from: 0, presenter: true },
    });
  });

  it("Rehearse Timings runs a timed show", async () => {
    covers("command:media.paged.slide.command.rehearseTimings");
    const r = recordingHost(ALL);
    contributeShow(r.host, deps(fakeStore()), null);
    await r.commands.get(SHOW_CMD.rehearseTimings)!.handler(undefined as never);
    expect(r.presented[0].options).toEqual({ rehearse: true });
  });

  it("Slide Sorter toggles the sorter view in place of the canvas", async () => {
    covers("command:media.paged.slide.command.slideSorter");
    const r = recordingHost(ALL);
    contributeShow(r.host, deps(fakeStore()), () => ({ dispose() {} }));
    const sorter = r.commands.get(SHOW_CMD.slideSorter)!;
    expect(when(sorter.when)).toBe(true);
    await sorter.handler(undefined as never);
    await sorter.handler(undefined as never);
    expect(r.views).toEqual([SORTER_VIEW, null]);
  });

  it("outside a deck nothing is offered; a host that cannot present gets no show", async () => {
    const r = recordingHost(ALL);
    contributeShow(r.host, deps(fakeStore(false)), () => ({ dispose() {} }));
    for (const c of r.commands.values()) expect(when(c.when)).toBe(false);
    const run = contributeShow(
      recordingHost(["contribute.command@1"]).host,
      deps(fakeStore()),
      null,
    ).run;
    expect(await run(SHOW_CMD.fromBeginning)).toBe(false);
    expect(await run(SHOW_CMD.slideSorter)).toBe(false);
  });
});
