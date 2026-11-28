#!/usr/bin/env bun
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
// The shard split (scripts/playwright-shards.mjs): every listed file lands in
// exactly one shard whatever the duration map says, the shards are balanced
// by seconds and not by count, and the split is deterministic.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPartition,
  assign,
  durationsOf,
  filesOf,
  medianSecondsPerTest,
  testList,
  weigh,
} from "./playwright-shards.mjs";

const SCRIPT = fileURLToPath(
  new URL("./playwright-shards.mjs", import.meta.url),
);

/** A Playwright JSON report: `files` is [project, file, [seconds...]]; a
 *  negative entry is a skipped test, `undefined` a listed one (no results). */
function report(files) {
  const byFile = new Map();
  for (const [project, file, tests] of files) {
    const suite = byFile.get(file) ?? { title: file, file, specs: [] };
    tests.forEach((seconds, i) => {
      suite.specs.push({
        title: `${project} test ${i}`,
        file,
        tests: [
          {
            projectName: project,
            results:
              seconds === undefined
                ? []
                : [
                    {
                      status: seconds < 0 ? "skipped" : "passed",
                      duration: Math.abs(seconds) * 1000,
                    },
                  ],
          },
        ],
      });
    });
    byFile.set(file, suite);
  }
  return { suites: [...byFile.values()] };
}

const listing = report([
  ["chromium", "e2e/matrix.spec.ts", Array(44).fill(undefined)],
  ["chromium", "a-panel.spec.ts", Array(5).fill(undefined)],
  ["chromium", "b-panel.spec.ts", Array(5).fill(undefined)],
  ["chromium", "c-panel.spec.ts", Array(5).fill(undefined)],
  ["journeys", "journey/x.journey.spec.ts", Array(2).fill(undefined)],
  ["chromium", "new.spec.ts", Array(4).fill(undefined)],
]);

const durations = {
  projects: {
    chromium: {
      "e2e/matrix.spec.ts": { seconds: 1000, tests: 44 },
      "a-panel.spec.ts": { seconds: 300, tests: 5 },
      "b-panel.spec.ts": { seconds: 300, tests: 5 },
      "c-panel.spec.ts": { seconds: 300, tests: 5 },
    },
    journeys: { "journey/x.journey.spec.ts": { seconds: 100, tests: 2 } },
  },
};

