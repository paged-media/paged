#!/usr/bin/env node
// Post-publish dist-tag assertion (audit P35/P13).
//
// The policy, pre-1.0 (canary-only — NO `latest`):
//   * Every published version is a `-canary.N` prerelease.
//   * `canary` is the floating lane and MUST point at the version
//     currently in this repo's package.json (the one we just published,
//     or the one already live).
//   * `latest` MUST NOT track a prerelease. Pre-1.0 it is INTENTIONALLY
//     ABSENT — a bare `npm install <pkg>` resolves `latest`, and it must
//     never hand a consumer a `-canary.N` build. The publish lane never
//     creates or advances `latest`; consumers float on `canary`.
//     A `latest` pointing at a prerelease is the exact drift that stuck
//     consumers at 0.2.1 before this lane published with `--tag canary`.
//     If `latest` ever points at a prerelease, fail loud.
//
// Remediation note: npm's registry REFUSES to delete a package's `latest`
// tag (E400), so a historical prerelease-`latest` cannot simply be
// removed in CI — it is re-pointed to the first real (non-prerelease)
// release at the v1 freeze. Until then this assertion stays red for any
// package whose `latest` is a leftover prerelease, by design: it is a
// loud, true signal of the drift, not something to paper over.
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

/**
 * A semver is a prerelease iff it carries a `-` qualifier (e.g.
 * `0.2.9-canary.0`). Pre-1.0 every published version is one of these.
 * @param {string | undefined} v
 */
function isPrerelease(v) {
  return typeof v === "string" && v.includes("-");
}

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

  // 2. latest must NOT track a prerelease pre-1.0 (canary-only policy).
  //    Absent is the intended state; a non-prerelease `latest` (a real
  //    v1+ release) is also fine. A `-canary.N` `latest` is the drift.
  if (isPrerelease(tags.latest)) {
    failures.push(
      `${name}: latest=${tags.latest} is a prerelease — pre-1.0 ` +
        `\`latest\` must not track a canary (a bare \`npm install\` would ` +
        `resolve it). The publish lane must not advance \`latest\`; ` +
        `consumers float on \`canary\`. (npm forbids deleting \`latest\` — ` +
        `E400 — so a leftover prerelease-latest is re-pointed to the first ` +
        `real release at the v1 freeze.)`,
    );
  }
}

if (failures.length > 0) {
  console.error("\ndist-tag policy violations:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("\ndist-tags OK: canary current, latest is not a prerelease.");
