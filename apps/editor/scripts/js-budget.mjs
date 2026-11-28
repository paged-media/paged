/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The JavaScript size ratchet of the editor build.
//
// Why this script exists: the wasm the app ships has a budget
// (scripts/wasm-budget.mjs, tooling/ci/wasm-size-ratchet.mjs); the JavaScript
// a page loads before it can paint had none. One static import of a heavy
// panel moves the whole panel into the entry, and no check noticed.
//
// What it measures, from a FINISHED Vite build: the ENTRY of each page, which
// is every script its HTML names — the `<script type="module" src>` and the
// `<link rel="modulepreload" href>` Vite writes for the static import graph
// of the entry. That is what the browser fetches before the editor runs; a
// chunk behind a dynamic `import()` is not in it. The editor page
// (`index.html`, entry "main") and the embedded editor (`embed.html`, entry
// "embed") are measured, raw and gzip (node:zlib, default level). Chunk file
// names carry content hashes, so the budget is keyed by ENTRY and holds its
// total bytes, never a file name. The sum of all JavaScript under `assets/`
// is printed as information and gates nothing: it includes every lazy chunk
// and every worker.
//
// The ratchet (scripts/js-budget.json), as the engine wasm's
// (tooling/ci/wasm-size-ratchet.mjs): an entry whose raw or gzip total is
// more than `tolerance` (one percent) over the recorded value FAILS; growing
// an entry takes an edit of the JSON in the same change, where a reviewer
// sees the number. An entry that has shrunk by more than the tolerance is
// reported (not failed), so the record follows it down: run `--write`.
// An entry the JSON names that cannot be measured (no build, no HTML, a
// script the HTML names that is not there) FAILS: nothing measured is never
// a pass.
//
// Usage:  bun scripts/js-budget.mjs [--dist <dir>] [--budget <file>]
//                                   [--write] [--json] [--json-out <file>]
//   --dist      the build directory (default apps/canvas/dist)
//   --budget    the record (default scripts/js-budget.json)
//   --write     record the current sizes in the budget file and exit 0
//   --json      print the measurement as JSON instead of the table
//   --json-out  also write the measurement artifact to <file>; the exit
//               code is still the gate's
// Exit 1 when an entry is over or cannot be measured.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DIST = join(ROOT, "apps/canvas/dist");
export const DEFAULT_BUDGET = join(ROOT, "scripts/js-budget.json");

/** The pages measured: entry name → its HTML in the build directory. */
export const ENTRIES = { main: "index.html", embed: "embed.html" };

/** How far an entry may be over its record before the gate fails, and how
 *  far under before it asks for the record to be lowered. */
export const DEFAULT_TOLERANCE = 0.01;

const ATTR = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(
    tag,
  );
  return m ? (m[1] ?? m[2]) : null;
};

/** The script URLs an HTML document makes the browser fetch up front: module
 *  and classic `<script src>`, and `<link rel="modulepreload" href>`. In
 *  document order, each once. */
