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

// `paged ai` without the model: the engine door the agent drives (scripts,
// page renders), the catalog it reads, and the argument checks that fire
// before any network call. The live model run is a manual smoke test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadCatalog, parsePageSize, sessionEngine } from "../src/ai";
import { openSession } from "../src/session";
import { cli, tempDir, writeFixture } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
});
afterAll(() => tmp.done());

const NP = "--no-plugins";

describe("paged ai", () => {
  it("reads the engine catalog published with this engine", () => {
    const c = loadCatalog();
    expect(c.hostFunctions.some((f) => f.name === "paged.insertTextFrame")).toBe(true);
    expect(c.settablePaths.length).toBeGreaterThan(100);
  });

  it("drives the headless document: scripts run, pages render to PNG", async () => {
    const s = await openSession(fx.paged, { plugins: [] });
    try {
      const engine = sessionEngine(s);
      const run = await engine.runScript("console.log(JSON.parse(paged.pages()).length)");
      expect(run).toMatchObject({ error: null, output: ["[log] 1"] });
      const png = await engine.renderPage!(1);
      expect(png && [...png.subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
      expect(await engine.renderPage!(9)).toBeNull();
    } finally {
      s.dispose();
    }
  });

  it("refuses a bad --mode before calling the model", async () => {
    const r = await cli(["ai", fx.paged, "make it pop", "--mode", "poem", "--no-save", NP]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/--mode/);
  });

  it("is listed with the other verbs", async () => {
    const r = await cli(["--help", "--text"]);
    expect(r.out + r.err).toMatch(/ai <doc> <brief>/);
  });

  it("--new takes named sizes or WxH in points", () => {
    expect(parsePageSize("A4")).toEqual([595, 842]);
    expect(parsePageSize("612x792")).toEqual([612, 792]);
    expect(() => parsePageSize("huge")).toThrow(/--new takes/);
  });

  it("--new needs -o and exactly one positional, checked before calling the model", async () => {
    const noOut = await cli(["ai", "--new", "a4", "a flyer", NP]);
    expect(noOut.code).toBe(2);
    expect(noOut.json.error.message).toMatch(/-o/);
    const two = await cli(["ai", "--new", "a4", fx.paged, "a flyer", "-o", "x.paged", NP]);
    expect(two.code).toBe(2);
    expect(two.json.error.message).toMatch(/only the brief/);
  });
});
