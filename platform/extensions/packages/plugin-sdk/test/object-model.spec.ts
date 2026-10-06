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

// @feat: plugin-platform.object-model
//
// ADR 323 on the REAL headless engine (the published canvas-wasm): the
// reference `acme.notes` bundle contributes a kind whose state lives
// outside core (content-addressed part + label hash), and `host.objects`
// proves get / set / batch / query / schema / invoke / onDidChange over it
// AND over core addresses — with a mixed batch landing as ONE undo step
// and ONE engine mutation.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { minimalIdml } from "./fixtures/minimal-idml";
import { makeNotesBundle, notesManifest, NOTES_ID } from "./fixtures/notes-bundle";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

const NOTE = `plugin:${NOTES_ID}/note`;

/** A loaded document with one rectangle, the notes bundle attached to it. */
async function setup(): Promise<{ h: HeadlessHost; rect: string; notes: string[] }> {
  const h = (live = await createHeadlessHost({ console: silent }));
  const [pageId] = await h.load(minimalIdml());
  const made = await h.host.document.mutate({
    op: "insertFrame",
    args: { pageId: pageId!, bounds: [10, 10, 110, 210] },
  });
  expect(made.applied).toBe(true);
  const created = (made as { createdId?: { kind: string; id: string } }).createdId!;
  const rect = `${created.kind}:${created.id}`;
  h.loadBundle(makeNotesBundle());
  const count = await h.objects.invoke("acme.notes.attach", { frame: rect, count: 2 });
  expect(count).toBe(2);
  const notes = await h.objects.query(NOTE);
  return { h, rect, notes };
}

const value = (v: unknown) => ({ kind: "value", value: v });

