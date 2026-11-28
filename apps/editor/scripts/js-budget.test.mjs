/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The JavaScript size ratchet against fixture builds: a gate that measures
// less than is there passes everything, so each outcome is pinned, through
// the functions and through the command's exit code.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { entryScripts, judge, measure, resolveScript } from "./js-budget.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "js-budget.mjs");
const scratch = mkdtempSync(join(tmpdir(), "js-budget-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Incompressible enough that gzip sizes move with the raw ones.
const body = (n, seed) => {
  let s = "";
  let x = seed;
  while (s.length < n) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += x.toString(36);
  }
  return s.slice(0, n);
};

let builds = 0;
/** A build directory: `main` is the entry script's size, `lazy` a chunk no
 *  HTML names. */
function build({ main = 4000, lazy = 9000, embed = true } = {}) {
  const dist = join(scratch, `dist-${builds++}`);
  mkdirSync(join(dist, "assets"), { recursive: true });
  const files = {
    "assets/main-AAAA.js": body(main, 1),
    "assets/react-BBBB.js": body(2000, 2),
    "assets/embed-CCCC.js": body(1000, 3),
    "assets/lazy-DDDD.js": body(lazy, 4),
  };
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dist, name), text);
  writeFileSync(
    join(dist, "index.html"),
    `<!doctype html><html><head>
      <script type="module" crossorigin src="/assets/main-AAAA.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/react-BBBB.js">
      <link rel="stylesheet" crossorigin href="/assets/main-EEEE.css">
    </head><body></body></html>`,
  );
  if (embed)
    writeFileSync(
      join(dist, "embed.html"),
      `<script type="module" src="/assets/embed-CCCC.js"></script>`,
    );
  return { dist, files };
}

const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "" },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

/** A recorded budget of `dist`, written by the command itself. */
function record(dist) {
  const budget = join(scratch, `budget-${builds++}.json`);
  const r = run("--dist", dist, "--budget", budget, "--write");
  expect(r.code).toBe(0);
  return budget;
}

describe("what an entry is", () => {
  test("the scripts and modulepreloads of the HTML, not its stylesheets", () => {
    expect(
      entryScripts(
        `<script type="module" src="/a.js"></script>
         <link rel="modulepreload" href='/b.js'>
         <link rel="stylesheet" href="/c.css"><script>inline()</script>`,
      ),
    ).toEqual(["/a.js", "/b.js"]);
  });

  test("a URL under a base path resolves to the build's file; another origin's does not", () => {
    const { dist } = build();
    expect(resolveScript(dist, "/editor/assets/main-AAAA.js")).toBe(
      join(dist, "assets/main-AAAA.js"),
    );
    expect(resolveScript(dist, "https://cdn.example/x.js")).toBeNull();
    expect(resolveScript(dist, "/assets/absent.js")).toBeNull();
  });

  test("an entry is the sum of its scripts, raw and gzip; lazy chunks count only in the total", () => {
    const { dist, files } = build();
    const m = measure(dist);
    const gz = (name) => gzipSync(Buffer.from(files[name])).length;
    expect(m.entries.main).toEqual({
      html: "index.html",
      files: 2,
      raw: 6000,
      gzip: gz("assets/main-AAAA.js") + gz("assets/react-BBBB.js"),
    });
    expect(m.entries.embed.raw).toBe(1000);
    expect(m.assets.files).toBe(4);
    expect(m.assets.raw).toBe(16000);
  });
});

