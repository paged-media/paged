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

// File ▸ Export PDF… as a guided flow (editor ADR 1221; UX audit F-12;
// UXI-FIL-004, UXI-FIL-005, UXI-FBK-004): the readiness check refuses an
// impossible standard before anything starts and names the fix, warnings
// come from the document's own collections, the preview states the
// file's facts, the controls are the kit's, the progress names its stage
// and Cancel says nothing changed; presets set the options.

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
import { detachedEditorScope } from "../../src/state/editor-scope";
import { operationFeedbackOf } from "../../src/state/operation-feedback";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  DocumentProvider,
  useDocument,
} from "../../src/state/document-context";

const HANDLE = {
  docId: "doc-1",
  pageIds: ["p1", "p2"],
  pageSizesPt: [
    [612, 792],
    [612, 792],
  ],
} as unknown as DocumentHandle;

interface Fake {
  client: CanvasClient;
  exports: Record<string, unknown>[];
  progress?: (done: number, total: number) => void;
  release?: () => void;
}

function fakeClient(over: Partial<Record<string, unknown>> = {}): Fake {
  const fake: Fake = { client: null as never, exports: [] };
  const collections: Record<string, unknown[]> = {
    pages: [
      {
        selfId: "p1",
        index: 0,
        sizePt: [612, 792],
        bleedTopPt: 9,
        bleedLeftPt: 9,
        bleedBottomPt: 9,
        bleedRightPt: 9,
      },
      { selfId: "p2", index: 1, sizePt: [612, 792] },
    ],
    fonts: [
      { family: "Plex", referenceCount: 3 },
      { family: "Gone", referenceCount: 1, isMissing: true },
    ],
    links: [
      {
        hostSelfId: "r1",
        hostKind: "Rectangle",
        uri: "a.jpg",
        status: "missing",
      },
      {
        hostSelfId: "r2",
        hostKind: "Rectangle",
        uri: "b.jpg",
        status: "ok",
        effectivePpi: 90,
      },
    ],
  };
  fake.client = {
    subscribe: () => () => {},
    onSaved: () => () => {},
    collection: async (name: string) => collections[name] ?? [],
    documentStats: async () => ({ overset_stories: 1 }),
    documentMeta: async () => ({
      documentName: "brochure",
      cmykProfileName: null,
      cmykProfileActive: false,
      pageCount: 2,
      activePage: "p2",
    }),
    exportPdf: async (
      options: Record<string, unknown>,
      hooks: {
        onProgress?: (d: number, t: number) => void;
        signal?: AbortSignal;
      },
    ) => {
      fake.exports.push(options);
      hooks.onProgress?.(0, 2);
      hooks.onProgress?.(1, 2);
      // Hold at page 1 of 2 until the test releases or cancels.
      await new Promise<void>((resolve, reject) => {
        fake.release = resolve;
        hooks.signal?.addEventListener("abort", () =>
          reject(new DOMException("export cancelled", "AbortError")),
        );
      });
      hooks.onProgress?.(2, 2);
      return {
        bytes: new TextEncoder().encode("%PDF-1.7\n"),
        diagnostics: [],
        findings: [],
      };
    },
    ...over,
  } as unknown as CanvasClient;
  return fake;
}

function WithDocument({ children }: PropsWithChildren) {
  const { setHandle } = useDocument();
  useEffect(() => setHandle(HANDLE), [setHandle]);
  return <>{children}</>;
}

