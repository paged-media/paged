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
/** Editor ADR 311, amended: path and shape tools are shared too. */
const SHARED_TOOLS = [
  FREE_TRANSFORM,
  "paged.tool.pen",
  "paged.tool.directSelect",
  "paged.tool.line",
  "paged.tool.rectangle",
  "paged.tool.ellipse",
  "paged.tool.polygon",
];

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
        for (const id of SHARED_TOOLS)
          expect(toolStaysInContext(id, ctx.toolIds), id).toBe(true);
        // The rule is real: another editing tool is still the way out.
        expect(toolStaysInContext("paged.tool.scissors", ctx.toolIds)).toBe(
          false,
        );
      }
    });
  }

  test("Free Transform, the Pen, Direct Selection and the shape tools are shared; the view tools stay too", () => {
    for (const id of SHARED_TOOLS)
      expect(CONTEXT_SHARED_TOOL_IDS).toContain(id);
    expect(toolStaysInContext("paged.tool.hand", [])).toBe(true);
    expect(toolStaysInContext("paged.tool.zoom", [])).toBe(true);
  });

  test("every solo profile keeps them, each once", () => {
    for (const profile of Object.values(SOLO_PROFILES)) {
      for (const id of PANELS)
        expect(profile.panelIds, profile.bundleId).toContain(id);
      for (const id of SHARED_TOOLS)
        expect(profile.toolIds, profile.bundleId).toContain(id);
      expect(new Set(profile.panelIds).size, profile.bundleId).toBe(
        profile.panelIds.length,
      );
      expect(new Set(profile.toolIds).size, profile.bundleId).toBe(
        profile.toolIds.length,
      );
    }
  });
});
