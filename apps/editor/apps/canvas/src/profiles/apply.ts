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

// A resolved editor profile, applied to the surfaces the app owns: which
// host panels, tools, rail launchers, modes and menus are registered, and
// which plugin bundles are activated (docs/composable-editor-plan.md, A4).
// What a profile leaves out is never registered or never activated, as in
// solo mode (ADR 213); what the shell then shows of the rest follows the
// profile's regions.
//
// Run once at module scope, before React renders: PagedShell re-registers
// every panel when its `panels` array changes identity, so these lists must
// be built exactly once per page.

import {
  ALWAYS_IN_PALETTE,
  BUNDLES_ENTRY,
  excludedBy,
  globMatches,
  type ModeContribution,
  type ProfileProblem,
  type ResolvedProfile,
  type ResolvedRegion,
  type WorkflowMode,
} from "@paged-media/shell";

/** The surfaces the app would register without a profile. */
export interface AppSurfaceSource<P, T, R, B> {
  panels: readonly P[];
  tools: readonly T[];
  panelRail: readonly R[];
  modes: readonly ModeContribution[];
  bundles: readonly B[];
}

export interface AppSurfaces<P, T, R, B> {
  panels: P[];
  tools: T[];
  panelRail: R[];
  modes: ModeContribution[];
  bundles: B[];
  /** Whether a host menu item is registered. */
  keepMenu: (item: { path: string }) => boolean;
  /** The mode to start in; undefined lets the stored mode win. */
  initialMode: WorkflowMode | undefined;
  initialDocumentSizePt: readonly [number, number] | undefined;
  /** Whether this is the plain editor (no preset beyond `full`). */
  plain: boolean;
  problems: ProfileProblem[];
}

function namedIn(region: ResolvedRegion | null): string[] {
  if (region === null || region.kind === "all") return [];
  return region.items.filter(
    (i): i is string => typeof i === "string" && i !== BUNDLES_ENTRY,
  );
}

/** Keeps the entries a region admits, by id; a removed region keeps none. */
function admitted<E>(
  region: ResolvedRegion | null,
  entries: readonly E[],
  idOf: (e: E) => string,
): E[] {
  if (region === null) return [];
  if (region.kind === "all") {
    return entries.filter((e) => !excludedBy(region.exclude, idOf(e)));
  }
  const names = namedIn(region);
  return entries.filter((e) => names.some((n) => globMatches(n, idOf(e))));
}

export function applyProfile<
  P extends { id: string },
  T extends { id: string },
  R extends { panelId: string },
  B extends { id: string; lane: string },
>(
  profile: ResolvedProfile,
  source: AppSurfaceSource<P, T, R, B>,
): AppSurfaces<P, T, R, B> {
  const problems: ProfileProblem[] = [];
  const { regions } = profile;

  // Modes: the app's six, or the profile's own.
  let modes: ModeContribution[];
  if (profile.modes === "all") {
    modes = [...source.modes];
  } else {
    modes = profile.modes.map((m, index) => {
      return {
        id: m.id,
        title: m.title,
        icon: "panel-canvas",
        order: (index + 1) * 10,
        ...(m.blurb !== undefined ? { blurb: m.blurb } : {}),
        ...(m.slots !== undefined ? { slots: m.slots } : {}),
        paletteSuggestions: [...(m.paletteSuggestions ?? [])],
        ...(m.menus !== undefined ? { menus: [...m.menus] } : {}),
      };
    });
  }

  // Host panels: the profile's list, plus whatever its layout names, so
  // the cockpit never shows "This panel is unavailable" in its own slot.
  let panels: P[];
  if (profile.panels === "all") {
    panels = [...source.panels];
  } else {
    const allow = new Set<string>(profile.panels);
    for (const mode of modes) {
      if (mode.slots?.left) allow.add(mode.slots.left);
      for (const id of mode.slots?.tabs ?? []) allow.add(id);
      if (mode.slots?.inspector) allow.add(mode.slots.inspector);
    }
    for (const id of namedIn(regions["panel-rail"])) allow.add(id);
    panels = source.panels.filter((p) => allow.has(p.id));
  }

  // Host tools: a rail list registers what it names; navigation and
  // inspection are never taken away (selection is how you get out).
  const railRegion = regions["tool-rail"];
  const tools =
    railRegion?.kind === "list"
      ? source.tools.filter(
          (t) =>
            ALWAYS_IN_PALETTE.includes(t.id) ||
            namedIn(railRegion).some((n) => globMatches(n, t.id)),
        )
      : railRegion === null
        ? source.tools.filter((t) => ALWAYS_IN_PALETTE.includes(t.id))
        : [...source.tools];

  // Rail launchers, in the profile's order where it gives one.
  const railLaunchers = regions["panel-rail"];
  let panelRail = admitted(railLaunchers, source.panelRail, (r) => r.panelId);
  if (railLaunchers?.kind === "list") {
    const order = namedIn(railLaunchers);
    panelRail = [...panelRail].sort(
      (a, b) => order.indexOf(a.panelId) - order.indexOf(b.panelId),
    );
  }

  // Host menu items: kept by their top-level menu.
  const menubar = regions.menubar;
  const keepMenu = (item: { path: string }) => {
    const top = item.path.split("/")[0] ?? "";
    if (menubar === null || menubar.kind === "all") {
      return menubar === null || !excludedBy(menubar.exclude, top);
    }
    return namedIn(menubar).some((n) => globMatches(n, top));
  };

  // Bundles: a list activates only what it names, all in the boot lane
  // (a bundle a profile asks for is part of that editor's start).
  let bundles: B[];
  if (profile.bundles === "all") {
    bundles = [...source.bundles];
  } else {
    const wanted = profile.bundles;
    bundles = source.bundles
      .filter((b) => wanted.includes(b.id))
      .map((b) => ({ ...b, lane: "boot" }));
    for (const id of wanted) {
      if (!source.bundles.some((b) => b.id === id)) {
        problems.push({ path: "bundles", message: `unknown bundle "${id}"` });
      }
    }
  }

  return {
    panels,
    tools,
    panelRail,
    modes,
    bundles,
    keepMenu,
    initialMode: profile.modes === "all" ? undefined : modes[0]?.id,
    initialDocumentSizePt: profile.documentSizePt ?? undefined,
    plain: profile.chain.every((name) => name === "full"),
    problems,
  };
}
