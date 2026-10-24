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

// Deprecated ids (docs/composable-editor.md §12, decision 2 of 2026-10-24;
// PM-0013, amendment 2). The ids a profile and a feature set name are the
// public list in `feature-ids.json`. An id leaves that list only after a
// deprecation window, and until the window ends an alias keeps an old
// profile or feature set working: the old id is read as its replacement, or,
// when nothing replaces it, dropped, and the host is told once per editor.

import type { FeatureId, FeatureKind } from "../state/features";
import type {
  EditorProfile,
  ProfileMode,
  RegionItem,
  RegionEdit,
} from "./types";

/** One deprecated id: what replaces it, and the window it works in. */
export interface IdDeprecation {
  /** The old id (`panel:paged.layers`). */
  readonly id: FeatureId;
  /** The id that replaces it, or null when the feature is gone. */
  readonly replacement: FeatureId | null;
  /** The release that deprecated it (`0.76.0`). */
  readonly deprecatedIn: string;
  /** The first release without the alias. */
  readonly removeIn: string;
}

/** Reads old ids as new ones, and reports each old id once. */
export interface IdAliases {
  /** A feature pattern as the editor reads it: a deprecated id becomes its
   *  replacement (null: nothing left to switch); anything else, a glob
   *  included, is itself. */
  feature(pattern: FeatureId): FeatureId | null;
  /** A bare id (a region item, a panel, a mode's slot) of one of these
   *  kinds, read the same way. */
  bare(id: string, kinds: readonly FeatureKind[]): string | null;
  /** The deprecations met so far, oldest first. */
  used(): readonly IdDeprecation[];
  /** Called once for each deprecation as it is first met. */
  subscribe(listener: (d: IdDeprecation) => void): () => void;
}

const bareOf = (id: string) => id.slice(id.indexOf(":") + 1);
const kindOf = (id: string) => id.slice(0, id.indexOf(":"));

export function createIdAliases(
  deprecations: readonly IdDeprecation[],
): IdAliases {
  const byId = new Map(deprecations.map((d) => [d.id as string, d]));
  const met: IdDeprecation[] = [];
  const listeners = new Set<(d: IdDeprecation) => void>();
  const meet = (d: IdDeprecation) => {
    if (met.includes(d)) return;
    met.push(d);
    for (const l of [...listeners]) l(d);
  };
  return {
    feature(pattern) {
      const d = byId.get(pattern);
      if (!d) return pattern;
      meet(d);
      return d.replacement;
    },
    bare(id, kinds) {
      for (const kind of kinds) {
        const d = byId.get(`${kind}:${id}`);
        if (!d) continue;
        meet(d);
        return d.replacement === null ? null : bareOf(d.replacement);
      }
      return id;
    },
    used: () => met,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The kinds a region item, a panel list entry and a slot may name. */
const ITEM_KINDS: readonly FeatureKind[] = ["command", "panel", "tool"];

/** What a host reads in the console when it uses an old id. */
export function deprecationWarning(d: IdDeprecation): string {
  const instead =
    d.replacement === null
      ? "it has no replacement and is ignored"
      : `it is read as "${d.replacement}"`;
  return `"${d.id}" is deprecated since ${d.deprecatedIn} and is removed in ${d.removeIn}; ${instead}`;
}

function items(list: readonly RegionItem[], aliases: IdAliases): RegionItem[] {
  const out: RegionItem[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const id = aliases.bare(item, ITEM_KINDS);
      if (id !== null) out.push(id);
    } else if (item.kind === "group") {
      out.push({ ...item, items: items(item.items, aliases) });
    } else out.push(item);
  }
  return out;
}

function matcher<T extends string | number | undefined>(
  m: T,
  aliases: IdAliases,
): T {
  // A matcher whose id is gone keeps the old id: it matches nothing, and
  // the edit reports that, as for any id a region does not hold.
  return typeof m === "string" ? ((aliases.bare(m, ITEM_KINDS) ?? m) as T) : m;
}

function edit(e: RegionEdit, aliases: IdAliases): RegionEdit {
  if (e.op === "remove") return { ...e, match: matcher(e.match, aliases) };
  if (e.op === "set") return { ...e, items: items(e.items, aliases) };
  return {
    ...e,
    items: items(e.items, aliases),
    ...(e.before !== undefined ? { before: matcher(e.before, aliases) } : {}),
    ...(e.after !== undefined ? { after: matcher(e.after, aliases) } : {}),
  };
}

function mode(m: ProfileMode, aliases: IdAliases): ProfileMode {
  const panel = (id: string) => aliases.bare(id, ["panel"]);
  const slots = m.slots;
  return {
    ...m,
    ...(slots
      ? {
          slots: {
            ...slots,
            left: panel(slots.left) ?? slots.left,
            ...(slots.tabs
              ? {
                  tabs: slots.tabs.flatMap((t) => {
                    const id = panel(t);
                    return id === null ? [] : [id];
                  }),
                }
              : {}),
            ...(slots.inspector
              ? { inspector: panel(slots.inspector) ?? slots.inspector }
              : {}),
          },
        }
      : {}),
    ...(m.paletteSuggestions
      ? {
          paletteSuggestions: m.paletteSuggestions.flatMap((c) => {
            const id = aliases.bare(c, ["command"]);
            return id === null ? [] : [id];
          }),
        }
      : {}),
  };
}

/**
 * A host's profile with its deprecated ids read as their replacements: the
 * feature switches, the panel list, the regions and their edits, and the
 * modes' slots. Presets are the editor's own and never name an old id
 * (`feature-ids.mjs` holds them to the list).
 */
export function migrateProfileIds(
  profile: EditorProfile,
  aliases: IdAliases,
): EditorProfile {
  const out: { -readonly [K in keyof EditorProfile]: EditorProfile[K] } = {
    ...profile,
  };
  if (profile.features) {
    const features: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(profile.features)) {
      const next = kindOf(id) ? aliases.feature(id as FeatureId) : id;
      if (next !== null) features[next] = on;
    }
    out.features = features;
  }
  if (Array.isArray(profile.panels)) {
    out.panels = (profile.panels as readonly string[]).flatMap((p) => {
      const id = aliases.bare(p, ["panel"]);
      return id === null ? [] : [id];
    });
  }
  if (profile.regions) {
    const regions: Record<string, unknown> = {};
    for (const [region, spec] of Object.entries(profile.regions)) {
      regions[region] =
        spec && spec.items !== "all"
          ? { ...spec, items: items(spec.items, aliases) }
          : spec;
    }
    out.regions = regions as EditorProfile["regions"];
  }
  if (profile.adjust) out.adjust = profile.adjust.map((e) => edit(e, aliases));
  if (Array.isArray(profile.modes))
    out.modes = (profile.modes as readonly ProfileMode[]).map((m) =>
      mode(m, aliases),
    );
  return out;
}
