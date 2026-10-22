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

// applyProfile against what solo mode built by hand (ADR 213, the
// SOLO_SURFACES block main.tsx had): for every solo preset the registered
// panels, tools, rail launchers, menus, mode and bundles are the same. The
// app's real lists import React components and Vite-only assets, so the
// surfaces here are stand-ins that carry every id the profiles name plus
// ids no profile names.

import { describe, expect, test } from "bun:test";

import {
  ALWAYS_IN_PALETTE,
  resolveProfile,
  type ModeContribution,
} from "@paged-media/shell";

import { applyProfile } from "../../../src/profiles/apply";
import { PRESETS, soloPresetId } from "../../../src/profiles/presets";
import { SOLO_PROFILES } from "../../../src/solo/profiles";

const solos = Object.values(SOLO_PROFILES);
const ids = (xs: Iterable<string>) => [...new Set(xs)].sort();

const SOURCE = {
  panels: ids([
    ...solos.flatMap((s) => [...s.panelIds, ...s.panelRailIds]),
    "paged.preflight",
    "paged.separations",
  ]).map((id) => ({ id })),
  tools: ids([
    ...solos.flatMap((s) => s.toolIds),
    ...ALWAYS_IN_PALETTE,
    "paged.tool.measure",
  ]).map((id) => ({ id })),
  panelRail: ids([
    ...solos.flatMap((s) => s.panelRailIds),
    "paged.preflight",
  ]).map((panelId) => ({ panelId })),
  modes: [
    { id: "design", title: "Design", icon: "x", order: 0 },
    { id: "export", title: "Export", icon: "x", order: 1 },
  ] as ModeContribution[],
  bundles: ids(solos.map((s) => s.bundleId))
    .concat(["media.paged.pdf"])
    .map((id) => ({
      id,
      lane: id === "media.paged.pdf" ? "onDemand" : "boot",
    })),
};

const MENU_TOPS = [
  "File",
  "Edit",
  "View",
  "Layout",
  "Type",
  "Object",
  "Data",
  "Window",
  "Help",
  "Table",
];

describe("applyProfile", () => {
  for (const [name, solo] of Object.entries(SOLO_PROFILES)) {
    test(`${name}: the surfaces solo mode registered`, () => {
      const { profile } = resolveProfile(
        { extends: soloPresetId(name) },
        PRESETS,
      );
      const s = applyProfile(profile, SOURCE);

      // What main.tsx's SOLO_SURFACES computed.
      const panelAllow = new Set([
        ...solo.panelIds,
        ...(solo.slots.left ? [solo.slots.left] : []),
        ...(solo.slots.tabs ?? []),
        ...(solo.slots.inspector ? [solo.slots.inspector] : []),
        ...solo.panelRailIds,
      ]);
      const toolAllow = new Set([...solo.toolIds, ...ALWAYS_IN_PALETTE]);
      expect(s.panels.map((p) => p.id)).toEqual(
        SOURCE.panels.filter((p) => panelAllow.has(p.id)).map((p) => p.id),
      );
      expect(s.tools.map((t) => t.id)).toEqual(
        SOURCE.tools.filter((t) => toolAllow.has(t.id)).map((t) => t.id),
      );
      expect(ids(s.panelRail.map((r) => r.panelId))).toEqual(
        ids(solo.panelRailIds),
      );
      for (const top of MENU_TOPS) {
        expect({ top, kept: s.keepMenu({ path: `${top}/Item` }) }).toEqual({
          top,
          kept: solo.menuTopLevels.includes(top),
        });
      }
      expect(s.modes).toEqual([
        {
          id: "design",
          title: solo.title,
          icon: "panel-canvas",
          order: 10,
          blurb: solo.blurb,
          slots: solo.slots,
          paletteSuggestions: [...solo.paletteSuggestions],
          menus: ["*"],
        },
      ]);
      expect(s.bundles).toEqual([{ id: solo.bundleId, lane: "boot" }]);
      expect(s.initialMode).toBe("design");
      expect(s.initialDocumentSizePt).toEqual(solo.documentSizePt);
      expect(s.plain).toBe(false);
      expect(s.problems).toEqual([]);
    });
  }

  test("the full editor registers everything and keeps the stored mode", () => {
    const { profile } = resolveProfile({ extends: "full" }, PRESETS);
    const s = applyProfile(profile, SOURCE);
    expect(s.panels).toEqual(SOURCE.panels);
    expect(s.tools).toEqual(SOURCE.tools);
    expect(s.panelRail).toEqual(SOURCE.panelRail);
    expect(s.modes).toEqual(SOURCE.modes);
    expect(s.bundles).toEqual(SOURCE.bundles);
    expect(s.keepMenu({ path: "Window/Layers" })).toBe(true);
    expect(s.initialMode).toBeUndefined();
    expect(s.initialDocumentSizePt).toBeUndefined();
    expect(s.plain).toBe(true);
  });

  test("excluding a menu from the whole bar drops its items", () => {
    const { profile } = resolveProfile(
      {
        extends: "full",
        adjust: [{ region: "menubar", op: "remove", match: "Window" }],
      },
      PRESETS,
    );
    const s = applyProfile(profile, SOURCE);
    expect(s.keepMenu({ path: "Window/Layers" })).toBe(false);
    expect(s.keepMenu({ path: "File/Open…" })).toBe(true);
  });

  test("a removed tool rail keeps only navigation", () => {
    const { profile } = resolveProfile(
      { regions: { "tool-rail": null } },
      PRESETS,
    );
    expect(applyProfile(profile, SOURCE).tools.map((t) => t.id)).toEqual(
      SOURCE.tools
        .filter((t) => ALWAYS_IN_PALETTE.includes(t.id))
        .map((t) => t.id),
    );
  });

  test("an unknown bundle and an unknown mode id are problems", () => {
    const { profile } = resolveProfile(
      {
        bundles: ["media.paged.nothing"],
        modes: [{ id: "fill", title: "Fill" }],
      },
      PRESETS,
    );
    const s = applyProfile(profile, SOURCE);
    expect(s.bundles).toEqual([]);
    expect(s.modes[0]!.id).toBe("design");
    expect(s.problems.map((p) => p.path).sort()).toEqual([
      "bundles",
      "modes[0].id",
    ]);
  });
});
