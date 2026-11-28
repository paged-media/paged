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
// The Playwright shards, split by how long each spec file takes.
//
//   bun scripts/playwright-shards.mjs --list <playwright --list json> \
//     --shards <n> --shard <i> --out <test-list file> [--md-out summary.md]
//   bun scripts/playwright-shards.mjs --list <json> --shards <n> --table
//   bun scripts/playwright-shards.mjs --update <merged playwright json>...
//
// Playwright's own `--shard=i/n` cuts the test list into n runs of equal test
// COUNT, in file order. The files differ by two orders of magnitude (the
// menu matrix: 17 minutes; a panel spec: 5 seconds), so ten such shards ran
// between 2 and 47 minutes. This script reads what Playwright would run
// (`playwright test --list --reporter=json`, with the run's own --project and
// --grep options, so the split can never name a file the run does not
// collect or miss one it does), weighs each (project, file) by its measured
// seconds in apps/canvas/tests/shard-durations.json, and deals the files out
// longest first, each to the lightest shard so far. Shard i's files are
// written as a Playwright `--test-list` file: one `[project] › file` line
// per file, the file relative to the config's rootDir.
//
// A file the map does not know (a new spec) weighs its test count times the
// map's median seconds per test, so the split degrades by a little, never
// fails. The map is refreshed from a merged CI report (the
// `playwright-results` artifact of editor / tests) with --update; it only
// balances the shards, so a stale map costs minutes, not correctness: every
// listed file is in exactly one shard whatever the map says (--out checks
// that before it writes).
//
// Whole files are dealt, never single tests: a file's tests run in order in
// one worker, and several files are serial groups that share a page.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DURATIONS_FILE = resolve(
  HERE,
  "..",
  "apps",
  "canvas",
  "tests",
  "shard-durations.json",
);

/** Seconds per test for a file the map does not know, when the map is
 *  empty too. */
const FALLBACK_SECONDS_PER_TEST = 7;

/** Walk a Playwright JSON report (a `--list` or a run); one record per
 *  (project, file): the test count and the seconds its attempts took. */
export function filesOf(report) {
  const files = new Map();
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const project = t.projectName ?? "";
        const path = spec.file ?? file ?? "";
        const key = `${project}\t${path}`;
        const row = files.get(key) ?? {
          project,
          file: path,
          tests: 0,
          ran: 0,
          seconds: 0,
        };
        row.tests += 1;
        const results = t.results ?? [];
        if (results.some((r) => r.status !== "skipped")) row.ran += 1;
        for (const r of results) row.seconds += (r.duration ?? 0) / 1000;
        files.set(key, row);
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.file ?? file);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return [...files.values()];
}

/** The median seconds per test over the map's files that have a count. */
export function medianSecondsPerTest(durations) {
  const rates = [];
  for (const files of Object.values(durations.projects ?? {})) {
    for (const entry of Object.values(files)) {
      if (entry.tests > 0) rates.push(entry.seconds / entry.tests);
    }
  }
  if (rates.length === 0) return FALLBACK_SECONDS_PER_TEST;
  rates.sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)];
}

/** Each listed file with its weight in seconds: the map's, scaled to the
 *  listed test count when the file has gained or lost tests, or the estimate
 *  for a file the map does not know. */
export function weigh(listed, durations) {
  const perTest = medianSecondsPerTest(durations);
  return listed.map((f) => {
    const known = durations.projects?.[f.project]?.[f.file];
    if (!known) return { ...f, weight: f.tests * perTest, estimated: true };
    const scale = known.tests > 0 ? f.tests / known.tests : 1;
    return { ...f, weight: known.seconds * scale, estimated: false };
  });
}

/** Deal the weighed files into `shards` bins: longest first, each to the
 *  lightest bin so far (ties: the lower bin, then the path, so the split is
 *  the same on every runner). */
export function assign(weighed, shards) {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`--shards must be a positive integer, got ${shards}`);
  }
  const bins = Array.from({ length: shards }, () => ({ weight: 0, files: [] }));
  const order = [...weighed].sort(
    (a, b) =>
      b.weight - a.weight ||
      a.project.localeCompare(b.project) ||
      a.file.localeCompare(b.file),
  );
  for (const f of order) {
    let lightest = bins[0];
    for (const bin of bins) if (bin.weight < lightest.weight) lightest = bin;
    lightest.files.push(f);
    lightest.weight += f.weight;
  }
  for (const bin of bins) {
    bin.files.sort(
      (a, b) =>
        a.project.localeCompare(b.project) || a.file.localeCompare(b.file),
    );
  }
  return bins;
}

