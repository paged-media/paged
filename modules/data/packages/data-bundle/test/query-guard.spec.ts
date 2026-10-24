// The query guard's security matrix in the Node lane, over the real query
// store (the shipped data-js wasm). The browser lane (test/store-browser.spec.ts)
// proves the same matrix in headless Chromium; both lanes import the matrix
// from test/guard-matrix.ts.
import { beforeAll, describe, expect, it } from "bun:test";
import { loadIntoStore } from "../src/query/import";
import { checkQuery } from "../src/query/sql";
import { storeHandle, type QueryHandle } from "../src/query/store";
import { ALLOWED, FIXTURE_CSV, REFUSED } from "./guard-matrix";
import {
  bootRealEngine,
  HAVE_ENGINE,
  REQUIRE_REAL_ENGINE,
} from "./real-engine";

describe.skipIf(!HAVE_ENGINE && !REQUIRE_REAL_ENGINE)(
  "the query guard over the real query store in Node [data.security.gates]",
  () => {
    let d: QueryHandle;
    beforeAll(async () => {
      expect(HAVE_ENGINE, "the data-js wasm must be built").toBe(true);
      d = storeHandle(await bootRealEngine(0))!;
      for (const [name, text] of Object.entries(FIXTURE_CSV))
        await loadIntoStore(d, name, "csv", new TextEncoder().encode(text));
    });

    it("refuses every reach outside the source tables", () => {
      for (const [sql, why] of REFUSED) {
        const v = checkQuery(sql);
        expect(v?.kind, sql).toBe("Guard");
        expect(v?.message, sql).toMatch(why);
      }
    });

    it("admits ordinary queries — joins, CTEs, aggregates — and the store runs them", async () => {
      for (const [sql, rows] of ALLOWED) {
        expect(checkQuery(sql), sql).toBeNull();
        expect((await d.preview(sql, 100)).rows, sql).toEqual(rows);
      }
    });

    it("the query connection refuses writes, and imports still work after it", async () => {
      // The store's own refusal, under the guard: user SQL runs on a
      // `query_only` connection.
      for (const sql of [
        "INSERT INTO people VALUES ('Eve', 'Spy')",
        "DELETE FROM orders",
        "DROP TABLE people",
        "CREATE TABLE x (a)",
      ]) {
        expect(() => d.preview(sql, 1), sql).toThrow();
      }
      await loadIntoStore(
        d,
        "late",
        "csv",
        new TextEncoder().encode("a,b\n1,2\n"),
      );
      expect((await d.preview("SELECT * FROM late", 10)).rows).toEqual([
        ["1", "2"],
      ]);
      expect((await d.preview("SELECT count(*) FROM people", 1)).rows).toEqual([
        ["2"],
      ]);
    });
  },
);
