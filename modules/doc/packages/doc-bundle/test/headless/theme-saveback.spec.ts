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

// Word-parity W1 on the REAL engine (headless): a themed Word document opens
// with its "Word theme" swatch group (doc ADR 609); File ▸ Export writes a
// zero-edit save part for part as it was, the paragraph style applied on the
// canvas and a Word style modified in paged (doc ADR 610), and does so from
// a saved document reopened in another session.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

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
import { inflateRawSync } from "node:zlib";

import { docBundle } from "../../src";
import { docxPresent, fixture, requireDocx } from "../conformance/harness";

requireDocx("doc headless — theme and save-back");

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const strFromU8 = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A ZIP's entries by name, decompressed (stored or deflated), read from
 *  its central directory. */
function parts(bytes: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = strFromU8(bytes.subarray(at + 46, at + 46 + nameLen));
    const dataAt =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    out[name] = method === 0 ? data : new Uint8Array(inflateRawSync(data));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function part(bytes: Uint8Array, name: string): string {
  const p = parts(bytes)[name];
  if (!p) throw new Error(`no part ${name}`);
  return strFromU8(p);
}

describe.skipIf(!docxPresent)(
  "doc headless — Word theme and save-back (unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh; REQUIRE_REAL_DOCX=1 fails instead)",
  () => {
    let h: HeadlessHost;
    let host: BundleHost;
    let importer: ImporterContribution;
    let exporter: ExporterContribution;
    let dispose: () => void;

    async function start(): Promise<void> {
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      const handle = createBundleHost(
        () => h.host.editor,
        docBundle.manifest as PluginManifest,
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
      const bundle = docBundle.activate(host);
      dispose = () => {
        bundle.dispose();
        handle.dispose();
      };
      importer = h
        .importersContributed()
        .find((c) => c.id === "media.paged.doc.importer.docx")!;
      exporter = h
        .exportersContributed()
        .find((c) => c.id === "media.paged.doc.exporter.docx")!;
    }

    beforeEach(async () => {
      await start();
      await h.newBlank(300, 300);
    }, 60_000);

    afterEach(() => {
      dispose?.();
      h?.dispose();
    });

    async function open(): Promise<void> {
      await importer.import({
        name: "theme-styles.docx",
        bytes: fixture("theme-styles.docx"),
        mimeType: DOCX_MIME,
      });
    }

    /** The body story and each paragraph's [start, end) offsets. */
    async function body(): Promise<{
      storyId: string;
      ranges: Array<[number, number, string]>;
    }> {
      const stories = await host.document.collection<{
        selfId: string;
        characterCount: number;
      }>("stories");
      const story = stories.reduce((a, b) =>
        b.characterCount > a.characterCount ? b : a,
      );
      const c = await host.document.storyContent(story.selfId);
      const ranges: Array<[number, number, string]> = [];
      let at = 0;
      for (const p of c?.paragraphs ?? []) {
        const text = p.runs.map((r) => r.text).join("");
        const n = Array.from(text).length;
        ranges.push([at, at + n, text]);
        at += n;
      }
      return { storyId: story.selfId, ranges };
    }

    it("a themed Word document opens with its Word theme swatch group", async () => {
      covers("importer:media.paged.doc.importer.docx");
      await open();
      const groups = await host.document.collection<{
        selfId: string;
        name: string;
      }>("colorGroups");
      expect(groups.map((g) => g.name)).toContain("Word theme");
      const swatches = await host.document.collection<{
        selfId: string;
        name: string;
      }>("swatches");
      const names = new Map(swatches.map((s) => [s.selfId, s.name]));
      expect(names.get("Color/docx-theme-accent1")).toBe("Accent 1");
      expect(names.get("Color/docx-theme-accent1-tint-99")).toBe(
        "Accent 1, Lighter 40%",
      );
    });

    it("File ▸ Export of an unedited themed document writes every part as it was", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await open();
      const out = await exporter.export();
      expect(out).not.toBeNull();
      const before = parts(fixture("theme-styles.docx"));
      const after = parts(out!.bytes);
      for (const [name, bytes] of Object.entries(before))
        expect(strFromU8(after[name]!)).toBe(strFromU8(bytes));
    });

    async function editAndCheck(): Promise<void> {
      const { storyId, ranges } = await body();
      const bodyText = ranges.find((r) => r[2] === "Body text.")!;
      // The paragraph style applied on the canvas.
      const styled = await host.document.mutate({
        op: "applyStyle",
        args: {
          storyId,
          start: bodyText[0],
          end: bodyText[1],
          style: "ParagraphStyle/docx-Quote",
          scope: "paragraph",
        },
      } as never);
      expect(styled.applied).toBe(true);
      // A Word style modified in paged.
      const sized = await host.document.mutate({
        op: "setStyleProperty",
        args: {
          collection: "paragraph",
          styleId: "ParagraphStyle/docx-Heading1",
          path: "characterFontSize",
          value: { type: "length", value: 20 },
        },
      } as never);
      expect(sized.applied).toBe(true);
      const out = await exporter.export();
      expect(out).not.toBeNull();
      const doc = part(out!.bytes, "word/document.xml");
      expect(doc).toContain(
        '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Body text.</w:t>',
      );
      const styles = part(out!.bytes, "word/styles.xml");
      expect(styles).toContain('<w:sz w:val="40"/>');
      expect(styles).not.toContain('<w:sz w:val="32"/>');
      // The theme references are untouched.
      expect(doc).toContain('w:themeColor="accent1" w:themeTint="99"');
      expect(styles).toContain('w:themeColor="accent1" w:themeShade="BF"');
    }

    it("File ▸ Export writes the paragraph style applied on the canvas and a Word style modified in paged", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await open();
      await editAndCheck();
    });

    it("a saved document reopened in another session still saves back as a splice", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await open();
      const { bytes: saved } = await h.exportDocument("paged");
      dispose();
      h.dispose();
      // Another session: the importing session's record is gone; the label
      // and the stored original .docx part are not.
      await start();
      await h.load(saved);
      await editAndCheck();
      // An unedited part stays as it was.
      const out = await exporter.export();
      expect(part(out!.bytes, "word/theme/theme1.xml")).toBe(
        strFromU8(
          parts(fixture("theme-styles.docx"))["word/theme/theme1.xml"]!,
        ),
      );
    });
  },
);
