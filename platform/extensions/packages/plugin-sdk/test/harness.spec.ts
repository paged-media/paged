// Headless conformance harness (B-13 RESOLVED). These tests stand on the
// REAL published engine wasm booted in Node — not a fake host. They pin:
//   · the loader boots the wasm + the protocol handshake matches the
//     vendored wire stamp (fail loudly on a wasm/wire skew);
//   · the document doors round-trip through the true engine (mutate +
//     undo), and the metadata namespace gate still bites headlessly;
//   · contributions are recorded in an assertable log;
//   · dispose is honest (empties the log, frees the engine).
//
// No browser, no editor, no UI. If the published package isn't installed
// the loader throws by design (no warn-skip) — so a green run here means
// a real engine actually replayed the operations.

import { afterEach, describe, expect, it } from "vitest";

import type {
  BundleHost,
  PagedBundle,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import {
  protocolFromVersion,
  readVendoredWireVersion,
  resolveCanvasWasm,
} from "../src/wasm-loader";
import { defineBundle } from "../src/define-bundle";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

const open = (): Promise<HeadlessHost> =>
  createHeadlessHost({ console: silent, storage: mapBacking() });

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

// The first leaf rectangle in the fixture (Self="urect").
const RECT = { kind: "rectangle", id: "urect" } as const;

describe("wasm-loader — boot + protocol pin", () => {
  it("resolves the published package and stamps a version", async () => {
    const r = await resolveCanvasWasm();
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.wasmPath).toMatch(/paged_canvas_wasm_bg\.wasm$/);
  });

  it("the vendored wire stamp pins the protocol the loader expects", async () => {
    const stamped = await readVendoredWireVersion();
    expect(stamped).not.toBeNull();
    const proto = protocolFromVersion(stamped!);
    // package minor IS the wire protocol (0.<protocol>.<patch>).
    expect(proto).toBe(Number(stamped!.split(".")[1]));
  });

  it("boots and the handshake matches the stamped wire (no skew)", async () => {
    live = await open();
    const stamped = await readVendoredWireVersion();
    expect(live.protocolVersion).toBe(protocolFromVersion(stamped!));
    // The resolved package version's minor agrees with the booted proto.
    expect(protocolFromVersion(live.engineVersion)).toBe(live.protocolVersion);
  });

  it("a wrong expected-protocol assertion fails loudly", async () => {
    await expect(
      createHeadlessHost({
        console: silent,
        storage: mapBacking(),
        expectedProtocol: 9999,
      }),
    ).rejects.toThrow(/protocol mismatch/i);
  });
});

describe("headless document doors — real engine round-trip", () => {
  it("loads the fixture IDML and returns page ids", async () => {
    live = await open();
    const pageIds = await live.load(minimalIdml());
    expect(pageIds).toEqual(["usp"]);
  });

  it("mutate applies through the engine and reports a createdId", async () => {
    live = await open();
    const [pageId] = await live.load(minimalIdml());
    const out = await live.host.document.mutate({
      op: "insertFrame",
      args: { pageId, bounds: [10, 10, 60, 60] },
    } as never);
    expect(out.applied).toBe(true);
    if (out.applied) {
      expect(out.createdId).not.toBeNull();
      expect(out.pageIds).toContain(pageId);
    }
  });

  it("undo reverses an applied mutation (shared engine history)", async () => {
    live = await open();
    await live.load(minimalIdml());
    const countLeaves = async () => {
      const tree = await live!.host.document.tree();
      let n = 0;
      const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
        for (const node of nodes) {
          if (node.id) n++;
          if (node.children) walk(node.children as never);
        }
      };
      walk(tree as never);
      return n;
    };
    const before = await countLeaves();
    await live.host.document.mutate({
      op: "insertFrame",
      args: { pageId: "usp", bounds: [20, 20, 40, 40] },
    } as never);
    expect(await countLeaves()).toBe(before + 1);
    await live.host.document.undo();
    expect(await countLeaves()).toBe(before);
  });

  it("setMetadata writes + getMetadata reads back this plugin's envelope", async () => {
    live = await open();
    await live.load(minimalIdml());
    const bundle = bundleFor("media.paged.draw");
    live.loadBundle(bundle);
    const set = await live.host.document.setMetadata(RECT as never, {
      v: 1,
      data: { shape: "rect" },
    });
    expect(set.applied).toBe(true);
    const got = await live.host.document.getMetadata(RECT as never);
    expect(got).toEqual({ v: 1, data: { shape: "rect" } });
  });

  it("metadata namespace gate STILL bites headlessly (raw foreign key)", async () => {
    live = await open();
    await live.load(minimalIdml());
    live.loadBundle(bundleFor("media.paged.draw"));
    // A raw setPluginMetadata for ANOTHER plugin's key is refused at the
    // SDK door before it ever reaches the engine — same gate as in-process.
    const out = await live.host.document.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: RECT,
        key: "x-paged:other.plugin",
        value: '{"v":1,"data":{}}',
      },
    } as never);
    expect(out.applied).toBe(false);
    // And the engine never saw it: the rectangle carries no foreign meta.
    const got = await live.host.document.getMetadata(RECT as never);
    expect(got).toBeNull();
  });
});

