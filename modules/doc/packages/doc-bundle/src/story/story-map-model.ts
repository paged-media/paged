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

// Doc ADR 630 — the Story Map: how every story of the document flows
// through its frames, page by page, and where it stops — overset (text the
// last frame cannot hold) or disconnected (a story placed in no frame).
// Built from the engine's own reads: the stories collection, each story's
// frame chain and each frame's page. Pure: no React, no host.

/** What the map reads of a story (the engine's `StorySummary`). */
export interface StoryFacts {
  selfId: string;
  characterCount: number;
  paragraphCount: number;
  overset?: boolean;
  oversetAt?: { paragraph: number; line: number } | null;
}

/** One frame of a story's thread. */
export interface MapFrame {
  frameId: string;
  /** The page the frame is on, and its index in the document. */
  pageId: string | null;
  pageIndex: number | null;
}

/** One story on the map. */
export interface MapStory {
  storyId: string;
  /** The first words of the story ("" when it is empty). */
  preview: string;
  characterCount: number;
  /** The frames in thread order. */
  frames: MapFrame[];
  /** Text past the last frame. */
  overset: boolean;
  /** The paragraph where the overset text starts, when known. */
  oversetParagraph: number | null;
  /** The story has no frame: its text shows nowhere. */
  disconnected: boolean;
  /** The pages it crosses, in thread order, without repeats. */
  pages: number[];
}

/** The map, longest stories first within each group: problems (overset,
 *  then disconnected) before stories that fit. */
export function storyMap(
  stories: readonly StoryFacts[],
  chains: ReadonlyMap<string, readonly string[]>,
  framePages: ReadonlyMap<string, { pageId: string; pageIndex: number }>,
  previews: ReadonlyMap<string, string> = new Map(),
): MapStory[] {
  const out = stories.map((s): MapStory => {
    // The id the frame-chain and content doors take, as the editor's own
    // overset markers pass it.
    const key = s.selfId;
    const frames = (chains.get(key) ?? []).map((frameId) => {
      const page = framePages.get(frameId);
      return {
        frameId,
        pageId: page?.pageId ?? null,
        pageIndex: page?.pageIndex ?? null,
      };
    });
    const pages: number[] = [];
    for (const f of frames)
      if (f.pageIndex !== null && pages[pages.length - 1] !== f.pageIndex)
        pages.push(f.pageIndex);
    return {
      storyId: key,
      preview: previews.get(key) ?? "",
      characterCount: s.characterCount,
      frames,
      overset: s.overset === true,
      oversetParagraph: s.oversetAt?.paragraph ?? null,
      disconnected: frames.length === 0,
      pages,
    };
  });
  const rank = (s: MapStory) => (s.overset ? 0 : s.disconnected ? 1 : 2);
  return out.sort(
    (a, b) => rank(a) - rank(b) || b.characterCount - a.characterCount,
  );
}

/** The overset stories in map order: what "Next overset" walks. */
export function oversetStories(map: readonly MapStory[]): MapStory[] {
  return map.filter((s) => s.overset && s.frames.length > 0);
}

/** The overset story after `current` (the first after the last), or null
 *  when none oversets. */
export function nextOverset(
  map: readonly MapStory[],
  current: string | null,
): MapStory | null {
  const list = oversetStories(map);
  if (list.length === 0) return null;
  const at = current ? list.findIndex((s) => s.storyId === current) : -1;
  return list[(at + 1) % list.length]!;
}

/** The first words of a story, at most `max` characters. */
export function previewText(
  paragraphs: ReadonlyArray<{ runs: ReadonlyArray<{ text: string }> }>,
  max = 60,
): string {
  const text = paragraphs
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
