// Data ADR 563 through the data door (`data@1`, extensions ADR 343) against
// the REAL stack: another bundle (the editor's Data panel reads the same
// shared backend, editor ADR 291) declares a query's field an asset column
// with a chain, lists it, hears the query change, has an unknown query, an
// unknown field and a malformed chain refused, and clears it. The column it
// declared is the session's own: an image binding over it places the
// chained asset.
//
// Gate: skips without canvas-wasm or the built data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1.

import { afterEach, describe, expect, it, mock, vi } from "bun:test";
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

// A 1×1 PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PANEL: PluginManifest = {
  id: "com.example.panel",
  name: "data panel",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: {
    data: { read: true, write: true },
    actions: { register: true },
  },
};

describe.skipIf(!ready && !required)(
  "asset columns through the data door [data.assets.columns]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of hosts.splice(0)) h.dispose?.();
    });

    it("declares, lists, refuses and clears an asset column; the binding places the chained asset", async () => {
      expect(
        ready,
        "real core and the data-js wasm must both be available",
      ).toBe(true);
      mock.module("../src/engine", () => ({
        ...actualEngine,
        bootEngine: (today: number) => bootRealEngine(today),
      }));
      const mod = await import("../src/index");
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
      let panel!: BundleHost;
      let calls = 0;
      h.loadBundle({
        manifest: PANEL,
        activate(bh: BundleHost) {
          panel = bh;
          bh.actions.register({
            id: "com.example.panel/stamp",
            title: "Stamp",
            input: "asset",
            output: "asset",
            params: { strength: 1 },
            run: (input) => {
              calls++;
              return input;
            },
          });
          return { dispose() {} };
        },
      } as never);
      const s = mod.sessionFor(dataHost)!;
      await s.whenRestored();
      await s.registerCsvSource(
        "products",
        `sku,photo\nA-1,"data:image/png;base64,${PNG_B64}"\n`,
      );
      s.addQuery("q", "SELECT * FROM products", "recordStream");
      await s.refreshData();

      const changes: DataChange[] = [];
      panel.data.onDidChange((c) => changes.push(c));
      expect(await panel.data.assetColumns()).toEqual([]);
      await panel.data.setAssetColumn("q", "photo", {
        chain: [{ action: "com.example.panel/stamp", params: { strength: 2 } }],
        base: " https://media.example/ ",
      });
      expect(changes.map((c) => c.table)).toEqual(["q"]);
      expect(await panel.data.assetColumns()).toEqual([
        {
          query: "q",
          field: "photo",
          chain: [
            { action: "com.example.panel/stamp", params: { strength: 2 } },
          ],
          base: "https://media.example/",
        },
      ]);
      // The session keeps it (and saves it with the session part).
      expect(s.assetColumns()["q.photo"]?.base).toBe("https://media.example/");

      await expect(
        panel.data.setAssetColumn("nope", "photo", {}),
      ).rejects.toThrow(/no query "nope"/);
      await expect(panel.data.setAssetColumn("q", "logo", {})).rejects.toThrow(
        /has no field "logo"/,
      );
      await expect(
        panel.data.setAssetColumn("q", "sku", {
          chain: [{ action: "" }],
        }),
      ).rejects.toThrow(/names no action/);
      expect((await panel.data.assetColumns()).length).toBe(1);

      // The declared column is the one an image binding reads.
      s.addImageBinding("img", "urect", "q", "photo");
      const mutate = vi.spyOn(dataHost.document, "mutate");
      await s.lowerBinding("img");
      const placed = mutate.mock.calls
        .map(([m]) => m as { op: string; args?: { uri?: string } })
        .find((m) => m.op === "placeImage");
      expect(placed?.args?.uri?.startsWith("data:image/png;base64,")).toBe(
        true,
      );
      expect(calls).toBe(1);

      await panel.data.setAssetColumn("q", "photo", null);
      expect(await panel.data.assetColumns()).toEqual([]);
      expect(changes.map((c) => c.table)).toEqual(["q", "q"]);
    });
  },
);
