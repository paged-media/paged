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

// The T7 trial (docs/migration/bun-webview.md): Bun.WebView's Chrome backend
// against the Playwright library, both inside bun test, head to head on the
// wasm boot parity checks.
//
//   bun system/wasm-boot/trial.ts [--runs N] [--json FILE]     (in tests/)
//
// 1. Reliability and speed: N runs of wasm-boot.test.ts per driver, each a
//    fresh `bun test` process (browser launch included), the drivers
//    alternating so that machine load falls on both alike. Per run: wall
//    time, passed and failed checks.
// 2. What each driver can do beyond the checks, probed once each: console
//    and uncaught-error capture, network interception, tracing, a
//    screenshot, and a WebGPU adapter.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, onCdpEvent, type DriverName } from "./drivers";
import { startPageServer } from "./server";

const TESTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(opt("--runs") ?? 10);
const JSON_OUT = opt("--json");
const DRIVERS: DriverName[] = ["playwright", "webview"];

const browser = await chromium();
if (!browser.path) throw new Error(browser.why);
const CHROME = browser.path;
const scratch = mkdtempSync(join(tmpdir(), "paged-t7-"));

interface Run {
  driver: DriverName;
  ms: number;
  passed: number;
  failed: number;
  exit: number | null;
  /** The failed checks: name and the first line of the failure. */
  failures: string[];
}

function oneRun(driver: DriverName, i: number): Run {
  const junit = join(scratch, `${driver}-${i}.xml`);
  const t0 = performance.now();
  const r = spawnSync(
    "bun",
    [
      "test",
      "--timeout",
      "30000",
      "--preload",
      "../tooling/js/bun-test-setup.ts",
      "./system/wasm-boot/wasm-boot.test.ts",
      "--reporter=junit",
      `--reporter-outfile=${junit}`,
    ],
    {
      cwd: TESTS,
      env: {
        ...process.env,
        PAGED_WASM_BOOT_DRIVER: driver,
        PAGED_REQUIRE_BROWSER: "1",
        PAGED_CHROMIUM: CHROME,
      },
      encoding: "utf8",
    },
  );
  const ms = performance.now() - t0;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  try {
    const xml = readFileSync(junit, "utf8");
    for (const m of xml.matchAll(
      /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g,
    )) {
      const body = m[3] ?? "";
      if (/<failure|<error/.test(body)) {
        failed++;
        const name = /name="([^"]*)"/.exec(m[1]!)?.[1] ?? "?";
        const why = /(?:message|type)="([^"]*)"/.exec(body)?.[1] ?? "";
        failures.push(`${name}: ${why}`.slice(0, 300));
      } else if (!/<skipped/.test(body)) passed++;
    }
  } catch {
    failed = -1; // no report: the process died before writing one
    failures.push((r.stderr ?? "").split("\n").slice(-5).join(" | "));
  }
  if (failed !== 0 && failures.length === 0)
    failures.push(
      (r.stderr ?? "").split("\n").filter(Boolean).slice(-3).join(" | "),
    );
  return { driver, ms, passed, failed, exit: r.status, failures };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { min: s[0]!, median: q(0.5), p90: q(0.9), max: s[s.length - 1]! };
};

// ── 1. reliability and speed ─────────────────────────────────────────────

const runs: Run[] = [];
for (let i = 0; i < RUNS; i++) {
  for (const d of i % 2 === 0 ? DRIVERS : [...DRIVERS].reverse()) {
    const r = oneRun(d, i);
    runs.push(r);
    console.log(
      `run ${i + 1}/${RUNS} ${d.padEnd(10)} ${Math.round(r.ms)} ms  ${r.passed} passed, ${r.failed} failed, exit ${r.exit}`,
    );
    for (const f of r.failures) console.log(`    ${f}`);
  }
}

// ── 2. capabilities ──────────────────────────────────────────────────────

type Probe = Record<string, string>;
const server = startPageServer();
const PAGE = server.url;
const verdict = async (f: () => Promise<string>) => {
  try {
    return await Promise.race([
      f(),
      new Promise<string>((_, no) =>
        setTimeout(() => no(new Error("timed out after 15 s")), 15_000),
      ),
    ]);
  } catch (e) {
    return `fails: ${(e as Error).message.split("\n")[0]}`;
  }
};
const GPU = `(async () => { if (!navigator.gpu) return "no navigator.gpu"; const a = await navigator.gpu.requestAdapter(); return a ? "adapter" : "navigator.gpu, no adapter"; })()`;

