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

// @feat: plugin-platform.object-model.panel-property
//
// List and struct VALUES on property rows (DESIGN.md §12.8): a host's list
// field edits a stack (add / remove / move / item-set) and a struct field
// edits one field; the SDK lowers each edit to plain `set` ops — one batch,
// one undo step — and the panel validator holds `items` / `fields` to the
// row's value type.

import { afterEach, describe, expect, it } from "vitest";

import type {
  BundleHost,
  ObjectOp,
  ObjectWrite,
  PagedBundle,
  PanelSchema,
  PluginManifest,
  PropertySchema,
  ValueType,
} from "@paged-media/plugin-api";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { applyValueEdit, defaultValueOf, editValue, planValueEdit } from "../src/value-edit";
import { propertyRow, validatePanelSchema } from "../src/panel-schema-check";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const STOP: ValueType = {
  kind: "struct",
  fields: {
    color: { kind: "color" },
    location: { kind: "number", unit: "percent", default: 0 },
    midpoint: { kind: "number", unit: "percent", optional: true },
  },
};
const ANCHOR: ValueType = { kind: "struct", fields: { x: { kind: "number" }, y: { kind: "number" } } };
const ROWS: PropertySchema[] = [
  { path: "stops", type: { kind: "list", of: STOP, maxItems: 4 }, default: [] },
  { path: "anchor", type: ANCHOR },
  { path: "tags", type: { kind: "list", of: { kind: "enum", members: ["a", "b"] } } },
  // Items typed only by their fields (no whole-list row): item-set lowers
  // to `set marks[i].label`.
  { path: "marks[].label", type: { kind: "text" } },
];

describe("defaultValueOf / applyValueEdit (pure)", () => {
  it("builds a new item from the type", () => {
    expect(defaultValueOf(STOP)).toEqual({ color: "Color/Black", location: 0 });
    expect(defaultValueOf({ kind: "enum", members: ["a", "b"] })).toBe("a");
    expect(defaultValueOf({ kind: "list", of: STOP })).toEqual([]);
    expect(defaultValueOf({ kind: "bool" })).toBe(false);
  });

  it("add / remove / move / itemSet / fieldSet", () => {
    const list = ROWS[0]!.type;
    const s = [{ color: "Color/Red", location: 0 }, { color: "Color/Blue", location: 100 }];
    expect(applyValueEdit(s, { edit: "add" }, list)).toEqual({ ok: true, value: [...s, { color: "Color/Black", location: 0 }] });
    expect(applyValueEdit(s, { edit: "add", index: 0, item: { color: "Color/Paper", location: 50 } }, list)).toMatchObject({
      ok: true,
      value: [{ color: "Color/Paper", location: 50 }, ...s],
    });
    expect(applyValueEdit(s, { edit: "remove", index: 0 }, list)).toEqual({ ok: true, value: [s[1]] });
    expect(applyValueEdit(s, { edit: "move", from: 0, to: 1 }, list)).toEqual({ ok: true, value: [s[1], s[0]] });
    expect(applyValueEdit(s, { edit: "itemSet", index: 1, field: "location", value: 80 }, list)).toEqual({
      ok: true,
      value: [s[0], { color: "Color/Blue", location: 80 }],
    });
    expect(applyValueEdit({ x: 1, y: 2 }, { edit: "fieldSet", field: "y", value: 5 }, ANCHOR)).toEqual({ ok: true, value: { x: 1, y: 5 } });
  });

  it("refuses edits the type does not allow", () => {
    const list = ROWS[0]!.type;
    const four = [0, 1, 2, 3].map((i) => ({ color: "Color/Red", location: i }));
    expect(applyValueEdit(four, { edit: "add" }, list)).toMatchObject({ ok: false, reason: expect.stringMatching(/maxItems/) });
    expect(applyValueEdit([], { edit: "remove", index: 0 }, list)).toMatchObject({ ok: false });
    expect(applyValueEdit([{ color: "Color/Red", location: 0 }], { edit: "itemSet", index: 0, field: "nope", value: 1 }, list)).toMatchObject({ ok: false });
    expect(applyValueEdit([{ color: "Color/Red", location: 0 }], { edit: "itemSet", index: 0, field: "location", value: "x" }, list)).toMatchObject({ ok: false });
    expect(applyValueEdit({ x: 1, y: 2 }, { edit: "add" }, ANCHOR)).toMatchObject({ ok: false });
    expect(applyValueEdit([], { edit: "fieldSet", field: "x", value: 1 }, list)).toMatchObject({ ok: false });
  });
});

// ------------------------------------------------- through host.objects

const SWATCH_ID = "acme.ramps";
const RAMP = `plugin:${SWATCH_ID}/ramp`;
type Ramp = { stops: unknown[]; anchor: { x: number; y: number }; tags: string[]; marks: { label: string }[] };

