#!/usr/bin/env node
/**
 * The deploy gate: wait for the commit's check workflows, then say whether
 * every one of them succeeded.
 *
 * A deploy must not publish a commit whose tests failed. The check workflows
 * are path-filtered, so there is no fixed list of "required" names: the gate
 * takes every workflow run GitHub started for this commit by a push (the
 * commit's own checks; scheduled and dispatched runs are not), except the run
 * it is part of. It polls until none of them is still queued or running and
 * then fails unless each concluded `success` or `skipped`.
 *
 * A check that was CANCELLED (and none that failed) is the third outcome,
 * "superseded": main's concurrency groups cancel a waiting run when a newer
 * push arrives, and that newer commit is the one to deploy. The gate then
 * says so, writes `ok=false` and exits 0, and the deploy job (which runs
 * only on `ok == 'true'`) is skipped rather than red.
 *
 *   GITHUB_TOKEN=… node tooling/ci/await-commit-checks.mjs \
 *       --repo owner/name --sha <commit> --self <this run's id> \
 *       [--settle 90] [--interval 60] [--timeout 7200]
 *
 * `--settle` is how long (seconds) the gate waits before its first verdict,
 * so that workflows GitHub has not queued yet are seen. Exit 0 with
 * `ok=true` in $GITHUB_OUTPUT: all green. Exit 0 with `ok=false`: superseded.
 * Exit 1: a check failed, or the time ran out. Exit 2: usage or API error.
 */

import { appendFileSync } from "node:fs";

const OK = new Set(["success", "skipped", "neutral"]);

/** The latest run of each workflow among `runs` (a re-run replaces a run). */
export function latestPerWorkflow(runs) {
  const latest = new Map();
  for (const run of runs) {
    const seen = latest.get(run.workflow_id);
    if (
      !seen ||
      run.run_number > seen.run_number ||
      (run.run_number === seen.run_number && run.run_attempt > seen.run_attempt)
    )
      latest.set(run.workflow_id, run);
  }
  return [...latest.values()];
}

/**
 * `{ state: "pending" | "green" | "red" | "superseded", … }` for the
 * commit's push-triggered runs other than `selfRunId`.
 */
export function verdict(runs, selfRunId) {
  const checks = latestPerWorkflow(
    runs.filter(
      (run) => run.event === "push" && String(run.id) !== String(selfRunId),
    ),
  );
  const pending = checks.filter((run) => run.status !== "completed");
  const failed = checks.filter(
    (run) => run.status === "completed" && !OK.has(run.conclusion),
  );
  const passed = checks.filter(
    (run) => run.status === "completed" && OK.has(run.conclusion),
  );
  const cancelled = failed.filter((run) => run.conclusion === "cancelled");
  const state =
    failed.length > cancelled.length
      ? "red"
      : pending.length
        ? "pending"
        : cancelled.length
          ? "superseded"
          : "green";
  return { state, pending, failed, passed };
}

async function listRuns(repo, sha, token) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok)
      throw new Error(
        `GET ${url}: ${response.status} ${await response.text()}`,
      );
    const body = await response.json();
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) break;
  }
  return runs;
}

function args(argv) {
  const out = { settle: 90, interval: 60, timeout: 7200 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!key || value === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[key] = ["settle", "interval", "timeout"].includes(key)
      ? Number(value)
      : value;
  }
  for (const key of ["repo", "sha", "self"])
    if (!out[key]) throw new Error(`--${key} is required`);
  return out;
}

const output = (line) => {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
};
const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const names = (runs) =>
  runs.map((run) => `${run.name} (${run.conclusion ?? run.status})`).join(", ");

async function main() {
  const token = process.env.GITHUB_TOKEN;
  let opts;
  try {
    opts = args(process.argv.slice(2));
    if (!token) throw new Error("GITHUB_TOKEN is not set");
  } catch (error) {
    console.error(`await-commit-checks: ${error.message}`);
    process.exit(2);
  }
  const started = Date.now();
  await sleep(opts.settle);
  for (;;) {
    let result;
    try {
      result = verdict(await listRuns(opts.repo, opts.sha, token), opts.self);
    } catch (error) {
      console.error(`await-commit-checks: ${error.message}`);
      process.exit(2);
    }
    if (result.state === "red") {
      console.error(
        `::error::not deploying ${opts.sha}: ${names(result.failed)} did not succeed.`,
      );
      process.exit(1);
    }
    if (result.state === "superseded") {
      console.log(
        `::warning title=not deploying::${opts.sha}: ${names(result.failed)} — cancelled, as a commit superseded by a newer push is. Nothing failed; the deploy is skipped.`,
      );
      output("ok=false");
      return;
    }
    if (result.state === "green") {
      output("ok=true");
      console.log(
        `all ${result.passed.length} check workflows of ${opts.sha} succeeded: ${names(result.passed)}`,
      );
      return;
    }
    const waited = Math.round((Date.now() - started) / 1000);
    if (waited >= opts.timeout) {
      console.error(
        `::error::not deploying ${opts.sha}: still waiting after ${waited}s for ${names(result.pending)}.`,
      );
      process.exit(1);
    }
    console.log(`${waited}s: waiting for ${names(result.pending)}`);
    await sleep(opts.interval);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
