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

// W0.10 — the wire-vendoring lockstep must actually gate (audit P11).
// Before Decision B the script hard-coded the editor's deleted vendored
// .d.ts and warn-skipped, so --check was silently inert. These tests
// pin the new contract: resolve the published @paged-media/canvas-wasm,
// fail on drift, fail on a missing/unresolvable source, and verify the
// `Synced from …@<version>` stamp freshness.

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Module } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// Run `fn` with NODE_PATH neutralised. The unresolvable-source
// assertions verify ANCHOR-RELATIVE resolution: the package must NOT be
// found via the temp anchor's node_modules. But a runner can seed NODE_PATH
// (vitest did, with pnpm's flat `.pnpm/node_modules`), and since the headless harness
// devDepends on @paged-media/canvas-wasm it now lives there — Node's
// resolver ALWAYS consults NODE_PATH (the `paths` option can't exclude
// it), so a bare anchor would "resolve" the package by environment
// accident. Stripping NODE_PATH for these probes restores the contract
// the script actually enforces in CI (where the harness dep is present
// but resolution is still anchored at the editor's packages/client).
function withoutNodePath<T>(fn: () => T): T {
  const saved = process.env.NODE_PATH;
  delete process.env.NODE_PATH;
  // Refresh Module's cached global paths so the change takes effect.
  (Module as unknown as { _initPaths(): void })._initPaths();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = saved;
    (Module as unknown as { _initPaths(): void })._initPaths();
  }
}

// The script is a plain .mjs (no .d.ts); the error fires on the module
// specifier, so the directive sits on the line directly above it.
import {
  buildVendored,
  checkVendored,
  readStampedVersion,
  resolveSource,
  // @ts-expect-error — JS module, no types; the script exports pure fns.
} from "../../../scripts/sync-wire.mjs";

// A throwaway fixture tree that mimics a published-package layout:
//   <root>/node_modules/@paged-media/canvas-wasm/{package.json,*.d.ts}
// resolveSource({ resolveFrom }) anchors a require there.
let tmp: string;
let pkgDir: string;
let dtsPath: string;
const DTS_BODY = "export type Wire = { protocol: number };\n";

function writePackage(version: string, body = DTS_BODY): void {
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@paged-media/canvas-wasm",
      version,
      types: "paged_canvas_wasm.d.ts",
    }),
  );
  writeFileSync(dtsPath, body);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sync-wire-"));
  pkgDir = join(tmp, "node_modules", "@paged-media", "canvas-wasm");
  mkdirSync(pkgDir, { recursive: true });
  dtsPath = join(pkgDir, "paged_canvas_wasm.d.ts");
  // The anchor package.json the require is created against.
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture-consumer", version: "0.0.0" }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("sync-wire: source resolution", () => {
  it("resolves @paged-media/canvas-wasm from the consumer dir", () => {
    writePackage("0.34.0");
    const src = resolveSource({ resolveFrom: tmp });
    expect(src.version).toBe("0.34.0");
    // require.resolve returns the realpath; normalize the fixture side
    // (macOS /var → /private/var) before comparing.
    expect(realpathSync(src.path)).toBe(realpathSync(dtsPath));
  });

  it("an explicit --source overrides package resolution", () => {
    const loose = join(tmp, "loose.d.ts");
    writeFileSync(loose, DTS_BODY);
    const src = resolveSource({ source: loose });
    expect(src.path).toBe(loose);
  });

  it("MISSING source fails (no warn-skip)", () => {
    // No package installed under the anchor, no --source: must throw,
    // not silently pass like the pre-Decision-B warn-skip did.
    withoutNodePath(() =>
      expect(() => resolveSource({ resolveFrom: tmp })).toThrow(
        /not resolvable|--source/,
      ),
    );
    expect(() => resolveSource({ source: join(tmp, "nope.d.ts") })).toThrow(
      /not found/,
    );
  });
});

