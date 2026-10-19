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

// Export mode's side panels (export-views.tsx):
//
//   paged.outputs           the left nav: every output with a readiness dot,
//                           and the plugins' exporters, one click each.
//   paged.export-inspector  the right inspector: the selected output's
//                           settings and its run action (Page images:
//                           resolution, format, quality, pages, range).
//
// The selected output and the image settings are module stores shared
// with the Export Center; each test starts from the defaults. Downloads
// are captured at the anchor click (the file itself is a browser's).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  ExportInspectorPanel,
  OutputsPanel,
} from "../../src/panels/cockpit/export-views";
import {
  setImageSettings,
  setSelectedExportTarget,
} from "../../src/panels/cockpit/export-targets";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  action,
  captureDownloads,
  linksDocument,
  pill,
} from "./support/cockpit";

let capture: ReturnType<typeof captureDownloads>;

beforeEach(() => {
  setSelectedExportTarget("pdf-x4");
  setImageSettings({
    dpi: 72,
    scope: "all",
    format: "png",
    quality: 0.9,
    range: "",
  });
  capture = captureDownloads();
});
afterEach(() => {
  capture.restore();
  unmountAll();
});

type H = PanelHarness<unknown>;

const nav = (h: H, id: string) =>
  h.root.querySelector<HTMLElement>(`[data-output-nav="${id}"]`)!;
const dots = (h: H) =>
  [...h.root.querySelectorAll("[data-output-nav]")].map((r) => [
    r.getAttribute("data-output-nav"),
    r.querySelector("[data-output-dot]")?.getAttribute("data-output-dot"),
  ]);

describe("Outputs nav", () => {
  test("no document: every output's dot is a draft", async () => {
    covers("panel:paged.outputs");
    const h = await mountPanel(OutputsPanel, {
      id: "paged.outputs",
      document: "none",
    });
    expect(dots(h)).toEqual([
      ["pdf-x4", "draft"],
      ["image", "draft"],
      ["web", "draft"],
      ["social", "draft"],
      ["package", "draft"],
    ]);
  });

  test("a document without an output intent: PDF (1.7) and images ready, the seams draft", async () => {
    covers("panel:paged.outputs");
    const h = await mountPanel(OutputsPanel, { id: "paged.outputs" });
    expect(dots(h)).toEqual([
      ["pdf-x4", "ready"],
      ["image", "ready"],
      ["web", "draft"],
      ["social", "draft"],
      ["package", "draft"],
    ]);
  });

  test("clicking an output selects it", async () => {
    covers("panel:paged.outputs");
    const h = await mountPanel(OutputsPanel, { id: "paged.outputs" });
    expect(nav(h, "pdf-x4").hasAttribute("data-selected")).toBe(true);
    await h.click(nav(h, "social"));
    expect(nav(h, "social").hasAttribute("data-selected")).toBe(true);
    expect(nav(h, "pdf-x4").hasAttribute("data-selected")).toBe(false);
    expect(h.mutations()).toEqual([]);
  });

  test("a plugin's exporter runs in one click: its bytes download under its name", async () => {
    covers("panel:paged.outputs");
    const h = await mountPanel(OutputsPanel, { id: "paged.outputs" });
    let calls = 0;
    h.registries.exporters.register({
      id: "test.exporter",
      title: "Plain text",
      extension: ".txt",
      mimeType: "text/plain",
      export: () => {
        calls += 1;
        return { bytes: new TextEncoder().encode("hi"), fileName: "notes.txt" };
      },
    });
    // The nav reads the registry when it renders (see PN-308).
    await h.click(nav(h, "image"));
    const item = h.root.querySelector<HTMLElement>(
      '[data-plugin-export="test.exporter"]',
    )!;
    expect(item.textContent).toBe("Plain text");
    await h.click(item);
    expect(calls).toBe(1);
    expect(capture.downloads.map((d) => d.name)).toEqual(["notes.txt"]);
    expect(item.textContent).toBe("Plain text✓");
  });

  test("an exporter that declines says so", async () => {
    covers("panel:paged.outputs");
    const h = await mountPanel(OutputsPanel, { id: "paged.outputs" });
    h.registries.exporters.register({
      id: "test.decline",
      title: "Nothing",
      extension: ".bin",
      export: () => null,
    });
    await h.click(nav(h, "image"));
    const item = h.root.querySelector<HTMLElement>(
      '[data-plugin-export="test.decline"]',
    )!;
    await h.click(item);
    expect(item.textContent).toBe("Nothing!");
    expect(capture.downloads).toEqual([]);
  });

  // PN-308 (fixed): the nav reads the exporters through a view of the
  // registry that changes with it (ADR 229), so a bundle that registers its
  // exporter after the panel is on screen (bundles load after boot) is
  // listed at once.
  test("PN-308: an exporter registered while the nav is open appears in it", async () => {
    covers("panel:paged.outputs");
    const h = await mountPanel(OutputsPanel, { id: "paged.outputs" });
    await h.act(() =>
      h.registries.exporters.register({
        id: "test.late",
        title: "Late exporter",
        extension: ".txt",
        export: () => null,
      }),
    );
    expect(
      h.root.querySelector('[data-plugin-export="test.late"]'),
    ).not.toBeNull();
  });

  test.failing(
    "PN-307: an output can be chosen with the keyboard",
    async () => {
      covers("panel:paged.outputs");
      const h = await mountPanel(OutputsPanel, { id: "paged.outputs" });
      const target = nav(h, "image");
      expect(
        target.matches(
          "button, a[href], [role=option], [role=tab], [role=radio]",
        ),
      ).toBe(true);
      expect(target.tabIndex).toBeGreaterThanOrEqual(0);
    },
  );
});

