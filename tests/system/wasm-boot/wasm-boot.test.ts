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

// WASM BOOT PARITY: every wasm the editor ships, booted by V8, per bundle.
//
// The unit suites boot the engine's and the modules' wasm under bun test,
// which runs JavaScriptCore. The editor ships to Chromium, which runs V8, and
// the two engines validate, compile and link wasm independently. So each
// wasm is also booted in headless Chromium, whether or not a journey reaches
// the lane that loads it (draw's trace kernel, data's DuckDB extensions,
// pdf's import mapper, the engine's library):
//
//   - the page fetches it with the sha384 the module host stamps on it, on a
//     cross-origin isolated page (the editor's COOP/COEP), so the browser
//     verifies its integrity;
//   - a wasm-bindgen module boots through its own glue (compile,
//     instantiate, link every import, run the start function) and must hand
//     back its exports;
//   - a plain module (DuckDB's engine and extensions) is compiled, which
//     validates every function body, and must export something.
//
// The browser is driven by the Playwright library (playwright-core) inside
// bun test, the driver the T7 trial chose (docs/migration/bun-webview.md);
// PAGED_WASM_BOOT_DRIVER=webview runs the same checks through Bun.WebView's
// Chrome backend instead. Without a Chromium the checks report
// `unavailable: browser` and skip; PAGED_REQUIRE_BROWSER=1 (CI) fails them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  chromium,
  openDriver,
  type BrowserDriver,
  type DriverName,
} from "./drivers";
import { startPageServer, type PageServer } from "./server";
import { WASM_BUNDLES, wasmFiles, type WasmFile } from "./wasm-files";

const DRIVER: DriverName =
  process.env.PAGED_WASM_BOOT_DRIVER === "webview" ? "webview" : "playwright";
const REQUIRED = process.env.PAGED_REQUIRE_BROWSER === "1";

const browser = await chromium();
if (!browser.path) {
  if (REQUIRED) throw new Error(`PAGED_REQUIRE_BROWSER=1: ${browser.why}`);
  console.log(`unavailable: browser: ${browser.why}`);
}
const NO_BROWSER = !browser.path;

const files = wasmFiles();
const owners = [...new Set(files.map((f) => f.owner))];

let server: PageServer;
let driver: BrowserDriver;

beforeAll(async () => {
  if (NO_BROWSER) return;
  server = startPageServer();
  driver = await openDriver(DRIVER, browser.path!);
  await driver.open(server.url);
}, 60_000);

afterAll(async () => {
  await driver?.close();
  server?.stop();
}, 30_000);

/** The page's half: fetch with integrity, boot or compile, count exports. */
function bootExpression(f: WasmFile): string {
  const args = JSON.stringify({
    wasm: `/@fs${f.fs}`,
    glue: f.glue ? `/@fs${f.glue}` : null,
    integrity: f.integrity,
  });
  return `(async ({ wasm, glue, integrity }) => {
    const res = await fetch(wasm, { integrity });
    if (!res.ok) return { error: "HTTP " + res.status };
    const bytes = await res.arrayBuffer();
    let exports;
    if (glue) {
      const mod = await import(glue);
      exports = Object.keys(await mod.default({ module_or_path: bytes })).length;
    } else {
      exports = WebAssembly.Module.exports(await WebAssembly.compile(bytes)).length;
    }
    return { exports, isolated: self.crossOriginIsolated };
  })(${args}).catch((e) => ({ error: String(e) }))`;
}

describe("wasm boot parity: every shipped wasm boots in V8", () => {
  test("the list holds the engine and every bundle that ships wasm, and nothing else", () => {
    expect(files.filter((f) => f.owner === "engine").length).toBeGreaterThan(0);
    expect(owners.filter((o) => o !== "engine").sort()).toEqual([
      ...WASM_BUNDLES,
    ]);
  });

  test.skipIf(NO_BROWSER)(
    "the page is cross-origin isolated (SharedArrayBuffer)",
    async () => {
      const page = await driver.evaluate<{ isolated: boolean; sab: string }>(
        "({ isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer })",
      );
      expect(page).toEqual({ isolated: true, sab: "function" });
    },
  );

  for (const owner of owners) {
    describe(owner, () => {
      for (const f of files.filter((x) => x.owner === owner)) {
        test.skipIf(NO_BROWSER)(f.file, async () => {
          const before = driver.errors.length;
          const out = await driver.evaluate<{
            error?: string;
            exports?: number;
            isolated?: boolean;
          }>(bootExpression(f));
          expect(out.error).toBeUndefined();
          expect(out.isolated).toBe(true);
          expect(out.exports).toBeGreaterThan(0);
          expect(driver.errors.slice(before)).toEqual([]);
        });
      }
    });
  }
});
