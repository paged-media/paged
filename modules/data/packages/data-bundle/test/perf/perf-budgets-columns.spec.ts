// PERF BUDGETS — how a result reaches the engine. Same rules as
// perf-budgets-commands.spec.ts: counts are pinned as measured, lowered only
// in the commit that earns them, a behaviour assertion beside each.
//
// C1 — the typed column door: a host that materialises 500 rows of its own
// hands them over as typed buffers (one push per column), and the same
// result re-delivered is recognised before anything is decoded.
// C2 — the query store (ADR 561): the same 500 rows go from the store to the
// binding session inside the engine, in one wasm call.

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import { ingestColumnBatch } from "../../src/engine";
import type { ColumnBatch } from "../../src/query/recordset";
import {
  BUDGET_TIMEOUT_MS,
  bootCountedEngine,
  bootCountedStore,
  printTable,
  productCsv,
  RUN_BUDGETS,
} from "./harness";

setDefaultTimeout(BUDGET_TIMEOUT_MS);

const SQL = "SELECT sku, name, price FROM products_c";

/** The CSV's rows as the column door's typed buffers. */
function batchOf(csv: string): ColumnBatch {
  const rows = csv
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","));
  const utf8 = (col: number) => {
    const parts = rows.map((r) => new TextEncoder().encode(r[col]!));
    const offsets = new Int32Array(rows.length + 1);
    parts.forEach((p, i) => (offsets[i + 1] = offsets[i]! + p.length));
    const bytes = new Uint8Array(offsets[rows.length]!);
    parts.forEach((p, i) => bytes.set(p, offsets[i]!));
    return { kind: "utf8" as const, bytes, offsets, valid: null };
  };
  return {
    schema: {
      fields: [
        { name: "sku", ty: "text", nullable: true },
        { name: "name", ty: "text", nullable: true },
        { name: "price", ty: "float", nullable: true, scale: 2 },
      ],
    },
    row_count: rows.length,
    columns: [
      utf8(0),
      utf8(1),
      {
        kind: "f64",
        values: Float64Array.from(rows, (r) => Number(r[2])),
        valid: null,
      },
    ],
  };
}

function defineQuery(e: { define_query(q: unknown): void }) {
  e.define_query({
    id: "q",
    sql: SQL,
    params: [],
    shape: { shape: "recordStream" },
  });
}

describe.skipIf(!RUN_BUDGETS)(
  "perf budgets — results into the engine [data.perf.gates]",
  () => {
    afterAll(() => printTable());

    it("C1 ingests a 500-row result as 3 typed columns, then skips an unchanged re-delivery [data.perf.gates]", async () => {
      const batch = batchOf(productCsv(500));
      const engine = await bootCountedEngine();
      defineQuery(engine.engine);

      engine.reset();
      const first = ingestColumnBatch(engine.engine, "q", batch);
      const c1 = engine.counters();
      const calls1 = { ...engine.log.calls };

      engine.reset();
      const again = ingestColumnBatch(engine.engine, "q", batchOf(productCsv(500)));
      const c2 = engine.counters();
      const calls2 = { ...engine.log.calls };

      expect(first).toBe("changed");
      expect(again).toBe("unchanged");
      // First delivery: 5 wasm calls (begin + 3 pushes + finish), 1 500 cells
      // decoded in the engine, 0 per-cell JS objects.
      expect(calls1).toEqual({
        begin_columns: 1,
        push_utf8: 2,
        push_f64: 1,
        finish_columns: 1,
      });
      expect(c1.ingest_cells).toBe(1500);
      expect(engine.log.cellsIn).toBe(0);
      // Re-delivery of unchanged data: the same 5 calls, NOTHING decoded or
      // ingested, the engine's content hash not even recomputed.
      expect(calls2).toEqual(calls1);
      expect(c2.ingest_cells).toBe(0);
      expect(c2.content_hashes).toBe(0);
    });

    it("C2 the store hands a 500-row result to the engine in one call, and an unchanged one changes nothing [data.perf.gates] [data.store.turso]", async () => {
      const engine = await bootCountedEngine();
      const store = bootCountedStore(engine);
      defineQuery(engine.engine);
      await store.handle.importCsv("products_c", productCsv(500));

      engine.reset();
      store.reset();
      expect(await store.handle.ingest("q", SQL)).toBe(500);
      const c1 = engine.counters();
      // Read through the raw engine: the counted one is for the store's calls.
      const token = engine.raw.result_token!("q");

      engine.reset();
      await store.handle.ingest("q", SQL);
      const c2 = engine.counters();

      // Behaviour: the store delivers the SAME data the column door does.
      const reference = await bootCountedEngine();
      defineQuery(reference.engine);
      ingestColumnBatch(reference.engine, "q", batchOf(productCsv(500)));
      expect(token).toBe(reference.engine.result_token!("q"));
      expect(engine.raw.result_token!("q")).toBe(token);

      // One statement each time, no wasm call through the counted engine
      // (the store reads the raw one), no per-cell JS object.
      expect(store.log.queries).toBe(2);
      expect(store.log.rowsOut).toBe(1000);
      expect(engine.total()).toBe(0);
      expect(engine.log.cellsIn).toBe(0);
      // First delivery: 1 500 cells into the engine, one content hash.
      expect(c1.ingest_cells).toBe(1500);
      // Re-delivery: the cells are counted as they arrive, and the content
      // hash recognises them: the result token does not move.
      expect(c2.ingest_cells).toBe(1500);
    });
  },
);
