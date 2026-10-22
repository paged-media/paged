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

// @feat: plugin-platform.object-model
//
// host.strings (extensions ADR 333): a bundle defines its English, ships
// translations, and reads its words in the editor's language; its keys are
// held to its own namespace. Without a host catalogue the English answers.

import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { englishStrings, formatMessage } from "../src/strings";
import { silentConsole as silent } from "../src/testing";
import { makeFakeEditor } from "./fake-editor";

const manifest: PluginManifest = {
  id: "acme.notes",
  name: "Notes",
  version: "1.0.0",
  apiVersion: "^0.2.0",
  capabilities: {},
};

function host(strings?: ReturnType<typeof englishStrings>) {
  const fake = makeFakeEditor();
  return createBundleHost(() => fake.editor, manifest, {
    console: silent,
    ...(strings ? { strings } : {}),
  }).host;
}

describe("host.strings", () => {
  it("answers a bundle's English without a host catalogue", () => {
    const h = host();
    expect(h.supports("strings@1")).toBe(false);
    const M = h.strings.define({
      hello: "Hello, {name}.",
      notes: "{count, plural, one {# note} other {# notes}}",
    });
    expect(M.hello).toBe("acme.notes.hello");
    expect(h.strings.t(M.hello, { name: "Ada" })).toBe("Hello, Ada.");
    expect(h.strings.t(M.notes, { count: 2 })).toBe("2 notes");
    expect(h.strings.locale).toBe("en");
  });

  it("keeps a bundle to its own namespace", () => {
    const h = host();
    expect(() => h.strings.translate("de", { "other.plugin.x": "y" })).toThrow(
      /outside this bundle's namespace/,
    );
    h.strings.define({ a: "A" });
    expect(() => h.strings.define({ a: "B" })).toThrow(/defined twice/);
  });

  it("reads the host's catalogue in its language", () => {
    const de = new Map<string, string>();
    const english = new Map<string, string>();
    const h = host({
      locale: () => "de",
      define: (k, v) => void english.set(k, v),
      translate: (_l, k, v) => void de.set(k, v),
      t: (k, p) => formatMessage(de.get(k) ?? english.get(k) ?? k, p, "de"),
    });
    expect(h.supports("strings@1")).toBe(true);
    const M = h.strings.define({ hello: "Hello, {name}.", only: "English" });
    h.strings.translate("de", { [M.hello]: "Hallo, {name}." });
    expect(h.strings.locale).toBe("de");
    expect(h.strings.t(M.hello, { name: "Ada" })).toBe("Hallo, Ada.");
    expect(h.strings.t(M.only)).toBe("English");
  });
});
