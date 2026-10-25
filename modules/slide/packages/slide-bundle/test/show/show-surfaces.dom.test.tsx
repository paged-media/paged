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

// The slide show, the presenter view and the slide sorter, RENDERED
// (happy-dom) against the real engine with a deck open (slide ADR 716):
//
//   · the show surface follows PowerPoint's keys (next, a number and
//     Enter, black, Esc), says what is up in its data attributes, and goes
//     back to the slide it ended on;
//   · the presenter console drives the audience over the presentation's
//     channel, and a key in the audience window comes back to it;
//   · rehearsed timings land in the slides' transitions as one undo step;
//   · the sorter selects, hides, sets a transition, moves and opens slides,
//     each one undo step, on the document itself.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type {
  PresentationContext,
  PresentationRole,
} from "@paged-media/plugin-api";

import { SHOW_CMD, SORTER_VIEW } from "../../src/show/contribute";
import { parseState } from "../../src/slides-model";
import { drive, openDeck, settle, type DeckHarness } from "../panels/harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck();
}, 60_000);

afterEach(() => {
  cleanup();
  for (const el of document.querySelectorAll("[data-test-surface]"))
    el.remove();
  d.dispose();
});

/** Two ends of one channel, as the host's BroadcastChannel pair is. */
function channelPair() {
  const a = new Set<(m: unknown) => void>();
  const b = new Set<(m: unknown) => void>();
  const end = (mine: typeof a, theirs: typeof a) => ({
    post: (m: unknown) => {
      const copy = structuredClone(m);
      queueMicrotask(() => theirs.forEach((h) => h(copy)));
    },
    onMessage(h: (m: unknown) => void) {
      mine.add(h);
      return { dispose: () => void mine.delete(h) };
    },
  });
  return [end(a, b), end(b, a)] as const;
}

/** Run a show command through the bundle (as F5 does), then mount the
 *  presentation the host was asked for, in `role`. */
async function present(
  command: string,
  roles: PresentationRole[],
): Promise<{
  surfaces: HTMLElement[];
  exits: () => number;
  cleanup: () => void;
}> {
  await d.h.host.objects.invoke(command, {});
  const state = d.h.host.shell.presentation()!;
  const [show] = d.h.presentationsContributed();
  const pair = channelPair();
  let exits = 0;
  const offs: Array<() => void> = [];
  const surfaces = roles.map((role, i) => {
    const el = document.createElement("div");
    el.setAttribute("data-test-surface", role);
    el.tabIndex = -1;
    document.body.appendChild(el);
    const ctx: PresentationContext = {
      id: state.id,
      target: state.target,
      role,
      options: state.options,
      window,
      channel: pair[i],
      exit: () => void exits++,
    };
    const out = show.render(el, ctx);
    if (typeof out === "function") offs.push(out);
    return el;
  });
  await settle();
  return {
    surfaces,
    exits: () => exits,
    cleanup: () => offs.forEach((o) => o()),
  };
}

const key = (el: HTMLElement, k: string, mods: KeyboardEventInit = {}) =>
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods }),
    );
  });

const stage = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[data-show-stage]")!;

describe("the slide show surface [plugin-slide.slideshow]", () => {
  it("follows PowerPoint's keys and ends on the slide it showed last", async () => {
    covers("command:media.paged.slide.command.slideShowFromBeginning");
    const ids = await d.pageIds();
    const p = await present(SHOW_CMD.fromBeginning, ["show"]);
    const [el] = p.surfaces;
    expect(stage(el).dataset.slideNumber).toBe("1");
    await key(el, "n");
    expect(stage(el).dataset.slideNumber).toBe("2");
    await key(el, "ArrowLeft");
    expect(stage(el).dataset.slideNumber).toBe("1");
    for (const digit of String(ids.length)) await key(el, digit);
    expect(el.querySelector("[data-show-typed]")!.textContent).toBe(
      String(ids.length),
    );
    await key(el, "Enter");
    expect(stage(el).dataset.slideNumber).toBe(String(ids.length));
    await key(el, "b");
    expect(stage(el).dataset.blank).toBe("black");
    await key(el, "b");
    await key(el, "g");
    expect(el.querySelectorAll("[data-show-grid-cell]").length).toBe(
      ids.length,
    );
    await key(el, "g");
    await key(el, "Escape");
    expect(p.exits()).toBe(1);
    d.wentTo.length = 0;
    p.cleanup();
    expect(d.wentTo).toEqual([ids[ids.length - 1]]);
  });

  it("From Current Slide starts on the active slide", async () => {
    covers("command:media.paged.slide.command.slideShowFromCurrent");
    const ids = await d.pageIds();
    d.setActivePage(ids[1]);
    await settle();
    const p = await present(SHOW_CMD.fromCurrent, ["show"]);
    expect(stage(p.surfaces[0]).dataset.pageId).toBe(ids[1]);
    p.cleanup();
  });
});

