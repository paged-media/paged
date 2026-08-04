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

// ADR-023 phase A — BINDING PROVIDERS: the host owns the panel, the
// active plugin resolves the values it binds to.
//
// The suite is organised around the THREE proof consumers the contract
// was designed against, because one consumer only proves you built
// something shaped like its only caller:
//
//   · LAYERS  — an element COLLECTION addressed by row identity;
//   · CHARACTER/PARAGRAPH — SCALAR paths over a RANGE, value may be MIXED;
//   · SWATCHES/COLOUR — a DOCUMENT-SCOPED resource collection the panel
//     edits directly (create / rename / delete) and applies to a
//     selection.
//
// Plus the mechanics all three depend on: registration + its three
// gates, lifetime borrowed from the edit context, innermost-first
// precedence, the typed refusals that make fall-through-to-core
// distinguishable from an empty answer, and teardown.

import { describe, expect, it } from "vitest";

import type {
  BindingProvider,
  ElementId,
  MutationInput,
  PluginManifest,
} from "@paged-media/plugin-api";

import {
  createBindingProviderRegistry,
  createBundleHost,
  HOST_FEATURES,
  PluginCapabilityError,
  type BindingProviderBackend,
} from "../src/host-impl";
import {
  contributeBindingProvider,
  contributeEditContext,
} from "../src/edit-context";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad", write: "scoped" } },
  contributes: {
    editContexts: [
      { type: "rasterImage", entry: "doubleClick" },
      { type: "webFrame", entry: "doubleClick" },
    ],
  },
};

/** A SECOND bundle, so the cross-bundle precedence case is real rather
 *  than two contexts of one plugin. */
const MANIFEST_B: PluginManifest = {
  ...MANIFEST,
  id: "media.paged.other",
  contributes: { editContexts: [{ type: "sheetGrid", entry: "doubleClick" }] },
};

const applied = { applied: true as const, createdId: null, pageIds: [] };

/** Build a host wired to a shared registry, with the edit context
 *  already registered (the ordering the door enforces). */
function setup(
  manifest: PluginManifest = MANIFEST,
  contextType = "rasterImage",
  registry: BindingProviderBackend = createBindingProviderRegistry(),
  warned: string[] = [],
) {
  const fake = makeFakeEditor();
  const { host, dispose } = createBundleHost(() => fake.editor, manifest, {
    console: { ...silent, warn: (m: string) => warned.push(m) },
    bindingProviders: registry,
  });
  contributeEditContext(host, { type: contextType, entry: "doubleClick" });
  /** Drive the shell's own lifecycle hooks — which is exactly what the
   *  editor does on a double-click; the adapter listens in. */
  const enter = (id = "u1") =>
    (
      fake.editContexts.get(contextType) as {
        onEnter?: (c: { type: string; id: ElementId }) => void;
      }
    ).onEnter?.({
      type: contextType,
      id: { kind: "rectangle", id } as ElementId,
    });
  const exit = (id = "u1") =>
    (
      fake.editContexts.get(contextType) as {
        onExit?: (c: { type: string; id: ElementId }) => void;
      }
    ).onExit?.({
      type: contextType,
      id: { kind: "rectangle", id } as ElementId,
    });
  return { fake, host, dispose, registry, enter, exit, warned };
}

// ══════════════════════════════════════════════ registration + gates

