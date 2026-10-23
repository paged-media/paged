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

// THE COMMAND INVENTORY: what the editor registers, read at run time, must
// be what the surface gate reads statically.
//
// The host commands come from two sources, both read here:
//
//   · the command TABLES the app registers (`buildAppCommands`,
//     `buildObjectCommands`, …), built with no-op handlers — their ids are
//     exactly what the registry receives;
//   · the INLINE registrations (`registries.commands.register({ id: … })`
//     inside a component or provider). Every `.commands.register(` call
//     site in the editor's sources is counted per file against SITES, so a
//     new site fails until it is listed — and its ids with it.
//
// Their union must equal the host commands the surface gate enumerates
// from the source (apps/editor/scripts/surface/enumerate.mjs), so the
// static reader cannot silently read less than the registry receives, and
// a command added without a test fails the gate (whose acknowledged lists
// hold the gaps, with their reasons). The derived families count as one id
// each (`paged.panel.show.*`, …), as the gate counts them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

import { buildAppCommands } from "../../../src/app-commands";
import { ALIGN_COMMAND } from "../../../src/align-plan";
import { buildCoreCommandEntries } from "../../../src/core-command-entries";
import { buildInsertCommands } from "../../../src/insert-commands";
import { buildObjectCommands } from "../../../src/object-commands";
import { buildClipboardCommands } from "../../../src/clipboard-commands";
import { CANVAS_CONTEXT_MENU_COMMAND } from "../../../src/canvas-context-menu";
import { GLOBAL_LIGHT_COMMANDS } from "../../../src/panels/global-light-dialog";
import { OPEN_AS_TEMPLATE_COMMANDS } from "../../../src/panels/template/open-as-template-dialog";
import { SELECT_ALL_COMMAND } from "../../../src/select-all";
import { hostCommands } from "../../../src/app/instance";
import { AI_ASK_COMMAND } from "@paged-media/shell";

const EDITOR = fileURLToPath(new URL("../../../../../", import.meta.url));
const at = (...p: string[]) => join(EDITOR, ...p);

const walk = (
  dir: string,
  skip: (name: string) => boolean,
  out: string[] = [],
) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || skip(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, skip, out);
    else if ([".ts", ".tsx"].includes(extname(p))) out.push(p);
  }
  return out;
};

const SOURCES = [
  ...walk(at("packages"), (n) => n === "test"),
  ...walk(at("apps/canvas/src"), () => false),
];

const noop = new Proxy({}, { get: () => () => {} }) as never;

/** Every `.commands.register(` call site, per file. A new site fails
 *  here: list it, and the ids it registers below. */
const SITES: Record<string, number> = {
  "packages/shell/src/PagedShell.tsx": 10,
  "packages/shell/src/state/commands/registry-derived.ts": 3,
  "packages/shell/src/chrome/FillStrokeCluster.tsx": 3,
  "packages/shell/src/actions/actions-context.tsx": 3,
  "packages/shell/src/bundles/loader.ts": 1,
  "packages/shell/src/bundles/sample-bundle.worker.ts": 1,
  // The app tables, and the host actions as commands (hostCommands).
  "apps/canvas/src/app/mount.tsx": 2,
  "apps/canvas/src/panels/schema-list-demo-panel.tsx": 1,
  "apps/canvas/src/panels/schema-tree-demo-panel.tsx": 2,
  "apps/canvas/src/panels/layers-panel.tsx": 1,
};

/** What the sites register, beyond the tables. `loader.ts` registers a
 *  worker bundle's own ids (plugin surface); `registry-derived.ts` the
 *  families. */
const INLINE_IDS: Record<string, string[]> = {
  "packages/shell/src/PagedShell.tsx": [
    "paged.chrome.toggleAll",
    "paged.chrome.togglePanels",
    // The rest of PagedShell's sites register the shell builders:
    "paged.view.toggleScreenPreview",
    "paged.file.openIdml",
    "paged.file.new",
    "paged.file.newFromBrief",
    "paged.library.importAse",
    "paged.library.exportAse",
    "paged.file.exportPdf",
    "paged.palette.toggle",
  ],
  "packages/shell/src/state/commands/registry-derived.ts": [
    "paged.tool.activate.*",
    "paged.panel.show.*",
    "paged.panel.hide.*",
  ],
  "packages/shell/src/chrome/FillStrokeCluster.tsx": [
    "paged.fillStroke.swap",
    "paged.fillStroke.default",
    "paged.fillStroke.toggleAffects",
  ],
  "packages/shell/src/actions/actions-context.tsx": [
    "paged.actions.record",
    "paged.actions.stop",
    "paged.actions.play",
  ],
  "packages/shell/src/bundles/sample-bundle.worker.ts": ["paged.sample.hello"],
  "apps/canvas/src/app/mount.tsx": [AI_ASK_COMMAND, ALIGN_COMMAND],
  "apps/canvas/src/panels/schema-list-demo-panel.tsx": [
    "paged.demo.applySwatchStroke",
  ],
  "apps/canvas/src/panels/schema-tree-demo-panel.tsx": [
    "paged.demo.renameLayer",
    "paged.demo.moveLayer",
  ],
  "apps/canvas/src/panels/layers-panel.tsx": [
    "paged.layers.reorder",
    "paged.layers.assignSelection",
    "paged.layers.togglePrintable",
    "paged.layers.rename",
    "paged.layers.toggleVisible",
    "paged.layers.toggleLocked",
    "paged.layers.remove",
    "paged.layers.add",
  ],
};

