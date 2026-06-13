// C-6 / I-06 — the renderer RESOURCE-PROVIDER door
// (`host.images.claimImageResource`, the v44 wire) over a MOCK editor
// that routes `resourceTilesNeeded` exactly as apps/canvas does (claim →
// emit needed → the SDK adapter pulls `source(level,x,y)` → submit →
// release). Pins: the feature probe + capability gate, the claim payload,
// the pull→batch→submit plumbing (generation echoed, only this image's
// events routed, nulls skipped), and the release on dispose.

import { describe, expect, it } from "vitest";

import type {
  PagedEditor,
  PluginManifest,
  TileBytes,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { makeFakeEditor, makeFakeImageChannel } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

const MANIFEST = (rendering?: string[]): PluginManifest => ({
  id: "media.paged.c6",
  name: "c6",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: rendering ? { rendering: rendering as never } : {},
  contributes: {},
});

/** A solid-colour level-0 tile generator (a stand-in for a real
 *  provider). Tags each tile's first pixel with `level` so a submit can
 *  be checked back to its request. */
function tile(level: number, x: number, y: number, size = 4): TileBytes {
  const rgba = new Uint8Array(size * size * 4).fill(0);
  rgba[0] = level;
  rgba[1] = x;
  rgba[2] = y;
  rgba[3] = 255;
  return { x, y, width: size, height: size, rgba };
}

function makeHost(rendering: string[] | undefined, withChannel: boolean) {
  const img = makeFakeImageChannel();
  const fake = makeFakeEditor(withChannel ? { images: img.channel } : {});
  const handle = createBundleHost(
    () => fake.editor as unknown as PagedEditor,
    MANIFEST(rendering),
    { console: silent, storage: mapBacking(), capabilityMode: "enforce" },
  );
  return { ...handle, img };
}

describe("host.images.claimImageResource (C-6, mock editor routing)", () => {
  it("probes rendering.resourceProvider@1 only when a channel is wired", () => {
    const wired = makeHost(["resourceProvider"], true);
    expect(wired.host.supports("rendering.resourceProvider@1")).toBe(true);
    const unwired = makeHost(["resourceProvider"], false);
    expect(unwired.host.supports("rendering.resourceProvider@1")).toBe(false);
  });

  it("claim → needed → source → submit (generation echoed, nulls skipped)", async () => {
    const { host, img } = makeHost(["resourceProvider"], true);
    const sourced: Array<[number, number, number]> = [];

    const claim = host.images.claimImageResource("frame-1", {
      levels: 3,
      tileSize: 4,
      baseWidth: 8,
      baseHeight: 8,
      revision: () => 7,
      source: async (level, x, y) => {
        sourced.push([level, x, y]);
        // Return null for one origin → it must be skipped on submit.
        if (x === 4 && y === 0) return null;
        return tile(level, x, y);
      },
    });

    // The claim crossed the wire with the provider-owned pyramid + rev.
    expect(img.claims).toEqual([
      {
        imageId: "frame-1",
        levels: 3,
        tileSize: 4,
        baseWidth: 8,
        baseHeight: 8,
        revision: 7,
      },
    ]);
    expect(img.listenerCount()).toBe(1);

    // The renderer reports three missing tiles at level 0, generation 2.
    await img.emitNeeded({
      imageId: "frame-1",
      level: 0,
      tiles: [
        [0, 0],
        [4, 0],
        [0, 4],
      ],
      generation: 2,
    });

    // The adapter pulled every requested origin…
    expect(sourced).toEqual([
      [0, 0, 0],
      [0, 4, 0],
      [0, 0, 4],
    ]);
    // …and submitted ONE batch — the null tile dropped — echoing the
    // generation and the level.
    expect(img.submits.length).toBe(1);
    const s = img.submits[0];
    expect(s.imageId).toBe("frame-1");
    expect(s.level).toBe(0);
    expect(s.generation).toBe(2);
    expect(s.tiles.map((t) => [t.x, t.y])).toEqual([
      [0, 0],
      [0, 4],
    ]);
    // RGBA crossed as a plain number[] (isolate-proxy-safe).
    expect(Array.isArray(s.tiles[0].rgba)).toBe(true);
    expect(s.tiles[0].rgba.length).toBe(4 * 4 * 4);

    claim.dispose();
  });

  it("routes only THIS image's needed events", async () => {
    const { host, img } = makeHost(["resourceProvider"], true);
    let calls = 0;
    host.images.claimImageResource("frame-A", {
      levels: 1,
      tileSize: 4,
      baseWidth: 4,
      baseHeight: 4,
      revision: () => 1,
      source: async (l, x, y) => {
        calls++;
        return tile(l, x, y);
      },
    });
    // A needed event for a DIFFERENT image is ignored.
    await img.emitNeeded({
      imageId: "frame-OTHER",
      level: 0,
      tiles: [[0, 0]],
      generation: 1,
    });
    expect(calls).toBe(0);
    expect(img.submits.length).toBe(0);
  });

  it("dispose releases the claim and stops routing", async () => {
    const { host, img } = makeHost(["resourceProvider"], true);
    let calls = 0;
    const claim = host.images.claimImageResource("frame-1", {
      levels: 1,
      tileSize: 4,
      baseWidth: 4,
      baseHeight: 4,
      revision: () => 1,
      source: async (l, x, y) => {
        calls++;
        return tile(l, x, y);
      },
    });
    expect(img.listenerCount()).toBe(1);
    claim.dispose();
    expect(img.releases).toEqual(["frame-1"]);
    expect(img.listenerCount()).toBe(0);
    // A post-dispose needed event drives nothing.
    await img.emitNeeded({
      imageId: "frame-1",
      level: 0,
      tiles: [[0, 0]],
      generation: 9,
    });
    expect(calls).toBe(0);
    expect(img.submits.length).toBe(0);
  });

  it("gates on capabilities.rendering ∋ resourceProvider (undeclared throws)", () => {
    const { host } = makeHost(undefined, true);
    expect(() =>
      host.images.claimImageResource("frame-1", {
        levels: 1,
        tileSize: 4,
        baseWidth: 4,
        baseHeight: 4,
        revision: () => 1,
        source: async () => null,
      }),
    ).toThrow(/resourceProvider/);
  });

  it("no channel wired → claim warns + returns an inert disposable", () => {
    const { host } = makeHost(["resourceProvider"], false);
    expect(host.supports("rendering.resourceProvider@1")).toBe(false);
    const claim = host.images.claimImageResource("frame-1", {
      levels: 1,
      tileSize: 4,
      baseWidth: 4,
      baseHeight: 4,
      revision: () => 1,
      source: async () => null,
    });
    // Inert but disposable (no throw).
    expect(() => claim.dispose()).not.toThrow();
  });
});