function rampsBundle(seen: ObjectOp[][]): PagedBundle {
  const manifest: PluginManifest = {
    id: SWATCH_ID,
    name: "Ramps",
    version: "0.0.0",
    apiVersion: "^0.2.0",
    capabilities: { document: { read: "broad", write: "broad" } },
    contributes: { objectModel: { kinds: [{ kind: "ramp", title: "Ramp", schema: ROWS }] } },
  };
  // In-memory state with an undo stack driven by core's label (one page
  // label per write = one engine undo step).
  const ramps: Record<string, Ramp> = {
    r1: {
      stops: [{ color: "Color/Red", location: 0 }, { color: "Color/Blue", location: 100 }],
      anchor: { x: 1, y: 2 },
      tags: ["a"],
      marks: [{ label: "one" }, { label: "two" }],
    },
  };
  return {
    manifest,
    activate(host: BundleHost) {
      return host.contribute.objectModel({
        kinds: [
          {
            kind: "ramp",
            title: "Ramp",
            schema: ROWS,
            hostOf: () => "doc",
            list: () => Object.keys(ramps).map((id) => `${RAMP}/${id}`),
            get(address, path) {
              const r = ramps[address.split("/").pop()!];
              if (!r) return { kind: "refused", code: "unknownAddress", reason: address };
              const m = /^marks\[(\d+)\]\.label$/.exec(path);
              if (m) return { kind: "value", value: r.marks[Number(m[1])]?.label };
              return path in r ? { kind: "value", value: structuredClone((r as Record<string, unknown>)[path]) } : { kind: "absent" };
            },
            batch(ops): ObjectWrite {
              seen.push([...ops]);
              for (const op of ops) {
                if (op.op !== "set") return { kind: "rejected", reason: "set only" };
                const r = ramps[op.address.split("/").pop()!]!;
                const m = /^marks\[(\d+)\]\.label$/.exec(op.path);
                if (m) r.marks[Number(m[1])]!.label = op.value as string;
                else (r as Record<string, unknown>)[op.path] = op.value;
              }
              return { kind: "state", parts: [], host: "doc", labelKey: `x-paged:${SWATCH_ID}`, labelValue: JSON.stringify({ v: 1, data: { n: seen.length } }) };
            },
          },
        ],
      });
    },
  };
}

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function setup() {
  const h = (live = await createHeadlessHost({ console: silent }));
  await h.load(minimalIdml());
  const seen: ObjectOp[][] = [];
  h.loadBundle(rampsBundle(seen));
  return { h, seen, r1: `${RAMP}/r1` };
}

describe("planValueEdit / editValue over host.objects", () => {
  it("a list edit is ONE set of the whole list, one batch, one undo step", async () => {
    const { h, seen, r1 } = await setup();
    const out = await editValue(h.objects, [r1], "stops", { edit: "move", from: 1, to: 0 });
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(seen).toEqual([[{ op: "set", address: r1, path: "stops", value: [{ color: "Color/Blue", location: 100 }, { color: "Color/Red", location: 0 }] }]]);
    expect(await h.objects.get(r1, "stops")).toMatchObject({ value: [{ color: "Color/Blue" }, { color: "Color/Red" }] });
  });

  it("a struct edit sets the whole struct", async () => {
    const { h, r1 } = await setup();
    const plan = await planValueEdit(h.objects, [r1], "anchor", { edit: "fieldSet", field: "x", value: 9 });
    expect(plan).toEqual({ ok: true, ops: [{ op: "set", address: r1, path: "anchor", value: { x: 9, y: 2 } }] });
  });

  it("items typed only by field rows: item-set lowers to set path[i].field; add is refused", async () => {
    const { h, r1 } = await setup();
    expect(await planValueEdit(h.objects, [r1], "marks", { edit: "itemSet", index: 1, field: "label", value: "TWO" })).toEqual({
      ok: true,
      ops: [{ op: "set", address: r1, path: "marks[1].label", value: "TWO" }],
    });
    expect(await planValueEdit(h.objects, [r1], "marks", { edit: "add" })).toMatchObject({ ok: false, code: "unknownPath" });
  });

  it("refusals are typed and nothing applies", async () => {
    const { h, seen, r1 } = await setup();
    expect(await editValue(h.objects, [r1], "tags", { edit: "itemSet", index: 0, value: "z" })).toMatchObject({
      applied: false,
      code: "invalidValue",
      undoSteps: 0,
    });
    expect(await editValue(h.objects, [r1], "nope", { edit: "add" })).toMatchObject({ applied: false, code: "unknownPath" });
    expect(seen).toEqual([]);
  });
});

describe("validatePanelSchema — items / fields", () => {
  const schemaOf = (k: string) => (k === RAMP ? ROWS : undefined);
  const panel = (row: ReturnType<typeof propertyRow>): PanelSchema => ({ id: "p", sections: [{ rows: [row] }] }) as PanelSchema;

  it("accepts items on a list row and fields on a struct row", () => {
    expect(validatePanelSchema(panel(propertyRow("stops", { bind: "ramp" }, { kind: RAMP, items: { fields: ["color", { field: "location", label: "Location" }], itemLabel: "color", reversed: true } })), { schemaOf })).toEqual([]);
    expect(validatePanelSchema(panel(propertyRow("anchor", { bind: "ramp" }, { kind: RAMP, fields: ["x", "y"] })), { schemaOf })).toEqual([]);
  });

  it("reports items on a non-list, fields on a non-struct, and unknown fields", () => {
    const issues = (row: ReturnType<typeof propertyRow>) => validatePanelSchema(panel(row), { schemaOf }).map((i) => i.message);
    expect(issues(propertyRow("anchor", { bind: "r" }, { kind: RAMP, items: {} }))).toEqual([expect.stringMatching(/items.*list/)]);
    expect(issues(propertyRow("stops", { bind: "r" }, { kind: RAMP, fields: ["x"] }))).toEqual([expect.stringMatching(/fields.*struct/)]);
    expect(issues(propertyRow("stops", { bind: "r" }, { kind: RAMP, items: { fields: ["hue"], itemLabel: "nope" } }))).toEqual([
      expect.stringMatching(/hue/),
      expect.stringMatching(/itemLabel.*nope/),
    ]);
    expect(issues(propertyRow("stops", { bind: "r" }, { kind: RAMP, items: { newItem: { color: 3 } } }))).toEqual([expect.stringMatching(/newItem/)]);
  });
});
