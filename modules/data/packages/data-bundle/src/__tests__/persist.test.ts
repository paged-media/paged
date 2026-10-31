// The session part's schema and the session's behaviour on a host without
// container parts — no real engine needed (the round trip through a real
// `.paged` is test/persist-real-core.spec.ts).

import { describe, expect, it } from "bun:test";

import {
  ASSET_INDEX_PART,
  INLINE_DATA_MAX_BYTES,
  decodeAssetIndex,
  decodeSession,
  storeAssets,
  type AssetIndex,
  encodeSession,
  loadData,
  storeData,
  type PersistedSession,
} from "../persist";
import { createSession } from "../session";

import { silentConsole as silent } from "@paged-media/plugin-sdk";
describe("the session part schema [data.plugin.persistence]", () => {
  const sample: PersistedSession = {
    v: 1,
    engine: { sources: [], queries: [], templates: [], bindings: [] },
    locale: "de",
    sync: [{ binding: "v", status: "pinned" }],
    targets: { image: {}, barcode: {}, visibility: {}, rule: {}, lowered: {} },
    data: [{ source: "s", format: "csv", text: "a\n1\n" }],
    remote: [],
    refresh: {},
  };

  it("round-trips through encode/decode", () => {
    expect(decodeSession(encodeSession(sample))).toEqual(sample);
  });

  it("refuses a newer version and names it", () => {
    const r = decodeSession(
      new TextEncoder().encode(JSON.stringify({ ...sample, v: 2 })),
    );
    expect("error" in r && r.error).toMatch(/version 2/);
  });

  it("refuses text that is not JSON", () => {
    expect("error" in decodeSession(new TextEncoder().encode("{nope"))).toBe(
      true,
    );
  });

  it("fills what an older writer left out", () => {
    const r = decodeSession(
      new TextEncoder().encode(JSON.stringify({ v: 1, engine: {} })),
    );
    expect(r).toMatchObject({ locale: "en", sync: [], data: [], remote: [] });
  });

  it("keeps small data inline and writes large data once, by content", async () => {
    const written: string[] = [];
    const write = async (p: string) => void written.push(p);
    const known = new Set<string>();
    expect(await storeData("s", "a\n1\n", write, known)).toEqual({
      source: "s",
      format: "csv",
      text: "a\n1\n",
    });
    const big = "x".repeat(INLINE_DATA_MAX_BYTES + 1);
    const a = await storeData("big", big, write, known);
    const b = await storeData("again", big, write, known);
    expect("ref" in a && a.ref.bytes).toBe(INLINE_DATA_MAX_BYTES + 1);
    expect(b).toEqual({ ...a, source: "again" });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^data\/[0-9a-f]{32}\.csv$/);
    expect(await loadData(a, async () => null)).toBeNull();
  });
});

describe("a host without container parts [data.plugin.persistence]", () => {
  it("says the session is not saved, once, and never writes", async () => {
    const host = {
      log: silent,
      supports: () => false,
      parts: {
        write: async () => {
          throw new Error("no container");
        },
        read: async () => null,
      },
      document: {
        onWillSave: () => ({ dispose() {} }),
        onDidChange: () => ({ dispose() {} }),
      },
    } as never;
    const s = createSession(host, 0);
    await s.restore();
    s.addQuery("q", "SELECT 1", "scalar");
    s.addQuery("q2", "SELECT 2", "scalar");
    await s.flushPersist();
    const st = s.getState();
    expect(st.persistence.status).toBe("unavailable");
    expect(st.diagnostics.filter((d) => d.source === "persist")).toHaveLength(
      1,
    );
  });
});