describe("sync-wire: --check", () => {
  it("in-sync vendored copy PASSES", () => {
    writePackage("0.34.0");
    const src = resolveSource({ resolveFrom: tmp });
    const target = join(tmp, "wire.d.ts");
    writeFileSync(target, buildVendored(src));

    const res = checkVendored({ resolveFrom: tmp, target });
    expect(res.ok).toBe(true);
    expect(res.expectedVersion).toBe("0.34.0");
  });

  it("TAMPERED local copy FAILS", () => {
    writePackage("0.34.0");
    const src = resolveSource({ resolveFrom: tmp });
    const target = join(tmp, "wire.d.ts");
    writeFileSync(target, buildVendored(src) + "\nexport type Sneak = 1;\n");

    const res = checkVendored({ resolveFrom: tmp, target });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/drift/);
  });

  it("UNRESOLVABLE source FAILS (not a pass)", () => {
    const target = join(tmp, "wire.d.ts");
    writeFileSync(target, "// whatever\n");
    const res = withoutNodePath(() =>
      checkVendored({ resolveFrom: tmp, target }),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not resolvable|--source/);
  });

  it("a build on another host (closure trampoline names) is not drift; a changed signature is", () => {
    // wasm-bindgen names its closure trampolines after rustc symbol hashes,
    // which differ between a macOS and a Linux build of one revision, and so
    // does their order.
    const trampoline = (hash: string, sig: string) =>
      `    readonly wasm_bindgen__convert__closures_____invoke__h${hash}: ${sig};\n`;
    const initOutput = (...lines: string[]) =>
      `export interface InitOutput {\n${lines.join("")}}\n`;
    const two = "(a: number, b: number) => void";
    const one = "(a: number) => void";
    writePackage(
      "0.34.0",
      DTS_BODY +
        initOutput(
          trampoline("1111111111111111", two),
          trampoline("2222222222222222", one),
        ),
    );
    const target = join(tmp, "wire.d.ts");
    writeFileSync(target, buildVendored(resolveSource({ resolveFrom: tmp })));

    // Same signatures under other hashes, in another order: in sync.
    writePackage(
      "0.34.0",
      DTS_BODY +
        initOutput(
          trampoline("bbbbbbbbbbbbbbbb", one),
          trampoline("aaaaaaaaaaaaaaaa", two),
        ),
    );
    expect(checkVendored({ resolveFrom: tmp, target }).ok).toBe(true);

    // A trampoline whose signature changed is drift.
    writePackage(
      "0.34.0",
      DTS_BODY +
        initOutput(
          trampoline(
            "aaaaaaaaaaaaaaaa",
            "(a: number, b: number, c: any) => void",
          ),
          trampoline("bbbbbbbbbbbbbbbb", one),
        ),
    );
    const res = checkVendored({ resolveFrom: tmp, target });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/drift/);
  });

  it("a Rust 1.99 build (crate-hashed trampoline names, another export order) is not drift", () => {
    // Since Rust 1.99 the trampolines are named `wasm_bindgen_<crate hash>___…`,
    // and the raw exports' order follows the link order.
    const old = (hash: string, sig: string) =>
      `    readonly wasm_bindgen__convert__closures_____invoke__h${hash}: ${sig};\n`;
    const v99 = (types: string, sig: string) =>
      `    readonly wasm_bindgen_cb391a3e032f37a7___convert__closures_____invoke___${types}_true_: ${sig};\n`;
    const exp = (name: string) =>
      `    readonly ${name}: (a: number) => number;\n`;
    const initOutput = (...lines: string[]) =>
      `export interface InitOutput {\n${lines.join("")}}\n`;
    const sig = "(a: number, b: number, c: any) => void";
    writePackage(
      "0.34.0",
      DTS_BODY +
        initOutput(exp("alpha"), old("1111111111111111", sig), exp("beta")),
    );
    const target = join(tmp, "wire.d.ts");
    writeFileSync(target, buildVendored(resolveSource({ resolveFrom: tmp })));

    writePackage(
      "0.34.0",
      DTS_BODY +
        initOutput(
          exp("beta"),
          v99("wasm_bindgen_cb391a3e032f37a7___JsValue_____", sig),
          exp("alpha"),
        ),
    );
    expect(checkVendored({ resolveFrom: tmp, target }).ok).toBe(true);

    // An export that disappeared is still drift.
    writePackage("0.34.0", DTS_BODY + initOutput(v99("x", sig), exp("alpha")));
    expect(checkVendored({ resolveFrom: tmp, target }).ok).toBe(false);
  });

  it("VERSION-stamp drift FAILS even when the body is byte-identical", () => {
    // Vendor against 0.34.0, then bump the installed package to 0.35.0
    // with the SAME .d.ts body — the protocol-coupling stamp must catch
    // the version bump.
    writePackage("0.34.0");
    const target = join(tmp, "wire.d.ts");
    writeFileSync(target, buildVendored(resolveSource({ resolveFrom: tmp })));

    writePackage("0.35.0"); // same DTS_BODY, new version
    const res = checkVendored({ resolveFrom: tmp, target });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/0\.34\.0.*0\.35\.0|synced from/i);
    expect(res.actualVersion).toBe("0.34.0");
    expect(res.expectedVersion).toBe("0.35.0");
  });
});

describe("sync-wire: header stamp", () => {
  it("buildVendored stamps the source package version", () => {
    writePackage("0.34.0");
    const content = buildVendored(resolveSource({ resolveFrom: tmp }));
    expect(readStampedVersion(content)).toBe("0.34.0");
    expect(content).toContain("// GENERATED — do not edit.");
  });
});

// Guard: the relative import (test dir → repo-root scripts/) holds, so a
// future move of either tree breaks loudly here rather than skipping.
it("the imported script resolves to scripts/sync-wire.mjs", () => {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/plugin-sdk/test
  const script = join(here, "..", "..", "..", "scripts", "sync-wire.mjs");
  expect(existsSync(script)).toBe(true);
});
