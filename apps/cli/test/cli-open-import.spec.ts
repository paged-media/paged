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

// Files a module imports, and bytes on the command line (plan G4): a file
// that is not .paged or .idml opens through the loaded module whose importer
// claims its extension; a `bytes` argument is given as "@path", and the
// bytes a command answers are written with --result-out.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { cli, REPO_ROOT, tempDir } from "./helpers";

const DRAW = `--plugins=${join(REPO_ROOT, "modules/draw/packages/draw-bundle/src/index.ts")}`;
const PUBLISH = `--plugins=${join(REPO_ROOT, "modules/publish/packages/publish-bundle/src/index.ts")}`;
const IDML = join(REPO_ROOT, "engine/core/corpus/generated/anchored.idml");

let tmp: ReturnType<typeof tempDir>;
beforeAll(() => {
  tmp = tempDir();
});
afterAll(() => tmp.done());

describe("opening a file a module imports", () => {
  it("an SVG opens through the draw module's importer", async () => {
    const svg = join(tmp.dir, "box.svg");
    writeFileSync(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="10" y="10" width="80" height="40" fill="#c00"/></svg>',
    );
    const r = await cli(["query", svg, "polygon", DRAW]);
    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json.addresses.length).toBe(1);
  });

  it("an extension no loaded module imports is a usage error", async () => {
    const odd = join(tmp.dir, "a.xyz");
    writeFileSync(odd, "x");
    const r = await cli(["query", odd, "page", DRAW]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/no loaded module imports \.xyz/);
  });
});

describe("bytes on the command line", () => {
  it("a bytes argument reads a file; --result-out writes the bytes answered", async () => {
    const out = join(tmp.dir, "out.idml");
    const exported = await cli([
      "invoke",
      IDML,
      "media.paged.publish.exportIdml",
      "{}",
      "--no-save",
      "--result-out",
      out,
      PUBLISH,
    ]);
    expect(exported.code, JSON.stringify(exported.json)).toBe(0);
    expect(exported.json.wrote).toBe(out);
    expect(existsSync(out)).toBe(true);
    // A zip: IDML is a package.
    expect([...readFileSync(out).subarray(0, 2)]).toEqual([0x50, 0x4b]);

    const imported = await cli([
      "invoke",
      IDML,
      "media.paged.publish.importIdml",
      JSON.stringify({ bytes: `@${out}` }),
      "--no-save",
      PUBLISH,
    ]);
    expect(imported.code, JSON.stringify(imported.json)).toBe(0);
    expect(imported.json.applied).toBe(true);
  });

  it("--result-out refuses a command that answers no bytes", async () => {
    const r = await cli([
      "invoke",
      IDML,
      "media.paged.publish.importIdml",
      JSON.stringify({ bytes: `@${IDML}` }),
      "--no-save",
      "--result-out",
      join(tmp.dir, "none.bin"),
      PUBLISH,
    ]);
    expect(r.code).toBe(1);
    expect(r.json.error.message).toMatch(/answered no bytes/);
  });
});
