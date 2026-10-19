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

// The URL flags: configuration a page load carries in its query string.
//
//   · `url.debug` (debug-flags.ts): `?debug=a,b` turns on per-load
//     developer diagnostics; read once at module load.
//   · `url.solo` (solo/profiles.ts): `?solo=<profile>` boots a
//     single-plugin application; resolution is TOTAL — anything that is
//     not a known profile boots the ordinary editor.

import { afterEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { resolveSoloProfile, SOLO_PROFILES } from "../../../src/solo/profiles";

type DebugFlags = typeof import("../../../src/debug-flags");

let loads = 0;
/** Evaluate debug-flags.ts afresh at `search`: what a page load does. */
async function loadAt(search: string | undefined): Promise<DebugFlags> {
  if (search === undefined) stubGlobal("location", undefined);
  else stubGlobal("location", { search });
  loads++;
  return import(`../../../src/debug-flags.ts?load=${loads}`);
}

afterEach(() => unstubAllGlobals());

describe("setting url.debug", () => {
  test("absent: every flag is off", async () => {
    covers("setting:url.debug");
    const mod = await loadAt("");
    expect(mod.debugFlag("hits")).toBe(false);
    expect(mod.debugFlag("")).toBe(false);
  });

  test("one flag, several flags, whitespace and empty entries", async () => {
    covers("setting:url.debug");
    const one = await loadAt("?debug=hits");
    expect(one.debugFlag("hits")).toBe(true);
    expect(one.debugFlag("other")).toBe(false);
    const many = await loadAt("?x=1&debug= hits , ,timing,");
    expect(many.debugFlag("hits")).toBe(true);
    expect(many.debugFlag("timing")).toBe(true);
    expect(many.debugFlag("")).toBe(false);
  });

  test("read once per load: a later URL change does not flip a flag", async () => {
    covers("setting:url.debug");
    const mod = await loadAt("?debug=hits");
    stubGlobal("location", { search: "" });
    expect(mod.debugFlag("hits")).toBe(true);
  });

  test("no location at all (a worker, a test) means no flags", async () => {
    covers("setting:url.debug");
    const mod = await loadAt(undefined);
    expect(mod.debugFlag("hits")).toBe(false);
  });
});

describe("setting url.solo", () => {
  test("absent, empty or unknown: the ordinary editor (null)", () => {
    covers("setting:url.solo");
    for (const search of [
      "",
      "?solo=",
      "?solo=paged.pdf",
      "?solo=draw",
      "?other=1",
    ])
      expect({ search, profile: resolveSoloProfile(search) }).toEqual({
        search,
        profile: null,
      });
  });

  test("every declared profile resolves to itself", () => {
    covers("setting:url.solo");
    const names = Object.keys(SOLO_PROFILES).sort();
    expect(names).toEqual([
      "paged.data",
      "paged.doc",
      "paged.draw",
      "paged.image",
      "paged.sheet",
      "paged.web",
    ]);
    for (const name of names) {
      const p = resolveSoloProfile(`?solo=${encodeURIComponent(name)}`);
      expect(p).toBe(SOLO_PROFILES[name]);
      // The profile names the bundle the solo app is: its storage scope
      // (`.solo.<bundleId>`) and its one mode's layout come from it.
      expect(typeof p?.bundleId).toBe("string");
      expect(p?.slots).toBeDefined();
    }
  });

  test("other parameters do not get in the way", () => {
    covers("setting:url.solo");
    expect(resolveSoloProfile("?debug=hits&solo=paged.sheet&x")).toBe(
      SOLO_PROFILES["paged.sheet"],
    );
  });
});
