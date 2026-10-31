/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// [scripting.data] `paged.data.*` in the editor's worker (engine ADR 1014,
// amendment 2): a real Worker blocks on `Atomics.wait` over a real
// SharedArrayBuffer while this thread's data service answers. Covered: an
// answer, one larger than the buffer (chunked), a refusal, a timeout whose
// late answer never reaches the next call, and the main thread's mapping
// of each call onto the data service.

import { describe, expect, test } from "bun:test";

import {
  allocateDataBridge,
  DataBridgeHost,
  type DataCallAnswerer,
} from "@paged-media/client";
import type { DataService } from "@paged-media/plugin-api";

import { answerScriptData, NO_DATA_SERVICE } from "../../../src/script-data";

/** Run `calls` in a worker against `answer`; resolves to each call's
 *  answer JSON, parsed. */
async function run(
  answer: DataCallAnswerer,
  calls: [string, unknown[]][],
  options: { capacity?: number; timeoutMs?: number } = {},
): Promise<unknown[]> {
  const buffer = allocateDataBridge(options.capacity);
  const host = new DataBridgeHost(buffer, answer);
  const worker = new Worker(
    new URL("./data-bridge.worker.ts", import.meta.url),
  );
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      worker.addEventListener("error", (e) => reject(e));
      worker.addEventListener("message", (event: MessageEvent) => {
        if (host.handle(event.data)) return;
        const data = event.data as { kind: string; results: string[] };
        if (data.kind === "results")
          resolve(data.results.map((r) => JSON.parse(r) as unknown));
      });
      worker.postMessage({
        buffer,
        calls: calls.map(([m, a]) => [m, JSON.stringify(a)]),
        timeoutMs: options.timeoutMs,
      });
    });
  } finally {
    worker.terminate();
  }
}

describe("[scripting.data] the blocking data bridge", () => {
  test("a call reaches the answerer with its arguments and returns its value", async () => {
    const seen: [string, unknown[]][] = [];
    const results = await run(
      async (method, args) => {
        seen.push([method, args]);
        await Bun.sleep(5);
        return method === "tables" ? [{ name: "people" }] : { rowCount: 0 };
      },
      [
        ["tables", []],
        ["records", ["people", { offset: 1, limit: 2 }]],
      ],
    );
    expect(results).toEqual([
      { ok: [{ name: "people" }] },
      { ok: { rowCount: 0 } },
    ]);
    expect(seen).toEqual([
      ["tables", []],
      ["records", ["people", { offset: 1, limit: 2 }]],
    ]);
  });

  test("an answer larger than the buffer arrives whole, in chunks", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `row ${i} ünïcødé`);
    const results = await run(async () => rows, [["query", ["SELECT *"]]], {
      capacity: 64,
    });
    expect(results).toEqual([{ ok: rows }]);
  });

  test("a refusal of the service is the call's error", async () => {
    const results = await run(
      () => Promise.reject(new Error("only one SELECT is allowed")),
      [["query", ["DROP TABLE people"]]],
    );
    expect(results).toEqual([{ error: "only one SELECT is allowed" }]);
  });

  test("no answer in time is an error, and the late answer is dropped", async () => {
    let calls = 0;
    const results = await run(
      async () => {
        calls++;
        if (calls === 1) {
          await Bun.sleep(400);
          return "late";
        }
        return "fresh";
      },
      [
        ["tables", []],
        ["tables", []],
      ],
      { timeoutMs: 150 },
    );
    expect(results[0]).toEqual({
      error: "no answer from the editor's data service within 150 ms",
    });
    expect(results[1]).toEqual({ ok: "fresh" });
  });
});

describe("[scripting.data] the main thread's answer", () => {
  const recorded: unknown[][] = [];
  const service = {
    tables: () => [{ name: "people" }],
    records: async (table: string, range: unknown) => {
      recorded.push(["records", table, range]);
      return { rowCount: 1 };
    },
    query: async (sql: string) => {
      recorded.push(["query", sql]);
      return { rowCount: 2 };
    },
    evaluate: async (query: string, expr: string, record: number) => {
      recorded.push(["evaluate", query, expr, record]);
      return { display: "A", value: "A" };
    },
  } as unknown as DataService;

  test("each call maps onto the data service", async () => {
    expect(await answerScriptData(service, "tables", [])).toEqual([
      { name: "people" },
    ]);
    await answerScriptData(service, "records", ["people", { offset: 3 }]);
    await answerScriptData(service, "query", ["SELECT 1"]);
    await answerScriptData(service, "evaluate", ["q", "upper(name)", 4]);
    expect(recorded).toEqual([
      ["records", "people", { offset: 3 }],
      ["query", "SELECT 1"],
      ["evaluate", "q", "upper(name)", 4],
    ]);
  });

  test("no service is the interpreter's refusal", async () => {
    await expect(answerScriptData(null, "tables", [])).rejects.toThrow(
      NO_DATA_SERVICE,
    );
  });
});
