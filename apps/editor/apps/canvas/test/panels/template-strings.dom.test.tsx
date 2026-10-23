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

// The words of filling in a template in two languages (plan E4): the form
// says the same thing in English and in German, a refusal follows the
// locale, and the German catalogue covers every message of the fill
// experience, with no key the code does not define.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { refusalText } from "@paged-media/panel-kit";
import {
  BUILT_IN_LOCALES,
  createStrings,
  englishSource,
  setActiveStrings,
} from "@paged-media/strings";

import { hostCommands } from "../../src/app/instance";
import { TemplateFormPanel } from "../../src/panels/template/form-panel";
import "../../src/panels/template/module-field";
import { mountPanel, unmountAll } from "./harness";

afterEach(() => {
  unmountAll();
  setActiveStrings(createStrings());
});

/** The namespaces of the fill experience (phase 1). */
const FILL = [
  "engineError.",
  "hostAction.",
  "node.",
  "refusal.",
  "templateForm.",
  "templateProblem.",
  "writeCode.",
];

describe("the fill experience in two languages", () => {
  test("the form speaks the editor's language", async () => {
    covers("panel:paged.template.form");
    let h = await mountPanel(TemplateFormPanel, {
      id: "paged.template.form",
      document: "blank",
    });
    expect(
      h.root.querySelector("[data-template-form-empty]")?.textContent,
    ).toBe("This document has no fields to fill in.");
    unmountAll();
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES["de"]));
    h = await mountPanel(TemplateFormPanel, {
      id: "paged.template.form",
      document: "blank",
    });
    expect(
      h.root.querySelector("[data-template-form-empty]")?.textContent,
    ).toBe("Dieses Dokument hat keine Felder zum Ausfüllen.");
  });

  test("refusals and host actions follow the locale", () => {
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES["de"]));
    expect(refusalText({ kind: "notPermitted", details: {} })).toBe(
      "Dieser Teil der Vorlage kann nicht geändert werden.",
    );
    expect(
      hostCommands({ submit() {}, close() {}, back() {} }).map((c) => c.title),
    ).toEqual(["Absenden", "Schließen", "Zurück"]);
  });

  test("the German catalogue covers the fill experience and names only defined keys", () => {
    const english = englishSource();
    const de = BUILT_IN_LOCALES["de"]!;
    const fill = Object.keys(english).filter((k) =>
      FILL.some((ns) => k.startsWith(ns)),
    );
    expect(fill.length).toBeGreaterThan(40);
    expect(fill.filter((k) => !(k in de))).toEqual([]);
    expect(Object.keys(de).filter((k) => !(k in english))).toEqual([]);
    // Parameters survive translation.
    for (const k of fill) {
      const want = [...english[k]!.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort();
      const got = [...de[k]!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect({ k, got }).toEqual({ k, got: want });
    }
  });
});
