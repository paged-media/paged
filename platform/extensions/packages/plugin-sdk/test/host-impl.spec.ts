import { describe, expect, it, vi } from "vitest";

import type { PluginManifest, ToolContribution } from "@paged-media/plugin-api";

import {
  createBundleHost,
  HOST_FEATURES,
  PluginCapabilityError,
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

// A manifest that DECLARES the one tool the loadBundle wiring tests
// register — so those tests run under the default 'enforce' mode and
// still pass (the bundle's manifest is truthful).
const DECLARED_MANIFEST: PluginManifest = {
  ...MANIFEST,
  contributes: { tools: ["media.paged.test.tool.pen"] },
};

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// These door-mechanics tests run in capabilityMode 'warn' (they cover
// the doors themselves, not the declaration gate — which has its own
// describe block below). 'warn' lets a capability-less manifest drive
// every door while still logging the drift.
function host(fake = makeFakeEditor()) {
  const handle = createBundleHost(() => fake.editor, MANIFEST, {
    console: silent,
    storage: mapBacking(),
    capabilityMode: "warn",
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

  it("editContext / objectType are no longer reserved (W3.2) — they register", () => {
    // No shell registry on the fake editor → the adapter takes the
    // recording-stub path; the door no longer throws. (The
    // capability/namespace surface for these doors has its own block.)
    const h = host();
    const d1 = h.host.contribute.editContext({
      type: "vectorGraphic",
      entry: "doubleClick",
      matches: () => true,
    });
    const d2 = h.host.contribute.objectType({
      type: "webFrame",
      bakedFallback: "rectangle",
      matches: () => true,
    });
    expect(typeof d1.dispose).toBe("function");
    expect(typeof d2.dispose).toBe("function");
    // Both are tracked by the host's DisposableStore (dispose is a no-op
    // here but must not throw).
    d1.dispose();
    d2.dispose();
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

  it("setToolPreview accepts the B-07 path/cubic variant verbatim", () => {
    const h = host();
    // True anchor/handle run (no flattening): a curved open segment.
    const preview = {
      pageId: "p1",
      anchors: [
        {
          anchor: [10, 10] as [number, number],
          left: [10, 10] as [number, number],
          right: [30, 10] as [number, number],
        },
        {
          anchor: [50, 10] as [number, number],
          left: [40, 30] as [number, number],
          right: [50, 10] as [number, number],
        },
      ],
      close: false,
    };
    h.host.overlay.setToolPreview(preview);
    // The door passes the cubic shape through UNTOUCHED — segment data,
    // not sampled points (B-07: the renderer draws real Béziers).
    expect(h.fake.getToolPreview()).toEqual(preview);
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
    // W3.2 un-reserved both doors — they are now in HOST_FEATURES.
    expect(h.host.supports("contribute.editContext@1")).toBe(true);
    expect(h.host.supports("contribute.objectType@1")).toBe(true);
    // An unimplemented feature still answers false.
    expect(h.host.supports("contribute.nonexistent@9")).toBe(false);
  });
});

describe("diagnostics — host problems-panel fan-out (W-05)", () => {
  it("set/clear publish to an injected sink keyed by (bundleId, key)", () => {
    const fake = makeFakeEditor();
    const published: Array<[string, string, number]> = [];
    const cleared: Array<[string, string | undefined]> = [];
    const handle = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      storage: mapBacking(),
      diagnosticsSink: {
        publish: (bundleId, key, diags) =>
          published.push([bundleId, key, diags.length]),
        clear: (bundleId, key) => cleared.push([bundleId, key]),
      },
    });

    handle.host.diagnostics.set("frame:u1", [
      { severity: "error", message: "page JavaScript never executes", line: 2 },
      { severity: "warning", message: "<p> is never closed", line: 1 },
    ]);
    // Fans out under THIS plugin's id — the panel attributes + de-dupes
    // by it (and click-to-focus resolves the owning panel from it).
    expect(published).toEqual([["media.paged.test", "frame:u1", 2]]);

    handle.host.diagnostics.clear("frame:u1");
    expect(cleared).toEqual([["media.paged.test", "frame:u1"]]);

    // The per-bundle store + onDidChange round-trip is unchanged by the
    // sink (it is a fan-out, not a replacement).
    handle.host.diagnostics.set("frame:u1", [
      { severity: "info", message: "empty web frame" },
    ]);
    expect(handle.host.diagnostics.get("frame:u1")).toHaveLength(1);
    handle.dispose();
  });

  it("supports('diagnostics.publish@1') only with a sink", () => {
    const h = host();
    expect(h.host.supports("diagnostics.publish@1")).toBe(false);
    const fake = makeFakeEditor();
    const withSink = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      storage: mapBacking(),
      diagnosticsSink: { publish: () => {}, clear: () => {} },
    });
    expect(withSink.host.supports("diagnostics.publish@1")).toBe(true);
    withSink.dispose();
  });
});

