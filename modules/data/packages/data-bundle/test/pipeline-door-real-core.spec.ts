// The data door's pipeline (data ADR 562, editor ADR 291's pipeline view)
// against the REAL stack: real core (canvas-wasm in the headless host) and
// the real data-js engine with its store. A consumer reads the steps in
// refresh order (sources, transforms, queries) with what each reads and its
// rows at the last run, defines a transform (it runs at once), has a bad one
// refused with the reason, sees a failing one's error, and removes it; each
// define and remove is announced as a change.
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

const CSV = "sku,price,stock\nA-1,9.50,3\nB-2,12.00,0\nC-3,4.00,8\n";
const JOINED =
  "WITH x AS (SELECT * FROM lowStock) SELECT x.sku, p.price FROM x JOIN products p ON p.sku = x.sku";
const FILE_READ = "SELECT * FROM read_csv('/etc/passwd')";

const CONSUMER: PluginManifest = {
  id: "com.example.pipeline",
  name: "pipeline consumer",
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
  "the data door's pipeline over the real stack [data.transforms]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of hosts.splice(0)) h.dispose?.();
    });

    it("lists the steps in refresh order, defines, refuses and removes transforms", async () => {
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
      const data = consumer.data;
      const changes: DataChange[] = [];
      data.onDidChange((c) => changes.push(c));

      await s.registerCsvSource("products", CSV);
      // Defined through the door: it runs at once and is announced.
      await data.defineTransform({
        id: "lowStock",
        inputs: ["products"],
        source: "(t, p) => t.products.filter((r) => r.stock < p.below)",
        params: { below: 5 },
      });
      expect(changes.map((c) => c.table)).toContain("lowStock");
      s.addQuery("q", JOINED, "recordStream");
      s.addQuery("refused", FILE_READ, "recordStream");
      await s.refreshData();

      expect(await data.pipeline()).toEqual([
        { id: "products", kind: "source", inputs: [], rowCount: 3 },
        {
          id: "lowStock",
          kind: "transform",
          inputs: ["products"],
          source: "(t, p) => t.products.filter((r) => r.stock < p.below)",
          params: { below: 5 },
          rowCount: 2,
        },
        {
          id: "q",
          kind: "query",
          inputs: ["lowStock", "products"],
          sql: JOINED,
          rowCount: 2,
        },
        {
          id: "refused",
          kind: "query",
          inputs: [],
          sql: FILE_READ,
          error: expect.stringMatching(/reads files or URLs/),
        },
      ]);
      // A step's id is a table of the door: the panel previews its rows.
      const low = await data.records("lowStock");
      const sku = low.schema.fields.findIndex((f) => f.name === "sku");
      expect(low.columns[sku]).toEqual(["A-1", "B-2"]);

      // Refused with the session's reason.
      await expect(
        data.defineTransform({
          id: "bad",
          inputs: ["nope"],
          source: "(t) => []",
        }),
      ).rejects.toThrow(/no table "nope"/);
      await expect(
        data.defineTransform({
          id: "products",
          inputs: [],
          source: "() => []",
        }),
      ).rejects.toThrow(/is a source table/);
      await expect(
        data.defineTransform({ id: "1x", inputs: [], source: "() => []" }),
      ).rejects.toThrow(/not a table name/);
      await expect(
        data.defineTransform({ id: "empty", inputs: [], source: "  " }),
      ).rejects.toThrow(/has a source/);
      expect((await data.pipeline()).map((p) => p.id)).not.toContain("bad");

      // One that does not run says why in its step.
      await data.defineTransform({
        id: "broken",
        inputs: ["products"],
        source: "(t) => 42",
      });
      const broken = (await data.pipeline()).find((p) => p.id === "broken");
      expect(broken?.kind).toBe("transform");
      expect(broken?.error).toBeTruthy();
      expect(broken?.rowCount).toBeUndefined();

      // Redefining keeps its place; removing announces the change.
      await data.defineTransform({
        id: "lowStock",
        inputs: ["products"],
        source: "(t) => t.products.filter((r) => r.stock === 0)",
      });
      const steps = await data.pipeline();
      expect(steps.map((p) => p.id)).toEqual([
        "products",
        "lowStock",
        "broken",
        "q",
        "refused",
      ]);
      expect(steps[1]).toMatchObject({ rowCount: 1 });
      expect(steps[1]!.params).toBeUndefined();
      const before = changes.length;
      expect(await data.removeTransform("broken")).toBe(true);
      expect(changes.slice(before).map((c) => c.table)).toEqual(["broken"]);
      expect(await data.removeTransform("broken")).toBe(false);
      expect((await data.pipeline()).map((p) => p.id)).not.toContain("broken");
    });
  },
);
