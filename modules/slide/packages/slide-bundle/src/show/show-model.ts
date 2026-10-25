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

// The slide show as a state machine (slide ADR 716): which slide is up,
// whether the screen is blanked, the digits typed for a jump, the slide
// grid, the pointer tool, and the end of the show. Pure: the DOM
// controllers (slide-show.ts, presenter.ts) feed it actions and draw what
// it says; a test drives it with plain objects.
//
// PowerPoint's keys (Slide Show ▸ keyboard shortcuts):
//   next      N, →, ↓, Space, Enter, Page Down
//   previous  P, ←, ↑, Backspace, Page Up
//   jump      a number, then Enter (hidden slides too)
//   first     Home          last   End
//   black     B or .        white  W or ,     (any advance key returns)
//   grid      G (arrows move, Enter opens, G or Esc closes)
//   laser     Ctrl+L        pen    Ctrl+P     arrow  Ctrl+A    erase  E
//   end       Esc
// Cmd stands in for Ctrl on a Mac, where Ctrl+click is the context menu.
// Hidden slides are skipped by next and previous; after the last slide
// comes a black end screen ("End of slide show"), and the next advance
// ends the show; with `loop` the show starts over instead, until Esc.

/** One slide as the show plays it. */
export interface ShowSlide {
  pageId: string;
  /** 1-based position in the deck. */
  number: number;
  hidden: boolean;
  /** Advance automatically after this long on the slide; null: on click. */
  advanceAfterMs: number | null;
  /** The transition INTO this slide. */
  transition: {
    kind: string | null;
    dir: string | null;
    speed: string | null;
    durationMs: number | null;
    /** The deck's own element (its effect options). */
    xml?: string | null;
  } | null;
  notes: string;
  sizePt: [number, number];
}

export type PointerTool = "arrow" | "laser" | "pen";

export interface ShowState {
  slides: readonly ShowSlide[];
  /** The slide up (an index into `slides`). */
  index: number;
  blank: "black" | "white" | null;
  /** Digits typed towards a jump. */
  typed: string;
  /** The slide grid is open, with this slide picked. */
  grid: number | null;
  /** Past the last slide: the end screen. */
  ended: boolean;
  loop: boolean;
  tool: PointerTool;
  /** The show is over (Esc, or an advance past the end screen). */
  done: boolean;
  /** Bumped by `erase`: the controller clears the slide's ink. */
  erased: number;
}

export type ShowAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "first" }
  | { type: "last" }
  | { type: "goto"; index: number }
  | { type: "digit"; digit: string }
  | { type: "enter" }
  | { type: "blank"; color: "black" | "white" }
  | { type: "grid" }
  | { type: "gridMove"; by: number }
  | { type: "tool"; tool: PointerTool }
  | { type: "erase" }
  | { type: "exit" };

/** Visible (not hidden) slide indices. */
function visible(slides: readonly ShowSlide[]): number[] {
  return slides.flatMap((s, i) => (s.hidden ? [] : [i]));
}

/** The show at its first slide: `from` (an index; a hidden slide shows
 *  when asked for by name, as Shift+F5 on it does), else the first slide
 *  that is not hidden. */
export function startShow(
  slides: readonly ShowSlide[],
  opts: { from?: number; loop?: boolean } = {},
): ShowState {
  const shown = visible(slides);
  const from =
    opts.from !== undefined && opts.from >= 0 && opts.from < slides.length
      ? opts.from
      : (shown[0] ?? 0);
  return {
    slides,
    index: from,
    blank: null,
    typed: "",
    grid: null,
    ended: slides.length === 0,
    loop: opts.loop === true,
    tool: "arrow",
    done: false,
    erased: 0,
  };
}