describe("asset parts: the asset columns' pictures in the document [data.assets.columns]", () => {
  const A = {
    hash: "aa".repeat(32),
    mediaType: "image/png",
    bytes: new Uint8Array([1, 2]),
  };
  const B = {
    hash: "bb".repeat(32),
    mediaType: "image/jpeg",
    bytes: new Uint8Array([3]),
  };

  /** A container's parts under the module's namespace, as the door sees them. */
  function container(parts: Record<string, Uint8Array> = {}) {
    const store = new Map(Object.entries(parts));
    const log: string[] = [];
    return {
      store,
      log,
      io: {
        write: async (p: string, b: Uint8Array) => {
          log.push(`write ${p}`);
          store.set(p, b);
        },
        list: async (prefix: string) =>
          [...store.keys()]
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length)),
        delete: async (p: string) => {
          log.push(`delete ${p}`);
          return store.delete(p);
        },
      },
      index: () => decodeAssetIndex(store.get(ASSET_INDEX_PART) ?? null),
    };
  }
  const keptOf =
    (m: Record<string, typeof A>) =>
    (ref: string): typeof A | null =>
      m[ref] ?? null;

  it("writes one part per content hash and indexes every reference", async () => {
    const c = container();
    const { index } = await storeAssets(
      new Map([
        [
          "q.photo",
          [
            "https://img.example/1.png",
            "https://img.example/1-copy.png",
            "https://img.example/1.png",
          ],
        ],
        ["q.logo", ["https://img.example/1.png", "logo.jpg"]],
      ]),
      keptOf({
        "https://img.example/1.png": A,
        "https://img.example/1-copy.png": A,
        "logo.jpg": B,
      }),
      null,
      c.io,
    );
    expect(c.log).toEqual([
      `write assets/${A.hash}`,
      `write assets/${B.hash}`,
      `write ${ASSET_INDEX_PART}`,
    ]);
    expect(index).toEqual({
      v: 1,
      refs: {
        "https://img.example/1.png": {
          hash: A.hash,
          columns: ["q.photo", "q.logo"],
        },
        "https://img.example/1-copy.png": {
          hash: A.hash,
          columns: ["q.photo"],
        },
        "logo.jpg": { hash: B.hash, columns: ["q.logo"] },
      },
      assets: {
        [A.hash]: { mediaType: "image/png", bytes: 2 },
        [B.hash]: { mediaType: "image/jpeg", bytes: 1 },
      },
    } satisfies AssetIndex);
    expect(c.index()).toEqual(index);

    // Saved again unchanged: nothing is written.
    c.log.length = 0;
    await storeAssets(
      new Map([
        ["q.photo", ["https://img.example/1.png"]],
        ["q.logo", ["https://img.example/1.png", "logo.jpg"]],
      ]),
      keptOf({ "https://img.example/1.png": A, "logo.jpg": B }),
      c.index(),
      c.io,
    );
    expect(c.log).toEqual([`write ${ASSET_INDEX_PART}`]);
    c.log.length = 0;
    await storeAssets(
      new Map([
        ["q.photo", ["https://img.example/1.png"]],
        ["q.logo", ["https://img.example/1.png", "logo.jpg"]],
      ]),
      keptOf({ "https://img.example/1.png": A, "logo.jpg": B }),
      c.index(),
      c.io,
    );
    expect(c.log).toEqual([]);
  });

  it("deletes the parts no reference names any more, after the index", async () => {
    const c = container();
    await storeAssets(
      new Map([["q.photo", ["a.png", "b.jpg"]]]),
      keptOf({ "a.png": A, "b.jpg": B }),
      null,
      c.io,
    );
    c.log.length = 0;
    await storeAssets(
      new Map([["q.photo", ["a.png"]]]),
      keptOf({ "a.png": A }),
      c.index(),
      c.io,
    );
    expect(c.log).toEqual([
      `write ${ASSET_INDEX_PART}`,
      `delete assets/${B.hash}`,
    ]);
    expect([...c.store.keys()].sort()).toEqual([
      ASSET_INDEX_PART,
      `assets/${A.hash}`,
    ]);

    // No asset column left: the index goes too.
    c.log.length = 0;
    await storeAssets(new Map(), keptOf({}), c.index(), c.io);
    expect(c.log).toEqual([
      `delete ${ASSET_INDEX_PART}`,
      `delete assets/${A.hash}`,
    ]);
    expect(c.store.size).toBe(0);
  });

  it("keeps what the document carries for references not loaded this session, or a column not yet refreshed", async () => {
    const c = container();
    await storeAssets(
      new Map([
        ["q.photo", ["a.png"]],
        ["r.logo", ["b.jpg"]],
      ]),
      keptOf({ "a.png": A, "b.jpg": B }),
      null,
      c.io,
    );
    c.log.length = 0;
    // Reopened elsewhere: nothing held in memory; r has no records yet.
    const { index } = await storeAssets(
      new Map([
        ["q.photo", ["a.png"]],
        ["r.logo", null],
      ]),
      keptOf({}),
      c.index(),
      c.io,
    );
    expect(c.log).toEqual([]);
    expect(Object.keys(index.refs).sort()).toEqual(["a.png", "b.jpg"]);

    // A part gone from the container is not named again.
    c.store.delete(`assets/${B.hash}`);
    const after = await storeAssets(
      new Map([
        ["q.photo", ["a.png"]],
        ["r.logo", null],
      ]),
      keptOf({}),
      c.index(),
      c.io,
    );
    expect(Object.keys(after.index.refs)).toEqual(["a.png"]);
  });

  it("never writes a reference this session holds no bytes for, nor a data: reference", async () => {
    const c = container();
    const { index, written } = await storeAssets(
      new Map([
        [
          "q.photo",
          ["https://unconsented.example/x.png", "data:image/png;base64,AQI="],
        ],
      ]),
      keptOf({ "data:image/png;base64,AQI=": A }),
      null,
      c.io,
    );
    expect(written).toEqual([]);
    expect(index.refs).toEqual({});
    expect(c.store.size).toBe(0);
  });

  it("reads an index back, dropping what names no asset", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        refs: { a: { hash: A.hash, columns: ["q.p", 3] }, b: { hash: "cc" } },
        assets: {
          [A.hash]: { mediaType: "image/png", bytes: 2 },
          "not-hex": { mediaType: "x" },
        },
      }),
    );
    expect(decodeAssetIndex(bytes)).toEqual({
      v: 1,
      refs: { a: { hash: A.hash, columns: ["q.p"] } },
      assets: { [A.hash]: { mediaType: "image/png", bytes: 2 } },
    });
    expect(decodeAssetIndex(new TextEncoder().encode('{"v":2}'))).toBeNull();
    expect(decodeAssetIndex(null)).toBeNull();
  });
});
