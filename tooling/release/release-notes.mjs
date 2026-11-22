#!/usr/bin/env node
// The notes of a release, as Markdown on stdout (.github/workflows/release-notes.yml):
//
//   node tooling/release/release-notes.mjs <tag> [--repo <dir>] [--deprecations <file>]
//
//   - the commits since the previous `v*` tag that <tag> descends from
//     (merges left out), each under the component it changes most, by the
//     first path segments: engine, modules/<m>, apps/<a>, packages/<p>,
//     platform, docs, tests, and tooling for the rest (CI, root files); the
//     other components a commit touches follow it in brackets;
//   - the deprecated feature ids, the Markdown that
//     `bun apps/editor/scripts/feature-ids.mjs --release-notes` printed at
//     the tag (--deprecations names the file it was written to; without it
//     the section says they were not read);
//   - the known limits: the capability record, which says what is stable,
//     experimental and planned, feature by feature.
//
// --repo is the checkout whose history holds <tag> (default: the current
// directory). Only node: builtins and git, so it runs before an install.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RECORD = "https://docs.paged.media/state/";

/** Components in the order the notes list them; `modules/<m>`, `apps/<a>`
 *  and `packages/<p>` sort by name inside their kind. */
const ORDER = [
  "engine",
  "modules",
  "apps",
  "packages",
  "platform",
  "docs",
  "tests",
  "tooling",
];

/** The component a changed path belongs to. */
export function componentOf(path) {
  const parts = path.split("/");
  const first = parts[0];
  if (first === "modules" || first === "apps" || first === "packages")
    return parts.length >= 3 ? `${first}/${parts[1]}` : first;
  if (
    ["engine", "platform", "docs", "tests"].includes(first) &&
    parts.length > 1
  )
    return first;
  return "tooling";
}

function rank(component) {
  const kind = component.split("/")[0];
  const i = ORDER.indexOf(kind);
  return i < 0 ? ORDER.length : i;
}

export function compareComponents(a, b) {
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Commits, each with its changed paths, grouped under the component it
 * changes most (a tie goes to the component listed first). A commit that
 * changes no file (an empty commit) is under tooling.
 */
export function groupCommits(commits) {
  const groups = new Map();
  for (const c of commits) {
    const counts = new Map();
    for (const p of c.paths) {
      const k = componentOf(p);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const touched = [...counts.keys()].sort(compareComponents);
    const primary =
      touched.length === 0
        ? "tooling"
        : touched.reduce((best, k) =>
            counts.get(k) > counts.get(best) ? k : best,
          );
    const also = touched.filter((k) => k !== primary);
    if (!groups.has(primary)) groups.set(primary, []);
    groups.get(primary).push({ ...c, also });
  }
  return new Map([...groups].sort(([a], [b]) => compareComponents(a, b)));
}

/** `git log --name-only` with a record separator, parsed. */
export function parseLog(text) {
  return text
    .split("\x1e")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [head, ...paths] = block.split("\n");
      const [sha, date, subject] = head.split("\x1f");
      return { sha, date, subject, paths: paths.filter(Boolean) };
    });
}

/** What GitHub takes as a release body: 125,000 characters; some room left. */
export const MAX_BODY = 120_000;

/** The notes for `tag`, from the commits since `previous`, each component's
 *  list cut short (newest first) until the notes fit a release body. */
export function renderNotes(input) {
  let notes = renderNotesAt(input, Infinity);
  for (
    let cap = 200;
    notes.length > MAX_BODY && cap >= 5;
    cap = Math.floor(cap / 2)
  )
    notes = renderNotesAt(input, cap);
  return notes;
}

function renderNotesAt({ tag, previous, commits, deprecations }, cap) {
  const out = [];
  const range = previous ? `since ${previous}` : "in the history";
  out.push(`## ${tag}`, "");
  out.push(
    `${commits.length} ${commits.length === 1 ? "commit" : "commits"} ${range}, merges left out, each under the component it changes most.`,
    "",
  );
  for (const [component, list] of groupCommits(commits)) {
    out.push(`### ${component} (${list.length})`, "");
    for (const c of list.slice(0, cap)) {
      const also = c.also.length ? ` (also ${c.also.join(", ")})` : "";
      out.push(`- ${c.subject} — ${c.sha.slice(0, 9)}${also}`);
    }
    if (list.length > cap)
      out.push(
        `- … and ${list.length - cap} more: \`git log --no-merges ${previous ? `${previous}..` : ""}${tag}\``,
      );
    out.push("");
  }
  out.push("### Deprecated feature ids", "");
  out.push(
    deprecations?.trim() ||
      "Not read: run `bun apps/editor/scripts/feature-ids.mjs --release-notes` at the tag.",
    "",
  );
  out.push("### Known limits", "");
  out.push(
    `What is stable, what is experimental and what is planned, feature by feature and with its tests, is the capability record: ${RECORD}`,
  );
  return `${out.join("\n")}\n`;
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The nearest `v*` tag `tag`'s parent descends from; null for none. */
function previousTag(repo, tag) {
  try {
    return git(repo, [
      "describe",
      "--tags",
      "--abbrev=0",
      "--match",
      "v[0-9]*",
      `${tag}^`,
    ]).trim();
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const repo = opt("--repo") ?? ".";
  const deprecationsFile = opt("--deprecations");
  const [tag] = args;
  if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    console.error(
      "usage: node tooling/release/release-notes.mjs <vMAJOR.MINOR.PATCH[-pre]> [--repo <dir>] [--deprecations <file>]",
    );
    process.exit(2);
  }
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  } catch {
    console.error(`release-notes: ${repo} has no tag ${tag}`);
    process.exit(1);
  }
  const previous = previousTag(repo, tag);
  const log = git(repo, [
    "log",
    "--no-merges",
    "--name-only",
    "--format=%x1e%H%x1f%cs%x1f%s",
    previous ? `${previous}..${tag}` : tag,
  ]);
  const deprecations = deprecationsFile
    ? readFileSync(deprecationsFile, "utf8")
    : undefined;
  process.stdout.write(
    renderNotes({ tag, previous, commits: parseLog(log), deprecations }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
