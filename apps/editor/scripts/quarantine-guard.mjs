#!/usr/bin/env bun
/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The Playwright quarantine guard (apps/editor/docs/adr/228).
//
//   bun scripts/quarantine-guard.mjs            the list itself: fields, dates, expiry
//   bun scripts/quarantine-guard.mjs --list     also: the list and the @quarantine
//                                               tags in the specs name the same tests
//   bun scripts/quarantine-guard.mjs --listing <playwright --list json>
//
// A flaky test is not retried until it passes. It is QUARANTINED: an entry in
// apps/canvas/tests/quarantine.json (id, owner, added, expires, reason) plus
// `{ tag: "@quarantine" }` on the test, which takes it out of the gating CI
// run and into an advisory one that keeps measuring it. This guard is what
// keeps a quarantine from becoming a place tests go to be forgotten:
//
//   - every entry names an owner, a reason and an expiry at most MAX_DAYS
//     after the day it was added;
//   - an expired entry FAILS: fix the test, delete it, or decide again (a new
//     `added` date, and a reason that says what changed);
//   - with --list, every entry names exactly one test that carries the tag,
//     and every tagged test has an entry (both directions, so the list cannot
//     drift from the specs).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { testId, testsOf } from "./flake-rate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANVAS = join(ROOT, "apps", "canvas");
export const LIST = join(CANVAS, "tests", "quarantine.json");

/** The longest a test may stay quarantined on one decision. */
export const MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OWNER = /^@[A-Za-z0-9-]+(\/[A-Za-z0-9-]+)?$/;
const TAG = "quarantine";

const parseDate = (s) =>
  DATE.test(s ?? "") ? Date.parse(`${s}T00:00:00Z`) : NaN;

/**
 * Check the entries themselves. `today` is `YYYY-MM-DD` (UTC). Returns a list
 * of error strings; empty means the list is valid on that day.
 */
export function checkEntries(entries, today) {
  const errors = [];
  const now = parseDate(today);
  const seen = new Set();
  if (!Array.isArray(entries)) return ["`entries` must be an array"];
  entries.forEach((e, i) => {
    const at = `entry ${i}${e?.id ? ` (${e.id})` : ""}`;
    for (const field of ["id", "owner", "added", "expires", "reason"]) {
      if (typeof e?.[field] !== "string" || e[field].trim() === "")
        errors.push(`${at}: missing \`${field}\``);
    }
    if (typeof e?.id === "string") {
      if (seen.has(e.id)) errors.push(`${at}: listed twice`);
      seen.add(e.id);
      if (!e.id.includes(" › "))
        errors.push(
          `${at}: id is \`<file> › <describe> › <title>\`, as Playwright prints it`,
        );
    }
    if (typeof e?.owner === "string" && !OWNER.test(e.owner))
      errors.push(`${at}: owner is a GitHub handle or team (@name, @org/team)`);
    const added = parseDate(e?.added);
    const expires = parseDate(e?.expires);
    if (typeof e?.added === "string" && Number.isNaN(added))
      errors.push(`${at}: added is not a YYYY-MM-DD date`);
    if (typeof e?.expires === "string" && Number.isNaN(expires))
      errors.push(`${at}: expires is not a YYYY-MM-DD date`);
    if (!Number.isNaN(added) && !Number.isNaN(expires)) {
      if (expires < added) errors.push(`${at}: expires before it was added`);
      else if ((expires - added) / DAY_MS > MAX_DAYS)
        errors.push(
          `${at}: expires more than ${MAX_DAYS} days after it was added`,
        );
      if (!Number.isNaN(now) && added > now)
        errors.push(`${at}: added in the future`);
    }
    if (!Number.isNaN(expires) && !Number.isNaN(now) && now > expires)
      errors.push(
        `${at}: EXPIRED on ${e.expires} (owner ${e.owner}) — fix the test, delete it, or decide again`,
      );
  });
  return errors;
}

/**
 * Cross-check the entries against a Playwright listing (`--list
 * --reporter=json`): each entry names exactly one test id, that test carries
 * the tag, and every tagged test has an entry.
 */
export function checkListing(entries, listing) {
  const errors = [];
  /** @type {Map<string, boolean>} id → tagged (in any project) */
  const tests = new Map();
  for (const t of testsOf(listing)) {
    const id = testId(t);
    tests.set(id, (tests.get(id) ?? false) || t.tags.includes(TAG));
  }
  if (tests.size === 0)
    return [
      "the listing holds no tests (a listing that reads nothing passes everything)",
    ];
  const listed = new Set(entries.map((e) => e.id));
  for (const id of listed) {
    if (!tests.has(id))
      errors.push(`stale: ${id} — no such test; delete the entry`);
    else if (!tests.get(id))
      errors.push(
        `untagged: ${id} — add \`{ tag: "@quarantine" }\` to the test`,
      );
  }
  for (const [id, tagged] of tests) {
    if (tagged && !listed.has(id))
      errors.push(
        `unlisted: ${id} — carries @quarantine but has no entry (owner, expiry, reason)`,
      );
  }
  return errors;
}

function playwrightListing() {
  const require = createRequire(join(CANVAS, "package.json"));
  const cli = require.resolve("@playwright/test/cli.js");
  const res = spawnSync(
    "node",
    [
      cli,
      "test",
      "--list",
      "--reporter=json",
      "--project=chromium",
      "--project=journeys",
    ],
    {
      cwd: CANVAS,
      env: { ...process.env, PAGED_CI_LEAN: process.env.PAGED_CI_LEAN ?? "1" },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    throw new Error(`playwright --list exited ${res.status}`);
  }
  return JSON.parse(res.stdout);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const { entries } = JSON.parse(readFileSync(LIST, "utf8"));
  const today =
    process.env.QUARANTINE_TODAY ?? new Date().toISOString().slice(0, 10);
  const errors = checkEntries(entries, today);
  let listing = null;
  const at = args.indexOf("--listing");
  if (at >= 0) listing = JSON.parse(readFileSync(args[at + 1], "utf8"));
  else if (args.includes("--list")) listing = playwrightListing();
  if (listing && errors.length === 0)
    errors.push(...checkListing(entries, listing));

  for (const e of entries ?? []) {
    console.log(
      `quarantined: ${e.id}\n  owner ${e.owner}, until ${e.expires}: ${e.reason}`,
    );
  }
  if (errors.length) {
    console.error(`\nquarantine guard: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `quarantine guard: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} valid on ${today}` +
      (listing ? ", list and tags agree" : ""),
  );
}
