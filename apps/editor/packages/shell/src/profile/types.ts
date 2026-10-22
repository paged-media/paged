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

// The editor profile: which bundles, modes and chrome regions an editor has,
// and what each region holds. It is data, resolved once before the shell
// renders (docs/composable-editor.md §5, the generalisation of solo mode,
// ADR 213). A profile names a preset it `extends` and adjusts it; the
// resolver expands the chain into a `ResolvedProfile` that has no gaps.

import type { ModeCockpitSlots } from "../registries/mode";

/** The regions of the chrome, by stable id. */
export const REGION_IDS = [
  "header",
  "menubar",
  "context-toolbar",
  "tool-rail",
  "left",
  "canvas",
  "right",
  "panel-rail",
  "mode-bar",
  "palette",
  "context-menu",
  "form",
  "actions-bar",
] as const;

export type RegionId = (typeof REGION_IDS)[number];

/**
 * One entry of a region. A string is an id from the registry the region
 * draws on: a command, panel or tool id, or, in the menu bar, a top-level
 * menu label. The object forms are layout, and `host` is a component the
 * embedding host registers.
 */
export type RegionItem =
  | string
  | { readonly kind: "separator" }
  | { readonly kind: "spacer" }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly items: readonly RegionItem[];
    }
  | { readonly kind: "host"; readonly id: string };

/**
 * What a region holds. `"all"` keeps everything the registry offers, in
 * registry order: the editor as it is today. A list is an allow-list, in
 * the order given.
 */
export interface RegionSpec {
  readonly items: "all" | readonly RegionItem[];
}

/**
 * Selects entries of a region: an exact id, a glob (`paged.object.*`),
 * `first` or `last`, or an index.
 */
export type ItemMatcher = string | number;

/** An edit applied to a region after the preset chain is merged. */
export type RegionEdit =
  | {
      readonly region: RegionId;
      readonly op: "remove";
      readonly match: ItemMatcher;
    }
  | {
      readonly region: RegionId;
      readonly op: "insert";
      readonly items: readonly RegionItem[];
      readonly before?: ItemMatcher;
      readonly after?: ItemMatcher;
    }
  | {
      readonly region: RegionId;
      readonly op: "set";
      readonly items: readonly RegionItem[];
    };

/** One workflow mode a profile declares. */
export interface ProfileMode {
  readonly id: string;
  readonly title: string;
  readonly blurb?: string;
  readonly slots?: ModeCockpitSlots;
  readonly paletteSuggestions?: readonly string[];
  /** Context menus the mode keeps on the menu bar; `"*"` keeps all. */
  readonly menus?: readonly string[];
}

/** Canvas furniture. */
export interface CanvasFurniture {
  readonly titleBar?: boolean;
  readonly rulers?: boolean;
  readonly thumbnails?: boolean;
}

/** Which plugin bundles an editor activates. */
export type BundleSelection = "all" | readonly string[];

/** An editor profile as a host or a preset writes it. */
export interface EditorProfile {
  /** The preset this profile starts from. */
  readonly extends?: string;
  /** Product name: the mode title and the title-bar badge. */
  readonly title?: string;
  readonly blurb?: string;
  /** Plugin bundles to activate, by manifest id. */
  readonly bundles?: BundleSelection;
  /** HOST panels registered; plugin panels arrive with their bundle. */
  readonly panels?: "all" | readonly string[];
  /** Workflow modes; `"all"` keeps the application's own set. */
  readonly modes?: "all" | readonly ProfileMode[];
  /** Regions. An absent key inherits the preset's; `null` removes it. */
  readonly regions?: Partial<Record<RegionId, RegionSpec | null>>;
  /** Region edits, applied in order after the chain is merged. */
  readonly adjust?: readonly RegionEdit[];
  readonly canvas?: CanvasFurniture;
  /** The size of the document created at start when none is open. */
  readonly documentSizePt?: readonly [number, number];
  /** Suffix that separates this profile's stored layout and mode. */
  readonly storageScope?: string;
}

/**
 * A region after resolution. `all` keeps every registry entry except those
 * `exclude` matches, followed by `append`; `list` is an exact allow-list.
 */
export type ResolvedRegion =
  | {
      readonly kind: "all";
      readonly exclude: readonly ItemMatcher[];
      readonly append: readonly RegionItem[];
    }
  | { readonly kind: "list"; readonly items: readonly RegionItem[] };

/** A profile with its chain expanded and every field present. */
export interface ResolvedProfile {
  /** The presets that were expanded, outermost last. */
  readonly chain: readonly string[];
  readonly title: string | null;
  readonly blurb: string | null;
  readonly bundles: BundleSelection;
  readonly panels: "all" | readonly string[];
  readonly modes: "all" | readonly ProfileMode[];
  /** Every region id is present; `null` means not rendered. */
  readonly regions: Readonly<Record<RegionId, ResolvedRegion | null>>;
  readonly canvas: Required<CanvasFurniture>;
  readonly documentSizePt: readonly [number, number] | null;
  readonly storageScope: string;
}

/** Something about a profile that was ignored, with where it was. */
export interface ProfileProblem {
  /** A dotted path into the profile, e.g. `regions.menubar.items[2]`. */
  readonly path: string;
  readonly message: string;
}
