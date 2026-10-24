// Data ADR 563 against the REAL stack: an image binding over an asset column
// places the column's asset — read (a data: reference, no network), run
// through the column's action chain (actions@1, registered by another
// bundle on the harness's shared registry) and placed as a data: URI the
// engine accepts (core ADR 208). A reference with no consent places nothing.
//
// Gate: skips without canvas-wasm or the built data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1.

import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import { importActual } from "@paged-media/test-kit";
import { existsSync } from "node:fs";

import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";
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

const PAINTER: PluginManifest = {
  id: "com.example.painter",
  name: "painter",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { actions: { register: true } },
};

describe.skipIf(!ready && !required)(
  "asset columns over the real stack [data.assets.columns]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of hosts.splice(0)) h.dispose?.();
    });

    it("an image binding over an asset column places the chained asset as a data URI", async () => {
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
      let calls = 0;
      h.loadBundle({
        manifest: PAINTER,
        activate(bh: BundleHost) {
          bh.actions.register({
            id: "com.example.painter/stamp",
            title: "Stamp",
            input: "asset",
            output: "asset",
            run: (input) => {
              calls++;
              return input;
            },
          });
          return { dispose() {} };
        },
      } as never);
      let dataHost!: BundleHost;
      h.loadBundle({
        ...mod.dataBundle,
        activate: (bh: BundleHost) => {
          dataHost = bh;
          return mod.dataBundle.activate(bh);
        },
      } as typeof mod.dataBundle);
      const s = mod.sessionFor(dataHost)!;
      await s.whenRestored();
      await s.registerCsvSource(
        "products",
        `sku,photo,remote\nA-1,"data:image/png;base64,${PNG_B64}",https://unconsented.example/a.png\n`,
      );
      s.addQuery("q", "SELECT * FROM products", "recordStream");
      await s.refreshData();
      s.setAssetColumn("q", "photo", {
        chain: [{ action: "com.example.painter/stamp" }],
      });
      s.setAssetColumn("q", "remote", {});
      s.addImageBinding("img", "urect", "q", "photo");
      s.addImageBinding("img2", "urect", "q", "remote");
      const mutate = vi.spyOn(dataHost.document, "mutate");
      const logs: string[] = [];
      for (const k of ["info", "warn"] as const)
        vi.spyOn(dataHost.log, k).mockImplementation(
          (m: unknown) => void logs.push(String(m)),
        );
      await s.lowerBinding("img");
      const placed = mutate.mock.calls
        .map(([m]) => m as { op: string; args?: { uri?: string } })
        .find((m) => m.op === "placeImage");
      expect(
        placed?.args?.uri?.startsWith("data:image/png;base64,"),
        logs.join("\n"),
      ).toBe(true);
      expect(calls).toBe(1);
      expect(s.assetColumns()).toMatchObject({
        "q.photo": { chain: [{ action: "com.example.painter/stamp" }] },
      });

      mutate.mockClear();
      await s.lowerBinding("img2");
      expect(
        mutate.mock.calls.some(
          ([m]) => (m as { op: string }).op === "placeImage",
        ),
      ).toBe(false);
    });
  },
);
