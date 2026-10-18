// Boot the SHIPPED DuckDB engine (bin/duckdb-engine.wasm) under Node through
// DuckDB's Node blocking build, wrapped in the bundle's own duckdbHandle. The
// same steps as test/duckdb-real.spec.ts, shared here for the oracle lanes.
// Never throws: returns the reason DuckDB could not boot.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DUCKDB_ARTIFACTS,
  duckdbHandle,
  type DuckDBHandle,
} from "../src/query/duckdb";
import { nodeBootSql } from "./duckdb-node-ext";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = join(HERE, "..");
export const BIN = join(PKG, "bin");
export const ENGINE_WASM = join(BIN, DUCKDB_ARTIFACTS.module);
export const NODE_API = join(
  PKG,
  "..",
  "..",
  "vendor",
  "duckdb-wasm",
  "dist",
  "duckdb-node-blocking.cjs",
);

// The vendored CJS requires apache-arrow, which resolves from modules/data's own
// node_modules (a devDependency there for this). It used to come from this
// package's node_modules through a NODE_PATH rewrite, which only Node honours.
function requireNodeDuckDB(): any {
  return createRequire(import.meta.url)(NODE_API);
}

export interface NodeDuckDB {
  handle: DuckDBHandle;
  /** The raw connection, for reading Arrow tables the handle does not expose
   *  (DESCRIBE, version()). */
  raw(sql: string): Array<Record<string, unknown>>;
}

export async function tryBootNodeDuckDB(): Promise<{
  duck?: NodeDuckDB;
  error?: string;
}> {
  if (!existsSync(ENGINE_WASM))
    return {
      error: `${ENGINE_WASM} is missing — run \`bash scripts/vendor-duckdb.sh\``,
    };
  if (!existsSync(NODE_API))
    return {
      error: `${NODE_API} is missing — run \`bash scripts/vendor-duckdb.sh\``,
    };
  try {
    const duckdb = requireNodeDuckDB();
    const db = await duckdb.createDuckDB(
      {
        mvp: {
          mainModule: join(BIN, "duckdb-mvp.NOT-SHIPPED.wasm"),
          mainWorker: "",
        },
        eh: { mainModule: ENGINE_WASM, mainWorker: "" },
      },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    );
    await db.instantiate();
    const conn = db.connect();
    for (const s of nodeBootSql()) conn.query(s); // as bootDuckDB does
    return {
      duck: {
        handle: duckdbHandle(db, conn, () => db.reset?.()),
        raw: (sql) =>
          conn
            .query(sql)
            .toArray()
            .map((r: { toJSON(): Record<string, unknown> }) => r.toJSON()),
      },
    };
  } catch (err) {
    return {
      error: `DuckDB failed to boot: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
