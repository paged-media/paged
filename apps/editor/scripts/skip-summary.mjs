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
// What a test run SKIPPED, said in the job summary (docs/development/
// testing.md, rule 1: a skip says so; skipped is not passed).
//
//   bun scripts/skip-summary.mjs --title <heading> \
//     [--playwright <playwright json>...] [--junit <bun junit xml>...] \
//     [--md-out summary.md] [--json-out skips.json]
//
// The JavaScript lanes skip at run time: `test.skip(condition, reason)` and
// `test.fixme` in a Playwright spec (no WebGPU adapter, no pdftoppm, no
// running server), `test.skip` / `test.skipIf` / `test.todo` under bun test.
// Those tests report neither red nor green, and a green job reads as if they
// had run. This lists every one of them, with the reason the test gave, and
// counts them by reason, so the summary says what the run did not check.
//
// Exit code 0 when the reports parse: this reports, it does not gate. A lane
// that must not skip sets the resource's REQUIRE variable (for the data and
// web engines: REQUIRE_REAL_ENGINE=1), which turns the skip into a failure.
// An unreadable report is exit 2: a summary that silently lists nothing
// would say "no skips".

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** The skipped tests of a Playwright JSON report: project, file, line,
 *  title and the reason of its `skip` / `fixme` annotation. */
export function playwrightSkips(report) {
  const out = [];
  const walk = (suite, file, path) => {
    const here =
      suite.title &&
      suite.title !== suite.file &&
      !/\.[cm]?[jt]sx?$/.test(suite.title)
        ? [...path, suite.title]
        : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status !== "skipped") continue;
        const annotation = (t.annotations ?? []).find(
          (a) => a.type === "skip" || a.type === "fixme",
        );
        out.push({
          lane: t.projectName ?? "",
          file: spec.file ?? file ?? "",
          line: spec.line ?? null,
          title: [...here, spec.title].join(" › "),
          kind: annotation?.type ?? "skip",
          reason: (annotation?.description ?? "").trim(),
        });
      }
    }
    for (const child of suite.suites ?? [])
      walk(child, child.file ?? file, here);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file, []);
  return out;
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** The skipped test cases of a JUnit report as bun test writes it. */
export function junitSkips(xml, lane) {
  const out = [];
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const body = match[3] ?? "";
    const skipped = /<skipped\b([^>]*)\/?>/.exec(body);
    if (!skipped) continue;
    const attr = (source, name) => {
      const m = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
      return m ? unescapeXml(m[1]) : "";
    };
    const message = attr(skipped[1], "message");
    out.push({
      lane,
      file: attr(match[1], "file"),
      line: Number(attr(match[1], "line")) || null,
      title: [attr(match[1], "classname"), attr(match[1], "name")]
        .filter(Boolean)
        .join(" › "),
      kind: message === "TODO" ? "todo" : "skip",
      reason: message === "TODO" ? "" : message,
    });
  }
  return out;
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ");
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The summary: a count, the reasons with how many tests gave each, and
 *  every skipped test under a fold. */
export function markdown(title, skips) {
  const lines = [
    `### ${title}: ${skips.length} skipped (not run, not passed)`,
    "",
  ];
  if (skips.length === 0) {
    lines.push("Every collected test ran.", "");
    return lines.join("\n");
  }
  const byReason = new Map();
  for (const s of skips) {
    const key = s.reason || `(${s.kind}, no reason given)`;
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  lines.push(
    "| tests | reason the test gave |",
    "| ----: | :------------------- |",
  );
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${n} | ${cell(short(reason, 300))} |`);
  }
  lines.push("", "<details><summary>every skipped test</summary>", "");
  lines.push(
    "| lane | test | where | kind |",
    "| :--- | :--- | :---- | :--- |",
  );
  for (const s of skips) {
    lines.push(
      `| ${cell(s.lane)} | ${cell(short(s.title, 160))} | ${cell(s.file)}${s.line ? `:${s.line}` : ""} | ${s.kind} |`,
    );
  }
  lines.push("", "</details>", "");
  return lines.join("\n");
}

function main(argv) {
  const args = { playwright: [], junit: [], title: "Skipped tests" };
  let into = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--playwright") into = args.playwright;
    else if (a === "--junit") into = args.junit;
    else if (a === "--title") ((args.title = argv[++i]), (into = null));
    else if (a === "--md-out") ((args.mdOut = argv[++i]), (into = null));
    else if (a === "--json-out") ((args.jsonOut = argv[++i]), (into = null));
    else if (into && !a.startsWith("--")) into.push(a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.playwright.length + args.junit.length === 0) {
    throw new Error(
      "no report given (--playwright <json>... / --junit <xml>...)",
    );
  }
  const skips = [];
  for (const path of args.playwright) {
    skips.push(...playwrightSkips(JSON.parse(readFileSync(path, "utf8"))));
  }
  for (const path of args.junit) {
    const lane = path
      .split("/")
      .pop()
      .replace(/(\.bun)?\.xml$/, "");
    skips.push(...junitSkips(readFileSync(path, "utf8"), lane));
  }
  const md = markdown(args.title, skips);
  if (args.mdOut) appendFileSync(args.mdOut, `${md}\n`);
  else console.log(md);
  if (args.jsonOut)
    writeFileSync(args.jsonOut, JSON.stringify(skips, null, 2) + "\n");
  if (skips.length > 0 && process.env.GITHUB_ACTIONS) {
    console.log(
      `::notice title=${args.title}::${skips.length} test(s) were skipped in this run and are not a pass; the job summary lists each with its reason.`,
    );
  }
  console.log(`${args.title}: ${skips.length} skipped`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`skip-summary: ${err.message}`);
    process.exit(2);
  }
}
