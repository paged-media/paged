#!/usr/bin/env node
// Bump-on-contract-change guard (audit 2026-06-11, 03 P2).
//
// The failure this prevents: four contract commits landed AFTER the
// 0.2.8 bump with NO version change, so publish.yml's "publish only when
// the version isn't on the registry yet" logic no-op'd — the npm canary
// sat two protocols behind contract HEAD while consumers (template lane)
// validated a stale surface.
//
// Rule (PM-0008, amendment 3: the contract has ONE public version,
// plugin-sdk's): if a commit range touches the contract's source — under
// `packages/plugin-api/src/**` (which includes the vendored `wire.d.ts` and
// `manifest.schema.json`; plugin-sdk publishes it as its `./api` entry) or
// `packages/plugin-sdk/src/**` — then plugin-sdk's `package.json` version
// MUST change in the same range. And plugin-api's private version moves in
// LOCKSTEP: at HEAD it equals plugin-sdk's, so the two counters never tell
// different stories.
//
// Reformat commits are exempt: a commit tooling/js/mass-format.sh made
// (subject `fmt: <component> (bun fmt, no other change)`) or one that
// .git-blame-ignore-revs lists changes no behaviour, so a range whose only
// src/ changes come from such commits needs no release. Without this, the
// mass format to `bun fmt` (docs/migration/bun-fmt.md) would have to publish
// canaries that differ from the last ones by whitespace alone.
//
// Base of the range:
//   * CONTRACT_BASE env (CI passes the PR base sha or `github.event.before`)
//   * else HEAD~1 (the previous trunk tip — this repo is push-to-main)
// A missing/zero base (first push of a branch) → HEAD~1. A base git cannot
// read FAILS the guard (see "FAIL CLOSED" below); only a one-commit history
// has nothing to diff.
//
// Runs in CI (extensions-contract-guard.yml) and locally:
//   node scripts/assert-contract-bumped.mjs            # HEAD~1..HEAD
//   node scripts/assert-contract-bumped.mjs <baseRef>  # <baseRef>..HEAD

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The contract's source directories, and the one package whose version is
// the contract's public number. plugin-api is private and published inside
// plugin-sdk (`./api`); its own version is held equal to plugin-sdk's.
const SOURCES = ["packages/plugin-api/src", "packages/plugin-sdk/src"];
const PUBLIC = "packages/plugin-sdk";
const LOCKSTEP = "packages/plugin-api";

const ZERO_SHA = "0000000000000000000000000000000000000000";

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

// FAIL CLOSED. Until 2026-11-28 a base that git could not read made this
// guard pass: an unresolvable HEAD~1 was "nothing to diff", and a failed
// `git show <base>:…/package.json` was "a brand-new package, counts as
// bumped". A shallow clone, or a base that is not in the clone (a
// force-push's `before`), therefore let any contract change through. Now
// only two things skip or exempt, and both are checked rather than assumed:
// a repository whose history really is one commit, and a package.json that
// really does not exist at a base git CAN read. Everything else is an error.
function fail(message) {
  console.error(`\ncontract-guard FAILED — ${message}\n`);
  process.exit(1);
}

function quiet(args) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveBase() {
  const fromArg = process.argv[2];
  const fromEnv = process.env.CONTRACT_BASE;
  const candidate = (fromArg || fromEnv || "").trim();
  if (candidate && candidate !== ZERO_SHA) return candidate;
  // Default: previous commit.
  if (quiet(["rev-parse", "--verify", "--quiet", "HEAD~1^{commit}"]))
    return git(["rev-parse", "HEAD~1"]);
  // No parent. That is "nothing to diff" only when HEAD is the history's
  // one commit; in a shallow clone the parent exists and was not fetched.
  const shallow = git(["rev-parse", "--is-shallow-repository"]) === "true";
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ");
  if (!shallow && parents.length === 1) return null;
  fail(
    "HEAD's parent is not in this clone (a shallow checkout), so the range cannot be read. " +
      "Fetch the history (actions/checkout fetch-depth: 0) or pass the base: CONTRACT_BASE=<sha>.",
  );
}

