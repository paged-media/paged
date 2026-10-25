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

// Doc ADR 616 on the REAL engine (headless): File ▸ Open of a Word
// template, a macro-enabled document, RTF, OpenDocument (behind its flag)
// and a binary .doc; File ▸ Export as .docx of a document that did not come
// from Word.

import { afterEach, describe, expect, it } from "bun:test";
import { inflateRawSync } from "node:zlib";

import type {
  BundleHost,
  ExporterContribution,
  ImporterContribution,
  PluginManifest,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { docBundle, docBundleWith, type DocBundleOptions } from "../../src";
import { DocEngine } from "../../src/engine";
import {
  ENGINE_ANCHOR,
  docxPresent,
  fixture,
  requireDocx,
  storyTexts,
} from "../conformance/harness";

requireDocx("doc headless — files (doc ADR 616)");

/** One entry of a zip archive, inflated (the test reads packages back). */
function zipEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let k = 0; k < count; k++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (entry === name) {
      const lName = view.getUint16(local + 26, true);
      const lExtra = view.getUint16(local + 28, true);
      const start = local + 30 + lName + lExtra;
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : new Uint8Array(inflateRawSync(data));
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : "");

describe.skipIf(!docxPresent)(
  "doc headless — the files paged.doc opens and writes (unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh; REQUIRE_REAL_DOCX=1 fails instead)",
  () => {
    let h: HeadlessHost;
    let host: BundleHost;
    let dispose: () => void = () => {};

    async function start(options?: DocBundleOptions): Promise<void> {
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      const bundle = options ? docBundleWith(options) : docBundle;
      const handle = createBundleHost(
        () => h.host.editor,
        bundle.manifest as PluginManifest,
        {
          console: silent,
          nativeDocument: {
            readModel: async () => null,
            readComposition: async () => null,
            listParts: async () => [],
            open: async (bytes) => {
              await h.load(bytes);
            },
          },
        },
      );
      host = handle.host;
      const active = bundle.activate(host);
      dispose = () => {
        active.dispose();
        handle.dispose();
      };
      await h.newBlank(300, 300);
    }

    const importer = (id = "media.paged.doc.importer.docx") =>
      h.importersContributed().find((c) => c.id === id) as
        ImporterContribution | undefined;
    const exporter = () =>
      h
        .exportersContributed()
        .find(
          (c) => c.id === "media.paged.doc.exporter.docx",
        ) as ExporterContribution;

    async function allText(): Promise<string[]> {
      const stories = await h.host.document.collection<{ selfId: string }>(
        "stories",
      );
      const out: string[] = [];
      for (const s of stories) out.push(...(await storyTexts(host, s.selfId)));
      return out;
    }

    afterEach(() => {
      dispose();
      h?.dispose();
    });

    it("a Word template opens as a new untitled document that saves as a .docx, the template untouched", async () => {
      covers("importer:media.paged.doc.importer.docx");
      await start();
      await importer()!.import({
        name: "template-letter.dotx",
        bytes: fixture("template-letter.dotx"),
        mimeType: "",
      });
      expect((await allText())[0]).toBe("Quarterly letter");
      const notes = host.diagnostics.get("media.paged.doc/file") ?? [];
      expect(notes.map((d) => d.message).join(" ")).toContain(
        "template template-letter.dotx",
      );
      const out = await exporter().export();
      expect(out!.fileName).toBe("Untitled.docx");
      const types = text(zipEntry(out!.bytes, "[Content_Types].xml"));
      expect(types).toContain("wordprocessingml.document.main+xml");
      expect(types).not.toContain("template.main+xml");
    }, 60_000);

    it("a .docm keeps its VBA project byte for byte through an edit and says the macros never run", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await start();
      const source = fixture("macro-letter.docm");
      await importer()!.import({
        name: "macro-letter.docm",
        bytes: source,
        mimeType: "",
      });
      const notes = (host.diagnostics.get("media.paged.doc/file") ?? []).map(
        (d) => d.message,
      );
      expect(notes.join(" ")).toContain("never runs them");
      const story = (
        await h.host.document.collection<{ selfId: string }>("stories")
      )[0]!;
      const edit = await host.document.mutate({
        op: "insertText",
        args: { storyId: story.selfId, offset: 0, text: "New: ", cell: null },
      } as never);
      expect(edit.applied).toBe(true);
      const out = await exporter().export();
      expect(out!.fileName).toBe("macro-letter.docm");
      expect(zipEntry(out!.bytes, "word/vbaProject.bin")).toEqual(
        zipEntry(source, "word/vbaProject.bin"),
      );
      expect(text(zipEntry(out!.bytes, "[Content_Types].xml"))).toContain(
        "macroEnabled.main+xml",
      );
      expect(text(zipEntry(out!.bytes, "word/document.xml"))).toContain(
        "New: ",
      );
    }, 60_000);

    it("an RTF file opens as a Word document with its heading style and saves as a .docx", async () => {
      covers("importer:media.paged.doc.importer.docx");
      await start();
      await importer()!.import({
        name: "memo.rtf",
        bytes: fixture("memo.rtf"),
        mimeType: "text/rtf",
      });
      expect(await allText()).toEqual([
        "Memo",
        "Please read this today.",
        "Second paragraph.",
      ]);
      const out = await exporter().export();
      expect(out!.fileName).toBe("memo.docx");
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(out!.bytes);
        const first = engine.lowered().story.blocks[0];
        expect(first?.kind).toBe("paragraph");
      } finally {
        engine.dispose();
      }
    }, 60_000);

    it("OpenDocument text opens only behind its flag", async () => {
      await start();
      expect(importer("media.paged.doc.importer.odt")).toBeUndefined();
      dispose();
      h.dispose();
      await start({ odt: true });
      covers("importer:media.paged.doc.importer.odt");
      await importer("media.paged.doc.importer.odt")!.import({
        name: "minutes.odt",
        bytes: fixture("minutes.odt"),
        mimeType: "",
      });
      expect(await allText()).toEqual([
        "Minutes",
        "First point.",
        "Second point.",
      ]);
      expect((await exporter().export())!.fileName).toBe("minutes.docx");
    }, 60_000);

    it("a binary .doc is refused with what to do, and the open document stays", async () => {
      covers("importer:media.paged.doc.importer.docx");
      await start();
      const before = await h.host.document.collection("pages");
      let error = "";
      await importer()!
        .import({
          name: "legacy.doc",
          bytes: fixture("legacy.doc"),
          mimeType: "application/msword",
        })
        .catch((e: unknown) => {
          error = String(e);
        });
      expect(error).toContain("save it as a Word Document (.docx)");
      expect(await h.host.document.collection("pages")).toEqual(before);
      const notes = host.diagnostics.get("media.paged.doc/file") ?? [];
      expect(notes[0]?.severity).toBe("error");
    }, 60_000);

    it("a document not from Word saves as a .docx that reads back to the same paragraphs", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await start();
      const page = (
        await h.host.document.collection<{ selfId: string }>("pages")
      )[0]!;
      const frame = await host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: page.selfId, bounds: [20, 20, 200, 280] },
      } as never);
      expect(frame.applied).toBe(true);
      const story = (
        await h.host.document.collection<{ selfId: string }>("stories")
      )[0]!;
      const typed = await host.document.mutate({
        op: "insertText",
        args: {
          storyId: story.selfId,
          offset: 0,
          text: "Native heading\nBody text.",
          cell: null,
        },
      } as never);
      expect(typed.applied).toBe(true);
      const out = await exporter().export();
      expect(out).not.toBeNull();
      expect(out!.fileName).toBe("document.docx");
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(out!.bytes);
        const paragraphs = engine
          .lowered()
          .story.blocks.flatMap((b) =>
            b.kind === "paragraph" ? [b.runs.map((r) => r.text).join("")] : [],
          );
        expect(paragraphs).toEqual(await storyTexts(host, story.selfId));
      } finally {
        engine.dispose();
      }
      // And the typed twin answers the same.
      const typedOut = (await host.objects.invoke(
        "media.paged.doc.command.saveAsDocx",
        {},
      )) as { fileName: string };
      expect(typedOut.fileName).toBe("document.docx");
    }, 60_000);

    it("pasted RTF lands at the caret with its paragraphs", async () => {
      covers("command:media.paged.doc.command.pasteRtf");
      await start();
      await importer()!.import({
        name: "memo.rtf",
        bytes: fixture("memo.rtf"),
        mimeType: "",
      });
      const caret = host.text.caret();
      if (!caret) {
        // A headless host without a caret reader refuses honestly.
        await expect(
          host.objects.invoke("media.paged.doc.command.pasteRtf", {
            rtf: "{\\rtf1 Pasted\\par}",
          }),
        ).rejects.toThrow("unavailable");
        return;
      }
      const out = (await host.objects.invoke(
        "media.paged.doc.command.pasteRtf",
        {
          rtf: "{\\rtf1 Pasted\\par}",
        },
      )) as { paragraphs: number };
      expect(out.paragraphs).toBe(1);
      expect((await allText()).join("\n")).toContain("Pasted");
    }, 60_000);
  },
);