describe("Export inspector", () => {
  const mount = (document?: "none" | "blank" | Uint8Array) =>
    mountPanel(ExportInspectorPanel, {
      id: "paged.export-inspector",
      document,
    });
  const settings = (h: H, name: string) =>
    h.root.querySelector<HTMLSelectElement | HTMLInputElement>(
      `[data-export-image-${name}]`,
    );

  test("Print PDF: the readiness, the dialog hand-off, nothing sent here", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount();
    expect(h.root.textContent).toContain("Print PDF");
    // No output intent: the print PDF is PDF 1.7, and it exports (PN-305).
    expect(pill(h.root, "export-inspector-readiness")).toEqual({
      text: "Ready · PDF 1.7",
      tone: "ready",
    });
    const from = h.mark();
    await h.click(action(h.root, "export-inspector-run"));
    expect(h.sent(undefined, from)).toEqual([]);
  });

  test("no document: No document, and nothing can run", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount("none");
    expect(pill(h.root, "export-inspector-readiness")?.text).toBe(
      "No document",
    );
    expect(action(h.root, "export-inspector-run").disabled).toBe(true);
    await h.act(() => setSelectedExportTarget("image"));
    expect(action(h.root, "export-inspector-run-image").disabled).toBe(true);
    expect((settings(h, "dpi") as HTMLSelectElement).disabled).toBe(true);
  });

  test("an honest output: Coming soon and its note, no run action", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount();
    await h.act(() => setSelectedExportTarget("web"));
    expect(pill(h.root, "export-inspector-readiness")?.text).toBe(
      "Coming soon",
    );
    expect(h.root.textContent).toContain(
      "Responsive HTML. This output lands with the multi-format publishing pipeline.",
    );
    expect(h.root.querySelector("[data-cockpit-action]")).toBeNull();
  });

  test("Page images: every setting changes what the run sends", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount(linksDocument());
    await h.act(() => setSelectedExportTarget("image"));
    expect(
      [...(settings(h, "dpi") as HTMLSelectElement).options].map(
        (o) => o.value,
      ),
    ).toEqual(["72", "150", "300"]);
    await h.choose(settings(h, "dpi")!, "150");
    const from = h.mark();
    await h.click(action(h.root, "export-inspector-run-image"));
    expect(h.sent("requestSnapshot", from).map((m) => m.payload)).toEqual([
      { pageId: "cp1", targetWidthPx: 1275, dpi: 150 },
      { pageId: "cp2", targetWidthPx: 1275, dpi: 150 },
    ]);
    expect(h.root.querySelector("[data-export-image-done]")?.textContent).toBe(
      "Exported 2 PNGs.",
    );
    // The settings persist (the next session's export starts from them).
    expect(
      JSON.parse(localStorage.getItem("paged.export.image.v1") ?? "{}").dpi,
    ).toBe(150);
  });

  test("Format JPEG offers a quality; PNG does not", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount();
    await h.act(() => setSelectedExportTarget("image"));
    expect(settings(h, "quality")).toBeNull();
    await h.choose(settings(h, "format")!, "jpeg");
    expect(
      [...(settings(h, "quality") as HTMLSelectElement).options].map(
        (o) => o.value,
      ),
    ).toEqual(["0.6", "0.8", "0.9", "1"]);
    await h.choose(settings(h, "quality")!, "0.6");
    expect(
      JSON.parse(localStorage.getItem("paged.export.image.v1") ?? "{}"),
    ).toMatchObject({ format: "jpeg", quality: 0.6 });
  });

  test("Pages: a range exports only the pages it names", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount(linksDocument());
    await h.act(() => setSelectedExportTarget("image"));
    expect(settings(h, "range")).toBeNull();
    await h.choose(settings(h, "scope")!, "range");
    await h.user.type(settings(h, "range")!, "2");
    await h.settle();
    const from = h.mark();
    await h.click(action(h.root, "export-inspector-run-image"));
    expect(h.sent("requestSnapshot", from).map((m) => m.payload)).toEqual([
      { pageId: "cp2", targetWidthPx: 612, dpi: 72 },
    ]);
    expect(capture.downloads.map((d) => d.name)).toEqual(["document.png"]);
    expect(h.root.querySelector("[data-export-image-done]")?.textContent).toBe(
      "Exported 1 PNG.",
    );
  });

  test("Pages: a range that names no page is refused and says why, nothing renders", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount(linksDocument());
    await h.act(() => setSelectedExportTarget("image"));
    await h.choose(settings(h, "scope")!, "range");
    await h.user.type(settings(h, "range")!, "9-12");
    await h.settle();
    const from = h.mark();
    await h.click(action(h.root, "export-inspector-run-image"));
    expect(h.sent("requestSnapshot", from)).toEqual([]);
    expect(h.root.textContent).toContain(
      'Export failed: "9-12" names no page in this 2-page document.',
    );
  });

  // Finding PN-310 (fixed): "Current page" exports the document's active
  // page when the caller names no index (it was always page 1).
  test("PN-310: Pages ▸ Current page exports the page in view, not page 1", async () => {
    covers("panel:paged.export-inspector");
    const h = await mount(linksDocument());
    await h.act(() => h.client.setActivePage("cp2"));
    expect((await h.client.documentMeta()).activePage).toBe("cp2");
    await h.act(() => setSelectedExportTarget("image"));
    await h.choose(settings(h, "scope")!, "current");
    const from = h.mark();
    await h.click(action(h.root, "export-inspector-run-image"));
    expect(
      h
        .sent("requestSnapshot", from)
        .map((m) => (m.payload as { pageId: string }).pageId),
    ).toEqual(["cp2"]);
  });
});
