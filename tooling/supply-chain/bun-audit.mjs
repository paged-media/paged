#!/usr/bin/env bun
// `bun audit` for the root workspace, with an allowlist that expires.
//
//   bun tooling/supply-chain/bun-audit.mjs [--today YYYY-MM-DD]
//
// Runs `bun audit --json` at the repository root (it reads /bun.lock; no
// install needed) and compares every advisory it reports with
// tooling/supply-chain/bun-audit-allowlist.json:
//
//   new       an advisory the list does not name        → fails
//   expired   a listed advisory past its `expires` date → fails
//   stale     a listed advisory bun no longer reports   → fails (delete the
//             entry, so the list only ever names what is still there)
//   allowed   a listed advisory inside its window       → reported, passes
//
// Each entry needs `id` (GHSA-…), `package`, `owner`, `expires`, `reason`.
// Exit 0 clean, 1 policy failure, 2 when bun audit itself could not answer
// (a registry outage must not read as "no advisories").
// docs/migration/renovate.md describes the policy.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIST = join(ROOT, "tooling", "supply-chain", "bun-audit-allowlist.json");
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The advisories in a `bun audit --json` answer: [{ id, package, severity, title, url }]. */
export function advisoriesOf(json) {
  const out = [];
  for (const [pkg, list] of Object.entries(json ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const id = String(a.url ?? "").match(GHSA)?.[0] ?? `npm-${a.id}`;
      out.push({
        id,
        package: pkg,
        severity: a.severity,
        title: a.title,
        url: a.url,
      });
    }
  }
  return out;
}

/** Compare found advisories with the allowlist on `today`. */
export function compare(found, entries, today) {
  const problems = [];
  const allowed = [];
  for (const [i, e] of entries.entries()) {
    for (const f of ["id", "package", "owner", "expires", "reason"]) {
      if (typeof e[f] !== "string" || !e[f].trim())
        problems.push(`allowlist entry ${i}: missing \`${f}\``);
    }
    if (typeof e.expires === "string" && !DATE.test(e.expires))
      problems.push(`allowlist entry ${i}: expires is not YYYY-MM-DD`);
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set();
  for (const a of found) {
    seen.add(a.id);
    const e = byId.get(a.id);
    if (!e)
      problems.push(
        `new: ${a.id} ${a.package} (${a.severity}) ${a.title} ${a.url}`,
      );
    else if (e.package !== a.package)
      problems.push(
        `new: ${a.id} reported for ${a.package}, but allowed only for ${e.package}`,
      );
    else if (today > e.expires)
      problems.push(
        `expired: ${a.id} ${a.package} — allowed until ${e.expires} (owner ${e.owner}); fix it or decide again`,
      );
    else
      allowed.push({
        ...a,
        expires: e.expires,
        owner: e.owner,
        reason: e.reason,
      });
  }
  for (const e of entries) {
    if (!seen.has(e.id))
      problems.push(
        `stale: ${e.id} ${e.package} is no longer reported — delete the entry`,
      );
  }
  return { problems, allowed };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--today");
  const today = at >= 0 ? args[at + 1] : new Date().toISOString().slice(0, 10);
  const { advisories: entries } = JSON.parse(readFileSync(LIST, "utf8"));

  const res = spawnSync("bun", ["audit", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  let json;
  try {
    json = JSON.parse(res.stdout || "null");
  } catch {
    json = undefined;
  }
  // Exit 0 = nothing found, 1 = advisories found; anything else, or output
  // that is not the advisory map, means bun audit did not answer.
  if (
    json === undefined ||
    json === null ||
    typeof json !== "object" ||
    (res.status !== 0 && res.status !== 1)
  ) {
    console.error(
      `bun audit did not answer (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
    );
    process.exit(2);
  }
  const found = advisoriesOf(json);
  const { problems, allowed } = compare(found, entries, today);

  const lines = [
    `### bun audit: ${found.length} advisor${found.length === 1 ? "y" : "ies"}`,
    "",
  ];
  for (const a of allowed)
    lines.push(
      `- allowed until ${a.expires}: ${a.id} ${a.package} (${a.severity}) — ${a.reason}`,
    );
  for (const p of problems) lines.push(`- **${p}**`);
  if (!found.length && !problems.length) lines.push("- none");
  const md = `${lines.join("\n")}\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  for (const p of problems)
    if (process.env.GITHUB_ACTIONS)
      console.log(`::error title=bun audit::${p}`);
  process.exit(problems.length ? 1 : 0);
}
