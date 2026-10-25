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

import {
  ALWAYS_IN_PALETTE,
  BUNDLES_ENTRY,
  type EditorProfile,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import { SOLO_PROFILES, type SoloProfile } from "../solo/profiles";

const M = defineMessages("app.profilesPresets", {
  fillIn: "Fill in",
  fillInBlurb: "Fill in the template's fields",
  form: "Form",
  formBlurb: "Fill in the template's fields in a form, with a preview",
  view: "View",
});

/** A solo profile as a preset. Field for field what `main.tsx` filters by. */
export function soloPreset(profile: SoloProfile): EditorProfile {
  return {
    extends: "full",
    title: profile.title,
    // Getters: the presets are built when the module loads, the words are
    // read when a profile resolves, in the editor's locale.
    get blurb() {
      return profile.blurb;
    },
    bundles: [profile.bundleId],
    panels: [...profile.panelIds],
    modes: [
      {
        id: "design",
        title: profile.title,
        get blurb() {
          return profile.blurb;
        },
        slots: profile.slots,
        paletteSuggestions: [...profile.paletteSuggestions],
        menus: ["*"],
      },
    ],
    regions: {
      // The navigation tools, the profile's host tools, then whatever the
      // one bundle contributes: its own tools, its menu, its rail panels.
      "tool-rail": {
        items: [...ALWAYS_IN_PALETTE, ...profile.toolIds, BUNDLES_ENTRY],
      },
      menubar: { items: [...profile.menuTopLevels, BUNDLES_ENTRY] },
      "panel-rail": { items: [...profile.panelRailIds, BUNDLES_ENTRY] },
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

/** Fill in a template (docs/composable-editor.md §5.4): the canvas and the
 *  template form, a short tool rail, and Undo, Redo and Save; the session
 *  is a filler, so the engine lets it change only what the template
 *  permits. On a phone the canvas fills the screen and the field tapped
 *  on it opens in a sheet below (editor ADR 294). */
const TEMPLATE_FILL: EditorProfile = {
  extends: "full",
  get title() {
    return t(M.fillIn);
  },
  role: "filler",
  panels: ["paged.template.form"],
  modes: [
    {
      id: "fill",
      get title() {
        return t(M.fillIn);
      },
      get blurb() {
        return t(M.fillInBlurb);
      },
      slots: { left: "" },
    },
  ],
  regions: {
    header: {
      items: ["paged.editor.undo", "paged.editor.redo", "paged.file.savePaged"],
    },
    form: { items: ["paged.template.form"] },
    right: null,
    menubar: null,
    "context-toolbar": null,
    "tool-rail": {
      items: [
        "paged.tool.select",
        "paged.tool.type",
        "paged.tool.hand",
        "paged.tool.zoom",
      ],
    },
    left: null,
    "panel-rail": null,
    "mode-bar": null,
    palette: null,
  },
  canvas: { rulers: false, titleBar: false, thumbnails: true },
  features: { "chrome:context-menu": false },
  compact: "field-sheet",
  storageScope: ".fill",
};

/** Fill in a template through a form (docs/composable-editor.md §5.4): the
 *  form beside a preview that pans and zooms and edits nothing. On a phone
 *  the form comes first and the preview folds away above it (editor ADR
 *  293). The host adds its actions bar. */
const FORM: EditorProfile = {
  extends: "full",
  get title() {
    return t(M.form);
  },
  role: "filler",
  panels: ["paged.template.form"],
  modes: [
    {
      id: "form",
      get title() {
        return t(M.form);
      },
      get blurb() {
        return t(M.formBlurb);
      },
      slots: { left: "" },
    },
  ],
  regions: {
    header: null,
    menubar: null,
    "context-toolbar": null,
    "tool-rail": null,
    left: null,
    right: null,
    "panel-rail": null,
    "mode-bar": null,
    palette: null,
    form: { items: ["paged.template.form"] },
  },
  canvas: { rulers: false, titleBar: false, thumbnails: false, preview: true },
  features: { "chrome:context-menu": false },
  compact: "form-first",
  storageScope: ".form",
};

/** Look at a document: the canvas and its pages, nothing to change. */
const VIEWER: EditorProfile = {
  extends: "full",
  get title() {
    return t(M.view);
  },
  role: "viewer",
  panels: [],
  modes: [
    {
      id: "view",
      get title() {
        return t(M.view);
      },
      slots: { left: "" },
    },
  ],
  regions: {
    header: null,
    menubar: null,
    "context-toolbar": null,
    "tool-rail": { items: ["paged.tool.hand", "paged.tool.zoom"] },
    left: null,
    right: null,
    "panel-rail": null,
    "mode-bar": null,
    palette: null,
  },
  canvas: { rulers: false, titleBar: false, thumbnails: true },
  features: { "chrome:context-menu": false },
  storageScope: ".viewer",
};

function buildPresets(): Record<string, EditorProfile> {
  const presets: Record<string, EditorProfile> = {
    full: {},
    "template-fill": TEMPLATE_FILL,
    form: FORM,
    viewer: VIEWER,
  };
  for (const [name, profile] of Object.entries(SOLO_PROFILES)) {
    presets[soloPresetId(name)] = soloPreset(profile);
  }
  return presets;
}

/** Every preset, by id. */
export const PRESETS: Readonly<Record<string, EditorProfile>> = buildPresets();
