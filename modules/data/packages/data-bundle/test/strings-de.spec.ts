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

// paged.data in German (editor plan E10): with the German catalogue active,
// what the bundle registers and shows is in German, every data message has
// its German text, and English comes back when the catalogue is reset.
// Menu paths are identities and stay English; the shell translates their
// segments through the `menu` messages.

import { afterEach, describe, expect, it } from "bun:test";
import type { BundleHost } from "@paged-media/plugin-api";
import {
  BUILT_IN_LOCALES,
  createStrings,
  englishSource,
  setActiveStrings,
} from "@paged-media/strings";

import { CATEGORY, MENU } from "../src/messages";
import { contributeMenu } from "../src/menu";
import { dataObjectsPanel } from "../src/panels/objects-panel";
import { queryOptions } from "../src/panels/bindings-panel";
import { policyLabel } from "../src/refresh";
import { validateRemoteUrl } from "../src/remote";

const german = () => setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));

afterEach(() => setActiveStrings(createStrings()));

/** The menu paths `contributeMenu` registers. */
function menuPaths(): string[] {
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
  return paths;
}

describe("paged.data in German [strings]", () => {
  it("every data message has German text", () => {
    const de = BUILT_IN_LOCALES.de ?? {};
    const keys = Object.keys(englishSource()).filter((k) =>
      k.startsWith("data."),
    );
    expect(keys.length).toBeGreaterThan(300);
    expect(keys.filter((k) => !(k in de))).toEqual([]);
  });

  it("panels, labels and refusals follow the active catalogue", () => {
    german();
    expect(dataObjectsPanel().title).toBe("Datenübersicht");
    expect(policyLabel({ policy: "interval", secs: 30 })).toBe("alle 30 s");
    expect(queryOptions(["people"], [], new Map())[0]!.label).toBe(
      "Alle Zeilen von people",
    );
    expect(validateRemoteUrl("ftp://example.com/x.csv")).toBe(
      "Die URL der entfernten Quelle muss http(s) sein, nicht ftp://",
    );
    setActiveStrings(createStrings());
    expect(dataObjectsPanel().title).toBe("Data overview");
  });

  it("menu paths stay English; their rows and the category read German", () => {
    german();
    const paths = menuPaths();
    expect(paths).toContain("Data/Data query…");
    const de = createStrings("de", BUILT_IN_LOCALES.de);
    expect(de.t(MENU["Data query…"])).toBe("Datenabfrage…");
    expect(de.t(CATEGORY.Data)).toBe("Daten");
  });
});