describe("contribute.bindingProvider — registration + the three gates", () => {
  it("registers, and both feature flags tell the truth", () => {
    const { host } = setup();
    const handle = contributeBindingProvider(host, "rasterImage", {
      provides: { paths: ["layerVisible"] },
      readProperty: () => ({ kind: "value", value: { type: "bool", value: true } }),
    });
    expect(typeof handle.invalidate).toBe("function");
    // STATIC: this SDK has the door. DYNAMIC: a registry is wired.
    expect(host.supports("contribute.bindingProvider@1")).toBe(true);
    expect(host.supports("bindings.provider@1")).toBe(true);
    expect(HOST_FEATURES).toContain("contribute.bindingProvider@1");
    // The dynamic flag is NOT in the static list — it is added per host.
    expect(HOST_FEATURES).not.toContain("bindings.provider@1");
  });

  it("GATE 1 (capability): an undeclared context type is refused", () => {
    const registry = createBindingProviderRegistry();
    const fake = makeFakeEditor();
    const { host } = createBundleHost(
      () => fake.editor,
      { ...MANIFEST, contributes: {} },
      { console: silent, bindingProviders: registry, capabilityMode: "enforce" },
    );
    expect(() =>
      contributeBindingProvider(host, "rasterImage", {
        provides: { paths: ["layerVisible"] },
        readProperty: () => ({ kind: "decline" }),
      }),
    ).toThrow(PluginCapabilityError);
  });

  it("GATE 2 (ordering): a provider for an unregistered context is refused", () => {
    const registry = createBindingProviderRegistry();
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      bindingProviders: registry,
    });
    // "webFrame" IS declared in the manifest but was never contributed,
    // so a provider on it could never activate.
    expect(() =>
      contributeBindingProvider(host, "webFrame", {
        provides: { paths: ["layerVisible"] },
        readProperty: () => ({ kind: "decline" }),
      }),
    ).toThrow(/no such edit context is registered/);
  });

  it("GATE 3 (declaration shape): a declared lane without its callback is refused", () => {
    const { host } = setup();
    expect(() =>
      contributeBindingProvider(host, "rasterImage", {
        provides: { collections: ["layers"] },
      }),
    ).toThrow(/provides\.collections declared without readCollection/);
    expect(() =>
      contributeBindingProvider(host, "rasterImage", {
        provides: { ops: ["layerMove"] },
      }),
    ).toThrow(/provides\.ops declared without applyMutation/);
    expect(() =>
      contributeBindingProvider(host, "rasterImage", { provides: {} }),
    ).toThrow(/declares nothing/);
    expect(() =>
      contributeBindingProvider(host, "rasterImage", {
        provides: { paths: ["layerVisible", "layerVisible"] },
        readProperty: () => ({ kind: "decline" }),
      }),
    ).toThrow(/lists "layerVisible" twice/);
  });

  it("no registry wired: the door warns, hands back an inert handle, never throws", async () => {
    const fake = makeFakeEditor();
    const warned: string[] = [];
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: { ...silent, warn: (m: string) => warned.push(m) },
    });
    contributeEditContext(host, { type: "rasterImage", entry: "doubleClick" });
    const handle = contributeBindingProvider(host, "rasterImage", {
      provides: { paths: ["layerVisible"] },
      readProperty: () => ({ kind: "value", value: { type: "bool", value: true } }),
    });
    expect(() => handle.invalidate()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
    expect(host.supports("contribute.bindingProvider@1")).toBe(true);
    expect(host.supports("bindings.provider@1")).toBe(false);
    expect(warned.some((w) => /wired no binding-provider registry/.test(w))).toBe(
      true,
    );
  });
});

// ══════════════════════════════════════════════════════════ lifetime