describe("widgets — host code-editor catalog (W-04)", () => {
  it("defaults to a textarea fallback; supports() answers false", () => {
    const h = host();
    expect(typeof h.host.widgets.CodeEditor).toBe("function");
    expect(h.host.supports("widgets.codeEditor@1")).toBe(false);
  });

  it("uses the injected catalog and flips the feature flag", () => {
    const fake = makeFakeEditor();
    const Injected = () => null;
    const handle = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      storage: mapBacking(),
      widgets: { CodeEditor: Injected },
    });
    expect(handle.host.widgets.CodeEditor).toBe(Injected);
    expect(handle.host.supports("widgets.codeEditor@1")).toBe(true);
    handle.dispose();
  });
});

describe("loadBundle", () => {
  it("activates, then dispose() runs bundle + facade teardown", () => {
    const fake = makeFakeEditor();
    const bundleDispose = vi.fn();
    const bundle = defineBundle({
      manifest: DECLARED_MANIFEST,
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
      manifest: DECLARED_MANIFEST,
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

describe("document.getMetadata / setMetadata (protocol v33)", () => {
  const KEY = "x-paged:media.paged.test";

  it("setMetadata writes the derived key + serialized envelope through mutate", async () => {
    const h = host();
    const out = await h.host.document.setMetadata(
      { kind: "textFrame", id: "u10" } as never,
      { v: 1, data: { source: "<b>hi</b>" } },
    );
    expect(out.applied).toBe(true);
    expect(h.fake.mutations).toEqual([
      {
        op: "setPluginMetadata",
        args: {
          elementId: { kind: "textFrame", id: "u10" },
          key: KEY,
          value: '{"v":1,"data":{"source":"<b>hi</b>"}}',
        },
      },
    ]);
  });

  it("setMetadata(null) clears the entry", async () => {
    const h = host();
    await h.host.document.setMetadata({ kind: "textFrame", id: "u10" } as never, null);
    expect(
      (h.fake.mutations[0] as { args: { value: unknown } }).args.value,
    ).toBeNull();
  });

  it("getMetadata reads only this plugin's namespace and parses the envelope", async () => {
    const h = host();
    h.fake.setElementProperties({
      kind: "elementProperties",
      payload: {
        result: {
          id: { kind: "textFrame", id: "u10" },
          kind: "TextFrame",
          entries: [
            {
              path: "frameBounds",
              value: { type: "bounds", value: [0, 0, 10, 10] },
            },
            {
              path: "pluginMetadata",
              value: {
                type: "pluginMetadata",
                value: {
                  key: "x-paged:other.plugin",
                  value: '{"v":9,"data":{"theirs":true}}',
                },
              },
            },
            {
              path: "pluginMetadata",
              value: {
                type: "pluginMetadata",
                value: { key: KEY, value: '{"v":1,"data":{"mine":true}}' },
              },
            },
          ],
        },
      },
    });
    const envelope = await h.host.document.getMetadata({
      textFrame: "u10",
    } as never);
    expect(envelope).toEqual({ v: 1, data: { mine: true } });
  });

  it("getMetadata returns null when absent", async () => {
    const h = host();
    const envelope = await h.host.document.getMetadata({
      textFrame: "u10",
    } as never);
    expect(envelope).toBeNull();
  });
});

describe("raw-mutate namespace gate (v34)", () => {
  const KEY = "x-paged:media.paged.test";

  it("rejects setPluginMetadata outside the plugin's namespace", async () => {
    const h = host();
    const out = await h.host.document.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "rectangle", id: "u1" },
        key: "x-paged:other.plugin",
        value: '{"v":1,"data":{}}',
      },
    } as never);
    expect(out.applied).toBe(false);
    expect(h.fake.mutations).toHaveLength(0);
  });

  it("rejects foreign keys nested in batches; allows own key", async () => {
    const h = host();
    const bad = await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "setPluginMetadata",
            args: {
              elementId: { kind: "rectangle", id: "$created" },
              key: "x-paged:other.plugin",
              value: '{"v":1,"data":{}}',
            },
          },
        ],
      },
    } as never);
    expect(bad.applied).toBe(false);

    const ok = await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "insertFrame",
            args: { pageId: "p1", bounds: [0, 0, 10, 10] },
          },
          {
            op: "setPluginMetadata",
            args: {
              elementId: { kind: "rectangle", id: "$created" },
              key: KEY,
              value: '{"v":1,"data":{}}',
            },
          },
        ],
      },
    } as never);
    expect(ok.applied).toBe(true);
    expect(h.fake.mutations).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Capability-scope ENFORCEMENT (W3.10 / trust-line W0.11): a door a
