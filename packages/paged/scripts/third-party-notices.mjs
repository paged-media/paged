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

// THIRD-PARTY-NOTICES.md for the engine wasm this package ships.
//
// The three wasm modules (canvas, introspect, repo) are Rust, linked from
// several hundred crates of other authors. Their licences (MIT, Apache-2.0,
// BSD, ISC, Zlib, MPL-2.0, …; engine/core/deny.toml is the allowlist, checked
// by the `core / licenses` workflow) ask that the copyright notice and the
// licence text travel with a binary. This script writes that file:
//
//   1. `cargo metadata` over engine/core's workspace, resolved for
//      wasm32-unknown-unknown with the features the wasm is built with
//      (engine/core/scripts/build-wasm-packages.sh);
//   2. the crates the three wasm crates reach through normal dependencies.
//      Build scripts, dev-dependencies and proc-macro crates are left out:
//      they run at build time and are not in the binary. First-party crates
//      (no registry or git source) are the package's own licence;
//   3. for each crate its name, version, licence expression and repository,
//      and the licence and notice files in its source directory, each
//      distinct text printed once with the crates it belongs to.
//
// What it cannot promise: features are resolved for the whole workspace, so
// the list may name a crate that no shipped module links (never fewer); and
// a crate that ships no licence file is listed under "No licence file" with
// its declared expression only. The JavaScript in the `paged` bin has its own
// file, dist/THIRD-PARTY-NOTICES.md (apps/cli/scripts/bundle.mjs).
//
//   bun scripts/third-party-notices.mjs [out file]    default: ../THIRD-PARTY-NOTICES.md
//   bun scripts/third-party-notices.mjs --list        the crate table only, to stdout
//
// It needs cargo and the crates' sources (cargo fetches what is missing).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(pkg, "..", "..", "engine", "core");

/** The crates whose wasm this package ships, with their build features. */
const SHIPPED = [
  { crate: "paged-canvas-wasm", features: ["gpu"] },
  { crate: "paged-introspect-wasm", features: [] },
  { crate: "paged-repo-wasm", features: [] },
];
const TARGET = "wasm32-unknown-unknown";
const LICENCE_FILE = /^(licen[sc]e|copying|copyright|notice|unlicense)/i;
// A licence file larger than this is not a licence text.
const MAX_LICENCE_BYTES = 200_000;

