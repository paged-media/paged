// Editor ADR 291's per-record status over the REAL stack: real core and the
// real data-js engine. A property is bound (it shows the first record) and a
// page item carries a merged record's label; Update document
// writes the document from the data. Then a source row changes, one is
// added and the placed first one is deleted, and the data is read again:
// the door reports which records are new and changed, how many placed ones
// are gone, which are placed, and each placement's record follows its
// record to its row now.
//
// Gate: skips without canvas-wasm or the built data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { importActual } from "@paged-media/test-kit";
import { existsSync } from "node:fs";

import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { BINDING_KEY, makeEnvelope } from "../../data-host-model/src";
import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import {
  bootRealEngine,
  DATA_JS_WASM,
  REQUIRE_REAL_ENGINE,
} from "./real-engine";

const actualEngine = await importActual(() => import("../src/engine"));

const ready = ENGINE_ANCHOR !== null && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_ENGINE;

const CSV = "sku,name,price\nA-1,Hammer,9.5\nB-2,Saw,12\nC-3,Rake,7\n";

const READER: PluginManifest = {
  id: "com.example.records",
  name: "record reader",
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
  "per-record status over the real stack [data.bind.record-status]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of hosts.splice(0)) h.dispose?.();
    });

    it("new, changed, removed and placed records; placements name their record", async () => {
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
      let reader!: BundleHost;
      h.loadBundle({
        manifest: READER,
        activate(bh: BundleHost) {
          reader = bh;
          return { dispose() {} };
        },
      } as never);
      const s = mod.sessionFor(dataHost)!;
      await s.whenRestored();
      await s.registerCsvSource("products", CSV);
      s.addQuery("q", "SELECT * FROM products", "recordStream");
      await s.refreshData();
      const data = reader.data;

      // Before anything is written from the data: no status to report.
      expect(await data.recordStatus("q")).toEqual({
        query: "q",
        added: [],
        changed: [],
        removed: 0,
        placed: [],
      });

      const fr = (await dataHost.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "insertTextFrame",
              args: { pageId: "usp", bounds: [100, 100, 300, 400] },
            },
            { op: "bindCreated", args: { handle: "f" } },
          ],
        },
      } as never)) as { minted?: { element: { id: string } }[] };
      const frame = fr.minted![0]!.element.id;
      // A property binding shows the first record on the rectangle.
      const bound = await data.bind({
        target: "rectangle:urect",
        path: "frameOpacity",
        query: "q",
        expr: "50",
      });
      // The text frame shows merged record 1 (B-2), as a Data Merge labels it.
      await dataHost.document.mutate({
        op: "setPluginMetadata",
        args: {
          elementId: { kind: "textFrame", id: frame },
          key: BINDING_KEY,
          value: makeEnvelope({
            kind: "merge",
            merge: "merge-q",
            query: "q",
            record: 1,
            frame: 0,
          }),
        },
      } as never);
      await data.refresh();

      expect(await data.recordStatus("q")).toEqual({
        query: "q",
        added: [],
        changed: [],
        removed: 0,
        placed: [0, 1],
      });
      const records = async () =>
        (await data.placements())
          .filter((p) => p.record !== undefined)
          .map((p) => [p.binding, p.address, p.record])
          .sort();
      expect(await records()).toEqual([
        [bound.id, "rectangle:urect", 0],
        ["merge-q", `textFrame:${frame}`, 1],
      ]);

      // B-2 costs more, D-4 is new, A-1 (the placed first record) is gone.
      await data.write("products", [
        { op: "set", row: 1, field: "price", value: 13 },
        { op: "insert", values: { sku: "D-4", name: "Spade", price: 20 } },
        { op: "delete", row: 0 },
      ]);
      await s.refreshData();
      expect(await data.recordStatus("q")).toEqual({
        query: "q",
        added: [2],
        changed: [0],
        removed: 1,
        placed: [0],
      });
      // The merged B-2 is row 0 now; the binding's first record is gone.
      expect(await records()).toEqual([["merge-q", `textFrame:${frame}`, 0]]);

      // The grid reads a query as a table, its records numbered.
      const grid = await data.query(
        'SELECT * FROM (SELECT row_number() OVER () - 1 AS "__record", * FROM "q") ORDER BY "price" DESC',
      );
      expect(grid.columns[0]).toEqual([2, 0, 1]);
      expect(grid.columns[1]).toEqual(["D-4", "B-2", "C-3"]);
      await expect(data.recordStatus("nope")).rejects.toThrow(
        /no query "nope"/,
      );
    });
  },
);
