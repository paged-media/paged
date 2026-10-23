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

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { createElement } from "react";

import {
  StringsProvider,
  activeStrings,
  createStrings,
  defineMessages,
  defineTranslations,
  englishSource,
  format,
  loadLocale,
  t,
  useStrings,
} from "../src/index";

const M = defineMessages("test", {
  hello: "Hello, {name}.",
  fields: "{count, plural, one {# field} other {# fields}} to fill in",
  only: "Only in English",
});

describe("strings", () => {
  test("a key answers its English text, a locale overrides it, a missing key falls back", () => {
    expect(createStrings().t(M.hello, { name: "Ada" })).toBe("Hello, Ada.");
    const de = createStrings("de", { [M.hello]: "Hallo, {name}." });
    expect(de.t(M.hello, { name: "Ada" })).toBe("Hallo, Ada.");
    expect(de.t(M.only)).toBe("Only in English");
    expect(englishSource()[M.only]).toBe("Only in English");
  });

  test("plurals follow the locale's rules and print the number", () => {
    expect(
      format(
        "{count, plural, one {# field} other {# fields}}",
        { count: 1 },
        "en",
      ),
    ).toBe("1 field");
    expect(createStrings().t(M.fields, { count: 3 })).toBe(
      "3 fields to fill in",
    );
    expect(format("{n, plural, =0 {none} other {#}}", { n: 0 }, "en")).toBe(
      "none",
    );
    expect(format("{n, plural, other {# Felder}}", { n: 1200 }, "de")).toBe(
      "1.200 Felder",
    );
  });

  test("the same key defined with other text is a mistake", () => {
    expect(() => defineMessages("test", { hello: "Hi" })).toThrow(
      /defined twice/,
    );
  });

  test("the provider sets what components and plain code read", () => {
    const de = createStrings("de", { [M.hello]: "Hallo, {name}." });
    function Greeting() {
      return createElement(
        "span",
        null,
        useStrings().t(M.hello, { name: "Ada" }),
      );
    }
    const view = render(
      createElement(StringsProvider, { strings: de }, createElement(Greeting)),
    );
    expect(view.container.textContent).toBe("Hallo, Ada.");
    expect(activeStrings().locale).toBe("de");
    expect(t(M.hello, { name: "Bo" })).toBe("Hallo, Bo.");
    view.unmount();
  });

  test("a locale loads from the host's messages or from the asset base, else the English stays", async () => {
    const given = await loadLocale("de", { messages: { [M.only]: "Nur" } });
    expect(given.strings.t(M.only)).toBe("Nur");
    const fetched = await loadLocale("de", {
      assetBase: "https://cdn.example/editor/",
      fetch: (async (url: string) =>
        url === "https://cdn.example/editor/locales/de.json"
          ? new Response(JSON.stringify({ [M.only]: "Geladen" }))
          : new Response("", { status: 404 })) as unknown as typeof fetch,
    });
    expect(fetched.strings.t(M.only)).toBe("Geladen");
    const missing = await loadLocale("fr", {
      fetch: (async () =>
        new Response("", { status: 404 })) as unknown as typeof fetch,
    });
    expect(missing.problem).toMatch(/no fr catalogue/);
    expect(missing.strings.t(M.only)).toBe("Only in English");
  });
});

describe("translations a package registers", () => {
  test("join the shipped catalogue of their language", async () => {
    const N = defineMessages("test2", { hi: "Hi" });
    defineTranslations("de", { [N.hi]: "Servus" });
    expect((await loadLocale("de")).strings.t(N.hi)).toBe("Servus");
    expect(() => defineTranslations("de", { [N.hi]: "Hallo" })).toThrow(
      /translated twice/,
    );
  });
});
