#!/usr/bin/env node
// Post-publish dist-tag assertion (audit P35).
//
// The policy, pre-1.0:
//   * Every published version is a `-canary.N` prerelease.
//   * `canary` is the floating lane and MUST point at the version
//     currently in this repo's package.json (the one we just published,
//     or the one already live).
//   * `latest` MUST EQUAL `canary` (lockstep). npm REFUSES to delete a
//     package's `latest` tag (E400), so absence is impossible; the
//     enforceable invariant is lockstep. A stale `latest` is the drift that
//     stuck consumers at 0.2.1 before this lane published with
//     `--tag canary`. If `latest` reappears, fail loud.
//
// Runs in CI after publish; also runnable locally (`node
// scripts/assert-dist-tags.mjs`) to audit the live registry state.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  "packages/plugin-api",
  "packages/plugin-sdk",
  "packages/plugin-cli",
];

/** @param {string} name */
function distTags(name) {
  // `npm view <name> dist-tags --json` — empty/absent package yields ''.
  const out = execFileSync(
    "npm",
    ["view", name, "dist-tags", "--json"],
    { encoding: "utf8" },
  ).trim();
  return out ? JSON.parse(out) : {};
}

const failures = [];

for (const dir of PACKAGES) {
  const pkg = JSON.parse(
    readFileSync(join(root, dir, "package.json"), "utf8"),
  );
  const { name, version } = pkg;
  const tags = distTags(name);
  console.log(`${name}: dist-tags=${JSON.stringify(tags)} (repo ${version})`);

  // 1. canary must point at the repo version.
  if (tags.canary !== version) {
    failures.push(
      `${name}: canary is ${tags.canary ?? "(absent)"}, expected ${version}`,
    );
  }

  // 2. latest must equal canary pre-1.0 (npm forbids deleting latest —
  //    E400 — so absence is impossible; lockstep is the invariant).
  if (tags.latest !== tags.canary) {
    failures.push(
      `${name}: latest=${tags.latest} != canary=${tags.canary} — pre-1.0 ` +
        `they must be lockstep (npm forbids deleting latest). ` +
        `Fix: npm dist-tag add ${name}@${tags.canary} latest`,
    );
  }
}

if (failures.length > 0) {
  console.error("\ndist-tag policy violations:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("\ndist-tags OK: canary current, latest in lockstep.");