function mount(client: CanvasClient) {
  render(
    <CanvasClientProvider client={client}>
      <DocumentProvider>
        <WithDocument>
          <ExportPdfDialog />
        </WithDocument>
      </DocumentProvider>
    </CanvasClientProvider>,
  );
  act(() => notifyExportPdfDialog(detachedEditorScope(), "open"));
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T & Element>(selector) as T | null;
const check = (id: string) => q(`[data-export-check="${id}"]`);
const fact = (id: string) =>
  q(`[data-export-fact="${id}"] dd`)?.textContent ?? null;
const confirm = () => q<HTMLButtonElement>("[data-export-confirm]")!;

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("guided export: the readiness check (UXI-FIL-004, ADR 238)", () => {
  test("UXI-T68 — PDF/X-4 without an output intent is refused before anything starts, with its reason and its fix @feat:the-renderer.pdf-export @level:edge", async () => {
    covers("command:paged.file.exportPdf");
    const fake = fakeClient();
    mount(fake.client);
    await waitFor(() => expect(check("standard")).not.toBeNull());
    fireEvent.change(q("select[data-export-standard]")!, {
      target: { value: "pdfx4" },
    });
    const blocker = check("standard")!;
    expect(blocker.getAttribute("data-export-check-level")).toBe("blocker");
    expect(blocker.textContent).toContain(
      "PDF/X-4 needs an output intent profile and this document has none",
    );
    expect(
      blocker
        .querySelector("[data-export-check-fix]")
        ?.getAttribute("data-export-check-fix"),
    ).toBe("paged.color-settings");
    expect(confirm().disabled).toBe(true);
    expect(q("[data-export-summary]")!.textContent).toBe(
      "1 problem blocks the export",
    );
    fireEvent.click(confirm());
    expect(fake.exports).toEqual([]);
  });

  test("the document's own issues are warnings: missing fonts and links, low resolution, overset", async () => {
    covers("command:paged.file.exportPdf");
    mount(fakeClient().client);
    await waitFor(() => expect(check("overset")).not.toBeNull());
    for (const id of ["fonts", "links", "resolution", "overset"])
      expect(check(id)!.getAttribute("data-export-check-level")).toBe(
        "warning",
      );
    expect(check("fonts")!.textContent).toContain(
      "1 font is missing: text set in it is embedded in a substitute font.",
    );
    expect(q("[data-export-summary]")!.textContent).toBe("Ready · 4 warnings");
    expect(confirm().disabled).toBe(false);
  });

  test("a page range outside the document blocks; the page in view is a scope of its own", async () => {
    covers("command:paged.file.exportPdf");
    mount(fakeClient().client);
    await waitFor(() => expect(fact("pages")).toBe("all 2 pages"));
    fireEvent.click(q('[data-export-page-scope-option="range"]')!);
    fireEvent.change(q("[data-export-page-to]")!, { target: { value: "9" } });
    expect(check("range")!.getAttribute("data-export-check-level")).toBe(
      "blocker",
    );
    expect(confirm().disabled).toBe(true);
    fireEvent.click(q('[data-export-page-scope-option="current"]')!);
    expect(check("range")).toBeNull();
    expect(fact("pages")).toBe("page 2");
  });
});

describe("guided export: the preview facts", () => {
  test("pages, size, bleed, colour, fonts, transparency, images, destination", async () => {
    covers("command:paged.file.exportPdf");
    mount(fakeClient().client);
    await waitFor(() =>
      expect(fact("fonts")).toBe(
        "2 families embedded as subsets · 1 substituted",
      ),
    );
    expect(fact("size")).toBe("612 × 792 pt (215.9 × 279.4 mm)");
    expect(fact("bleed")).toBe("9 pt on every side");
    expect(fact("color")).toBe(
      "PDF 1.7 · no output intent · colour numbers kept",
    );
    expect(fact("transparency")).toBe("Kept live, not flattened");
    expect(fact("images")).toBe("Placed images pass through unchanged");
    expect(fact("destination")).toBe("Download: brochure.pdf");
  });
});

describe("guided export: kit controls and presets (UX audit F-12)", () => {
  test("every checkbox is the kit's; the selects are kit selects", async () => {
    covers("command:paged.file.exportPdf");
    mount(fakeClient().client);
    await waitFor(() => expect(q("[data-export-dialog]")).not.toBeNull());
    const boxes = [
      ...document.body.querySelectorAll<HTMLInputElement>(
        '[data-export-dialog] input[type="checkbox"]',
      ),
    ];
    expect(boxes.length).toBeGreaterThanOrEqual(8);
    expect(boxes.every((b) => b.hasAttribute("data-kit-checkbox"))).toBe(true);
    for (const select of document.body.querySelectorAll<HTMLSelectElement>(
      "[data-export-dialog] select",
    ))
      expect(select.className).toContain("appearance-none");
  });

  test("a built-in preset sets its options; a saved preset is stored and offered", async () => {
    covers("setting:paged.exportPdf.presets.v1");
    mount(fakeClient().client);
    await waitFor(() => expect(q("[data-export-preset]")).not.toBeNull());
    fireEvent.change(q("select[data-export-preset]")!, {
      target: { value: "builtin:screen" },
    });
    expect(q<HTMLSelectElement>("select[data-export-downsample]")!.value).toBe(
      "150",
    );
    expect(fact("images")).toBe("Downsampled to 150 ppi where finer");
    fireEvent.click(q("[data-export-preset-save]")!);
    fireEvent.change(q("[data-export-preset-name]")!, {
      target: { value: "Web proof" },
    });
    fireEvent.click(q("[data-export-preset-confirm]")!);
    const stored = JSON.parse(
      localStorage.getItem("paged.exportPdf.presets.v1") ?? "[]",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("Web proof");
    expect(stored[0].fields.downsample).toBe("150");
    expect(stored[0].fields.pageScope).toBeUndefined();
    expect(
      [...q<HTMLSelectElement>("select[data-export-preset]")!.options].map(
        (o) => o.textContent,
      ),
    ).toContain("Web proof");
  });
});

describe("guided export: stages, Cancel and the result (UXI-FBK-004, UXI-FIL-005)", () => {
  test("the stage is named and only the page stage carries a measure; Cancel says nothing changed", async () => {
    covers("command:paged.file.exportPdf");
    const fake = fakeClient();
    mount(fake.client);
    await waitFor(() => expect(confirm().disabled).toBe(false));
    fireEvent.click(confirm());
    const progress = await waitFor(() => {
      const el = q("[data-export-progress]");
      if (!el) throw new Error("no progress yet");
      return el;
    });
    expect(progress.getAttribute("data-export-stage")).toBe("pages");
    expect(progress.textContent).toContain("Writing page 1 of 2…");
    expect(
      progress
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("1");
    fireEvent.click(q("[data-export-cancel]")!);
    const canceled = await waitFor(() => {
      const el = q("[data-export-canceled]");
      if (!el) throw new Error("not canceled yet");
      return el;
    });
    expect(canceled.textContent).toBe(
      "Export brochure.pdf canceled. Nothing changed.",
    );
    expect(q("[data-export-dialog]")).not.toBeNull();
  });

  test("a finished export reports the file, its pages and where it went", async () => {
    covers("command:paged.file.exportPdf");
    const fake = fakeClient();
    mount(fake.client);
    await waitFor(() => expect(confirm().disabled).toBe(false));
    fireEvent.click(confirm());
    await waitFor(() => expect(fake.release).toBeDefined());
    await act(async () => fake.release!());
    await waitFor(() => expect(q("[data-export-dialog]")).toBeNull());
    const toast = operationFeedbackOf(detachedEditorScope())
      .snapshot()
      .toasts.find((x) => x.key === "paged.export.pdf");
    expect(toast?.text.headline).toBe(
      "Exported brochure.pdf · 2 pages · in your downloads",
    );
  });
});
