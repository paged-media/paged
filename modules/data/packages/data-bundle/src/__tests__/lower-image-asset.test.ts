// An `asset:<id>` image (data ADR 563, amended 2026-10-28) is placed from
// the bytes the document carries, through the resolver the session wires;
// without one, or when it says why not, nothing is placed.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import { commitLoweredImage } from "../lower";
import { carriedHash } from "../persist";

function fakeHost() {
  const sent: any[] = [];
  const host = {
    log: { info() {}, warn() {}, debug() {} },
    document: {
      mutate: async (m: any) => {
        sent.push(m);
        return { applied: true };
      },
    },
  } as unknown as BundleHost;
  return { host, sent };
}

const IMAGE: any = {
  target: "u1",
  reference: { ref: "assetId", id: "logo-a" },
  fit: "proportional",
  status: "present",
};

describe("commitLoweredImage, an asset id [data.assets.columns]", () => {
  it("places the uri the asset resolver gives", async () => {
    const { host, sent } = fakeHost();
    const asked: string[] = [];
    const placed = await commitLoweredImage(
      host,
      IMAGE,
      "u1",
      undefined,
      undefined,
      async (id) => {
        asked.push(id);
        return { uri: "data:image/png;base64,AAAA" };
      },
    );
    expect(placed).toBe(true);
    expect(asked).toEqual(["logo-a"]);
    expect(JSON.stringify(sent[0])).toContain("data:image/png;base64,AAAA");
  });

  it("places nothing when the resolver says why not", async () => {
    const { host, sent } = fakeHost();
    const placed = await commitLoweredImage(
      host,
      IMAGE,
      "u1",
      undefined,
      undefined,
      async () => ({ reason: "the document carries no such asset" }),
    );
    expect(placed).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("places nothing without a resolver", async () => {
    const { host, sent } = fakeHost();
    expect(await commitLoweredImage(host, IMAGE, "u1")).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("carriedHash [data.assets.columns]", () => {
  const index: any = {
    v: 1,
    refs: { "https://cdn.example/a.png": { hash: "aa", columns: ["q.photo"] } },
    assets: {
      aa: { mediaType: "image/png", bytes: 3 },
      bb: { mediaType: "image/png", bytes: 4 },
    },
  };

  it("finds a column's reference, and an asset id by reference or by hash", () => {
    expect(carriedHash(index, "https://cdn.example/a.png")).toBe("aa");
    expect(carriedHash(index, "asset:https://cdn.example/a.png")).toBe("aa");
    expect(carriedHash(index, "asset:bb")).toBe("bb");
  });

  it("finds nothing the index does not carry", () => {
    expect(carriedHash(index, "asset:cc")).toBeUndefined();
    expect(carriedHash(index, "bb")).toBeUndefined();
  });
});
