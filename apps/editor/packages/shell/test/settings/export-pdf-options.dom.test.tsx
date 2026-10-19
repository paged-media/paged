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

// Setting `paged.exportPdf.options.v1` (chrome/ExportPdfDialog.tsx): the
// Export PDF dialog's last-used options. Read when the dialog mounts
// (merged over the defaults), written on every field change, and what
// the Export button sends to `client.exportPdf`.

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CanvasClient, DocumentHandle } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  ExportPdfDialog,
  notifyExportPdfDialog,
} from "../../src/chrome/ExportPdfDialog";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  DocumentProvider,
  useDocument,
} from "../../src/state/document-context";

const KEY = "paged.exportPdf.options.v1";
const DEFAULTS = {
  standard: "pdfx4",
  outputIntentProfile: "",
  colorPolicy: "preserveNumbers",
  allPages: true,
  pageFrom: "1",
  pageTo: "1",
  useDocumentBleed: true,
  bleedPt: "0",
  cropMarks: false,
  registrationMarks: false,
  colorBars: false,
  downsample: "off",
  bookmarks: false,
  tagged: false,
};

const HANDLE = {
  docId: "doc-1",
  pageIds: ["p1", "p2"],
  pageSizesPt: [
    [612, 792],
    [612, 792],
  ],
} as unknown as DocumentHandle;

function fakeClient() {
  const exports: Record<string, unknown>[] = [];
  const client = {
    subscribe: () => () => {},
    documentMeta: async () => ({
      documentName: "brochure",
      cmykProfileName: null,
      cmykProfileActive: false,
      pageCount: 2,
    }),
    exportPdf: async (options: Record<string, unknown>) => {
      exports.push(options);
      return { bytes: new Uint8Array([37, 80, 68, 70]), diagnostics: [] };
    },
  } as unknown as CanvasClient;
  return { client, exports };
}

function WithDocument({ children }: PropsWithChildren) {
  const { setHandle } = useDocument();
  useEffect(() => setHandle(HANDLE), [setHandle]);
  return <>{children}</>;
}

function mount(client: CanvasClient) {
  const view = render(
    <CanvasClientProvider client={client}>
      <DocumentProvider>
        <WithDocument>
          <ExportPdfDialog />
        </WithDocument>
      </DocumentProvider>
    </CanvasClientProvider>,
  );
  act(() => notifyExportPdfDialog("open"));
  return view;
}

const field = <T extends Element>(selector: string) => {
  const el = document.body.querySelector<T & Element>(selector);
  if (!el) throw new Error(`no ${selector} in the dialog`);
  return el as T;
};
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("setting paged.exportPdf.options.v1", () => {
  test("default: the form opens at the defaults and nothing is written", async () => {
    covers("setting:paged.exportPdf.options.v1");
    mount(fakeClient().client);
    await waitFor(() => field("[data-export-dialog]"));
    expect(field<HTMLSelectElement>("select[data-export-standard]").value).toBe(
      "pdfx4",
    );
    expect(field<HTMLSelectElement>("select[data-export-policy]").value).toBe(
      "preserveNumbers",
    );
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a change is written at once and the next dialog opens with it", async () => {
    covers("setting:paged.exportPdf.options.v1");
    const first = mount(fakeClient().client);
    await waitFor(() => field("[data-export-dialog]"));
    fireEvent.change(field("select[data-export-standard]"), {
      target: { value: "pdf17" },
    });
    // The page range was seeded from the document's page count on open.
    expect(stored()).toEqual({ ...DEFAULTS, standard: "pdf17", pageTo: "2" });
    first.unmount();
    mount(fakeClient().client);
    await waitFor(() => field("[data-export-dialog]"));
    expect(field<HTMLSelectElement>("select[data-export-standard]").value).toBe(
      "pdf17",
    );
  });

  test("the stored options are what Export sends", async () => {
    covers("setting:paged.exportPdf.options.v1");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...DEFAULTS,
        standard: "pdf17",
        cropMarks: true,
        downsample: "150",
        tagged: true,
        useDocumentBleed: false,
        bleedPt: "9",
      }),
    );
    const { client, exports } = fakeClient();
    mount(client);
    const confirm = await waitFor(() => {
      const b = field<HTMLButtonElement>("[data-export-confirm]");
      if (b.disabled) throw new Error("export not ready");
      return b;
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(exports).toHaveLength(1));
    expect(exports[0]).toMatchObject({
      standard: "pdf17",
      cropMarks: true,
      downsamplePpi: 150,
      tagged: true,
      bleedOverridePt: [9, 9, 9, 9],
      pageFrom: null,
      pageTo: null,
      title: "brochure",
    });
  });

  test("an older, partial value is merged over the defaults", async () => {
    covers("setting:paged.exportPdf.options.v1");
    localStorage.setItem(
      KEY,
      JSON.stringify({ colorPolicy: "convertToDestination" }),
    );
    mount(fakeClient().client);
    await waitFor(() => field("[data-export-dialog]"));
    expect(field<HTMLSelectElement>("select[data-export-policy]").value).toBe(
      "convertToDestination",
    );
    expect(field<HTMLSelectElement>("select[data-export-standard]").value).toBe(
      "pdfx4",
    );
  });

  test("an unreadable value falls back to the defaults", async () => {
    covers("setting:paged.exportPdf.options.v1");
    localStorage.setItem(KEY, "{broken");
    mount(fakeClient().client);
    await waitFor(() => field("[data-export-dialog]"));
    expect(field<HTMLSelectElement>("select[data-export-standard]").value).toBe(
      "pdfx4",
    );
  });

  // Finding SH-103: the stored form is spread over the defaults without a
  // check, so a value the dialog never offers survives a load and is
  // exported: `standard: "bogus"` reaches `client.exportPdf` as the PDF
  // standard (the comment above OPTIONS_KEY promises "schema drift falls
  // back to defaults").
  test.failing(
    "SH-103: a stored standard the dialog does not offer falls back to the default",
    async () => {
      covers("setting:paged.exportPdf.options.v1");
      localStorage.setItem(
        KEY,
        JSON.stringify({
          ...DEFAULTS,
          standard: "bogus",
          outputIntentProfile: "x",
        }),
      );
      const { client, exports } = fakeClient();
      mount(client);
      const confirm = await waitFor(() => {
        const b = field<HTMLButtonElement>("[data-export-confirm]");
        if (b.disabled) throw new Error("export not ready");
        return b;
      });
      fireEvent.click(confirm);
      await waitFor(() => expect(exports).toHaveLength(1));
      expect(exports[0].standard).toBe("pdfx4");
    },
  );
});