describe("the ratchet", () => {
  test("the recorded build passes", () => {
    const { dist } = build();
    const budget = record(dist);
    const r = run("--dist", dist, "--budget", budget);
    expect(r.code).toBe(0);
    expect(r.out).toContain("main raw: 6000 bytes, recorded 6000");
  });

  test("growth within the tolerance passes, growth past it fails", () => {
    const budget = record(build().dist);
    // 6000 recorded, one percent is 60 bytes.
    expect(
      run("--dist", build({ main: 4040 }).dist, "--budget", budget).code,
    ).toBe(0);
    const over = run("--dist", build({ main: 4400 }).dist, "--budget", budget);
    expect(over.code).toBe(1);
    expect(over.out).toContain("main raw: 6400 bytes, recorded 6000");
    expect(over.out).toContain("over");
  });

  test("a lazy chunk may grow: only entries are held", () => {
    const budget = record(build().dist);
    expect(
      run("--dist", build({ lazy: 90000 }).dist, "--budget", budget).code,
    ).toBe(0);
  });

  test("an entry well under its record is reported, not failed", () => {
    const budget = record(build().dist);
    const r = run("--dist", build({ main: 2000 }).dist, "--budget", budget);
    expect(r.code).toBe(0);
    expect(r.out).toContain("under its record");
    const rows = judge(
      JSON.parse(readFileSync(budget, "utf8")),
      measure(build({ main: 2000 }).dist),
    );
    expect(
      rows.find((x) => x.entry === "main" && x.metric === "raw").status,
    ).toBe("slack");
  });

  test("--write records the current sizes by entry, with no file name in the record", () => {
    const { dist } = build();
    const budget = record(dist);
    const text = readFileSync(budget, "utf8");
    const doc = JSON.parse(text);
    expect(doc.tolerance).toBe(0.01);
    expect(doc.entries.main.raw).toBe(6000);
    expect(doc.entries.embed.raw).toBe(1000);
    expect(text).not.toContain("AAAA");
    // A grown build fails until the record is written again.
    const grown = build({ main: 8000 }).dist;
    expect(run("--dist", grown, "--budget", budget).code).toBe(1);
    expect(run("--dist", grown, "--budget", budget, "--write").code).toBe(0);
    expect(JSON.parse(readFileSync(budget, "utf8")).entries.main.raw).toBe(
      10000,
    );
    expect(run("--dist", grown, "--budget", budget).code).toBe(0);
  });

  test("--json-out writes the measurement and keeps the gate's exit code", () => {
    const budget = record(build().dist);
    const out = join(scratch, "measurement.json");
    const r = run(
      "--dist",
      build({ main: 8000 }).dist,
      "--budget",
      budget,
      "--json-out",
      out,
    );
    expect(r.code).toBe(1);
    const doc = JSON.parse(readFileSync(out, "utf8"));
    expect(doc.lane).toBe("js-budget");
    const raw = doc.measurements.find(
      (m) => m.metric === "js.entry_raw_bytes" && m.subject === "main",
    );
    expect(raw.value).toBe(10000);
    expect(raw.status).toBe("over");
  });
});

describe("nothing measured is never a pass", () => {
  test("no build directory fails, and --write records nothing", () => {
    const budget = record(build().dist);
    const before = readFileSync(budget, "utf8");
    const absent = join(scratch, "no-such-dist");
    const r = run("--dist", absent, "--budget", budget);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no build at");
    expect(run("--dist", absent, "--budget", budget, "--write").code).toBe(1);
    expect(readFileSync(budget, "utf8")).toBe(before);
    expect(() => measure(absent)).toThrow(/no build at/);
  });

  test("a recorded entry whose HTML is gone fails", () => {
    const budget = record(build().dist);
    const r = run("--dist", build({ embed: false }).dist, "--budget", budget);
    expect(r.code).toBe(1);
    expect(r.out).toContain("embed raw was not measured");
  });

  test("a script the HTML names that is not in the build fails", () => {
    const { dist } = build();
    const budget = record(dist);
    rmSync(join(dist, "assets/react-BBBB.js"));
    const r = run("--dist", dist, "--budget", budget);
    expect(r.code).toBe(1);
    expect(r.out).toContain("which is not in the build");
  });

  test("no record fails, and an entry the record does not know fails", () => {
    const { dist } = build();
    const none = join(scratch, "no-budget.json");
    expect(run("--dist", dist, "--budget", none).code).toBe(1);
    expect(existsSync(none)).toBe(false);
    const partial = join(scratch, "partial.json");
    writeFileSync(
      partial,
      JSON.stringify({ entries: { main: { raw: 6000, gzip: 99999 } } }),
    );
    const r = run("--dist", dist, "--budget", partial);
    expect(r.code).toBe(1);
    expect(r.out).toContain("has no number for it");
  });
});
