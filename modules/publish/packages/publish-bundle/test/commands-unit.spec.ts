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

// The publish bundle's typed commands and its IDML exporter, UNIT: the
// bundle activated on the in-process host over a recording fake editor (no
// engine). What each command SENDS to the engine, in what order, what it
// makes of the replies, when it refuses, and that it never mutates the
// document (an export or an open is not an undo step). The same commands on
// the real engine: test/headless/commands.spec.ts.

import { describe, expect, it } from "bun:test";

import type {
  MainToWorkerKind,
  PluginManifest,
  WorkerToMain,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  type CreateBundleHostOptions,
} from "@paged-media/plugin-sdk";
import {
  covers,
  createFakeEditor,
  type FakeEditor,
} from "@paged-media/test-kit";

import manifestJson from "../manifest.json";
import { activate } from "../src/activate";
import {
  EXPORT_IDML_COMMAND,
  EXPORT_PAGED_COMMAND,
  EXPORT_PDF_COMMAND,
  IMPORT_IDML_COMMAND,
  pdfExportArgs,
  type ExportResult,
} from "../src/commands";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

type Reply = { kind: string; payload?: unknown };

/** The bundle on a fake editor whose engine replies `reply` scripts. */
function boot(
  reply: (m: MainToWorkerKind) => Reply | undefined,
  options: Partial<CreateBundleHostOptions> = {},
) {
  const logs: string[] = [];
  const fake = createFakeEditor({
    documentMeta: { documentName: "Brochure.idml" },
    collections: {
      pages: [
        { selfId: "p1", sizePt: [612, 792] },
        { selfId: "p2", sizePt: [612, 792] },
      ],
    },
    reply: (m) => reply(m) as WorkerToMain | undefined,
  });
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    {
      console: {
        ...silent,
        warn: (...a: unknown[]) => void logs.push(`warn ${a.join(" ")}`),
        error: (...a: unknown[]) => void logs.push(`error ${a.join(" ")}`),
        info: (...a: unknown[]) => void logs.push(`info ${a.join(" ")}`),
      },
      ...options,
    },
  );
  const bundle = activate(handle.host);
  return {
    fake,
    host: handle.host,
    logs,
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

/** The engine messages the bundle sent, by kind, in order. */
const sent = (fake: FakeEditor): string[] =>
  fake.ofChannel("send").map((e) => e.message.kind);

/** A fake PDF session: `pages` pages, then `pdfExported`. */
function pdfEngine(pages: number, failPage = -1) {
  let page = 0;
  return (m: MainToWorkerKind): Reply | undefined => {
    if (m.kind === "exportPdfBegin")
      return {
        kind: "exportPdfBegun",
        payload: { session: 7, pageCount: pages },
      };
    if (m.kind === "exportPdfPage") {
      const i = page++;
      return i === failPage
        ? { kind: "exportPdfFailed", payload: { error: "page boom" } }
        : {
            kind: "exportPdfProgress",
            payload: { session: 7, done: i + 1, total: pages },
          };
    }
    if (m.kind === "exportPdfFinish")
      return {
        kind: "pdfExported",
        payload: {
          pdfBytes: [0x25, 0x50, 0x44, 0x46, 0x2d],
          diagnostics: ["image downsampled", "overset text on page 2"],
          findings: [
            {
              severity: "warning",
              code: "overset",
              message: "overset text on page 2",
              pageIndex: 1,
            },
          ],
        },
      };
    if (m.kind === "exportPdfCancel")
      return { kind: "exportPdfCancelled", payload: { session: 7 } };
    return undefined;
  };
}

describe("media.paged.publish.exportPdf (unit)", () => {
  it("runs one engine session — begin, a page per page, finish — and answers the ExportResult", async () => {
    covers("command:media.paged.publish.exportPdf");
    const b = boot(pdfEngine(2));
    const out = (await b.host.objects.invoke(
      EXPORT_PDF_COMMAND,
      pdfExportArgs({ pages: "1-2", title: "Brochure" }),
    )) as ExportResult;
    expect(sent(b.fake)).toEqual([
      "exportPdfBegin",
      "exportPdfPage",
      "exportPdfPage",
      "exportPdfFinish",
    ]);
    const begin = b.fake.ofChannel("send")[0]!.message as Extract<
      MainToWorkerKind,
      { kind: "exportPdfBegin" }
    >;
    // The 1-based range reaches the engine 0-based, the title as given.
    expect(begin.payload.options).toMatchObject({
      standard: "pdf17",
      pageFrom: 0,
      pageTo: 1,
      title: "Brochure",
    });
    expect(Array.from(out.bytes)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    // Named after the document, its own extension dropped.
    expect(out.fileName).toBe("Brochure.pdf");
    expect(out.mimeType).toBe("application/pdf");
    expect(out.pageCount).toBe(2);
    // A finding keeps its page (1-based); the flat line repeating it is not
    // reported twice, the line it does not repeat is kept as info.
    expect(out.diagnostics).toEqual([
      {
        severity: "warning",
        code: "overset",
        message: "overset text on page 2",
        page: 2,
      },
      { severity: "info", code: "pdf", message: "image downsampled", page: 0 },
    ]);
    // An export is not an edit: no mutation, nothing on the undo stack.
    expect(b.fake.mutations()).toEqual([]);
    expect(b.fake.undoDepth()).toBe(0);
    b.dispose();
  });

  it("cancels the engine session when a page fails, and rejects", async () => {
    covers("command:media.paged.publish.exportPdf");
    const b = boot(pdfEngine(3, 1));
    await expect(
      b.host.objects.invoke(EXPORT_PDF_COMMAND, pdfExportArgs()),
    ).rejects.toThrow(/failed: page boom/);
    expect(sent(b.fake)).toEqual([
      "exportPdfBegin",
      "exportPdfPage",
      "exportPdfPage",
      "exportPdfCancel",
    ]);
    b.dispose();
  });

  it("refuses PDF/X-4 without an output intent before the engine is asked anything", async () => {
    covers("command:media.paged.publish.exportPdf");
    const b = boot(pdfEngine(1));
    await expect(
      b.host.objects.invoke(
        EXPORT_PDF_COMMAND,
        pdfExportArgs({ standard: "pdfx4" }),
      ),
    ).rejects.toThrow(/invalidValue: pdfx4 needs an outputIntentProfile/);
    expect(sent(b.fake)).toEqual([]);
    b.dispose();
  });

  it("reports the engine's refusal to begin as a failure", async () => {
    covers("command:media.paged.publish.exportPdf");
    const b = boot((m) =>
      m.kind === "exportPdfBegin"
        ? { kind: "exportPdfFailed", payload: { error: "no document" } }
        : undefined,
    );
    await expect(b.host.objects.invoke(EXPORT_PDF_COMMAND, {})).rejects.toThrow(
      /failed: no document/,
    );
    expect(sent(b.fake)).toEqual(["exportPdfBegin"]);
    b.dispose();
  });
});

const idmlEngine =
  (lost: string[] = []) =>
  (m: MainToWorkerKind): Reply | undefined =>
    m.kind === "exportIdml"
      ? {
          kind: "idmlExported",
          payload: { idmlBytes: [0x50, 0x4b, 3, 4], lost },
        }
      : undefined;

describe("media.paged.publish.exportIdml (unit)", () => {
  it("asks the engine's writer, passes the link base, and reports every loss as a warning", async () => {
    covers("command:media.paged.publish.exportIdml");
    const b = boot(idmlEngine(["a footnote's custom numbering"]));
    const out = (await b.host.objects.invoke(EXPORT_IDML_COMMAND, {
      linkBase: "links/",
    })) as ExportResult;
    const msg = b.fake.ofChannel("send")[0]!.message as Extract<
      MainToWorkerKind,
      { kind: "exportIdml" }
    >;
    expect(msg.payload).toEqual({ linkBase: "links/" });
    expect(Array.from(out.bytes)).toEqual([0x50, 0x4b, 3, 4]);
    expect(out.fileName).toBe("Brochure.idml");
    expect(out.pageCount).toBe(2);
    expect(out.diagnostics).toEqual([
      {
        severity: "warning",
        code: "idml.lost",
        message: "a footnote's custom numbering",
        page: 0,
      },
    ]);
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });

  it("sends no link base when none is given, and rejects the engine's failure", async () => {
    covers("command:media.paged.publish.exportIdml");
    const b = boot((m) =>
      m.kind === "exportIdml"
        ? { kind: "exportIdmlFailed", payload: { error: "writer refused" } }
        : undefined,
    );
    await expect(
      b.host.objects.invoke(EXPORT_IDML_COMMAND, {}),
    ).rejects.toThrow(/failed: writer refused/);
    const msg = b.fake.ofChannel("send")[0]!.message as Extract<
      MainToWorkerKind,
      { kind: "exportIdml" }
    >;
    expect(msg.payload).toEqual({ linkBase: null });
    b.dispose();
  });
});

describe("media.paged.publish.exportPaged (unit)", () => {
  it("serialises through the documents door when the host has one, and sends nothing to the engine", async () => {
    covers("command:media.paged.publish.exportPaged");
    const exported: string[] = [];
    const b = boot(() => undefined, {
      documents: {
        exportPaged: async () => {
          exported.push("exportPaged");
          return new Uint8Array([0x50, 0x4b, 9]);
        },
        open: async () => ({ opened: true, pageIds: ["p1"] }),
      },
    });
    const out = (await b.host.objects.invoke(
      EXPORT_PAGED_COMMAND,
      {},
    )) as ExportResult;
    expect(exported).toEqual(["exportPaged"]);
    expect(Array.from(out.bytes)).toEqual([0x50, 0x4b, 9]);
    expect(out.fileName).toBe("Brochure.paged");
    expect(out.mimeType).toBe("application/zip");
    expect(sent(b.fake)).toEqual([]);
    b.dispose();
  });

  it("falls back to the engine's exportPaged without the door, and rejects its failure", async () => {
    covers("command:media.paged.publish.exportPaged");
    const ok = boot((m) =>
      m.kind === "exportPaged"
        ? { kind: "pagedExported", payload: { bytes: [0x50, 0x4b] } }
        : undefined,
    );
    const out = (await ok.host.objects.invoke(
      EXPORT_PAGED_COMMAND,
      {},
    )) as ExportResult;
    expect(sent(ok.fake)).toEqual(["exportPaged"]);
    expect(Array.from(out.bytes)).toEqual([0x50, 0x4b]);
    ok.dispose();

    const bad = boot((m) =>
      m.kind === "exportPaged"
        ? { kind: "pagedPartFailed", payload: { error: "no container" } }
        : undefined,
    );
    await expect(
      bad.host.objects.invoke(EXPORT_PAGED_COMMAND, {}),
    ).rejects.toThrow(/failed: no container/);
    bad.dispose();
  });
});

describe("media.paged.publish.importIdml (unit)", () => {
  const BYTES = new Uint8Array([0x50, 0x4b, 1, 2]);

  it("opens through the native-document door when the host has one", async () => {
    covers("command:media.paged.publish.importIdml");
    const opened: number[][] = [];
    const b = boot(() => undefined, {
      nativeDocument: {
        readModel: async () => null,
        readComposition: async () => null,
        listParts: async () => [],
        open: async (bytes) => void opened.push(Array.from(bytes)),
      },
    });
    const out = (await b.host.objects.invoke(IMPORT_IDML_COMMAND, {
      bytes: BYTES,
      name: "brochure.idml",
    })) as { pages: string[] };
    expect(opened).toEqual([[0x50, 0x4b, 1, 2]]);
    // The pages of the document now open, as object-model addresses.
    expect(out.pages).toEqual(["page:p1", "page:p2"]);
    b.dispose();
  });

  it("opens through the documents door otherwise, naming the file, and fails when the user keeps their document", async () => {
    covers("command:media.paged.publish.importIdml");
    const asked: Array<string | null> = [];
    let answer = true;
    const b = boot(() => undefined, {
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
    await b.host.objects.invoke(IMPORT_IDML_COMMAND, {
      bytes: BYTES,
      name: "a.idml",
    });
    answer = false;
    await expect(
      b.host.objects.invoke(IMPORT_IDML_COMMAND, {
        bytes: BYTES,
        name: "b.idml",
      }),
    ).rejects.toThrow(/failed: the host declined to open b\.idml/);
    expect(asked).toEqual(["a.idml", "b.idml"]);
    b.dispose();
  });

  it("refuses on a host with neither door", async () => {
    covers("command:media.paged.publish.importIdml");
    const b = boot(() => undefined);
    await expect(
      b.host.objects.invoke(IMPORT_IDML_COMMAND, { bytes: BYTES }),
    ).rejects.toThrow(/failed: this host cannot open a document/);
    b.dispose();
  });
});

describe("the IDML exporter and importer (unit)", () => {
  it("the exporter answers the typed command's bytes and file name, and logs each loss", async () => {
    covers("exporter:media.paged.publish.exporter.idml");
    const b = boot(idmlEngine(["a lost thing"]));
    const [exporter] = b.fake.registered<{
      id: string;
      export(): Promise<{ bytes: Uint8Array; fileName: string } | null>;
    }>("exporters");
    expect(exporter!.id).toBe("media.paged.publish.exporter.idml");
    const r = await exporter!.export();
    expect(r!.fileName).toBe("Brochure.idml");
    expect(Array.from(r!.bytes)).toEqual([0x50, 0x4b, 3, 4]);
    expect(b.logs.some((l) => l.includes("a lost thing"))).toBe(true);
    b.dispose();
  });

  it("the exporter answers null (nothing to save) when the engine fails, and says why", async () => {
    covers("exporter:media.paged.publish.exporter.idml");
    const b = boot((m) =>
      m.kind === "exportIdml"
        ? { kind: "exportIdmlFailed", payload: { error: "writer refused" } }
        : undefined,
    );
    const [exporter] = b.fake.registered<{
      export(): Promise<unknown>;
    }>("exporters");
    expect(await exporter!.export()).toBeNull();
    expect(
      b.logs.some((l) => l.startsWith("error") && l.includes("writer refused")),
    ).toBe(true);
    b.dispose();
  });

  it("the importer hands the file's bytes to the native-document door, and never throws past the host", async () => {
    covers("importer:media.paged.publish.importer.idml");
    const opened: number[][] = [];
    let fail = false;
    const b = boot(() => undefined, {
      nativeDocument: {
        readModel: async () => null,
        readComposition: async () => null,
        listParts: async () => [],
        open: async (bytes) => {
          if (fail) throw new Error("not an IDML package");
          opened.push(Array.from(bytes));
        },
      },
    });
    const [importer] = b.fake.registered<{
      extensions: string[];
      import(f: {
        name: string;
        bytes: Uint8Array;
        mimeType: string;
      }): Promise<void>;
    }>("importers");
    expect(importer!.extensions).toEqual([".idml"]);
    await importer!.import({
      name: "a.idml",
      bytes: new Uint8Array([1, 2]),
      mimeType: "",
    });
    expect(opened).toEqual([[1, 2]]);
    fail = true;
    await importer!.import({
      name: "b.idml",
      bytes: new Uint8Array([3]),
      mimeType: "",
    });
    expect(
      b.logs.some((l) => l.startsWith("error") && l.includes("b.idml")),
    ).toBe(true);
    b.dispose();
  });

  it("the importer opens nothing on a host without the native-document door, and says so", async () => {
    covers("importer:media.paged.publish.importer.idml");
    const b = boot(() => undefined);
    const [importer] = b.fake.registered<{
      import(f: {
        name: string;
        bytes: Uint8Array;
        mimeType: string;
      }): Promise<void>;
    }>("importers");
    await importer!.import({
      name: "c.idml",
      bytes: new Uint8Array([1]),
      mimeType: "",
    });
    expect(
      b.logs.some(
        (l) => l.startsWith("warn") && l.includes("document.openNative@1"),
      ),
    ).toBe(true);
    b.dispose();
  });
});
