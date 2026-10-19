#!/usr/bin/env bun
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
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The React Compiler's re-render measurement in the DOM lane (ADR 229):
// runs test/measure/panels.measure.test.tsx twice, on the sources as
// written and compiled by the build's compiler configuration
// (tooling/js/bun-react-compiler.ts), and prints both side by side.
//
//   bun run test:render-counts [-- --json <file>]
//
// What one scenario reports: React's commits and the components it
// rendered, summed over the same interactions, and the share of mounted
// function components that carry a compiler cache.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const tooling = join(app, "..", "..", "..", "..", "tooling", "js");
const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;

function run(mode) {
  const preloads = [
    "./test/measure/render-counter.ts",
    join(tooling, "bun-test-setup.ts"),
    "./test/happydom.ts",
    "./test/vite-shim.ts",
    ...(mode === "compiled" ? [join(tooling, "bun-react-compiler.ts")] : []),
  ].flatMap((p) => ["--preload", p]);
  const res = spawnSync(
    "bun",
    [
      "test",
      "--timeout",
      "120000",
      ...preloads,
      "./test/measure/panels.measure.test.tsx",
    ],
    {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, PAGED_RENDER_COUNTS_MODE: mode },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const out = `${res.stdout}\n${res.stderr}`;
  const rows = out
    .split("\n")
    .filter((l) => l.startsWith("RENDER-COUNTS "))
    .map((l) => JSON.parse(l.slice("RENDER-COUNTS ".length)));
  if (res.status !== 0 || rows.length === 0) {
    console.error(out);
    throw new Error(`the ${mode} run failed (exit ${res.status})`);
  }
  return rows;
}

const plain = run("plain");
const compiled = run("compiled");
const table = plain.map((p) => {
  const c = compiled.find((x) => x.panel === p.panel);
  return {
    panel: p.panel,
    interactions: p.interactions,
    renders: [p.renders, c.renders],
    panelRenders: [p.panelRenders, c.panelRenders],
    commits: [p.commits, c.commits],
    mountRenders: [p.mount.renders, c.mount.renders],
    memoCache: `${c.memo.compiled}/${c.memo.functionComponents}`,
    perCommit: [p, c].map((x) =>
      x.commits ? (x.panelRenders / x.commits).toFixed(2) : "-",
    ),
  };
});
const pct = (a, b) => (a ? `${Math.round((100 * (b - a)) / a)}%` : "-");
const cell = ([a, b]) => `${a} -> ${b} (${pct(a, b)})`;
console.log(
  `${"panel".padEnd(11)}${"steps".padStart(6)}  ${"panel renders".padEnd(24)}${"per commit".padEnd(16)}${"all renders".padEnd(26)}${"commits".padEnd(18)}${"mount renders".padEnd(22)}memo cache`,
);
for (const r of table) {
  console.log(
    `${r.panel.padEnd(11)}${String(r.interactions).padStart(6)}  ${cell(r.panelRenders).padEnd(24)}${`${r.perCommit[0]} -> ${r.perCommit[1]}`.padEnd(16)}${cell(r.renders).padEnd(26)}${cell(r.commits).padEnd(18)}${cell(r.mountRenders).padEnd(22)}${r.memoCache}`,
  );
}
if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ plain, compiled }, null, 2)}\n`);
}
