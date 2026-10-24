// Records the SQLite SQL oracle: `setup` and every case of cases.json through
// the native sqlite3 CLI in JSON mode, into recorded/results.json. Local only
// (CI replays the recording: data-store/tests/sqlite_oracle.rs).
//
//   SQLITE3=/path/to/sqlite3 node tests/sqlite-sql/record.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const sqlite = process.env.SQLITE3 ?? "sqlite3";
const spec = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
const version = execFileSync(sqlite, ["--version"], { encoding: "utf8" })
  .trim()
  .split(" ")[0];

const results = {};
for (const c of spec.cases) {
  const script = [
    ...spec.setup.map((s) => `${s};`),
    ".mode json",
    `${c.sql};`,
  ].join("\n");
  try {
    const out = execFileSync(sqlite, [":memory:"], {
      input: script,
      encoding: "utf8",
    });
    // One object per row, keys in column order; an empty result prints nothing.
    const rows = out.trim() === "" ? [] : JSON.parse(out);
    results[c.id] = { rows: rows.map((r) => Object.values(r)) };
  } catch (err) {
    results[c.id] = { error: String(err.stderr ?? err.message).trim() };
  }
}
writeFileSync(
  join(HERE, "recorded", "results.json"),
  `${JSON.stringify({ sqlite: version, results }, null, 2)}\n`,
);
console.log(`recorded ${spec.cases.length} cases with sqlite ${version}`);
