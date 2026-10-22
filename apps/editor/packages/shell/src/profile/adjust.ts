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

// Region edits: remove, insert and set by matcher, so a host changes one
// entry of a preset without copying the whole list. Pure functions; an
// edit that cannot apply is reported, never thrown.

import type {
  ItemMatcher,
  ProfileProblem,
  RegionEdit,
  RegionItem,
  ResolvedRegion,
} from "./types";

/** The id an item is matched by; layout entries have none. */
export function itemId(item: RegionItem): string | null {
  if (typeof item === "string") return item;
  if (item.kind === "group" || item.kind === "host") return item.id;
  return null;
}

function isPositional(matcher: ItemMatcher): boolean {
  return (
    typeof matcher === "number" || matcher === "first" || matcher === "last"
  );
}

/** Whether `id` matches `pattern`, where `*` stands for any run of characters. */
export function globMatches(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;
  const parts = pattern
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`).test(id);
}

/** Indices of the entries a matcher selects, in order. */
export function matchIndices(
  items: readonly RegionItem[],
  matcher: ItemMatcher,
): number[] {
  if (typeof matcher === "number") {
    const index = matcher < 0 ? items.length + matcher : matcher;
    return index >= 0 && index < items.length ? [index] : [];
  }
  if (matcher === "first") return items.length > 0 ? [0] : [];
  if (matcher === "last") return items.length > 0 ? [items.length - 1] : [];
  const out: number[] = [];
  items.forEach((item, index) => {
    const id = itemId(item);
    if (id !== null && globMatches(matcher, id)) out.push(index);
  });
  return out;
}

/** Whether a registry id survives a region that keeps everything but `exclude`. */
export function excludedBy(
  exclude: readonly ItemMatcher[],
  id: string,
): boolean {
  return exclude.some((m) => typeof m === "string" && globMatches(m, id));
}

/**
 * Applies one edit to a region. Returns the new region and any problem;
 * the input is never mutated.
 */
export function applyRegionEdit(
  region: ResolvedRegion | null,
  edit: RegionEdit,
  path: string,
): { region: ResolvedRegion | null; problems: ProfileProblem[] } {
  const problems: ProfileProblem[] = [];
  const problem = (message: string) => problems.push({ path, message });

  if (edit.op === "set") {
    return { region: { kind: "list", items: [...edit.items] }, problems };
  }
  if (region === null) {
    problem(`region "${edit.region}" is removed; use "set" to add it back`);
    return { region, problems };
  }

  if (region.kind === "all") {
    if (edit.op === "remove") {
      if (isPositional(edit.match)) {
        problem(
          `region "${edit.region}" keeps every registered entry; remove by id or glob, not by position`,
        );
        return { region, problems };
      }
      return {
        region: { ...region, exclude: [...region.exclude, edit.match] },
        problems,
      };
    }
    if (edit.before !== undefined || edit.after !== undefined) {
      problem(
        `region "${edit.region}" keeps every registered entry; inserted items go at its end`,
      );
    }
    return {
      region: { ...region, append: [...region.append, ...edit.items] },
      problems,
    };
  }

  const items = [...region.items];
  if (edit.op === "remove") {
    const hits = matchIndices(items, edit.match);
    if (hits.length === 0) {
      problem(
        `nothing in "${edit.region}" matches ${JSON.stringify(edit.match)}`,
      );
      return { region, problems };
    }
    const drop = new Set(hits);
    return {
      region: { kind: "list", items: items.filter((_, i) => !drop.has(i)) },
      problems,
    };
  }

  // insert
  let at = items.length;
  const anchor = edit.before ?? edit.after;
  if (anchor !== undefined) {
    const hits = matchIndices(items, anchor);
    if (hits.length === 0) {
      problem(
        `nothing in "${edit.region}" matches ${JSON.stringify(anchor)}; inserted at the end`,
      );
    } else {
      at = edit.before !== undefined ? hits[0]! : hits[hits.length - 1]! + 1;
    }
  }
  items.splice(at, 0, ...edit.items);
  return { region: { kind: "list", items }, problems };
}
