/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// paged.data's template field kinds (plan G3) and inspection commands (G4)
// on the real bundle, the real data engine, DuckDB and the real canvas
// engine: a template binds the rectangle's stroke weight and visibility to
// a query, opens a part of that to a filler, and the session becomes a
// FILLER — every write checked by the engine against the role.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { TemplateFieldRef } from "@paged-media/plugin-api";

import { headlessEnv, readiness, type DataEnv } from "../conformance/env";
import { D, seed } from "../conformance/scenarios";

type Env = DataEnv & { h: HeadlessHost };
const gate = readiness(true);
const MM = 72 / 25.4;
const RECT = "rectangle:urect";

const send = (env: Env, kind: string, payload?: unknown) =>
  (
    env.h.host.editor.client as unknown as {
      send(m: unknown): Promise<{
        kind: string;
        payload: { createdId?: { id: string } };
      }>;
    }
  ).send(payload === undefined ? { kind } : { kind, payload });

const role = async (env: Env, r: "author" | "filler") =>
  expect(
    (await send(env, "setSessionPolicy", { policy: { role: r } })).kind,
  ).toBe("sessionPolicyApplied");

/** The author makes an item a data field. */
async function field(
  env: Env,
  element: { kind: string; id: string },
  name: string,
  kind: string,
  def: unknown,
  grants = ["appearance.stroke", "item.visibility"],
): Promise<TemplateFieldRef> {
  const r = await send(env, "mutate", {
    op: "setPluginMetadata",
    args: {
      elementId: element,
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: {
          field: { name, kind: "module", module: { kind, grants, def } },
        },
      }),
    },
  });
  expect(r.kind).toBe("mutationApplied");
  return { name, targetId: element.id, kind, def };
}

const prop = async (env: Env, path: string) => {
  const v = await env.objects.get(RECT as never, path);
  return v.kind === "value" ? v.value : v;
};

/** The rectangle's stroke weight from `weight_mm`, its visibility from
 *  `shown`; the first record placed. */
async function bind(env: Env): Promise<void> {
  await seed(env);
  const r = (await env.objects.invoke(`${D}.defineProperty` as never, {
    id: "weight",
    selector: RECT,
    path: "frameStrokeWeight",
    query: "q",
    expr: "MM(weight_mm)",
  })) as { ok: boolean; reason?: string };
  expect(r.ok, r.reason).toBe(true);
  env.session.addVisibilityBinding("badge", "urect", "q", "shown", {
    kind: "rectangle",
  });
  await env.session.lowerAll();
  await env.settle();
  await role(env, "author");
}