/** Every listed file is in exactly one bin; throws otherwise. */
export function assertPartition(listed, bins) {
  const seen = new Map();
  for (const bin of bins) {
    for (const f of bin.files) {
      const key = `${f.project}\t${f.file}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const wrong = listed
    .map((f) => `${f.project}\t${f.file}`)
    .filter((key) => seen.get(key) !== 1);
  if (wrong.length > 0 || seen.size !== listed.length) {
    throw new Error(
      `the shards are not a partition of the listed files: ${wrong.join(", ") || "extra files"}`,
    );
  }
}

/** A Playwright `--test-list` file for one bin. */
export function testList(bin) {
  return bin.files.map((f) => `[${f.project}] › ${f.file}`).join("\n") + "\n";
}

/** The duration map of one or more run reports: per (project, file) the
 *  seconds of every attempt and the number of tests that ran. A file that
 *  only skipped keeps no entry. With several reports, the mean. */
export function durationsOf(reports) {
  const sums = new Map();
  for (const report of reports) {
    for (const f of filesOf(report)) {
      if (f.ran === 0) continue;
      const key = `${f.project}\t${f.file}`;
      const row = sums.get(key) ?? { ...f, seconds: 0, tests: 0, n: 0 };
      row.seconds += f.seconds;
      row.tests += f.tests;
      row.n += 1;
      sums.set(key, row);
    }
  }
  const projects = {};
  const rows = [...sums.values()].sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.file.localeCompare(b.file),
  );
  for (const row of rows) {
    (projects[row.project] ??= {})[row.file] = {
      seconds: Math.round((row.seconds / row.n) * 10) / 10,
      tests: Math.round(row.tests / row.n),
    };
  }
  return projects;
}

function table(bins, workers) {
  const minutes = (s) => (s / 60).toFixed(1);
  const lines = [
    "| shard | files | tests | test minutes | of which estimated | longest file (min) |",
    "| ----: | ----: | ----: | -----------: | -----------------: | :----------------- |",
  ];
  bins.forEach((bin, i) => {
    const longest = [...bin.files].sort((a, b) => b.weight - a.weight)[0];
    const estimated = bin.files
      .filter((f) => f.estimated)
      .reduce((n, f) => n + f.weight, 0);
    lines.push(
      `| ${i + 1} | ${bin.files.length} | ${bin.files.reduce((n, f) => n + f.tests, 0)} | ${minutes(bin.weight)} | ${minutes(estimated)} | ${longest ? `${longest.file} (${minutes(longest.weight)})` : ""} |`,
    );
  });
  const total = bins.reduce((n, b) => n + b.weight, 0);
  lines.push(
    "",
    `Test minutes are the sum of each file's measured test time on one worker (${minutes(total)} in all); a shard with ${workers} worker(s) needs about that divided by ${workers}, and never less than its longest file.`,
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { update: [], workers: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--list") args.list = value();
    else if (a === "--durations") args.durations = value();
    else if (a === "--shards") args.shards = Number(value());
    else if (a === "--shard") args.shard = Number(value());
    else if (a === "--workers") args.workers = Number(value());
    else if (a === "--out") args.out = value();
    else if (a === "--md-out") args.mdOut = value();
    else if (a === "--table") args.table = true;
    else if (a === "--update") args.updating = true;
    else if (args.updating && !a.startsWith("--")) args.update.push(a);
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const durationsFile = args.durations ?? DURATIONS_FILE;
  if (args.updating) {
    if (args.update.length === 0) {
      throw new Error("--update needs at least one Playwright JSON report");
    }
    const reports = args.update.map((p) => JSON.parse(readFileSync(p, "utf8")));
    const previous = JSON.parse(readFileSync(durationsFile, "utf8"));
    const next = { ...previous, projects: durationsOf(reports) };
    writeFileSync(durationsFile, JSON.stringify(next, null, 2) + "\n");
    console.log(`wrote ${durationsFile}`);
    return;
  }
  if (!args.list)
    throw new Error("--list <playwright --list json> is required");
  const listed = filesOf(JSON.parse(readFileSync(args.list, "utf8")));
  // An empty listing is a broken listing (a wrong --project, a config that
  // did not load), never "nothing to run".
  if (listed.length === 0) {
    throw new Error(`${args.list} lists no tests`);
  }
  const durations = JSON.parse(readFileSync(durationsFile, "utf8"));
  const bins = assign(weigh(listed, durations), args.shards);
  assertPartition(listed, bins);
  const report = table(bins, args.workers);
  if (args.table) console.log(report);
  if (args.out) {
    if (!(args.shard >= 1 && args.shard <= args.shards)) {
      throw new Error(`--shard must be 1..${args.shards}, got ${args.shard}`);
    }
    const bin = bins[args.shard - 1];
    if (bin.files.length === 0) {
      throw new Error(
        `shard ${args.shard}/${args.shards} is empty: fewer files than shards`,
      );
    }
    writeFileSync(args.out, testList(bin));
    console.log(
      `shard ${args.shard}/${args.shards}: ${bin.files.length} files, ${(bin.weight / 60).toFixed(1)} test minutes -> ${args.out}`,
    );
    if (args.mdOut) {
      appendFileSync(
        args.mdOut,
        `### Playwright shards by duration (this is shard ${args.shard})\n\n${report}\n`,
      );
    }
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`playwright-shards: ${err.message}`);
    process.exit(2);
  }
}
