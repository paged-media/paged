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

// paged.sheet's commands, the UNIT layer: the real bundle on the SDK's
// in-process host over the gesture kit's recording fake editor (no canvas
// engine; the sheet engine is real). One test per command id; the scenario
// is shared with the headless layer (./headless/commands.headless.test.ts)
// and lives in ./conformance/scenarios.ts, which says what each asserts.
//
// The sheet engine is a build artifact: without it the suite is skipped and
// says why; REQUIRE_REAL_ENGINE=1 (the CI lane) turns that into a failure.

import {
  afterEach,
  beforeEach,
  describe,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";

import { unitEnv, type SheetEnv } from "./conformance/env";
import * as S from "./conformance/scenarios";
import { ENGINE_BUILT, WASM } from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("sheet commands (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet commands on the fake editor${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => env.dispose());

    it("importXlsx — the picked workbook opens and the panel shows it; the typed command loads bytes and refuses a non-workbook", async () => {
      covers("command:media.paged.sheet.command.importXlsx");
      await S.importXlsx(env);
    });

    it("lowerToFrame — places the range as a native table; nothing to place without a workbook", async () => {
      covers("command:media.paged.sheet.command.lowerToFrame");
      await S.lowerToFrame(env);
    });

    it("lowerChartToFrame — a chartless workbook says so; a chart places", async () => {
      covers("command:media.paged.sheet.command.lowerChartToFrame");
      await S.lowerChartToFrame(env);
    });

    it("openGrid — opens the grid panel and touches no document", async () => {
      covers("command:media.paged.sheet.command.openGrid");
      await S.openGrid(env);
    });

    it("showGridInFrame — submits the live grid to the placed frame; names what is missing first", async () => {
      covers("command:media.paged.sheet.command.showGridInFrame");
      await S.showGridInFrame(env);
    });

    it("hideGridInFrame — clears the in-frame grid layer", async () => {
      covers("command:media.paged.sheet.command.hideGridInFrame");
      await S.hideGridInFrame(env);
    });

    it("sortRange — the palette opens the sort options; the typed sort reorders rows, one undo step", async () => {
      covers("command:media.paged.sheet.command.sortRange");
      await S.sortRange(env);
    });

    it("findReplace — the palette opens find; the typed replace counts, honours match case, one undo step", async () => {
      covers("command:media.paged.sheet.command.findReplace");
      await S.findReplace(env);
    });

    it("sheetFromDataset — the palette opens datasets; the typed command seeds a sheet from a published dataset", async () => {
      covers("command:media.paged.sheet.command.sheetFromDataset");
      await S.sheetFromDataset(env);
    });

    it("copySelection — gated on a workbook; copies the selected range as rows and TSV", async () => {
      covers("command:media.paged.sheet.command.copySelection");
      await S.copySelection(env);
    });

    it("pasteSelection — gated on a workbook; pastes at the selection, one journal step", async () => {
      covers("command:media.paged.sheet.command.pasteSelection");
      await S.pasteSelection(env);
    });

    it("styleFromCell — needs a placed cell; mints a cell style from it", async () => {
      covers("command:media.paged.sheet.command.styleFromCell");
      await S.styleFromCell(env);
    });

    it("paginateToChain — gated on a workbook; needs a chain frame; splits the range over the chain", async () => {
      covers("command:media.paged.sheet.command.paginateToChain");
      await S.paginateToChain(env);
    });

    it("newWorkbook — a blank Sheet1 opens in the workbook panel", async () => {
      covers("command:media.paged.sheet.command.newWorkbook");
      await S.newWorkbook(env);
    });

    it("insertRows — gated; refuses without a selection; inserts at the selection and by the typed command", async () => {
      covers("command:media.paged.sheet.command.insertRows");
      await S.structural(env, "insertRows");
    });

    it("deleteRows — gated; refuses without a selection; deletes at the selection and by the typed command", async () => {
      covers("command:media.paged.sheet.command.deleteRows");
      await S.structural(env, "deleteRows");
    });

    it("insertColumns — gated; refuses without a selection; inserts at the selection and by the typed command", async () => {
      covers("command:media.paged.sheet.command.insertColumns");
      await S.structural(env, "insertColumns");
    });

    it("deleteColumns — gated; refuses without a selection; deletes at the selection and by the typed command", async () => {
      covers("command:media.paged.sheet.command.deleteColumns");
      await S.structural(env, "deleteColumns");
    });

    it("addSheet — gated; adds a sheet from the palette and a named one by the typed command", async () => {
      covers("command:media.paged.sheet.command.addSheet");
      await S.addSheet(env);
    });

    it("fillDown — gated; fills the selection down, the journal takes it back; typed on a range", async () => {
      covers("command:media.paged.sheet.command.fillDown");
      await S.fill(env, "fillDown");
    });

    it("fillRight — gated; fills the selection right, the journal takes it back; typed on a range", async () => {
      covers("command:media.paged.sheet.command.fillRight");
      await S.fill(env, "fillRight");
    });

    it("clearCells — gated; clears the selection, the journal takes it back; typed on a range", async () => {
      covers("command:media.paged.sheet.command.clearCells");
      await S.clearCells(env);
    });

    it("findInSheet — gated; the palette opens find; the typed find lists matching cells", async () => {
      covers("command:media.paged.sheet.command.findInSheet");
      await S.findInSheet(env);
    });

    it("findNext — gated; with no search yet there is nothing to repeat", async () => {
      covers("command:media.paged.sheet.command.findNext");
      await S.findNext(env);
    });

    it("publishDataset — publishes a range as a dataset with its header as the schema; refuses a bad name", async () => {
      covers("command:media.paged.sheet.command.publishDataset");
      await S.publishDataset(env);
    });

    it("unpublishDataset — stops publishing; an unknown name answers false", async () => {
      covers("command:media.paged.sheet.command.unpublishDataset");
      await S.unpublishDataset(env);
    });
  },
);
