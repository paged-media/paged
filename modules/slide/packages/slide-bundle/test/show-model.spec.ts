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

// The slide show's state machine and controller (slide ADR 716), UNIT:
// PowerPoint's keys, hidden slides skipped, a number and Enter, black and
// white screens, Home/End, the grid, the end screen and the loop; the
// controller's automatic advance from the slides' timings, its ink, and
// the rehearsal's timings written back as one undo step.

import { describe, expect, it } from "bun:test";

import {
  current,
  keyAction,
  position,
  reduce,
  startShow,
  upNext,
  type ShowAction,
  type ShowSlide,
  type ShowState,
} from "../src/show/show-model";
import { ShowController, clock } from "../src/show/slide-show";
import {
  SHOW_CMD,
  showSlides,
  showTypedCommands,
  timingsMutation,
} from "../src/show/contribute";
import {
  transitionDurationMs,
  transitionKind,
  transitionParams,
  registerTransitionRenderer,
  transitionRendererFactory,
} from "../src/show/transition-renderer";
import { letterbox } from "../src/show/compositor";
import { frameScale } from "../src/show/frames";
import type { Slide } from "../src/slides-model";

const slide = (n: number, over: Partial<ShowSlide> = {}): ShowSlide => ({
  pageId: `p${n}`,
  number: n,
  hidden: false,
  advanceAfterMs: null,
  transition: null,
  notes: `notes ${n}`,
  sizePt: [960, 540],
  ...over,
});

/** Five slides, the third hidden. */
const deck = () => [
  slide(1),
  slide(2),
  slide(3, { hidden: true }),
  slide(4),
  slide(5),
];

const press = (
  s: ShowState,
  key: string,
  mods: Partial<KeyboardEvent> = {},
) => {
  const a = keyAction({ key, ...mods }, s);
  return a ? reduce(s, a) : s;
};
const keys = (s: ShowState, ...ks: string[]): ShowState =>
  ks.reduce((acc, k) => press(acc, k), s);
const at = (s: ShowState) => current(s)?.number ?? "end";

describe("the show's keys (slide ADR 716) [plugin-slide.slide-show]", () => {
  it("advances with N, →, ↓, Space, Enter and Page Down, skipping hidden slides", () => {
    for (const key of [
      "n",
      "N",
      "ArrowRight",
      "ArrowDown",
      " ",
      "Enter",
      "PageDown",
    ]) {
      let s = startShow(deck());
      s = press(s, key);
      expect(at(s)).toBe(2);
      s = press(s, key);
      expect(at(s)).toBe(4); // slide 3 is hidden
    }
  });

  it("goes back with P, ←, ↑, Backspace and Page Up, skipping hidden slides", () => {
    for (const key of ["p", "ArrowLeft", "ArrowUp", "Backspace", "PageUp"]) {
      let s = startShow(deck(), { from: 3 });
      expect(at(s)).toBe(4);
      s = press(s, key);
      expect(at(s)).toBe(2);
      s = press(s, key);
      s = press(s, key);
      expect(at(s)).toBe(1); // stays on the first
    }
  });

  it("jumps to a number with Enter, a hidden slide too", () => {
    let s = startShow(deck());
    s = keys(s, "3");
    expect(s.typed).toBe("3");
    s = press(s, "Enter");
    expect(at(s)).toBe(3);
    expect(s.typed).toBe("");
    s = keys(s, "9", "Enter");
    expect(at(s)).toBe(3); // no slide 9: nothing happens
    s = keys(s, "1", "Enter");
    expect(at(s)).toBe(1);
  });

  it("blacks and whitens the screen with B/. and W/, ; an advance key returns first", () => {
    let s = startShow(deck());
    s = press(s, "b");
    expect(s.blank).toBe("black");
    s = press(s, "b");
    expect(s.blank).toBeNull();
    s = press(s, ".");
    expect(s.blank).toBe("black");
    s = press(s, "w");
    expect(s.blank).toBe("white");
    s = press(s, ",");
    expect(s.blank).toBeNull();
    s = press(s, "W");
    s = press(s, "n");
    expect(s.blank).toBeNull();
    expect(at(s)).toBe(1); // the key only took the screen back
  });

  it("Home and End go to the first and last slide shown", () => {
    let s = startShow(deck(), { from: 1 });
    s = press(s, "End");
    expect(at(s)).toBe(5);
    s = press(s, "Home");
    expect(at(s)).toBe(1);
  });

  it("ends on a black end screen; the next advance ends the show; Esc ends it any time", () => {
    let s = startShow(deck(), { from: 4 });
    s = press(s, "n");
    expect(s.ended).toBe(true);
    expect(at(s)).toBe("end");
    s = press(s, "p");
    expect(at(s)).toBe(5);
    s = keys(s, "n", "n");
    expect(s.done).toBe(true);
    // Done is final.
    expect(press(s, "p")).toBe(s);
    expect(press(startShow(deck()), "Escape").done).toBe(true);
  });

  it("loops back to the first slide until Esc", () => {
    let s = startShow(deck(), { from: 4, loop: true });
    s = press(s, "n");
    expect(at(s)).toBe(1);
    expect(s.ended).toBe(false);
    expect(upNext(startShow(deck(), { from: 4, loop: true }))?.number).toBe(1);
  });

  it("opens the grid with G, moves in it, opens a slide with Enter, closes with Esc", () => {
    let s = startShow(deck());
    s = press(s, "g");
    expect(s.grid).toBe(0);
    s = keys(s, "ArrowRight", "ArrowRight");
    expect(s.grid).toBe(2);
    s = press(s, "ArrowDown"); // a row of four
    expect(s.grid).toBe(4);
    s = press(s, "Enter");
    expect(s.grid).toBeNull();
    expect(at(s)).toBe(5);
    s = press(s, "g");
    s = press(s, "Escape");
    expect(s.grid).toBeNull();
    expect(s.done).toBe(false);
  });

  it("switches the laser (Ctrl/Cmd+L), the pen (Ctrl/Cmd+P) and erases with E", () => {
    let s = startShow(deck());
    s = press(s, "l", { ctrlKey: true });
    expect(s.tool).toBe("laser");
    s = press(s, "p", { metaKey: true });
    expect(s.tool).toBe("pen");
    s = press(s, "p", { ctrlKey: true });
    expect(s.tool).toBe("arrow");
    expect(at(press(s, "p", { ctrlKey: true }))).toBe(1); // not "previous"
    const e = press(s, "e");
    expect(e.erased).toBe(s.erased + 1);
    expect(keyAction({ key: "x" }, s)).toBeNull();
    expect(keyAction({ key: "n", altKey: true }, s)).toBeNull();
  });

  it("starts on the first slide shown, or on a named one (Shift+F5 on a hidden slide)", () => {
    const hiddenFirst = [slide(1, { hidden: true }), slide(2)];
    expect(at(startShow(hiddenFirst))).toBe(2);
    expect(at(startShow(hiddenFirst, { from: 0 }))).toBe(1);
    expect(startShow([]).ended).toBe(true);
  });

  it("counts the position among the slides shown", () => {
    const s = startShow(deck(), { from: 3 });
    expect(position(s)).toEqual({ at: 3, of: 4 });
  });

  it("ignores actions it has no meaning for", () => {
    const s = startShow(deck());
    const a: ShowAction = { type: "goto", index: 99 };
    expect(reduce(s, a)).toBe(s);
    expect(reduce(s, { type: "gridMove", by: 1 })).toBe(s);
  });
});

