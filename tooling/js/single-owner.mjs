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

// The single-owner ratchet (docs/adr/PM-0017, docs/development/capability-register.md).
//
//   bun tooling/js/single-owner.mjs            check (CI)
//   bun tooling/js/single-owner.mjs --write    record the copies that exist
//
// A capability has ONE owner. Each rule in `tooling/single-owner.json` names a
// capability by a pattern that only its implementation contains (a lookup
// table, a constant, a polynomial), the owner paths that may hold it, and a
// baseline: the files that still hold a copy today. The check fails when
//   - a file outside the owner and the baseline matches (a new copy: use the
//     owner's, or if the capability really is different, say so in a rule);
//   - the baseline lists a file that no longer matches (the copy is gone:
//     run --write, so the baseline only ever shrinks).
// Moving a copy to its owner is the way to empty a baseline.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = join(ROOT, "tooling", "single-owner.json");
const EXTENSIONS = [".rs", ".ts", ".tsx", ".mjs"];
/** Paths no rule looks at: generated, vendored, fixtures, and this tool. */
const SKIP = [
  "node_modules/",
  "/target/",
  "/vendor/",
  "/corpus/",
  "/fixtures/",
  "/dist/",
  "tooling/js/single-owner.mjs",
];

const config = JSON.parse(readFileSync(CONFIG, "utf8"));

/** Whether a path is one no rule looks at. */
const skipped = (f) =>
  SKIP.some((s) => `/${f}`.includes(s.startsWith("/") ? s : `/${s}`));

/** The files (tracked by git) `pattern` matches, among `exts`. `git grep -P`
 *  does the reading: natively, in parallel, in a fraction of a second where
 *  reading every file from JavaScript took minutes. */
const filesMatching = (rule, pattern, exts) => {
  const out = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-I",
      "-P",
      "-e",
      pattern,
      "--",
      ...exts.map((e) => `*${e}`),
    ],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  // Exit 1 is "no match"; anything else is a failure to look.
  if (out.status !== 0 && out.status !== 1)
    throw new Error(`git grep failed for ${rule.name}: ${out.stderr}`);
  return out.stdout
    .toString("utf8")
    .split("\n")
    .filter((f) => f && !skipped(f));
};

/** The files any of `patterns` matches, among `extensions`. A rule with
 *  `allOf` names a capability no single line shows (a key listener that
 *  answers Escape): a file then holds a copy only when it ALSO matches every
 *  `allOf` pattern somewhere. */
const matchesOf = (rule) => {
  const exts = rule.extensions ?? EXTENSIONS;
  const found = new Set();
  for (const pattern of rule.patterns)
    for (const f of filesMatching(rule, pattern, exts)) found.add(f);
  for (const pattern of rule.allOf ?? []) {
    const also = new Set(filesMatching(rule, pattern, exts));
    for (const f of [...found]) if (!also.has(f)) found.delete(f);
  }
  return [...found].sort();
};

// `allow` lists exact files that may hold a copy for a stated reason (`allowReason`):
// code that cannot import the owner. It is never a place to park a copy that could move.
const owns = (rule, file) =>
  rule.owner.some((o) => file.startsWith(o)) ||
  (rule.allow ?? []).includes(file);

const write = process.argv.includes("--write");
const problems = [];
for (const rule of config.rules) {
  const found = matchesOf(rule);
  const outside = found.filter((f) => !owns(rule, f));
  if (write) {
    rule.baseline = outside;
    continue;
  }
  const baseline = new Set(rule.baseline);
  for (const f of outside) {
    if (!baseline.has(f))
      problems.push(
        `${rule.name}: a new copy in ${f} — use the owner (${rule.owner.join(", ") || "none yet"}): ${rule.description}`,
      );
  }
  for (const f of rule.baseline) {
    if (!outside.includes(f))
      problems.push(
        `${rule.name}: ${f} is in the baseline but no longer holds a copy — run bun tooling/js/single-owner.mjs --write`,
      );
  }
}

if (write) {
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  for (const rule of config.rules)
    console.log(
      `${rule.name.padEnd(28)} ${rule.baseline.length} copies outside the owner`,
    );
  process.exit(0);
}

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const rule of config.rules)
  console.log(
    `${rule.name.padEnd(28)} ${rule.baseline.length} baseline copies, owner ${rule.owner.join(", ") || "none yet"}`,
  );
