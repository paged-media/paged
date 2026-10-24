// The Turso spike's wasm lane: times the bench exports of the release wasm
// (wasm-bindgen --target web output) under Bun. Usage:
//   bun bench/wasm-1m.mjs <dir with data_store_spike.js and its _bg.wasm>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const glue = await import(join(dir, "data_store_spike.js"));
const wasm = await glue.default({
  module_or_path: readFileSync(join(dir, "data_store_spike_bg.wasm")),
});
const rows = Number(process.env.ROWS ?? 1_000_000);
for (const run of [1, 2]) {
  let t = performance.now();
  const n = wasm.spike_bench_ingest(rows);
  const ingest = performance.now() - t;
  t = performance.now();
  const g = wasm.spike_bench_query(0);
  const group = performance.now() - t;
  t = performance.now();
  const all = wasm.spike_bench_query(1);
  const selectAll = performance.now() - t;
  console.log(
    `run ${run}: ${n} rows (CSV generated in the module; ingest includes generating it), ingest ${ingest.toFixed(0)} ms, grouped query ${group.toFixed(0)} ms (${g} rows), SELECT * to RecordSet ${selectAll.toFixed(0)} ms (${all} rows)`,
  );
}
