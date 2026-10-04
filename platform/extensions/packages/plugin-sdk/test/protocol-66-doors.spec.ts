/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The protocol-66 doors (ADRs 320–322):
//   · scene images: the binary lane when the host wires it, the SDK's own
//     JSON fallback (with a retained copy the tiles patch) when it does not;
//   · parts.delete over the binary lane and the JSON message;
//   · widgets.ColorPicker: the flag tracks the host injection, the fallback
//     is always present;
//   · document.onWillSave: awaited, errors contained, inert without backend;
//   · shell.enterEditContext: own registered types only;
//   · tools.settings: own tools only, read + subscribe.

import { describe, expect, it } from "vitest";

import type {
  ColorPickerProps,
  PagedEditor,
  PluginManifest,
  SceneImage,
  SceneImageTile,
  SceneLayer,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { inMemoryToolSettings, inMemoryWillSave } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const MANIFEST: PluginManifest = {
  id: "media.paged.image",
  name: "image",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { rendering: ["sceneLayer"] },
  contributes: {
    editContexts: [{ type: "rasterImage", entry: "doubleClick" }],
  },
};

function solid(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h * 4).fill(v);
}

/** A fake editor with a scene channel; `binary` adds the 66 lane. */
function sceneEditor(binary: boolean) {
  const fake = makeFakeEditor();
  const json: { id: string; layer: SceneLayer; caller?: string }[] = [];
  const images: { id: string; image: SceneImage; caller?: string; transfer?: boolean }[] = [];
  const tiles: { id: string; tiles: readonly SceneImageTile[]; transfer?: boolean }[] = [];
  const sceneLayers: NonNullable<PagedEditor["sceneLayers"]> = {
    async submit(id, layer, caller) {
      json.push({ id, layer, caller });
    },
    async clear() {},
    ...(binary
      ? {
          async submitImage(id: string, image: SceneImage, caller?: string, transfer?: boolean) {
            images.push({ id, image, caller, transfer });
          },
          async submitImageTiles(
            id: string,
            t: readonly SceneImageTile[],
            _caller?: string,
            transfer?: boolean,
          ) {
            tiles.push({ id, tiles: t, transfer });
          },
        }
      : {}),
  };
  (fake.editor as unknown as { sceneLayers: unknown }).sceneLayers = sceneLayers;
  const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
  return { host, json, images, tiles };
}

describe("sceneLayer.submitImage / submitImageTiles", () => {
  const image = (): SceneImage => ({
    rgba: solid(4, 4, 0),
    width: 4,
    height: 4,
    dest: [0, 0, 100, 100],
  });

  it("uses the binary lane when the host wires it, naming the caller", async () => {
    const { host, json, images, tiles } = sceneEditor(true);
    expect(host.supports("rendering.sceneLayer.binary@1")).toBe(true);
    const s = host.contribute.sceneLayer();
    await s.submitImage("r1", image(), { transfer: true });
    await s.submitImageTiles("r1", [
      { x: 1, y: 1, width: 2, height: 1, rgba: solid(2, 1, 255) },
    ]);
    expect(json).toHaveLength(0);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ id: "r1", caller: "media.paged.image", transfer: true });
    expect(tiles).toHaveLength(1);
    expect(tiles[0].transfer).toBe(false);
  });

  it("falls back to JSON on an older host and patches its own retained copy", async () => {
    const { host, json } = sceneEditor(false);
    expect(host.supports("rendering.sceneLayer.binary@1")).toBe(false);
    const s = host.contribute.sceneLayer();
    const img = image();
    await s.submitImage("r1", img);
    // The bundle may reuse its buffer: the SDK copied it.
    img.rgba.fill(9);
    await s.submitImageTiles("r1", [
      { x: 1, y: 2, width: 2, height: 1, rgba: solid(2, 1, 255) },
    ]);
    expect(json).toHaveLength(2);
    const item = json[1].layer.items[0] as unknown as {
      kind: string;
      rgba: number[];
      w: number;
    };
    expect(item.kind).toBe("image");
    expect(item.w).toBe(100);
    const at = (x: number, y: number) => item.rgba[(y * 4 + x) * 4];
    expect(at(1, 2)).toBe(255);
    expect(at(2, 2)).toBe(255);
    expect(at(0, 2)).toBe(0);
    expect(at(1, 1)).toBe(0);
    expect(json[1].caller).toBe("media.paged.image");
  });

  it("refuses tiles before any image, out of bounds, or a malformed image", async () => {
    for (const binary of [true, false]) {
      const { host, json, tiles } = sceneEditor(binary);
      const s = host.contribute.sceneLayer();
      await expect(
        s.submitImageTiles("r1", [{ x: 0, y: 0, width: 1, height: 1, rgba: solid(1, 1, 1) }]),
      ).rejects.toThrow(/submitImage first/);
      await expect(
        s.submitImage("r1", { rgba: new Uint8Array(3), width: 1, height: 1, dest: [0, 0, 1, 1] }),
      ).rejects.toThrow(/width\*height\*4/);
      await s.submitImage("r1", image());
      const sent = json.length + tiles.length;
      await expect(
        s.submitImageTiles("r1", [{ x: 3, y: 0, width: 2, height: 1, rgba: solid(2, 1, 1) }]),
      ).rejects.toThrow(/does not fit/);
      expect(json.length + tiles.length).toBe(sent);
    }
  });
});

