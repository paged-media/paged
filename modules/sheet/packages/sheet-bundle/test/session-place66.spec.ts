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

// The ONE-CALL placement (protocol 66: core resolves a table handle in a
// `tableId` / `table_id` position, 0eff96b): the frame, its binding, the
// table, the pour, the decor and the text styles are one `mutate`, over the
// REAL headless core. When the engine refuses that batch
// (`refusingTableHandles`), the placement falls back to the two-batch path.
//
// Real engine: skipped without the wasm artifact, FAILS under
// REQUIRE_REAL_ENGINE=1 (the engine-real.spec.ts dual gate).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { parseBinding } from "@paged-media/sheet-host-model";

import { createWorkbookSession, type WorkbookSession } from "../src";
import { countingHost, Tally } from "./perf/counting-host";
import {
  ENGINE_BUILT,
  WASM,
  authorWorkbook,
  blankPageIdml,
  exportedTableCells,
  openHost,
  refusingTableHandles,
  settle,
  sheetHost,
  withSceneChannel,
} from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("one-call placement (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

/** Every text frame in the scene tree. */
async function textFrames(host: BundleHost): Promise<string[]> {
  const out: string[] = [];
  const walk = (
    ns: readonly {
      id?: { kind: string; id: unknown } | null;
      children?: unknown[];
    }[],
  ) => {
    for (const n of ns) {
      if (n.id?.kind === "textFrame") out.push(n.id.id as string);
      if (n.children) walk(n.children as never);
    }
  };
  walk((await host.document.tree()) as never);
  return out;
}

describe.skipIf(!ENGINE_BUILT)("one-call placement [sheet.lower.page]", () => {
  setDefaultTimeout(60_000);
  let h: HeadlessHost;
  let raw: BundleHost;
  const sessions: WorkbookSession[] = [];

  beforeEach(async () => {
    h = await openHost();
    await h.load(blankPageIdml());
    raw = withSceneChannel(sheetHost(h)).host;
  });
  afterEach(() => {
    for (const x of sessions.splice(0)) x.dispose();
    h?.dispose();
  });

  async function placeOn(
    host: BundleHost,
    label = (r: number, c: number) => `${r}${c}`,
  ) {
    const s = createWorkbookSession(host);
    sessions.push(s);
    await s.import(await authorWorkbook(3, 2, label), "p.xlsx");
    s.setRange("A1:B3");
    return s;
  }

  it("the host places frame, table and content in ONE mutate", async () => {
    const tally = new Tally();
    const { host } = countingHost(raw, tally);
    const s = await placeOn(host);
    tally.work.reset();
    const frame = await s.lowerSelection();
    await settle();
    expect(frame).not.toBeNull();

    expect(tally.work.count("document.mutate")).toBe(1);
    expect(tally.work.rejected).toBe(0);
    const [m] = tally.work.mutations;
    expect(m.kinds.insertTextFrame).toBe(1);
    expect(m.kinds.insertTable).toBe(1);
    expect(m.kinds.bindCreated).toBe(2);
    expect(m.kinds.insertText).toBe(6);
    // No read-back of the frame or its story: `minted` names both.
    expect(tally.work.count("document.frameChain")).toBe(0);

    const tables = await exportedTableCells(h);
    expect(tables).toHaveLength(1);
    expect(tables[0].get("1:1")).toBe("11");
    expect(tables[0].get("2:1")).toBe("21");
    // The binding rode the batch: the table record without ids (they did
    // not exist when it was written).
    const b = parseBinding(
      await raw.document.getMetadata({
        kind: "textFrame",
        id: frame!,
      } as never),
    );
    expect(b?.data.table).toBeDefined();
    expect(b?.data.table?.tableId).toBeUndefined();

    // This session knows the ids from `minted`: an edit refreshes in place.
    s.editCell(0, 2, 1, "edited");
    await s.refreshPlacements();
    await settle();
    const after = await exportedTableCells(h);
    expect(after).toHaveLength(1);
    expect(after[0].get("2:1")).toBe("edited");
    // ...and the refresh re-stamped the record with its ids.
    const b2 = parseBinding(
      await raw.document.getMetadata({
        kind: "textFrame",
        id: frame!,
      } as never),
    );
    expect(b2?.data.table?.tableId).toBeTruthy();
  });

  it("a later session finds a one-call table by reading the page [sheet.plugin.persistence]", async () => {
    const a = await placeOn(raw);
    const frame = await a.lowerSelection();
    await settle();
    await a.flushPersist();
    a.dispose();
    expect(
      parseBinding(
        await raw.document.getMetadata({
          kind: "textFrame",
          id: frame!,
        } as never),
      )?.data.table?.tableId,
    ).toBeUndefined();

    const b = createWorkbookSession(raw);
    sessions.push(b);
    expect(await b.restore()).toBe(true);
    b.editCell(0, 2, 1, "later");
    await b.refreshPlacements();
    await settle();
    const tables = await exportedTableCells(h);
    expect(tables).toHaveLength(1);
    expect(tables[0].get("2:1")).toBe("later");
    expect(tables[0].get("1:1")).toBe("11");
    // Found (its hash matched) and refreshed IN PLACE: the same frame, not
    // a re-placement.
    expect(await textFrames(raw)).toEqual([frame]);
    // ...and the refresh re-stamped the record with the ids it read.
    expect(
      parseBinding(
        await raw.document.getMetadata({
          kind: "textFrame",
          id: frame!,
        } as never),
      )?.data.table?.tableId,
    ).toBeTruthy();
  });

  it("a refused one-call batch: rolled back, then the two-batch placement", async () => {
    // The engine under test resolves the table handle; the wrapper refuses
    // the one-call batch, and the placement must still land exactly once.
    const tally = new Tally();
    const { host } = countingHost(refusingTableHandles(raw), tally);
    const s = await placeOn(host);
    const tablesBefore = (await exportedTableCells(h)).length;
    const treeBefore = JSON.stringify(await raw.document.tree());
    const framesBefore = await textFrames(raw);
    tally.work.reset();

    const frame = await s.lowerSelection();
    await settle();
    expect(frame).not.toBeNull();
    // 1 refused one-call batch, then the two-batch placement.
    expect(tally.work.count("document.mutate")).toBe(3);
    expect(tally.work.rejected).toBe(1);
    // Exactly one new frame and one table, holding the range.
    expect(await textFrames(raw)).toEqual([...framesBefore, frame]);
    const tables = await exportedTableCells(h);
    expect(tables).toHaveLength(tablesBefore + 1);
    expect(tables[tablesBefore].get("2:1")).toBe("21");
    // Two undo steps (the two batches) and the page is as it was: the
    // refused attempt left no step behind.
    await raw.document.undo();
    await raw.document.undo();
    await settle();
    expect(JSON.stringify(await raw.document.tree())).toBe(treeBefore);
    expect(await exportedTableCells(h)).toHaveLength(tablesBefore);

    // A refusal is about that batch, not the host: the next placement
    // tries the one call again.
    tally.work.reset();
    s.setRange("A1:A2");
    expect(await s.lowerSelection()).not.toBeNull();
    await settle();
    expect(tally.work.count("document.mutate")).toBe(3);
    expect(tally.work.rejected).toBe(1);
  });
});