async function probePlaywright(): Promise<Probe> {
  const { chromium: pw } = await import("playwright-core");
  const out: Probe = {};
  const t0 = performance.now();
  const b = await pw.launch({ executablePath: CHROME, headless: true });
  const context = await b.newContext();
  const page = await context.newPage();
  await page.goto(PAGE);
  out.launch = `${Math.round(performance.now() - t0)} ms to a loaded page`;
  out.console = await verdict(async () => {
    const seen: string[] = [];
    page.on("console", (m) => void seen.push(m.text()));
    page.on("pageerror", (e) => void seen.push(`pageerror ${e.message}`));
    await page.evaluate(
      `console.error("probe-console"); setTimeout(() => { throw new Error("probe-throw"); }); new Promise((r) => setTimeout(r, 100))`,
    );
    await page.waitForTimeout(100);
    return `console.error: ${seen.includes("probe-console") ? "yes" : "no"}; uncaught error: ${seen.some((s) => s.includes("probe-throw")) ? "yes" : "no"}`;
  });
  out.interception = await verdict(async () => {
    await page.route("**/probe.json", (r) =>
      r.fulfill({ contentType: "application/json", body: '{"stubbed":true}' }),
    );
    const got = await page.evaluate(
      `fetch("/probe.json").then((r) => r.json())`,
    );
    return JSON.stringify(got) === '{"stubbed":true}'
      ? "works (page.route)"
      : `wrong body ${JSON.stringify(got)}`;
  });
  out.tracing = await verdict(async () => {
    const path = join(scratch, "trace.zip");
    await context.tracing.start({ snapshots: true, screenshots: true });
    await page.evaluate("1 + 1");
    await context.tracing.stop({ path });
    return `works (${statSync(path).size} bytes, context.tracing)`;
  });
  out.screenshot = await verdict(
    async () => `works (${(await page.screenshot()).length} bytes PNG)`,
  );
  out.webgpu = await verdict(async () => String(await page.evaluate(GPU)));
  await b.close();
  return out;
}

async function probeWebView(): Promise<Probe> {
  const out: Probe = {};
  const seen: string[] = [];
  const t0 = performance.now();
  const view = new Bun.WebView({
    backend: { type: "chrome", url: false, path: CHROME },
    console: (type, ...a) =>
      void seen.push(`${type} ${a.map(String).join(" ")}`),
  });
  await view.navigate(PAGE);
  out.launch = `${Math.round(performance.now() - t0)} ms to a loaded page`;
  out.console = await verdict(async () => {
    await view.cdp("Runtime.enable");
    onCdpEvent<{
      exceptionDetails?: { exception?: { description?: string } };
    }>(
      view,
      "Runtime.exceptionThrown",
      (p) =>
        void seen.push(
          `exception ${p.exceptionDetails?.exception?.description ?? ""}`,
        ),
    );
    await view.evaluate(
      `(console.error("probe-console"), setTimeout(() => { throw new Error("probe-throw"); }), new Promise((r) => setTimeout(r, 100)))`,
    );
    await Bun.sleep(100);
    return `console.error: ${seen.some((s) => s.includes("probe-console")) ? "yes" : "no"}; uncaught error: ${seen.some((s) => s.includes("probe-throw")) ? "yes (Runtime.exceptionThrown over cdp())" : "no"}`;
  });
  out.interception = await verdict(async () => {
    await view.cdp("Fetch.enable", {
      patterns: [{ urlPattern: "*probe.json*" }],
    });
    onCdpEvent<{ requestId: string }>(view, "Fetch.requestPaused", (p) => {
      void view.cdp("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from('{"stubbed":true}').toString("base64"),
      });
    });
    const got = await view.evaluate(
      `fetch("/probe.json").then((r) => r.json())`,
    );
    await view.cdp("Fetch.disable");
    return JSON.stringify(got) === '{"stubbed":true}'
      ? "works, hand-written over cdp() (Fetch domain)"
      : `wrong body ${JSON.stringify(got)}`;
  });
  out.tracing = await verdict(async () => {
    let chunks = 0;
    const done = new Promise<void>((ok) =>
      view.addEventListener("Tracing.tracingComplete", () => ok()),
    );
    onCdpEvent<{ value: unknown[] }>(view, "Tracing.dataCollected", (p) => {
      chunks += p.value.length;
    });
    await view.cdp("Tracing.start", { categories: "devtools.timeline,v8" });
    await view.evaluate("1 + 1");
    await view.cdp("Tracing.end");
    await done;
    return `raw trace events only (${chunks} over cdp(); no trace viewer file)`;
  });
  out.screenshot = await verdict(
    async () =>
      `works (${(await view.screenshot({ encoding: "buffer" })).length} bytes PNG)`,
  );
  out.webgpu = await verdict(async () => String(await view.evaluate(GPU)));
  view.close();
  Bun.WebView.closeAll();
  return out;
}

const probes: Record<DriverName, Probe> = {
  playwright: await probePlaywright(),
  webview: await probeWebView(),
};
server.stop();

// ── report ───────────────────────────────────────────────────────────────

const summary = DRIVERS.map((d) => {
  const rs = runs.filter((r) => r.driver === d);
  const green = rs.filter((r) => r.exit === 0 && r.failed === 0).length;
  return {
    driver: d,
    runs: rs.length,
    green,
    checks: rs[0]?.passed ?? 0,
    failedChecks: rs.reduce((n, r) => n + Math.max(0, r.failed), 0),
    wallMs: stats(rs.map((r) => r.ms)),
  };
});
for (const s of summary)
  console.log(
    `${s.driver}: ${s.green}/${s.runs} green runs, ${s.checks} checks a run, ${s.failedChecks} failed checks; wall ms min ${Math.round(s.wallMs.min)} median ${Math.round(s.wallMs.median)} p90 ${Math.round(s.wallMs.p90)} max ${Math.round(s.wallMs.max)}`,
  );
for (const d of DRIVERS)
  for (const [k, v] of Object.entries(probes[d]))
    console.log(`${d} ${k}: ${v}`);
if (JSON_OUT)
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        bun: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        chromium: CHROME.split("/").slice(-4).join("/"),
        summary,
        probes,
        runs,
      },
      null,
      2,
    ),
  );
