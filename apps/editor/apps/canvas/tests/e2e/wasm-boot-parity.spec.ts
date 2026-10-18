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

// WASM BOOT PARITY — every wasm the editor ships, booted by V8.
//
// The unit suites boot the engine's and the modules' wasm under bun test,
// which runs JavaScriptCore. The editor ships to Chromium, which runs V8,
// and the two engines validate, compile and link wasm independently. This
// spec keeps the shipped path covered for each wasm on its own, whether or
// not a journey happens to reach the lane that loads it (draw's trace
// kernel, data's DuckDB extensions, pdf's mapper, the engine's library):
//
//   - the engine packages (engine/core/packages/*) and every file the
//     module manifest declares (`virtual:paged-modules`, the list the
//     editor's module host serves) are fetched by the page with the
//     manifest's sha384 integrity, as the module host does;
//   - a wasm-bindgen module is booted through its own glue (`__wbg_init`
//     with the bytes: compile, instantiate, link every import, run the
//     start function), and the test reads one export back;
//   - a plain module (DuckDB's engine and its extensions) is compiled,
//     which validates every function body, and must export something.
//
// The page is a static file of the dev server, so it is same-origin and
// cross-origin isolated (the server's headers) without booting the editor.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { buildModuleManifest } from "../../scripts/module-index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_PACKAGES = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "engine",
  "core",
  "packages",
);

interface WasmFile {
  owner: string;
  file: string;
  fs: string;
  integrity: string;
}

function sha384(path: string): string {
  return `sha384-${createHash("sha384").update(readFileSync(path)).digest("base64")}`;
}

const files: WasmFile[] = [];
for (const dir of existsSync(ENGINE_PACKAGES)
  ? readdirSync(ENGINE_PACKAGES)
  : []) {
  const pkgDir = join(ENGINE_PACKAGES, dir);
  for (const name of existsSync(pkgDir) ? readdirSync(pkgDir) : []) {
    if (!name.endsWith("_bg.wasm")) continue;
    const fs = join(pkgDir, name);
    files.push({
      owner: `engine/${dir}`,
      file: name,
      fs,
      integrity: sha384(fs),
    });
  }
}
const manifest = buildModuleManifest({ host: null, dev: true });
for (const [pkg, entry] of Object.entries(manifest.packages)) {
  for (const [file, f] of Object.entries(entry.files)) {
    if (!file.endsWith(".wasm") || !f.fs) continue;
    files.push({ owner: pkg, file, fs: f.fs, integrity: f.integrity });
  }
}

test.describe("wasm boot parity — every shipped wasm boots in V8", () => {
  test("the parity list covers the engine and every module the manifest declares @level:smoke", () => {
    expect(
      files.filter((f) => f.owner.startsWith("engine/")).length,
    ).toBeGreaterThan(0);
    const owners = new Set(files.map((f) => f.owner));
    for (const pkg of Object.keys(manifest.packages))
      expect(owners.has(pkg), pkg).toBe(true);
  });

  for (const f of files) {
    test(`${f.owner} ${basename(f.file)} @level:smoke`, async ({ page }) => {
      await page.goto("/oauth-callback.html");
      const glue = f.fs.replace(/_bg\.wasm$/, ".js");
      const viaGlue = f.fs.endsWith("_bg.wasm") && existsSync(glue);
      const out = await page.evaluate(
        async ({ wasm, glue, integrity, viaGlue }) => {
          const res = await fetch(`/@fs${wasm}`, { integrity });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const bytes = await res.arrayBuffer();
          if (viaGlue) {
            const mod = (await import(/* @vite-ignore */ `/@fs${glue}`)) as {
              default: (init: {
                module_or_path: ArrayBuffer;
              }) => Promise<WebAssembly.Exports>;
            };
            const exports = await mod.default({ module_or_path: bytes });
            return {
              exports: Object.keys(exports).length,
              isolated: self.crossOriginIsolated,
            };
          }
          const compiled = await WebAssembly.compile(bytes);
          return {
            exports: WebAssembly.Module.exports(compiled).length,
            isolated: self.crossOriginIsolated,
          };
        },
        { wasm: f.fs, glue, integrity: f.integrity, viaGlue },
      );
      expect(out.error).toBeUndefined();
      expect(out.isolated).toBe(true);
      expect(out.exports).toBeGreaterThan(0);
    });
  }
});
