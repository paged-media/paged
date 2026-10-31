/*
 * This file is part of paged (https://paged.media).
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

// View ▸ Guides & grid preferences… opens its dialog (editor ADR 287):
// the grid's spacing, subdivisions, colour and stacking and the smart
// guides' options, each showing the stored preference. Rendered
// server-side: the dialog is the open store's one reader.

import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";
import {
  createCommandRegistry,
  createEditorScope,
  EditorScopeProvider,
  resetViewPreferences,
  setViewPreferences,
} from "@paged-media/shell";

import {
  openViewPreferences,
  ViewPreferencesDialog,
} from "../../../src/panels/view-preferences-dialog";
import { buildViewCommands, VIEW_MENU_ITEMS } from "../../../src/view-commands";
import { memoryStorage } from "../settings/memory-storage";

afterEach(() => {
  unstubAllGlobals();
  resetViewPreferences();
});

describe("paged.view.guidesAndGridPreferences", () => {
  test("opens the dialog with the stored preferences; the menu row points at it", async () => {
    covers(
      "command:paged.view.guidesAndGridPreferences",
      "menu:View/Guides & grid preferences…",
      "setting:paged.viewPreferences",
    );
    stubGlobal("localStorage", memoryStorage());
    resetViewPreferences();
    setViewPreferences({ gridSubdivisions: 4, gridColor: "#336699" });
    const scope = createEditorScope();
    const registry = createCommandRegistry(() => ({ scope }) as never);
    for (const c of buildViewCommands({
      rotateView: () => {},
      resetRotation: () => {},
      openPreferences: () => openViewPreferences(scope),
    }))
      registry.register(c);
    const render = () =>
      renderToStaticMarkup(
        createElement(EditorScopeProvider, {
          scope,
          children: createElement(ViewPreferencesDialog),
        }),
      );
    expect(render()).toBe("");
    await registry.invoke("paged.view.guidesAndGridPreferences");
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toMatch(
      /data-view-pref="gridSubdivisions"[^>]*value="4"|value="4"[^>]*data-view-pref="gridSubdivisions"/,
    );
    expect(html).toContain('value="#336699"');
    for (const key of [
      "gridEvery",
      "gridsInBack",
      "angleGuides",
      "customAngle",
      "spacing",
      "rotateSnap",
      "intersections",
      "measurementLabels",
      "tolerancePx",
    ])
      expect(html).toContain(`data-view-pref="${key}"`);
    expect(
      VIEW_MENU_ITEMS.find(
        (m) => m.command === "paged.view.guidesAndGridPreferences",
      )?.path,
    ).toBe("View/Guides & grid preferences…");
  });
});
