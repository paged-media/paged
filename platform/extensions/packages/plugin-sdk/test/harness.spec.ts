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

  it("records SCHEMA panels verbatim (W3.1 — the schema, not React)", async () => {
    live = await open();
    const host = (await loaded()).host;
    host.contribute.schemaPanel(schemaPanelC("media.paged.harness.panel.stroke"));
    // The schema panel is recorded as its OWN kind, carrying the schema
    // (not the synthesized React component the registry saw).
    const recorded = live!.schemaPanelsContributed();
    expect(recorded.map((p) => p.id)).toEqual([
      "media.paged.harness.panel.stroke",
    ]);
    expect(recorded[0].schema.sections).toHaveLength(1);
    expect(recorded[0].schema.sections[0].rows[0].widget).toBe(
      "paged.readout",
    );
    // It also lands in the registry as a panel (the synthesized one).
    expect(live!.panelsContributed().map((p) => p.id)).toContain(
      "media.paged.harness.panel.stroke",
    );
  });

  it("records editContext + objectType contributions (W3.2 — un-reserved)", async () => {
    live = await open();
    const host = (await loaded()).host;
    // The doors no longer throw PluginApiNotImplemented; headlessly there
    // is no shell stack, so they take the recording-stub path.
    host.contribute.editContext({
      type: "vectorGraphic",
      entry: "doubleClick",
      matches: (c) => c.kind === "polygon",
      toolIds: ["media.paged.harness.tool.addAnchor"],
      panelIds: ["media.paged.harness.panel.stroke"],
    });
    host.contribute.objectType({
      type: "webFrame",
      bakedFallback: "rectangle",
      matches: (c) => c.metadata?.data?.source !== undefined,
      editContextType: "webFrame",
    });
    const ecs = live!.editContextsContributed();
    const ots = live!.objectTypesContributed();
    expect(ecs.map((c) => c.type)).toEqual(["vectorGraphic"]);
    expect(ecs[0].toolIds).toEqual(["media.paged.harness.tool.addAnchor"]);
    // The matcher survives verbatim — the shell calls it at hit time.
    expect(ecs[0].matches?.({ id: {} as never, kind: "polygon", groupChain: [], metadata: null })).toBe(true);
    expect(ots.map((c) => c.type)).toEqual(["webFrame"]);
    expect(ots[0].editContextType).toBe("webFrame");
    // Both also land in the unified contribution log under their kinds.
    expect(live!.contributions.map((c) => c.kind)).toEqual([
      "editContext",
      "objectType",
    ]);
  });

  it("an editContext carries the K-1 modal + content-pointer handlers", async () => {
    live = await open();
    const host = (await loaded()).host;
    const seen: string[] = [];
    let dirty = true;
    host.contribute.editContext({
      type: "vectorGraphic",
      entry: "doubleClick",
      onContentPointerDown: (e) => seen.push(`down@${e.contentPoint.join(",")}`),
      onContentPointerMove: () => seen.push("move"),
      onContentPointerUp: () => seen.push("up"),
      onContentKey: (e) => seen.push(`key:${e.key}`),
      isDirty: () => dirty,
      onCommit: () => seen.push("commit"),
      onCancel: () => seen.push("cancel"),
    });
    const ec = live!.editContextsContributed()[0];
    // The handlers survive registration verbatim — the editor calls them
    // at pointer/commit time with frame-content coords (K-1 wiring).
    expect(typeof ec.onContentPointerDown).toBe("function");
    expect(typeof ec.onCommit).toBe("function");
    expect(ec.isDirty?.()).toBe(true);
    ec.onContentPointerDown?.({
      contentPoint: [12, 34],
      elementId: "media.paged.sheet.frame1",
      modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
      button: 0,
    });
    ec.onCommit?.();
    expect(seen).toEqual(["down@12,34", "commit"]);
  });

  it("records importer + exporter contributions (K-2 / S-06)", async () => {
    live = await open();
    const host = (await loaded()).host;
    // The doors route to the harness recording registry (no shell wired).
    const seen: string[] = [];
    host.contribute.importer({
      id: "media.paged.harness.importer.xlsx",
      title: "Spreadsheet",
      extensions: [".xlsx"],
      mimeTypes: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      import: ({ name }) => void seen.push(name),
    });
    host.contribute.exporter({
      id: "media.paged.harness.exporter.xlsx",
      title: "Workbook (.xlsx)",
      extension: ".xlsx",
      export: () => ({ bytes: new Uint8Array([1, 2]), fileName: "out.xlsx" }),
    });
    const imps = live!.importersContributed();
    const exps = live!.exportersContributed();
    expect(imps.map((i) => i.id)).toEqual(["media.paged.harness.importer.xlsx"]);
    expect(imps[0].extensions).toEqual([".xlsx"]);
    // The import callback survives verbatim — the host calls it at open time.
    imps[0].import({ name: "budget.xlsx", bytes: new Uint8Array(), mimeType: "" });
    expect(seen).toEqual(["budget.xlsx"]);
    expect(exps.map((e) => e.id)).toEqual(["media.paged.harness.exporter.xlsx"]);
    expect(host.supports("contribute.importer@1")).toBe(true);
    expect(host.supports("contribute.exporter@1")).toBe(true);
    expect(live!.contributions.map((c) => c.kind)).toEqual([
      "importer",
      "exporter",
    ]);
  });

  it("pickFile resolves empty + warns when no shell is wired (K-5 / S-11)", async () => {
    live = await open();
    const host = (await loaded()).host;
    // The neutral headless host injects no shell — the honest no-picker door.
    expect(host.supports("shell.pickFile@1")).toBe(false);
    await expect(host.shell.pickFile({ accept: [".xlsx"] })).resolves.toEqual(
      [],
    );
  });

  it("contribute.sceneLayer() is obtainable + no-ops without a channel (C-1)", async () => {
    live = await open();
    const host = (await loaded()).host;
    // No scene channel is wired headlessly — the honest no-op door.
    expect(host.supports("rendering.sceneLayer@1")).toBe(false);
    const surface = host.contribute.sceneLayer();
    // submit/clear resolve (no-op) without throwing; the surface disposes.
    await expect(
      surface.submit("media.paged.sheet.grid.f1", {
        items: [
          {
            kind: "strokePath",
            path: [
              { op: "moveTo", x: 0, y: 0 },
              { op: "lineTo", x: 10, y: 0 },
            ],
            paint: { r: 0, g: 0, b: 0, a: 1 },
            width: 1,
          },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(surface.clear("media.paged.sheet.grid.f1")).resolves.toBeUndefined();
    expect(() => surface.dispose()).not.toThrow();
  });

  it("contribute.sceneLayer() is gated on rendering ∋ sceneLayer (C-1)", async () => {
    live = await open();
    // A bundle whose manifest does NOT declare rendering sceneLayer is
    // refused (enforce mode — the same gate overlay/hitTest use).
    const bundle = defineBundle({
      manifest: {
        id: "media.paged.proof",
        name: "proof",
        version: "1.0.0",
        apiVersion: "^0.2",
        capabilities: { document: { read: "broad" } }, // no rendering
      },
      activate: (h) => {
        expect(() => h.contribute.sceneLayer()).toThrow(/rendering/);
        return { dispose() {} };
      },
    });
    live.loadBundle(bundle);
  });

  it("blob store round-trips bytes + reports usage (K-4 / S-08)", async () => {
    live = await open();
    const host = (await loaded()).host;
    // The harness injects an in-memory blob store, so the door is live.
    expect(host.supports("storage.blob@1")).toBe(true);
    expect(await host.blob.read("workbook")).toBeNull();

    const bytes = new Uint8Array([5, 6, 7, 8]);
    await host.blob.write("workbook", bytes);
    expect(Array.from((await host.blob.read("workbook"))!)).toEqual([
      5, 6, 7, 8,
    ]);
    expect(await host.blob.keys()).toEqual(["workbook"]);
    const usage = await host.blob.usage();
    expect(usage.used).toBe(4);
    expect(usage.quota).toBeGreaterThan(0);

    // Overwrite replaces (usage does not double-count), then delete clears.
    await host.blob.write("workbook", new Uint8Array([9]));
    expect((await host.blob.usage()).used).toBe(1);
    await host.blob.delete("workbook");
    expect(await host.blob.read("workbook")).toBeNull();
    expect(await host.blob.keys()).toEqual([]);
  });

  it("records the B-07 path/cubic tool preview headlessly (no overlay surface)", async () => {
    live = await open();
    // A loaded bundle that declares the overlay rendering capability —
    // the same gate the live editor enforces. It pushes a TRUE cubic run
    // (anchor/handle form), not a flattened polyline.
    const preview = {
      pageId: "p1",
      anchors: [
        { anchor: [10, 10] as [number, number], left: [10, 10] as [number, number], right: [30, 10] as [number, number] },
        { anchor: [50, 10] as [number, number], left: [40, 30] as [number, number], right: [50, 10] as [number, number] },
      ],
      close: false,
    };
    const bundle = defineBundle({
      manifest: {
        id: "media.paged.draw",
        name: "draw",
        version: "1.0.0",
        apiVersion: "^0.2",
        capabilities: {
          document: { read: "broad", write: "broad" },
          rendering: ["overlay"],
        },
      },
      activate(h) {
        // Initially nothing.
        expect(live!.lastToolPreview()).toBeNull();
        h.overlay.setToolPreview(preview as never);
        return { dispose() {} };
      },
    });
    live.loadBundle(bundle);
    // The channel is recorded verbatim — SEGMENT data (anchors + left/
    // right handles), not sampled points. This is the headless proof of
    // B-07's path variant (no overlay SURFACE, but an assertable record).
    const rec = live.lastToolPreview() as typeof preview | null;
    expect(rec).not.toBeNull();
    expect(rec).toHaveProperty("anchors");
    expect(rec).not.toHaveProperty("points");
    expect(rec!.anchors).toHaveLength(2);
    // The curved segment's handles survived untouched (the renderer would
    // draw `C from.right to.left to.anchor`).
    expect(rec!.anchors[1].left).toEqual([40, 30]);
  });

  it("a bundle without rendering 'overlay' cannot push a path preview", async () => {
    live = await open();
    const bundle = defineBundle({
      manifest: manifestFor("media.paged.draw"), // no rendering capability
      activate(h) {
        expect(() =>
          h.overlay.setToolPreview({
            pageId: "p1",
            anchors: [
              { anchor: [0, 0], left: [0, 0], right: [0, 0] },
              { anchor: [1, 1], left: [1, 1], right: [1, 1] },
            ],
          } as never),
        ).toThrow(/rendering must include "overlay"/);
        return { dispose() {} };
      },
    });
    live.loadBundle(bundle);
    expect(live.lastToolPreview()).toBeNull();
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
const schemaPanelC = (id: string) =>
  ({
    id,
    title: "S",
    schema: {
      id,
      title: "S",
      sections: [
        { rows: [{ widget: "paged.readout", props: { text: "—" } }] },
      ],
    },
  }) as never;
const cmdC = (id: string) =>
  ({ id, title: "C", handler: () => undefined }) as never;
