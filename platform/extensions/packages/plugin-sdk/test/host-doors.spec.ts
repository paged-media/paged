// Host-door coverage for the read/no-op surfaces that had no dedicated
// spec: S-13 text measurement, K-5 shell file picker, W-04 widgets
// fallback, C-2 frame-chain read, C-1 scene-layer contribution. Each
// asserts the door's honest behaviour (estimate / empty / fallback /
// gated registration) so the plugin.api claim is certified.

import { describe, expect, it } from "vitest";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
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

const manifest = (
  capabilities: PluginManifest["capabilities"] = {},
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

function makeHost(
  caps: PluginManifest["capabilities"] = {},
  opts: Record<string, unknown> = {},
) {
  return createBundleHost(() => makeFakeEditor().editor, manifest(caps), {
    console: silent,
    storage: mapBacking(),
    capabilityMode: "enforce",
    ...opts,
  });
}

describe("host doors — measurement / picker / widgets / frame-chain / scene-layer", () => {
  // ── S-13 text measurement (plugin-platform.text-measurement) ────────
  it("text.measureString falls back to an estimate when no host shaper is wired", async () => {
    const { host } = makeHost();
    const m = await host.text.measureString("Helvetica", "Regular", "abcd", 12);
    // ~0.5em advance, 0.8em/0.2em asc/desc — the documented fallback.
    expect(m.advance).toBeCloseTo(4 * 12 * 0.5);
    expect(m.ascender).toBeCloseTo(12 * 0.8);
    expect(m.descender).toBeCloseTo(-12 * 0.2);
    expect(host.supports("text.measure@1")).toBe(false);
  });

  // ── K-5 shell file picker (plugin-platform.file-picker) ─────────────
  it("shell.pickFile resolves empty (honest no-op) when the host provides no picker", async () => {
    const { host } = makeHost();
    expect(await host.shell.pickFile()).toEqual([]);
    expect(host.supports("shell.pickFile@1")).toBe(false);
  });

  // ── W-04 widgets fallback (plugin-platform.host-widgets) ────────────
  it("host.widgets is the bundle-owned fallback when no widget surface is injected", () => {
    const { host } = makeHost();
    expect(host.supports("widgets.codeEditor@1")).toBe(false);
    expect(host.widgets).toBeDefined();
    // The fallback always provides a CodeEditor component (a plain textarea).
    expect(typeof host.widgets.CodeEditor).toBe("function");
  });

  // ── C-2 frame-chain read (plugin-platform.frame-chain-read) ─────────
  it("document.frameChain reads the chain (empty here) behind capabilities.document.read", async () => {
    const { host } = makeHost({ document: { read: "broad" } });
    expect(await host.document.frameChain("story-1")).toEqual([]);
  });

  it("document.frameChain is gated — refused without capabilities.document.read", async () => {
    const { host } = makeHost();
    await expect(host.document.frameChain("story-1")).rejects.toThrow();
  });

  // ── C-1 scene-layer contribution (plugin-platform.scene-layer) ──────
  it("contribute.sceneLayer registers behind capabilities.rendering ∋ sceneLayer", () => {
    const { host } = makeHost({ rendering: ["sceneLayer"] });
    const layer = host.contribute.sceneLayer();
    expect(layer).toBeDefined();
    layer.dispose();
  });

  it("contribute.sceneLayer is gated — refused without rendering ∋ sceneLayer", () => {
    const { host } = makeHost({ rendering: [] });
    expect(() => host.contribute.sceneLayer()).toThrow();
  });
});
