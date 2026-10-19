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

// paged.data's file importer (`media.paged.data.importer.table`, the
// editor's File ▸ Open and drag-drop for JSON and Parquet), driven through
// the contribution the real bundle registers, over the real data-js engine
// and a real DuckDB, on the recording fake editor (./conformance/env.ts).
// Fixtures are built here.

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
import { PANEL } from "./conformance/scenarios";

const gate = readiness(false);
const enc = new TextEncoder();
const IMPORTER = "media.paged.data.importer.table";

if (gate.required && !gate.ready) {
  describe("data importer (engines) — REQUIRED", () => {
    it("FAILS: a REQUIRE_REAL_* lane but an engine is missing", () => {
      throw new Error(`missing: ${gate.missing}`);
    });
  });
}

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data importer${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: DataEnv;
    beforeEach(async () => {
      env = await unitEnv();
    });
    afterEach(() => env.dispose());

    it("claims JSON and Parquet, and leaves the spreadsheet types to paged.sheet", () => {
      covers("importer:media.paged.data.importer.table");
      const imp = env.importer(IMPORTER);
      expect([...imp.extensions]).toEqual([
        ".json",
        ".ndjson",
        ".jsonl",
        ".parquet",
      ]);
      for (const contested of [".csv", ".tsv", ".xlsx"])
        expect(imp.extensions).not.toContain(contested);
    });

    it("a JSON array becomes a source named after the file, its rows queryable, and Data sources opens", async () => {
      covers("importer:media.paged.data.importer.table");
      const m = env.mark();
      await env.importer(IMPORTER).import({
        name: "stock.json",
        bytes: enc.encode(
          JSON.stringify([
            { sku: "A-1", qty: 3 },
            { sku: "B-2", qty: 5 },
          ]),
        ),
        mimeType: "application/json",
      });
      await env.settle();
      expect(env.opened).toEqual([PANEL.sources]);
      expect(env.session.getState().sources).toContain("stock");
      // Importing defines a source; it does not touch the document.
      expect(env.writesSince(m)).toEqual([]);
      env.session.addQuery(
        "q",
        "SELECT sku FROM stock WHERE qty > 4",
        "recordStream",
      );
      await env.session.refreshData();
      expect(await env.session.recordCount("q")).toBe(1);
    });

    it("newline-delimited JSON imports as rows too", async () => {
      covers("importer:media.paged.data.importer.table");
      await env.importer(IMPORTER).import({
        name: "events.ndjson",
        bytes: enc.encode('{"id":1}\n{"id":2}\n{"id":3}\n'),
        mimeType: "application/x-ndjson",
      });
      await env.settle();
      env.session.addQuery("q", "SELECT * FROM events", "recordStream");
      await env.session.refreshData();
      expect(await env.session.recordCount("q")).toBe(3);
    });

    it("bytes that are not JSON define no source and say why", async () => {
      covers("importer:media.paged.data.importer.table");
      await env.importer(IMPORTER).import({
        name: "broken.json",
        bytes: enc.encode("{ not json"),
        mimeType: "application/json",
      });
      await env.settle();
      expect(env.session.getState().sources).not.toContain("broken");
      expect(
        env.session.getState().diagnostics.some((d) => d.level === "error"),
      ).toBe(true);
    });
  },
);
