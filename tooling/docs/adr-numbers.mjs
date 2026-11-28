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

// ADR numbers across components (docs/adr/README.md, "Numbers used twice").
//
// Each component numbers its decision records in a range of its own. 25
// numbers were given out twice before the ranges were separated; those
// records keep their numbers (PM-0012, PM-0019) and are told apart by
// directory. This check fails on any OTHER number that two components use,
// or that one component uses for two records.
//
//   node tooling/docs/adr-numbers.mjs          check; exit 1 on a new collision
//   node tooling/docs/adr-numbers.mjs --list   print every collision, known ones too

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The collisions that predate the ranges: number -> the two components. */
const KNOWN = new Map();
for (let n = 200; n <= 209; n++) KNOWN.set(n, "apps/editor | engine/core");
for (const n of [300, 301, ...Array.from({ length: 13 }, (_, i) => 303 + i)])
  KNOWN.set(n, "apps/editor | platform/extensions");

// number -> component -> files. Component records only: the repository's
// own PM-NNNN records in docs/adr are a series of their own.
const byNumber = new Map();
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*/docs/adr/*.md",
  ],
  { cwd: repo, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
for (const file of files) {
  const match = /^(.+)\/docs\/adr\/(\d{3,4})[-_.][^/]*\.md$/.exec(file);
  if (!match) continue;
  const [, component, digits] = match;
  const number = Number(digits);
  const components = byNumber.get(number) ?? new Map();
  components.set(component, [...(components.get(component) ?? []), file]);
  byNumber.set(number, components);
}
if (byNumber.size === 0) {
  console.error(
    "adr-numbers: no component record found: the path pattern is out of date",
  );
  process.exit(1);
}

const list = process.argv.includes("--list");
const problems = [];
let known = 0;
for (const [number, components] of [...byNumber].sort((a, b) => a[0] - b[0])) {
  for (const [component, records] of components) {
    if (records.length > 1)
      problems.push(
        `${number} names ${records.length} records of ${component}: ${records.join(", ")}`,
      );
  }
  if (components.size < 2) continue;
  const owners = [...components.keys()].sort().join(" | ");
  if (KNOWN.get(number) === owners) {
    known++;
    if (list) console.log(`${number}  ${owners}  (known)`);
  } else {
    problems.push(`${number} is used by ${owners}`);
  }
}
for (const [number, owners] of KNOWN) {
  if ((byNumber.get(number)?.size ?? 0) < 2)
    problems.push(
      `${number} (${owners}) no longer collides: remove it from KNOWN and from docs/adr/README.md`,
    );
}

if (problems.length > 0) {
  console.error("adr-numbers: FAILED");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "A new record takes the next free number of its component's range (docs/adr/README.md).",
  );
  process.exit(1);
}
console.log(
  `adr-numbers: ${byNumber.size} numbers, ${known} known collisions (200–209, 300, 301, 303–315), no new one`,
);
