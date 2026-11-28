#!/usr/bin/env node
/**
 * Every test file belongs to a lane.
 *
 * A test file that no CI step runs passes forever: it rots, and its green
 * history is a claim nobody checks. `tooling/ci/test-lanes.json` maps the
 * repository's JavaScript and TypeScript test files to the workflow steps
 * that run them, and this check holds the map to the tree:
 *
 *   - every tracked `*.test.*` / `*.spec.*` file (ts, tsx, mts, js, jsx,
 *     mjs, cjs) matches a lane's `files` (minus its `except`), or an
 *     `unlaned` entry that says why no CI step runs it;
 *   - every lane names a workflow that exists and still contains the lane's
 *     `evidence` (the command text of the step that runs it), so a removed
 *     step un-lanes its files;
 *   - every lane and every `unlaned` entry still matches a file, and no
 *     file is both laned and listed as unlaned.
 *
 *   node tooling/ci/test-lanes.mjs            the check
 *   node tooling/ci/test-lanes.mjs --list     each lane with its file count
 *
 * Patterns are globs over repository-relative paths: `**` crosses
 * directories, `*` does not, `{a,b}` alternates. Rust tests are held by
 * nextest (`--no-tests=fail`, tooling/rust/skip-report.py); this is the
 * JavaScript half.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

export const TEST_FILE = /[._](test|spec)\.(ts|tsx|mts|js|jsx|mjs|cjs)$/;

/** A glob as a RegExp over a whole repository-relative path. */
export function glob(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches no directory at all.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const matcher = (patterns = []) => {
  const res = patterns.map(glob);
  return (file) => res.some((re) => re.test(file));
};

/**
 * `{ problems: string[], lanes: [{ name, count }] }` for a manifest, the
 * tracked files and a reader of workflow text (`null` when it is missing).
 */
export function check(manifest, files, readWorkflow) {
  const problems = [];
  const tests = files.filter((f) => TEST_FILE.test(f));
  const laned = new Map(tests.map((f) => [f, []]));
  const lanes = [];
  const squash = (text) => text.replace(/\s+/g, " ");

  for (const lane of manifest.lanes) {
    const text = readWorkflow(lane.workflow);
    if (text === null)
      problems.push(`lane "${lane.name}": no workflow ${lane.workflow}`);
    else if (!squash(text).includes(squash(lane.evidence)))
      problems.push(
        `lane "${lane.name}": ${lane.workflow} no longer contains \`${lane.evidence}\` — the step that ran these files is gone or changed`,
      );
    const include = matcher(lane.files);
    const exclude = matcher(lane.except);
    let count = 0;
    for (const file of tests)
      if (include(file) && !exclude(file)) {
        laned.get(file).push(lane.name);
        count++;
      }
    if (count === 0)
      problems.push(`lane "${lane.name}": matches no test file — remove it`);
    lanes.push({ name: lane.name, count });
  }

  const unlanedUsed = new Set();
  for (const file of tests) {
    const entry = manifest.unlaned.find((e) => glob(e.file).test(file));
    if (entry) unlanedUsed.add(entry);
    const inLanes = laned.get(file);
    if (entry && inLanes.length)
      problems.push(
        `${file}: listed as unlaned, but lane "${inLanes[0]}" runs it — remove the unlaned entry`,
      );
    if (!entry && !inLanes.length)
      problems.push(
        `${file}: no CI lane runs this test file — add it to a lane in tooling/ci/test-lanes.json (and to the workflow), or to "unlaned" with the reason`,
      );
  }
  for (const entry of manifest.unlaned) {
    if (!entry.reason) problems.push(`unlaned ${entry.file}: no reason given`);
    if (!unlanedUsed.has(entry))
      problems.push(`unlaned ${entry.file}: matches no test file — remove it`);
  }
  return { problems, lanes, tests: tests.length };
}

function main() {
  const manifest = JSON.parse(
    readFileSync(join(HERE, "test-lanes.json"), "utf8"),
  );
  // Tracked files, and new ones not yet added (so the check answers for a
  // working tree as it will for the commit).
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  )
    .split("\0")
    // A file deleted in the working tree is not a test any more.
    .filter((f) => f && existsSync(join(ROOT, f)));
  const result = check(manifest, files, (workflow) => {
    const path = join(ROOT, ".github", "workflows", workflow);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  });
  if (process.argv.includes("--list"))
    for (const lane of result.lanes)
      console.log(`${String(lane.count).padStart(5)}  ${lane.name}`);
  for (const problem of result.problems)
    console.error(
      `${process.env.GITHUB_ACTIONS ? "::error::" : ""}test-lanes: ${problem}`,
    );
  if (result.problems.length) {
    console.error(`test-lanes: ${result.problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(
    `test-lanes: ${result.tests} test files, each in one of ${manifest.lanes.length} lanes or among the ${manifest.unlaned.length} unlaned entries`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
