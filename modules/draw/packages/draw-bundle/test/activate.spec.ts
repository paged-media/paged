// Registration-wiring test: activate the real bundle against the
// real in-process host adapter over a minimal fake editor. Covers
// the D3 contract — four tools, four activation commands, four
// guarded shortcuts, and the honesty smoke test (dispose leaves the
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

function makeFakeEditor() {
  const tools = fakeRegistry();
  const commands = fakeRegistry();
  const keybindings = fakeKeybindings();
  const editor = {
    registries: { tools, commands, keybindings },
    camera: { camera: { scale: 1, tx: 0, ty: 0 } },
  };
  return { editor: editor as unknown as PagedEditor, tools, commands, keybindings };
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
  it("registers 4 namespaced tools + activation commands + shortcuts", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.tools.ids()).toEqual([
      "media.paged.draw.tool.pen",
      "media.paged.draw.tool.addAnchor",
      "media.paged.draw.tool.deleteAnchor",
      "media.paged.draw.tool.convertAnchor",
    ]);
    expect(fake.commands.ids()).toEqual([
      "media.paged.draw.tool.pen.activate",
      "media.paged.draw.tool.addAnchor.activate",
      "media.paged.draw.tool.deleteAnchor.activate",
      "media.paged.draw.tool.convertAnchor.activate",
    ]);
    expect(fake.keybindings.count()).toBe(4);
  });

  it("registered ids match the manifest's contributes declaration", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    expect(fake.tools.ids()).toEqual(drawBundle.manifest.contributes?.tools);
    expect(fake.commands.ids()).toEqual(
      drawBundle.manifest.contributes?.commands,
    );
  });

  it("dispose leaves the shell exactly as found (honesty smoke test)", () => {
    const fake = makeFakeEditor();
    const loaded = loadBundle(() => fake.editor, drawBundle, {
      console: silent,
      storage: mapBacking(),
    });
    loaded.dispose();
    expect(fake.tools.ids()).toHaveLength(0);
    expect(fake.commands.ids()).toHaveLength(0);
    expect(fake.keybindings.count()).toBe(0);
  });
});