describe("the presenter view [plugin-slide.slideshow]", () => {
  it("drives the audience window over the channel, and takes its keys", async () => {
    covers("command:media.paged.slide.command.presenterView");
    const ids = await d.pageIds();
    const p = await present(SHOW_CMD.presenterView, ["console", "audience"]);
    const [consoleEl, audienceEl] = p.surfaces;
    expect(d.h.host.shell.presentation()?.target).toBe("secondary");
    // The audience asked for the state and got the first slide.
    await waitFor(() =>
      expect(stage(audienceEl).dataset.slideNumber).toBe("1"),
    );
    expect(
      consoleEl.querySelector('[data-presenter="position"]')!.textContent,
    ).toMatch(/1/);
    expect(
      consoleEl.querySelector<HTMLElement>('[data-presenter="next-preview"]')!
        .dataset.pageId,
    ).toBe(ids[1]);
    // Next in the console advances the audience.
    await act(async () => {
      fireEvent.click(consoleEl.querySelector('[data-presenter="next"]')!);
    });
    await waitFor(() =>
      expect(stage(audienceEl).dataset.slideNumber).toBe("2"),
    );
    // A key pressed in the audience window comes back to the console.
    await key(audienceEl, "p");
    await waitFor(() =>
      expect(
        consoleEl.querySelector<HTMLElement>("[data-presenter-view]")!.dataset
          .slideIndex,
      ).toBe("0"),
    );
    await waitFor(() =>
      expect(stage(audienceEl).dataset.slideNumber).toBe("1"),
    );
    // Black screen from the console blanks the audience.
    await act(async () => {
      fireEvent.click(consoleEl.querySelector('[data-presenter="black"]')!);
    });
    await waitFor(() => expect(stage(audienceEl).dataset.blank).toBe("black"));
    // Notes zoom, the timer pauses.
    const notes = consoleEl.querySelector<HTMLElement>(
      '[data-presenter="notes"]',
    )!;
    const before = notes.style.fontSize;
    fireEvent.click(
      consoleEl.querySelector('[data-presenter="notes-larger"]')!,
    );
    expect(notes.style.fontSize).not.toBe(before);
    fireEvent.click(consoleEl.querySelector('[data-presenter="pause"]')!);
    expect(
      consoleEl.querySelector('[data-presenter="pause"]')!.textContent,
    ).toBe("▶");
    fireEvent.click(consoleEl.querySelector('[data-presenter="end"]')!);
    expect(p.exits()).toBe(1);
    p.cleanup();
  });
});

describe("rehearse timings [plugin-slide.slideshow]", () => {
  it("records the time on each slide into its transition, one undo step", async () => {
    covers("command:media.paged.slide.command.rehearseTimings");
    const ids = await d.pageIds();
    const p = await present(SHOW_CMD.rehearseTimings, ["show"]);
    const [el] = p.surfaces;
    expect(el.querySelector("[data-show-typed]")!.textContent).toMatch(/0:0/);
    await new Promise((r) => setTimeout(r, 30));
    await key(el, "n");
    await key(el, "Escape");
    await drive(() => p.cleanup());
    await waitFor(async () => {
      const pages = await d.h.host.document.collection<{
        selfId: string;
        pluginMetadata?: { key: string; value: string }[];
      }>("pages");
      const first = parseState(
        pages.find((x) => x.selfId === ids[0])?.pluginMetadata,
      );
      expect(typeof first.transition?.advanceAfterMs).toBe("number");
      expect(first.transition?.advanceOnClick).toBe(true);
    });
    // One undo takes every timing back.
    await drive(() => d.h.host.document.undo());
    const pages = await d.h.host.document.collection<{
      selfId: string;
      pluginMetadata?: { key: string; value: string }[];
    }>("pages");
    for (const page of pages)
      expect(parseState(page.pluginMetadata).transition?.advanceAfterMs).toBe(
        undefined,
      );
  });
});

