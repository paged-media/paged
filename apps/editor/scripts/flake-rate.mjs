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

// The Playwright flake rate, as a number per run (apps/editor/docs/adr/228).
//
//   bun scripts/flake-rate.mjs <playwright-json>... \
//     [--json-out flake-rate.json] [--md-out summary.md]
//
// Reads one or more Playwright JSON reports (the merged CI report, a local
// `--reporter=json` run, a `--repeat-each` run) and classifies every test
// (project + file + title path) by all of its attempts:
//
//   passed   every attempt passed
//   failed   every attempt failed (a deterministic red)
//   flaky    it both passed and failed: a retry that passed (Playwright's
//            own `flaky`), or repeats that disagree (`--repeat-each`)
//   skipped  it never ran
//
// flakeRate = flaky / (passed + failed + flaky). Tests tagged @quarantine
// are counted on their own and stay out of the rate: the rate measures the
// gating suite, the quarantine block measures what is parked.
//
// Exit code 0 always when the reports parse; the gate is Playwright's own
// `failOnFlakyTests` in CI. This script makes the number visible and keeps
// it in the evidence (the `playwright-flake-rate` artifact).

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const QUARANTINE_TAG = "quarantine";

/** Walk a Playwright JSON report; yield one record per test attempt set. */
export function* testsOf(report) {
  function* walk(suite, path) {
    const here =
      suite.title && !suite.title.endsWith(".ts")
        ? [...path, suite.title]
        : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        yield {
          project: t.projectName ?? "",
          file: spec.file ?? suite.file ?? "",
          titlePath: [...here, spec.title],
          tags: spec.tags ?? [],
          status: t.status,
          results: (t.results ?? []).map((r) => r.status),
        };
      }
    }
    for (const child of suite.suites ?? []) yield* walk(child, here);
  }
  for (const s of report.suites ?? []) yield* walk(s, []);
}

/** The id a quarantine entry names: `file › describe › title`. */
export const testId = (t) => [t.file, ...t.titlePath].join(" › ");

/** Classify every test across all reports. */
export function flakeRate(reports) {
  /** @type {Map<string, {project:string,id:string,tags:string[],pass:number,fail:number,skip:number}>} */
  const byKey = new Map();
  for (const report of reports) {
    for (const t of testsOf(report)) {
      const id = testId(t);
      const key = `${t.project} :: ${id}`;
      const row = byKey.get(key) ?? {
        project: t.project,
        id,
        tags: t.tags,
        pass: 0,
        fail: 0,
        skip: 0,
      };
      if (t.status === "skipped" || t.results.length === 0) row.skip++;
      for (const r of t.results) {
        if (r === "passed") row.pass++;
        else if (r === "skipped") row.skip++;
        else row.fail++; // failed, timedOut, interrupted
      }
      byKey.set(key, row);
    }
  }
  const gating = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const quarantined = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const flakyTests = [];
  const failedTests = [];
  for (const row of byKey.values()) {
    const bucket = row.tags.includes(QUARANTINE_TAG) ? quarantined : gating;
    const name = `[${row.project}] ${row.id}`;
    let verdict;
    if (row.pass > 0 && row.fail > 0) verdict = "flaky";
    else if (row.fail > 0) verdict = "failed";
    else if (row.pass > 0) verdict = "passed";
    else verdict = "skipped";
    bucket[verdict]++;
    if (bucket === gating && verdict === "flaky")
      flakyTests.push(`${name} (${row.pass} passed, ${row.fail} failed)`);
    if (bucket === gating && verdict === "failed") failedTests.push(name);
  }
  const ran = gating.passed + gating.failed + gating.flaky;
  return {
    schema: 1,
    reports: reports.length,
    attempts: [...byKey.values()].reduce((n, r) => n + r.pass + r.fail, 0),
    tests: { ...gating, ran },
    flakeRate: ran === 0 ? 0 : gating.flaky / ran,
    quarantined: {
      ...quarantined,
      ran: quarantined.passed + quarantined.failed + quarantined.flaky,
    },
    flakyTests: flakyTests.sort(),
    failedTests: failedTests.sort(),
  };
}

export function markdown(r) {
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const lines = [
    "### Playwright flake rate",
    "",
    "| | tests | passed | failed | flaky | skipped | flake rate |",
    "|---|---|---|---|---|---|---|",
    `| gating | ${r.tests.ran} | ${r.tests.passed} | ${r.tests.failed} | ${r.tests.flaky} | ${r.tests.skipped} | ${pct(r.flakeRate)} |`,
    `| quarantined | ${r.quarantined.ran} | ${r.quarantined.passed} | ${r.quarantined.failed} | ${r.quarantined.flaky} | ${r.quarantined.skipped} | — |`,
    "",
  ];
  if (r.flakyTests.length) {
    lines.push("Flaky (quarantine or fix; `tests/quarantine.json`):", "");
    for (const t of r.flakyTests) lines.push(`- ${t}`);
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = [];
  let jsonOut = null;
  let mdOut = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json-out") jsonOut = args[++i];
    else if (args[i] === "--md-out") mdOut = args[++i];
    else files.push(args[i]);
  }
  if (files.length === 0) {
    console.error(
      "usage: flake-rate.mjs <playwright-json>... [--json-out f] [--md-out f]",
    );
    process.exit(2);
  }
  const reports = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  const result = flakeRate(reports);
  const md = markdown(result);
  console.log(md);
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`);
  if (mdOut) appendFileSync(mdOut, `${md}\n`);
}
