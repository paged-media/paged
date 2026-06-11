#!/usr/bin/env node
// Bump-on-contract-change guard (audit 2026-06-11, 03 P2).
//
// The failure this prevents: four contract commits landed AFTER the
// 0.2.8 bump with NO version change, so publish.yml's "publish only when
// the version isn't on the registry yet" logic no-op'd — the npm canary
// sat two protocols behind contract HEAD while consumers (template lane)
// validated a stale surface.
//
// Rule: if a commit range touches a package's PUBLISHED contract source
// (`packages/<pkg>/src/**`, which for plugin-api includes the vendored
// `wire.d.ts` and `manifest.schema.json`), that package's
// `package.json` version MUST also change in the same range. Otherwise
// the change can never reach npm.
//
// Base of the range:
//   * CONTRACT_BASE env (CI passes the PR base sha or `github.event.before`)
//   * else HEAD~1 (the previous trunk tip — this repo is push-to-main)
// A missing/zero base (first push of a branch) → skip (nothing to diff).
//
// Runs in CI (contract-guard.yml) and locally:
//   node scripts/assert-contract-bumped.mjs            # HEAD~1..HEAD
//   node scripts/assert-contract-bumped.mjs <baseRef>  # <baseRef>..HEAD

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Packages whose published source is the contract. Each guards its own
// `src/**` against its own version.
const PACKAGES = ["packages/plugin-api", "packages/plugin-sdk"];

const ZERO_SHA = "0000000000000000000000000000000000000000";

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function resolveBase() {
  const fromArg = process.argv[2];
  const fromEnv = process.env.CONTRACT_BASE;
  const candidate = (fromArg || fromEnv || "").trim();
  if (candidate && candidate !== ZERO_SHA) return candidate;
  // Default: previous commit. If HEAD has no parent, there is nothing to
  // diff against — signal "skip".
  try {
    return git(["rev-parse", "HEAD~1"]);
  } catch {
    return null;
  }
}

// version of a package.json at a given ref, or null if the file did not
// exist there (a brand-new package counts as "bumped").
function versionAt(ref, pkgDir) {
  try {
    const json = git(["show", `${ref}:${pkgDir}/package.json`]);
    return JSON.parse(json).version ?? null;
  } catch {
    return null;
  }
}

function versionAtHead(pkgDir) {
  // Read the committed HEAD version (not the working tree) so the guard
  // judges what is actually in the range under test.
  return versionAt("HEAD", pkgDir);
}

const base = resolveBase();
if (!base) {
  console.log("contract-guard: no base commit to diff against — skipping.");
  process.exit(0);
}

const violations = [];
for (const pkg of PACKAGES) {
  const changed = git([
    "diff",
    "--name-only",
    `${base}`,
    "HEAD",
    "--",
    `${pkg}/src`,
  ])
    .split("\n")
    .filter(Boolean);
  if (changed.length === 0) continue;

  const before = versionAt(base, pkg);
  const after = versionAtHead(pkg);
  if (before !== null && before === after) {
    violations.push({ pkg, version: after, files: changed });
  }
}

if (violations.length > 0) {
  console.error(
    `\ncontract-guard FAILED — contract source changed without a version bump.\n` +
      `Any change under packages/<pkg>/src/ must bump that package's version\n` +
      `(a -canary.N rev), or publish.yml will no-op and npm will go stale (03 P2).\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.pkg} @ ${v.version} — unchanged across ${base}..HEAD, but:`);
    for (const f of v.files) console.error(`      ${f}`);
  }
  console.error("");
  process.exit(1);
}

console.log(
  `contract-guard OK — every package with src changes in ${base}..HEAD bumped its version.`,
);
