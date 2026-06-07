// W-06 — the capability-gated ASSET STORE (`host.assets`).
//
// Coverage:
//   1. the door: `getFontFace` serves bytes from the injected source,
//      returns null for an unknown family, and answers null (never
//      throws) when no source is injected;
//   2. the gate: a manifest WITHOUT `capabilities.assets: ["fonts"]`
//      is refused — throw in 'enforce', warn+proceed in 'warn';
//   3. the budget: an over-budget face is refused (null + a warn);
//   4. supports("assets.fonts@1") tracks whether a source is wired;
//   5. the recordable fake (`createRecordableAssetSource`) records
//      every request and matches case-insensitively / by style.

import { describe, expect, it, vi } from "vitest";

import type { FontFaceAsset, PluginManifest } from "@paged-media/plugin-api";

import {
  ASSET_BUDGETS,
  createBundleHost,
  PluginCapabilityError,
  createRecordableAssetSource,
  type BundleAssetProvider,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

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

const DECLARED: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { assets: ["fonts"] },
};
const UNDECLARED: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

function bytes(n: number): Uint8Array {
  return new Uint8Array(n).fill(7);
}

function makeHost(
  manifest: PluginManifest,
  assetSource?: BundleAssetProvider,
  capabilityMode: "enforce" | "warn" = "enforce",
  console = silent,
) {
  return createBundleHost(() => makeFakeEditor().editor, manifest, {
    console,
    storage: mapBacking(),
    capabilityMode,
    assetSource,
  });
}

describe("host.assets.getFontFace — the door (W-06)", () => {
  it("serves the injected source's bytes for a known family", async () => {
    const inter: FontFaceAsset = {
      bytes: bytes(64),
      format: "truetype",
      family: "Inter",
      postscriptName: "Inter-Regular",
    };
    const source = createRecordableAssetSource([inter]);
    const { host } = makeHost(DECLARED, source);

    const face = await host.assets.getFontFace("Inter");
    expect(face).not.toBeNull();
    expect(face?.family).toBe("Inter");
    expect(face?.format).toBe("truetype");
    expect(face?.bytes.byteLength).toBe(64);
    expect(face?.postscriptName).toBe("Inter-Regular");
  });

  it("returns null for a family the source has no bytes for", async () => {
    const source = createRecordableAssetSource([]);
    const { host } = makeHost(DECLARED, source);
    expect(await host.assets.getFontFace("Ghost Sans")).toBeNull();
  });

  it("returns null (never throws) when NO source is injected — the honest no-bytes door", async () => {
    const { host } = makeHost(DECLARED, undefined);
    await expect(host.assets.getFontFace("Inter")).resolves.toBeNull();
  });

  it("returns null (never throws) when the source itself throws", async () => {
    const throwing: BundleAssetProvider = {
      async getFontFace() {
        throw new Error("source blew up");
      },
    };
    const { host } = makeHost(DECLARED, throwing);
    await expect(host.assets.getFontFace("Inter")).resolves.toBeNull();
  });
});

describe("host.assets — the capability gate (W-06)", () => {
  it("THROWS in 'enforce' when capabilities.assets does not include 'fonts'", async () => {
    const source = createRecordableAssetSource([
      { bytes: bytes(8), format: "truetype", family: "Inter" },
    ]);
    const { host } = makeHost(UNDECLARED, source, "enforce");
    await expect(host.assets.getFontFace("Inter")).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });

  it("warns + PROCEEDS in 'warn' when undeclared (migration hatch)", async () => {
    const warn = vi.fn();
    const source = createRecordableAssetSource([
      { bytes: bytes(8), format: "truetype", family: "Inter" },
    ]);
    const { host } = makeHost(UNDECLARED, source, "warn", {
      ...silent,
      warn,
    });
    const face = await host.assets.getFontFace("Inter");
    expect(face?.family).toBe("Inter"); // proceeded
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/assets must include "fonts"/);
  });

  it("does not gate on the SOURCE — undeclared with no source still throws (the gate fires first)", async () => {
    const { host } = makeHost(UNDECLARED, undefined, "enforce");
    await expect(host.assets.getFontFace("Inter")).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });
});

describe("host.assets — the per-face budget (W-06)", () => {
  it("refuses an over-budget face (null + a warn)", async () => {
    const warn = vi.fn();
    const oversize: FontFaceAsset = {
      bytes: bytes(ASSET_BUDGETS.maxFontFaceBytes + 1),
      format: "opentype",
      family: "Huge",
    };
    const source: BundleAssetProvider = {
      async getFontFace() {
        return oversize;
      },
    };
    const { host } = makeHost(DECLARED, source, "enforce", {
      ...silent,
      warn,
    });
    expect(await host.assets.getFontFace("Huge")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/over the .* per-face cap/);
  });

  it("serves a face exactly at the cap", async () => {
    const atCap: FontFaceAsset = {
      bytes: bytes(ASSET_BUDGETS.maxFontFaceBytes),
      format: "woff2",
      family: "AtCap",
    };
    const { host } = makeHost(DECLARED, {
      async getFontFace() {
        return atCap;
      },
    });
    const face = await host.assets.getFontFace("AtCap");
    expect(face?.bytes.byteLength).toBe(ASSET_BUDGETS.maxFontFaceBytes);
  });
});

describe("host.supports('assets.fonts@1')", () => {
  it("is true only when a source is injected", () => {
    const withSource = makeHost(DECLARED, createRecordableAssetSource([]));
    expect(withSource.host.supports("assets.fonts@1")).toBe(true);
    const without = makeHost(DECLARED, undefined);
    expect(without.host.supports("assets.fonts@1")).toBe(false);
  });
});

describe("createRecordableAssetSource — the headless fake", () => {
  it("records every request in order", async () => {
    const source = createRecordableAssetSource([
      { bytes: bytes(8), format: "truetype", family: "Inter" },
    ]);
    await source.getFontFace("Inter");
    await source.getFontFace("Lora", "Bold");
    expect(source.requests).toEqual([
      { family: "Inter" },
      { family: "Lora", style: "Bold" },
    ]);
  });

  it("matches family case-insensitively", async () => {
    const source = createRecordableAssetSource([
      { bytes: bytes(8), format: "truetype", family: "IBM Plex Sans" },
    ]);
    const face = await source.getFontFace("ibm plex sans");
    expect(face?.family).toBe("IBM Plex Sans");
  });

  it("honors a style-specific seed (matchStyle) and strips matchStyle from the result", async () => {
    const source = createRecordableAssetSource([
      { bytes: bytes(8), format: "truetype", family: "Lora", matchStyle: "Bold" },
    ]);
    expect(await source.getFontFace("Lora")).toBeNull(); // no style → no match
    const bold = await source.getFontFace("Lora", "Bold");
    expect(bold?.family).toBe("Lora");
    expect(bold).not.toHaveProperty("matchStyle");
  });
});