// version of a package.json at a given ref, or null if the file did not
// exist there (a brand-new package counts as "bumped"). The ref itself must
// be readable (checked once, below); an unreadable or unparsable file that
// DOES exist is an error, never "new".
function versionAt(ref, pkgDir) {
  // `./` makes the path relative to git's cwd (this package's root). A bare
  // `<ref>:<path>` resolves from the REPOSITORY root, which in the monorepo
  // is two levels up: the show failed, this returned null, and every
  // package counted as "bumped" — the guard could never fire.
  const spec = `${ref}:./${pkgDir}/package.json`;
  if (!quiet(["cat-file", "-e", spec])) return null;
  let version;
  try {
    version = JSON.parse(git(["show", spec])).version;
  } catch (error) {
    fail(`cannot read ${spec}: ${error.message}`);
  }
  if (typeof version !== "string" || !version) fail(`${spec} has no version`);
  return version;
}

function versionAtHead(pkgDir) {
  // Read the committed HEAD version (not the working tree) so the guard
  // judges what is actually in the range under test.
  return versionAt("HEAD", pkgDir);
}

const base = resolveBase();
if (!base) {
  console.log(
    "contract-guard: HEAD is the history's only commit — nothing to diff against.",
  );
  process.exit(0);
}
// The base must be a commit this clone has: otherwise every question below
// ("what changed", "what was the version") has no answer, and no answer is
// not a pass.
if (!quiet(["cat-file", "-e", `${base}^{commit}`]))
  fail(
    `the base ${base} is not a commit in this clone (a force-push, or a shallow checkout), so the range cannot be read. ` +
      "Fetch the history (fetch-depth: 0), or pass a base that exists: CONTRACT_BASE=<sha>.",
  );

// The reformat commits (see the rule above), by full hash.
const FORMAT_SUBJECT = /^fmt: \S+ \(bun fmt, no other change\)$/;
function isReformat(sha) {
  if (FORMAT_SUBJECT.test(git(["log", "-1", "--format=%s", sha]))) return true;
  return blameIgnored.has(sha);
}
const blameIgnored = new Set(
  (() => {
    try {
      // A bare `<rev>:<path>` resolves from the repository root, where the
      // file lives.
      return execFileSync("git", ["show", "HEAD:.git-blame-ignore-revs"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).split("\n");
    } catch {
      return [];
    }
  })()
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{40}$/.test(l)),
);

const violations = [];
const changed = [];
const counted = [];
for (const src of SOURCES) {
  const files = git(["diff", "--name-only", `${base}`, "HEAD", "--", src])
    .split("\n")
    .filter(Boolean);
  if (files.length === 0) continue;
  const touching = git(["rev-list", `${base}..HEAD`, "--", src])
    .split("\n")
    .filter(Boolean);
  if (touching.length > 0 && touching.every(isReformat)) {
    console.log(
      `contract-guard: ${src} changed in reformat commits only (${touching.length}) — no bump needed.`,
    );
    continue;
  }
  changed.push(...files);
  counted.push(src);
}

if (changed.length > 0) {
  const before = versionAt(base, PUBLIC);
  const after = versionAtHead(PUBLIC);
  if (before !== null && before === after) {
    violations.push(
      `${PUBLIC} @ ${after} — unchanged across ${base}..HEAD, but ${counted.join(" and ")} changed:\n` +
        changed.map((f) => `      ${f}`).join("\n"),
    );
  }
}

const sdk = versionAtHead(PUBLIC);
const api = versionAtHead(LOCKSTEP);
// Both packages exist at HEAD; a guard that cannot find them guards nothing.
if (sdk === null || api === null)
  fail(
    `${sdk === null ? PUBLIC : LOCKSTEP}/package.json is not at HEAD: the guard's package paths are out of date`,
  );
if (sdk !== api) {
  violations.push(
    `${LOCKSTEP} @ ${api} is not in lockstep with ${PUBLIC} @ ${sdk}: set both to the same version`,
  );
}

if (violations.length > 0) {
  console.error(
    `\ncontract-guard FAILED — the contract changed without its version.\n` +
      `A change under packages/plugin-api/src or packages/plugin-sdk/src moves\n` +
      `plugin-sdk's version (the contract's one public number, PM-0008\n` +
      `amendment 3), and plugin-api's private version moves with it.\n`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error("");
  process.exit(1);
}

console.log(
  `contract-guard OK — ${changed.length ? `the contract changed in ${base}..HEAD and plugin-sdk moved to ${sdk}` : `no contract change in ${base}..HEAD`}; plugin-api is in lockstep (${api}).`,
);
