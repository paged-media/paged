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
// The skip summary (scripts/skip-summary.mjs): a skipped test is listed with
// the reason it gave, from a Playwright JSON report and from bun's JUnit.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { junitSkips, markdown, playwrightSkips } from "./skip-summary.mjs";

const SCRIPT = fileURLToPath(new URL("./skip-summary.mjs", import.meta.url));

const playwright = {
  suites: [
    {
      title: "journey/plugins/data.journey.spec.ts",
      file: "journey/plugins/data.journey.spec.ts",
      suites: [
        {
          title: "journey · paged.data",
          specs: [
            {
              title: "imports a CSV",
              file: "journey/plugins/data.journey.spec.ts",
              line: 40,
              tests: [
                {
                  projectName: "journeys",
                  status: "skipped",
                  annotations: [
                    {
                      type: "skip",
                      description: "the data engine did not boot",
                    },
                  ],
                },
              ],
            },
            {
              title: "runs",
              file: "journey/plugins/data.journey.spec.ts",
              line: 60,
              tests: [{ projectName: "journeys", status: "expected" }],
            },
            {
              title: "not built yet",
              file: "journey/plugins/data.journey.spec.ts",
              line: 80,
              tests: [
                {
                  projectName: "journeys",
                  status: "skipped",
                  annotations: [{ type: "fixme" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" skipped="3">
  <testsuite name="a.test.ts" file="a.test.ts">
    <testcase name="runs" classname="outer" time="0.0004" file="a.test.ts" line="3" assertions="1" />
    <testcase name="needs &lt;a server&gt; &amp; a token" classname="outer" time="0" file="a.test.ts" line="4" assertions="0">
      <skipped />
    </testcase>
    <testcase name="later" classname="outer" time="0" file="a.test.ts" line="6" assertions="0">
      <skipped message="TODO" />
    </testcase>
    <testcase name="fails" classname="outer" time="0" file="a.test.ts" line="8"><failure message="x" /></testcase>
  </testsuite>
</testsuites>`;

describe("the skip summary", () => {
  test("a Playwright skip is listed with its project, place and reason; a passed test is not", () => {
    expect(playwrightSkips(playwright)).toEqual([
      {
        lane: "journeys",
        file: "journey/plugins/data.journey.spec.ts",
        line: 40,
        title: "journey · paged.data › imports a CSV",
        kind: "skip",
        reason: "the data engine did not boot",
      },
      {
        lane: "journeys",
        file: "journey/plugins/data.journey.spec.ts",
        line: 80,
        title: "journey · paged.data › not built yet",
        kind: "fixme",
        reason: "",
      },
    ]);
  });

  test("bun's JUnit: skipped and todo cases are listed, passed and failed ones are not", () => {
    expect(junitSkips(junit, "shell")).toEqual([
      {
        lane: "shell",
        file: "a.test.ts",
        line: 4,
        title: "outer › needs <a server> & a token",
        kind: "skip",
        reason: "",
      },
      {
        lane: "shell",
        file: "a.test.ts",
        line: 6,
        title: "outer › later",
        kind: "todo",
        reason: "",
      },
    ]);
  });

  test("the summary counts, groups by reason and says a skip is not a pass", () => {
    const md = markdown("Playwright", playwrightSkips(playwright));
    expect(md).toContain("### Playwright: 2 skipped (not run, not passed)");
    expect(md).toContain("| 1 | the data engine did not boot |");
    expect(md).toContain("| 1 | (fixme, no reason given) |");
    expect(md).toContain("journey/plugins/data.journey.spec.ts:40");
  });

  test("no skips is said, not left blank", () => {
    expect(markdown("bun test", [])).toContain("Every collected test ran.");
  });
});

describe("the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "skip-summary-"));
  const run = (...args) =>
    Bun.spawnSync(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });

  test("reads both kinds of report and appends the summary; exit 0 with skips", () => {
    const pw = join(dir, "pw.json");
    const xml = join(dir, "shell.bun.xml");
    const md = join(dir, "summary.md");
    writeFileSync(pw, JSON.stringify(playwright));
    writeFileSync(xml, junit);
    const result = run(
      "--title",
      "editor",
      "--playwright",
      pw,
      "--junit",
      xml,
      "--md-out",
      md,
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("### editor: 4 skipped");
  });

  test("an unreadable report is an error, never 'no skips'", () => {
    const result = run("--playwright", join(dir, "missing.json"));
    expect(result.exitCode).toBe(2);
  });

  test("no report at all is an error", () => {
    expect(run("--title", "x").exitCode).toBe(2);
  });
});
