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

// The swatch-library commands (import .ase as ONE undoable mutation, export
// the document's swatches as a download) and the two shell commands that
// only open something: the command palette and the Export PDF dialog. The
// dialogs' notifiers are module-scope buses their components subscribe to;
// they are observed here by mocking the bus, keeping the rest of each
// module.

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  covers,
  createFakeShellEditor,
  expectOneCommit,
  stubGlobal,
  unstubAllGlobals,
} from "@paged-media/test-kit";

const paletteCalls: unknown[] = [];
const exportPdfCalls: unknown[] = [];
const palette = await import("../../src/chrome/CommandPalette");
mock.module("../../src/chrome/CommandPalette", () => ({
  ...palette,
  notifyPalette: (action: unknown) => void paletteCalls.push(action),
}));
const exportDialog = await import("../../src/chrome/ExportPdfDialog");
mock.module("../../src/chrome/ExportPdfDialog", () => ({
  ...exportDialog,
  notifyExportPdfDialog: (action: unknown) => void exportPdfCalls.push(action),
}));

const { createCommandRegistry } = await import("../../src/registries/command");
const { buildExportAseCommand, buildImportAseCommand } =
  await import("../../src/state/commands/library-commands");
const { buildExportPdfCommand } =
  await import("../../src/state/commands/export-commands");
const {
  PALETTE_TOGGLE_COMMAND,
  PALETTE_TOGGLE_KEYBINDING,
  PALETTE_TOGGLE_KEYBINDING_CTRL,
} = await import("../../src/state/commands/built-in-commands");

afterEach(() => unstubAllGlobals());

describe("Import swatches (.ase) — paged.library.importAse", () => {
  const ase = (name: string) =>
    new File([new Uint8Array([0x41, 0x53, 0x45, 0x46, 1])], name);

  function harness(file: File | null, refuse = false) {
    const fake = createFakeShellEditor({
      refuse: refuse ? () => "bad ASE" : undefined,
    });
    const statuses: string[] = [];
    const r = createCommandRegistry(() => fake.shell);
    r.register(
      buildImportAseCommand({
        pickFile: async () => file,
        setStatus: (s) => void statuses.push(s),
      }),
    );
    return { fake, r, statuses };
  }

  test("the picked bytes land as ONE importSwatchLibrary named after the file", async () => {
    covers("command:paged.library.importAse");
    const h = harness(ase("Brand Colours.ASE"));
    await h.r.invoke("paged.library.importAse");
    await h.fake.settle();
    expect(h.fake.mutations()).toEqual([
      {
        op: "importSwatchLibrary",
        args: {
          bytes: [0x41, 0x53, 0x45, 0x46, 1],
          groupName: "Brand Colours",
        },
      },
    ]);
    expectOneCommit(h.fake);
    expect(h.fake.undoDepth()).toBe(1);
    expect(h.statuses).toEqual(["imported swatch library “Brand Colours”"]);
  });

  test("a cancelled picker sends nothing", async () => {
    covers("command:paged.library.importAse");
    const h = harness(null);
    await h.r.invoke("paged.library.importAse");
    expect(h.fake.mutations()).toEqual([]);
    expect(h.statuses).toEqual([]);
  });

  test("an engine refusal says the import failed", async () => {
    covers("command:paged.library.importAse");
    const h = harness(ase("x.ase"), true);
    await h.r.invoke("paged.library.importAse");
    await h.fake.settle();
    expect(h.statuses).toEqual(["swatch import failed"]);
    expect(h.fake.undoDepth()).toBe(0);
  });
});

describe("Save swatches (.ase) — paged.library.exportAse", () => {
  test("downloads the engine's .ase bytes as swatches.ase; the document is untouched", async () => {
    covers("command:paged.library.exportAse");
    const clicks: Array<{ href: string; download: string }> = [];
    const blobs: Blob[] = [];
    stubGlobal("document", {
      createElement: (tag: string) => {
        expect(tag).toBe("a");
        const a = {
          href: "",
          download: "",
          click: () => void clicks.push({ href: a.href, download: a.download }),
        };
        return a;
      },
    });
    const create = URL.createObjectURL;
    const revoked: string[] = [];
    URL.createObjectURL = (b: Blob) => {
      blobs.push(b);
      return "blob:ase";
    };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (u: string) => void revoked.push(u);
    try {
      const fake = createFakeShellEditor();
      const editor = {
        ...fake.shell,
        client: {
          ...fake.shell.client,
          exportSwatchLibrary: async () => new Uint8Array([9, 8, 7]),
        },
      };
      const statuses: string[] = [];
      const r = createCommandRegistry(() => editor);
      r.register(
        buildExportAseCommand({ setStatus: (s) => void statuses.push(s) }),
      );
      await r.invoke("paged.library.exportAse");
      expect(clicks).toEqual([{ href: "blob:ase", download: "swatches.ase" }]);
      expect(Array.from(new Uint8Array(await blobs[0].arrayBuffer()))).toEqual([
        9, 8, 7,
      ]);
      expect(revoked).toEqual(["blob:ase"]);
      expect(statuses).toEqual(["exported swatches.ase"]);
      expect(fake.mutations()).toEqual([]);
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });
});

describe("the commands that open a surface", () => {
  test("Toggle command palette (paged.palette.toggle) asks the palette to toggle, nothing else", async () => {
    covers("command:paged.palette.toggle");
    paletteCalls.length = 0;
    const r = createCommandRegistry(() => null);
    r.register(PALETTE_TOGGLE_COMMAND);
    await r.invoke("paged.palette.toggle");
    await r.invoke("paged.palette.toggle");
    expect(paletteCalls).toEqual(["toggle", "toggle"]);
    // Ungated (the palette is how you find a command), bound on both platforms.
    expect(PALETTE_TOGGLE_COMMAND.when).toBeUndefined();
    expect([
      PALETTE_TOGGLE_KEYBINDING.key,
      PALETTE_TOGGLE_KEYBINDING_CTRL.key,
    ]).toEqual(["cmd+k", "ctrl+k"]);
  });

  test("Export PDF… (paged.file.exportPdf) opens the dialog, which owns the export loop", async () => {
    covers("command:paged.file.exportPdf");
    exportPdfCalls.length = 0;
    const fake = createFakeShellEditor();
    const r = createCommandRegistry(() => fake.shell);
    r.register(buildExportPdfCommand());
    await r.invoke("paged.file.exportPdf");
    expect(exportPdfCalls).toEqual(["open"]);
    expect(fake.events.filter((e) => e.channel !== "read")).toEqual([]);
  });
});