describe("contribution recording + dispose honesty", () => {
  it("records tool/panel/command contributions in an assertable log", async () => {
    live = await open();
    const host = (await loaded()).host;
    host.contribute.tool(toolC("media.paged.harness.tool.pen"));
    host.contribute.panel(panelC("media.paged.harness.panel.layers"));
    host.contribute.command(cmdC("media.paged.harness.cmd.x"));
    expect(live!.contributions.map((c) => c.kind)).toEqual([
      "tool",
      "panel",
      "command",
    ]);
    expect(live!.toolsContributed().map((t) => t.id)).toEqual([
      "media.paged.harness.tool.pen",
    ]);
    expect(live!.panelsContributed().map((p) => p.id)).toEqual([
      "media.paged.harness.panel.layers",
    ]);
  });

  it("namespace rule is enforced headlessly too", async () => {
    const host = (await loaded()).host;
    expect(() => host.contribute.tool(toolC("foreign.tool.pen"))).toThrow(
      /must be namespaced/,
    );
  });

  it("an individual disposable removes its log entry", async () => {
    const host = (await loaded()).host;
    const d = host.contribute.tool(toolC("media.paged.harness.tool.a"));
    expect(live!.contributions).toHaveLength(1);
    d.dispose();
    expect(live!.contributions).toHaveLength(0);
  });

  it("loadBundle teardown empties the contribution log (honesty)", async () => {
    live = await open();
    let activated: BundleHost | null = null;
    const bundle = defineBundle({
      manifest: manifestFor("media.paged.proof"),
      activate(h) {
        activated = h;
        h.contribute.tool(toolC("media.paged.proof.tool.pen"));
        h.contribute.tool(toolC("media.paged.proof.tool.node"));
        return { dispose() {} };
      },
    });
    const handle = live.loadBundle(bundle);
    expect(activated).not.toBeNull();
    expect(live.toolsContributed()).toHaveLength(2);
    handle.dispose();
    expect(live.contributions).toHaveLength(0);
  });

  it("dispose() frees the engine and empties the log", async () => {
    const h = await open();
    (await loadedWith(h)).host.contribute.tool(
      toolC("media.paged.harness.tool.z"),
    );
    expect(h.contributions).toHaveLength(1);
    h.dispose();
    expect(h.contributions).toHaveLength(0);
    // After dispose the engine handle is freed; re-dispose is a no-op.
    expect(() => h.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------- helpers

async function loaded(): Promise<HeadlessHost> {
  live = await open();
  return live;
}
async function loadedWith(h: HeadlessHost): Promise<HeadlessHost> {
  return h;
}

function manifestFor(id: string): PluginManifest {
  // Declare the capabilities these conformance tests exercise (document
  // read+write for the metadata round-trip; the inline contributions
  // these bundles register). Capability enforcement is on by default
  // now (trust-line W0.11); a manifest must declare what its bundle
  // touches, so the conformance fixtures declare it too.
  return {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: "^0.2",
    capabilities: { document: { read: "broad", write: "broad" } },
    contributes: {
      tools: [`${id}.tool.pen`, `${id}.tool.node`],
    },
  };
}
function bundleFor(id: string): PagedBundle {
  return defineBundle({
    manifest: manifestFor(id),
    activate: () => ({ dispose() {} }),
  });
}
const toolC = (id: string) =>
  ({
    id,
    title: "T",
    icon: "i",
    group: "g",
    section: "drawType",
  }) as never;
const panelC = (id: string) =>
  ({ id, title: "P", component: (() => null) as never }) as never;
const cmdC = (id: string) =>
  ({ id, title: "C", handler: () => undefined }) as never;