describe("parts.delete (storage.parts@2)", () => {
  it("deletes over the JSON message on a host without the binary lane", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    expect(host.supports("storage.parts@2")).toBe(true);
    await host.parts.write("px/a.png", new Uint8Array([1]));
    expect(await host.parts.delete("px/a.png")).toBe(true);
    expect(await host.parts.delete("px/a.png")).toBe(false);
    expect(await host.parts.read("px/a.png")).toBeNull();
    const del = fake.sent.find((m) => m.kind === "deletePagedPart");
    expect(del?.payload).toEqual({
      path: "paged/media.paged.image/px/a.png",
      caller: "media.paged.image",
    });
    await expect(host.parts.delete("../other/x")).rejects.toThrow(/\.\./);
  });

  it("uses the binary lane for write/read/delete when wired", async () => {
    const fake = makeFakeEditor();
    const store = new Map<string, Uint8Array>();
    const calls: string[] = [];
    (fake.editor as unknown as { parts: PagedEditor["parts"] }).parts = {
      async write(path, bytes, caller) {
        calls.push(`write ${path} ${caller}`);
        store.set(path, bytes);
      },
      async read(path) {
        return store.get(path) ?? null;
      },
      async delete(path, caller) {
        calls.push(`delete ${path} ${caller}`);
        return store.delete(path);
      },
    };
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    await host.parts.write("f/1/r1.json", new Uint8Array([7, 8]));
    expect(Array.from((await host.parts.read("f/1/r1.json"))!)).toEqual([7, 8]);
    expect(await host.parts.delete("f/1/r1.json")).toBe(true);
    expect(calls).toEqual([
      "write paged/media.paged.image/f/1/r1.json media.paged.image",
      "delete paged/media.paged.image/f/1/r1.json media.paged.image",
    ]);
    expect(fake.sent.some((m) => m.kind.endsWith("PagedPart"))).toBe(false);
  });
});

describe("widgets.ColorPicker", () => {
  it("is always present; the flag tracks the host's injection", () => {
    const fake = makeFakeEditor();
    const bare = createBundleHost(() => fake.editor, MANIFEST, { console: silent }).host;
    expect(typeof bare.widgets.ColorPicker).toBe("function");
    expect(bare.supports("widgets.colorPicker@1")).toBe(false);
    expect(bare.supports("widgets.codeEditor@1")).toBe(false);

    const Picker = (_: ColorPickerProps) => null;
    const wired = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      widgets: { ColorPicker: Picker },
    }).host;
    expect(wired.widgets.ColorPicker).toBe(Picker);
    expect(wired.supports("widgets.colorPicker@1")).toBe(true);
    // A host injecting only the picker keeps the code-editor fallback.
    expect(typeof wired.widgets.CodeEditor).toBe("function");
    expect(wired.supports("widgets.codeEditor@1")).toBe(false);
  });
});

