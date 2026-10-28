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

// Sections (slide ADR 720): PowerPoint's named runs of slides. A section
// is kept on the label of the slide it starts at (`section: {id, name}`),
// so it moves, duplicates and undoes with that slide; the slides after it
// belong to it until the next start. Each edit here is one mutation: one
// undo step.

import type { MutationInput } from "@paged-media/plugin-api";

import { setStateMutation, type Slide } from "./slides-model.js";
import { moveManyMutation } from "./views/slide-sorter.js";

/** A section as the deck reads it. */
export interface Section {
  id: string;
  name: string;
  /** Index of its first slide. */
  start: number;
  /** Its slides, in order. */
  pageIds: string[];
}

/** The deck's sections, in order. Slides before the first start belong to
 *  no section (export writes them as PowerPoint's "Default Section"); a
 *  start whose id repeats an earlier one (a duplicated first slide) does
 *  not open a second section. */
export function sectionsOf(slides: readonly Slide[]): Section[] {
  const out: Section[] = [];
  const seen = new Set<string>();
  slides.forEach((s, i) => {
    const start = s.state.section;
    if (start && !seen.has(start.id)) {
      seen.add(start.id);
      out.push({
        id: start.id,
        name: start.name,
        start: i,
        pageIds: [s.pageId],
      });
    } else if (out.length > 0) {
      out[out.length - 1]!.pageIds.push(s.pageId);
    }
  });
  return out;
}

/** The section `pageId` is in, or null. */
export function sectionOf(
  slides: readonly Slide[],
  pageId: string,
): Section | null {
  return sectionsOf(slides).find((s) => s.pageIds.includes(pageId)) ?? null;
}

/** A new section id in PowerPoint's form. */
export function newSectionId(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
          Math.floor(Math.random() * 16).toString(16),
        );
  return `{${uuid.toUpperCase()}}`;
}

/** Start a section named `name` at `pageId` (a start already there is
 *  renamed). Null for an unknown page. */
export function addSectionMutation(
  slides: readonly Slide[],
  pageId: string,
  name: string,
  id: string = newSectionId(),
): MutationInput | null {
  const s = slides.find((x) => x.pageId === pageId);
  if (!s) return null;
  return setStateMutation(pageId, {
    ...s.state,
    section: { id: s.state.section?.id ?? id, name },
  });
}

function startSlide(slides: readonly Slide[], id: string): Slide | null {
  const sec = sectionsOf(slides).find((x) => x.id === id);
  return sec ? (slides[sec.start] ?? null) : null;
}

/** Rename section `id`. */
export function renameSectionMutation(
  slides: readonly Slide[],
  id: string,
  name: string,
): MutationInput | null {
  const s = startSlide(slides, id);
  if (!s || s.state.section?.name === name) return null;
  return setStateMutation(s.pageId, {
    ...s.state,
    section: { id, name },
  });
}

/** Remove section `id`; its slides join the section before it (PowerPoint's
 *  Remove Section). With `withSlides`, its slides go too (Remove Section &
 *  Slides), unless they are all the deck has. */
export function removeSectionMutation(
  slides: readonly Slide[],
  id: string,
  withSlides = false,
): MutationInput | null {
  const sec = sectionsOf(slides).find((x) => x.id === id);
  if (!sec) return null;
  if (withSlides) {
    if (sec.pageIds.length >= slides.length) return null;
    return {
      op: "batch",
      args: {
        ops: sec.pageIds.map((pageId) => ({
          op: "deletePage",
          args: { pageId },
        })),
      },
    } as MutationInput;
  }
  const s = slides[sec.start]!;
  const { section: _gone, ...rest } = s.state;
  return setStateMutation(s.pageId, rest);
}

/** Move section `id` with its slides before the section above it (`-1`)
 *  or after the one below (`+1`). */
export function moveSectionMutation(
  slides: readonly Slide[],
  id: string,
  by: -1 | 1,
): MutationInput | null {
  const all = sectionsOf(slides);
  const k = all.findIndex((x) => x.id === id);
  const other = all[k + by];
  if (k < 0 || !other) return null;
  const order = slides.map((s) => s.pageId);
  const to = by < 0 ? other.start : other.start + other.pageIds.length;
  return moveManyMutation(order, all[k]!.pageIds, to);
}
