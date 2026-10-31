// Data ADR 563 against the REAL stack: an image binding over an asset column
// places the column's asset — read (a data: reference, no network), run
// through the column's action chain (actions@1, registered by another
// bundle on the harness's shared registry) and placed as a data: URI the
// engine accepts (core ADR 208). A reference with no consent places nothing.
// A save writes the fetched asset into the `.paged` (ADR 563 amended
// 2026-10-28), and the document reopened by another host places it from
// that part, with no consent and no network.
//
// Gate: skips without canvas-wasm or the built data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1.

import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import { importActual } from "@paged-media/test-kit";
import { existsSync } from "node:fs";

import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { ASSET_INDEX_PART, decodeAssetIndex } from "../src/persist";
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

    it("a save carries a fetched asset in the .paged; reopened elsewhere it is placed from its part, not fetched", async () => {
      expect(
        ready,
        "real core and the data-js wasm must both be available",
      ).toBe(true);
      mock.module("../src/engine", () => ({
        ...actualEngine,
        bootEngine: (today: number) => bootRealEngine(today),
      }));
      const mod = await import("../src/index");
      const png = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
      const URL_A = "https://img.example/a.png";
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((async () => new Response(png)) as never);
      try {
        const bind = async (h: HeadlessHost, consented: string[]) => {
          let bh!: BundleHost;
          h.loadBundle({
            ...mod.dataBundle,
            activate: (b: BundleHost) => {
              bh = b;
              return mod.dataBundle.activate(b);
            },
          } as typeof mod.dataBundle);
          vi.spyOn(bh.network, "consentedOrigins").mockReturnValue(consented);
          const s = mod.sessionFor(bh)!;
          await s.whenRestored();
          return { bh, s };
        };
        const placedUri = (calls: readonly (readonly unknown[])[]) =>
          calls
            .map(([m]) => m as { op: string; args?: { uri?: string } })
            .find((m) => m.op === "placeImage")?.args?.uri;

        // ── one host: fetch (consented), place, save ──────────────────────
        const h1 = await openRealHost();
        hosts.push(h1);
        const one = await bind(h1, ["https://img.example"]);
        await one.s.registerCsvSource(
          "products",
          `sku,photo\nA-1,${URL_A}\nA-2,${URL_A}\n`,
        );
        one.s.addQuery("q", "SELECT * FROM products", "recordStream");
        await one.s.refreshData();
        one.s.setAssetColumn("q", "photo", {});
        one.s.addImageBinding("img", "urect", "q", "photo");
        await one.s.lowerBinding("img");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await h1.willSave.fire();
        const index = decodeAssetIndex(
          await one.bh.parts.read(ASSET_INDEX_PART),
        );
        const hash = index?.refs[URL_A]?.hash;
        expect(index?.refs).toEqual({
          [URL_A]: { hash: hash!, columns: ["q.photo"] },
        });
        expect(index?.assets[hash!]).toEqual({
          mediaType: "image/png",
          bytes: png.length,
        });
        expect(await one.bh.parts.list("assets/")).toEqual([`assets/${hash}`]);
        const saved = await exportPaged(one.bh);

        // ── another host: no consent, no network ──────────────────────────
        fetchSpy.mockClear();
        const h2 = await openRealHost();
        hosts.push(h2);
        await h2.load(saved);
        const two = await bind(h2, []);
        await two.s.refreshData();
        const reads = vi.spyOn(two.bh.parts, "read");
        const mutate = vi.spyOn(two.bh.document, "mutate");
        await two.s.lowerBinding("img");
        expect(
          placedUri(mutate.mock.calls)?.startsWith("data:image/png;base64,"),
        ).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(reads.mock.calls.map(([p]) => p)).toContain(`assets/${hash}`);

        // A save with the column gone drops the parts and the index.
        two.s.setAssetColumn("q", "photo", null);
        await h2.willSave.fire();
        expect(await two.bh.parts.list("assets/")).toEqual([]);
        expect(await two.bh.parts.read(ASSET_INDEX_PART)).toBeNull();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  },
);

async function exportPaged(host: BundleHost): Promise<Uint8Array> {
  const reply = (await host.editor.client.send({
    kind: "exportPaged",
    payload: {},
  } as never)) as {
    kind: string;
    payload: { bytes?: number[]; error?: string };
  };
  if (reply.kind !== "pagedExported")
    throw new Error(`exportPaged: ${reply.kind} ${reply.payload.error ?? ""}`);
  return Uint8Array.from(reply.payload.bytes!);
}
