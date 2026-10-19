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

// THE BUNDLEHOST CONTRACT — `host.contribute.*`: a declared contribution
// lands in the host's registry and leaves it on dispose, an undeclared one
// is refused, and what the editor then does with it (a command runs, a key
// runs its command, a menu entry points at a registered command, an
// importer claims its extension). On `editor` the registries are the
// shell's own; on `headless` / `bare` the harness records them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { BundleHost, ImporterContribution } from "@paged-media/plugin-api";

import {
  PROBE_ID,
  bareAdapter,
  editorAdapter,
  headlessAdapter,
  probeManifest,
  type HostUnderTest,
} from "./hosts";

const Nothing = () => null;

const tool = (id = `${PROBE_ID}.tool.one`) => ({
  id,
  title: "Probe tool",
  icon: "tool-pen",
  group: "pen",
  section: "drawType",
});
const panel = (id = `${PROBE_ID}.panel.one`) => ({
  id,
  title: "Probe panel",
  component: Nothing,
});
const command = (
  id = `${PROBE_ID}.command.one`,
  handler: (paged: unknown, payload?: unknown) => unknown = () => "ran",
) => ({ id, title: "Probe command", handler });
const importer = (
  id = `${PROBE_ID}.importer.one`,
  run: (f: { name: string }) => void = () => {},
): ImporterContribution => ({
  id,
  title: "Probe file",
  extensions: [".probe"],
  mimeTypes: ["application/x-probe"],
  import: run,
});
const exporter = (id = `${PROBE_ID}.exporter.one`) => ({
  id,
  title: "Probe file",
  extension: ".probe",
  export: () => ({ bytes: new Uint8Array([1]), fileName: "a.probe" }),
});

describe.each([
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.contribute — %s", (name, make) => {
  let t: HostUnderTest;
  let h: BundleHost;
  beforeAll(async () => {
    t = await make();
    h = t.host;
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a declared tool, panel, command, importer and exporter register, and leave on dispose", () => {
    const ds = [
      h.contribute.tool(tool() as never),
      h.contribute.panel(panel() as never),
      h.contribute.command(command() as never),
      h.contribute.importer(importer()),
      h.contribute.exporter(exporter()),
    ];
    const r = t.registered();
    expect(r.tools).toContain(`${PROBE_ID}.tool.one`);
    expect(r.panels).toContain(`${PROBE_ID}.panel.one`);
    expect(r.commands).toContain(`${PROBE_ID}.command.one`);
    expect(r.importers).toContain(`${PROBE_ID}.importer.one`);
    expect(r.exporters).toContain(`${PROBE_ID}.exporter.one`);
    for (const d of ds) d.dispose();
    const after = t.registered();
    expect(after.tools).not.toContain(`${PROBE_ID}.tool.one`);
    expect(after.panels).not.toContain(`${PROBE_ID}.panel.one`);
    expect(after.commands).not.toContain(`${PROBE_ID}.command.one`);
    expect(after.importers).not.toContain(`${PROBE_ID}.importer.one`);
    expect(after.exporters).not.toContain(`${PROBE_ID}.exporter.one`);
  });

  test("an id the manifest does not declare is refused, and nothing registers", () => {
    const before = t.registered();
    expect(() =>
      h.contribute.tool(tool(`${PROBE_ID}.tool.undeclared`) as never),
    ).toThrow();
    expect(() =>
      h.contribute.panel(panel(`${PROBE_ID}.panel.undeclared`) as never),
    ).toThrow();
    expect(() =>
      h.contribute.command(command(`${PROBE_ID}.command.undeclared`) as never),
    ).toThrow();
    expect(() =>
      h.contribute.importer(importer(`${PROBE_ID}.importer.undeclared`)),
    ).toThrow();
    expect(() =>
      h.contribute.exporter(exporter(`${PROBE_ID}.exporter.undeclared`)),
    ).toThrow();
    expect(t.registered()).toEqual(before);
  });

  test("an id outside this plugin's namespace is refused", () => {
    expect(() =>
      h.contribute.command(command("paged.editor.undo") as never),
    ).toThrow();
    expect(() =>
      h.contribute.command(command("media.paged.draw.command.x") as never),
    ).toThrow();
  });

  test("a registered command runs its handler with the payload", async () => {
    const seen: unknown[] = [];
    const d = h.contribute.command(
      command(`${PROBE_ID}.command.two`, (_p, payload) => {
        seen.push(payload);
        return "done";
      }) as never,
    );
    expect(await t.invokeCommand(`${PROBE_ID}.command.two`, { n: 3 })).toBe(
      "done",
    );
    expect(seen).toEqual([{ n: 3 }]);
    d.dispose();
  });

  test("a key binding needs capabilities.keybindings", () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenokeys", {
        capabilities: { keybindings: false },
        contributes: { commands: ["media.paged.probenokeys.command.one"] },
      }),
    );
    expect(() =>
      narrow.contribute.keybinding({
        key: "cmd+shift+k",
        command: "media.paged.probenokeys.command.one",
      }),
    ).toThrow(/keybindings/);
  });

  if (name !== "bare")
    test("a declared edit context and object type register by type", () => {
      const a = h.contribute.editContext({
        type: "probeFrame",
        entry: "doubleClick",
        matches: () => false,
      });
      const b = h.contribute.objectType({
        type: "probeFrame",
        matches: () => false,
        bakedFallback: "rectangle",
      });
      expect(t.registered().editContexts).toContain("probeFrame");
      expect(t.registered().objectTypes).toContain("probeFrame");
      expect(() =>
        h.contribute.editContext({
          type: "sheet",
          entry: "doubleClick",
          matches: () => false,
        }),
      ).toThrow();
      a.dispose();
      b.dispose();
      expect(t.registered().editContexts).not.toContain("probeFrame");
    });
});