describe("the shard split", () => {
  test("a listing yields one row per project and file, with its test count", () => {
    const rows = filesOf(listing);
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.file === "e2e/matrix.spec.ts")).toMatchObject({
      project: "chromium",
      tests: 44,
    });
  });

  test("a known file weighs its measured seconds; an unknown one its tests times the median rate", () => {
    const weighed = weigh(filesOf(listing), durations);
    const of = (file) => weighed.find((w) => w.file === file);
    expect(of("e2e/matrix.spec.ts")).toMatchObject({
      weight: 1000,
      estimated: false,
    });
    // Rates: 1000/44, 60, 60, 60, 50 -> median 60 s a test.
    expect(medianSecondsPerTest(durations)).toBe(60);
    expect(of("new.spec.ts")).toMatchObject({ weight: 240, estimated: true });
  });

  test("a file that gained tests since the map was written weighs proportionally more", () => {
    const grown = report([
      ["chromium", "a-panel.spec.ts", Array(10).fill(undefined)],
    ]);
    expect(weigh(filesOf(grown), durations)[0].weight).toBe(600);
  });

  test("the shards are balanced by seconds, not by test count", () => {
    const bins = assign(weigh(filesOf(listing), durations), 2);
    // 2240 s in all: the matrix (1000) with the journey and the new file,
    // against the three panels (900) ... longest first, lightest bin.
    const weights = bins.map((b) => Math.round(b.weight));
    expect(weights.reduce((a, b) => a + b)).toBe(2240);
    expect(Math.abs(weights[0] - weights[1])).toBeLessThanOrEqual(300);
    // By count the split would have been 44 tests against 21.
    const counts = bins.map((b) => b.files.reduce((n, f) => n + f.tests, 0));
    expect(counts).not.toEqual([44, 21]);
  });

  test("every listed file is in exactly one shard, for every shard count", () => {
    const listed = filesOf(listing);
    for (const n of [1, 2, 3, 6]) {
      const bins = assign(weigh(listed, durations), n);
      expect(() => assertPartition(listed, bins)).not.toThrow();
      expect(bins.flatMap((b) => b.files)).toHaveLength(listed.length);
    }
  });

  test("an empty duration map still splits every file (by test count)", () => {
    const listed = filesOf(listing);
    const bins = assign(weigh(listed, { projects: {} }), 3);
    expect(() => assertPartition(listed, bins)).not.toThrow();
  });

  test("a split that loses or repeats a file is refused", () => {
    const listed = filesOf(listing);
    const bins = assign(weigh(listed, durations), 2);
    const lost = [{ ...bins[0], files: bins[0].files.slice(1) }, bins[1]];
    expect(() => assertPartition(listed, lost)).toThrow(/not a partition/);
    const twice = [
      bins[0],
      { ...bins[1], files: [...bins[1].files, bins[0].files[0]] },
    ];
    expect(() => assertPartition(listed, twice)).toThrow(/not a partition/);
  });

  test("the split is the same whatever order the listing has", () => {
    const listed = filesOf(listing);
    const a = assign(weigh(listed, durations), 3).map(testList);
    const b = assign(weigh([...listed].reverse(), durations), 3).map(testList);
    expect(b).toEqual(a);
  });

  test("a shard's test list names project and file, as --test-list reads them", () => {
    const bins = assign(weigh(filesOf(listing), durations), 1);
    expect(testList(bins[0]).split("\n")).toContain(
      "[journeys] › journey/x.journey.spec.ts",
    );
  });

  test("a run report becomes a duration map; a file that only skipped has no entry", () => {
    const run = report([
      ["chromium", "a-panel.spec.ts", [1.5, 2.5]],
      ["chromium", "skipped.spec.ts", [-1]],
      ["journeys", "journey/x.journey.spec.ts", [10, -1]],
    ]);
    expect(durationsOf([run])).toEqual({
      chromium: { "a-panel.spec.ts": { seconds: 4, tests: 2 } },
      journeys: { "journey/x.journey.spec.ts": { seconds: 11, tests: 2 } },
    });
  });
});

describe("the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "playwright-shards-"));
  const list = join(dir, "list.json");
  const map = join(dir, "durations.json");
  writeFileSync(list, JSON.stringify(listing));
  writeFileSync(map, JSON.stringify(durations));
  const run = (...args) =>
    Bun.spawnSync(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });

  test("--out writes shard i's test list; the shards together are the listing", () => {
    const lines = [];
    for (const i of [1, 2]) {
      const out = join(dir, `shard-${i}.txt`);
      const result = run(
        "--list",
        list,
        "--durations",
        map,
        "--shards",
        "2",
        "--shard",
        String(i),
        "--out",
        out,
      );
      expect(result.exitCode).toBe(0);
      lines.push(...readFileSync(out, "utf8").trim().split("\n"));
    }
    expect(lines.sort()).toEqual(
      filesOf(listing)
        .map((f) => `[${f.project}] › ${f.file}`)
        .sort(),
    );
  });

  test("an empty listing fails: it is a broken listing, never nothing to run", () => {
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ suites: [] }));
    const result = run(
      "--list",
      empty,
      "--durations",
      map,
      "--shards",
      "2",
      "--shard",
      "1",
      "--out",
      join(dir, "x.txt"),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("lists no tests");
  });

  test("a shard number outside 1..n fails", () => {
    const result = run(
      "--list",
      list,
      "--durations",
      map,
      "--shards",
      "2",
      "--shard",
      "3",
      "--out",
      join(dir, "x.txt"),
    );
    expect(result.exitCode).toBe(2);
  });

  test("more shards than files fails the empty shard instead of running nothing", () => {
    const result = run(
      "--list",
      list,
      "--durations",
      map,
      "--shards",
      "7",
      "--shard",
      "7",
      "--out",
      join(dir, "x.txt"),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("is empty");
  });
});