/** The sorter, mounted; `closed` counts its close calls. */
async function sorter() {
  const view = d.h.viewsContributed().find((v) => v.id === SORTER_VIEW)!;
  let closed = 0;
  const Render = view.render;
  const r = render(<Render id={view.id} close={() => void closed++} />);
  await waitFor(() =>
    expect(
      r.container.querySelector('[data-slide-sorter="ready"]'),
    ).not.toBeNull(),
  );
  await settle();
  return { r, closed: () => closed };
}

const states = async () =>
  (
    await d.h.host.document.collection<{
      selfId: string;
      pluginMetadata?: { key: string; value: string }[];
    }>("pages")
  ).map((p) => ({ id: p.selfId, state: parseState(p.pluginMetadata) }));

describe("the slide sorter [plugin-slide.slide-sorter]", () => {
  it("is shown by its command in place of the canvas", async () => {
    covers("command:media.paged.slide.command.slideSorter");
    await d.h.host.objects.invoke(SHOW_CMD.slideSorter, {});
    expect(d.h.host.shell.activeView()).toBe(SORTER_VIEW);
    await d.h.host.objects.invoke(SHOW_CMD.slideSorter, {});
    expect(d.h.host.shell.activeView()).toBeNull();
  });

  it("selects, hides and sets a transition on the selection, one undo step each", async () => {
    const ids = await d.pageIds();
    const { r } = await sorter();
    const cell = (i: number) =>
      r.container.querySelector<HTMLElement>(
        `[data-sorter-slide="${ids[i]}"]`,
      )!;
    fireEvent.click(cell(0));
    fireEvent.click(cell(1), { shiftKey: true });
    expect(cell(0).getAttribute("aria-selected")).toBe("true");
    expect(cell(1).getAttribute("aria-selected")).toBe("true");
    await drive(() =>
      fireEvent.click(r.container.querySelector('[data-sorter="hide"]')!),
    );
    let now = await states();
    expect(now[0].state.hidden).toBe(true);
    expect(now[1].state.hidden).toBe(true);
    await waitFor(() =>
      expect(r.container.querySelectorAll("[data-sorter-hidden]").length).toBe(
        2,
      ),
    );
    await drive(() => d.h.host.document.undo());
    now = await states();
    expect(now[0].state.hidden).toBeUndefined();

    await drive(() =>
      fireEvent.change(
        r.container.querySelector<HTMLSelectElement>(
          '[data-sorter="transition"]',
        )!,
        { target: { value: "push" } },
      ),
    );
    now = await states();
    expect(now[0].state.transition?.kind).toBe("push");
    expect(now[1].state.transition?.kind).toBe("push");
    expect(now[0].state.transition?.xml).toBeUndefined();
  });

  it("Cmd+click toggles one slide; a drop moves the selection; a double-click opens a slide", async () => {
    const ids = await d.pageIds();
    const { r, closed } = await sorter();
    const cell = (id: string) =>
      r.container.querySelector<HTMLElement>(`[data-sorter-slide="${id}"]`)!;
    fireEvent.click(cell(ids[0]));
    fireEvent.click(cell(ids[2]), { metaKey: true });
    fireEvent.click(cell(ids[0]), { metaKey: true });
    expect(cell(ids[0]).getAttribute("aria-selected")).toBe("false");
    expect(cell(ids[2]).getAttribute("aria-selected")).toBe("true");
    // Drag the third slide in front of the first.
    const dt = { effectAllowed: "", setData() {}, getData: () => "" };
    fireEvent.dragStart(cell(ids[2]), { dataTransfer: dt });
    await settle();
    fireEvent.dragOver(cell(ids[0]), { dataTransfer: dt });
    await drive(() => fireEvent.drop(cell(ids[0]), { dataTransfer: dt }));
    expect((await d.pageIds()).slice(0, 3)).toEqual([ids[2], ids[0], ids[1]]);
    await drive(() => d.h.host.document.undo());
    expect(await d.pageIds()).toEqual(ids);
    d.wentTo.length = 0;
    fireEvent.doubleClick(cell(ids[1]));
    expect(d.wentTo).toEqual([ids[1]]);
    expect(closed()).toBe(1);
  });
});
