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

// Deprecated ids (PM-0013, amendment 2): an old id in a host's profile or feature set is
// read as its replacement, an id with no replacement is dropped, and each
// old id is reported once.

import { describe, expect, test } from "bun:test";

import {
  createIdAliases,
  deprecationWarning,
  migrateProfileIds,
  type IdDeprecation,
} from "../../src/profile";

const LIST: IdDeprecation[] = [
  {
    id: "panel:paged.old-layers",
    replacement: "panel:paged.layers",
    deprecatedIn: "0.76.0",
    removeIn: "0.78.0",
  },
  {
    id: "command:paged.old.lock",
    replacement: "command:paged.object.lock",
    deprecatedIn: "0.76.0",
    removeIn: "0.78.0",
  },
  {
    id: "tool:paged.gone",
    replacement: null,
    deprecatedIn: "0.76.0",
    removeIn: "0.78.0",
  },
];

describe("deprecated ids", () => {
  test("a feature id maps to its replacement; a glob and a current id stay", () => {
    const aliases = createIdAliases(LIST);
    expect(aliases.feature("panel:paged.old-layers")).toBe(
      "panel:paged.layers",
    );
    expect(aliases.feature("tool:paged.gone")).toBeNull();
    expect(aliases.feature("command:paged.object.*")).toBe(
      "command:paged.object.*",
    );
    expect(aliases.feature("panel:paged.layers")).toBe("panel:paged.layers");
  });

  test("each old id is reported once, to listeners and in used()", () => {
    const aliases = createIdAliases(LIST);
    const seen: string[] = [];
    aliases.subscribe((d) => seen.push(d.id));
    aliases.feature("panel:paged.old-layers");
    aliases.bare("paged.old-layers", ["panel"]);
    aliases.feature("command:paged.old.lock");
    expect(seen).toEqual(["panel:paged.old-layers", "command:paged.old.lock"]);
    expect(aliases.used().map((d) => d.id)).toEqual(seen);
  });

  test("a profile's features, panels, regions, edits and modes are migrated", () => {
    const aliases = createIdAliases(LIST);
    const out = migrateProfileIds(
      {
        extends: "full",
        features: {
          "panel:paged.old-layers": false,
          "tool:paged.gone": false,
          "command:paged.object.*": true,
        },
        panels: ["paged.old-layers", "paged.pages"],
        regions: {
          "tool-rail": { items: ["paged.gone", "paged.select"] },
          header: {
            items: [{ kind: "group", id: "g", items: ["paged.old.lock"] }],
          },
          right: { items: "all" },
        },
        adjust: [{ region: "right", op: "remove", match: "paged.old-layers" }],
        modes: [
          {
            id: "m",
            title: "M",
            slots: { left: "paged.old-layers", tabs: ["paged.old-layers"] },
            paletteSuggestions: ["paged.old.lock"],
          },
        ],
      },
      aliases,
    );
    expect(out.features).toEqual({
      "panel:paged.layers": false,
      "command:paged.object.*": true,
    });
    expect(out.panels).toEqual(["paged.layers", "paged.pages"]);
    expect(out.regions?.["tool-rail"]).toEqual({ items: ["paged.select"] });
    expect(out.regions?.header).toEqual({
      items: [{ kind: "group", id: "g", items: ["paged.object.lock"] }],
    });
    expect(out.regions?.right).toEqual({ items: "all" });
    expect(out.adjust).toEqual([
      { region: "right", op: "remove", match: "paged.layers" },
    ]);
    expect(out.modes).toEqual([
      {
        id: "m",
        title: "M",
        slots: { left: "paged.layers", tabs: ["paged.layers"] },
        paletteSuggestions: ["paged.object.lock"],
      },
    ]);
    expect(aliases.used()).toHaveLength(3);
  });

  test("the warning names the window and the replacement", () => {
    expect(deprecationWarning(LIST[0]!)).toBe(
      '"panel:paged.old-layers" is deprecated since 0.76.0 and is removed in 0.78.0; it is read as "panel:paged.layers"',
    );
    expect(deprecationWarning(LIST[2]!)).toContain("no replacement");
  });
});
