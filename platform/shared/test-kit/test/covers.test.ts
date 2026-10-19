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

import { describe, expect, it } from "bun:test";

import { covers, SURFACE_KINDS, type SurfaceId } from "../src/index.ts";

describe("covers", () => {
  it("is a no-op that returns nothing", () => {
    // Called through an alias: the gate reads only calls of the bare
    // identifier `covers`, and this test asserts nothing about a surface.
    const mark = covers;
    expect(
      mark("command:paged.editor.undo", "panel:paged.layers"),
    ).toBeUndefined();
  });

  it("names the ten surface kinds the gate enumerates", () => {
    expect([...SURFACE_KINDS]).toEqual([
      "command",
      "panel",
      "tool",
      "menu",
      "keybinding",
      "setting",
      "cli",
      "script",
      "importer",
      "exporter",
    ]);
  });

  it("types an id as <kind>:<id>", () => {
    const ok: SurfaceId = "cli:paged export-pdf";
    // @ts-expect-error an id without a known kind is not a SurfaceId
    const bad: SurfaceId = "widget:paged.undo";
    expect([ok, bad]).toHaveLength(2);
  });
});