const rel = (p: string) => relative(EDITOR, p).split("\\").join("/");

function tableIds(): string[] {
  return [
    ...buildAppCommands(noop),
    ...buildClipboardCommands(noop),
    CANVAS_CONTEXT_MENU_COMMAND,
    ...buildObjectCommands(noop),
    ...buildInsertCommands(noop),
    ...buildCoreCommandEntries(),
    ...GLOBAL_LIGHT_COMMANDS,
    ...OPEN_AS_TEMPLATE_COMMANDS,
    SELECT_ALL_COMMAND,
    // Registered only when an embedding host supplies the action.
    ...hostCommands({ submit: noop, close: noop, back: noop }),
  ].map((c) => c.id);
}

function hostIds(): Set<string> {
  return new Set([...tableIds(), ...Object.values(INLINE_IDS).flat()]);
}

describe("the host command inventory", () => {
  test("every .commands.register( site is listed (a new one must name its ids)", () => {
    const counts: Record<string, number> = {};
    for (const file of SOURCES) {
      const n = (
        readFileSync(file, "utf8").match(/\.commands\.register\(/g) ?? []
      ).length;
      if (n > 0) counts[rel(file)] = n;
    }
    // Floor: a scan that stops matching must not pass.
    expect(
      Object.values(counts).reduce((a, b) => a + b, 0),
    ).toBeGreaterThanOrEqual(25);
    expect(counts).toEqual(SITES);
  });

  test("the inline ids are the ones the sites literally name", () => {
    // Each listed literal (or the constant it resolves through) appears in
    // its file, so a renamed id fails here rather than going unseen.
    for (const [file, ids] of Object.entries(INLINE_IDS)) {
      const src = readFileSync(at(file), "utf8");
      for (const id of ids) {
        if (id.endsWith(".*")) continue;
        const literal = src.includes(`"${id}"`);
        const constant = [
          ...src.matchAll(
            /(?:export )?const ([A-Z_0-9]+)\s*=\s*\n?\s*"([^"]+)"/g,
          ),
        ].some((m) => m[2] === id && src.includes(`id: ${m[1]}`));
        const viaImport =
          file === "apps/canvas/src/app/mount.tsx" &&
          ((id === AI_ASK_COMMAND && src.includes("id: AI_ASK_COMMAND")) ||
            (id === ALIGN_COMMAND && src.includes("id: ALIGN_COMMAND")));
        const viaBuilder =
          file.endsWith("PagedShell.tsx") && !id.startsWith("paged.chrome.");
        expect({
          file,
          id,
          found: literal || constant || viaImport || viaBuilder,
        }).toEqual({
          file,
          id,
          found: true,
        });
      }
    }
  });

  test("main.tsx registers exactly the tables this inventory builds", () => {
    const src = readFileSync(at("apps/canvas/src/app/mount.tsx"), "utf8");
    const start = src.indexOf("const cmdDisposables = [");
    const block = src.slice(
      start,
      src.indexOf("].map((c) => registries.commands.register(c))", start),
    );
    const entries = [
      ...block.matchAll(/^\s*(\.\.\.)?([A-Za-z_][A-Za-z0-9_]*(?:\(\))?),/gm),
    ].map((m) => m[2]);
    expect(entries).toEqual([
      "commands",
      "aiCommands",
      "clipboardCommands",
      "CANVAS_CONTEXT_MENU_COMMAND",
      "objectCommands",
      "insertCommands",
      "alignCommands",
      "GLOBAL_LIGHT_COMMANDS",
      "OPEN_AS_TEMPLATE_COMMANDS",
      "SELECT_ALL_COMMAND",
      "buildCoreCommandEntries()",
    ]);
  });

  test("the gate's static enumeration reads exactly the commands the app registers", async () => {
    const { enumerateSurface } = (await import(
      pathToFileURL(at("scripts/surface/enumerate.mjs")).href
    )) as {
      enumerateSurface(root: string): {
        items: Array<{ kind: string; id: string; origin: string }>;
      };
    };
    const surface = enumerateSurface(
      fileURLToPath(new URL("../../../../../../../", import.meta.url)),
    );
    const gate = surface.items
      .filter((i) => i.kind === "command" && i.origin === "host")
      .map((i) => i.id)
      .sort();
    const host = [...hostIds()].sort();
    expect(host.length).toBeGreaterThanOrEqual(100);
    expect(gate).toEqual(host);
  }, 180_000);
});
