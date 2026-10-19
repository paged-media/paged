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

// React is declared an OPTIONAL peer (`peerDependenciesMeta`), and this pins
// that the BUILT package honours it. It did not: a static
// `import { createElement } from "react"` in widgets-fallback / schema-panel
// was reachable from the barrel (index → host-impl → widgets-fallback), so
// `import { loadBundle }` — the React-free loader path — died with
// ERR_MODULE_NOT_FOUND wherever React was not installed. That broke all 22 of
// plugin-draw's test files against the published canary, and nobody saw it
// because that repo's CI was failing at set-up for an unrelated reason.
//
// A unit test importing the SOURCE cannot catch this (the test runner resolves React
// from the workspace root), so this asserts on the shipped artifact: no
// top-level react import may survive the bundle. The artifact is built HERE,
// with the bundling step of the package's own `build` script, into a
// temporary directory: the tests used to read `dist/` and return early when
// no build had run, which passed without asserting anything in every checkout
// that had not built the package first.
//
// The FIRST fix for that used a top-level `await import("react")`, which
// broke the artifact a second way: the bundler emits top-level await
// verbatim, and Vite's dep-optimizer compiles pre-bundled deps down to its
// ES2020 floor, where top-level await does not exist — so pre-bundling the
// published package failed the editor's dev server outright. The declaration
// build now compiles at `"module": "ES2020"` (that same floor), where
// TypeScript REFUSES top-level await (TS1378): the build fails here instead of
// in a consumer. These tests pin the gate and the resulting shape;
// `src/react-optional.ts` holds the full record.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");

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

/** TypeScript `module` settings that ALLOW top-level await (TS1378 names
 *  them). Compiling at anything else is what makes it a build error. */
const TLA_CAPABLE =
  /^(es2022|esnext|system|node16|node18|node20|nodenext|preserve)$/i;

function readBuildModule(): string | undefined {
  const config = JSON.parse(
    readFileSync(resolve(HERE, "../tsconfig.build.json"), "utf8"),
  ) as {
    compilerOptions?: { module?: string };
  };
  return config.compilerOptions?.module;
}

/** The bundling step of the package's `build` script (`bun build … --outdir
 *  dist …`), as argv, with the output directory swapped for `outdir`. Read
 *  from package.json so the artifact asserted on is the one `bun run build`
 *  ships, not a second recipe kept here. */
function bundleCommand(outdir: string): string[] {
  const build = readPkg().scripts?.build ?? "";
  const step = build
    .split("&&")
    .map((s) => s.trim())
    .find((s) => s.startsWith("bun build "));
  if (!step)
    throw new Error(`no "bun build" step in the build script: ${build}`);
  const argv = step.split(/\s+/);
  const at = argv.indexOf("--outdir");
  if (at < 0 || at + 1 >= argv.length)
    throw new Error(`the build step names no --outdir: ${step}`);
  argv[at + 1] = outdir;
  return argv;
}

let outdir = "";
let bundle = "";

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "plugin-sdk-react-free-"));
  const [cmd, ...args] = bundleCommand(outdir);
  const run = Bun.spawnSync(
    [cmd === "bun" ? process.execPath : cmd!, ...args],
    {
      cwd: PKG,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (run.exitCode !== 0)
    throw new Error(
      `bundling the package failed (${run.exitCode}): ${run.stderr.toString()}`,
    );
  bundle = readFileSync(join(outdir, "index.js"), "utf8");
});

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

describe("the published bundle keeps React optional", () => {
  it("has no top-level react import", () => {
    expect(bundle.length, "the bundle was built").toBeGreaterThan(0);
    const statics =
      bundle.match(/^\s*import[^;]*?from\s*["']react["']/gm) ?? [];
    expect(
      statics,
      "a static react import makes the whole package unloadable without React",
    ).toEqual([]);
  });

  it("resolves React dynamically, and never with a top-level await", () => {
    expect(bundle.length, "the bundle was built").toBeGreaterThan(0);
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

  it("builds at a module setting that CANNOT hold top-level await", () => {
    // The real gate: TypeScript reports a top-level await as an error
    // (TS1378) below `module: es2022`, so a future one fails `bun run build`
    // rather than a consumer's dev server. This asserts the gate is still
    // configured and on the build's path — the build asserts the rest.
    const build = readPkg().scripts?.build ?? "";
    expect(build, "the build must run the declaration compile").toContain(
      "tsc -p tsconfig.build.json",
    );
    const moduleSetting = readBuildModule();
    expect(
      moduleSetting,
      "tsconfig.build.json must pin an explicit module",
    ).toBeDefined();
    expect(
      TLA_CAPABLE.test(moduleSetting ?? ""),
      `module "${moduleSetting}" allows top-level await; Vite's dep-optimizer ` +
        "floor (es2020) cannot consume it",
    ).toBe(false);
  });

  it("declares react as an optional peer, matching that", () => {
    const pkg = readPkg();
    expect(pkg.peerDependencies?.react).toBeDefined();
    expect(pkg.peerDependenciesMeta?.react?.optional).toBe(true);
  });
});
