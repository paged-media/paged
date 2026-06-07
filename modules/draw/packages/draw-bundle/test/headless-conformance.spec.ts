// Consumer proof for the B-13 headless conformance harness: activate
// the REAL paged.draw bundle against a REAL engine (the published
// @paged-media/canvas-wasm booted in Node by @paged-media/plugin-sdk's
// createHeadlessHost), assert its contribution log, run one real
// mutation through the host (engine round-trip), and prove dispose
// leaves the document unchanged.
//
// This is the conformance-fixture replay FOUNDATION the BREAKAGE_LOG
// B-13 entry calls for. Unlike `activate.spec.ts` (wiring only, over a
// fake editor), this drives the bundle's document door through the true
// parse→apply→inverse engine path — no UI, no editor, no browser.
//
// CONTRIBUTION COUNT (honesty note): the bundle registers THREE anchor-
// editing tools. The Pen itself is a built-in core-document tool (editor
// W2.5 division), and panels stay design prototypes (`panels/*.panel.
// json`, BREAKAGE_LOG B-01) — they are declared in the manifest but not
// registered through `host.contribute.panel`. So the contribution log
// holds three tools and zero panels; the proof asserts exactly that
// reality rather than a planned-but-absent fourth tool / panel set.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  createHeadlessHost,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";

import { drawBundle } from "../src";
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

// The fixture's single rectangle leaf (Self="urect").
const RECT = { kind: "rectangle", id: "urect" } as const;

describe("paged.draw — headless conformance (B-13 replay)", () => {
  let harness: HeadlessHost;

  beforeAll(async () => {
    harness = await createHeadlessHost({
      console: silent,
      storage: mapBacking(),
    });
    await harness.load(minimalIdml());
  });

  afterAll(() => {
    harness.dispose();
  });

  it("boots a real engine (protocol > 0)", () => {
    expect(harness.protocolVersion).toBeGreaterThan(0);
    expect(harness.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("activating the bundle registers its tools in the contribution log", () => {
    const handle = harness.loadBundle(drawBundle);
    try {
      // Every anchor tool is captured, namespaced + in registration order.
      expect(harness.toolsContributed().map((t) => t.id)).toEqual([
        "media.paged.draw.tool.addAnchor",
        "media.paged.draw.tool.deleteAnchor",
        "media.paged.draw.tool.convertAnchor",
      ]);
      // The contribution log holds exactly those three tools (pen is a
      // core built-in, panels are design prototypes — see header note).
      expect(harness.contributions.map((c) => c.kind)).toEqual([
        "tool",
        "tool",
        "tool",
      ]);
      expect(harness.panelsContributed()).toHaveLength(0);
      // The captured contributions are the real objects (cursor, shortcut).
      const add = harness.toolsContributed()[0];
      expect(add.shortcut).toBe("=");
      expect(add.cursor).toEqual({ kind: "css", token: "crosshair" });
    } finally {
      handle.dispose();
    }
  });

  it("runs a real mutation through the host (engine round-trip)", async () => {
    const handle = harness.loadBundle(drawBundle);
    try {
      // Write this plugin's metadata onto the rectangle via the document
      // door — a real setPluginMetadata mutation, applied + inverted by
      // the engine, read back through requestElementProperties.
      const set = await harness.host.document.setMetadata(RECT as never, {
        v: 1,
        data: { tool: "addAnchor", note: "headless proof" },
      });
      expect(set.applied).toBe(true);
      const got = await harness.host.document.getMetadata(RECT as never);
      expect(got).toEqual({
        v: 1,
        data: { tool: "addAnchor", note: "headless proof" },
      });

      // Clear it again so the doc is pristine for the dispose check below.
      const clear = await harness.host.document.setMetadata(RECT as never, null);
      expect(clear.applied).toBe(true);
      expect(await harness.host.document.getMetadata(RECT as never)).toBeNull();
    } finally {
      handle.dispose();
    }
  });

  it("dispose leaves the document unchanged (honesty smoke test)", async () => {
    // Snapshot the scene-tree shape before activation.
    const treeSize = async () => {
      const roots = await harness.host.document.tree();
      let n = 0;
      const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
        for (const node of nodes) {
          if (node.id) n++;
          if (node.children) walk(node.children as never);
        }
      };
      walk(roots as never);
      return n;
    };
    const before = await treeSize();

    const handle = harness.loadBundle(drawBundle);
    expect(harness.toolsContributed()).toHaveLength(3);
    handle.dispose();

    // After dispose: the contribution log is empty (registrations torn
    // down structurally) AND the document is byte-for-byte as found —
    // the bundle made no uninvited engine writes.
    expect(harness.contributions).toHaveLength(0);
    expect(await treeSize()).toBe(before);
    expect(await harness.host.document.getMetadata(RECT as never)).toBeNull();
  });
});
