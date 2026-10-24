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

// The typed placement and chart-delete commands (plan G4), the UNIT layer:
// the real bundle over the recording fake editor (the sheet engine real).
// The fake answers no frame and holds no table, so this layer asserts what
// the bundle decides and emits — the refusals before any write, the one
// write a placement or a delete is, the workbook read back — and
// ./headless/placement.headless.test.ts asserts what lands on the page.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";

import { P, unitEnv, type SheetEnv } from "./conformance/env";
import { C, openBook } from "./conformance/scenarios";
import { ENGINE_BUILT, WASM } from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("sheet placement (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

const chart = {
  op: "create",
  kind: `${P}/chart`,
  props: {
    kind: "column",
    title: "Stock",
    series: [
      {
        values: "book!B2:B4",
        categories: "book!A2:A4",
        name: "qty",
        color: "",
      },
    ],
  },
} as never;

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet placement and chart delete on the fake editor${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => env.dispose());

    const place = (args: object) =>
      env.objects.invoke(`${C}.place` as never, args as never);

    it("place — refuses what cannot be placed before any write; a range is one batch carrying the frame", async () => {
      covers("command:media.paged.sheet.command.place");
      await openBook(env);
      const m = env.mark();
      await expect(
        place({ ref: "book!A1:B3", sizing: "fixed" }),
      ).rejects.toThrow(/sizing fixed needs a box/);
      await expect(
        place({ ref: "book!A1:B3", box: { width: 100, height: 50 } }),
      ).rejects.toThrow(/a box is given with sizing "fixed"/);
      await expect(
        place({ ref: "book!A1:B3", repeatHeaderRows: -1 }),
      ).rejects.toThrow(/repeatHeaderRows must be 0 or more/);
      await expect(
        place({ source: "printArea", ref: "nosuch" }),
      ).rejects.toThrow(/no sheet named/);
      await expect(place({ source: "name", ref: "Nothing" })).rejects.toThrow(
        /no defined name or table/,
      );
      expect(env.mutationsSince(m)).toEqual([]);
      // A range: the frame and the native table go to the document as ONE
      // batch, applied. The fake answers no created frame, so the command
      // then says it could not name what it placed (the real engine does:
      // the headless layer).
      await expect(place({ ref: "book!A1:B3" })).rejects.toThrow(
        /could not place book!A1:B3/,
      );
      await env.settle();
      const emitted = env.mutationsSince(m);
      expect(emitted.filter((e) => e.op === "batch")).toHaveLength(1);
      expect(emitted.every((e) => e.applied)).toBe(true);
    });

    it("deleteChart — the chart leaves the workbook in one write; the others keep their index; a missing chart is refused", async () => {
      covers("command:media.paged.sheet.command.deleteChart");
      await openBook(env);
      await env.objects.batch([chart, chart]);
      await env.settle();
      expect(await env.objects.query(`${P}/chart` as never)).toEqual([
        `${P}/chart/0`,
        `${P}/chart/1`,
      ]);
      const m = env.mark();
      // Nothing of it is placed on the fake's page: no copies removed.
      expect(
        await env.objects.invoke(`${C}.deleteChart` as never, { chart: 0 }),
      ).toBe(0);
      await env.settle();
      expect(await env.objects.query(`${P}/chart` as never)).toEqual([
        `${P}/chart/1`,
      ]);
      // ONE document write: the workbook version label.
      const emitted = env.mutationsSince(m);
      expect(
        emitted.filter((e) => e.op === "setDocumentMetadata"),
      ).toHaveLength(1);
      expect(emitted.every((e) => e.applied)).toBe(true);
      // The deleted index is gone.
      const before = env.mark();
      await expect(
        env.objects.invoke(`${C}.deleteChart` as never, { chart: 0 }),
      ).rejects.toThrow();
      expect(env.mutationsSince(before)).toEqual([]);
    });
  },
);