export function entryScripts(html) {
  const urls = [];
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    let url = null;
    if (m[1].toLowerCase() === "script") url = ATTR(tag, "src");
    else if (/\bmodulepreload\b/i.test(ATTR(tag, "rel") ?? ""))
      url = ATTR(tag, "href");
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** The file in `dist` a script URL of its HTML names, or null. A build with
 *  a `base` writes `/base/assets/x.js` for `dist/assets/x.js`: leading path
 *  segments are dropped until a file is found. A URL with an origin is not
 *  the build's own file. */
export function resolveScript(dist, url) {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return null;
  const parts = url
    .replace(/[?#].*$/, "")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) return null;
  for (let i = 0; i < parts.length; i++) {
    const file = join(dist, ...parts.slice(i));
    if (existsSync(file)) return file;
  }
  return null;
}

/** Every `.js` / `.mjs` file under `dir`. */
function scriptsUnder(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) scriptsUnder(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const sizesOf = (file) => {
  const bytes = readFileSync(file);
  return { raw: bytes.length, gzip: gzipSync(bytes).length };
};

/**
 * The measurement of a build directory:
 * `{ entries: { <name>: { html, files, raw, gzip } | { html, error } },
 *    assets: { files, raw, gzip } }`.
 * An entry that cannot be measured carries `error` and no sizes.
 */
export function measure(dist, entries = ENTRIES) {
  if (!existsSync(dist))
    throw new Error(
      `no build at ${dist} — run \`bunx --bun vite build\` in apps/canvas first (or pass --dist)`,
    );
  const out = { entries: {}, assets: { files: 0, raw: 0, gzip: 0 } };
  for (const [name, html] of Object.entries(entries)) {
    const page = join(dist, html);
    if (!existsSync(page)) {
      out.entries[name] = { html, error: `${html} is not in the build` };
      continue;
    }
    const urls = entryScripts(readFileSync(page, "utf8"));
    if (urls.length === 0) {
      out.entries[name] = { html, error: `${html} names no script` };
      continue;
    }
    let raw = 0;
    let gzip = 0;
    let error = null;
    for (const url of urls) {
      const file = resolveScript(dist, url);
      if (!file) {
        error = `${html} names ${url}, which is not in the build`;
        break;
      }
      const s = sizesOf(file);
      raw += s.raw;
      gzip += s.gzip;
    }
    out.entries[name] = error
      ? { html, error }
      : { html, files: urls.length, raw, gzip };
  }
  for (const file of scriptsUnder(join(dist, "assets"))) {
    const s = sizesOf(file);
    out.assets.files += 1;
    out.assets.raw += s.raw;
    out.assets.gzip += s.gzip;
  }
  return out;
}

/**
 * Hold a measurement to the record:
 * `[{ entry, metric: "raw" | "gzip", size, recorded, max, status }]` with
 * `status` one of "ok", "over", "slack" (more than the tolerance under the
 * record: lower it), "missing" (the entry could not be measured) and
 * "unrecorded" (measured, but the record has no number for it).
 */
export function judge(budget, measurement) {
  const tolerance = budget.tolerance ?? DEFAULT_TOLERANCE;
  const rows = [];
  const names = new Set([
    ...Object.keys(budget.entries ?? {}),
    ...Object.keys(measurement.entries),
  ]);
  for (const entry of names) {
    const recorded = budget.entries?.[entry];
    const measured = measurement.entries[entry];
    for (const metric of ["raw", "gzip"]) {
      const want = recorded?.[metric];
      const row = { entry, metric, size: null, recorded: want ?? null };
      if (!measured || measured.error) {
        rows.push({
          ...row,
          status: "missing",
          error: measured?.error ?? "the build has no such entry",
        });
        continue;
      }
      row.size = measured[metric];
      if (typeof want !== "number") {
        rows.push({ ...row, status: "unrecorded" });
        continue;
      }
      const max = Math.floor(want * (1 + tolerance));
      const status =
        row.size > max
          ? "over"
          : row.size < want * (1 - tolerance)
            ? "slack"
            : "ok";
      rows.push({ ...row, max, status });
    }
  }
  return rows;
}

/** The record `--write` leaves: the old one with the measured sizes. */
export function recorded(budget, measurement) {
  const entries = {};
  for (const [name, m] of Object.entries(measurement.entries)) {
    if (m.error) throw new Error(`cannot record "${name}": ${m.error}`);
    entries[name] = { html: m.html, raw: m.raw, gzip: m.gzip };
  }
  return {
    about:
      budget.about ??
      "The JavaScript size ratchet of the editor build (scripts/js-budget.mjs). Per entry page, the bytes of every script its HTML names (the entry script and its modulepreloads), raw and gzip, as measured from a production build. A build more than `tolerance` over a number fails: raise it here, in the change that grows the entry, and say why in the commit. `bun scripts/js-budget.mjs --write` records the current build.",
    tolerance: budget.tolerance ?? DEFAULT_TOLERANCE,
    entries,
  };
}

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

/** `--json-out <path>`: the measurement artifact, written as a SIDE EFFECT
 *  (never `--json | tee`: a pipe replaces the gate's exit code with tee's). */
function writeArtifact(path, measurement, rows) {
  const statusOf = (entry, metric) =>
    rows.find((r) => r.entry === entry && r.metric === metric);
  const measurements = [];
  for (const [name, m] of Object.entries(measurement.entries)) {
    if (m.error) continue;
    for (const metric of ["raw", "gzip"]) {
      const row = statusOf(name, metric);
      measurements.push({
        metric: `js.entry_${metric}_bytes`,
        subject: name,
        value: m[metric],
        unit: "bytes",
        status: row?.status === "over" ? "over" : "ok",
        ...(typeof row?.max === "number" ? { budget: row.max } : {}),
      });
    }
  }
  measurements.push(
    {
      metric: "js.assets_raw_bytes",
      subject: "app",
      value: measurement.assets.raw,
      unit: "bytes",
      status: "ok",
    },
    {
      metric: "js.assets_gzip_bytes",
      subject: "app",
      value: measurement.assets.gzip,
      unit: "bytes",
      status: "ok",
    },
    {
      metric: "js.assets_file_count",
      subject: "app",
      value: measurement.assets.files,
      unit: "count",
      status: "ok",
    },
  );
  const doc = {
    contract: 1,
    source: "editor",
    lane: "js-budget",
    commit: process.env.GITHUB_SHA ?? "unknown",
    branch: process.env.GITHUB_REF_NAME ?? "main",
    ...(process.env.GITHUB_RUN_ID
      ? { run_id: String(process.env.GITHUB_RUN_ID) }
      : {}),
    finished_at: new Date().toISOString(),
    environment: {
      os: process.env.RUNNER_OS ?? process.platform,
      arch: process.arch,
    },
    measurements,
  };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function main() {
  const dist = argOf("--dist") ?? DEFAULT_DIST;
  const budgetPath = argOf("--budget") ?? DEFAULT_BUDGET;
  const write = process.argv.includes("--write");
  const json = process.argv.includes("--json");
  const outPath = argOf("--json-out");
  const gha = !!process.env.GITHUB_ACTIONS;
  const fail = (message) => {
    console.error(`${gha ? "::error::" : ""}js budget: ${message}`);
    process.exit(1);
  };

  let measurement;
  try {
    measurement = measure(dist);
  } catch (err) {
    fail(err.message);
  }

  let budget = {};
  if (existsSync(budgetPath)) {
    try {
      budget = JSON.parse(readFileSync(budgetPath, "utf8"));
    } catch (err) {
      fail(`${budgetPath} is not JSON: ${err.message}`);
    }
  } else if (!write) {
    fail(`no record at ${budgetPath} — run with --write to create it`);
  }

  if (write) {
    let next;
    try {
      next = recorded(budget, measurement);
    } catch (err) {
      fail(err.message);
    }
    writeFileSync(budgetPath, `${JSON.stringify(next, null, 2)}\n`);
    budget = next;
  }

  const rows = judge(budget, measurement);
  if (outPath) writeArtifact(outPath, measurement, rows);

  if (json) {
    console.log(JSON.stringify({ ...measurement, rows }, null, 2));
  } else {
    console.log(`editor JavaScript, entry by entry (${dist}):\n`);
    for (const [name, m] of Object.entries(measurement.entries)) {
      console.log(
        m.error
          ? `  ${name.padEnd(6)} not measured: ${m.error}`
          : `  ${name.padEnd(6)} ${kb(m.raw).padStart(11)} raw  ${kb(m.gzip).padStart(10)} gzip  ${m.files} script(s) of ${m.html}`,
      );
    }
    const a = measurement.assets;
    console.log(
      `\n  ${"all".padEnd(6)} ${kb(a.raw).padStart(11)} raw  ${kb(a.gzip).padStart(10)} gzip  ${a.files} script(s) under assets/ (information: lazy chunks and workers included)\n`,
    );
  }

  const record = relative(join(ROOT, "..", ".."), budgetPath);
  let failed = false;
  for (const row of rows) {
    const what = `${row.entry} ${row.metric}`;
    const line = `${what}: ${row.size} bytes, recorded ${row.recorded}`;
    if (row.status === "missing") {
      failed = true;
      console.error(
        `${gha ? "::error::" : ""}js budget: ${what} was not measured — ${row.error}`,
      );
    } else if (row.status === "unrecorded") {
      failed = true;
      console.error(
        `${gha ? "::error::" : ""}js budget: ${what}: ${row.size} bytes, and ${record} has no number for it. Record it with --write.`,
      );
    } else if (row.status === "over") {
      failed = true;
      console.error(
        `${gha ? "::error::" : ""}js budget: ${line} (max ${row.max}) — ${row.size - row.max} bytes over. Move what the first paint does not need behind a dynamic import, or raise the number in ${record} in the same change and say why.`,
      );
    } else if (row.status === "slack") {
      console.log(
        `${gha ? "::notice::" : ""}js budget: ${line} — more than ${((budget.tolerance ?? DEFAULT_TOLERANCE) * 100).toFixed(0)}% under its record; lower it (bun scripts/js-budget.mjs --write).`,
      );
    } else if (!json) console.log(`js budget: ${line} (max ${row.max}) — ok`);
  }
  if (write && !failed) console.log(`\nrecorded in ${record}.`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
