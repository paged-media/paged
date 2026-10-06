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

// @feat: plugin-platform.object-model.node-cli
//
// The SHIPPED bin (dist/bin.js, plain Node, no TypeScript): stdout carries
// only the verb's JSON (engine logs go to stderr), and the exit code is the
// process's. Skips when dist is absent (CI builds before the suite).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tempDir, writeFixture } from "./helpers";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

describe.skipIf(!existsSync(BIN))("dist/bin.js", () => {
  let tmp: ReturnType<typeof tempDir>;
  let fx: Awaited<ReturnType<typeof writeFixture>>;
  beforeAll(async () => {
    tmp = tempDir();
    fx = await writeFixture(tmp.dir);
  });
  afterAll(() => tmp.done());

  it("prints clean JSON on stdout and exits 0", () => {
    const out = execFileSync(process.execPath, [BIN, "get", fx.paged, "swatch:Black", "value", "--no-plugins"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    expect(JSON.parse(out)).toEqual({ address: "swatch:Black", path: "value", value: [0, 0, 0, 100] });
  });

  it("exits 1 on a refused write and 2 on a usage error", () => {
    const refused = spawnSync(process.execPath, [BIN, "set", fx.paged, "swatch:Black", "space", "X", "--no-save", "--no-plugins"], { encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout).error.exit).toBe(1);
    expect(spawnSync(process.execPath, [BIN, "nope"], { encoding: "utf8" }).status).toBe(2);
  });

  it("exports a PDF", () => {
    const out = join(tmp.dir, "bin.pdf");
    const r = spawnSync(process.execPath, [BIN, "export", fx.paged, "-o", out, "--no-plugins"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).format).toBe("pdf");
  });
});
