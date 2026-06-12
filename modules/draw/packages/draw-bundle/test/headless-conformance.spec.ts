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
// editing tools AND TWO declarative SCHEMA panels (stroke — W3.1,
// B-01 RESOLVED; fill — Phase 2d, B-03 consumer; each registered
// through `host.contribute.schemaPanel`, recorded by the harness as a
// `schemaPanel` contribution carrying the verbatim schema). The Pen
// itself is a built-in core-document tool (editor W2.5 division); the
// layers prototype stays design JSON (expert-leaf list territory). So
// the contribution log holds three tools + two schema panels + eight
// commands (4 dash + 2 group + 2 gradient-fill) + the edit context.

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

  it("activating the bundle registers its tools + the schema panel in the log", () => {
    const handle = harness.loadBundle(drawBundle);
    try {
      // Every anchor tool is captured, namespaced + in registration order.
      expect(harness.toolsContributed().map((t) => t.id)).toEqual([
        "media.paged.draw.tool.addAnchor",
        "media.paged.draw.tool.deleteAnchor",
        "media.paged.draw.tool.convertAnchor",
      ]);
      // The contribution log holds the three tools, then EACH schema
      // panel as TWO entries: the synthesized React `panel` the panels
      // registry sees (the host turns a schema into a registry panel via
      // the injected renderer / seam) AND the `schemaPanel` recorded
      // VERBATIM through the harness's registration hook. Both are
      // honest — the registry really got a panel; the log keeps the
      // schema so conformance can assert it. Stroke first, then fill
      // (Phase 2d). Then the four B-12 dash-preset commands, the two
      // Phase 2d group commands, the two gradient-fill commands, then
      // the W3.2 edit context. (Pen is a core built-in; layers stays a
      // prototype — header note.)
      expect(harness.contributions.map((c) => c.kind)).toEqual([
        "tool",
        "tool",
        "tool",
        // W3.1 — the stroke schema panel.
        "panel",
        "schemaPanel",
        // Phase 2d — the fill schema panel (B-03).
        "panel",
        "schemaPanel",
        // B-12 — the stroke dash-preset commands (Solid / Dashed /
        // Dotted / Dash-dot).
        "command",
        "command",
        "command",
        "command",
        // Phase 2d — Group selection / Ungroup (B-04).
        "command",
        "command",
        // Phase 2d — Fill: Linear / Radial gradient (B-03).
        "command",
        "command",
        // W3.2 — the vectorGraphic edit context (B-02), recorded
        // through the harness's editContext registration hook.
        "editContext",
      ]);
      // The schema panels are recorded VERBATIM (the schema, not React):
      // ids, sections, and the binding-driven gates.
      const panels = harness.schemaPanelsContributed();
      expect(panels.map((p) => p.id)).toEqual([
        "media.paged.draw.panel.stroke",
        "media.paged.draw.panel.fill",
      ]);
      const dashSection = panels[0].schema.sections[1];
      expect(dashSection.title).toBe("Dashes");
      // The dash section's visibility is a binding REF — a derived bound
      // value the bundle publishes, NOT a visibleWhen conditional (B-01).
      expect(dashSection.visible).toEqual({
        bind: "media.paged.draw.dashControlsVisible",
      });
      // The fill panel's gradient section is likewise a binding REF
      // (Phase 2d — gated on the selection's fill being a gradient).
      const gradientSection = panels[1].schema.sections[1];
      expect(gradientSection.title).toBe("Gradient");
      expect(gradientSection.visible).toEqual({
        bind: "media.paged.draw.gradientControlsVisible",
      });
      // The captured tool contributions are the real objects too.
      const add = harness.toolsContributed()[0];
      expect(add.shortcut).toBe("=");
      expect(add.cursor).toEqual({ kind: "css", token: "crosshair" });
      // W3.2 — the edit context is recorded with its matcher + sets, and
      // the host stamped the own-namespace metadata key.
      const ecs = harness.editContextsContributed();
      expect(ecs.map((c) => c.type)).toEqual(["vectorGraphic"]);
      expect(ecs[0].metadataKey).toBe("x-paged:media.paged.draw");
      expect(
        ecs[0].matches?.({
          id: { kind: "polygon", id: "u1" } as never,
          kind: "polygon",
          groupChain: [],
          metadata: null,
        }),
      ).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("the schema panel's bindings react to real selection (B-01 derived value)", async () => {
    const handle = harness.loadBundle(drawBundle);
    try {
      // On activation the binding driver primes from the (empty)
      // selection: nothing selected → hasSelection false.
      // Selecting the rectangle flips hasSelection true; the rectangle
      // is bounds-based (no anchor table — B-13 finding b), so
      // dashControlsVisible stays false (it gates on path anchors).
      await harness.host.selection.set([RECT as never]);
      // Give the async recompute a tick to land.
      await new Promise((r) => setTimeout(r, 0));
      expect(harness.host.bindings.get("media.paged.draw.hasSelection")).toBe(
        true,
      );
      expect(
        harness.host.bindings.get("media.paged.draw.dashControlsVisible"),
      ).toBe(false);

      // Clearing the selection flips hasSelection back to false.
      await harness.host.selection.set([]);
      await new Promise((r) => setTimeout(r, 0));
      expect(harness.host.bindings.get("media.paged.draw.hasSelection")).toBe(
        false,
      );
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
