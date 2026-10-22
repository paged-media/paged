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

// paged.sheet in German (plan E10): with the German catalogue active, the
// bundle's panel schema, menu labels, token labels and messages read in
// German; English stays the default.

import { afterEach, describe, expect, it } from "bun:test";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
  t,
} from "@paged-media/strings";
import type { BundleHost } from "@paged-media/plugin-api";

import { GRID, NOTICES } from "../src/messages";
import { contributeMenu } from "../src/menu";
import { tokenLabel } from "../src/panels/format-section";
import { sheetPropertiesPanel } from "../src/panels/properties-panel";

const german = () => setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));

describe("paged.sheet strings", () => {
  afterEach(() => setActiveStrings(createStrings()));

  it("reads English by default", () => {
    expect(sheetPropertiesPanel().title).toBe("Sheet properties");
    expect(t(GRID.matches, { count: 1 })).toBe("1 match.");
  });

  it("reads German with the German catalogue", () => {
    german();
    const panel = sheetPropertiesPanel();
    expect(panel.title).toBe("Tabelleneigenschaften");
    expect(panel.sections.map((s) => s.title)).toContain("Benannter Bereich");
    expect(t(GRID.matches, { count: 3 })).toBe("3 Treffer.");
    expect(t(NOTICES.cantCopy, { reason: "x" })).toBe(
      "Kopieren nicht möglich: x.",
    );
    expect(tokenLabel(t, "stackedColumn")).toBe("Gestapelte Säule");
    expect(tokenLabel(t, "unknownKind")).toBe("UnknownKind");
  });

  it("labels its menu segments and command category, which stay English", () => {
    german();
    const paths: string[] = [];
    const host = {
      contribute: {
        menu: (m: { path: string }) => {
          paths.push(m.path);
          return { dispose() {} };
        },
      },
      log: { info() {} },
    } as unknown as BundleHost;
    contributeMenu(host).dispose();
    expect(paths).toContain("Sheet/Insert rows");
    expect(t("menu.Sheet")).toBe("Tabelle");
    expect(t("menu.Insert rows")).toBe("Zeilen einfügen");
    expect(t("commandCategory.Sheet")).toBe("Tabelle");
  });
});
