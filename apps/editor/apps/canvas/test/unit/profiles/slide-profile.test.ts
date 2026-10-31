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

// The slide profile (ADR 307): `?solo=paged.slide` is PowerPoint's Normal
// view. The slide at the deck's size, the Slides rail on the left, the
// slide's panels in the right dock; every plugin id it names is one the
// slide bundle's manifest declares (a renamed panel fails here, not in the
// UI), and the palette suggests commands the bundle registers.

import { describe, expect, test } from "bun:test";

import slideBundle from "@paged-media/slide";
import { covers } from "@paged-media/test-kit";

import { profileFromSearch } from "../../../src/profiles/from-url";
import { SOLO_PROFILES } from "../../../src/solo/profiles";

const slide = SOLO_PROFILES["paged.slide"]!;
const manifest = slideBundle.manifest;
const pluginPanels = new Set(manifest.contributes?.panels ?? []);

describe("the slide profile", () => {
  test("?solo=paged.slide boots the slide bundle alone at PowerPoint's 16:9 slide size", () => {
    covers("setting:url.solo");
    const { profile, problems } = profileFromSearch("?solo=paged.slide");
    expect(problems).toEqual([]);
    expect(profile.bundles).toEqual(["media.paged.slide"]);
    expect(profile.documentSizePt).toEqual([960, 540]);
    expect(profile.storageScope).toBe(".solo.media.paged.slide");
    expect(profile.regions["mode-bar"]).toBeNull();
    // Landscape, like every deck.
    expect(slide.documentSizePt[0]).toBeGreaterThan(slide.documentSizePt[1]);
  });

  test("Normal view: the Slides rail on the left, the slide's panels and Comments in the right dock", () => {
    expect(slide.slots.left).toBe("media.paged.slide.panel.slides");
    expect(slide.slots.tabs).toEqual([
      "media.paged.slide.panel.slide",
      "media.paged.slide.panel.transition",
      "media.paged.slide.panel.placeholder",
      "media.paged.slide.panel.deck",
      "media.paged.slide.panel.comments",
      "media.paged.slide.panel.notes",
    ]);
    const named = [
      slide.slots.left,
      ...(slide.slots.tabs ?? []),
      ...slide.panelRailIds,
    ].filter((id) => id.startsWith("media.paged.slide."));
    for (const id of named) expect(pluginPanels.has(id), id).toBe(true);
    // No host panel id is a plugin id in disguise.
    for (const id of slide.panelIds)
      expect(id.startsWith("paged."), id).toBe(true);
  });

  test("menus as PowerPoint needs them, from the host's own; no page-layout surfaces", () => {
    expect(slide.menuTopLevels).toEqual([
      "File",
      "Edit",
      "View",
      "Type",
      "Object",
      "Window",
      "Help",
    ]);
    for (const gone of [
      "paged.pages",
      "paged.masters",
      "paged.spreads",
      "paged.preflight",
      "paged.separations",
      "paged.stories",
    ])
      expect(slide.panelIds).not.toContain(gone);
    expect(slide.menuTopLevels).not.toContain("Layout");
  });

  test("the palette suggests slide commands the bundle declares", () => {
    const commands = new Set(manifest.contributes?.commands ?? []);
    expect(slide.paletteSuggestions.length).toBeGreaterThan(0);
    for (const id of slide.paletteSuggestions)
      expect(commands.has(id), id).toBe(true);
  });
});
