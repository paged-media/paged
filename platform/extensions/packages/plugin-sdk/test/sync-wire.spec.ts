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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Run `fn` with NODE_PATH neutralised. The unresolvable-source
// assertions verify ANCHOR-RELATIVE resolution: the package must NOT be
// found via the temp anchor's node_modules. But vitest seeds NODE_PATH
// with pnpm's flat `.pnpm/node_modules`, and since the headless harness
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
    const res = withoutNodePath(() => checkVendored({ resolveFrom: tmp, target }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not resolvable|--source/);
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