describe("host.objects — registry over core and a plugin (ADR 323, real engine)", () => {
  it("kinds() lists the core kinds and the contributed plugin kind", async () => {
    const { h } = await setup();
    const kinds = await h.objects.kinds();
    const names = kinds.map((k) => k.kind);
    expect(names).toEqual(expect.arrayContaining(["doc", "frame", "page", "layer", "swatch", "style", NOTE]));
    expect(kinds.find((k) => k.kind === NOTE)).toMatchObject({
      owner: NOTES_ID,
      title: "Note",
      addressForm: `${NOTE}/<id>`,
    });
  });

  it("schema() answers the plugin's rows (qualified) and core's rows", async () => {
    const { h, notes } = await setup();
    const rows = await h.objects.schema(NOTE);
    // The declared rows, plus `content` (the kind declares a ContentSchema).
    expect(rows.map((r) => r.path)).toEqual(["text", "size", "visible", "tone", "length", "content"]);
    expect(rows[0]!.addressKind).toBe(NOTE);
    expect(await h.objects.schema(notes[0]!)).toEqual(rows);
    const frameRows = await h.objects.schema("frame");
    expect(frameRows.find((r) => r.path === "frameStrokeWeight")?.type).toEqual({ kind: "length" });
    expect(frameRows.find((r) => r.path === "frameFillColor")?.type).toEqual({ kind: "color" });
    expect(await h.objects.schema("plugin:nobody/x")).toEqual([]);
  });

  it("query() — kind, predicates (plugin-honoured and registry-filtered), limit", async () => {
    const { h, notes } = await setup();
    expect(notes).toEqual([`${NOTE}/n1`, `${NOTE}/n2`]);
    expect(await h.objects.query(`${NOTE}[text="hello"]`)).toEqual([`${NOTE}/n1`]);
    expect(await h.objects.query(`${NOTE}[text^=note]`)).toEqual([`${NOTE}/n2`]);
    expect(await h.objects.query(`${NOTE}[size!=12]`)).toEqual([]);
    expect(await h.objects.query(NOTE, { limit: 1 })).toEqual([`${NOTE}/n1`]);
    expect(await h.objects.query(`${NOTE}:nth(2)`)).toEqual([`${NOTE}/n2`]);
    expect(await h.objects.query("frame[name")).toEqual([]);
  });

  it("query() — core kinds through the containment tree", async () => {
    const { h, rect } = await setup();
    expect(await h.objects.query("frame")).toContain(rect);
    expect(await h.objects.query("page:#1 > rectangle")).toContain(rect);
    expect(await h.objects.query(rect)).toEqual([rect]);
    expect((await h.objects.query("page")).length).toBeGreaterThan(0);
    expect(await h.objects.query("swatch[name=Black]")).toEqual(["swatch:Color/Black"]);
  });

  it("get() / set() on a plugin object, schema-validated before the plugin is asked", async () => {
    const { h, notes } = await setup();
    const n1 = notes[0]!;
    expect(await h.objects.get(n1, "text")).toEqual(value("hello"));
    expect(await h.objects.get(n1, "length")).toEqual(value(5));
    expect(await h.objects.get(n1, "nope")).toMatchObject({ kind: "refused", code: "unknownPath" });
    expect(await h.objects.get(`${NOTE}/zz`, "text")).toMatchObject({ kind: "refused", code: "unknownAddress" });

    expect(await h.objects.set(n1, "size", 99)).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await h.objects.set(n1, "tone", "green")).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await h.objects.set(n1, "length", 3)).toMatchObject({ applied: false, code: "readOnly" });

    const out = await h.objects.set(n1, "size", 18);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(n1, "size")).toEqual(value(18));
    expect(await h.objects.getAll(n1)).toMatchObject({ size: value(18), text: value("hello"), tone: value("red") });
  });

  it("get() / set() on core addresses, mapped onto today's wire", async () => {
    const { h, rect } = await setup();
    expect(await h.objects.set(rect, "frameStrokeWeight", 3)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(value(3));
    // `frame:` is a kind-agnostic alias, resolved through the tree.
    const id = rect.split(":")[1];
    expect(await h.objects.get(`frame:${id}`, "frameStrokeWeight")).toEqual(value(3));
    expect(await h.objects.set(rect, "frameStrokeWeight", "thick")).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await h.objects.get("rectangle:nope", "frameStrokeWeight")).toMatchObject({ kind: "refused", code: "unknownAddress" });

    // The minimal fixture has no layer; make one through the core op.
    expect((await h.host.document.mutate({ op: "layerInsert", args: { position: 0, name: "Copy" } })).applied).toBe(true);
    const [layer] = await h.objects.query("layer[name=Copy]");
    expect(layer).toBeDefined();
    expect(await h.objects.set(layer!, "layerVisible", false)).toMatchObject({ applied: true });
    expect(await h.objects.get(layer!, "layerVisible")).toEqual(value(false));
    expect(await h.objects.get("doc", "pageCount")).toEqual(value(1));
  });

  it("a MIXED batch (core + plugin) is ONE engine mutation and ONE undo step", async () => {
    const { h, rect, notes } = await setup();
    await h.objects.set(rect, "frameStrokeWeight", 3);
    const mutate = vi.spyOn(h.host.editor.client, "mutate");
    const out = await h.objects.batch([
      { op: "set", address: rect, path: "frameStrokeWeight", value: 5 },
      { op: "set", address: notes[0]!, path: "text", value: "batched" },
      { op: "set", address: notes[1]!, path: "size", value: 20 },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(value(5));
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("batched"));
    expect(await h.objects.get(notes[1]!, "size")).toEqual(value(20));

    await h.host.document.undo();
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(value(3));
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("hello"));
    expect(await h.objects.get(notes[1]!, "size")).toEqual(value(12));

    await h.host.document.redo();
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("batched"));
  });

  it("a batch is all-or-nothing: one bad op applies none", async () => {
    const { h, rect, notes } = await setup();
    const mutate = vi.spyOn(h.host.editor.client, "mutate");
    const out = await h.objects.batch([
      { op: "set", address: notes[0]!, path: "text", value: "never" },
      { op: "set", address: rect, path: "frameStrokeWeight", value: 4 },
      { op: "set", address: notes[1]!, path: "size", value: 1000 },
    ]);
    expect(out).toMatchObject({ applied: false, code: "invalidValue", index: 2, undoSteps: 0 });
    expect(mutate).not.toHaveBeenCalled();
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("hello"));
  });

  it("create / delete route to the owning kind's batch", async () => {
    const { h } = await setup();
    expect(await h.objects.batch([{ op: "create", kind: NOTE, props: { text: "third" } }])).toMatchObject({
      applied: true,
    });
    expect(await h.objects.query(`${NOTE}[text=third]`)).toEqual([`${NOTE}/n3`]);
    expect(await h.objects.batch([{ op: "delete", address: `${NOTE}/n3` }])).toMatchObject({ applied: true });
    expect(await h.objects.query(NOTE)).toHaveLength(2);
    // A CORE create (protocol 71) is validated like any other op…
    expect(await h.objects.batch([{ op: "create", kind: "rectangle" }])).toMatchObject({
      applied: false,
      code: "invalidValue",
    });
    // …and a kind nobody creates is unmapped.
    expect(await h.objects.batch([{ op: "create", kind: "spread" }])).toMatchObject({
      applied: false,
      code: "unmapped",
    });
  });

  it("typed commands: listed with schemas, args validated before the handler", async () => {
    const { h } = await setup();
    expect(await h.objects.commands()).toEqual([
      expect.objectContaining({ id: "acme.notes.attach", owner: NOTES_ID }),
    ]);
    await expect(h.objects.invoke("acme.notes.attach", { frame: "x", count: "two" })).rejects.toThrow(/^invalidValue/);
    await expect(h.objects.invoke("acme.notes.nope", {})).rejects.toThrow(/^unknownCommand/);
  });

  it("onDidChange — plugin writes and engine mutations both notify, filtered by selector", async () => {
    const { h, rect, notes } = await setup();
    const all: unknown[] = [];
    const onlyNotes: unknown[] = [];
    const d1 = h.objects.onDidChange((e) => all.push(e));
    const d2 = h.objects.onDidChange((e) => onlyNotes.push(e), { selector: notes[0]! });
    await h.objects.set(notes[0]!, "text", "x");
    await h.objects.set(rect, "frameStrokeWeight", 2);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(onlyNotes.length).toBeGreaterThanOrEqual(1);
    d1.dispose();
    d2.dispose();
  });

  it("the bundle's own host.objects is capability-gated by its manifest", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    let surface: import("@paged-media/plugin-api").ObjectsSurface | null = null;
    h.loadBundle({
      manifest: { ...notesManifest, id: "acme.ro", contributes: {}, capabilities: { document: { read: "broad" } } },
      activate(host) {
        surface = host.objects;
        expect(host.supports("objects@1")).toBe(true);
        expect(host.supports("contribute.objectModel@1")).toBe(true);
        return { dispose() {} };
      },
    });
    expect(await surface!.get("doc", "pageCount")).toEqual(value(1));
    expect(await surface!.set("doc", "defaultStrokeWeight", 2)).toMatchObject({ applied: false, code: "denied" });
  });

  it("contribute.objectModel refuses an undeclared kind and an empty schema", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    expect(() =>
      h.loadBundle(makeNotesBundle({ ...notesManifest, contributes: {} })),
    ).toThrow(/contributes\.objectModel/);
  });
});
