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

// Custom shows (slide ADR 720): PowerPoint's named subsets of a deck's
// slides, each in its own order (Slide Show ▸ Custom Slide Show). They
// belong to the deck as a whole, so they ride the document's label
// (`customShows: [{id, name, pages}]`, by page id) beside `deck`; a write
// is one undoable mutation of that label. A page that is gone drops out of
// the shows that played it; a duplicated slide is in none.

import type { BundleHost, MutationInput } from "@paged-media/plugin-api";
import { encodeEnvelope } from "@paged-media/helpers";

import {
  LABEL_KEY,
  LABEL_VERSION,
  parseLabel,
  PLUGIN_ID,
} from "./object-model.js";

export interface CustomShow {
  /** PowerPoint's `id`, unique among the deck's shows. */
  id: number;
  name: string;
  /** The pages it plays, in order (a page may appear twice). */
  pages: string[];
}

/** The shows a document label holds, valid entries only. */
export function showsOfLabel(
  data: Record<string, unknown> | null,
): CustomShow[] {
  const raw = data?.customShows;
  if (!Array.isArray(raw)) return [];
  const out: CustomShow[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const { id, name, pages } = r as Record<string, unknown>;
    if (
      typeof id !== "number" ||
      typeof name !== "string" ||
      !Array.isArray(pages)
    )
      continue;
    out.push({
      id,
      name,
      pages: pages.filter((p): p is string => typeof p === "string"),
    });
  }
  return out;
}

/** The shows over the deck's current pages: a page that is gone is left out. */
export function liveShows(
  shows: readonly CustomShow[],
  pageIds: readonly string[],
): CustomShow[] {
  const have = new Set(pageIds);
  return shows.map((s) => ({
    ...s,
    pages: s.pages.filter((p) => have.has(p)),
  }));
}

/** The next free show id. */
export function nextShowId(shows: readonly CustomShow[]): number {
  let id = 0;
  while (shows.some((s) => s.id === id)) id++;
  return id;
}

/** The document label with `shows` as its custom shows (other keys kept);
 *  an empty list drops the key. */
export function showsMutation(
  label: Record<string, unknown> | null,
  shows: readonly CustomShow[],
): MutationInput {
  const { customShows: _old, ...rest } = label ?? {};
  const data =
    shows.length > 0
      ? {
          ...rest,
          customShows: shows.map((s) => ({
            id: s.id,
            name: s.name,
            pages: s.pages,
          })),
        }
      : rest;
  return {
    op: "setDocumentMetadata",
    args: {
      key: LABEL_KEY,
      value:
        Object.keys(data).length > 0
          ? encodeEnvelope(data, LABEL_VERSION)
          : null,
      caller: PLUGIN_ID,
    },
  } as MutationInput;
}

/** Read and edit the open deck's custom shows. */
export class CustomShows {
  constructor(private readonly host: BundleHost) {}

  private async label(): Promise<Record<string, unknown> | null> {
    if (!this.host.supports("document.documentMetadata@1")) return null;
    try {
      return parseLabel<Record<string, unknown>>(
        await this.host.document.getDocumentMetadata(),
      );
    } catch {
      return null;
    }
  }

  /** The deck's shows, as the label holds them. */
  async list(): Promise<CustomShow[]> {
    return showsOfLabel(await this.label());
  }

  /** Replace every show (one undo step). Answers whether it was applied. */
  async write(shows: readonly CustomShow[]): Promise<boolean> {
    const out = await this.host.document.mutate(
      showsMutation(await this.label(), shows),
    );
    return out.applied;
  }

  /** Add or replace the show named `name` (the name is the key a user and a
   *  script know it by). Answers the show written. */
  async set(
    name: string,
    pages: readonly string[],
  ): Promise<CustomShow | null> {
    const shows = await this.list();
    const at = shows.findIndex((s) => s.name === name);
    const show: CustomShow = {
      id: at >= 0 ? shows[at]!.id : nextShowId(shows),
      name,
      pages: [...pages],
    };
    if (at >= 0) shows[at] = show;
    else shows.push(show);
    return (await this.write(shows)) ? show : null;
  }

  async rename(from: string, to: string): Promise<boolean> {
    const shows = await this.list();
    const s = shows.find((x) => x.name === from);
    if (!s || shows.some((x) => x.name === to && x !== s)) return false;
    s.name = to;
    return this.write(shows);
  }

  async remove(name: string): Promise<boolean> {
    const shows = await this.list();
    const rest = shows.filter((s) => s.name !== name);
    if (rest.length === shows.length) return false;
    return this.write(rest);
  }
}
