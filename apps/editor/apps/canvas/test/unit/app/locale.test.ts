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

// The page's language (app/locale.ts): the URL, then the user's stored
// choice, then the browser's languages against the shipped catalogues,
// then English.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  chooseLocale,
  LOCALE_KEY,
  needsCatalogue,
} from "../../../src/app/locale";

const storage = (value: string | null) => ({
  getItem: (key: string) => (key === LOCALE_KEY ? value : null),
});
const base = {
  search: "",
  storage: storage(null),
  languages: [] as string[],
  shipped: ["de"],
};

describe("the page's language", () => {
  test("the URL comes first", () => {
    expect(
      chooseLocale({
        ...base,
        search: "?profile=x&locale=fr",
        storage: storage("de"),
        languages: ["de-DE"],
      }),
    ).toEqual({ locale: "fr", from: "url" });
  });

  test("then the user's stored choice", () => {
    covers("setting:paged.locale");
    expect(
      chooseLocale({ ...base, storage: storage("de"), languages: ["en-US"] }),
    ).toEqual({ locale: "de", from: "choice" });
    // A choice of English holds against a German browser.
    expect(
      chooseLocale({ ...base, storage: storage("en"), languages: ["de-DE"] }),
    ).toEqual({ locale: "en", from: "choice" });
  });

  test("a stored value that is no language tag, or a blocked storage, is no choice", () => {
    covers("setting:paged.locale");
    expect(
      chooseLocale({ ...base, storage: storage("<x>"), languages: ["de"] }),
    ).toEqual({ locale: "de", from: "browser" });
    expect(
      chooseLocale({
        ...base,
        storage: {
          getItem: () => {
            throw new Error("SecurityError");
          },
        },
        languages: ["de"],
      }),
    ).toEqual({ locale: "de", from: "browser" });
    expect(chooseLocale({ ...base, storage: null }).locale).toBe("en");
  });

  test("then the browser's languages, the first one with a shipped catalogue", () => {
    expect(
      chooseLocale({ ...base, languages: ["fr-FR", "de-AT", "en"] }),
    ).toEqual({ locale: "de-AT", from: "browser" });
    expect(chooseLocale({ ...base, languages: ["de"] }).locale).toBe("de");
  });

  test("English before a shipped language stays English", () => {
    expect(chooseLocale({ ...base, languages: ["fr", "en-GB", "de"] })).toEqual(
      { locale: "en-GB", from: "browser" },
    );
  });

  test("nothing shipped for any of them: English", () => {
    expect(chooseLocale({ ...base, languages: ["fr-FR", "it"] })).toEqual({
      locale: "en",
      from: "default",
    });
    expect(chooseLocale(base)).toEqual({ locale: "en", from: "default" });
  });

  test("only a language other than English loads a catalogue", () => {
    expect(needsCatalogue("en")).toBe(false);
    expect(needsCatalogue("en-GB")).toBe(false);
    expect(needsCatalogue("de-AT")).toBe(true);
  });
});
