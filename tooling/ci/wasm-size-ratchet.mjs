#!/usr/bin/env node
/**
 * The size ratchet of the shipped engine wasm.
 *
 * `tooling/ci/engine-wasm-sizes.json` records, for each wasm file the
 * engine's packages ship, the size last measured on CI and the most it may
 * be (`max`, the measurement plus about one percent). A build whose file is
 * larger than its `max` fails: growing an artifact takes an edit of that
 * file, in the same change, where a reviewer sees the number. A file that
 * has shrunk by more than three percent below its `max` is reported (not
 * failed), so the budget follows it down.
 *
 *   node tooling/ci/wasm-size-ratchet.mjs [--json <out file>]
 *
 * Sizes are of the release build (`wasm-release` profile, wasm-bindgen,
 * wasm-opt -Oz) that .github/actions/engine-wasm produces; a local
 * `moon run core:wasm-dev` build is not comparable and is not what this
 * measures.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** `[{ file, size, max, status: "ok" | "over" | "slack" | "missing" }]`. */
export function judge(budget, sizeOf) {
  return Object.entries(budget.artifacts).map(([file, { max }]) => {
    const size = sizeOf(file);
    if (size === null) return { file, size, max, status: "missing" };
    if (size > max) return { file, size, max, status: "over" };
    if (size < max * 0.97) return { file, size, max, status: "slack" };
    return { file, size, max, status: "ok" };
  });
}

function main() {
  const budget = JSON.parse(
    readFileSync(join(HERE, "engine-wasm-sizes.json"), "utf8"),
  );
  const rows = judge(budget, (file) => {
    const path = join(ROOT, file);
    return existsSync(path) ? statSync(path).size : null;
  });
  const gha = !!process.env.GITHUB_ACTIONS;
  const mib = (n) => `${(n / 1048576).toFixed(2)} MiB`;
  let failed = false;
  for (const row of rows) {
    if (row.status === "missing") {
      failed = true;
      console.error(
        `${gha ? "::error::" : ""}wasm size: ${row.file} is not built — nothing was measured for it`,
      );
      continue;
    }
    const line = `${row.file}: ${row.size} bytes (${mib(row.size)}), max ${row.max}`;
    if (row.status === "over") {
      failed = true;
      console.error(
        `${gha ? "::error::" : ""}wasm size: ${line} — ${row.size - row.max} bytes over. Shrink it, or raise "max" in tooling/ci/engine-wasm-sizes.json in the same change and say why.`,
      );
    } else if (row.status === "slack") {
      console.log(
        `${gha ? "::notice::" : ""}wasm size: ${line} — more than 3% under its max; lower "max" to about ${Math.ceil((row.size * 1.01) / 1000) * 1000}.`,
      );
    } else console.log(`wasm size: ${line} — ok`);
  }
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt >= 0)
    writeFileSync(process.argv[jsonAt + 1], JSON.stringify(rows, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = [
      "### Engine wasm sizes",
      "",
      "| artifact | bytes | max | |",
      "|---|---:|---:|---|",
      ...rows.map(
        (r) => `| ${r.file} | ${r.size ?? "—"} | ${r.max} | ${r.status} |`,
      ),
      "",
    ].join("\n");
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, table, { flag: "a" });
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
