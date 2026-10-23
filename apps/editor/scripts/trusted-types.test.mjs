#!/usr/bin/env node
// Unit test for the editor's Trusted Types policy (ADR 240):
// apps/canvas/src/boot/trusted-types.ts — the policy header, the script-URL
// rule of the default policy — plus the lock-step between the committed
// `public/_headers` and the module (the dev server sends the module's value).
//
// Run: `bun test ./scripts/trusted-types.test.mjs`
//   (root script `bun run test:trusted-types`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const canvas = resolve(here, "..", "apps", "canvas");
const { REPORT_PATH, TRUSTED_TYPES_POLICY, allowedScriptUrl } = await import(
  resolve(canvas, "src", "boot", "trusted-types.ts")
);

test("the policy requires Trusted Types for script and reports to the report route", () => {
  assert.equal(
    TRUSTED_TYPES_POLICY,
    `require-trusted-types-for 'script'; report-uri ${REPORT_PATH}`,
  );
  assert.equal(REPORT_PATH, "/api/csp-report");
});

test("public/_headers ships the module's policy, enforced, as a policy of its own", () => {
  const headers = readFileSync(resolve(canvas, "public", "_headers"), "utf8");
  // The site-wide block (`/*`); embed.html's own block follows it.
  const [site, embed = ""] = headers.split(/^\/embed\.html$/m);
  assert.match(embed, /Content-Security-Policy: frame-ancestors 'self'/);
  const policies = site
    .split("\n")
    .filter((l) => /^\s*Content-Security-Policy:/.test(l))
    .map((l) => l.replace(/^\s*Content-Security-Policy:\s*/, ""));
  // The connect-src wall comes first (the build's rewrite replaces the
  // first line only), the Trusted Types policy is a line of its own.
  assert.equal(policies.length, 2, "_headers ships two CSP lines");
  assert.match(policies[0], /^connect-src /);
  assert.equal(policies[1], TRUSTED_TYPES_POLICY);
  // Not report-only any more.
  assert.ok(
    !/Content-Security-Policy-Report-Only:.*trusted-types/.test(headers),
    "_headers still sends Trusted Types report-only",
  );
  // The report route is served by a Pages Function.
  readFileSync(resolve(canvas, "functions", "api", "csp-report.ts"), "utf8");
});

test("the default policy admits the editor's own script URLs only", () => {
  const base = "https://play.paged.media/";
  for (const ok of [
    "/assets/worker-abc.js",
    "https://play.paged.media/assets/worker.js",
    "https://modules.paged.media/duckdb/1.29/duckdb-browser-eh.worker.js",
    "blob:https://play.paged.media/5f0c8f7e-0000-0000-0000-000000000000",
  ]) {
    assert.equal(allowedScriptUrl(ok, base), true, ok);
  }
  for (const bad of [
    "https://evil.example/x.js",
    "blob:https://evil.example/5f0c",
    "data:text/javascript,alert(1)",
    "javascript:alert(1)",
  ]) {
    assert.equal(allowedScriptUrl(bad, base), false, bad);
  }
});
