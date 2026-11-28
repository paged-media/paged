#!/usr/bin/env node
/**
 * No private path in the public repository.
 *
 * A path into somebody's home directory, onto a named local volume, into a
 * tool's per-user state, or into a private repository means nothing to a
 * reader of this repository and tells them about a machine that is not
 * theirs. This check reads every tracked text file and fails on:
 *
 *   home        /Users/<name>/, /home/<name>/ with a real-looking name
 *               (placeholders such as alice, me, runner pass; so does
 *               `/Users/<user>`)
 *   volume      /Volumes/<name> other than the documented RAM disk
 *   tool-state  per-user assistant and scratch state directories
 *   checkout    home-relative paths of one machine's checkout layout
 *   private-repo  citations of the private planning repository
 *
 *   node tooling/ci/private-paths.mjs            every tracked file
 *   node tooling/ci/private-paths.mjs --staged   the staged files (pre-commit)
 *
 * `tooling/ci/private-paths-allow.json` is the allowlist: one entry per file
 * and rule, with the reason. An entry that no longer matches anything fails
 * the full run, so the list only shrinks.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** Names that stand for "some user" in tests, examples and CI. */
const PLACEHOLDER_USERS = new Set([
  "alice",
  "bob",
  "me",
  "x",
  "a",
  "u",
  "you",
  "user",
  "username",
  "name",
  "someone",
  "runner",
  "web_user",
  "shared",
]);
/** Volumes the documentation names (tooling/dev/ramdisk.sh). */
const KNOWN_VOLUMES = new Set(["PagedTarget"]);

export const RULES = [
  {
    id: "home",
    pattern: /(?:\/Users|\/home|[A-Za-z]:\\+Users)[/\\]+([A-Za-z0-9._-]+)/g,
    hit: (m) => !PLACEHOLDER_USERS.has(m[1].toLowerCase()),
  },
  {
    id: "volume",
    pattern: /\/Volumes\/([A-Za-z0-9._-]+)/g,
    hit: (m) => !KNOWN_VOLUMES.has(m[1]),
  },
  {
    id: "tool-state",
    pattern:
      /\.claude\/(?:plans|projects|todos)\b|\/private\/tmp\/claude-|\/tmp\/claude-\d|-Users-[A-Za-z0-9]+-/g,
    hit: () => true,
  },
  {
    id: "checkout",
    pattern: /(?:~|\$HOME|\$\{HOME\})\/(?:paged|idml)\b/g,
    hit: () => true,
  },
  {
    id: "private-repo",
    pattern: /(?<![\w./-])thoughts\/(?=[\w.-])/g,
    hit: () => true,
  },
];

/** `[{ rule, line, text }]` for one file's text. */
export function scan(text) {
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const m of line.matchAll(rule.pattern)) {
        if (!rule.hit(m)) continue;
        findings.push({ rule: rule.id, line: i + 1, text: m[0] });
        break;
      }
    }
  }
  return findings;
}

function tracked(staged) {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

function main() {
  const staged = process.argv.includes("--staged");
  const allow = JSON.parse(
    readFileSync(join(HERE, "private-paths-allow.json"), "utf8"),
  ).allow;
  const allowed = new Map(allow.map((e) => [`${e.file}\0${e.rule}`, e]));
  const used = new Set();
  const failures = [];
  let files = 0;
  for (const file of tracked(staged)) {
    let buffer;
    try {
      buffer = readFileSync(join(ROOT, file));
    } catch {
      continue; // deleted in the working tree, or a submodule/symlink target
    }
    // Binary files (a NUL in the first 8 KiB) and very large generated
    // files are not prose anyone wrote a path into.
    if (buffer.subarray(0, 8192).includes(0)) continue;
    files++;
    for (const finding of scan(buffer.toString("utf8"))) {
      const key = `${file}\0${finding.rule}`;
      if (allowed.has(key)) used.add(key);
      else failures.push({ file, ...finding });
    }
  }
  for (const f of failures)
    console.error(
      `${process.env.GITHUB_ACTIONS ? `::error file=${f.file},line=${f.line}::` : ""}${f.file}:${f.line}: private path (${f.rule}): ${f.text}`,
    );
  let stale = [];
  if (!staged) stale = allow.filter((e) => !used.has(`${e.file}\0${e.rule}`));
  for (const e of stale)
    console.error(
      `private-paths-allow.json: ${e.file} (${e.rule}) matches nothing any more — remove the entry`,
    );
  if (failures.length || stale.length) {
    console.error(
      `private-paths: ${failures.length} finding(s), ${stale.length} stale allowlist entr(ies). Rewrite the path (\`<repo root>/…\`, \`/Users/<user>/…\`), or name the file in tooling/ci/private-paths-allow.json with a reason.`,
    );
    process.exit(1);
  }
  console.log(
    `private-paths: ${files} text file(s) clean (${allow.length} allowlisted)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
