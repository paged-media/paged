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

// The editor's presets (docs/composable-editor.md §5.4): named profiles a
// host or a URL starts from. `full` is the editor as it is; `solo:<name>`
// is each solo profile (ADR 213) expressed as a profile. Until the app
// applies profiles (plan task A4) the solo presets are derived from
// `SOLO_PROFILES`, so the two cannot drift; A4 moves the data here.

import type { EditorProfile } from "@paged-media/shell";

import { SOLO_PROFILES, type SoloProfile } from "../solo/profiles";

/** A solo profile as a preset. Field for field what `main.tsx` filters by. */
export function soloPreset(profile: SoloProfile): EditorProfile {
  return {
    extends: "full",
    title: profile.title,
    blurb: profile.blurb,
    bundles: [profile.bundleId],
    panels: [...profile.panelIds],
    modes: [
      {
        id: "design",
        title: profile.title,
        blurb: profile.blurb,
        slots: profile.slots,
        paletteSuggestions: [...profile.paletteSuggestions],
        menus: ["*"],
      },
    ],
    regions: {
      // The tools beyond the navigation set the shell always keeps.
      "tool-rail": { items: [...profile.toolIds] },
      menubar: { items: [...profile.menuTopLevels] },
      "panel-rail": { items: [...profile.panelRailIds] },
      // One mode: the switcher, and the zoom control it holds, are not rendered.
      "mode-bar": null,
    },
    documentSizePt: profile.documentSizePt,
    storageScope: `.solo.${profile.bundleId}`,
  };
}

/** `solo:draw` for `paged.draw`, and so on. */
export function soloPresetId(soloName: string): string {
  return `solo:${soloName.replace(/^paged\./, "")}`;
}

function buildPresets(): Record<string, EditorProfile> {
  const presets: Record<string, EditorProfile> = { full: {} };
  for (const [name, profile] of Object.entries(SOLO_PROFILES)) {
    presets[soloPresetId(name)] = soloPreset(profile);
  }
  return presets;
}

/** Every preset, by id. */
export const PRESETS: Readonly<Record<string, EditorProfile>> = buildPresets();