const K = "media.paged.data";

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data template fields on the real engines${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: Env;
    beforeEach(async () => {
      env = (await headlessEnv()) as Env;
    });
    afterEach(() => env.dispose());

    it("lists its kinds", async () => {
      expect(
        (await env.objects.templateFieldKinds()).map((k) => [
          k.kind,
          k.control.kind,
        ]),
      ).toEqual([
        [`${K}.record`, "choice"],
        [`${K}.bindingValue`, "text"],
        [`${K}.dataSet`, "choice"],
        [`${K}.variable`, "text"],
      ]);
    });

    it("record — a filler chooses the record that fills the item; the choice is saved with the session", async () => {
      await bind(env);
      const f = await field(
        env,
        { kind: "rectangle", id: "urect" },
        "product",
        `${K}.record`,
        { query: "q", label: "name" },
      );
      await role(env, "filler");
      expect(await env.objects.readTemplateField(f)).toEqual({
        control: {
          kind: "choice",
          options: [
            { value: "1", label: "Alpha" },
            { value: "2", label: "Beta" },
            { value: "3", label: "Gamma" },
          ],
        },
        value: null,
      });
      expect(await env.objects.writeTemplateField(f, "2")).toEqual({
        ok: true,
      });
      expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(4 * MM, 5);
      expect(await prop(env, "elementVisible")).toBe(false);
      expect((await env.objects.readTemplateField(f)).value).toBe("2");
      expect(env.session.getState().preview).toEqual({ q: 1 });
      expect(await env.objects.writeTemplateField(f, "7")).toEqual({
        ok: false,
        problem: '"7" is not a record of "q" (1 to 3).',
      });
      // One undo step takes the record back.
      await env.undo();
      expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(2 * MM, 5);
    });

    it("record — a field on another item may not write the rectangle: refused, nothing changes", async () => {
      await bind(env);
      const frame = await send(env, "mutate", {
        op: "insertTextFrame",
        args: { pageId: "usp", bounds: [200, 10, 220, 100] },
      });
      const f = await field(
        env,
        { kind: "textFrame", id: frame.payload.createdId!.id },
        "product",
        `${K}.record`,
        { query: "q" },
      );
      await role(env, "filler");
      const r = await env.objects.writeTemplateField(f, "2");
      expect(r.ok).toBe(false);
      expect(r).toEqual({
        ok: false,
        problem:
          "Record 2 could not be shown: this template does not let a filler change item urect (appearance.stroke).",
      });
      expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(2 * MM, 5);
      expect((await env.objects.readTemplateField(f)).value).toBeNull();
    });

    it("bindingValue — a property set by hand and pinned; a refresh leaves it", async () => {
      await bind(env);
      const f = await field(
        env,
        { kind: "rectangle", id: "urect" },
        "weight",
        `${K}.bindingValue`,
        { binding: "weight" },
      );
      await role(env, "filler");
      const read = await env.objects.readTemplateField(f);
      expect(read.control).toEqual({ kind: "number", min: 0 });
      expect(read.value as number).toBeCloseTo(2 * MM, 5);
      expect(await env.objects.writeTemplateField(f, 3)).toEqual({ ok: true });
      expect(await prop(env, "frameStrokeWeight")).toBe(3);
      expect(env.session.syncStatusOf("weight")).toBe("pinned");
      expect(await env.objects.writeTemplateField(f, -1)).toEqual({
        ok: false,
        problem: "-1 is less than 0.",
      });
      await env.objects.invoke(`${D}.refresh` as never, {});
      expect(await prop(env, "frameStrokeWeight")).toBe(3);
    });

    it("variable — a visibility variable by its name; a toggle", async () => {
      await bind(env);
      const f = await field(
        env,
        { kind: "rectangle", id: "urect" },
        "badge",
        `${K}.variable`,
        { name: "badge" },
      );
      await role(env, "filler");
      expect(await env.objects.readTemplateField(f)).toEqual({
        control: { kind: "toggle" },
        value: true,
      });
      expect(await env.objects.writeTemplateField(f, "yes")).toEqual({
        ok: false,
        problem: '"yes" is not on or off.',
      });
      expect(await env.objects.writeTemplateField(f, false)).toEqual({
        ok: true,
      });
      expect(await prop(env, "elementVisible")).toBe(false);
    });

    it("dataSet — a filler picks one of the allowed captured sets, applied in one batch", async () => {
      await bind(env);
      await env.objects.invoke(`${D}.captureDataSet` as never, {
        name: "Alpha",
        record: 0,
      });
      await env.objects.invoke(`${D}.captureDataSet` as never, {
        name: "Beta",
        record: 1,
      });
      await env.objects.invoke(`${D}.captureDataSet` as never, {
        name: "Gamma",
        record: 2,
      });
      const f = await field(
        env,
        { kind: "rectangle", id: "urect" },
        "edition",
        `${K}.dataSet`,
        { allowed: ["Alpha", "Beta"] },
      );
      await role(env, "filler");
      expect(await env.objects.readTemplateField(f)).toEqual({
        control: {
          kind: "choice",
          options: [{ value: "Alpha" }, { value: "Beta" }],
        },
        value: null,
      });
      expect(await env.objects.writeTemplateField(f, "Gamma")).toEqual({
        ok: false,
        problem: '"Gamma" is not one of the data sets (Alpha, Beta).',
      });
      expect(await env.objects.writeTemplateField(f, "Beta")).toEqual({
        ok: true,
      });
      expect(await prop(env, "elementVisible")).toBe(false);
      expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(4 * MM, 5);
      expect((await env.objects.readTemplateField(f)).value).toBe("Beta");
    });
  },
);

