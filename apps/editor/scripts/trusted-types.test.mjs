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
const {
  REPORT_PATH,
  TRUSTED_TYPES_POLICY,
  TRUSTED_TYPES_POLICY_NAMES,
  allowedScriptUrl,
  installDefaultPolicy,
} = await import(resolve(canvas, "src", "boot", "trusted-types.ts"));

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

/** Run `fn` with `globalThis.trustedTypes` set to `tt`. */
function withTrustedTypes(tt, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "trustedTypes");
  globalThis.trustedTypes = tt;
  try {
    fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "trustedTypes", had);
    else delete globalThis.trustedTypes;
  }
}

test("the default policy is installed once per page, and a host's stays (E1)", () => {
  const created = [];
  const tt = {
    defaultPolicy: undefined,
    createPolicy(name, rules) {
      created.push(name);
      this.defaultPolicy = rules;
      return rules;
    },
  };
  withTrustedTypes(tt, () => {
    installDefaultPolicy(() => false);
    installDefaultPolicy(() => false); // a second editor on the page
  });
  assert.deepEqual(created, ["default"]);

  const host = { defaultPolicy: {}, createPolicy: () => assert.fail() };
  withTrustedTypes(host, () => installDefaultPolicy(() => false));
});

test("a host that does not allow the default policy does not stop the mount", () => {
  const warn = console.warn;
  let warned = 0;
  console.warn = () => void warned++;
  try {
    withTrustedTypes(
      {
        createPolicy() {
          throw new TypeError("Policy default disallowed.");
        },
      },
      () => installDefaultPolicy(() => false),
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(warned, 1);
});

test("the policy names a host must allow are the ones the editor creates", () => {
  const sources = [
    "packages/ui/src/code/CodeEditor.tsx",
    "packages/shell/src/icons/plugin-glyph.tsx",
    "packages/shell/src/demo/runner.ts",
    "../../modules/sheet/packages/sheet-bundle/src/panels/grid-panel.tsx",
    "../../modules/web/packages/web-bundle/src/panels/web-source-panel.tsx",
  ]
    .map((p) => readFileSync(resolve(here, "..", p), "utf8"))
    .join("\n");
  for (const name of TRUSTED_TYPES_POLICY_NAMES.filter((n) => n !== "default"))
    assert.ok(sources.includes(`"${name}"`), name);
});
