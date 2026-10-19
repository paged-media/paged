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

test("public/_headers ships the module's policy, report-only", () => {
  const headers = readFileSync(resolve(canvas, "public", "_headers"), "utf8");
  const line = headers
    .split("\n")
    .find((l) => /^\s*Content-Security-Policy-Report-Only:/.test(l));
  assert.ok(line, "_headers has no Content-Security-Policy-Report-Only line");
  assert.equal(
    line.replace(/^\s*Content-Security-Policy-Report-Only:\s*/, ""),
    TRUSTED_TYPES_POLICY,
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