describe("lifetime — borrowed from the edit context, not declared", () => {
  const provider: BindingProvider = {
    provides: { paths: ["layerVisible"] },
    readProperty: () => ({ kind: "value", value: { type: "bool", value: false } }),
  };

  it("is NOT consulted before its context is entered", async () => {
    const { host, registry } = setup();
    contributeBindingProvider(host, "rasterImage", provider);
    const read = await registry.readProperty({
      path: "layerVisible",
      target: { kind: "selection", scope: "element" },
    });
    expect(read.resolved).toBe(false);
    expect(registry.activeProviders()).toHaveLength(0);
  });

  it("becomes active on the shell's own onEnter and inert on onExit", async () => {
    const { host, registry, enter, exit } = setup();
    contributeBindingProvider(host, "rasterImage", provider);

    enter("u7");
    const active = registry.activeProviders();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      plugin: "media.paged.test",
      contextType: "rasterImage",
      elementId: "u7",
    });
    expect(active[0].provides.paths).toEqual(["layerVisible"]);
    const hit = await registry.readProperty({
      path: "layerVisible",
      target: { kind: "selection", scope: "element" },
    });
    expect(hit).toEqual({
      resolved: true,
      provider: "media.paged.test",
      read: { kind: "value", value: { type: "bool", value: false } },
    });

    exit("u7");
    expect(registry.activeProviders()).toHaveLength(0);
    expect(
      (
        await registry.readProperty({
          path: "layerVisible",
          target: { kind: "selection", scope: "element" },
        })
      ).resolved,
    ).toBe(false);
  });

  it("the bundle's OWN onEnter/onExit still run (the wrap is additive)", () => {
    const seen: string[] = [];
    const registry = createBindingProviderRegistry();
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      bindingProviders: registry,
    });
    contributeEditContext(host, {
      type: "rasterImage",
      entry: "doubleClick",
      onEnter: (c) => seen.push(`enter:${c.id.id as string}`),
      onExit: (c) => seen.push(`exit:${c.id.id as string}`),
    });
    const ctx = fake.editContexts.get("rasterImage") as {
      onEnter?: (c: unknown) => void;
      onExit?: (c: unknown) => void;
    };
    const entered = { type: "rasterImage", id: { kind: "rectangle", id: "u3" } };
    ctx.onEnter?.(entered);
    ctx.onExit?.(entered);
    expect(seen).toEqual(["enter:u3", "exit:u3"]);
  });

  it("a provider registered while the context is ALREADY active is live at once", async () => {
    const { host, registry, enter } = setup();
    enter();
    contributeBindingProvider(host, "rasterImage", provider);
    expect(
      (
        await registry.readProperty({
          path: "layerVisible",
          target: { kind: "selection", scope: "element" },
        })
      ).resolved,
    ).toBe(true);
  });

  it("nested entry/exit of the same type unwinds one level at a time", async () => {
    const { host, registry, enter, exit } = setup();
    contributeBindingProvider(host, "rasterImage", provider);
    enter("outer");
    enter("inner");
    expect(registry.activeProviders()).toHaveLength(2);
    expect(registry.activeProviders()[0].elementId).toBe("inner");
    exit("inner");
    expect(registry.activeProviders()).toHaveLength(1);
    expect(registry.activeProviders()[0].elementId).toBe("outer");
  });
});

// ════════════════════════════════════════════════════════ precedence

describe("precedence — innermost active context wins, then decline, then core", () => {
  it("the innermost context's provider answers first", async () => {
    const registry = createBindingProviderRegistry();
    const outer = setup(MANIFEST, "rasterImage", registry);
    const inner = setup(MANIFEST_B, "sheetGrid", registry);
    contributeBindingProvider(outer.host, "rasterImage", {
      provides: { paths: ["characterFontSize"] },
      readProperty: () => ({ kind: "value", value: { type: "length", value: 10 } }),
    });
    contributeBindingProvider(inner.host, "sheetGrid", {
      provides: { paths: ["characterFontSize"] },
      readProperty: () => ({ kind: "value", value: { type: "length", value: 99 } }),
    });
    outer.enter();
    inner.enter();
    const read = await registry.readProperty({
      path: "characterFontSize",
      target: { kind: "selection", scope: "content" },
    });
    expect(read).toEqual({
      resolved: true,
      provider: "media.paged.other",
      read: { kind: "value", value: { type: "length", value: 99 } },
    });
    // Pop the inner context and the outer one takes over — the panel
    // retargets with the stack, which is the whole ADR.
    inner.exit();
    const after = await registry.readProperty({
      path: "characterFontSize",
      target: { kind: "selection", scope: "content" },
    });
    expect(after).toMatchObject({ provider: "media.paged.test" });
  });

  it("a decline continues down the stack rather than ending resolution", async () => {
    const registry = createBindingProviderRegistry();
    const outer = setup(MANIFEST, "rasterImage", registry);
    const inner = setup(MANIFEST_B, "sheetGrid", registry);
    contributeBindingProvider(outer.host, "rasterImage", {
      provides: { paths: ["characterFontSize"] },
      readProperty: () => ({ kind: "value", value: { type: "length", value: 10 } }),
    });
    contributeBindingProvider(inner.host, "sheetGrid", {
      provides: { paths: ["characterFontSize"] },
      readProperty: () => ({ kind: "decline", reason: "no cell selected" }),
    });
    outer.enter();
    inner.enter();
    expect(
      await registry.readProperty({
        path: "characterFontSize",
        target: { kind: "selection", scope: "content" },
      }),
    ).toMatchObject({ resolved: true, provider: "media.paged.test" });
  });

  it("an UNDECLARED path is never offered to the provider at all", async () => {
    let asked = 0;
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", {
      provides: { paths: ["layerVisible"] },
      readProperty: () => {
        asked++;
        return { kind: "value", value: { type: "bool", value: true } };
      },
    });
    enter();
    const read = await registry.readProperty({
      path: "characterLeading",
      target: { kind: "selection", scope: "content" },
    });
    expect(read).toEqual({
      resolved: false,
      reason: 'no active binding provider claimed "characterLeading"',
    });
    expect(asked).toBe(0);
  });
});

