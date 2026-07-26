/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// React is declared an OPTIONAL peer (`peerDependenciesMeta`), and this pins
// that the BUILT package honours it. It did not: a static
// `import { createElement } from "react"` in widgets-fallback / schema-panel
// was reachable from the barrel (index → host-impl → widgets-fallback), so
// `import { loadBundle }` — the React-free loader path — died with
// ERR_MODULE_NOT_FOUND wherever React was not installed. That broke all 22 of
// plugin-draw's test files against the published canary, and nobody saw it
// because that repo's CI was failing at set-up for an unrelated reason.
//
// A unit test importing the SOURCE cannot catch this (vitest resolves React
// from the workspace root), so this asserts on the shipped artifact: no
// top-level react import may survive the bundle. The dynamic `await
// import("react")` the modules now use is fine — it is reached only on the
// render path, which a headless consumer never takes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DIST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/index.js",
);

describe("the published bundle keeps React optional", () => {
  it("has no top-level react import", () => {
    if (!existsSync(DIST)) {
      // `pnpm build` has not run in this checkout — nothing to assert
      // against. The publish workflow always builds first.
      return;
    }
    const bundle = readFileSync(DIST, "utf8");
    const statics = bundle.match(/^\s*import[^;]*?from\s*["']react["']/gm) ?? [];
    expect(
      statics,
      "a static react import makes the whole package unloadable without React",
    ).toEqual([]);
  });

  it("declares react as an optional peer, matching that", () => {
    const pkg = JSON.parse(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    ) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.peerDependencies?.react).toBeDefined();
    expect(pkg.peerDependenciesMeta?.react?.optional).toBe(true);
  });
});
