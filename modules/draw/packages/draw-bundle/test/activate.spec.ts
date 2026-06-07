// Registration-wiring test: activate the real bundle against the
// real in-process host adapter over a minimal fake editor. Covers
// the D3 contract — three anchor tools (activation commands +
// shortcuts host-derived per B-15) AND the W3.1 declarative stroke
// SCHEMA panel — and the honesty smoke test (dispose leaves the
// registries empty). Engine behavior is NOT faked here (that's the
// reserved harness's job); this exercises wiring only.

import { describe, expect, it } from "vitest";

import type { PagedEditor } from "@paged-media/plugin-api";
import { loadBundle } from "@paged-media/plugin-sdk";

import { drawBundle } from "../src";

function fakeRegistry() {
  const byId = new Map<string, unknown>();
  return {
    ids: () => Array.from(byId.keys()),
    register(c: { id: string }) {
      if (byId.has(c.id)) throw new Error(`duplicate id ${c.id}`);
      byId.set(c.id, c);
      return {
        dispose() {
          byId.delete(c.id);
        },
      };
    },
  };
}

function fakeKeybindings() {
  const items: unknown[] = [];
  return {
    count: () => items.length,
    register(c: unknown) {
      items.push(c);
      return {
        dispose() {
          const i = items.indexOf(c);
          if (i >= 0) items.splice(i, 1);
        },
      };
    },
  };
}

// W3.2 — edit-context/object-type registries key off `type`, not `id`.
function fakeTypeRegistry() {
  const byType = new Map<string, { type: string }>();
  return {
    types: () => Array.from(byType.keys()),
    get: (t: string) => byType.get(t),
    register(c: { type: string }) {
      byType.set(c.type, c);
      return {
        dispose() {
          byType.delete(c.type);
        },
      };
    },
  };
}

function makeFakeEditor() {
  const tools = fakeRegistry();
  const commands = fakeRegistry();
  const panels = fakeRegistry();
  const keybindings = fakeKeybindings();
  const editContexts = fakeTypeRegistry();
  const objectTypes = fakeTypeRegistry();
  // Minimal client for the schema panel's binding driver: it subscribes
  // for selection changes and (on a non-empty selection) reads
  // pathAnchors. At install over the empty fake selection it only
  // publishes hasSelection=false, so the stubs below suffice.
  let selectionIds: unknown[] = [];
  const client = {
    subscribe: (_l: (msg: unknown) => void) => () => {},
    pathAnchors: async () => null,
    setElementSelection: async (ids: unknown[]) => ids,
  };
  const editor = {
    client,
    registries: {
      tools,
      commands,
      panels,
      keybindings,
      editContexts,
      objectTypes,
    },
    selection: {
      elementSelection: selectionIds,
      setElementSelection: (ids: unknown[]) => {
        selectionIds = ids;
      },
      setElementGeometry: () => {},
    },
    camera: { camera: { scale: 1, tx: 0, ty: 0 } },
  };
  return {
    editor: editor as unknown as PagedEditor,
    tools,
    commands,
    panels,
    keybindings,
    editContexts,
    objectTypes,
  };
}

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

describe("drawBundle.activate", () => {
  it("registers the 3 anchor tools (pen built-in per W2.5; activation host-derived per B-15)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.tools.ids()).toEqual([
      "media.paged.draw.tool.addAnchor",
      "media.paged.draw.tool.deleteAnchor",
      "media.paged.draw.tool.convertAnchor",
    ]);
    // B-15: activation commands + shortcuts are HOST-derived from
    // the registry — the bundle registers tools only.
    expect(fake.commands.ids()).toEqual([]);
    expect(fake.keybindings.count()).toBe(0);
  });

  it("registers the W3.1 stroke SCHEMA panel (B-01 RESOLVED)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    // The schema panel registers through the panels registry as a
    // synthesized PanelContribution under its declared id.
    expect(fake.panels.ids()).toEqual(["media.paged.draw.panel.stroke"]);
  });

  it("registered ids match the manifest's contributes declaration", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.tools.ids()).toEqual(drawBundle.manifest.contributes?.tools);
    // The schema panel's id matches the manifest's panel declaration.
    expect(fake.panels.ids()).toEqual(drawBundle.manifest.contributes?.panels);
    expect(fake.commands.ids()).toEqual(
      drawBundle.manifest.contributes?.commands ?? [],
    );
  });

  it("registers the W3.2 vectorGraphic edit context (B-02 RESOLVED)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.editContexts.types()).toEqual(["vectorGraphic"]);
    const ec = fake.editContexts.get("vectorGraphic") as unknown as {
      entry: string;
      toolIds: string[];
      panelIds: string[];
      matches?: (c: unknown) => boolean;
      metadataKey?: string;
    };
    expect(ec.entry).toBe("doubleClick");
    // The anchor-editing tool-set the context focuses.
    expect(ec.toolIds).toEqual([
      "media.paged.draw.tool.addAnchor",
      "media.paged.draw.tool.deleteAnchor",
      "media.paged.draw.tool.convertAnchor",
    ]);
    // The stroke panel the cockpit raises on enter.
    expect(ec.panelIds).toEqual(["media.paged.draw.panel.stroke"]);
    // The host stamped the own-namespace metadata key.
    expect(ec.metadataKey).toBe("x-paged:media.paged.draw");
    // Kind-claimed: a polygon matches, an oval (no path) does not.
    expect(ec.matches?.({ kind: "polygon", groupChain: [], metadata: null })).toBe(
      true,
    );
    expect(ec.matches?.({ kind: "oval", groupChain: [], metadata: null })).toBe(
      false,
    );
    // paged.web declares NO objectType here; a webFrame is just a
    // rectangle to draw — rectangles ARE a path kind, so this context
    // claims them. (In the live editor paged.web's objectType claims a
    // webFrame FIRST via metadata; see the resolveDoubleClick ordering.)
    expect(
      ec.matches?.({ kind: "rectangle", groupChain: [], metadata: null }),
    ).toBe(true);
  });

  it("dispose leaves the shell exactly as found (honesty smoke test)", () => {
    const fake = makeFakeEditor();
    const loaded = loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    loaded.dispose();
    expect(fake.tools.ids()).toHaveLength(0);
    expect(fake.panels.ids()).toHaveLength(0);
    expect(fake.commands.ids()).toHaveLength(0);
    expect(fake.keybindings.count()).toBe(0);
    expect(fake.editContexts.types()).toHaveLength(0);
  });
});
