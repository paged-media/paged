// The REAL store lane (ADR 561): the shipped data-js wasm in Node, its query
// store fed through the bundle's own handle (src/query/store.ts), the rows
// delivered to the binding session inside the engine, and the engine lowering
// them. This is pipeline Part B: the one place the whole CSV → store →
// RecordSet → engine → lowered seam runs for real, with no rows crossing into
// TypeScript.
//
// GATE: skips when the data-js wasm is not built, EXCEPT under
// REQUIRE_REAL_ENGINE=1 (CI builds it first and sets it), where a missing wasm
// is a FAILURE.
import { describe, expect, it } from "bun:test";
import { loadIntoStore } from "../src/query/import";
import { storeHandle, type QueryHandle } from "../src/query/store";
import {
  assertLowered,
  bootEngine,
  defineCatalog,
  partA,
} from "./pipeline-parts.mjs";
import { HAVE_ENGINE, REQUIRE_REAL_ENGINE } from "./real-engine";

const CSV = "sku,price\nB-2,19.99\nA-1,9.99\n";
const csv = (text: string) => new TextEncoder().encode(text);

if (REQUIRE_REAL_ENGINE) {
  describe("real store — REQUIRED (REQUIRE_REAL_ENGINE=1) [data.store.turso]", () => {
    it("the data-js engine is built", () => {
      expect(
        HAVE_ENGINE,
        "bin/data_js_bg.wasm — run scripts/build-wasm.sh",
      ).toBe(true);
    });
  });
}

async function fresh(): Promise<{ e: any; d: QueryHandle }> {
  const e = await bootEngine();
  const d = storeHandle(e);
  if (!d) throw new Error("this engine has no query store");
  return { e, d };
}

describe.skipIf(!HAVE_ENGINE)(
  "real store → data-js engine [data.query.seam] [data.store.turso]",
  () => {
    it("imports a CSV, runs a SELECT into the engine, and lowers it like the hand-built RecordSet", async () => {
      const { e, d } = await fresh();
      defineCatalog(e);
      await loadIntoStore(d, "products", "csv", csv(CSV));
      expect(await d.describe("SELECT sku, price FROM products")).toEqual([
        { name: "sku", type: "TEXT" },
        { name: "price", type: "DECIMAL(18,2)" },
      ]);
      const rows = await d.ingest(
        "q1",
        "SELECT sku, price FROM products ORDER BY sku",
      );
      expect(rows).toBe(2);
      expect(e.query_record_count("q1")).toBe(2);
      const lowered = assertLowered(e.resolve_lowered("t1"), "store");
      // Parity with Part A: the same recipe over a hand-built RecordSet.
      expect(lowered.text).toBe((await partA()).text);
      // The same data again is recognised: the result token does not move.
      const token = e.result_token("q1");
      await d.ingest("q1", "SELECT sku, price FROM products ORDER BY sku");
      expect(e.result_token("q1")).toBe(token);
    });

    it("importing a source again replaces its table", async () => {
      const { d } = await fresh();
      await loadIntoStore(d, "reimported", "csv", csv("name\nApple 14\n"));
      await loadIntoStore(d, "reimported", "csv", csv("name\nAardvark 14\n"));
      const p = await d.preview("SELECT name FROM reimported", 10);
      expect(p.rows).toEqual([["Aardvark 14"]]);
      expect(await d.tables()).toEqual(["reimported"]);
    });

    it("reads a CSV as written for a merge: 9.90, 007 and 01/02/2026 stay text, typed reads are unchanged", async () => {
      const { e, d } = await fresh();
      await loadIntoStore(
        d,
        "prices",
        "csv",
        csv(
          "sku,price,code,date\nA-1,9.90,007,01/02/2026\nB-2,10.00,012,03/04/2026\n",
        ),
      );
      e.define_query({
        id: "w",
        sql: "SELECT * FROM prices",
        params: [],
        shape: { shape: "recordStream" },
      });
      expect(
        await d.ingestAsWritten("w", 'SELECT * FROM "prices"', ["prices"]),
      ).toBe(2);
      // The as-written rows are text, as the file has them.
      const preview = await d.preview(
        "SELECT price, code, date FROM prices",
        10,
      );
      // The typed table is the store's, back under its name: a decimal keeps
      // its scale, a code with leading zeros stays text, the d/m/y text too.
      expect(preview.rows).toEqual([
        ["9.90", "007", "01/02/2026"],
        ["10.00", "012", "03/04/2026"],
      ]);
      // A computation over the as-written text needs a CAST; the store runs it.
      expect(
        await d.ingestAsWritten(
          "w",
          "SELECT sku FROM prices WHERE CAST(price AS REAL) > 10",
          ["prices"],
        ),
      ).toBe(0);
      // A source without a twin (not a CSV) has nothing to read as written.
      await loadIntoStore(d, "j", "json", csv('[{"a":1}]'));
      expect(await d.ingestAsWritten("w", "SELECT * FROM j", ["j"])).toBeNull();
    });

    it("an as-written query that fails leaves every table where it was", async () => {
      const { d } = await fresh();
      await loadIntoStore(d, "broken", "csv", csv("a,b\n1,2\n"));
      expect(() =>
        d.ingestAsWritten("x", "SELECT no_such_column FROM broken", ["broken"]),
      ).toThrow(/no such column/);
      expect(await d.describe("SELECT a FROM broken")).toEqual([
        { name: "a", type: "INTEGER" },
      ]);
      // …and the twin is still there for the next merge.
      expect(
        await d.ingestAsWritten("x", "SELECT a FROM broken", ["broken"]),
      ).toBe(1);
    });

    it("a failure is an Error with the store's kind and offset", async () => {
      const { d } = await fresh();
      let err: unknown;
      try {
        await d.preview("SELECT 1::INT", 1);
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({ kind: "Parser", offset: 8 });
      expect(() => d.importFile("x", "parquet", csv("not parquet"))).toThrow(
        /Parquet file does not read/,
      );
    });
  },
);
