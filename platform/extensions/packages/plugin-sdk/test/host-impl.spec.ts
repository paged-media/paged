import { describe, expect, it, vi } from "vitest";

import type { PluginManifest, ToolContribution } from "@paged-media/plugin-api";

import {
  createBundleHost,
  HOST_FEATURES,
  PluginApiNotImplemented,
} from "../src/host-impl";
import { loadBundle } from "../src/load";
import { defineBundle } from "../src/define-bundle";
import { makeFakeEditor } from "./fake-editor";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function host(fake = makeFakeEditor()) {
  const handle = createBundleHost(() => fake.editor, MANIFEST, {
    console: silent,
    storage: mapBacking(),
  });
  return { ...handle, fake };
}

function mapBacking() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    keys: () => Array.from(map.keys()),
  };
}

const tool = (id: string): ToolContribution =>
  ({ id, title: "T", icon: "i", group: "g", section: "drawType" }) as ToolContribution;

describe("contribute — namespace rule + teardown", () => {
  it("accepts namespaced ids and registers", () => {
    const h = host();
    h.host.contribute.tool(tool("media.paged.test.tool.pen"));
    expect(h.fake.tools.ids()).toEqual(["media.paged.test.tool.pen"]);
  });

  it("rejects foreign ids loudly", () => {
    const h = host();
    expect(() => h.host.contribute.tool(tool("paged.tool.pen"))).toThrow(
      /must be namespaced under "media\.paged\.test\."/,
    );
  });

  it("dispose() tears down every facade registration", () => {
    const h = host();
    h.host.contribute.tool(tool("media.paged.test.tool.a"));
    h.host.contribute.tool(tool("media.paged.test.tool.b"));
    h.host.contribute.command({
      id: "media.paged.test.cmd.x",
    } as never);
    expect(h.fake.tools.ids()).toHaveLength(2);
    expect(h.fake.commands.ids()).toHaveLength(1);
    h.dispose();
    expect(h.fake.tools.ids()).toHaveLength(0);
    expect(h.fake.commands.ids()).toHaveLength(0);
  });

  it("individual disposables still work", () => {
    const h = host();
    const d = h.host.contribute.tool(tool("media.paged.test.tool.a"));
    d.dispose();
    expect(h.fake.tools.ids()).toHaveLength(0);
  });

  it("reserved members throw visible seams", () => {
    const h = host();
    expect(() =>
      h.host.contribute.editContext({ type: "x", entry: "doubleClick" }),
    ).toThrow(PluginApiNotImplemented);
    expect(() =>
      h.host.contribute.objectType({ type: "x", bakedFallback: "group" }),
    ).toThrow(PluginApiNotImplemented);
  });
});

describe("document surface", () => {
  it("maps mutationApplied to an applied outcome", async () => {
    const h = host();
    h.fake.setNextMutateReply({
      kind: "mutationApplied",
      payload: { createdId: { kind: "polygon", id: "u1" }, pageIds: ["p1"] },
    });
    const out = await h.host.document.mutate({
      op: "deleteFrame",
      args: { frameId: "u1" },
    } as never);
    expect(out).toEqual({
      applied: true,
      createdId: { kind: "polygon", id: "u1" },
      pageIds: ["p1"],
    });
  });

  it("maps mutationFailed to a non-throwing failure", async () => {
    const h = host();
    h.fake.setNextMutateReply({
      kind: "mutationFailed",
      payload: { error: "nope" },
    });
    const out = await h.host.document.mutate({} as never);
    expect(out.applied).toBe(false);
  });

  it("onDidChange filters to document-change kinds and disposes", () => {
    const h = host();
    const seen: string[] = [];
    const d = h.host.document.onDidChange((e) => seen.push(e.kind));
    h.fake.emit({ kind: "mutationApplied", payload: { pageIds: ["p1"] } });
    h.fake.emit({ kind: "hitResult", payload: {} });
    h.fake.emit({ kind: "undoApplied", payload: { pageIds: [] } });
    expect(seen).toEqual(["mutationApplied", "undoApplied"]);
    d.dispose();
    expect(h.fake.listenerCount()).toBe(0);
  });

  it("hitTest unwraps the reply", async () => {
    const h = host();
    const r = await h.host.document.hitTest("p1", [1, 2]);
    expect(r).toEqual({ element: null });
  });
});

