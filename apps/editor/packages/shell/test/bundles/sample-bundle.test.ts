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

// The shell's worker-bundle loader (`src/bundles/loader.ts`) with the
// sample bundle it ships to prove the path: a real Worker (Bun runs the
// `.worker.ts` kernel), the activate / register / ready handshake, the
// invoke round trip, the key binding dispatched through the registry, and
// dispose. The editor itself never loads the sample bundle (its bundles go
// through plugin-sdk's loader), so this is the only place these three
// contributions are reachable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { loadBundle } from "../../src/bundles/loader";
import { sampleBundleManifest } from "../../src/bundles/sample-bundle";
import { createShellRegistries } from "../../src/state/registries-context";

let target: EventTarget & {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};
const logged: string[] = [];
const info = console.info;

beforeEach(() => {
  // The loader times its handshake with `window.setTimeout`; the key
  // binding registry listens on `window`.
  target = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  stubGlobal("window", target);
  logged.length = 0;
  console.info = (...args: unknown[]) => void logged.push(args.join(" "));
});
afterEach(() => {
  console.info = info;
  unstubAllGlobals();
});

/** Cmd+Shift+H on the stub window; true when a binding took it. */
function pressCmdShiftH(): boolean {
  const event = new Event("keydown", { cancelable: true });
  for (const [k, v] of Object.entries({
    key: "h",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    target: null,
  })) {
    Object.defineProperty(event, k, { value: v });
  }
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

describe("the sample worker bundle, through the shell's loader", () => {
  test("activates in a worker and registers its command, key binding and menu item", async () => {
    covers(
      "command:paged.sample.hello",
      "keybinding:cmd+shift+h→paged.sample.hello",
    );
    const registries = createShellRegistries(() => null);
    const manifest = sampleBundleManifest();
    const handle = await loadBundle(manifest, registries);
    try {
      expect(handle.active).toBe(true);
      const command = registries.commands.get("paged.sample.hello");
      expect({ title: command?.title, category: command?.category }).toEqual({
        title: "Sample: Hello from Bundle",
        category: "Sample",
      });
      expect(
        registries.keybindings
          .list()
          .filter((k) => k.command === "paged.sample.hello")
          .map((k) => k.key),
      ).toEqual(["cmd+shift+h"]);
      expect(registries.menus.get("Tools/Sample bundle hello")).toMatchObject({
        command: "paged.sample.hello",
        order: 10,
      });
    } finally {
      handle.dispose();
      registries.keybindings.detach();
    }
  });

  // Finding SH-13 (fixed): the manifest declared "Tools/Sample Bundle
  // Hello" while the kernel registers "Tools/Sample bundle hello". Menu
  // paths are keys, so anything that checks a manifest against its
  // registrations (as plugin-sdk's checkManifestConformance does for the
  // plugin bundles) reported one missing and one undeclared.
  test("SH-13: the manifest declares exactly the contributions the kernel registers", async () => {
    covers("command:paged.sample.hello");
    const registries = createShellRegistries(() => null);
    const manifest = sampleBundleManifest();
    const handle = await loadBundle(manifest, registries);
    try {
      expect({
        commands: registries.commands
          .list()
          .map((c) => c.id)
          .filter((id) => id.startsWith("paged.sample.")),
        keybindings: registries.keybindings.list().map((k) => k.key),
        menus: registries.menus.list().map((m) => m.path),
      }).toEqual({
        commands: [...(manifest.contributes?.commands ?? [])],
        keybindings: [...(manifest.contributes?.keybindings ?? [])],
        menus: [...(manifest.contributes?.menus ?? [])],
      });
    } finally {
      handle.dispose();
      registries.keybindings.detach();
    }
  });

  test("invoking the command runs the worker's handler and resolves with its answer", async () => {
    covers("command:paged.sample.hello");
    const registries = createShellRegistries(() => null);
    const handle = await loadBundle(sampleBundleManifest(), registries);
    try {
      const answer = await registries.commands.invoke("paged.sample.hello");
      expect(answer).toEqual({
        ok: true,
        message: "Hello from the sample bundle",
      });
      await until(() => logged.length > 0, "the handler's log line");
      expect(logged).toEqual([
        "[bundle:paged.sample] sample bundle handler ran",
      ]);
    } finally {
      handle.dispose();
      registries.keybindings.detach();
    }
  });

  test("Cmd+Shift+H runs it; after dispose the key, the command and the menu item are gone", async () => {
    covers(
      "command:paged.sample.hello",
      "keybinding:cmd+shift+h→paged.sample.hello",
    );
    const registries = createShellRegistries(() => null);
    const handle = await loadBundle(sampleBundleManifest(), registries);
    expect(pressCmdShiftH()).toBe(true);
    await until(() => logged.length > 0, "the handler run by the key");
    expect(logged).toEqual(["[bundle:paged.sample] sample bundle handler ran"]);

    handle.dispose();
    expect(handle.active).toBe(false);
    expect(registries.commands.get("paged.sample.hello")).toBeUndefined();
    expect(registries.menus.get("Tools/Sample bundle hello")).toBeUndefined();
    expect(pressCmdShiftH()).toBe(false);
    registries.keybindings.detach();
  });
});