describe.skipIf(!gate.ready && !gate.required)(
  "paged.data inspection commands (plan G4)",
  () => {
    setDefaultTimeout(60_000);
    let env: Env;
    beforeEach(async () => {
      env = (await headlessEnv()) as Env;
    });
    afterEach(() => env.dispose());

    it("previewQuery / checkExpression / refreshDiff — read, never write", async () => {
      covers(
        "command:media.paged.data.previewQuery",
        "command:media.paged.data.checkExpression",
        "command:media.paged.data.refreshDiff",
      );
      await bind(env);
      const m = env.mark();
      expect(
        await env.objects.invoke(`${D}.previewQuery` as never, {
          sql: "SELECT sku, name FROM products ORDER BY sku",
          limit: 2,
        }),
      ).toEqual({
        columns: ["sku", "name"],
        rows: [
          ["A-1", "Alpha"],
          ["B-2", "Beta"],
        ],
        total: 3,
      });
      const bad = (await env.objects.invoke(`${D}.previewQuery` as never, {
        sql: "DELETE FROM products",
      })) as { problem?: string; rows: unknown[] };
      expect(bad.rows).toEqual([]);
      expect(bad.problem).toBeTruthy();
      expect(
        await env.objects.invoke(`${D}.checkExpression` as never, {
          expr: "UPPER(name)",
          query: "q",
        }),
      ).toEqual({ ok: true, fields: ["name"], unknownFields: [] });
      const unknown = (await env.objects.invoke(
        `${D}.checkExpression` as never,
        { expr: "UPPER(nope)", query: "q" },
      )) as { unknownFields: string[] };
      expect(unknown.unknownFields).toEqual(["nope"]);
      const diff = (await env.objects.invoke(
        `${D}.refreshDiff` as never,
        {},
      )) as { binding: string; change: string }[];
      expect(diff.map((d) => d.binding).sort()).toEqual(["badge", "weight"]);
      expect(env.writesSince(m)).toEqual([]);
    });

    it("previewRecordFlow — the blocks a record flow would place, nothing written", async () => {
      covers("command:media.paged.data.previewRecordFlow");
      await seed(env);
      env.session.defineRecordFlow("rf", "q", [{ expr: "sku" }]);
      await env.session.refreshData();
      const m = env.mark();
      expect(
        await env.objects.invoke(`${D}.previewRecordFlow` as never, {
          binding: "rf",
        }),
      ).toEqual({ total: 3, blocks: ["A-1", "B-2", "C-3"] });
      expect(env.writesSince(m)).toEqual([]);
    });

    it("captureEveryRecord / exportVariableLibrary / importVariableLibrary — the variable set, never the document", async () => {
      covers(
        "command:media.paged.data.captureEveryRecord",
        "command:media.paged.data.exportVariableLibrary",
        "command:media.paged.data.importVariableLibrary",
      );
      await bind(env);
      const m = env.mark();
      expect(
        await env.objects.invoke(`${D}.captureEveryRecord` as never, {
          query: "q",
          nameColumn: "name",
        }),
      ).toEqual(["Alpha", "Beta", "Gamma"]);
      const xml = (await env.objects.invoke(
        `${D}.exportVariableLibrary` as never,
        {},
      )) as string;
      expect(xml).toContain("Beta");
      await env.session.deleteDataSet("Beta");
      const report = (await env.objects.invoke(
        `${D}.importVariableLibrary` as never,
        { xml },
      )) as { dataSets: number };
      expect(report.dataSets).toBe(3);
      expect(await env.session.listDataSets()).toEqual([
        "Alpha",
        "Beta",
        "Gamma",
      ]);
      expect(env.writesSince(m)).toEqual([]);
    });
  },
);