/** Timers the test advances by hand. */
function fakeTimers() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe("the show's controller [plugin-slide.slide-show]", () => {
  it("advances by itself after a slide's time, and not while blanked", () => {
    const timers = fakeTimers();
    const ctl = new ShowController({
      slides: [slide(1, { advanceAfterMs: 2000 }), slide(2), slide(3)],
      ...timers,
    });
    timers.advance(1999);
    expect(ctl.state().index).toBe(0);
    timers.advance(1);
    expect(ctl.state().index).toBe(1);
    // Slide 2 advances on a click only.
    expect(timers.pending()).toBe(0);
    ctl.dispatch({ type: "prev" });
    ctl.dispatch({ type: "blank", color: "black" });
    expect(timers.pending()).toBe(0);
    ctl.dispatch({ type: "blank", color: "black" });
    expect(timers.pending()).toBe(1);
    ctl.dispose();
    expect(timers.pending()).toBe(0);
  });

  it("loops a timed show until Esc", () => {
    const timers = fakeTimers();
    const ctl = new ShowController({
      slides: [
        slide(1, { advanceAfterMs: 100 }),
        slide(2, { advanceAfterMs: 100 }),
      ],
      loop: true,
      ...timers,
    });
    timers.advance(100);
    timers.advance(100);
    expect(ctl.state().index).toBe(0);
    timers.advance(100);
    expect(ctl.state().index).toBe(1);
    ctl.key({ key: "Escape" });
    expect(ctl.state().done).toBe(true);
    expect(timers.pending()).toBe(0);
  });

  it("rehearses: no automatic advance, the time on each slide recorded", () => {
    const timers = fakeTimers();
    const ctl = new ShowController({
      slides: [slide(1, { advanceAfterMs: 50 }), slide(2), slide(3)],
      rehearse: true,
      ...timers,
    });
    timers.advance(3000);
    expect(ctl.state().index).toBe(0);
    ctl.key({ key: "n" });
    timers.advance(4500);
    ctl.key({ key: "n" });
    timers.advance(1000);
    ctl.key({ key: "Escape" });
    expect([...ctl.rehearsed()]).toEqual([
      ["p1", 3000],
      ["p2", 4500],
      ["p3", 1000],
    ]);
  });

  it("keeps each slide's ink, erases it with E, and snapshots it for the audience", () => {
    const ctl = new ShowController({ slides: [slide(1), slide(2)] });
    ctl.addStroke("p1", [
      [0, 0],
      [1, 1],
    ]);
    expect(ctl.snapshot().strokes.length).toBe(1);
    const before = ctl.state();
    ctl.key({ key: "n" });
    const snap = ctl.snapshot(before);
    expect(snap.advanced).toBe(true);
    expect(snap.slide?.pageId).toBe("p2");
    expect(snap.strokes).toEqual([]);
    ctl.key({ key: "p" });
    ctl.key({ key: "e" });
    expect(ctl.strokes("p1")).toEqual([]);
  });

  it("formats durations as a clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65_000)).toBe("1:05");
    expect(clock(3_725_000)).toBe("1:02:05");
  });
});

