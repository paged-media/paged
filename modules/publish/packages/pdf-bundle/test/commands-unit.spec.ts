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

// The PDF bundle's typed command and its importer, UNIT: the bundle on the
// in-process host over a recording fake editor (no engine), with the real
// PDFium and pdf-import wasm under Node. What reaches the door that opens
// the document, which door, when it refuses, and that an open is never an
// edit of the document that was open. The same command on the real engine:
// test/headless/commands.spec.ts.

import { beforeEach, describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";
import {
  createBundleHost,
  type CreateBundleHostOptions,
} from "@paged-media/plugin-sdk";
import { covers, createFakeEditor } from "@paged-media/test-kit";

import manifestJson from "../manifest.json";
import { activate } from "../src/activate";
import { IMPORT_PDF_COMMAND } from "../src/commands";
import { _resetPdfMapperCache } from "../src/engine-loader";
import { tinyPdf } from "./fixtures/tiny-pdf";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const PDF = tinyPdf([["Hello PDF"], ["Page two", "a second line"]]);

/** Every byte array the native-document door was handed. */
function nativeDoor(opened: Uint8Array[], fail = false) {
  return {
    readModel: async () => null,
    readComposition: async () => null,
    listParts: async () => [],
    open: async (bytes: Uint8Array) => {
      if (fail) throw new Error("the engine refused the package");
      opened.push(bytes);
    },
  };
}

function boot(options: Partial<CreateBundleHostOptions> = {}) {
  const logs: string[] = [];
  const fake = createFakeEditor();
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    {
      console: {
        ...silent,
        info: (...a: unknown[]) => void logs.push(`info ${a.join(" ")}`),
        warn: (...a: unknown[]) => void logs.push(`warn ${a.join(" ")}`),
        error: (...a: unknown[]) => void logs.push(`error ${a.join(" ")}`),
      },
      ...options,
    },
  );
  const bundle = activate(handle.host);
  return {
    fake,
    host: handle.host,
    logs,
    importer: () =>
      fake.registered<{
        id: string;
        extensions: string[];
        import(f: {
          name: string;
          bytes: Uint8Array;
          mimeType: string;
        }): Promise<void>;
      }>("importers")[0]!,
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

const isPackage = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

beforeEach(() => _resetPdfMapperCache());

describe("media.paged.pdf.importPdf (unit)", () => {
  it("reconstructs the PDF as an editable package and hands it to the native-document door", async () => {
    covers("command:media.paged.pdf.importPdf");
    const opened: Uint8Array[] = [];
    const b = boot({ nativeDocument: nativeDoor(opened) });
    const out = await b.host.objects.invoke(IMPORT_PDF_COMMAND, {
      bytes: PDF,
    });
    expect(out).toEqual({ mode: "editable", pageCount: 2 });
    expect(opened).toHaveLength(1);
    // A `.paged` container (a ZIP), not the PDF passed through.
    expect(isPackage(opened[0]!)).toBe(true);
    // Opening is not an edit of the open document.
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  }, 60_000);

  it("honours the page cap", async () => {
    covers("command:media.paged.pdf.importPdf");
    const opened: Uint8Array[] = [];
    const b = boot({ nativeDocument: nativeDoor(opened) });
    expect(
      await b.host.objects.invoke(IMPORT_PDF_COMMAND, {
        bytes: PDF,
        maxPages: 1,
      }),
    ).toEqual({ mode: "editable", pageCount: 1 });
    b.dispose();
  }, 60_000);

  it("opens through the documents door when there is no native one, naming the file; a decline is a failure", async () => {
    covers("command:media.paged.pdf.importPdf");
    const asked: Array<string | null> = [];
    let answer = true;
    const b = boot({
      documents: {
        exportPaged: async () => new Uint8Array(),
        open: async (_bytes, request) => {
          asked.push(request.name);
          return answer
            ? { opened: true as const, pageIds: ["p1"] }
            : { opened: false as const, reason: "declined" as const };
        },
      },
    });
    await b.host.objects.invoke(IMPORT_PDF_COMMAND, {
      bytes: PDF,
      name: "a.pdf",
    });
    answer = false;
    await expect(
      b.host.objects.invoke(IMPORT_PDF_COMMAND, { bytes: PDF, name: "b.pdf" }),
    ).rejects.toThrow(/failed: the host declined to open b\.pdf/);
    expect(asked).toEqual(["a.pdf", "b.pdf"]);
    b.dispose();
  }, 60_000);

  it("refuses out-of-range options and a host with no door, opening nothing", async () => {
    covers("command:media.paged.pdf.importPdf");
    const opened: Uint8Array[] = [];
    const b = boot({ nativeDocument: nativeDoor(opened) });
    await expect(
      b.host.objects.invoke(IMPORT_PDF_COMMAND, { bytes: PDF, dpi: 10 }),
    ).rejects.toThrow(/invalidValue/);
    await expect(
      b.host.objects.invoke(IMPORT_PDF_COMMAND, { bytes: PDF, maxPages: 0 }),
    ).rejects.toThrow(/invalidValue/);
    expect(opened).toEqual([]);
    b.dispose();

    const none = boot();
    await expect(
      none.host.objects.invoke(IMPORT_PDF_COMMAND, { bytes: PDF }),
    ).rejects.toThrow(/failed: this host cannot open a document/);
    none.dispose();
  });

  it("the image path needs a canvas: under Node it rejects and opens nothing", async () => {
    covers("command:media.paged.pdf.importPdf");
    const opened: Uint8Array[] = [];
    const b = boot({ nativeDocument: nativeDoor(opened) });
    await expect(
      b.host.objects.invoke(IMPORT_PDF_COMMAND, { bytes: PDF, mode: "image" }),
    ).rejects.toThrow();
    expect(opened).toEqual([]);
    b.dispose();
  }, 60_000);
});

describe("the PDF importer (unit)", () => {
  it("File ▸ Open of a .pdf opens it, editable, through the native-document door", async () => {
    covers("importer:media.paged.pdf.importer.pdf");
    const opened: Uint8Array[] = [];
    const b = boot({ nativeDocument: nativeDoor(opened) });
    const importer = b.importer();
    expect(importer.extensions).toEqual([".pdf"]);
    await importer.import({
      name: "two.pdf",
      bytes: PDF,
      mimeType: "application/pdf",
    });
    expect(opened).toHaveLength(1);
    expect(isPackage(opened[0]!)).toBe(true);
    expect(
      b.logs.some((l) => l.includes("opened two.pdf as an editable document")),
    ).toBe(true);
    b.dispose();
  }, 60_000);

  it("a door that fails is reported, never thrown past the host", async () => {
    covers("importer:media.paged.pdf.importer.pdf");
    const b = boot({ nativeDocument: nativeDoor([], true) });
    await b.importer().import({ name: "x.pdf", bytes: PDF, mimeType: "" });
    expect(
      b.logs.some((l) => l.startsWith("error") && l.includes("x.pdf")),
    ).toBe(true);
    b.dispose();
  }, 60_000);

  it("on a host without the native-document door it opens nothing and says so", async () => {
    covers("importer:media.paged.pdf.importer.pdf");
    const b = boot();
    await b.importer().import({ name: "y.pdf", bytes: PDF, mimeType: "" });
    expect(
      b.logs.some(
        (l) => l.startsWith("warn") && l.includes("document.openNative@1"),
      ),
    ).toBe(true);
    b.dispose();
  });
});
