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

// plugin-cli `validate` — the WASM packaging rules (W-07). Drives the
// real dependency-free CLI as a subprocess against fixture manifests, so
// the test exercises the SAME code path users run (no re-implementation).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(
  here,
  "../../plugin-cli/bin/paged-plugin.mjs",
);
const FIX = (name: string) => resolve(here, "fixtures/wasm-manifests", name);

function validate(manifest: string): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, "validate", FIX(manifest)], {
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

describe("plugin-cli validate — wasm capability (W-07)", () => {
  it("accepts a valid wasm declaration", () => {
    const r = validate("valid.json");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("rejects an unknown purpose", () => {
    const r = validate("unknown-purpose.json");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/purpose must be layout\|codec\|compute/);
  });

  it("rejects a path-traversal path", () => {
    const r = validate("traversal.json");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/bundle-relative .* path/);
    expect(r.err).toMatch(/no "\.\." segment/);
  });

  it("rejects a declared maxBytes over the per-artifact ceiling", () => {
    const r = validate("over-budget.json");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/exceeds the host per-artifact ceiling/);
  });

  it("rejects an unknown key on a wasm artifact (strict object)", () => {
    const r = validate("unknown-key.json");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown key "threads"/);
  });

  it("rejects a present file larger than its declared maxBytes", () => {
    const r = validate("present-over-declared.json");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/over its 4-byte ceiling/);
  });
});
