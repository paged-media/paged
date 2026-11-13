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

// Setting `paged.cockpit.docks.v1` (cockpit-persistence.ts; editor ADR
// "Docks are resizable and the workspace adapts"): per workflow mode, the
// widths the docks were dragged to and whether the left dock is pinned
// open on a laptop-width workspace. Written 300 ms after the last change,
// scoped per workspace like the tabs' blob.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import {
  loadDockStore,
  saveModeDockState,
} from "../../src/cockpit/cockpit-persistence";
import { setChromeStorageScope } from "../../src/state/chrome-storage-scope";
import { createEditorScope } from "../../src/state/editor-scope";
import { setEditorStorage } from "../../src/state/storage";
import { memoryStorage, type MemoryStorage } from "./memory-storage";

const KEY = "paged.cockpit.docks.v1";
const DEBOUNCE_MS = 300;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ls: MemoryStorage;
let scope = createEditorScope();

beforeEach(() => {
  ls = memoryStorage();
  scope = createEditorScope();
  stubGlobal("window", {
    get localStorage() {
      return ls;
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  setEditorStorage(scope, ls);
});
afterEach(async () => {
  await wait(DEBOUNCE_MS + 20);
  unstubAllGlobals();
});

describe("setting paged.cockpit.docks.v1", () => {
  test("default: nothing stored → every dock at its default width", () => {
    covers("setting:paged.cockpit.docks.v1");
    expect(loadDockStore(scope)).toEqual({});
  });

  test("a mode's widths persist after the debounce and load back", async () => {
    covers("setting:paged.cockpit.docks.v1");
    const store = saveModeDockState(scope, {}, "design", {
      right: 400,
      left: 300,
    });
    saveModeDockState(scope, store, "prepress", { leftPinned: true });
    expect(ls.getItem(KEY)).toBeNull();
    await wait(DEBOUNCE_MS + 30);
    expect(loadDockStore(scope)).toEqual({
      design: { right: 400, left: 300 },
      prepress: { leftPinned: true },
    });
  });

  test("a field of the wrong type is dropped, the rest kept", () => {
    covers("setting:paged.cockpit.docks.v1");
    ls.setItem(
      KEY,
      JSON.stringify({
        design: { right: "wide", left: 280, leftPinned: "yes" },
        export: 7,
      }),
    );
    expect(loadDockStore(scope)).toEqual({ design: { left: 280 } });
    ls.setItem(KEY, "{not json");
    expect(loadDockStore(scope)).toEqual({});
  });

  test("solo keeps its own blob (the workspace scope)", async () => {
    covers("setting:paged.cockpit.docks.v1");
    setChromeStorageScope(scope, ".solo.paged.draw");
    saveModeDockState(scope, {}, "design", { right: 260 });
    await wait(DEBOUNCE_MS + 30);
    expect(ls.getItem(KEY)).toBeNull();
    expect(JSON.parse(ls.getItem(`${KEY}.solo.paged.draw`)!)).toEqual({
      design: { right: 260 },
    });
  });

  test("blocked storage degrades to the defaults without throwing", () => {
    covers("setting:paged.cockpit.docks.v1");
    setEditorStorage(scope, {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {},
    });
    expect(loadDockStore(scope)).toEqual({});
    expect(() =>
      saveModeDockState(scope, {}, "design", { right: 300 }),
    ).not.toThrow();
  });
});
