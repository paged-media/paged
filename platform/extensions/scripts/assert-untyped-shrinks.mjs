#!/usr/bin/env node
// ADR 323 — the untyped-command baseline only SHRINKS.
//
// `packages/plugin-cli/untyped-commands.baseline.json` lists, per plugin,
// the commands that still take an untyped payload (no typed twin in
// `contributes.objectModel.commands`). plugin-cli `validate` fails a plugin
// that adds a new untyped command; this guard fails a commit range that
// GROWS the baseline instead (adds a plugin, or an id to a plugin's list),
// which would make that check meaningless.
//
//   node scripts/assert-untyped-shrinks.mjs            # HEAD~1..HEAD
//   node scripts/assert-untyped-shrinks.mjs <baseRef>  # <baseRef>..HEAD
//   CONTRACT_BASE=<sha> node scripts/assert-untyped-shrinks.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "packages/plugin-cli/untyped-commands.baseline.json";
const ZERO = "0000000000000000000000000000000000000000";

const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let base = (process.argv[2] || process.env.CONTRACT_BASE || "").trim();
if (!base || base === ZERO) {
  try {
    base = git(["rev-parse", "HEAD~1"]);
  } catch {
    console.log("untyped baseline: no base to diff against — skip");
    process.exit(0);
  }
}

let before;
try {
  before = JSON.parse(git(["show", `${base}:${FILE}`]));
} catch {
  console.log(`untyped baseline: absent at ${base} — first introduction, nothing to compare`);
  process.exit(0);
}
const after = JSON.parse(readFileSync(join(root, FILE), "utf8"));

const grown = [];
for (const [plugin, ids] of Object.entries(after.plugins ?? {})) {
  const prev = new Set(before.plugins?.[plugin] ?? []);
  for (const id of ids) if (!prev.has(id)) grown.push(`${plugin}: ${id}`);
}
if (grown.length > 0) {
  console.error(`✗ ${FILE} grew (it may only shrink — type the command instead, ADR 323):`);
  for (const g of grown) console.error(`  + ${g}`);
  process.exit(1);
}
const count = (b) => Object.values(b.plugins ?? {}).reduce((n, l) => n + l.length, 0);
console.log(`✓ untyped baseline ${count(before)} → ${count(after)} (shrink-only holds)`);
