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

// Slide ADR 725 — a deck opens in the slide sorter: once per opened
// document, a deck of two or more slides, unless the switch is off.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import { SORTER_VIEW } from "../src/show/contribute.js";
import {
  openDecksInSorter,
  setSorterOnOpen,
  sorterOnOpen,
} from "../src/show/sorter-on-open.js";
import type { SlidesStore } from "../src/slides-model.js";

function world(slides: number, deck = true) {
  let list: unknown[] = Array.from({ length: slides }, (_, i) => ({
    pageId: `p${i}`,
  }));
  let isDeck = deck;
  const listeners = new Set<() => void>();
  const opened = new Set<() => void>();
  const shown: Array<string | null> = [];
  const kv = new Map<string, unknown>();
  const host = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      get: (k: string) => kv.get(k),
      set: (k: string, v: unknown) => void kv.set(k, v),
      delete: (k: string) => void kv.delete(k),
      keys: () => [...kv.keys()],
    },
    shell: {
      showView(id: string | null) {
        shown.push(id);
        return true;
      },
    },
    document: {
      onDidOpen(l: () => void) {
        opened.add(l);
        return { dispose: () => void opened.delete(l) };
      },
    },
  } as unknown as BundleHost;
  const store = {
    isDeck: () => isDeck,
    list: () => list,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  } as unknown as SlidesStore;
  return {
    host,
    store,
    shown,
    /** A new document opened; the store reads it later. */
    open(next: number, nextDeck = true) {
      for (const l of [...opened]) l();
      // The store still holds the old pages: an emit now changes nothing.
      for (const l of [...listeners]) l();
      list = Array.from({ length: next }, (_, i) => ({ pageId: `q${i}` }));
      isDeck = nextDeck;
      for (const l of [...listeners]) l();
    },
    emit() {
      for (const l of [...listeners]) l();
    },
  };
}

describe("a deck opens in the slide sorter [plugin-slide.slide-sorter]", () => {
  it("shows the sorter for a deck of several slides, once per document", () => {
    const w = world(10);
    openDecksInSorter(w.host, w.store);
    expect(w.shown).toEqual([SORTER_VIEW]);
    w.emit();
    w.emit();
    expect(w.shown).toEqual([SORTER_VIEW]);
    w.open(4);
    expect(w.shown).toEqual([SORTER_VIEW, SORTER_VIEW]);
  });

  it("not for a one-slide deck, not for a document that is no deck, not before the pages are read", () => {
    const one = world(1);
    openDecksInSorter(one.host, one.store);
    expect(one.shown).toEqual([]);
    const doc = world(5, false);
    openDecksInSorter(doc.host, doc.store);
    expect(doc.shown).toEqual([]);
    // A deck opened after a document: decided on its own pages.
    doc.open(3, true);
    expect(doc.shown).toEqual([SORTER_VIEW]);
    const empty = world(0);
    openDecksInSorter(empty.host, empty.store);
    expect(empty.shown).toEqual([]);
  });

  it("not when the user turned it off", () => {
    const w = world(10);
    expect(sorterOnOpen(w.host)).toBe(true);
    setSorterOnOpen(w.host, false);
    expect(sorterOnOpen(w.host)).toBe(false);
    openDecksInSorter(w.host, w.store);
    expect(w.shown).toEqual([]);
  });
});
