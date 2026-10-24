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

// The Word chrome's live state (doc ADR 608): what the Home group shows for
// the selection (its effective format), the document's styles, fonts and
// swatches, and what the status items read (page X of Y, the word counts).
// One store per activation; `refresh*` re-reads from the host and the
// components subscribe (`useLive(store, subscribeOf)`).

import type { BundleHost, PropertyPath } from "@paged-media/plugin-api";

import type { Read, StyleRow } from "./format.js";
import {
  rangeText,
  countWords,
  storyWords,
  type StoryText,
} from "./word-count.js";

/** The paths the Home group shows. */
export const SHOWN_PATHS = [
  "appliedParagraphStyle",
  "characterFontFamily",
  "characterFontStyle",
  "characterFontSize",
  "characterLeading",
  "characterUnderline",
  "characterStrikethru",
  "characterPosition",
  "characterCase",
  "characterFillColor",
  "paragraphJustification",
  "paragraphListType",
] as const satisfies readonly PropertyPath[];

export type ShownPath = (typeof SHOWN_PATHS)[number];

export interface WordSnapshot {
  /** The selection's effective values (absent: no selection). */
  format: Partial<Record<ShownPath, Read<unknown>>>;
  hasSelection: boolean;
  styles: StyleRow[];
  fonts: string[];
  swatches: Array<{ selfId: string; name: string }>;
  page: { index: number; count: number } | null;
  words: { total: number; selected: number | null } | null;
}

export interface WordStore {
  get(): WordSnapshot;
  subscribe(listener: () => void): () => void;
  refreshFormat(): Promise<void>;
  refreshDocument(): Promise<void>;
  refreshPage(): Promise<void>;
  refreshWords(): Promise<void>;
}

const EMPTY: WordSnapshot = {
  format: {},
  hasSelection: false,
  styles: [],
  fonts: [],
  swatches: [],
  page: null,
  words: null,
};

/**
 * The store over `host`. `docStories` names the stories that are the Word
 * document (its sections) for the word count; an empty answer counts the
 * story the selection is in.
 */
export function createWordStore(
  host: BundleHost,
  docStories: () => Promise<string[]>,
): WordStore {
  let snap: WordSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<WordSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const fn of [...listeners]) fn();
  };
  // Answers arrive out of order; only the newest request of each kind lands.
  const latest = { format: 0, words: 0 };

  const story = async (id: string): Promise<StoryText | null> => {
    try {
      return (await host.document.storyContent(id)) as StoryText | null;
    } catch {
      return null;
    }
  };

  return {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refreshFormat() {
      const ask = ++latest.format;
      const sel = host.text.selection();
      if (!sel) {
        set({ format: {}, hasSelection: false });
        return;
      }
      const props = await host.text.properties([...SHOWN_PATHS]);
      if (ask !== latest.format) return;
      const format: Partial<Record<ShownPath, Read<unknown>>> = {};
      for (const p of SHOWN_PATHS) {
        const r = props?.[p];
        format[p] = r === "mixed" ? "mixed" : r ? r.value : null;
      }
      set({ format, hasSelection: true });
    },
    async refreshDocument() {
      const [styles, fonts, swatches] = await Promise.all([
        host.document.collection("paragraphStyles").catch(() => []),
        host.document.collection("fonts").catch(() => []),
        host.document.collection("swatches").catch(() => []),
      ]);
      set({
        styles: (styles as unknown as StyleRow[]).map((s) => ({
          selfId: s.selfId,
          name: s.name,
        })),
        fonts: (fonts as unknown as Array<{ family: string }>)
          .map((f) => f.family)
          .sort((a, b) => a.localeCompare(b)),
        swatches: (
          swatches as unknown as Array<{ selfId: string; name: string }>
        ).map((s) => ({ selfId: s.selfId, name: s.name })),
      });
    },
    async refreshPage() {
      if (!host.supports("viewport.pages@1")) return;
      const pages = (await host.document
        .collection("pages")
        .catch(() => [])) as unknown as Array<{ selfId?: string; id?: string }>;
      const active = host.viewport.activePage();
      const id = active == null ? null : String(active);
      const index = pages.findIndex((p) => (p.selfId ?? p.id) === id);
      set({
        page:
          pages.length === 0
            ? null
            : { index: index < 0 ? 0 : index, count: pages.length },
      });
    },
    async refreshWords() {
      if (!host.supports("document.readStory@1")) return;
      const ask = ++latest.words;
      const sel = host.text.selection();
      const ids = await docStories();
      const all = ids.length > 0 ? ids : sel ? [sel.storyId] : [];
      const stories = (await Promise.all(all.map(story))).filter(
        (s): s is StoryText => s !== null,
      );
      let selected: number | null = null;
      if (sel && sel.start !== sel.end) {
        const s = await story(sel.storyId);
        if (s) selected = countWords(rangeText(s, sel.start, sel.end));
      }
      if (ask !== latest.words) return;
      set({ words: { total: storyWords(stories), selected } });
    },
  };
}
