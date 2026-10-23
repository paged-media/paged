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

// paged.data's inspection commands (plan G4), the UNIT layer: the real
// bundle on the SDK's in-process host over the recording fake editor, with
// the real data-js engine and a real DuckDB. Each reads, or changes the
// session's variable set; none writes to the document.

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
import { D, seed } from "./conformance/scenarios";

const gate = readiness(false);

const invoke = (env: DataEnv, id: string, args: unknown) =>
  env.objects.invoke(`${D}.${id}` as never, args);

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data inspection commands on the fake editor${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: DataEnv;
    beforeEach(async () => {
      env = await unitEnv();
      await seed(env);
    });
    afterEach(() => env.dispose());

    it("previewQuery — the first rows as DuckDB renders them; a guarded statement says why", async () => {
      covers("command:media.paged.data.previewQuery");
      const m = env.mark();
      expect(
        await invoke(env, "previewQuery", {
          sql: "SELECT name FROM products ORDER BY sku",
          limit: 1,
        }),
      ).toEqual({ columns: ["name"], rows: [["Alpha"]], total: 3 });
      const bad = (await invoke(env, "previewQuery", {
        sql: "DROP TABLE products",
      })) as { rows: unknown[]; problem?: string };
      expect(bad.rows).toEqual([]);
      expect(bad.problem).toBeTruthy();
      expect(env.writesSince(m)).toEqual([]);
    });

    it("checkExpression — parse errors and fields the query lacks", async () => {
      covers("command:media.paged.data.checkExpression");
      expect(
        await invoke(env, "checkExpression", {
          expr: "name & sku",
          query: "q",
        }),
      ).toEqual({ ok: true, fields: ["name", "sku"], unknownFields: [] });
      const broken = (await invoke(env, "checkExpression", {
        expr: "UPPER(",
      })) as { ok: boolean; error?: string };
      expect(broken.ok).toBe(false);
      expect(broken.error).toBeTruthy();
    });

    it("refreshDiff — every binding against the last report", async () => {
      covers("command:media.paged.data.refreshDiff");
      env.session.addVisibilityBinding("badge", "urect", "q", "shown");
      const first = (await invoke(env, "refreshDiff", {})) as {
        binding: string;
        change: string;
      }[];
      expect(first.map((e) => [e.binding, e.change])).toEqual([
        ["badge", "added"],
      ]);
      const again = (await invoke(env, "refreshDiff", {})) as {
        change: string;
      }[];
      expect(again.map((e) => e.change)).toEqual(["unchanged"]);
    });

    it("previewRecordFlow — a record flow's blocks; anything else is refused", async () => {
      covers("command:media.paged.data.previewRecordFlow");
      env.session.defineRecordFlow("rf", "q", [{ expr: "name" }]);
      await env.session.refreshData();
      expect(await invoke(env, "previewRecordFlow", { binding: "rf" })).toEqual(
        { total: 3, blocks: ["Alpha", "Beta", "Gamma"] },
      );
      await expect(
        invoke(env, "previewRecordFlow", { binding: "nope" }),
      ).rejects.toThrow(/no record flow/);
    });

    it("captureEveryRecord / exportVariableLibrary / importVariableLibrary — the variable set round-trips", async () => {
      covers(
        "command:media.paged.data.captureEveryRecord",
        "command:media.paged.data.exportVariableLibrary",
        "command:media.paged.data.importVariableLibrary",
      );
      env.session.addVisibilityBinding("badge", "urect", "q", "shown");
      const m = env.mark();
      expect(
        await invoke(env, "captureEveryRecord", {
          query: "q",
          prefix: "P-",
        }),
      ).toHaveLength(3);
      const xml = (await invoke(env, "exportVariableLibrary", {})) as string;
      expect(xml).toContain("badge");
      for (const n of await env.session.listDataSets())
        await env.session.deleteDataSet(n);
      const report = (await invoke(env, "importVariableLibrary", { xml })) as {
        variables: number;
        dataSets: number;
      };
      expect(report.dataSets).toBe(3);
      expect(await env.session.listDataSets()).toHaveLength(3);
      expect(env.writesSince(m)).toEqual([]);
    });
  },
);