// ═══════════════════════════════════════════ fall-through to core

describe("fall-through to core — a typed refusal, never an empty answer", () => {
  it("the refusal is structurally distinct from every claimed answer", async () => {
    const { registry } = setup();
    const read = await registry.readProperty({
      path: "characterFontSize",
      target: { kind: "selection", scope: "content" },
    });
    expect(read.resolved).toBe(false);
    // The point of the split: a caller cannot mistake this for a claimed
    // answer whose value happens to be empty/mixed/absent.
    expect(read).not.toHaveProperty("read");
    expect((read as { reason: string }).reason).toMatch(/no active binding provider/);
  });

  it("the host completes the fall-through by reading CORE (the two-step)", async () => {
    const { host, registry, fake, enter } = setup();
    contributeBindingProvider(host, "rasterImage", {
      provides: { paths: ["layerVisible"] },
      readProperty: () => ({ kind: "value", value: { type: "bool", value: false } }),
    });
    enter();
    fake.setElementProperties({
      kind: "elementProperties",
      payload: {
        result: {
          id: { kind: "rectangle", id: "u1" },
          kind: "rectangle",
          entries: [
            { path: "frameOpacity", value: { type: "length", value: 42 } },
          ],
        },
      },
    });
    // The panel asks the seam first…
    const seam = await registry.readProperty({
      path: "frameOpacity",
      target: { kind: "element", id: { kind: "rectangle", id: "u1" } },
    });
    expect(seam.resolved).toBe(false);
    // …and, refused, reads core through the ordinary door.
    const core = await host.document.elementProperties({
      kind: "rectangle",
      id: "u1",
    });
    expect(core?.entries[0].value).toEqual({ type: "length", value: 42 });
  });

  it("a write nobody claims is `handled: false` — the host mutates core", async () => {
    const { host, registry, fake, enter } = setup();
    contributeBindingProvider(host, "rasterImage", {
      provides: { paths: ["layerVisible"] },
      readProperty: () => ({ kind: "decline" }),
    });
    enter();
    const verdict = await registry.writeProperty({
      path: "frameOpacity",
      target: { kind: "selection", scope: "element" },
      value: { type: "length", value: 50 },
    });
    expect(verdict.handled).toBe(false);
    const outcome = await host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: { kind: "rectangle", id: "u1" },
        path: "frameOpacity",
        value: { type: "length", value: 50 },
      },
    });
    expect(outcome.applied).toBe(true);
    expect(fake.mutations).toHaveLength(1);
  });

  it("a provider that declares a path but omits writeProperty falls through on WRITES only", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", {
      provides: { paths: ["layerVisible"] },
      readProperty: () => ({ kind: "value", value: { type: "bool", value: true } }),
    });
    enter();
    expect(
      (
        await registry.readProperty({
          path: "layerVisible",
          target: { kind: "selection", scope: "element" },
        })
      ).resolved,
    ).toBe(true);
    expect(
      (
        await registry.writeProperty({
          path: "layerVisible",
          target: { kind: "selection", scope: "element" },
          value: { type: "bool", value: false },
        })
      ).handled,
    ).toBe(false);
  });
});

// ═══════════════════════════════════════ consumer 1 — LAYERS (rows)

