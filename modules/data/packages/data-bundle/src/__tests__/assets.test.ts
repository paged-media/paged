// Data ADR 563 — asset columns: the pipeline that makes a referenced asset
// ready to place (fetch for a consented origin, keep by content hash, run the
// column's action chain), against a real SDK bundle host with the shared
// action registry (extensions ADR 344).
import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";
import {
  createActionRegistry,
  createBundleHost,
  silentConsole,
} from "@paged-media/plugin-sdk";
import { createFakeEditor } from "@paged-media/plugin-sdk/gesture-kit";

import { createAssetPipeline, mediaTypeOf, type AssetDeps } from "../assets";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function setup(
  consented: string[] = ["https://img.example"],
  fromDocument?: AssetDeps["fromDocument"],
) {
  const actions = createActionRegistry();
  const editor = createFakeEditor().editor;
  const painter = createBundleHost(
    () => editor,
    {
      id: "media.paged.image",
      name: "image",
      version: "1.0.0",
      apiVersion: "^0.2",
      capabilities: { actions: { register: true } },
    } as PluginManifest,
    { console: silentConsole, actions },
  ).host;
  painter.actions.register({
    id: "media.paged.image/invert",
    title: "Invert",
    input: "asset",
    output: "asset",
    run: (input) => {
      const a = input as { bytes: Uint8Array; mediaType: string };
      return { bytes: a.bytes.map((b) => 255 - b), mediaType: a.mediaType };
    },
  });
  painter.actions.register({
    id: "media.paged.image/size",
    title: "Size",
    input: "asset",
    output: "value",
    run: (input) => (input as { bytes: Uint8Array }).bytes.length,
  });
  const host = createBundleHost(
    () => editor,
    {
      id: "media.paged.data",
      name: "data",
      version: "1.0.0",
      apiVersion: "^0.2",
      capabilities: { actions: { run: true } },
    } as PluginManifest,
    { console: silentConsole, actions },
  ).host;
  const fetches: string[] = [];
  const pipeline = createAssetPipeline(host, {
    consentedOrigins: () => consented,
    fetch: async (url) => {
      fetches.push(url);
      if (url.endsWith("/missing.png")) throw new Error("HTTP 404");
      return PNG;
    },
    ...(fromDocument ? { fromDocument } : {}),
  });
  return { pipeline, fetches };
}

const decode = (uri: string) =>
  Uint8Array.from(atob(uri.split(",")[1]!), (c) => c.charCodeAt(0));

describe("asset columns [data.assets.columns]", () => {
  it("fetches a consented origin once, and places the bytes as a data URI", async () => {
    const { pipeline, fetches } = setup();
    const a = await pipeline.resolve("https://img.example/p/1.png", {});
    expect(a.ok && a.uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(a.ok && a.cached).toBe(false);
    expect(a.ok && Array.from(decode(a.uri))).toEqual(Array.from(PNG));
    const again = await pipeline.resolve("https://img.example/p/1.png", {});
    expect(again.ok && again.key).toBe(a.ok && a.key);
    expect(again.ok && again.cached).toBe(true);
    expect(fetches).toEqual(["https://img.example/p/1.png"]);
  });

  it("resolves a relative reference against the column's base", async () => {
    const { pipeline, fetches } = setup();
    const a = await pipeline.resolve("2.png", {
      base: "https://img.example/p/",
    });
    expect(a.ok).toBe(true);
    expect(fetches).toEqual(["https://img.example/p/2.png"]);
  });

  it("runs the column's action chain, its result cached under the chain's key", async () => {
    const { pipeline } = setup();
    const chain = [{ action: "media.paged.image/invert" }];
    const a = await pipeline.resolve("https://img.example/p/1.png", { chain });
    expect(a.ok && Array.from(decode(a.uri))).toEqual(
      Array.from(PNG, (b) => 255 - b),
    );
    const b = await pipeline.resolve("https://img.example/p/1.png", { chain });
    expect(b.ok && b.cached).toBe(true);
    expect(b.ok && b.key).toBe(a.ok && a.key);
  });

  it("says why an asset cannot be had, and places nothing", async () => {
    const { pipeline, fetches } = setup();
    const reasons = await Promise.all(
      [
        ["https://other.example/x.png", {}],
        ["https://img.example/missing.png", {}],
        ["file:///etc/passwd", {}],
        ["x.png", {}],
        [
          "https://img.example/p/1.png",
          { chain: [{ action: "media.paged.image/size" }] },
        ],
        ["https://img.example/p/1.png", { chain: [{ action: "nope" }] }],
      ].map(async ([ref, def]) => {
        const r = await pipeline.resolve(ref as string, def as never);
        return r.ok ? "ok" : r.reason;
      }),
    );
    expect(reasons[0]).toMatch(/has no consent/);
    expect(reasons[1]).toMatch(/could not be fetched \(HTTP 404\)/);
    expect(reasons[2]).toMatch(/only http\(s\) assets/);
    expect(reasons[3]).toMatch(/no base/);
    expect(reasons[4]).toMatch(/did not give an asset/);
    expect(reasons[5]).toMatch(/no action nope/);
    expect(fetches).not.toContain("https://other.example/x.png");
  });

  it("reads a data URI without the network, and knows the media type by signature", async () => {
    const { pipeline, fetches } = setup([]);
    const a = await pipeline.resolve(
      `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`,
      {},
    );
    expect(a.ok && a.mediaType).toBe("image/png");
    expect(fetches).toEqual([]);
    expect(mediaTypeOf(new Uint8Array([0xff, 0xd8, 0]), "x.bin")).toBe(
      "image/jpeg",
    );
    expect(mediaTypeOf(new Uint8Array([0]), "a.svg?v=1")).toBe("image/svg+xml");
  });

  it("reads a reference the document carries from its part, without consent or a fetch, and keeps it", async () => {
    const hash = await sha256Hex(PNG);
    const reads: string[] = [];
    const { pipeline, fetches } = setup([], async (reference) =>
      reference === "https://img.example/p/1.png"
        ? {
            hash,
            mediaType: "image/png",
            read: async () => {
              reads.push(reference);
              return PNG;
            },
          }
        : null,
    );
    const a = await pipeline.resolve("https://img.example/p/1.png", {});
    expect(a.ok && a.cached).toBe(true);
    expect(a.ok && Array.from(decode(a.uri))).toEqual(Array.from(PNG));
    expect(fetches).toEqual([]);
    expect(pipeline.kept("https://img.example/p/1.png")).toMatchObject({
      hash,
      mediaType: "image/png",
    });
    // Kept: a second resolve does not read the part again.
    await pipeline.resolve("https://img.example/p/1.png", {});
    expect(reads).toHaveLength(1);
    // What the document does not carry still needs consent.
    const b = await pipeline.resolve("https://img.example/p/2.png", {});
    expect(!b.ok && b.reason).toMatch(/has no consent/);
    expect(pipeline.kept("https://img.example/p/2.png")).toBeNull();
  });

  it("refuses a document part whose bytes are not its hash, and falls back to the fetch", async () => {
    const { pipeline, fetches } = setup(["https://img.example"], async () => ({
      hash: "00".repeat(32),
      mediaType: "image/png",
      read: async () => PNG,
    }));
    const a = await pipeline.resolve("https://img.example/p/1.png", {});
    expect(a.ok && a.cached).toBe(false);
    expect(fetches).toEqual(["https://img.example/p/1.png"]);
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
