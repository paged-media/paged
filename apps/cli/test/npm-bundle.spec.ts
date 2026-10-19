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

// The npm build of this CLI: the `paged` bin of @paged-media/paged (PM-0008,
// amendment 3), bundled by scripts/bundle.mjs into one file that imports only
// node: builtins. Here it is built into a temporary directory and run with
// plain Node against the workspace engine: the command names itself `paged`,
// prints clean JSON, and its exit codes are the CLI's.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { tempDir, writeFixture } from "./helpers";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.env["PAGED_TEST_NODE"] ?? "node";

describe("the npm bundle (dist/paged.js of @paged-media/paged)", () => {
  let tmp: ReturnType<typeof tempDir>;
  let fx: Awaited<ReturnType<typeof writeFixture>>;
  let bin = "";
  const run = (args: string[]) =>
    spawnSync(NODE, [bin, ...args, "--engine-from", PKG], {
      encoding: "utf8",
    });
  beforeAll(async () => {
    tmp = tempDir();
    execFileSync(
      process.execPath,
      [
        join(PKG, "scripts/bundle.mjs"),
        join(tmp.dir, "dist"),
        "--bin",
        "paged",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    bin = join(tmp.dir, "dist", "paged.js");
    fx = await writeFixture(tmp.dir);
  }, 120_000);
  afterAll(() => tmp.done());

  it("is one file that imports only node: builtins, with the notices of what it inlines", () => {
    expect(existsSync(bin)).toBe(true);
    const code = readFileSync(bin, "utf8");
    expect(code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(code).not.toMatch(/from\s*["']@paged-media\//);
    const notices = readFileSync(
      join(tmp.dir, "dist", "THIRD-PARTY-NOTICES.md"),
      "utf8",
    );
    expect(notices).toContain("## @anthropic-ai/sdk");
  });

  it("names itself paged in its help, usage and error lines", () => {
    const help = spawnSync(NODE, [bin, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^paged \S+ — the paged Node CLI/);
    expect(help.stdout).toContain("usage: paged <verb> [args] [options]");
    const usage = spawnSync(NODE, [bin, "get", "--text"], {
      encoding: "utf8",
    });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/^paged: usage: paged get /m);
  });

  it("reads through the engine and exits 0", () => {
    const r = run(["get", fx.paged, "swatch:Black", "value", "--no-plugins"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      address: "swatch:Black",
      path: "value",
      value: [0, 0, 0, 100],
    });
  });
});