describe("host.contribute — what the editor does with a contribution", () => {
  let t: HostUnderTest;
  let h: BundleHost;
  beforeAll(async () => {
    t = await editorAdapter();
    h = t.host;
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a key binding runs its command when the key is pressed", async () => {
    let ran = 0;
    const c = h.contribute.command(
      command(`${PROBE_ID}.command.one`, () => {
        ran += 1;
      }) as never,
    );
    const k = h.contribute.keybinding({
      key: "cmd+shift+y",
      command: `${PROBE_ID}.command.one`,
    });
    expect(t.registered().keybindings).toContain(
      `cmd+shift+y→${PROBE_ID}.command.one`,
    );
    expect(await t.editorApp!.ed.press("cmd+shift+y")).toBe(true);
    expect(ran).toBe(1);
    k.dispose();
    expect(await t.editorApp!.ed.press("cmd+shift+y")).toBe(false);
    expect(ran).toBe(1);
    c.dispose();
  });

  test("a command's when gates it in the editor", async () => {
    let enabled = false;
    let ran = 0;
    const c = h.contribute.command({
      ...command(`${PROBE_ID}.command.two`, () => {
        ran += 1;
      }),
      when: () => enabled,
    } as never);
    await t.invokeCommand(`${PROBE_ID}.command.two`).catch(() => {});
    expect(ran).toBe(0);
    enabled = true;
    await t.invokeCommand(`${PROBE_ID}.command.two`);
    expect(ran).toBe(1);
    c.dispose();
  });

  test("a menu entry lands at its path on a registered command, leaves on dispose; an undeclared command is refused", () => {
    const c = h.contribute.command(command() as never);
    const m = h.contribute.menu({
      path: "Probe/Run the probe",
      command: `${PROBE_ID}.command.one`,
    });
    expect(t.registered().menus).toContain(
      `Probe/Run the probe→${PROBE_ID}.command.one`,
    );
    expect(() =>
      h.contribute.menu({
        path: "Probe/Elsewhere",
        command: `${PROBE_ID}.command.undeclared`,
      }),
    ).toThrow(/contributes\.commands/);
    m.dispose();
    expect(t.registered().menus).not.toContain(
      `Probe/Run the probe→${PROBE_ID}.command.one`,
    );
    c.dispose();
  });

  // MenuContribution.command: "Must be a command the bundle has
  // REGISTERED — the host refuses an entry pointing at nothing". The SDK
  // checks the manifest's declaration only, so an entry onto a declared
  // command the bundle has not registered (or registers only under a
  // condition) is accepted and sits in the menu bar, doing nothing.
  test.failing(
    "HOST-7 — a menu entry onto a declared but unregistered command is refused",
    () => {
      expect(t.registered().commands).not.toContain(`${PROBE_ID}.command.two`);
      expect(() =>
        h.contribute.menu({
          path: "Probe/Nothing",
          command: `${PROBE_ID}.command.two`,
        }),
      ).toThrow();
    },
  );

  test("an importer claims its extension and MIME type in File ▸ Open", async () => {
    const got: string[] = [];
    const d = h.contribute.importer(
      importer(undefined, (f) => void got.push(f.name)),
    );
    const registry = t.editorApp!.ed.registries.importers!;
    const resolved = registry.resolve("Report.PROBE");
    expect(resolved?.id).toBe(`${PROBE_ID}.importer.one`);
    expect(registry.resolve("x.bin", "application/x-probe")?.id).toBe(
      `${PROBE_ID}.importer.one`,
    );
    await resolved!.import({
      name: "Report.PROBE",
      bytes: new Uint8Array(),
      mimeType: "",
    });
    expect(got).toEqual(["Report.PROBE"]);
    d.dispose();
    expect(registry.resolve("Report.PROBE")).toBeNull();
  });
});