/** The show after `action`. */
export function reduce(s: ShowState, action: ShowAction): ShowState {
  if (s.done) return s;
  const shown = visible(s.slides);
  switch (action.type) {
    case "exit":
      if (s.grid !== null) return { ...s, grid: null };
      return { ...s, done: true };
    case "next": {
      if (s.blank) return { ...s, blank: null, typed: "" };
      if (s.ended) return s.loop ? restart(s, shown) : { ...s, done: true };
      const next = shown.find((i) => i > s.index);
      if (next !== undefined) return { ...s, index: next, typed: "" };
      if (s.loop) return restart(s, shown);
      return { ...s, ended: true, typed: "" };
    }
    case "prev": {
      if (s.blank) return { ...s, blank: null, typed: "" };
      if (s.ended) return { ...s, ended: false, typed: "" };
      const prev = [...shown].reverse().find((i) => i < s.index);
      return prev === undefined
        ? { ...s, typed: "" }
        : { ...s, index: prev, typed: "" };
    }
    case "first":
      return shown.length
        ? { ...s, index: shown[0], ended: false, blank: null, typed: "" }
        : s;
    case "last":
      return shown.length
        ? {
            ...s,
            index: shown[shown.length - 1],
            ended: false,
            blank: null,
            typed: "",
          }
        : s;
    case "goto":
      if (action.index < 0 || action.index >= s.slides.length) return s;
      return {
        ...s,
        index: action.index,
        ended: false,
        blank: null,
        grid: null,
        typed: "",
      };
    case "digit":
      return { ...s, typed: (s.typed + action.digit).slice(-4) };
    case "enter": {
      if (s.grid !== null) return reduce(s, { type: "goto", index: s.grid });
      if (s.typed !== "") {
        const n = Number(s.typed);
        const at = s.slides.findIndex((x) => x.number === n);
        return at >= 0
          ? reduce(s, { type: "goto", index: at })
          : { ...s, typed: "" };
      }
      return reduce(s, { type: "next" });
    }
    case "blank":
      return {
        ...s,
        blank: s.blank === action.color ? null : action.color,
        typed: "",
      };
    case "grid":
      return { ...s, grid: s.grid === null ? s.index : null, typed: "" };
    case "gridMove": {
      if (s.grid === null) return s;
      const g = Math.max(0, Math.min(s.slides.length - 1, s.grid + action.by));
      return { ...s, grid: g };
    }
    case "tool":
      return { ...s, tool: s.tool === action.tool ? "arrow" : action.tool };
    case "erase":
      return { ...s, erased: s.erased + 1 };
  }
}

function restart(s: ShowState, shown: number[]): ShowState {
  return {
    ...s,
    index: shown[0] ?? 0,
    ended: false,
    blank: null,
    typed: "",
  };
}

/** What a key press means in the show, or null for a key it ignores.
 *  `gridColumns` is how many slides the grid shows per row (↑/↓ move a
 *  row there). */
export function keyAction(
  e: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  },
  s: ShowState,
  gridColumns = 4,
): ShowAction | null {
  const key = e.key;
  const lower = key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (lower === "l") return { type: "tool", tool: "laser" };
    if (lower === "p") return { type: "tool", tool: "pen" };
    if (lower === "a") return { type: "tool", tool: "arrow" };
    return null;
  }
  if (e.altKey) return null;
  if (key === "Escape") return { type: "exit" };
  if (s.grid !== null) {
    switch (key) {
      case "ArrowRight":
        return { type: "gridMove", by: 1 };
      case "ArrowLeft":
        return { type: "gridMove", by: -1 };
      case "ArrowDown":
        return { type: "gridMove", by: gridColumns };
      case "ArrowUp":
        return { type: "gridMove", by: -gridColumns };
      case "Enter":
        return { type: "enter" };
    }
    return lower === "g" ? { type: "grid" } : null;
  }
  if (/^[0-9]$/.test(key)) return { type: "digit", digit: key };
  switch (key) {
    case "Enter":
      return { type: "enter" };
    case "ArrowRight":
    case "ArrowDown":
    case " ":
    case "PageDown":
      return { type: "next" };
    case "ArrowLeft":
    case "ArrowUp":
    case "Backspace":
    case "PageUp":
      return { type: "prev" };
    case "Home":
      return { type: "first" };
    case "End":
      return { type: "last" };
    case ".":
      return { type: "blank", color: "black" };
    case ",":
      return { type: "blank", color: "white" };
  }
  switch (lower) {
    case "n":
      return { type: "next" };
    case "p":
      return { type: "prev" };
    case "b":
      return { type: "blank", color: "black" };
    case "w":
      return { type: "blank", color: "white" };
    case "g":
      return { type: "grid" };
    case "e":
      return { type: "erase" };
  }
  return null;
}

/** The next slide the show would advance to (for the presenter's
 *  preview), or null at the end. */
export function upNext(s: ShowState): ShowSlide | null {
  if (s.ended) return null;
  const next = visible(s.slides).find((i) => i > s.index);
  if (next !== undefined) return s.slides[next];
  return s.loop ? (s.slides[visible(s.slides)[0]] ?? null) : null;
}

/** The slide up, or null on the end screen. */
export function current(s: ShowState): ShowSlide | null {
  return s.ended ? null : (s.slides[s.index] ?? null);
}

/** "Slide x of y": the slide's position among the slides shown (a hidden
 *  slide shown by a jump counts where it stands). */
export function position(s: ShowState): { at: number; of: number } {
  const shown = visible(s.slides);
  const at = shown.filter((i) => i <= s.index).length;
  return { at: Math.max(at, 1), of: shown.length };
}