describe("consumer 1 — LAYERS: a collection addressed by row identity", () => {
  /** plugin-image's shape: raster layers held in the plugin's own wasm
   *  layer graph, served as CORE's `LayerSummary` row shape so one host
   *  list renders provider rows and core rows identically. */
  const rasterLayers = () => {
    const rows = [
      { selfId: "r2", name: "Type", visible: true, locked: false, printable: true, z: 1 },
      { selfId: "r1", name: "Base", visible: true, locked: false, printable: true, z: 0 },
    ];
    const provider: BindingProvider = {
      provides: {
        collections: ["layers"],
        paths: ["layerVisible", "layerName"],
        ops: ["layerMove"],
      },
      readCollection: () => ({ kind: "rows", rows }),
      readProperty: (req) => {
        const target = req.target;
        if (target.kind !== "row") return { kind: "decline" };
        const row = rows.find((r) => r.selfId === target.id);
        if (!row) return { kind: "decline", reason: "unknown row" };
        return req.path === "layerVisible"
          ? { kind: "value", value: { type: "bool", value: row.visible } }
          : { kind: "value", value: { type: "text", value: row.name } };
      },
      writeProperty: (req) => {
        const target = req.target;
        if (target.kind !== "row") return { kind: "decline" };
        const row = rows.find((r) => r.selfId === target.id);
        if (!row) return { kind: "decline" };
        if (req.path === "layerVisible" && req.value.type === "bool") {
          row.visible = req.value.value;
        }
        return { kind: "applied", outcome: applied };
      },
      applyMutation: (m) => {
        if (m.op !== "layerMove") return { kind: "decline" };
        const from = rows.findIndex((r) => r.selfId === m.args.layerId);
        if (from < 0) return { kind: "applied", outcome: { applied: false, error: "unknown layer" } };
        rows.splice(m.args.newIndex, 0, ...rows.splice(from, 1));
        return { kind: "applied", outcome: applied };
      },
    };
    return { rows, provider };
  };

  it("serves the row list, and the rows carry CORE's row shape", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", rasterLayers().provider);
    enter();
    const read = await registry.readCollection({ collection: "layers" });
    expect(read).toMatchObject({ resolved: true, provider: "media.paged.test" });
    const rows = (read as { rows: readonly Record<string, unknown>[] }).rows;
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["locked", "name", "printable", "selfId", "visible", "z"].sort(),
    );
  });

  it("reads and WRITES a row's typed path (the visibility toggle)", async () => {
    const { host, registry, enter } = setup();
    const { rows, provider } = rasterLayers();
    contributeBindingProvider(host, "rasterImage", provider);
    enter();
    const target = { kind: "row" as const, collection: "layers" as const, id: "r1" };
    expect(
      await registry.readProperty({ path: "layerVisible", target }),
    ).toMatchObject({ read: { kind: "value", value: { type: "bool", value: true } } });
    const wrote = await registry.writeProperty({
      path: "layerVisible",
      target,
      value: { type: "bool", value: false },
    });
    expect(wrote).toEqual({
      handled: true,
      provider: "media.paged.test",
      outcome: { applied: true, createdId: null, pageIds: [] },
    });
    expect(rows.find((r) => r.selfId === "r1")?.visible).toBe(false);
  });

  it("an owned row + an UNDECLARED path is `absent` — it must NOT fall through", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", rasterLayers().provider);
    enter();
    // `layerPrintable` is a real core path this provider does not serve
    // (raster layers have no printable flag). Falling through would show
    // the CORE selection's value for a row core has never heard of.
    const read = await registry.readProperty({
      path: "layerPrintable",
      target: { kind: "row", collection: "layers", id: "r1" },
    });
    expect(read).toMatchObject({ resolved: true, provider: "media.paged.test" });
    expect((read as { read: { kind: string } }).read.kind).toBe("absent");
  });

  it("a row of a collection NO provider owns still falls through to core", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", rasterLayers().provider);
    enter();
    const read = await registry.readProperty({
      path: "frameFillColor",
      target: { kind: "row", collection: "swatches", id: "s1" },
    });
    expect(read.resolved).toBe(false);
  });

  it("STRUCTURAL reorder rides the mutation lane in core's own op vocabulary", async () => {
    const { host, registry, enter } = setup();
    const { rows, provider } = rasterLayers();
    contributeBindingProvider(host, "rasterImage", provider);
    enter();
    const move: MutationInput = {
      op: "layerMove",
      args: { layerId: "r1", newIndex: 0 },
    };
    expect(await registry.applyMutation(move)).toMatchObject({ handled: true });
    expect(rows.map((r) => r.selfId)).toEqual(["r1", "r2"]);
    // An op the provider did not declare goes to core untouched.
    expect(
      await registry.applyMutation({
        op: "layerRemove",
        args: { layerId: "r1" },
      }),
    ).toMatchObject({ handled: false });
  });
});

// ═════════════════════════════ consumer 2 — CHARACTER (range + mixed)

