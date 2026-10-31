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
//   · `url.solo` (profiles/from-url.ts): `?solo=<profile>` boots a
//     single-plugin application, the preset `solo:<name>`; resolution is
//     TOTAL — anything that is not a known profile boots the ordinary
//     editor.
//   · `url.profile` (profiles/from-url.ts): `?profile=<preset>` boots the
//     editor as a named preset (docs/composable-editor.md §5.4); an
//     unknown name boots the ordinary editor with a problem.

import { afterEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { profileFromSearch } from "../../../src/profiles/from-url";
import { PRESETS } from "../../../src/profiles/presets";
import { SOLO_PROFILES } from "../../../src/solo/profiles";

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
  test("absent, empty or unknown: the ordinary editor", () => {
    covers("setting:url.solo");
    for (const search of [
      "",
      "?solo=",
      "?solo=paged.pdf",
      "?solo=draw",
      "?other=1",
    ]) {
      const { profile } = profileFromSearch(search);
      expect({
        search,
        bundles: profile.bundles,
        scope: profile.storageScope,
      }).toEqual({
        search,
        bundles: "all",
        scope: "",
      });
    }
  });

  test("every declared profile boots its one bundle in its own storage scope", () => {
    covers("setting:url.solo");
    const names = Object.keys(SOLO_PROFILES).sort();
    expect(names).toEqual([
      "paged.data",
      "paged.doc",
      "paged.draw",
      "paged.image",
      "paged.sheet",
      "paged.slide",
      "paged.web",
    ]);
    for (const name of names) {
      const { profile, problems } = profileFromSearch(
        `?solo=${encodeURIComponent(name)}`,
      );
      const solo = SOLO_PROFILES[name]!;
      expect(problems).toEqual([]);
      expect(profile.bundles).toEqual([solo.bundleId]);
      expect(profile.storageScope).toBe(`.solo.${solo.bundleId}`);
      expect(profile.modes).not.toBe("all");
    }
  });

  test("other parameters do not get in the way", () => {
    covers("setting:url.solo");
    expect(
      profileFromSearch("?debug=hits&solo=paged.sheet&x").profile.bundles,
    ).toEqual(["media.paged.sheet"]);
  });
});

describe("setting url.profile", () => {
  test("names a preset", () => {
    covers("setting:url.profile");
    for (const name of Object.keys(PRESETS)) {
      const { profile, problems } = profileFromSearch(
        `?profile=${encodeURIComponent(name)}`,
      );
      expect({ name, problems }).toEqual({ name, problems: [] });
      expect(profile.chain[profile.chain.length - 1]).toBe(name);
    }
  });

  test("wins over ?solo= when both are given", () => {
    covers("setting:url.profile");
    expect(
      profileFromSearch("?solo=paged.draw&profile=full").profile.bundles,
    ).toBe("all");
  });

  test("an unknown preset is the ordinary editor with a problem", () => {
    covers("setting:url.profile");
    const { profile, problems } = profileFromSearch("?profile=nothing");
    expect(profile.bundles).toBe("all");
    expect(problems).toEqual([
      { path: "extends", message: 'unknown preset "nothing"' },
    ]);
  });
});
