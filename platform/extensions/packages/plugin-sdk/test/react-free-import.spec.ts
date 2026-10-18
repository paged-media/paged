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
// top-level react import may survive the bundle.
//
// The FIRST fix for that used a top-level `await import("react")`, which
// broke the artifact a second way: tsup emits top-level await verbatim, and
// Vite's dep-optimizer compiles pre-bundled deps down to its ES2020 floor,
// where top-level await does not exist — so pre-bundling the published
// package failed the editor's dev server outright. The build now pins
// `--target es2020` (that same floor), which makes esbuild REFUSE to emit
// top-level await: the build fails here instead of in a consumer. These
// tests pin the gate and the resulting shape; `src/react-optional.ts` holds
// the full record.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "../dist/index.js");

function readPkg(): {
  scripts?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
} {
  return JSON.parse(readFileSync(resolve(HERE, "../package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
}

/** esbuild targets that can REPRESENT top-level await. Building at
 *  anything below these is what makes the emit impossible. */
const TLA_CAPABLE = /^(esnext|es2022|es2023|es2024|es2025)$/;

describe("the published bundle keeps React optional", () => {
  it("has no top-level react import", () => {
    if (!existsSync(DIST)) {
      // `pnpm build` has not run in this checkout — nothing to assert
      // against. BOTH workflows now build before the suite (they did not,
      // which left this guard inert in CI); locally, run `pnpm build` first.
      return;
    }
    const bundle = readFileSync(DIST, "utf8");
    const statics = bundle.match(/^\s*import[^;]*?from\s*["']react["']/gm) ?? [];
    expect(
      statics,
      "a static react import makes the whole package unloadable without React",
    ).toEqual([]);
  });

  it("resolves React dynamically, and never with a top-level await", () => {
    if (!existsSync(DIST)) return;
    const bundle = readFileSync(DIST, "utf8");
    expect(
      bundle,
      "React must still be resolved at runtime — a dropped import() means " +
        "the render paths can never work",
    ).toMatch(/\bimport\("react"\)/);
    expect(
      bundle,
      "an AWAITED react import makes the module an async module, which " +
        "Vite's dep-optimizer cannot pre-bundle at its ES2020 floor",
    ).not.toMatch(/await import\("react"\)/);
  });

  it("builds at a target that CANNOT emit top-level await", () => {
    // The real gate: esbuild errors on top-level await below es2022, so a
    // future one fails `pnpm build` rather than a consumer's dev server.
    // This asserts the gate is still configured — the build asserts the rest.
    const build = readPkg().scripts?.build ?? "";
    const target = /--target\s+(\S+)/.exec(build)?.[1];
    expect(target, "the build must pin an explicit esbuild target").toBeDefined();
    expect(
      TLA_CAPABLE.test(target ?? ""),
      `build target "${target}" can emit top-level await; Vite's dep-optimizer ` +
        "floor (es2020) cannot consume it",
    ).toBe(false);
  });

  it("declares react as an optional peer, matching that", () => {
    const pkg = readPkg();
    expect(pkg.peerDependencies?.react).toBeDefined();
    expect(pkg.peerDependenciesMeta?.react?.optional).toBe(true);
  });
});
