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

// paged.data's commands, the HEADLESS layer: the real bundle on the
// plugin-sdk harness over the REAL canvas engine (the minimal document: page
// "usp", rectangle "urect"), with the real data-js engine and a real
// DuckDB. The same scenarios as the unit layer (../commands.spec.ts); here
// they also assert what LANDED — the bound rectangle's properties, the
// merged pages, the exported template — and that undo takes it back.
//
// Without the engines the suite is skipped and names what is missing; the
// CI lane (REQUIRE_REAL_DUCKDB / _ENGINE / _CORE) makes that a failure.

import {
  afterEach,
  beforeEach,
  describe,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";

import { headlessEnv, readiness, type DataEnv } from "../conformance/env";
import * as S from "../conformance/scenarios";

const gate = readiness(true);

if (gate.required && !gate.ready) {
  describe("data commands (engines) — REQUIRED", () => {
    it("FAILS: a REQUIRE_REAL_* lane but an engine is missing", () => {
      throw new Error(`missing: ${gate.missing}`);
    });
  });
}

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data commands on the real engine${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: DataEnv;
    beforeEach(async () => {
      env = await headlessEnv();
    });
    afterEach(() => env.dispose());

    it("command.importData — opens Data sources and writes nothing", async () => {
      covers("command:media.paged.data.command.importData");
      await S.opensPanel(env, `${S.D}.command.importData`, S.PANEL.sources);
    });

    it("command.defineBinding — opens Bindings and writes nothing", async () => {
      covers("command:media.paged.data.command.defineBinding");
      await S.opensPanel(env, `${S.D}.command.defineBinding`, S.PANEL.bindings);
    });

    it("command.openDataset — opens Dataset preview and writes nothing", async () => {
      covers("command:media.paged.data.command.openDataset");
      await S.opensPanel(env, `${S.D}.command.openDataset`, S.PANEL.dataset);
    });

    it("command.editQuery — opens Data query and writes nothing", async () => {
      covers("command:media.paged.data.command.editQuery");
      await S.opensPanel(env, `${S.D}.command.editQuery`, S.PANEL.query);
    });

    it("command.resolveBindings — reads every source again; writes nothing to the document", async () => {
      covers("command:media.paged.data.command.resolveBindings");
      await S.resolveBindings(env);
    });

    it("command.lowerBinding — places the bindings: one write, the first record's value, undone in one step", async () => {
      covers("command:media.paged.data.command.lowerBinding");
      await S.lowerBinding(env);
    });

    it("command.mergeRecords — without a query opens Bindings; with a template merges every record as one write", async () => {
      covers("command:media.paged.data.command.mergeRecords");
      await S.mergeRecords(env);
    });

    it("command.captureDataSet — captures the bound values as named sets; writes nothing", async () => {
      covers("command:media.paged.data.command.captureDataSet");
      await S.captureDataSetCommand(env);
    });

    it("command.applyDataSet — without a name opens Dataset preview; with one applies the set in one write", async () => {
      covers("command:media.paged.data.command.applyDataSet");
      await S.applyDataSetCommand(env);
    });

    it("bindProperty — without a target opens Bindings; with one drafts the binding, palette and typed", async () => {
      covers("command:media.paged.data.bindProperty");
      await S.bindPropertyCommand(env);
    });

    it("defineProperty — binds a frame property through a durable selector, one label write; refuses a bad target or path", async () => {
      covers("command:media.paged.data.defineProperty");
      await S.defineProperty(env);
    });

    it("propertyBindings — lists the bindings on an object and path", async () => {
      covers("command:media.paged.data.propertyBindings");
      await S.propertyBindings(env);
    });

    it("refresh — reads the sources again and reports it", async () => {
      covers("command:media.paged.data.refresh");
      await S.refresh(env);
    });

    it("apply — applies every binding at a record; one undo per apply", async () => {
      covers("command:media.paged.data.apply");
      await S.apply(env);
    });

    it("defineSource — registers CSV sources a query reads", async () => {
      covers("command:media.paged.data.defineSource");
      await S.defineSource(env);
    });

    it("captureDataSet — captures a record's values as a set", async () => {
      covers("command:media.paged.data.captureDataSet");
      await S.captureDataSet(env);
    });

    it("applyDataSet — switches between sets; an unknown set applies nothing", async () => {
      covers("command:media.paged.data.applyDataSet");
      await S.applyDataSet(env);
    });

    it("exportDataMergeTemplate — writes the document as an InDesign Data Merge template with its CSV", async () => {
      covers("command:media.paged.data.exportDataMergeTemplate");
      await S.exportDataMergeTemplate(env);
    });

    it("merge — merges every record onto pages after the template; one undo", async () => {
      covers("command:media.paged.data.merge");
      await S.merge(env);
    });

    // Findings: the behaviour the command should have, failing until the
    // product does it.
    it.failing(
      "DAT-1 — propertyBindings (typed) lists an object's bindings without a path filter",
      async () => {
        // Today the declared args make `path` (and `address`) required, so
        // `{ address }` is refused ("invalidValue: args.path is missing"),
        // although the session filters by either and both are optional there.
        await S.propertyBindingsByAddress(env);
      },
    );

    it.failing(
      "DAT-2 — applyDataSet over a property and a visibility binding is ONE undo step",
      async () => {
        // Today the set is written twice — the visibility through
        // document.mutate, the property through objects.batch — so one undo
        // takes back the property only and the frame stays hidden; the log
        // says "in one undo step".
        await S.applyDataSetIsOneUndoStep(env);
      },
    );
  },
);
