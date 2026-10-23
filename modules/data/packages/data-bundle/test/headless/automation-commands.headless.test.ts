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

// The automation commands (plan G4) on the real bundle, the real data
// engine, DuckDB and the real canvas engine, the path the Node CLI takes:
// a file's bytes become a source (importSource), a query object selects
// the records, a visibility binding is defined (defineBinding) and applied
// for one record, and the batch plan splits the records by a field.

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

import { headlessEnv, readiness, type DataEnv } from "../conformance/env";
import { CSV, D } from "../conformance/scenarios";

type Env = DataEnv & { h: HeadlessHost };
const gate = readiness(true);

const invoke = (env: Env, id: string, args: unknown) =>
  env.objects.invoke(`${D}.${id}` as never, args);

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data automation commands on the real engines${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: Env;
    beforeEach(async () => {
      env = (await headlessEnv()) as Env;
    });
    afterEach(() => env.dispose());

    it("importSource → a query → defineBinding → apply: record 2 hides the rectangle; planBatch groups by a field", async () => {
      covers(
        "command:media.paged.data.importSource",
        "command:media.paged.data.defineBinding",
        "command:media.paged.data.planBatch",
      );
      expect(
        await invoke(env, "importSource", {
          bytes: new TextEncoder().encode(CSV),
          fileName: "products.csv",
        }),
      ).toEqual({ source: "products", format: "csv" });
      const q = await env.objects.batch([
        {
          op: "create",
          kind: `plugin:${D}/query`,
          handle: "q",
          props: { sql: "SELECT * FROM products ORDER BY sku" },
        },
      ]);
      expect(q.applied, q.reason).toBe(true);
      await invoke(env, "defineBinding", {
        id: "badge",
        kind: "visibility",
        query: "q",
        target: "urect",
        expr: "shown",
        options: { kind: "rectangle" },
      });
      await invoke(env, "apply", { record: 1 });
      await env.settle();
      const visible = await env.objects.get(
        "rectangle:urect" as never,
        "elementVisible",
      );
      expect(visible).toEqual({ kind: "value", value: false });

      const plan = (await invoke(env, "planBatch", {
        query: "q",
        mode: "perGroup",
        by: ["shown"],
      })) as { totalRecords: number; units: { records: number[] }[] };
      expect(plan.totalRecords).toBe(3);
      expect(plan.units.map((u) => u.records)).toEqual([[0, 2], [1]]);
    });
  },
);
