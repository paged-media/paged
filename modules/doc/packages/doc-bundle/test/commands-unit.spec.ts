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

// The doc bundle's commands, UNIT: the bundle on the in-process host over a
// recording fake editor (no engine; the docx wasm is real). "Insert Word
// document…" (the palette command): no picker, a cancelled pick, a picked
// file placed as a text frame inside the Word page's margins, the outline
// panel raised. The typed commands: placeDoc places the bytes it is given;
// exportDocx and fillMergeFields refuse an address that is not a placed
// Word document, with the document untouched. The same commands on the real
// engine: test/headless/object-model.spec.ts.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import type { Mutation, PluginManifest } from "@paged-media/plugin-api";
import {
  createBundleHost,
  type CreateBundleHostOptions,
  type ShellBackend,
} from "@paged-media/plugin-sdk";
import { covers, createFakeEditor, waitFor } from "@paged-media/test-kit";

import { docBundle } from "../src";
import { docxPresent, requireDocx } from "./conformance/harness";

const LETTER = new Uint8Array(
  readFileSync(new URL("./fixtures/merge-letter.docx", import.meta.url)),
);
const PANEL = "media.paged.doc.panel.outline";
const PLACE = "media.paged.doc.command.placeDoc";

requireDocx("doc unit — the commands");
/** The reason the docx-engine tests skip without the wasm (REQUIRE_REAL_DOCX=1 fails instead). */
const NEEDS_DOCX =
  "(unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh)";

/** A shell whose picker answers `picked`, recording what it is asked. */
function shell(picked: Array<{ name: string; bytes: Uint8Array }>) {
  const opened: string[] = [];
  const asked: unknown[] = [];
  const backend = {
    openPanel: (id: string) => void opened.push(id),
    closePanel: () => {},
    pickFile: async (options?: unknown) => {
      asked.push(options);
      return picked.map((p) => ({ ...p, mimeType: "" }));
    },
  } as unknown as ShellBackend;
  return { backend, opened, asked };
}

function boot(options: Partial<CreateBundleHostOptions> = {}) {
  const logs: string[] = [];
  const fake = createFakeEditor();
  const handle = createBundleHost(
    () => fake.editor,
    docBundle.manifest as PluginManifest,
    {
      console: {
        debug() {},
        info() {},
        warn: (...a: unknown[]) => void logs.push(a.join(" ")),
        error: (...a: unknown[]) => void logs.push(a.join(" ")),
      },
      ...options,
    },
  );
  const bundle = docBundle.activate(handle.host);
  const command = () =>
    fake
      .registered<{
        id: string;
        handler: (p: unknown) => unknown;
      }>("commands")
      .find((c) => c.id === PLACE)!;
  return {
    fake,
    host: handle.host,
    logs,
    command,
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

/** The first mutation: the text frame a placement starts with. */
function frameOf(fake: ReturnType<typeof createFakeEditor>) {
  const [first] = fake.mutations();
  expect(first?.op).toBe("insertTextFrame");
  return (first as Extract<Mutation, { op: "insertTextFrame" }>).args;
}

describe("media.paged.doc.command.placeDoc — the palette command (unit)", () => {
  const itDocx = it.skipIf(!docxPresent);
  itDocx(
    `asks the picker for a Word file and places it as a text frame inside the page's margins, then raises the outline ${NEEDS_DOCX}`,
    async () => {
      covers("command:media.paged.doc.command.placeDoc");
      const s = shell([{ name: "letter.docx", bytes: LETTER }]);
      const b = boot({ shell: s.backend });
      // The command answers at once; the placement runs after the pick.
      await b.command().handler(undefined);
      await waitFor(() => expect(s.opened).toContain(PANEL), {
        timeout: 4_000,
      });
      expect(s.asked).toEqual([{ accept: [".docx", ".dotx"] }]);
      const args = frameOf(b.fake);
      expect(args.pageId).toBe("page-1");
      // [top, left, bottom, right] inside the Word page: positive margins.
      const [top, left, bottom, right] = args.bounds as number[];
      expect(top).toBeGreaterThan(0);
      expect(left).toBeGreaterThan(0);
      expect(bottom).toBeGreaterThan(top!);
      expect(right).toBeGreaterThan(left!);
      expect(s.opened).toContain(PANEL);
      b.dispose();
    },
  );

  it("does nothing when the pick is cancelled", async () => {
    covers("command:media.paged.doc.command.placeDoc");
    const s = shell([]);
    const b = boot({ shell: s.backend });
    await b.command().handler(undefined);
    await b.fake.settle();
    expect(s.asked).toHaveLength(1);
    expect(b.fake.mutations()).toEqual([]);
    expect(s.opened).toEqual([]);
    b.dispose();
  });

  it("on a host without a file picker places nothing and says why", async () => {
    covers("command:media.paged.doc.command.placeDoc");
    const b = boot();
    await b.command().handler(undefined);
    await b.fake.settle();
    expect(b.fake.mutations()).toEqual([]);
    expect(b.logs.some((l) => l.includes("cannot pick files"))).toBe(true);
    b.dispose();
  });

  itDocx(
    `a file that is not a Word document is reported and places nothing ${NEEDS_DOCX}`,
    async () => {
      covers("command:media.paged.doc.command.placeDoc");
      const s = shell([
        { name: "notes.docx", bytes: new TextEncoder().encode("not a zip") },
      ]);
      const b = boot({ shell: s.backend });
      await b.command().handler(undefined);
      await waitFor(
        () =>
          expect(
            b.logs.some((l) => l.includes("could not insert notes.docx")),
          ).toBe(true),
        { timeout: 20_000 },
      );
      expect(b.fake.mutations()).toEqual([]);
      // The panel opens to show the notice.
      expect(s.opened).toContain(PANEL);
      b.dispose();
    },
  );
});

describe("the typed commands (unit)", () => {
  it.skipIf(!docxPresent)(
    `placeDoc places the bytes it is given, starting with the frame ${NEEDS_DOCX}`,
    async () => {
      covers("command:media.paged.doc.command.placeDoc");
      const b = boot();
      const out = (await b.host.objects.invoke(PLACE, {
        bytes: LETTER,
        fileName: "letter.docx",
      })) as { document: string; frame: string };
      frameOf(b.fake);
      expect(out.document).toMatch(/^plugin:media\.paged\.doc\/docxDocument\//);
      b.dispose();
    },
  );

  it("exportDocx refuses an address that is not a placed Word document", async () => {
    covers("command:media.paged.doc.command.exportDocx");
    const b = boot();
    await expect(
      b.host.objects.invoke("media.paged.doc.command.exportDocx", {
        document: "plugin:media.paged.doc/docxDocument/nope",
      }),
    ).rejects.toThrow(/invalidValue: .* is not a placed Word document/);
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });

  it("fillMergeFields refuses an address that is not a placed Word document, writing nothing", async () => {
    covers("command:media.paged.doc.command.fillMergeFields");
    const b = boot();
    await expect(
      b.host.objects.invoke("media.paged.doc.command.fillMergeFields", {
        document: "plugin:media.paged.doc/docxDocument/nope",
        values: { City: "London" },
      }),
    ).rejects.toThrow(/invalidValue/);
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });
});