describe("consumer 2 — CHARACTER/PARAGRAPH: scalar paths over a RANGE", () => {
  /** plugin-doc's shape: a DOCX story addressed by story id + character
   *  range, whose value over a multi-format run is MIXED. */
  const docRuns: BindingProvider = {
    provides: { paths: ["characterFontSize", "paragraphJustification"] },
    readProperty: (req) => {
      if (req.path === "paragraphJustification") {
        return { kind: "absent", reason: "DOCX runs carry no justification here" };
      }
      if (req.target.kind === "element" && req.target.id.kind === "storyRange") {
        const { start, end } = req.target.id.id;
        // One run → a value; a span crossing runs → mixed, never a winner.
        return end - start > 4
          ? { kind: "mixed" }
          : { kind: "value", value: { type: "length", value: 12 } };
      }
      return { kind: "decline" };
    },
    writeProperty: () => ({ kind: "applied", outcome: applied }),
  };

  const range = (start: number, end: number): ElementId =>
    ({ kind: "storyRange", id: { story_id: "s1", start, end } }) as ElementId;

  it("addresses a RANGE through core's own ElementId — no parallel scheme", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", docRuns);
    enter();
    expect(
      await registry.readProperty({
        path: "characterFontSize",
        target: { kind: "element", id: range(0, 3) },
      }),
    ).toMatchObject({ read: { kind: "value", value: { type: "length", value: 12 } } });
  });

  it("a multi-format range answers MIXED, not an arbitrary winner", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", docRuns);
    enter();
    const read = await registry.readProperty({
      path: "characterFontSize",
      target: { kind: "element", id: range(0, 40) },
    });
    expect(read).toMatchObject({ resolved: true, read: { kind: "mixed" } });
    // MIXED is a CLAIM, so the panel must not fall through and show core.
    expect(read.resolved).toBe(true);
  });

  it("ABSENT and DECLINE are different answers with different consequences", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", docRuns);
    enter();
    // absent = owned, inapplicable → the panel blanks the row.
    const absent = await registry.readProperty({
      path: "paragraphJustification",
      target: { kind: "element", id: range(0, 3) },
    });
    expect(absent).toMatchObject({ resolved: true, read: { kind: "absent" } });
    // decline = not mine → resolution falls through to core.
    const declined = await registry.readProperty({
      path: "characterFontSize",
      target: { kind: "selection", scope: "element" },
    });
    expect(declined.resolved).toBe(false);
  });

  it("the content SCOPE reaches the provider verbatim", async () => {
    const seen: string[] = [];
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", {
      provides: { paths: ["characterFontSize"] },
      readProperty: (req) => {
        if (req.target.kind === "selection") seen.push(req.target.scope);
        return { kind: "decline" };
      },
    });
    enter();
    await registry.readProperty({
      path: "characterFontSize",
      target: { kind: "selection", scope: "content" },
    });
    await registry.readProperty({
      path: "characterFontSize",
      target: { kind: "selection", scope: "element" },
    });
    expect(seen).toEqual(["content", "element"]);
  });

  it("a range WRITE lands as a MutationOutcome, the same type core answers", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", docRuns);
    enter();
    const wrote = await registry.writeProperty({
      path: "characterFontSize",
      target: { kind: "element", id: range(0, 3) },
      value: { type: "length", value: 18 },
    });
    expect(wrote).toMatchObject({ handled: true });
    expect((wrote as { outcome: { applied: boolean } }).outcome.applied).toBe(true);
  });
});

// ══════════════════════ consumer 3 — SWATCHES (document-scoped colour)

