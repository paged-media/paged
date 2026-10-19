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

// Setting `paged.cockpit.v1` (cockpit-persistence.ts): per workflow mode,
// the right dock's open tabs and the active one. One localStorage blob,
// written 300 ms after the last change, scoped per workspace, and on load
// the legacy dockview layout keys (`paged.layout.*`) are deleted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import {
  loadCockpitStore,
  saveModeUiState,
} from "../../src/cockpit/cockpit-persistence";
import { setChromeStorageScope } from "../../src/state/chrome-storage-scope";
import { memoryStorage, type MemoryStorage } from "./memory-storage";

const KEY = "paged.cockpit.v1";
const DEBOUNCE_MS = 300;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ls: MemoryStorage;

/** The module reads `window.localStorage` and `window.setTimeout`; a
 *  window whose storage getter can be made to throw (blocked storage). */
function installWindow(storage: () => Storage) {
  stubGlobal("window", {
    get localStorage() {
      return storage();
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
}

beforeEach(() => {
  ls = memoryStorage();
  installWindow(() => ls);
  setChromeStorageScope("");
});
afterEach(async () => {
  // Let a debounced write from the test land before the next one starts.
  await wait(DEBOUNCE_MS + 20);
  unstubAllGlobals();
  setChromeStorageScope("");
});

describe("setting paged.cockpit.v1", () => {
  test("default: nothing stored → an empty store (each mode seeds from its slots)", () => {
    covers("setting:paged.cockpit.v1");
    expect(loadCockpitStore()).toEqual({});
  });

  test("a mode's tabs persist after the debounce and load back (a reload)", async () => {
    covers("setting:paged.cockpit.v1");
    const state = {
      rightTabs: ["paged.properties", "paged.swatches"],
      activeTab: "paged.swatches",
    };
    const next = saveModeUiState({}, "design", state);
    expect(next).toEqual({ design: state });
    // Debounced: nothing yet.
    expect(ls.getItem(KEY)).toBeNull();
    await wait(DEBOUNCE_MS + 50);
    expect(JSON.parse(ls.getItem(KEY)!)).toEqual({ design: state });
    expect(loadCockpitStore()).toEqual({ design: state });
  });

  test("changes inside the debounce window coalesce into one write of the latest", async () => {
    covers("setting:paged.cockpit.v1");
    let writes = 0;
    const setItem = ls.setItem.bind(ls);
    ls.setItem = (k: string, v: string) => {
      writes++;
      setItem(k, v);
    };
    let store = saveModeUiState({}, "design", {
      rightTabs: ["a"],
      activeTab: "a",
    });
    store = saveModeUiState(store, "design", {
      rightTabs: ["a", "b"],
      activeTab: "b",
    });
    store = saveModeUiState(store, "prepress", {
      rightTabs: ["p"],
      activeTab: "p",
    });
    await wait(DEBOUNCE_MS + 50);
    expect(writes).toBe(1);
    expect(JSON.parse(ls.getItem(KEY)!)).toEqual({
      design: { rightTabs: ["a", "b"], activeTab: "b" },
      prepress: { rightTabs: ["p"], activeTab: "p" },
    });
  });

  test("migration: the legacy dockview layout keys are deleted on load, nothing else", () => {
    covers("setting:paged.cockpit.v1");
    ls.setItem("paged.layout.mode.design", "{}");
    ls.setItem("paged.layout.mode.prepress", "{}");
    ls.setItem("paged.layout.v2", "{}");
    ls.setItem("paged.theme", "light");
    ls.setItem(
      KEY,
      JSON.stringify({ data: { rightTabs: ["x"], activeTab: "x" } }),
    );
    expect(loadCockpitStore()).toEqual({
      data: { rightTabs: ["x"], activeTab: "x" },
    });
    expect(ls.keys().sort()).toEqual([KEY, "paged.theme"]);
  });

  test("the key is scoped per workspace (solo never overwrites the editor)", async () => {
    covers("setting:paged.cockpit.v1");
    ls.setItem(
      KEY,
      JSON.stringify({
        design: { rightTabs: ["editor"], activeTab: "editor" },
      }),
    );
    setChromeStorageScope(".solo.paged.draw");
    expect(loadCockpitStore()).toEqual({});
    saveModeUiState({}, "design", { rightTabs: ["draw"], activeTab: "draw" });
    await wait(DEBOUNCE_MS + 50);
    expect(JSON.parse(ls.getItem(`${KEY}.solo.paged.draw`)!)).toEqual({
      design: { rightTabs: ["draw"], activeTab: "draw" },
    });
    expect(JSON.parse(ls.getItem(KEY)!)).toEqual({
      design: { rightTabs: ["editor"], activeTab: "editor" },
    });
  });

  test("an unreadable blob loads as the empty store", () => {
    covers("setting:paged.cockpit.v1");
    for (const raw of ["{not json", "5", "null", '"text"', "true"]) {
      ls.setItem(KEY, raw);
      expect({ raw, store: loadCockpitStore() }).toEqual({ raw, store: {} });
    }
  });

  test("blocked storage: load is empty and a save stays in memory without throwing", async () => {
    covers("setting:paged.cockpit.v1");
    installWindow(() => {
      throw new Error("SecurityError");
    });
    expect(loadCockpitStore()).toEqual({});
    const state = { rightTabs: ["a"], activeTab: "a" };
    expect(saveModeUiState({}, "review", state)).toEqual({ review: state });
    await wait(DEBOUNCE_MS + 50);
  });

  test("a refused write (quota) keeps the in-memory store", async () => {
    covers("setting:paged.cockpit.v1");
    ls.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const state = { rightTabs: ["a"], activeTab: "a" };
    expect(saveModeUiState({}, "export", state)).toEqual({ export: state });
    await wait(DEBOUNCE_MS + 50);
    expect(ls.getItem(KEY)).toBeNull();
  });
});
