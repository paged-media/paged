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

// plugin-cli and the module door (ADR 326): `validate` accepts and checks a
// wasm artifact's `integrity`, `integrity` stamps/verifies it, and
// `modules-upload` runs dry and without a token (never uploading here).
// Drives the real dependency-free CLI as a subprocess.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../plugin-cli/bin/paged-plugin.mjs");
// The 8-byte empty module.
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const SRI = "sha384-" + createHash("sha384").update(WASM).digest("base64");

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "", ...env },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** A package dir: package.json + manifest.json + bin/engine.wasm. */
function bundle(artifact: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "paged-modules-cli-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "engine.wasm"), WASM);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@paged-media/test-bundle", version: "0.0.1-test.0" }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        id: "media.paged.test",
        name: "test",
        version: "0.0.1",
        apiVersion: "^0.2",
        capabilities: { wasm: [{ name: "engine", path: "bin/engine.wasm", purpose: "compute", ...artifact }] },
      },
      null,
      2,
    ) + "\n",
  );
  return dir;
}

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

describe("plugin-cli — wasm integrity (ADR 326)", () => {
  it("validate accepts a matching integrity stamp", () => {
    const r = run(["validate", join(bundle({ integrity: SRI }), "manifest.json")]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  it("validate rejects a malformed integrity", () => {
    const r = run(["validate", join(bundle({ integrity: "md5-abc" }), "manifest.json")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/integrity must be a Subresource Integrity token/);
  });

  it("validate rejects a stamp that does not match the file", () => {
    const r = run(["validate", join(bundle({ integrity: "sha384-" + "A".repeat(64) }), "manifest.json")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/integrity does not match "bin\/engine\.wasm"/);
  });

  it("integrity stamps sha384, then --check passes", () => {
    const dir = bundle();
    expect(run(["integrity", dir, "--check"]).code).toBe(1);
    const r = run(["integrity", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/stamped 1 of 1/);
    expect(readManifest(dir).capabilities.wasm[0].integrity).toBe(SRI);
    expect(readFileSync(join(dir, "manifest.json"), "utf8").endsWith("}\n")).toBe(true);
    expect(run(["integrity", dir, "--check"]).code).toBe(0);
    expect(run(["validate", join(dir, "manifest.json")]).code).toBe(0);
  });

  it("integrity --check reports a stale stamp", () => {
    const dir = bundle({ integrity: "sha384-" + "A".repeat(64) });
    const r = run(["integrity", dir, "--check"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is stale/);
  });

  it("modules-upload skips cleanly without a token, and --dry-run names the keys", () => {
    // An unroutable host: HEAD fails, so the artifact counts as not hosted.
    const env = { PAGED_MODULE_HOST: "http://127.0.0.1:9" };
    const dir = bundle();
    const skip = run(["modules-upload", dir], env);
    expect(skip.code).toBe(0);
    expect(skip.out).toContain(
      "http://127.0.0.1:9/@paged-media/test-bundle/0.0.1-test.0/bin/engine.wasm · not hosted (skipped: CLOUDFLARE_API_TOKEN is not set)",
    );
    const dry = run(["modules-upload", dir, "--dry-run"], { ...env, CLOUDFLARE_API_TOKEN: "x" });
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/· would upload/);
  });
});