describe("consumer 3 — SWATCHES/COLOUR: a document-scoped resource", () => {
  /** plugin-sheets' shape: it already mints REAL document swatches for
   *  cell + chart colour through the raw ops, with no panel to drive
   *  them from. Here that write path has a surface. */
  const swatchProvider = () => {
    const swatches = [{ selfId: "sw1", name: "Header", colorValue: [0, 0, 0, 100] }];
    const provider: BindingProvider = {
      provides: {
        collections: ["swatches"],
        paths: ["frameFillColor"],
        ops: ["createSwatch", "deleteSwatch"],
      },
      readCollection: () => ({ kind: "rows", rows: swatches }),
      readProperty: () => ({
        kind: "value",
        value: { type: "colorRef", value: "sw1" },
      }),
      writeProperty: () => ({ kind: "applied", outcome: applied }),
      applyMutation: (m) => {
        if (m.op === "createSwatch") {
          swatches.push({ selfId: "sw2", name: "New", colorValue: [0, 0, 0, 0] });
          return { kind: "applied", outcome: { ...applied, createdId: null } };
        }
        if (m.op === "deleteSwatch") {
          const i = swatches.findIndex((s) => s.selfId === m.args.swatchId);
          if (i >= 0) swatches.splice(i, 1);
          return { kind: "applied", outcome: applied };
        }
        return { kind: "decline" };
      },
    };
    return { swatches, provider };
  };

  it("serves the document swatch list with NO target — it is not per-element", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", swatchProvider().provider);
    enter();
    const read = await registry.readCollection({ collection: "swatches" });
    expect(read).toMatchObject({ resolved: true });
    expect((read as { rows: readonly unknown[] }).rows).toHaveLength(1);
  });

  it("the panel ADDS and DELETES document resources through the mutation lane", async () => {
    const { host, registry, enter } = setup();
    const { swatches, provider } = swatchProvider();
    contributeBindingProvider(host, "rasterImage", provider);
    enter();
    expect(
      await registry.applyMutation({
        op: "createSwatch",
        args: { spec: { name: "New" } as never },
      }),
    ).toMatchObject({ handled: true, provider: "media.paged.test" });
    expect(swatches).toHaveLength(2);
    expect(
      await registry.applyMutation({
        op: "deleteSwatch",
        args: { swatchId: "sw1" },
      }),
    ).toMatchObject({ handled: true });
    expect(swatches.map((s) => s.selfId)).toEqual(["sw2"]);
  });

  it("applying a colour to the SELECTION is the ordinary property lane", async () => {
    const { host, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", swatchProvider().provider);
    enter();
    expect(
      await registry.writeProperty({
        path: "frameFillColor",
        target: { kind: "selection", scope: "element" },
        value: { type: "colorRef", value: "sw1" },
      }),
    ).toMatchObject({ handled: true });
  });

  it("document-scoped does NOT mean always-on: the context still gates it", async () => {
    const { host, registry, enter, exit } = setup();
    contributeBindingProvider(host, "rasterImage", swatchProvider().provider);
    enter();
    expect((await registry.readCollection({ collection: "swatches" })).resolved).toBe(
      true,
    );
    exit();
    // Deliberate: the host Swatches panel retargets to the DOCUMENT's own
    // swatches the moment you leave the plugin's frame.
    expect((await registry.readCollection({ collection: "swatches" })).resolved).toBe(
      false,
    );
  });
});

// ═══════════════════════════════════════════ invalidation + teardown

describe("invalidation + teardown", () => {
  const trivial: BindingProvider = {
    provides: { collections: ["layers"] },
    readCollection: () => ({ kind: "rows", rows: [] }),
  };

  it("invalidate() fans out to the host's re-read subscribers", () => {
    const { host, registry, enter } = setup();
    const handle = contributeBindingProvider(host, "rasterImage", trivial);
    let ticks = 0;
    const sub = registry.onDidChange(() => ticks++);
    handle.invalidate();
    expect(ticks).toBe(1);
    // Entering / leaving a context is also a re-read signal.
    enter();
    expect(ticks).toBe(2);
    sub.dispose();
    handle.invalidate();
    expect(ticks).toBe(2);
  });

  it("disposing the handle removes the provider WITHOUT touching the context", async () => {
    const { host, registry, fake, enter } = setup();
    const handle = contributeBindingProvider(host, "rasterImage", trivial);
    enter();
    expect(registry.activeProviders()).toHaveLength(1);
    handle.dispose();
    expect(registry.activeProviders()).toHaveLength(0);
    // The edit context is untouched — phase D retires a duplicate panel
    // behind the seam and rolls back by disposing ONE handle.
    expect(fake.editContexts.types()).toEqual(["rasterImage"]);
    expect((await registry.readCollection({ collection: "layers" })).resolved).toBe(
      false,
    );
  });

  it("host dispose() tears the provider down with everything else", async () => {
    const { host, dispose, registry, enter } = setup();
    contributeBindingProvider(host, "rasterImage", trivial);
    enter();
    expect(registry.activeProviders()).toHaveLength(1);
    dispose();
    expect(registry.activeProviders()).toHaveLength(0);
  });
});
