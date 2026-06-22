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

// All schema value-sets (recursive): `enum` arrays AND `const` scalars — a const
// is a single-value closed vocabulary (e.g. gpu.realm = const "bundle"). The
// scalar set is every accepted value, flattened. This is the source of truth.
function collectSchemaValues(
  node: unknown,
  enums: string[] = [],
  scalars: string[] = [],
): { enums: string[]; scalars: string[] } {
  if (node && typeof node === "object") {
    const e = (node as { enum?: unknown }).enum;
    if (Array.isArray(e)) {
      enums.push(canon(e as string[]));
      for (const v of e as string[]) scalars.push(v);
    }
    const c = (node as { const?: unknown }).const;
    if (typeof c === "string") {
      enums.push(canon([c]));
      scalars.push(c);
    }
    for (const v of Object.values(node)) collectSchemaValues(v, enums, scalars);
  }
  return { enums, scalars };
}
const collected = collectSchemaValues(schema);
const SCHEMA_ENUMS = new Set(collected.enums);
const SCHEMA_SCALARS = new Set(collected.scalars);

// The CLI's `const NAME = new Set([...])` literal.
function cliSet(name: string): string[] | null {
  const m = cliSrc.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// Every >=2-member literal-string union in the plugin-api types, canonicalized.
const TS_UNIONS = new Set(
  [...tsSrc.matchAll(/"[a-zA-Z]+"(?:\s*\|\s*"[a-zA-Z]+")+/g)].map((m) =>
    canon([...m[0].matchAll(/"([^"]+)"/g)].map((x) => x[1])),
  ),
);

// vocab → schema-ACCEPTED values + the CLI Set that mirrors them. `reserved` is
// a vocabulary forward-declared in the TS type (and a CLI *reserved* Set) but
// deliberately NOT accepted by the schema — e.g. gpu realm "shared" (ADR-018:
// rejected until the zero-copy walls lift). The TS type union = accepted ∪
// reserved; the schema accepts only the accepted half.
type Vocab = {
  values: string[];
  cliSet: string;
  reservedCliSet?: string;
  reserved?: string[];
};
const VOCAB: Record<string, Vocab> = {
  rendering: { values: ["sceneLayer", "overlay", "hitTest", "resourceProvider"], cliSet: "RENDERING" },
  assets: { values: ["fonts", "images"], cliSet: "ASSET_KINDS", reservedCliSet: "ASSET_KINDS_RESERVED", reserved: [] },
  clipboard: { values: ["none", "vector", "full"], cliSet: "CLIPBOARD" },
  scopes: { values: ["broad", "scoped"], cliSet: "SCOPES" },
  wasmPurposes: { values: ["layout", "codec", "compute", "engine"], cliSet: "WASM_PURPOSES" },
  entries: { values: ["doubleClick", "command"], cliSet: "ENTRIES" },
  bakedFallbacks: { values: ["group", "rectangle", "raster"], cliSet: "BAKED_FALLBACKS" },
  gpuRealm: { values: ["bundle"], cliSet: "GPU_REALMS", reservedCliSet: "GPU_REALMS_RESERVED", reserved: ["shared"] },
};

describe("capability vocabulary — single source: manifest.schema.json", () => {
  for (const [vocab, spec] of Object.entries(VOCAB)) {
    const { values, cliSet: setName, reservedCliSet, reserved = [] } = spec;
    it(`${vocab}: schema is the source; CLI Set + TS type agree`, () => {
      // 1. the schema (the source) accepts exactly these values
      expect(SCHEMA_ENUMS.has(canon(values))).toBe(true);
      // 2. the CLI accepted Set mirrors the schema (no hand-mirror drift)
      const cli = cliSet(setName);
      expect(cli, `CLI Set ${setName} not found`).not.toBeNull();
      expect(canon(cli!)).toBe(canon(values));
      // 3. reserved values: mirrored by the CLI reserved Set, disjoint from the
      //    accepted half, and NOT accepted anywhere in the schema (forward-only)
      if (reservedCliSet) {
        const cliR = cliSet(reservedCliSet);
        expect(cliR, `CLI Set ${reservedCliSet} not found`).not.toBeNull();
        expect(canon(cliR!)).toBe(canon(reserved));
        for (const r of reserved) {
          expect(values).not.toContain(r);
          expect(SCHEMA_SCALARS.has(r)).toBe(false);
        }
      }
      // 4. the TS type union == accepted ∪ reserved
      expect(TS_UNIONS.has(canon([...values, ...reserved]))).toBe(true);
    });
  }

  it("the schema actually carries every gated vocabulary", () => {
    // guard against a typo making an assertion vacuously pass
    for (const { values } of Object.values(VOCAB)) {
      expect(SCHEMA_ENUMS.has(canon(values))).toBe(true);
    }
  });
});
