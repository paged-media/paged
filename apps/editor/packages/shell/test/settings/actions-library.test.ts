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

// Setting `paged.actions.v1` (actions/store.ts + model.ts): the recorded
// actions library, app-scoped in localStorage (schema 1). What a reader
// from another build left there is validated, never repaired: another
// schema version loads as empty, an action that does not validate is
// dropped, and blocked storage degrades to an in-memory session.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import {
  ACTIONS_SCHEMA_VERSION,
  EMPTY_LIBRARY,
  type PagedAction,
} from "../../src/actions/model";
import {
  ACTIONS_STORAGE_KEY,
  loadLibrary,
  parseImport,
  saveLibrary,
  serializeForExport,
} from "../../src/actions/store";
import { memoryStorage, type MemoryStorage } from "./memory-storage";

let ls: MemoryStorage;

const action = (over: Partial<PagedAction> = {}): PagedAction => ({
  id: "act_1",
  name: "Tidy",
  createdAt: 1_700_000_000_000,
  steps: [
    { command: "paged.object.group", title: "Group", verdict: "contextual" },
    {
      command: "paged.align.objects",
      title: "Align objects",
      verdict: "documentBound",
      payload: { kind: "left", targets: ["u1"] },
    },
  ],
  uncaptured: { gestures: 1, directEdits: 0 },
  includeDocumentBound: false,
  ...over,
});

beforeEach(() => {
  ls = memoryStorage();
  stubGlobal("window", { localStorage: ls });
});
afterEach(() => unstubAllGlobals());

describe("setting paged.actions.v1", () => {
  test("the key and the schema version", () => {
    covers("setting:paged.actions.v1");
    expect(ACTIONS_STORAGE_KEY).toBe("paged.actions.v1");
    expect(ACTIONS_SCHEMA_VERSION).toBe(1);
  });

  test("default: nothing stored → the empty library", () => {
    covers("setting:paged.actions.v1");
    expect(loadLibrary()).toEqual({ schema: 1, actions: [] });
    expect(loadLibrary()).toEqual(EMPTY_LIBRARY);
  });

  test("a saved library loads back intact (a reload)", () => {
    covers("setting:paged.actions.v1");
    const library = {
      schema: 1,
      actions: [action(), action({ id: "act_2", name: "Two" })],
    };
    expect(saveLibrary(library)).toBe(true);
    expect(JSON.parse(ls.getItem(ACTIONS_STORAGE_KEY)!)).toEqual(library);
    expect(loadLibrary()).toEqual(library);
  });

  test("another schema version is dropped, not repaired", () => {
    covers("setting:paged.actions.v1");
    for (const schema of [0, 2, "1", undefined]) {
      ls.setItem(
        ACTIONS_STORAGE_KEY,
        JSON.stringify({ schema, actions: [action()] }),
      );
      expect({ schema, lib: loadLibrary() }).toEqual({
        schema,
        lib: EMPTY_LIBRARY,
      });
    }
  });

  test("an invalid action is filtered out, the valid ones stay", () => {
    covers("setting:paged.actions.v1");
    const bad = [
      { ...action({ id: "x1" }), name: 3 },
      { ...action({ id: "x2" }), steps: "group" },
      {
        ...action({ id: "x3" }),
        uncaptured: { gestures: "1", directEdits: 0 },
      },
      { ...action({ id: "x4" }), includeDocumentBound: "yes" },
      action({
        id: "x5",
        steps: [{ command: "c", title: "t", verdict: "maybe" as never }],
      }),
      null,
    ];
    ls.setItem(
      ACTIONS_STORAGE_KEY,
      JSON.stringify({ schema: 1, actions: [action({ id: "ok" }), ...bad] }),
    );
    expect(loadLibrary().actions.map((a) => a.id)).toEqual(["ok"]);
  });

  test("unreadable values load as the empty library", () => {
    covers("setting:paged.actions.v1");
    for (const raw of ["{nope", "null", "[]", "42", '{"schema":1}']) {
      ls.setItem(ACTIONS_STORAGE_KEY, raw);
      expect({ raw, lib: loadLibrary() }).toEqual({ raw, lib: EMPTY_LIBRARY });
    }
  });

  test("blocked storage: load is empty, save reports the refusal", () => {
    covers("setting:paged.actions.v1");
    stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(loadLibrary()).toEqual(EMPTY_LIBRARY);
    expect(saveLibrary({ schema: 1, actions: [action()] })).toBe(false);
  });

  test("a refused write (quota) reports false so the panel can say so", () => {
    covers("setting:paged.actions.v1");
    ls.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(saveLibrary({ schema: 1, actions: [action()] })).toBe(false);
  });

  test("export and import share the stored schema", () => {
    covers("setting:paged.actions.v1");
    const body = serializeForExport([action()]);
    expect(JSON.parse(body)).toEqual({ schema: 1, actions: [action()] });
    expect(parseImport(body)).toEqual([action()]);
    expect(parseImport("not json")).toEqual([]);
  });
});
