// ADR 019 — collapse the capability-manifest triplet to ONE source.
//
// The closed plugin-capability vocabularies (rendering surfaces, clipboard
// grants, wasm purposes, …) were hand-mirrored in three places: the TS unions
// in plugin-api `manifest.ts`, the JSON enums in `manifest.schema.json`, and the
// runtime `Set`s in the zero-dep `plugin-cli`. The hard constraints (plugin-api
// is type-only → no runtime const; the CLI is zero-dep, no build step → can't
// import either) rule out a single literal feeding all three at runtime. So the
// single source of truth is **manifest.schema.json**, and this test GATES the
// other two against it — turning the CLAUDE "change them together" rule into a
// failing-CI invariant. Drift is now impossible, not merely discouraged.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const API = join(here, "..", "..", "plugin-api", "src");
const CLI_PATH = join(here, "..", "..", "plugin-cli", "bin", "paged-plugin.mjs");

const schema = JSON.parse(readFileSync(join(API, "manifest.schema.json"), "utf8")) as Record<
  string,
  unknown
>;
const cliSrc = readFileSync(CLI_PATH, "utf8");
// The vocabulary unions are spread across the plugin-api type surface
// (manifest.ts, assets.ts, …), so scan every .ts source, not just manifest.ts.
const tsSrc = readdirSync(API)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(API, f), "utf8"))
  .join("\n");

const canon = (values: readonly string[]) => [...values].sort().join(",");

// All enum value-sets in the schema (recursive) — the source of truth.
function collectSchemaEnums(node: unknown, acc: string[] = []): string[] {
  if (node && typeof node === "object") {
    const enumVals = (node as { enum?: unknown }).enum;
    if (Array.isArray(enumVals)) acc.push(canon(enumVals as string[]));
    for (const v of Object.values(node)) collectSchemaEnums(v, acc);
  }
  return acc;
}
const SCHEMA_ENUMS = new Set(collectSchemaEnums(schema));

// The CLI's `const NAME = new Set([...])` literal.
function cliSet(name: string): string[] | null {
  const m = cliSrc.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// Every >=2-member literal-string union in manifest.ts, as canonical value-sets.
const TS_UNIONS = new Set(
  [...tsSrc.matchAll(/"[a-zA-Z]+"(?:\s*\|\s*"[a-zA-Z]+")+/g)].map((m) =>
    canon([...m[0].matchAll(/"([^"]+)"/g)].map((x) => x[1])),
  ),
);

// vocab key → (expected values, CLI Set name). Values are documented here only
// for readability; the assertion is schema-driven (the test fails if the schema
// stops defining the vocabulary).
const VOCAB: Record<string, { values: string[]; cliSet: string }> = {
  rendering: { values: ["sceneLayer", "overlay", "hitTest", "resourceProvider"], cliSet: "RENDERING" },
  assets: { values: ["fonts", "images"], cliSet: "ASSET_KINDS" },
  clipboard: { values: ["none", "vector", "full"], cliSet: "CLIPBOARD" },
  scopes: { values: ["broad", "scoped"], cliSet: "SCOPES" },
  wasmPurposes: { values: ["layout", "codec", "compute", "engine"], cliSet: "WASM_PURPOSES" },
  entries: { values: ["doubleClick", "command"], cliSet: "ENTRIES" },
  bakedFallbacks: { values: ["group", "rectangle", "raster"], cliSet: "BAKED_FALLBACKS" },
};

describe("capability vocabulary — single source: manifest.schema.json", () => {
  for (const [vocab, { values, cliSet: setName }] of Object.entries(VOCAB)) {
    it(`${vocab}: schema, CLI Set, and manifest.ts union all agree`, () => {
      // 1. the schema (the source) defines this vocabulary
      expect(SCHEMA_ENUMS.has(canon(values))).toBe(true);
      // 2. the CLI Set matches the schema enum (no hand-mirror drift)
      const cli = cliSet(setName);
      expect(cli, `CLI Set ${setName} not found`).not.toBeNull();
      expect(canon(cli!)).toBe(canon(values));
      // 3. a manifest.ts literal union matches the schema enum
      expect(TS_UNIONS.has(canon(values))).toBe(true);
    });
  }

  it("the schema actually carries every gated vocabulary", () => {
    // guard against a typo making an assertion vacuously pass
    for (const { values } of Object.values(VOCAB)) {
      expect(SCHEMA_ENUMS.has(canon(values))).toBe(true);
    }
  });
});
