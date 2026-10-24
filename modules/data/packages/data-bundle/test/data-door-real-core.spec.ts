// The data door (`data@1`, extensions ADR 343) against the REAL stack: real
// core (canvas-wasm in the headless host) and the real data-js engine with
// its store. paged.data serves; a second bundle (a sheet-like consumer,
// sharing the harness's data backend) reads the tables and their typed
// records, writes rows into a source table and hears the change, has a
// file-reading query refused by the guard, and binds a frame property.
//
// Gate: skips without canvas-wasm or the built data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { importActual } from "@paged-media/test-kit";
import { existsSync } from "node:fs";

import type {
  BundleHost,
  DataChange,
  PluginManifest,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import {
  bootRealEngine,
  DATA_JS_WASM,
  REQUIRE_REAL_ENGINE,
} from "./real-engine";

const actualEngine = await importActual(() => import("../src/engine"));

const ready = ENGINE_ANCHOR !== null && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_ENGINE;

const CSV = "sku,price,stock\nA-1,9.50,3\nB-2,12.00,0\n";

const CONSUMER: PluginManifest = {
  id: "com.example.sheetlike",
  name: "sheet-like consumer",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { data: { read: true, write: true, bind: true } },
};

async function loadBundleModule() {
  mock.module("../src/engine", () => ({
    ...actualEngine,
    bootEngine: (today: number) => bootRealEngine(today),
  }));
  return import("../src/index");
}

describe.skipIf(!ready && !required)(
  "the data door over the real stack [plugin-platform.data-door]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of hosts.splice(0)) h.dispose?.();
    });

    it("paged.data serves; another bundle reads, writes, is refused and binds", async () => {
      expect(
        ready,
        "real core and the data-js wasm must both be available",
      ).toBe(true);
      const mod = await loadBundleModule();
      const h = await openRealHost();
      hosts.push(h);
      let dataHost!: BundleHost;
      h.loadBundle({
        ...mod.dataBundle,
        activate: (bh: BundleHost) => {
          dataHost = bh;
          return mod.dataBundle.activate(bh);
        },
      } as typeof mod.dataBundle);
      let consumer!: BundleHost;
      h.loadBundle({
        manifest: CONSUMER,
        activate(bh: BundleHost) {
          consumer = bh;
          return { dispose() {} };
        },
      } as never);
      const s = mod.sessionFor(dataHost)!;
      await s.whenRestored();
      expect(consumer.supports("data@1")).toBe(true);
      expect(consumer.data.available()).toBe(true);

      const changes: DataChange[] = [];
      consumer.data.onDidChange((c) => changes.push(c));
      await s.registerCsvSource("products", CSV);
      s.addQuery(
        "q",
        "SELECT sku, price * stock AS value FROM products ORDER BY sku",
        "recordStream",
      );
      await s.refreshData();
      expect(changes.map((c) => c.table)).toEqual(["products", "q"]);

      const tables = await consumer.data.tables();
      expect(
        tables.map((t) => [t.name, t.kind, t.rowCount, t.writable]),
      ).toEqual([
        ["products", "source", 2, true],
        ["q", "query", 2, false],
      ]);
      const products = await consumer.data.records("products");
      expect(products.schema.fields.map((f) => [f.name, f.ty])).toEqual([
        ["sku", "text"],
        ["price", "float"],
        ["stock", "int"],
      ]);
      expect(products.columns).toEqual([
        ["A-1", "B-2"],
        [9.5, 12],
        [3, 0],
      ]);

      const w = await consumer.data.write("products", [
        { op: "set", row: 1, field: "stock", value: 5 },
        { op: "insert", values: { sku: "C-3", price: 1.25, stock: 4 } },
      ]);
      expect(w.rowCount).toBe(3);
      expect(changes.at(-1)).toEqual({
        table: "products",
        revision: w.revision,
      });
      expect((await consumer.data.records("q")).columns).toEqual([
        ["A-1", "B-2", "C-3"],
        [28.5, 60, 5],
      ]);
      await expect(consumer.data.write("q", [])).rejects.toThrow(/is derived/);
      await expect(
        consumer.data.query("SELECT * FROM read_csv('/etc/passwd')"),
      ).rejects.toThrow(/read_csv\(\) reads files or URLs/);
      expect(
        (await consumer.data.query("SELECT count(*) AS n FROM products"))
          .columns,
      ).toEqual([[3]]);

      // Editor ADR 292: the bind popover's compiled rules and maps
      // (apps/editor shell bind-expr.ts) evaluate in the engine, over the
      // query's refreshed rows (a write reaches bindings at the refresh).
      await s.refreshData();
      const rule =
        'IF(value > 50, 14, IF(IFERROR(FIND("A", sku), 0) > 0, 12, 10))';
      const at = async (expr: string, r: number) =>
        (await consumer.data.evaluate("q", expr, r)).value;
      expect([await at(rule, 0), await at(rule, 1), await at(rule, 2)]).toEqual(
        [12, 14, 10],
      );
      const map = 'SWITCH(sku, "A-1", "Red", "B-2", "Blue", "Black")';
      expect([await at(map, 0), await at(map, 2)]).toEqual(["Red", "Black"]);
      expect(
        (await consumer.data.evaluate("q", "nope +", 0)).error,
      ).toBeTruthy();

      const b = await consumer.data.bind({
        target: "rectangle:urect",
        path: "frameOpacity",
        query: "q",
        expr: "50",
      });
      expect(
        (await consumer.data.bindings()).map((x) => [x.id, x.path]),
      ).toEqual([[b.id, "frameOpacity"]]);
      // Editor ADR 291's colour cues and Update document.
      const st = (await consumer.data.status()).find((x) => x.id === b.id);
      expect(st).toMatchObject({ kind: "property", query: "q", fields: [] });
      expect(["linked", "unresolved", "stale"]).toContain(st!.status);
      await consumer.data.refresh();
      expect(
        (await consumer.data.status()).find((x) => x.id === b.id)?.status,
      ).toBe("linked");
      await consumer.data.unbind(b.id);
      expect(await consumer.data.bindings()).toEqual([]);

      // Data ADR 562: a transform's derived table is a read-only table of the
      // door, refreshed before the queries.
      expect(
        await s.defineTransform({
          id: "lowStock",
          inputs: ["products"],
          source: "(t, p) => t.products.filter((r) => r.stock < p.below)",
          params: { below: 5 },
        }),
      ).toBeNull();
      await s.refreshData();
      const low = (await consumer.data.tables()).find(
        (t) => t.name === "lowStock",
      );
      expect(low).toMatchObject({
        kind: "query",
        rowCount: 2,
        writable: false,
      });
      await expect(consumer.data.write("lowStock", [])).rejects.toThrow(
        /is derived/,
      );
    });
  },
);
