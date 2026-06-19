// ADR 019 Phase 3 — the capability-catalog vendoring must actually gate.
// Mirrors sync-wire.spec.ts: resolve an explicit source, vendor it, and fail
// on drift. (The published-package resolution path is exercised live in CI once
// @paged-media/introspect-wasm ships catalog.json; here we pin the pure logic.)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildVendored,
  checkVendored,
  resolveSource,
  writeVendored,
  // @ts-expect-error — JS module, no types; the script exports pure fns.
} from "../../../scripts/sync-catalog.mjs";

const CATALOG =
  JSON.stringify(
    {
      hostFunctions: [{ name: "paged.set", params: "(id, path, value)" }],
      idGrammar: [{ form: "textFrame:<id>" }],
      settablePaths: ["frameFillColor", "characterFontSize"],
      constraints: ["Scripts run in Boa, not Node."],
    },
    null,
    2,
  ) + "\n";

describe("sync-catalog", () => {
  let dir: string;
  let source: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-catalog-"));
    source = join(dir, "catalog.json");
    writeFileSync(source, CATALOG);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves an explicit --source path", () => {
    expect(resolveSource({ source }).path).toBe(source);
  });

  it("vendors the catalog verbatim and a fresh --check passes", () => {
    const target = join(dir, "vendored.json");
    writeVendored({ source, target });
    expect(readFileSync(target, "utf8")).toBe(buildVendored({ path: source }));
    expect(checkVendored({ source, target }).ok).toBe(true);
  });

  it("--check fails when the vendored copy drifts", () => {
    const target = join(dir, "vendored.json");
    writeFileSync(target, "{}\n");
    const res = checkVendored({ source, target });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/drifted/);
  });

  it("--check fails (not throws) when the source is unresolvable", () => {
    const res = checkVendored({ source: join(dir, "does-not-exist.json") });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not found/);
  });
});
