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

// The typed commands the Node CLI drives paged.data through (plan G4):
// importSource (a data file's bytes as a source), defineBinding (a session
// binding kind, as the Bindings panel defines it) and planBatch (the units
// of a per-record or per-group batch). The UNIT layer: the real bundle on
// the SDK's in-process host over the recording fake editor, with the real
// data-js engine and a real DuckDB.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";

import { readiness, unitEnv, type DataEnv } from "./conformance/env";
import { CSV, D, seed } from "./conformance/scenarios";

const gate = readiness(false);

const invoke = (env: DataEnv, id: string, args: unknown) =>
  env.objects.invoke(`${D}.${id}` as never, args);

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data automation commands on the fake editor${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: DataEnv;
    beforeEach(async () => {
      env = await unitEnv();
    });
    afterEach(() => env.dispose());

    it("importSource — a file's bytes become a source a query reads; a format it does not read is refused", async () => {
      covers("command:media.paged.data.importSource");
      const out = await invoke(env, "importSource", {
        bytes: new TextEncoder().encode(CSV),
        fileName: "products.csv",
        name: "items",
      });
      expect(out).toEqual({ source: "items", format: "csv" });
      expect(
        await invoke(env, "previewQuery", {
          sql: "SELECT name FROM items ORDER BY sku",
        }),
      ).toEqual({
        columns: ["name"],
        rows: [["Alpha"], ["Beta"], ["Gamma"]],
        total: 3,
      });
      await expect(
        invoke(env, "importSource", {
          bytes: new Uint8Array([1, 2, 3]),
          fileName: "notes.docx",
        }),
      ).rejects.toThrow(/invalidValue: .*not a file the data plugin imports/);
    });

    it("defineBinding — a session kind, as the panel defines it; a missing field is refused by name", async () => {
      covers("command:media.paged.data.defineBinding");
      await seed(env);
      expect(
        await invoke(env, "defineBinding", {
          id: "badge",
          kind: "visibility",
          query: "q",
          target: "urect",
          expr: "shown",
        }),
      ).toEqual({ id: "badge", kind: "visibility" });
      expect(env.session.listBindings().map((b) => b.id)).toContain("badge");
      await expect(
        invoke(env, "defineBinding", {
          id: "label",
          kind: "variable",
          query: "q",
          expr: "name",
        }),
      ).rejects.toThrow(/a variable binding needs "target"/);
    });

    it("planBatch — one unit per record, per group, or one catalogue", async () => {
      covers("command:media.paged.data.planBatch");
      await seed(env);
      const perRecord = (await invoke(env, "planBatch", {
        query: "q",
        mode: "perRecord",
      })) as { totalRecords: number; units: { records: number[] }[] };
      expect(perRecord.totalRecords).toBe(3);
      expect(perRecord.units.map((u) => u.records)).toEqual([[0], [1], [2]]);
      const perGroup = (await invoke(env, "planBatch", {
        query: "q",
        mode: "perGroup",
        by: ["shown"],
      })) as { units: { label: string; records: number[] }[] };
      expect(perGroup.units.map((u) => u.records.length).sort()).toEqual([
        1, 2,
      ]);
      const one = (await invoke(env, "planBatch", {
        mode: "oneCatalog",
      })) as { query: string; units: { records: number[] }[] };
      expect(one.query).toBe("q");
      expect(one.units).toHaveLength(1);
      await expect(
        invoke(env, "planBatch", { mode: "perGroup" }),
      ).rejects.toThrow(/perGroup needs the columns/);
    });
  },
);