function fail(message) {
  console.error(`third-party-notices: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const out = resolve(
  args.find((a) => !a.startsWith("--")) ?? join(pkg, "THIRD-PARTY-NOTICES.md"),
);

let metadata;
try {
  metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        TARGET,
        "--features",
        SHIPPED.flatMap((s) => s.features.map((f) => `${s.crate}/${f}`)).join(
          ",",
        ),
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
} catch (error) {
  fail(`cargo metadata failed in ${workspace}: ${error.message}`);
}

const packages = new Map(metadata.packages.map((p) => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const isProcMacro = (p) =>
  p.targets.length > 0 && p.targets.every((t) => t.kind.includes("proc-macro"));

const roots = SHIPPED.map(({ crate }) => {
  const found = metadata.packages.find(
    (p) => p.name === crate && p.source === null,
  );
  if (!found) fail(`${crate} is not a crate of ${workspace}`);
  return found.id;
});

// The closure over normal dependencies that apply to the wasm target.
const linked = new Set();
const queue = [...roots];
while (queue.length > 0) {
  const id = queue.pop();
  if (linked.has(id)) continue;
  linked.add(id);
  const node = nodes.get(id);
  if (!node) fail(`${id} has no node in cargo's resolve`);
  for (const dep of node.deps) {
    // `kind: null` is a normal dependency; "build" and "dev" are not linked.
    if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
    const target = packages.get(dep.pkg);
    if (!target) fail(`${dep.pkg} is not in cargo's package list`);
    if (isProcMacro(target)) continue;
    queue.push(dep.pkg);
  }
}

const crates = [...linked]
  .map((id) => packages.get(id))
  .filter((p) => p.source !== null)
  .sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
if (crates.length === 0) fail("no third-party crate found: the walk is wrong");

const label = (p) => `${p.name} ${p.version}`;
const table = [
  "| Crate | Version | Licence | Source |",
  "| --- | --- | --- | --- |",
  ...crates.map(
    (p) =>
      `| ${p.name} | ${p.version} | ${p.license ?? (p.license_file ? `see ${p.license_file}` : "not declared")} | ${p.repository ?? p.homepage ?? (p.source.startsWith("registry+") ? `https://crates.io/crates/${p.name}` : p.source)} |`,
  ),
];

if (listOnly) {
  console.log(table.join("\n"));
  process.exit(0);
}

// The licence and notice files of each crate, each distinct text once.
const texts = new Map(); // hash -> { text, name, users: string[] }
const without = [];
for (const p of crates) {
  const dir = dirname(p.manifest_path);
  let names;
  try {
    names = readdirSync(dir)
      .filter((n) => LICENCE_FILE.test(n))
      .sort();
  } catch (error) {
    fail(
      `the source of ${label(p)} is not readable (${dir}): ${error.message}`,
    );
  }
  let found = 0;
  for (const name of names) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_LICENCE_BYTES) continue;
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
    if (text.length === 0) continue;
    const hash = createHash("sha256").update(text).digest("hex");
    const entry = texts.get(hash) ?? { text, name, users: [] };
    entry.users.push(label(p));
    texts.set(hash, entry);
    found++;
  }
  if (found === 0) without.push(p);
}

const lines = [
  "# Third-party notices: the engine wasm",
  "",
  "`@paged-media/paged` ships the paged engine as three WebAssembly modules",
  "(`paged_canvas_wasm_bg.wasm`, `introspect/paged_introspect_wasm_bg.wasm`,",
  "`repo/paged_repo_wasm_bg.wasm`). They are built from the Rust crates below,",
  "which belong to their authors and are used under the licences named. The",
  "package itself is AGPL-3.0-only OR LicenseRef-PMEL (`LICENSE.md`).",
  "",
  "Generated by `scripts/third-party-notices.mjs` from the engine's",
  "`Cargo.lock`: do not edit. The list is resolved for the whole workspace, so",
  "it may name a crate that no shipped module links. The JavaScript in the",
  "`paged` command has its own file, `dist/THIRD-PARTY-NOTICES.md`; the bundled",
  "face is Inter, under the SIL Open Font License 1.1 (`fonts/OFL-inter.txt`).",
  "",
  `## Crates (${crates.length})`,
  "",
  ...table,
  "",
];
if (without.length > 0) {
  lines.push(
    "## No licence file",
    "",
    "These crates publish no licence or notice file; the licence expression",
    "they declare is in the table above.",
    "",
    ...without.map((p) => `- ${label(p)} (${p.license ?? "not declared"})`),
    "",
  );
}
lines.push("## Licence texts", "");
const ordered = [...texts.values()].sort(
  (a, b) => b.users.length - a.users.length || a.text.localeCompare(b.text),
);
for (const entry of ordered) {
  // A fence longer than any run of backticks in the text.
  const longest = Math.max(
    2,
    ...(entry.text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longest + 1);
  lines.push(
    `### ${entry.name}: ${entry.users.length === 1 ? entry.users[0] : `${entry.users.length} crates`}`,
    "",
    ...(entry.users.length > 1 ? [entry.users.join(", "), ""] : []),
    `${fence}text`,
    entry.text,
    fence,
    "",
  );
}
writeFileSync(out, lines.join("\n"));
console.log(
  `third-party-notices: ${crates.length} crates, ${texts.size} licence texts, ${without.length} without a licence file -> ${out} (${(statSync(out).size / 1024).toFixed(0)} KiB)`,
);
