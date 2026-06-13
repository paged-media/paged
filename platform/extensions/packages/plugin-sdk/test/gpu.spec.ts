// I-07 / C-1 Stage B (realm-local; ADR-018) — the `capabilities.gpu`
// declaration (the buildable "bless it" half). Unlike every other
// capability-gated door, GPU is DECLARE-ONLY: there is NO `host.gpu` /
// `requestGpuDevice` device surface (the bundle drives WebGPU itself via
// `navigator.gpu` in its own JS realm — paged.image's Engine-B does this
// today). Pins: `supports("gpu@1")` reflects the DECLARATION (not a wired
// backend), and — the trust-line keystone, mirroring D-11's no-`get` test —
// that NO device-handing surface exists on the host (assert no `gpu` /
// `requestGpuDevice` member). The zero-copy host composite + shared device
// stay deferred record-only (ADR-018); building them would be a fake.

import { describe, expect, it } from "vitest";

import type {
  GpuCapability,
  PagedEditor,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";

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

const MANIFEST = (gpu?: GpuCapability): PluginManifest => ({
  id: "media.paged.i07",
  name: "i07",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: gpu ? { gpu } : {},
  contributes: {},
});

function makeHost(gpu?: GpuCapability) {
  return createBundleHost(
    () => ({}) as unknown as PagedEditor,
    MANIFEST(gpu),
    {
      console: silent,
      storage: mapBacking(),
      capabilityMode: "enforce",
    },
  );
}

describe("capabilities.gpu (I-07 / C-1 Stage B realm-local)", () => {
  it("supports(\"gpu@1\") reflects the DECLARATION (no host backend to wire)", () => {
    // Declaring realm:"bundle" blesses the realm-local WebGPU usage — the
    // probe is true purely from the manifest (there is no device door whose
    // wiring it could depend on).
    const declared = makeHost({ realm: "bundle" });
    expect(declared.host.supports("gpu@1")).toBe(true);
    // A bundle that does not declare gpu → the probe is false.
    const undeclared = makeHost(undefined);
    expect(undeclared.host.supports("gpu@1")).toBe(false);
  });

  it("THE TRUST LINE — no device-handing surface exists (no gpu / requestGpuDevice)", () => {
    const { host } = makeHost({ realm: "bundle" });
    // The keystone I-07 assertion (mirroring D-11's no-`get`): blessing GPU
    // usage hands the bundle NO device. A shared `GPUDevice` cannot cross the
    // render-worker/main-thread realm boundary, and Vello has no external-
    // texture import — so a device door would be a fake. Its ABSENCE is the
    // contract.
    const h = host as unknown as Record<string, unknown>;
    expect("gpu" in host).toBe(false);
    expect(h.gpu).toBeUndefined();
    expect("requestGpuDevice" in host).toBe(false);
    expect(h.requestGpuDevice).toBeUndefined();
    // No host member name even hints at handing a GPU device/adapter/texture.
    for (const member of Object.keys(host)) {
      expect(member).not.toMatch(/gpu|device|adapter|texture/i);
    }
  });
});