// bundle USES must be DECLARED in its manifest. Per chokepoint:
// declared → allowed, undeclared → typed error (or non-applied outcome
// for the write doors), warn-mode → logs + proceeds.

const baseManifest = (
  overrides: Partial<PluginManifest>,
): PluginManifest => ({
  id: "media.paged.cap",
  name: "cap",
  version: "1.0.0",
  apiVersion: "^0.2",
  ...overrides,
});

const capHost = (
  manifest: PluginManifest,
  mode: "enforce" | "warn" = "enforce",
  log?: Pick<Console, "debug" | "info" | "warn" | "error">,
) => {
  const fake = makeFakeEditor();
  const handle = createBundleHost(() => fake.editor, manifest, {
    console: log ?? silent,
    storage: mapBacking(),
    capabilityMode: mode,
  });
  return { ...handle, fake };
};

const cTool = (id: string): ToolContribution =>
  ({ id, title: "T", icon: "i", group: "g", section: "drawType" }) as ToolContribution;

describe("capability gate — contribution doors", () => {
  it("contribute.tool: declared id allowed", () => {
    const h = capHost(
      baseManifest({ contributes: { tools: ["media.paged.cap.tool.pen"] } }),
    );
    expect(() => h.host.contribute.tool(cTool("media.paged.cap.tool.pen"))).not.toThrow();
    expect(h.fake.tools.ids()).toEqual(["media.paged.cap.tool.pen"]);
  });

  it("contribute.tool: undeclared id throws PluginCapabilityError", () => {
    const h = capHost(baseManifest({ contributes: { tools: [] } }));
    let err: unknown;
    try {
      h.host.contribute.tool(cTool("media.paged.cap.tool.pen"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginCapabilityError);
    expect((err as PluginCapabilityError).door).toBe("contribute.tool");
    expect((err as PluginCapabilityError).missingDeclaration).toMatch(
      /contributes\.tools\[\] must include "media\.paged\.cap\.tool\.pen"/,
    );
    expect(h.fake.tools.ids()).toHaveLength(0);
  });

  it("contribute.tool: warn mode logs and proceeds", () => {
    const warns: string[] = [];
    const log = { ...silent, warn: (m: string) => void warns.push(m) };
    const h = capHost(baseManifest({ contributes: { tools: [] } }), "warn", log);
    expect(() => h.host.contribute.tool(cTool("media.paged.cap.tool.pen"))).not.toThrow();
    expect(h.fake.tools.ids()).toEqual(["media.paged.cap.tool.pen"]);
    expect(warns.some((w) => /contribute\.tool used without declaring/.test(w))).toBe(true);
  });

  it("contribute.panel: declared allowed / undeclared throws", () => {
    const ok = capHost(
      baseManifest({ contributes: { panels: ["media.paged.cap.panel.x"] } }),
    );
    expect(() =>
      ok.host.contribute.panel({
        id: "media.paged.cap.panel.x",
      } as never),
    ).not.toThrow();
    const bad = capHost(baseManifest({}));
    expect(() =>
      bad.host.contribute.panel({ id: "media.paged.cap.panel.x" } as never),
    ).toThrow(PluginCapabilityError);
  });

  it("contribute.command: declared allowed / undeclared throws", () => {
    const ok = capHost(
      baseManifest({ contributes: { commands: ["media.paged.cap.cmd.x"] } }),
    );
    expect(() =>
      ok.host.contribute.command({ id: "media.paged.cap.cmd.x" } as never),
    ).not.toThrow();
    const bad = capHost(baseManifest({ contributes: { commands: [] } }));
    expect(() =>
      bad.host.contribute.command({ id: "media.paged.cap.cmd.x" } as never),
    ).toThrow(/contributes\.commands\[\] must include/);
  });

  it("contribute.keybinding: gated on capabilities.keybindings", () => {
    const ok = capHost(baseManifest({ capabilities: { keybindings: true } }));
    expect(() =>
      ok.host.contribute.keybinding({ key: "p", command: "media.paged.cap.cmd.x" }),
    ).not.toThrow();
    const bad = capHost(baseManifest({}));
    expect(() =>
      bad.host.contribute.keybinding({ key: "p", command: "media.paged.cap.cmd.x" }),
    ).toThrow(/capabilities\.keybindings must be true/);
  });

  it("contribute.overlay: gated on rendering 'overlay'", () => {
    const ok = capHost(baseManifest({ capabilities: { rendering: ["overlay"] } }));
    expect(() =>
      ok.host.contribute.overlay({ id: "media.paged.cap.overlay.x" } as never),
    ).not.toThrow();
    const bad = capHost(baseManifest({ capabilities: { rendering: [] } }));
    expect(() =>
      bad.host.contribute.overlay({ id: "media.paged.cap.overlay.x" } as never),
    ).toThrow(/capabilities\.rendering must include "overlay"/);
  });

  it("namespace rule still fires FIRST (before the capability gate)", () => {
    const h = capHost(baseManifest({ contributes: { tools: [] } }));
    // A foreign id trips the namespace gate (plain Error), not the
    // capability gate — the namespace rule is the outer guard.
    expect(() => h.host.contribute.tool(cTool("other.tool.pen"))).toThrow(
      /must be namespaced/,
    );
  });
});

describe("capability gate — document doors", () => {
  it("write doors: declared write allowed", async () => {
    const h = capHost(baseManifest({ capabilities: { document: { write: "broad" } } }));
    const out = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: "p1", bounds: [0, 0, 1, 1] },
    } as never);
    expect(out.applied).toBe(true);
  });

  it("mutate without document.write → non-applied outcome (never throws)", async () => {
    const h = capHost(baseManifest({ capabilities: { document: { read: "broad" } } }));
    const out = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: "p1", bounds: [0, 0, 1, 1] },
    } as never);
    expect(out.applied).toBe(false);
    if (!out.applied) {
      expect(String(out.error)).toMatch(/document\.mutate requires capabilities\.document\.write/);
    }
    // The engine never saw the mutation.
    expect(h.fake.mutations).toHaveLength(0);
  });

  it("mutate in warn mode proceeds despite no write capability", async () => {
    const warns: string[] = [];
    const log = { ...silent, warn: (m: string) => void warns.push(m) };
    const h = capHost(baseManifest({}), "warn", log);
    const out = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: "p1", bounds: [0, 0, 1, 1] },
    } as never);
    expect(out.applied).toBe(true);
    expect(warns.some((w) => /document\.mutate requires/.test(w))).toBe(true);
  });

  it("undo/redo gated on document.write (throw when undeclared)", async () => {
    const h = capHost(baseManifest({ capabilities: { document: { read: "broad" } } }));
    await expect(h.host.document.undo()).rejects.toThrow(PluginCapabilityError);
    await expect(h.host.document.redo()).rejects.toThrow(PluginCapabilityError);
  });

  it("read doors: declared read allowed / undeclared throws", async () => {
    const ok = capHost(baseManifest({ capabilities: { document: { read: "broad" } } }));
    await expect(ok.host.document.meta()).resolves.toBeDefined();
    await expect(ok.host.document.collection("pages")).resolves.toBeDefined();
    await expect(ok.host.document.tree()).resolves.toBeDefined();

    const bad = capHost(baseManifest({ capabilities: { document: { write: "broad" } } }));
    // meta/collection/elementGeometry map 1:1 to the client and gate
    // synchronously (a thrown error, the door-mechanics shape); tree is
    // async and rejects. Both forms name the missing read declaration.
    expect(() => bad.host.document.meta()).toThrow(PluginCapabilityError);
    expect(() => bad.host.document.collection("pages")).toThrow(
      /capabilities\.document\.read must be declared/,
    );
    expect(() => bad.host.document.elementGeometry([])).toThrow(
      PluginCapabilityError,
    );
    await expect(bad.host.document.tree()).rejects.toThrow(
      /capabilities\.document\.read must be declared/,
    );
    await expect(bad.host.document.getMetadata({} as never)).rejects.toThrow(
      PluginCapabilityError,
    );
  });

  it("hitTest needs BOTH document.read AND rendering 'hitTest'", async () => {
    const full = capHost(
      baseManifest({
        capabilities: { document: { read: "broad" }, rendering: ["hitTest"] },
      }),
    );
    await expect(full.host.document.hitTest("p1", [1, 2])).resolves.toEqual({
      element: null,
    });
    // read but no rendering hitTest → throws.
    const noRender = capHost(
      baseManifest({ capabilities: { document: { read: "broad" } } }),
    );
    await expect(noRender.host.document.hitTest("p1", [1, 2])).rejects.toThrow(
      /capabilities\.rendering must include "hitTest"/,
    );
    // rendering hitTest but no read → throws (read gate fires first).
    const noRead = capHost(
      baseManifest({ capabilities: { rendering: ["hitTest"] } }),
    );
    await expect(noRead.host.document.hitTest("p1", [1, 2])).rejects.toThrow(
      /capabilities\.document\.read/,
    );
  });

  it("setMetadata rides the write gate (non-applied when undeclared)", async () => {
    const h = capHost(baseManifest({ capabilities: { document: { read: "broad" } } }));
    const out = await h.host.document.setMetadata(
      { kind: "rectangle", id: "u1" } as never,
      { v: 1, data: {} },
    );
    expect(out.applied).toBe(false);
    expect(h.fake.mutations).toHaveLength(0);
  });
});

