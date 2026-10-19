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

// Object ▸ Effects ▸ Global light… opens the document's global-light form
// (angle + altitude, the two document-scope PropertyFields). The command
// only opens it; the fields write through the object model, which the
// PropertyField tests own. Rendered server-side: the dialog is the store's
// one reader.

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { covers } from "@paged-media/test-kit";

// The fields bind to the live document; stand them in with their props.
const shell = await import("@paged-media/shell");
mock.module("@paged-media/shell", () => ({
  ...shell,
  PropertyField: (p: { path: string; label: string }) =>
    createElement("span", { "data-field": p.path }, p.label),
}));
const { createCommandRegistry } = shell;
const { GLOBAL_LIGHT_COMMANDS, GLOBAL_LIGHT_MENU_ITEMS, GlobalLightDialog } =
  await import("../../../src/panels/global-light-dialog");

describe("paged.effects.globalLight", () => {
  test("opens the dialog with the document's angle and altitude; the menu item points at it", async () => {
    covers("command:paged.effects.globalLight");
    const registry = createCommandRegistry(() => null);
    for (const c of GLOBAL_LIGHT_COMMANDS) registry.register(c);
    const render = () => renderToStaticMarkup(createElement(GlobalLightDialog));
    expect(render()).toBe("");
    // Ungated: it works with no document state (the fields say so).
    expect(registry.get("paged.effects.globalLight")?.when).toBeUndefined();
    await registry.invoke("paged.effects.globalLight");
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-field="documentGlobalLightAngle"');
    expect(html).toContain('data-field="documentGlobalLightAltitude"');
    // A second invoke keeps one dialog open.
    await registry.invoke("paged.effects.globalLight");
    expect(render().match(/role="dialog"/g)).toHaveLength(1);
    expect(GLOBAL_LIGHT_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["Object/Effects/Global light…", "paged.effects.globalLight"],
    ]);
  });
});
