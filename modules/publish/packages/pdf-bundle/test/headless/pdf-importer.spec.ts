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

// File ▸ Open of a .pdf on the REAL engine (headless): the importer the
// editor routes a PDF to, on a host whose native-document door loads the
// package it produces as the active document (the editor's arrangement).
// The PDF is built in code (test/fixtures/tiny-pdf.ts): real text in the
// standard Helvetica, so the editable reconstruction has words to find.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { fileURLToPath } from "node:url";

import type {
  ImporterContribution,
  PluginManifest,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  createHeadlessHost,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import manifestJson from "../../manifest.json";
import { activate } from "../../src/activate";
import { _resetPdfMapperCache } from "../../src/engine-loader";
import { PDF_IMPORTER_ID } from "../../src/io/pdf";
import { tinyPdf } from "../fixtures/tiny-pdf";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let h: HeadlessHost;
let importer: ImporterContribution;
const errors: string[] = [];
let dispose: () => void;

/** The content (paragraphs and runs) of every story in the open
 *  document, as the engine answers it. */
async function storyText(): Promise<string> {
  const stories = await h.host.document.collection<{ selfId: string }>(
    "stories",
  );
  const out: string[] = [];
  for (const s of stories) {
    const r = await h.host.editor.client.send({
      kind: "requestStoryContent",
      payload: { storyId: s.selfId },
    });
    if (r.kind === "storyContentResult")
      out.push(JSON.stringify(r.payload.content ?? null));
  }
  return out.join("\n");
}

beforeAll(async () => {
  h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR, console: silent });
  const handle = createBundleHost(
    () => h.host.editor,
    manifestJson as PluginManifest,
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
  const bundle = activate(handle.host);
  dispose = () => {
    bundle.dispose();
    handle.dispose();
  };
  importer = h.importersContributed().find((c) => c.id === PDF_IMPORTER_ID)!;
}, 60_000);

beforeEach(() => _resetPdfMapperCache());

afterAll(() => {
  dispose?.();
  h?.dispose();
});

describe("the PDF importer on the real engine", () => {
  it("opens a PDF as an editable document: a page per PDF page, its text in stories", async () => {
    covers("importer:media.paged.pdf.importer.pdf");
    await h.newBlank(200, 200);
    await importer.import({
      name: "letter.pdf",
      bytes: tinyPdf([["Hello PDF"], ["Second page"]]),
      mimeType: "application/pdf",
    });
    expect(errors).toEqual([]);
    const pages = await h.host.document.collection<{
      sizePt?: [number, number];
    }>("pages");
    expect(pages).toHaveLength(2);
    // US Letter, as the PDF's MediaBox says.
    expect(pages[0]!.sizePt?.map(Math.round)).toEqual([612, 792]);
    const text = await storyText();
    expect(text).toContain("Hello PDF");
    expect(text).toContain("Second page");
  }, 60_000);

  it("bytes that are not a PDF leave the open document alone, and say so", async () => {
    covers("importer:media.paged.pdf.importer.pdf");
    const before = await h.host.document.collection("pages");
    await importer.import({
      name: "not.pdf",
      bytes: new TextEncoder().encode("not a pdf at all"),
      mimeType: "application/pdf",
    });
    expect(await h.host.document.collection("pages")).toEqual(before);
    expect(errors.some((e) => e.includes("not.pdf"))).toBe(true);
  }, 60_000);
});