describe("capability gate — selection / overlay", () => {
  it("selection.get + onDidChange always allowed (ambient UI state)", () => {
    const h = capHost(baseManifest({}));
    expect(() => h.host.selection.get()).not.toThrow();
    expect(() => h.host.selection.onDidChange(() => {})).not.toThrow();
  });

  it("selection.set gated on document.write", async () => {
    const ok = capHost(baseManifest({ capabilities: { document: { write: "broad" } } }));
    await expect(ok.host.selection.set([])).resolves.toEqual([]);
    const bad = capHost(baseManifest({}));
    await expect(bad.host.selection.set([])).rejects.toThrow(PluginCapabilityError);
  });

  it("overlay.setToolPreview gated on rendering 'overlay'", () => {
    const ok = capHost(baseManifest({ capabilities: { rendering: ["overlay"] } }));
    expect(() => ok.host.overlay.setToolPreview(null)).not.toThrow();
    const bad = capHost(baseManifest({}));
    expect(() => bad.host.overlay.setToolPreview(null)).toThrow(
      /capabilities\.rendering must include "overlay"/,
    );
  });

  it("viewport / storage / diagnostics need no capability", () => {
    const h = capHost(baseManifest({}));
    expect(() => h.host.viewport.camera()).not.toThrow();
    expect(() => h.host.storage.set("k", 1)).not.toThrow();
    expect(() => h.host.diagnostics.set("k", [])).not.toThrow();
  });
});