describe("viewport / overlay / storage / diagnostics", () => {
  it("pxToPt divides by the camera scale", () => {
    const h = host();
    expect(h.host.viewport.pxToPt(6)).toBe(3); // fake scale = 2
    expect(h.host.viewport.camera()).toEqual({ scale: 2, tx: 10, ty: 20 });
  });

  it("setToolPreview reaches the overlay signals", () => {
    const h = host();
    h.host.overlay.setToolPreview({ pageId: "p1", points: [[0, 0]] });
    expect(h.fake.getToolPreview()).toEqual({ pageId: "p1", points: [[0, 0]] });
  });

  it("storage namespaces keys and round-trips JSON", () => {
    const h = host();
    h.host.storage.set("opts", { dpi: 240 });
    expect(h.host.storage.get("opts")).toEqual({ dpi: 240 });
    expect(h.host.storage.keys()).toEqual(["opts"]);
    h.host.storage.delete("opts");
    expect(h.host.storage.get("opts")).toBeUndefined();
  });

  it("diagnostics store + change events", () => {
    const h = host();
    const keys: string[] = [];
    h.host.diagnostics.onDidChange((k) => keys.push(k));
    h.host.diagnostics.set("frame:u1", [
      { severity: "warning", message: "unsupported property" },
    ]);
    expect(h.host.diagnostics.get("frame:u1")).toHaveLength(1);
    h.host.diagnostics.clear("frame:u1");
    expect(h.host.diagnostics.get("frame:u1")).toHaveLength(0);
    expect(keys).toEqual(["frame:u1", "frame:u1"]);
  });

  it("supports() answers from HOST_FEATURES", () => {
    const h = host();
    for (const f of HOST_FEATURES) expect(h.host.supports(f)).toBe(true);
    expect(h.host.supports("contribute.editContext@1")).toBe(false);
  });
});

describe("loadBundle", () => {
  it("activates, then dispose() runs bundle + facade teardown", () => {
    const fake = makeFakeEditor();
    const bundleDispose = vi.fn();
    const bundle = defineBundle({
      manifest: MANIFEST,
      activate(h) {
        h.contribute.tool(tool("media.paged.test.tool.pen"));
        return { dispose: bundleDispose };
      },
    });
    const loaded = loadBundle(() => fake.editor, bundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(loaded.active).toBe(true);
    expect(fake.tools.ids()).toHaveLength(1);
    loaded.dispose();
    expect(loaded.active).toBe(false);
    expect(bundleDispose).toHaveBeenCalledOnce();
    expect(fake.tools.ids()).toHaveLength(0);
  });

  it("refuses an unsatisfied apiVersion loudly", () => {
    const fake = makeFakeEditor();
    const bundle = defineBundle({
      manifest: { ...MANIFEST, apiVersion: "^1.0" },
      activate: () => ({ dispose() {} }),
    });
    expect(() => loadBundle(() => fake.editor, bundle)).toThrow(
      /requires plugin-api/,
    );
  });

  it("facades tear down even when the bundle's dispose throws", () => {
    const fake = makeFakeEditor();
    const bundle = defineBundle({
      manifest: MANIFEST,
      activate(h) {
        h.contribute.tool(tool("media.paged.test.tool.pen"));
        return {
          dispose() {
            throw new Error("bundle teardown bug");
          },
        };
      },
    });
    const loaded = loadBundle(() => fake.editor, bundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(() => loaded.dispose()).toThrow("bundle teardown bug");
    expect(fake.tools.ids()).toHaveLength(0);
  });
});
