// Shared boot for specs that need REAL DuckDB in Node: DuckDB's Node blocking
// build (vendor/duckdb-wasm/dist/duckdb-node-blocking.cjs, never shipped)
// driving the SHIPPED engine (bin/duckdb-engine.wasm), wrapped by the bundle's
// own handle code (duckdbHandle). The same lane duckdb-real.spec.ts proves;
// this file only makes it reusable. Never throws — returns why not.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DUCKDB_ARTIFACTS, duckdbHandle, type DuckDBHandle } from "../src/query/duckdb";
import { nodeBootSql } from "./duckdb-node-ext";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
export const BIN = join(PKG, "bin");
const ENGINE_WASM = join(BIN, DUCKDB_ARTIFACTS.module);
const NODE_API = join(PKG, "..", "..", "vendor", "duckdb-wasm", "dist", "duckdb-node-blocking.cjs");
export const DATA_JS_WASM = join(BIN, "data_js_bg.wasm");
export const REQUIRE_REAL_DUCKDB = process.env.REQUIRE_REAL_DUCKDB === "1";

// The vendored CJS requires apache-arrow, which resolves from modules/data's own
// node_modules (a devDependency there for this). It used to come from this
// package's node_modules through a NODE_PATH rewrite, which only Node honours.
function requireNodeDuckDB(): any {
  return createRequire(import.meta.url)(NODE_API);
}

/** Boot one real DuckDB over the shipped EH engine. */
export async function bootRealDuckDB(): Promise<{ handle?: DuckDBHandle; error?: string }> {
  if (!existsSync(ENGINE_WASM))
    return { error: `${ENGINE_WASM} is missing — run scripts/vendor-duckdb.sh` };
  if (!existsSync(NODE_API))
    return { error: `${NODE_API} is missing — run scripts/vendor-duckdb.sh` };
  try {
    const duckdb = requireNodeDuckDB();
    const db = await duckdb.createDuckDB(
      {
        mvp: { mainModule: join(BIN, "duckdb-mvp.NOT-SHIPPED.wasm"), mainWorker: "" },
        eh: { mainModule: ENGINE_WASM, mainWorker: "" },
      },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    );
    await db.instantiate();
    const conn = db.connect();
    for (const s of nodeBootSql()) conn.query(s); // as bootDuckDB does
    return { handle: duckdbHandle(db, conn, () => db.reset?.()) };
  } catch (err) {
    return { error: `DuckDB failed to boot: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Boot the REAL data-js engine in Node (the bundle's glue fetches the wasm by
 *  URL, which Node cannot; hand it the bytes instead). */
export async function bootRealEngine(today: number): Promise<any> {
  const mod = await import(join(BIN, "data_js.js"));
  await mod.default({ module_or_path: readFileSync(DATA_JS_WASM) });
  return new mod.DataEngine(today);
}
