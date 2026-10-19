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

// Every built-in module boots its wasm through this package: a module
// source that instantiates a wasm-bindgen glue itself (`initSync(`, or
// `default({ module_or_path })`) is a boot outside the single flight, the
// double-boot race this package exists to prevent.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Hand-rolled instantiation: a call of the glue's `initSync`, or of its
 *  `default` / `init` with a `module_or_path` (types and comments aside). */
const INSTANTIATES =
  /\.initSync\s*\(|\b(?:default|init)\s*\(\s*\{\s*module_or_path\b/;

/** The source without its comments (a doc comment may name the calls). */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Sources allowed to hand the glue its input themselves, and why. */
const ALLOWED = new Map<string, string>([
  [
    // The module door: the host's copy fetched with its integrity, then the
    // bundle's own; it runs inside the module's singleFlight.
    "modules/data/packages/data-bundle/src/engine.ts",
    "initEngineGlue (the module door), called inside singleFlight",
  ],
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Every `src/` directory of a built-in module package. */
function moduleSourceDirs(): string[] {
  const dirs: string[] = [];
  const modules = join(ROOT, "modules");
  for (const mod of readdirSync(modules)) {
    for (const group of ["packages", "."]) {
      let base: string;
      try {
        base = join(modules, mod, group);
        if (!statSync(base).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const pkg of readdirSync(base)) {
        const src = join(base, pkg, "src");
        try {
          if (statSync(src).isDirectory()) dirs.push(src);
        } catch {
          // not a package
        }
      }
    }
  }
  return dirs;
}

describe("every built-in boots its wasm through wasm-boot", () => {
  it("no module source instantiates a wasm-bindgen glue itself", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of moduleSourceDirs()) {
      for (const file of sources(dir)) {
        if (/\.(spec|test)\.tsx?$/.test(file)) continue;
        scanned += 1;
        const rel = relative(ROOT, file);
        if (ALLOWED.has(rel)) continue;
        if (INSTANTIATES.test(code(readFileSync(file, "utf8")))) {
          offenders.push(rel);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it("the allowed exceptions still exist (a stale entry is an error)", () => {
    for (const rel of ALLOWED.keys()) {
      const text = code(readFileSync(join(ROOT, rel), "utf8"));
      expect(INSTANTIATES.test(text)).toBe(true);
    }
  });
});
