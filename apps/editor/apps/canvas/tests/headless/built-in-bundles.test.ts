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

// THE BUILT-IN BUNDLES IN THE HEADLESS EDITOR. All nine bundles of the
// editor's table (src/plugin-bundle-table.ts, slide included), activated as
// main.tsx activates them: through the SDK's `loadBundle` with the editor's
// own host options (`createEditorHostOptions`), over the shell's real
// registries. What each manifest declares must then be in the registries the
// editor's chrome reads — the palette (commands), the rail (tools), the
// dock (panels), File ▸ Open / Export (importers, exporters) — and every menu
// entry and key binding a bundle adds at run time must point at a command
// that is there. This is the editor surface as the app enumerates it, so a
// bundle missing here is missing in the editor.
//
// (bundle-registrations.test.ts checks each manifest against what the bundle
// registers on the SDK's headless host; this checks the same declarations
// against the EDITOR's registries, after all nine are live together.)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";

import { PLUGIN_BUNDLES } from "../../src/plugin-bundle-table";
import { objectRegistry } from "../../src/object-model";

import { createHeadlessEditor, type HeadlessEditor } from "./harness";

/** The nine, pinned: a bundle leaving the table, or a tenth joining it
 *  without a row here, fails the first test. */
const BUILT_INS = [
  "media.paged.draw",
  "media.paged.web",
  "media.paged.data",
  "media.paged.sheet",
  "media.paged.image",
  "media.paged.publish",
  "media.paged.pdf",
  "media.paged.doc",
  "media.paged.slide",
] as const;

let ed: HeadlessEditor;
let hosts: Map<string, BundleHost>;

beforeAll(async () => {
  ed = await createHeadlessEditor({ blank: [612, 792] });
  hosts = await ed.loadBuiltInBundles();
}, 120_000);

afterAll(async () => {
  await ed.dispose();
});

const manifestOf = (id: string): PluginManifest => hosts.get(id)!.manifest;

describe("the editor's built-in bundles, activated together in the headless editor", () => {
  test("all nine activate, in the table's order, slide included", () => {
    expect(PLUGIN_BUNDLES.map((b) => b.id)).toEqual([...BUILT_INS]);
    expect([...hosts.keys()]).toEqual([...BUILT_INS]);
  });

  test("each host answers the doors the editor wires for every bundle", () => {
    for (const [id, host] of hosts) {
      const missing = [
        "contribute.panel@1",
        "contribute.importer@1",
        "contribute.exporter@1",
        "contribute.objectModel@1",
        "contribute.schemaPanel@1",
        "schemaPanel.renderer@1",
        "render.snapshot@1",
        "viewport.pages@1",
        "storage.parts@1",
        "documents.open@1",
        "document.readNative@1",
        "network.consent@1",
        "dataProviders@1",
        "bindings.provider@1",
        "objects.shared@1",
        "tools.settings@1",
        "document.onWillSave@1",
        "shell.openPanel@1",
        "diagnostics.publish@1",
      ].filter((f) => !host.supports(f));
      expect({ id, missing }).toEqual({ id, missing: [] });
    }
  });

  for (const id of BUILT_INS) {
    test(`${id}: what its manifest declares is in the editor's registries`, async () => {
      const c = manifestOf(id).contributes ?? {};
      const r = ed.registries;
      const has = <T>(list: T[], key: (x: T) => string) =>
        new Set(list.map(key));
      const panels = has(r.panels.list(), (p) => p.id);
      const commands = has(r.commands.list(), (p) => p.id);
      const tools = has(r.tools.list(), (p) => p.id);
      const importers = has(r.importers?.list() ?? [], (p) => p.id);
      const exporters = has(r.exporters?.list() ?? [], (p) => p.id);
      const typed = has([...(await objectRegistry.commands())], (p) => p.id);
      const missing = [
        ...(c.panels ?? []).filter((x) => !panels.has(x)),
        ...(c.commands ?? []).filter((x) => !commands.has(x)),
        ...(c.tools ?? []).filter((x) => !tools.has(x)),
        ...(c.importers ?? []).filter((x) => !importers.has(x)),
        ...(c.exporters ?? []).filter((x) => !exporters.has(x)),
        ...(c.objectModel?.commands ?? [])
          .map((x) => x.id)
          .filter((x) => !typed.has(x)),
      ];
      expect(missing).toEqual([]);
    });
  }

  test("every menu entry and key binding the bundles add points at a registered command", () => {
    const commands = new Set(ed.registries.commands.list().map((c) => c.id));
    const bundleMenus = ed.registries.menus
      .list()
      .filter((m) => m.command.startsWith("media.paged."));
    const bundleKeys = ed.registries.keybindings
      .list()
      .filter((k) => k.command.startsWith("media.paged."));
    // Five bundles add menu entries (draw, image, sheet, data, web, doc);
    // sheet adds the key bindings of its grid.
    expect(bundleMenus.length).toBeGreaterThan(100);
    expect(bundleKeys.length).toBeGreaterThan(0);
    expect(
      bundleMenus.filter((m) => !commands.has(m.command)).map((m) => m.path),
    ).toEqual([]);
    expect(
      bundleKeys.filter((k) => !commands.has(k.command)).map((k) => k.key),
    ).toEqual([]);
  });
});
