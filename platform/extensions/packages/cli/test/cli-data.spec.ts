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
// ADR 324 — `paged merge` / `paged apply` over TODAY's paged.data session
// (@paged-media/data canary.10): the real data-js engine, DuckDB in-process
// (Node blocking build + the bundle's shipped engine wasm) and real core.
// The merge is compared with InDesign's own Data Merge recording of the
// long-record-set fixture (vendored from plugin-data
// conformance/indesign-merge): 57 records, 2 columns, columns first, 3 pages.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSession } from "../src/session";
import { cli, FIXTURES, tempDir, writeFixture } from "./helpers";

const LANE = join(FIXTURES, "indesign-merge");
const DATA = "--plugins=@paged-media/data";

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
});
afterAll(() => tmp.done());

const normalise = (s: string) => s.replace(/\r/g, "\n").replace(/\uFEFF/g, "");

describe("paged merge — InDesign Data Merge oracle (long-record-set)", () => {
  it("57 records over 3 pages; every frame's text matches the recording", async () => {
    const rec = JSON.parse(readFileSync(join(LANE, "long-record-set.json"), "utf8"));
    const out = join(tmp.dir, "merged");
    const r = await cli([
      "merge", join(LANE, "long-record-set.idml"),
      "--data", join(LANE, "long-record-set.csv"),
      "--out", out, "--format", "paged",
      "--records-per-page", "multiple", "--arrange", "columns", "--row-spacing", "6", "--column-spacing", "12",
      DATA,
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.records).toBe(57);
    expect(r.json.outputs).toHaveLength(1);
    expect(r.json.outputs[0]).toMatchObject({ pages: rec.merged.page_count, records: 57, overset: [] });
    expect(rec.merged.page_count).toBe(3);

    // Read the written file back, independently of the merge.
    const s = await openSession(r.json.outputs[0].path, { plugins: [] });
    try {
      const doc = s.driver.document;
      const pages = await doc.collection<{ selfId: string }>("pages");
      expect(pages).toHaveLength(3);
      let frames = 0;
      for (const [p, page] of (rec.merged.pages as Array<{ text_frames: Array<{ bounds: number[]; text: string }> }>).entries()) {
        for (const tf of page.text_frames) {
          const b = tf.bounds;
          const hit = await doc.hitTest(pages[p]!.selfId as never, [(b[1]! + b[3]!) / 2, (b[0]! + b[2]!) / 2]);
          expect(hit?.storyId, `page ${p + 1} frame at ${b}`).toBeTruthy();
          const content = await doc.storyContent(hit!.storyId!);
          const text = content!.paragraphs.map((x) => x.runs.map((run) => run.text).join("")).join("\n");
          expect(text).toBe(normalise(tf.text));
          frames++;
        }
      }
      expect(frames).toBe(57);
    } finally {
      s.dispose();
    }
  });

  it("--per-record writes one PDF per record, back to the template between records", async () => {
    const csv = join(tmp.dir, "three.csv");
    writeFileSync(csv, readFileSync(join(LANE, "long-record-set.csv"), "utf8").split("\n").slice(0, 4).join("\n") + "\n");
    const out = join(tmp.dir, "per-record");
    const r = await cli(["merge", join(LANE, "long-record-set.idml"), "--data", csv, "--out", out, "--format", "pdf", "--per-record", DATA]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.outputs.map((o: { path: string }) => o.path.split("/").pop())).toEqual([
      "long-record-set-1.pdf",
      "long-record-set-2.pdf",
      "long-record-set-3.pdf",
    ]);
    for (const o of r.json.outputs) {
      expect(o.pages).toBe(1);
      expect(readFileSync(o.path).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  it("merge without the data bundle is a usage error naming what to install", async () => {
    const r = await cli(["merge", join(LANE, "long-record-set.idml"), "--data", join(LANE, "long-record-set.csv"), "--out", tmp.dir, "--no-plugins"]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/install @paged-media\/data/);
  });
});

describe("paged apply", () => {
  it("interim property bindings: one record's fields → typed properties in ONE write", async () => {
    const csv = join(tmp.dir, "apply.csv");
    writeFileSync(csv, 'title,ink,weight\n"First, row","[0,0,0,10]",1mm\nSecond,"[0,0,0,60]",3pt\n');
    const bindings = join(tmp.dir, "b.json");
    writeFileSync(
      bindings,
      JSON.stringify({
        bindings: [
          { kind: "property", target: "story", path: "content", field: "title" },
          { kind: "property", target: "swatch[name=Black]", path: "value", field: "ink" },
          { kind: "property", target: "rectangle:urect", path: "frameStrokeWeight", field: "weight" },
        ],
      }),
    );
    const out = join(tmp.dir, "applied.paged");
    const r = await cli(["apply", fx.paged, "--data", csv, "--bindings", bindings, "--record", "1", "-o", out, DATA]);
    expect(r.code, r.out).toBe(0);
    expect(r.json).toMatchObject({ records: 2, record: 1, property: { ops: 3, undoSteps: 1 } });
    expect((await cli(["get", out, "story", "content", "--no-plugins"])).json.results[0].value).toBe("Second");
    expect((await cli(["get", out, "swatch:Black", "value", "--no-plugins"])).json.value).toEqual([0, 0, 0, 60]);
    expect((await cli(["get", out, "rectangle:urect", "frameStrokeWeight", "--no-plugins"])).json.value).toBe(3);
  });

  it("a field that does not fit the schema is refused by path and type", async () => {
    const csv = join(tmp.dir, "bad.csv");
    writeFileSync(csv, "weight\nheavy\n");
    const bindings = join(tmp.dir, "bad.json");
    writeFileSync(bindings, JSON.stringify([{ kind: "property", target: "rectangle:urect", path: "frameStrokeWeight", field: "weight" }]));
    const r = await cli(["apply", fx.paged, "--data", csv, "--bindings", bindings, "--no-save", DATA]);
    expect(r.code).toBe(1);
    expect(r.json.error.message).toMatch(/frameStrokeWeight.*expected length/);
  });

  it("expression property bindings wait for Wave 5 (universal Binding::Property)", async () => {
    const csv = join(tmp.dir, "w5.csv");
    writeFileSync(csv, "a\n1\n");
    const bindings = join(tmp.dir, "w5.json");
    writeFileSync(bindings, JSON.stringify([{ kind: "property", target: "rectangle:urect", path: "frameStrokeWeight", expr: "MM(a)" }]));
    const r = await cli(["apply", fx.paged, "--data", csv, "--bindings", bindings, "--no-save", DATA]);
    expect(r.code).toBe(1);
    expect(r.json.error.message).toMatch(/needs Wave 5/);
  });
});

describe("paged plugins", () => {
  it("lists the discovered bundle and the engine protocol", async () => {
    const r = await cli(["plugins", DATA]);
    expect(r.code).toBe(0);
    expect(r.json.protocol).toBe(Number(r.json.engine.split(".")[1]));
    expect(r.json.plugins.map((p: { id: string }) => p.id)).toEqual(["media.paged.data"]);
    expect(r.json.plugins[0].version).toBe("0.1.0-canary.10");
  });

  it("auto discovery finds first-party bundles resolvable from the cwd", async () => {
    const r = await cli(["plugins"], join(FIXTURES, ".."));
    expect(r.json.plugins.map((p: { id: string }) => p.id)).toContain("media.paged.data");
  });
});
