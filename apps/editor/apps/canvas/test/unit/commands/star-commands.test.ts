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

// `paged.insert.star`: bare it opens the dialog and writes nothing; with a
// payload it inserts (live star where the engine draws one, else a plain path).

import { describe, expect, test } from "bun:test";

import { createCommandRegistry, createEditorScope } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  buildStarCommands,
  hasStarParams,
  PAGED_INSERT_STAR,
  STAR_MENU_ITEMS,
} from "../../../src/star-commands";

describe("paged.insert.star [editor-shell.insert-star]", () => {
  test("a payload is an insert; none (or unrelated keys) opens the dialog", () => {
    covers("command:paged.insert.star");
    expect(hasStarParams(undefined)).toBe(false);
    expect(hasStarParams({ page: "p" })).toBe(false);
    expect(hasStarParams({ radius1: 40 })).toBe(true);
    expect(hasStarParams({ rotationDeg: 0 })).toBe(true);
  });

  test("run bare it reports nothing and does not touch the document", async () => {
    covers("command:paged.insert.star");
    const reports: string[] = [];
    const registry = createCommandRegistry(() => ({
      scope: createEditorScope(),
    }));
    for (const c of buildStarCommands(
      (_s, m) => reports.push(m),
      () => {},
    ))
      registry.register(c);
    await registry.invoke(PAGED_INSERT_STAR);
    expect(reports).toEqual([]);
  });

  test("the menu row is Object > Insert star…", () => {
    covers("menu:Object/Insert star…");
    expect(STAR_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["Object/Insert star…", PAGED_INSERT_STAR],
    ]);
  });
});