describe("document.onWillSave", () => {
  it("is awaited by the host and contains a listener's error", async () => {
    const fake = makeFakeEditor();
    const willSave = inMemoryWillSave();
    const errors: string[] = [];
    const { host, dispose } = createBundleHost(() => fake.editor, MANIFEST, {
      console: { ...silent, error: (m: string) => void errors.push(m) },
      willSave,
    });
    expect(host.supports("document.onWillSave@1")).toBe(true);
    const order: string[] = [];
    host.document.onWillSave(async (e) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(`committed ${e.format}`);
    });
    host.document.onWillSave(() => {
      throw new Error("boom");
    });
    await willSave.fire();
    order.push("saved");
    expect(order).toEqual(["committed paged", "saved"]);
    expect(errors.some((m) => m.includes("boom"))).toBe(true);
    dispose();
    expect(willSave.count()).toBe(0);
  });

  it("holds a listener inertly without a backend", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    expect(host.supports("document.onWillSave@1")).toBe(false);
    const d = host.document.onWillSave(() => {});
    expect(typeof d.dispose).toBe("function");
  });
});

describe("shell.enterEditContext", () => {
  const shell = (entered: string[]) => ({
    openPanel() {},
    closePanel() {},
    async pickFile() {
      return [];
    },
    async enterEditContext(type: string, id: { kind: string; id: string }) {
      entered.push(`${type}:${id.id}`);
      return true;
    },
  });

  it("enters only a context type this bundle registered", async () => {
    const fake = makeFakeEditor();
    const entered: string[] = [];
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      shell: shell(entered) as never,
    });
    expect(host.supports("shell.enterEditContext@1")).toBe(true);
    const frame = { kind: "rectangle", id: "u1" } as never;
    await expect(host.shell.enterEditContext("rasterImage", frame)).rejects.toThrow(
      /registered no edit context/,
    );
    host.contribute.editContext({ type: "rasterImage", entry: "doubleClick" });
    expect(await host.shell.enterEditContext("rasterImage", frame)).toBe(true);
    expect(entered).toEqual(["rasterImage:u1"]);
    await expect(host.shell.enterEditContext("vectorGraphic", frame)).rejects.toThrow();
  });

  it("answers false when the host cannot enter", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    expect(host.supports("shell.enterEditContext@1")).toBe(false);
    host.contribute.editContext({ type: "rasterImage", entry: "doubleClick" });
    expect(
      await host.shell.enterEditContext("rasterImage", { kind: "rectangle", id: "u1" } as never),
    ).toBe(false);
  });

  it("carries undo labels through to the registry verbatim", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    host.contribute.editContext({
      type: "rasterImage",
      entry: "doubleClick",
      onUndo: () => true,
      undoLabel: () => "Undo Brush Stroke",
      redoLabel: () => null,
    });
    const registered = fake.editContexts.get("rasterImage") as unknown as {
      undoLabel(): string | null;
      redoLabel(): string | null;
    };
    expect(registered.undoLabel()).toBe("Undo Brush Stroke");
    expect(registered.redoLabel()).toBeNull();
  });
});

describe("tools.settings", () => {
  it("reads and subscribes to this bundle's own tools only", () => {
    const fake = makeFakeEditor();
    const settings = inMemoryToolSettings();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      toolSettings: settings,
    });
    expect(host.supports("tools.settings@1")).toBe(true);
    const brush = "media.paged.image.tool.brush";
    expect(host.tools.settings(brush)).toEqual({});
    const seen: unknown[] = [];
    const sub = host.tools.onDidChangeSettings(brush, (s) => seen.push(s));
    settings.set(brush, "size", 24);
    settings.set(brush, "hardness", 0.5);
    expect(host.tools.settings(brush)).toEqual({ size: 24, hardness: 0.5 });
    expect(seen).toEqual([{ size: 24 }, { size: 24, hardness: 0.5 }]);
    sub.dispose();
    settings.set(brush, "size", 1);
    expect(seen).toHaveLength(2);
    expect(() => host.tools.settings("media.paged.draw.tool.pen")).toThrow(/namespaced/);
  });

  it("answers {} without a backend", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    expect(host.supports("tools.settings@1")).toBe(false);
    expect(host.tools.settings("media.paged.image.tool.brush")).toEqual({});
  });
});
