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

// paged.sheet's keybindings (the nine `contribute.keybinding` entries in
// src/activate.ts): each is registered with its key and command, is live
// ONLY while a sheet frame is entered and focus is not in a text field
// (`when: inGrid`), and running the command it names does that command's
// work at the grid selection. The real bundle on the recording fake editor
// (./conformance/env.ts); the sheet engine is real.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import type { KeybindingContribution } from "@paged-media/plugin-api";
import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { unitEnv, type SheetEnv } from "./conformance/env";
import {
  PANEL,
  cell,
  column,
  openBook,
  selectCell,
  selectRect,
} from "./conformance/scenarios";
import { ENGINE_BUILT, WASM } from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("sheet keybindings (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

const live = (b: KeybindingContribution): boolean =>
  (b.when as (s: unknown) => boolean)(null);

/** The binding for `key`, checked registered for `command`, and its gate
 *  walked: off with a workbook but no entered frame, on inside the frame,
 *  off again while focus is in a text field. Leaves the frame entered. */
async function bound(
  env: SheetEnv,
  key: string,
  command: string,
): Promise<KeybindingContribution> {
  const b = env.keybindings().find((k) => k.key === key);
  expect(b, `${key} is bound`).toBeDefined();
  expect(b!.command).toBe(command);
  await openBook(env);
  expect(live(b!), "off outside a sheet frame").toBe(false);
  env.editContext().onEnter?.({
    type: "sheet",
    id: { kind: "textFrame", id: "f1" },
  } as never);
  await env.settle();
  expect(live(b!), "on inside the entered frame").toBe(true);
  stubGlobal("document", { activeElement: { tagName: "INPUT" } });
  expect(live(b!), "off while typing in a field").toBe(false);
  unstubAllGlobals();
  expect(live(b!)).toBe(true);
  return b!;
}

const run = async (env: SheetEnv, b: KeybindingContribution) => {
  await env.command(b.command).handler(env.host.editor);
  await env.settle();
};

const effect = {
  async copy(env: SheetEnv, b: KeybindingContribution) {
    selectRect(env, 0, 0, 1, 1);
    await run(env, b);
    expect(env.clipboard.payload?.tabular?.rows).toEqual([
      ["name", "qty"],
      ["Apples", "12"],
    ]);
  },
  async paste(env: SheetEnv, b: KeybindingContribution) {
    env.clipboard.payload = { tabular: { rows: [["Limes", "4"]] } };
    selectCell(env, 3, 0);
    await run(env, b);
    expect([await cell(env, "A4"), await cell(env, "B4")]).toEqual([
      "Limes",
      "4",
    ]);
  },
  async fillDown(env: SheetEnv, b: KeybindingContribution) {
    selectRect(env, 1, 0, 3, 0);
    await run(env, b);
    expect(await column(env, "A")).toEqual([
      "name",
      "Apples",
      "Apples",
      "Apples",
    ]);
  },
  async fillRight(env: SheetEnv, b: KeybindingContribution) {
    selectRect(env, 2, 0, 2, 1);
    await run(env, b);
    expect(await cell(env, "B3")).toBe("Pears");
  },
  async find(env: SheetEnv, b: KeybindingContribution) {
    await run(env, b);
    expect(env.opened).toContain(PANEL.grid);
  },
};

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet keybindings${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => {
      unstubAllGlobals();
      env.dispose();
    });

    it("exactly the nine grid keys are bound, all gated on the grid", () => {
      expect(env.keybindings().map((k) => `${k.key} ${k.command}`)).toEqual([
        "cmd+c media.paged.sheet.command.copySelection",
        "ctrl+c media.paged.sheet.command.copySelection",
        "cmd+v media.paged.sheet.command.pasteSelection",
        "ctrl+v media.paged.sheet.command.pasteSelection",
        "cmd+d media.paged.sheet.command.fillDown",
        "cmd+r media.paged.sheet.command.fillRight",
        "ctrl+r media.paged.sheet.command.fillRight",
        "cmd+f media.paged.sheet.command.findInSheet",
        "ctrl+f media.paged.sheet.command.findInSheet",
      ]);
      for (const b of env.keybindings()) expect(b.when).toBeDefined();
    });

    it("cmd+c → copySelection: live only inside an entered sheet frame, and it does what copySelection does", async () => {
      covers("keybinding:cmd+c→media.paged.sheet.command.copySelection");
      const b = await bound(
        env,
        "cmd+c",
        "media.paged.sheet.command.copySelection",
      );
      await effect.copy(env, b);
    });

    it("ctrl+c → copySelection: live only inside an entered sheet frame, and it does what copySelection does", async () => {
      covers("keybinding:ctrl+c→media.paged.sheet.command.copySelection");
      const b = await bound(
        env,
        "ctrl+c",
        "media.paged.sheet.command.copySelection",
      );
      await effect.copy(env, b);
    });

    it("cmd+v → pasteSelection: live only inside an entered sheet frame, and it does what pasteSelection does", async () => {
      covers("keybinding:cmd+v→media.paged.sheet.command.pasteSelection");
      const b = await bound(
        env,
        "cmd+v",
        "media.paged.sheet.command.pasteSelection",
      );
      await effect.paste(env, b);
    });

    it("ctrl+v → pasteSelection: live only inside an entered sheet frame, and it does what pasteSelection does", async () => {
      covers("keybinding:ctrl+v→media.paged.sheet.command.pasteSelection");
      const b = await bound(
        env,
        "ctrl+v",
        "media.paged.sheet.command.pasteSelection",
      );
      await effect.paste(env, b);
    });

    it("cmd+d → fillDown: live only inside an entered sheet frame, and it does what fillDown does", async () => {
      covers("keybinding:cmd+d→media.paged.sheet.command.fillDown");
      const b = await bound(env, "cmd+d", "media.paged.sheet.command.fillDown");
      await effect.fillDown(env, b);
    });

    it("cmd+r → fillRight: live only inside an entered sheet frame, and it does what fillRight does", async () => {
      covers("keybinding:cmd+r→media.paged.sheet.command.fillRight");
      const b = await bound(
        env,
        "cmd+r",
        "media.paged.sheet.command.fillRight",
      );
      await effect.fillRight(env, b);
    });

    it("ctrl+r → fillRight: live only inside an entered sheet frame, and it does what fillRight does", async () => {
      covers("keybinding:ctrl+r→media.paged.sheet.command.fillRight");
      const b = await bound(
        env,
        "ctrl+r",
        "media.paged.sheet.command.fillRight",
      );
      await effect.fillRight(env, b);
    });

    it("cmd+f → findInSheet: live only inside an entered sheet frame, and it does what findInSheet does", async () => {
      covers("keybinding:cmd+f→media.paged.sheet.command.findInSheet");
      const b = await bound(
        env,
        "cmd+f",
        "media.paged.sheet.command.findInSheet",
      );
      await effect.find(env, b);
    });

    it("ctrl+f → findInSheet: live only inside an entered sheet frame, and it does what findInSheet does", async () => {
      covers("keybinding:ctrl+f→media.paged.sheet.command.findInSheet");
      const b = await bound(
        env,
        "ctrl+f",
        "media.paged.sheet.command.findInSheet",
      );
      await effect.find(env, b);
    });
  },
);
