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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { tempDir, writeFixture } from "./helpers";

const PKG = fileURLToPath(new URL("..", import.meta.url));

/** A CMYK ICC profile on this machine, as the engine's tests find one:
 *  `$PAGED_CMYK_PROFILE`, the engine's corpus/profiles (fetch-profiles.sh),
 *  else the ones macOS installs. Null: none here. */
function cmykProfile(): string | null {
  const env = process.env["PAGED_CMYK_PROFILE"];
  if (env && existsSync(env)) return env;
  const corpus = join(PKG, "../../engine/core/corpus/profiles");
  if (existsSync(corpus)) {
    const icc = readdirSync(corpus)
      .filter((f) => f.toLowerCase().endsWith(".icc"))
      .sort();
    if (icc[0]) return join(corpus, icc[0]);
  }
  for (const p of [
    "/Library/Application Support/Adobe/Color/Profiles/Recommended/CoatedFOGRA39.icc",
    "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc",
  ])
    if (existsSync(p)) return p;
  return null;
}
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

  it("does not end before the verb finishes (an await no handle holds)", () => {
    const r = run([
      "get",
      fx.paged,
      "swatch:Black",
      "value",
      `--plugins=${join(PKG, "test/fixtures/late-plugin.mjs")}`,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).value).toEqual([0, 0, 0, 100]);
  });

  it("sets text in the bundled Inter when no --font is given, and says so when told not to", () => {
    const pdf = join(tmp.dir, "text.pdf");
    const r = run(["export", fx.paged, "-o", pdf, "--no-plugins"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const bytes = readFileSync(pdf, "latin1");
    // The fixture's "Hello" is set, so the PDF embeds the face it is set in.
    expect(bytes).toMatch(/\/FontFile2|\/FontFile3/);
    expect(bytes).toContain("<0048>"); // "H" in the ToUnicode map

    const bare = join(tmp.dir, "bare.pdf");
    const without = run([
      "export",
      fx.paged,
      "-o",
      bare,
      "--no-plugins",
      "--no-default-font",
      "--text",
    ]);
    expect(without.status).toBe(0);
    expect(without.stderr).toContain("--no-default-font");
    expect(readFileSync(bare, "latin1")).not.toMatch(/\/FontFile2/);
  });

  it("exports PDF/X-4 with --cmyk-profile, and says what is missing without one", () => {
    const x4 = join(tmp.dir, "x4.pdf");
    const without = run([
      "export",
      fx.paged,
      "-o",
      x4,
      "--pdf-standard",
      "pdfx4",
      "--no-plugins",
    ]);
    expect(without.status).toBe(1);
    expect(JSON.parse(without.stdout).error.message).toContain(
      "--cmyk-profile",
    );

    const notIcc = run([
      "export",
      fx.paged,
      "-o",
      x4,
      "--pdf-standard",
      "pdfx4",
      "--cmyk-profile",
      fx.paged,
      "--no-plugins",
    ]);
    expect(notIcc.status).toBe(2);
    expect(JSON.parse(notIcc.stdout).error.message).toContain(
      "is not an ICC profile",
    );

    const icc = cmykProfile();
    if (!icc) {
      console.warn(
        "skip: no CMYK profile (set PAGED_CMYK_PROFILE, or run engine/core/scripts/fetch-profiles.sh)",
      );
      return;
    }
    const r = run([
      "export",
      fx.paged,
      "-o",
      x4,
      "--pdf-standard",
      "pdfx4",
      "--cmyk-profile",
      icc,
      "--no-plugins",
    ]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const pdf = readFileSync(x4, "latin1");
    expect(pdf).toContain("/OutputIntents");
    expect(pdf).toContain("GTS_PDFX");
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
