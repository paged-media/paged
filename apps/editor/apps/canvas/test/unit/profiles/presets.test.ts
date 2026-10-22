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

// The presets against the solo profiles they stand for: resolving
// `solo:<name>` must yield exactly the bundle, panels, tools, menus, rail,
// mode, size and storage scope that `main.tsx` builds from the
// `SoloProfile` today (ADR 213), or the solo journeys would change when the
// app starts applying profiles.

import { describe, expect, test } from "bun:test";

import {
  ALWAYS_IN_PALETTE,
  BUNDLES_ENTRY,
  resolveProfile,
} from "@paged-media/shell";

import { profileFromSearch } from "../../../src/profiles/from-url";
import { PRESETS, soloPresetId } from "../../../src/profiles/presets";
import { SOLO_PROFILES } from "../../../src/solo/profiles";

describe("solo presets", () => {
  for (const [name, solo] of Object.entries(SOLO_PROFILES)) {
    test(`${name} resolves to its solo profile`, () => {
      const { profile, problems } = resolveProfile(
        { extends: soloPresetId(name) },
        PRESETS,
      );
      expect(problems).toEqual([]);
      expect(profile.chain).toEqual(["full", soloPresetId(name)]);
      expect(profile.bundles).toEqual([solo.bundleId]);
      expect(profile.panels).toEqual([...solo.panelIds]);
      expect(profile.regions["tool-rail"]).toEqual({
        kind: "list",
        items: [...ALWAYS_IN_PALETTE, ...solo.toolIds, BUNDLES_ENTRY],
      });
      expect(profile.regions.menubar).toEqual({
        kind: "list",
        items: [...solo.menuTopLevels, BUNDLES_ENTRY],
      });
      expect(profile.regions["panel-rail"]).toEqual({
        kind: "list",
        items: [...solo.panelRailIds, BUNDLES_ENTRY],
      });
      expect(profile.regions["mode-bar"]).toBeNull();
      expect(profile.modes).toEqual([
        {
          id: "design",
          title: solo.title,
          blurb: solo.blurb,
          slots: solo.slots,
          paletteSuggestions: [...solo.paletteSuggestions],
          menus: ["*"],
        },
      ]);
      expect(profile.documentSizePt).toEqual(solo.documentSizePt);
      expect(profile.storageScope).toBe(`.solo.${solo.bundleId}`);
    });
  }
});

describe("profileFromSearch", () => {
  test("no parameter is the full editor", () => {
    const { profile, problems } = profileFromSearch("");
    expect(problems).toEqual([]);
    expect(profile.chain).toEqual(["full"]);
    expect(profile.bundles).toBe("all");
    expect(profile.storageScope).toBe("");
  });

  test("?solo= and ?profile= name the same preset", () => {
    const a = profileFromSearch("?solo=paged.draw").profile;
    const b = profileFromSearch("?profile=solo:draw").profile;
    expect(a).toEqual(b);
    expect(a.bundles).toEqual(["media.paged.draw"]);
  });

  test("an unknown name is the full editor with a problem", () => {
    const { profile, problems } = profileFromSearch("?solo=paged.nothing");
    expect(profile.bundles).toBe("all");
    expect(problems).toHaveLength(1);
  });
});