const page = (n: number, state: Slide["state"] = {}): Slide => ({
  pageId: `p${n}`,
  number: n,
  sizePt: [960, 540],
  state,
});

describe("the show's slides and timings [plugin-slide.slide-show]", () => {
  it("reads hidden flags, notes, transitions and timings, the deck's own as the fallback", () => {
    const slides = showSlides(
      [
        page(1, {
          notes: "hello",
          transition: { kind: "fade", durationMs: 400, advanceAfterMs: 1500 },
        }),
        page(2, { hidden: true, part: "ppt/slides/slide2.xml" }),
      ],
      {
        slides: [
          {
            part: "ppt/slides/slide2.xml",
            transition: { advance_after_ms: 2500 },
          },
        ],
      } as never,
    );
    expect(slides[0]).toMatchObject({
      pageId: "p1",
      notes: "hello",
      hidden: false,
      advanceAfterMs: 1500,
      transition: { kind: "fade", durationMs: 400 },
    });
    expect(slides[1]).toMatchObject({ hidden: true, advanceAfterMs: 2500 });
  });

  it("writes rehearsed timings into the slides' transitions as one batch", () => {
    const m = timingsMutation(
      [
        page(1, { transition: { kind: "push", xml: "<p:transition/>" } }),
        page(2),
      ],
      new Map([
        ["p1", 3004],
        ["p2", 1996],
      ]),
    ) as { op: string; args: { ops: Array<{ args: { value: string } }> } };
    expect(m.op).toBe("batch");
    const values = m.args.ops.map((o) => JSON.parse(o.args.value).data);
    expect(values[0].transition).toEqual({
      kind: "push",
      xml: "<p:transition/>",
      advanceOnClick: true,
      advanceAfterMs: 3000,
    });
    expect(values[1].transition).toEqual({
      advanceOnClick: true,
      advanceAfterMs: 2000,
    });
    expect(timingsMutation([page(1)], new Map())).toBeNull();
  });

  it("gives each palette command a typed twin that answers whether it presented", async () => {
    const ran: string[] = [];
    const twins = showTypedCommands(async (id) => {
      ran.push(id);
      return id !== SHOW_CMD.rehearseTimings;
    });
    expect(twins.map((c) => c.id).sort()).toEqual(
      Object.values(SHOW_CMD).sort(),
    );
    const first = twins.find((c) => c.id === SHOW_CMD.fromBeginning)!;
    expect(await first.handler({} as never, {} as never)).toEqual({
      presented: true,
    });
    const rehearse = twins.find((c) => c.id === SHOW_CMD.rehearseTimings)!;
    await expect(rehearse.handler({} as never, {} as never)).rejects.toThrow(
      /unavailable/,
    );
  });
});

describe("transitions and frames [plugin-slide.slide-show]", () => {
  it("names a transition as the shader manifest does, with its duration and direction", () => {
    expect(transitionKind("fade")).toBe("p:fade");
    expect(transitionKind("p14:vortex")).toBe("p14:vortex");
    expect(transitionKind(null)).toBeNull();
    expect(transitionDurationMs({ durationMs: 300 })).toBe(300);
    expect(transitionDurationMs({ speed: "slow" })).toBe(1000);
    expect(transitionDurationMs({})).toBe(700);
    expect(transitionParams("u")).toEqual({ direction: 2 });
    expect(transitionParams(null)).toEqual({});
  });

  it("takes one registered renderer factory", () => {
    const f = () => ({ supports: () => true, render() {} });
    const off = registerTransitionRenderer(f);
    expect(transitionRendererFactory()).toBe(f);
    off();
    expect(transitionRendererFactory()).toBeNull();
  });

  it("letterboxes a slide and picks a frame scale for the screen", () => {
    expect(letterbox(16 / 9, 1600, 1200)).toEqual({
      x: 0,
      y: 150,
      width: 1600,
      height: 900,
    });
    expect(letterbox(4 / 3, 1600, 900).x).toBe(200);
    expect(frameScale([960, 540], { width: 1920, height: 1080 }, 1)).toBe(2);
    expect(frameScale([960, 540], { width: 1920, height: 1080 }, 2)).toBe(4);
    expect(frameScale([960, 540], { width: 100, height: 50 }, 1)).toBe(0.25);
    expect(frameScale([0, 0], { width: 100, height: 50 })).toBe(1);
  });
});
