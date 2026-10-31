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

// Editor ADR 309, plan WP10.7 — the host's Effects, Transparency and
// Appearance panels act on any page item, so they are offered inside every
// module's edit context: no context claims them, and the applicability
// rule (`panelBelongsHere`) offers an unclaimed panel everywhere. The
// contexts below are the modules' own (their type and the panels they
// claim, as each bundle's activate declares them).

import { describe, expect, test } from "bun:test";
import { panelBelongsHere } from "@paged-media/shell";

import { SOLO_PROFILES } from "../../../src/solo/profiles";

const HOST_FX_PANELS = [
  "paged.effects",
  "paged.transparency",
  "paged.appearance",
];

/** Each module's edit contexts, as registered. */
const CONTEXTS = [
  { type: "wordDocument", panelIds: ["media.paged.doc.panel.outline"] },
  { type: "slideDeck", panelIds: [] },
  { type: "slideChart", panelIds: [] },
  { type: "sheet", panelIds: ["media.paged.sheet.panel.workbook"] },
  { type: "vectorGraphic", panelIds: ["media.paged.draw.panel.properties"] },
  { type: "rasterImage", panelIds: ["media.paged.image.panel.adjustments"] },
  { type: "webFrame", panelIds: ["media.paged.web.panel.source"] },
  { type: "dataBinding", panelIds: ["media.paged.data.panel.bindings"] },
];

const standingIn = (type: string | null) => ({
  editContext: type ? { type } : null,
  registries: { editContexts: { list: () => CONTEXTS } },
});

describe("host effect panels apply in every edit context [editor-shell.shared-panels-every-context]", () => {
  for (const ctx of [{ type: null }, ...CONTEXTS]) {
    test(`offered ${ctx.type ? `inside ${ctx.type}` : "outside any context"}`, () => {
      for (const id of HOST_FX_PANELS)
        expect(panelBelongsHere(standingIn(ctx.type), id)).toBe(true);
      // The rule is real: another module's own panel is not offered here.
      if (ctx.type === "wordDocument")
        expect(
          panelBelongsHere(
            standingIn(ctx.type),
            "media.paged.sheet.panel.workbook",
          ),
        ).toBe(false);
    });
  }

  test("every module's solo profile keeps them", () => {
    for (const profile of Object.values(SOLO_PROFILES))
      for (const id of HOST_FX_PANELS)
        expect(profile.panelIds, profile.bundleId).toContain(id);
  });
});
