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

// Editor ADR 311, plan WP10.7 — Gradients, Picture adjustments, History
// and the Free Transform tool in every module's edit context: no context
// claims the panels, picking the tool does not leave a context, and every
// solo profile keeps all four. The contexts are the modules' own (their
// type, the tools and the panels each bundle's activate declares).

import { describe, expect, test } from "bun:test";
import {
  CONTEXT_SHARED_TOOL_IDS,
  panelBelongsHere,
  toolStaysInContext,
} from "@paged-media/shell";

import { SOLO_PROFILES } from "../../../src/solo/profiles";

const PANELS = [
  "paged.gradients",
  "paged.picture-adjustments",
  "paged.history",
];
const FREE_TRANSFORM = "paged.tool.freeTransform";

/** Each module's edit contexts, as registered. */
const CONTEXTS = [
  {
    type: "wordDocument",
    toolIds: ["paged.tool.type", "paged.tool.select"],
    panelIds: ["media.paged.doc.panel.outline"],
  },
  { type: "slideDeck", toolIds: null, panelIds: [] },
  {
    type: "sheet",
    toolIds: [],
    panelIds: ["media.paged.sheet.panel.workbook"],
  },
  {
    type: "vectorGraphic",
    toolIds: ["media.paged.draw.tool.addAnchor"],
    panelIds: ["media.paged.draw.panel.properties"],
  },
  {
    type: "rasterImage",
    toolIds: [
      "media.paged.image.tool.brush",
      "media.paged.image.tool.transform",
    ],
    panelIds: ["media.paged.image.panel.adjustments"],
  },
  { type: "webFrame", toolIds: [], panelIds: ["media.paged.web.panel.source"] },
  {
    type: "dataBinding",
    toolIds: [],
    panelIds: ["media.paged.data.panel.bindings"],
  },
];

const standingIn = (type: string | null) => ({
  editContext: type ? { type } : null,
  registries: { editContexts: { list: () => CONTEXTS } },
});

describe("the shared host panels and Free Transform in every edit context [editor-shell.shared-panels-every-context]", () => {
  for (const ctx of [{ type: null, toolIds: null }, ...CONTEXTS]) {
    test(`offered ${ctx.type ? `inside ${ctx.type}` : "outside any context"}`, () => {
      for (const id of PANELS)
        expect(panelBelongsHere(standingIn(ctx.type), id), id).toBe(true);
      if (ctx.toolIds) {
        expect(toolStaysInContext(FREE_TRANSFORM, ctx.toolIds)).toBe(true);
        // The rule is real: another editing tool is still the way out.
        expect(toolStaysInContext("paged.tool.pen", ctx.toolIds)).toBe(false);
      }
    });
  }

  test("Free Transform is the shared tool; the view tools stay too", () => {
    expect(CONTEXT_SHARED_TOOL_IDS).toContain(FREE_TRANSFORM);
    expect(toolStaysInContext("paged.tool.hand", [])).toBe(true);
    expect(toolStaysInContext("paged.tool.zoom", [])).toBe(true);
  });

  test("every solo profile keeps them, each once", () => {
    for (const profile of Object.values(SOLO_PROFILES)) {
      for (const id of PANELS)
        expect(profile.panelIds, profile.bundleId).toContain(id);
      expect(profile.toolIds, profile.bundleId).toContain(FREE_TRANSFORM);
      expect(new Set(profile.panelIds).size, profile.bundleId).toBe(
        profile.panelIds.length,
      );
      expect(new Set(profile.toolIds).size, profile.bundleId).toBe(
        profile.toolIds.length,
      );
    }
  });
});
