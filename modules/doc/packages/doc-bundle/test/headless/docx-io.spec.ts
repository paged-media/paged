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

// File ▸ Open of a .docx and File ▸ Export as .docx on the REAL engine
// (headless): the bundle on a host whose native-document door loads the
// package it produces as the active document (the editor's arrangement).

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
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { docBundle } from "../../src";
import { DocEngine } from "../../src/engine";
import {
  docxPresent,
  fixture,
  requireDocx,
  storyTexts,
} from "../conformance/harness";

requireDocx("doc headless — File ▸ Open and File ▸ Export");

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe.skipIf(!docxPresent)(
  "doc headless — File ▸ Open and File ▸ Export of a .docx (unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh; REQUIRE_REAL_DOCX=1 fails instead)",
  () => {
    let h: HeadlessHost;
    let host: BundleHost;
    let importer: ImporterContribution;
    let exporter: ExporterContribution;
    let dispose: () => void;
    const errors: string[] = [];

    beforeEach(async () => {
      errors.length = 0;
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      const handle = createBundleHost(
        () => h.host.editor,
        docBundle.manifest as PluginManifest,
        {
          console: {
            ...silent,
            error: (...a: unknown[]) => void errors.push(a.join(" ")),
          },
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
      await h.newBlank(300, 300);
    }, 60_000);

    afterEach(() => {
      dispose?.();
      h?.dispose();
    });

    /** Every story's paragraphs, in document order. */
    async function allText(): Promise<string[]> {
      const stories = await h.host.document.collection<{ selfId: string }>(
        "stories",
      );
      const out: string[] = [];
      for (const s of stories) out.push(...(await storyTexts(host, s.selfId)));
      return out;
    }

    it("File ▸ Open of a .docx opens it as its own document: the Word page, its text, a Word document object", async () => {
      covers("importer:media.paged.doc.importer.docx");
      await importer.import({
        name: "merge-letter.docx",
        bytes: fixture("merge-letter.docx"),
        mimeType: DOCX_MIME,
      });
      expect(errors).toEqual([]);
      // The blank page is gone: the document is the Word document.
      const pages = await h.host.document.collection<{
        sizePt?: [number, number];
      }>("pages");
      expect(pages.length).toBeGreaterThanOrEqual(1);
      expect(pages[0]!.sizePt?.map(Math.round)).not.toEqual([300, 300]);
      expect(await allText()).toEqual([
        "Dear «First Name», from «City» and «City», page 1",
        "Order «OrderNo»",
      ]);
      expect(
        await host.objects.query("plugin:media.paged.doc/docxDocument"),
      ).toHaveLength(1);
    });

    it("bytes that are not a Word document open nothing", async () => {
      covers("importer:media.paged.doc.importer.docx");
      const before = await h.host.document.collection("pages");
      await importer
        .import({
          name: "notes.docx",
          bytes: new TextEncoder().encode("not a zip"),
          mimeType: DOCX_MIME,
        })
        .catch(() => undefined);
      expect(await h.host.document.collection("pages")).toEqual(before);
      expect(
        await host.objects.query("plugin:media.paged.doc/docxDocument"),
      ).toEqual([]);
    });

    it("File ▸ Export writes the open Word document as a .docx Word reads, with an edit made since", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await importer.import({
        name: "merge-letter.docx",
        bytes: fixture("merge-letter.docx"),
        mimeType: DOCX_MIME,
      });
      const field = "plugin:media.paged.doc/mergeField/docx_f0/b1/f0";
      expect(await host.objects.set(field, "value", "A-17")).toMatchObject({
        applied: true,
      });
      const out = await exporter.export();
      expect(out).not.toBeNull();
      expect(out!.fileName).toBe("merge-letter.docx");
      expect(new TextDecoder().decode(out!.bytes.subarray(0, 2))).toBe("PK");
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(out!.bytes);
        const text = engine
          .lowered()
          .story.blocks.flatMap((b) =>
            b.kind === "paragraph" ? b.runs.map((r) => r.text) : [],
          )
          .join("");
        expect(text).toContain("A-17");
      } finally {
        engine.dispose();
      }
    });

    it("with no Word document open there is nothing to export", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      expect(await exporter.export()).toBeNull();
    });
  },
);
