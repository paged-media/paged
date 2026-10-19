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

// Roving tabindex (the WAI-ARIA toolbar / menubar pattern): a group of
// buttons is ONE tab stop. Tab enters the group on its current item, the
// arrow keys move between the items, Home and End jump to the ends, and
// Tab leaves. The rail's 37 tool buttons were 37 tab stops; they are one.
//
// Which item holds the tab stop: the last one focused, or — while focus
// is outside the group — the selected one (`aria-pressed`, `aria-checked`,
// `aria-selected`, `aria-current`, `data-active="true"`,
// `data-state="active"`), so Tab into the tool rail lands on the tool in
// hand. Items are found by selector and kept current by a
// MutationObserver: the rail's tools register late and re-render often,
// and no item has to know it is in a group.

import { useLayoutEffect, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

export type RovingOrientation = "horizontal" | "vertical" | "both";

export interface RovingFocusOptions {
  /** Which arrows move: Left/Right, Up/Down, or all four (a grid of
   *  buttons in reading order). Default `horizontal`. */
  orientation?: RovingOrientation;
  /** The items, by selector inside the container. Default
   *  `[data-roving-item]`. */
  items?: string;
  /** Wrap from the last item to the first and back. Default true. */
  loop?: boolean;
  /** A typed letter moves to the next item whose name starts with the
   *  letters typed in the last half second (a menu's typeahead).
   *  Default false: in a toolbar the letters are tool shortcuts. */
  typeahead?: boolean;
}

/** Spread on the group's container element. */
export interface RovingFocusProps {
  ref: (el: HTMLElement | null) => void | (() => void);
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
}

const SELECTED = [
  '[aria-pressed="true"]',
  '[aria-checked="true"]',
  '[aria-selected="true"]',
  "[aria-current]:not([aria-current='false'])",
  '[data-active="true"]',
  '[data-state="active"]',
].join(",");

const OBSERVED = [
  "aria-pressed",
  "aria-checked",
  "aria-selected",
  "aria-current",
  "aria-hidden",
  "data-active",
  "data-state",
  "disabled",
  "hidden",
];

function resolveOptions(
  options: RovingFocusOptions,
): Required<RovingFocusOptions> {
  return {
    orientation: options.orientation ?? "horizontal",
    items: options.items ?? "[data-roving-item]",
    loop: options.loop ?? true,
    typeahead: options.typeahead ?? false,
  };
}

function nameOf(el: HTMLElement): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "")
    .trim()
    .toLowerCase();
}

function usable(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.closest("[hidden],[inert]")) return false;
  return el.getAttribute("aria-hidden") !== "true";
}

/** The controller behind `useRovingFocus`; exported for tests and for
 *  groups that are not React components. */
export class RovingFocusGroup {
  private container: HTMLElement | null = null;
  private current: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private typed = "";
  private typedAt = 0;
  options: Required<RovingFocusOptions>;

  constructor(options: RovingFocusOptions = {}) {
    this.options = resolveOptions(options);
  }

  /** Replace the options and re-apply the tab stop. */
  configure(options: RovingFocusOptions): void {
    this.options = resolveOptions(options);
    this.sync();
  }

  /** The group's items in DOM order, usable ones only. */
  items(): HTMLElement[] {
    if (!this.container) return [];
    return Array.from(
      this.container.querySelectorAll<HTMLElement>(this.options.items),
    ).filter(usable);
  }

  /** Give the tab stop to one item: tabIndex 0 there, -1 elsewhere. */
  sync = (): void => {
    const items = this.items();
    if (items.length === 0) return;
    const focusInside =
      this.container !== null &&
      typeof document !== "undefined" &&
      this.container.contains(document.activeElement);
    let stop: HTMLElement | undefined;
    if (!focusInside) stop = items.find((el) => el.matches(SELECTED));
    if (!stop && this.current && items.includes(this.current)) {
      stop = this.current;
    }
    stop ??= items[0];
    for (const el of items) {
      const want = el === stop ? 0 : -1;
      if (el.tabIndex !== want) el.tabIndex = want;
    }
  };

  attach = (el: HTMLElement | null): (() => void) | void => {
    this.observer?.disconnect();
    this.observer = null;
    this.container = el;
    if (!el) return;
    this.sync();
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver(this.sync);
      this.observer.observe(el, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: OBSERVED,
      });
    }
    return () => {
      this.observer?.disconnect();
      this.observer = null;
      this.container = null;
    };
  };

  onFocus = (e: FocusEvent<HTMLElement>): void => {
    const item = this.itemOf(e.target);
    if (!item) return;
    this.current = item;
    this.sync();
  };

  onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const item = this.itemOf(e.target);
    // Only on an item itself: an input or a popover inside the group
    // keeps its keys.
    if (!item || item !== e.target) return;
    const items = this.items();
    const at = items.indexOf(item);
    if (at < 0) return;
    const next =
      this.options.typeahead && e.key.length === 1 && e.key !== " "
        ? this.match(e.key, at, items, e.timeStamp)
        : this.step(e.key, at, items.length);
    if (next === null || next === at) {
      if (next === at) e.preventDefault();
      return;
    }
    e.preventDefault();
    this.current = items[next];
    this.sync();
    items[next].focus();
  };

  private step(key: string, at: number, n: number): number | null {
    const { orientation, loop } = this.options;
    const horizontal = orientation !== "vertical";
    const vertical = orientation !== "horizontal";
    let delta = 0;
    if (key === "Home") return 0;
    if (key === "End") return n - 1;
    if (
      (horizontal && key === "ArrowRight") ||
      (vertical && key === "ArrowDown")
    )
      delta = 1;
    else if (
      (horizontal && key === "ArrowLeft") ||
      (vertical && key === "ArrowUp")
    )
      delta = -1;
    else return null;
    const to = at + delta;
    if (to < 0) return loop ? n - 1 : 0;
    if (to >= n) return loop ? 0 : n - 1;
    return to;
  }

  /** The next item, after `at`, whose name starts with what was typed. */
  private match(
    char: string,
    at: number,
    items: HTMLElement[],
    now: number,
  ): number | null {
    this.typed = now - this.typedAt > 500 ? char : this.typed + char;
    this.typedAt = now;
    const want = this.typed.toLowerCase();
    // A repeated single letter cycles through the items it starts.
    const from = this.typed.length === 1 ? at + 1 : at;
    for (let i = 0; i < items.length; i++) {
      const j = (from + i) % items.length;
      if (nameOf(items[j]).startsWith(want)) return j;
    }
    return null;
  }

  private itemOf(target: EventTarget | null): HTMLElement | null {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function" || !this.container) return null;
    const item = el.closest<HTMLElement>(this.options.items);
    return item && this.container.contains(item) ? item : null;
  }
}

/**
 * Make a container a roving-tabindex group. Spread the result on it:
 * `<div role="toolbar" aria-label="Tools" {...useRovingFocus({ orientation:
 * "vertical", items: "[data-tool-slot]" })}>`.
 */
export function useRovingFocus(
  options: RovingFocusOptions = {},
): RovingFocusProps {
  const [group] = useState(() => new RovingFocusGroup(options));
  const { orientation, items, loop, typeahead } = options;
  useLayoutEffect(() => {
    group.configure({ orientation, items, loop, typeahead });
  }, [group, orientation, items, loop, typeahead]);
  return {
    ref: group.attach,
    onKeyDown: group.onKeyDown,
    onFocus: group.onFocus,
  };
}
