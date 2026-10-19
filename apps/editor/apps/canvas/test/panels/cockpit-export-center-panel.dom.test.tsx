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

// The Export Center (paged.export-center): Export mode's readiness table.
// LIVE outputs run a real action (Print PDF opens the export dialog; Page
// images render each page through the engine's snapshot and download
// it); HONEST outputs (web, social, package) are visible "soon" seams.
// Row selection is shared with the Outputs nav and the Export inspector.
//
// What only a browser shows is out of reach here: the export dialog that
// Print PDF opens (the chrome's ExportPdfDialog, behind a module-level
// notifier) and the file a download writes. The downloads are captured at
// the anchor click.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { PanelProps } from "@paged-media/shell";

import { ExportCenterPanel } from "../../src/panels/cockpit/export-center-panel";
import { ExportInspectorPanel } from "../../src/panels/cockpit/export-views";
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
  // The selected target and the image settings are module stores shared
  // by the three Export panels (and persisted); start each test from the
  // defaults.
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

const mount = (document?: "none" | "blank" | Uint8Array) =>
  mountPanel(ExportCenterPanel, { id: "paged.export-center", document });

const row = (h: H, id: string) =>
  h.root.querySelector<HTMLElement>(`[data-export-target="${id}"]`)!;

const LIVE = ["pdf-x4", "image"];
const HONEST = ["web", "social", "package"];

describe("Export Center: states", () => {
  test("no document: every live output reads No document and cannot export", async () => {
    covers("panel:paged.export-center");
    const h = await mount("none");
    expect(h.root.textContent).toContain("no document");
    for (const id of LIVE) {
      expect(pill(h.root, `readiness-${id}`)).toEqual({
        text: "No document",
        tone: "draft",
      });
      expect(action(h.root, `export-center-${id}`).disabled).toBe(true);
    }
    expect(action(h.root, "export-selected").disabled).toBe(true);
  });

  test("a document without an output intent: PDF falls back to 1.7, images are ready", async () => {
    covers("panel:paged.export-center");
    const h = await mount();
    expect(h.root.textContent).toContain("2 outputs available");
    expect(pill(h.root, "readiness-pdf-x4")).toEqual({
      text: "PDF 1.7 — no output intent",
      tone: "warn",
    });
    expect(pill(h.root, "readiness-image")).toEqual({
      text: "Ready",
      tone: "ready",
    });
    for (const id of LIVE) {
      expect(action(h.root, `export-center-${id}`).disabled).toBe(false);
    }
  });

  test("the honest outputs are visible seams: soon, and no export button", async () => {
    covers("panel:paged.export-center");
    const h = await mount();
    for (const id of HONEST) {
      expect(row(h, id).hasAttribute("data-export-live")).toBe(false);
      expect(row(h, id).textContent).toContain("soon");
      expect(row(h, id).querySelector("button")).toBeNull();
    }
    expect(action(h.root, "export-fix-issues").disabled).toBe(true);
    expect(action(h.root, "export-save-preset").disabled).toBe(true);
  });
});

describe("Export Center: controls", () => {
  test("choosing a row selects it, and the Export inspector follows", async () => {
    covers("panel:paged.export-center");
    // The centre table and the right inspector, as Export mode shows them.
    function ExportMode(props: PanelProps) {
      return (
        <>
          <ExportCenterPanel />
          <ExportInspectorPanel {...props} />
        </>
      );
    }
    const h = await mountPanel(ExportMode, { id: "paged.export-center" });
    expect(row(h, "pdf-x4").hasAttribute("data-selected")).toBe(true);
    await h.click(row(h, "image"));
    expect(row(h, "image").hasAttribute("data-selected")).toBe(true);
    expect(row(h, "pdf-x4").hasAttribute("data-selected")).toBe(false);
    expect(
      h.root.querySelector("[data-export-inspector-panel]")?.textContent,
    ).toContain("Page images (PNG)");
  });

  test("Page images ▸ Export… renders every page through the engine and downloads one PNG each", async () => {
    covers("panel:paged.export-center");
    const h = await mount(linksDocument());
    const from = h.mark();
    await h.click(action(h.root, "export-center-image"));
    expect(h.sent("requestSnapshot", from).map((m) => m.payload)).toEqual([
      { pageId: "cp1", targetWidthPx: 612, dpi: 72 },
      { pageId: "cp2", targetWidthPx: 612, dpi: 72 },
    ]);
    expect(capture.downloads.map((d) => d.name)).toEqual([
      "document-p1.png",
      "document-p2.png",
    ]);
    expect(action(h.root, "export-center-image").textContent).toBe("Export…");
  });

  test("Export selected runs the selected live output", async () => {
    covers("panel:paged.export-center");
    const h = await mount();
    await h.click(row(h, "image"));
    const from = h.mark();
    await h.click(action(h.root, "export-selected"));
    expect(h.sent("requestSnapshot", from)).toHaveLength(1);
    expect(capture.downloads.map((d) => d.name)).toEqual(["document.png"]);
  });

  test("a selected seam cannot be exported", async () => {
    covers("panel:paged.export-center");
    const h = await mount();
    await h.click(row(h, "web"));
    expect(row(h, "web").hasAttribute("data-selected")).toBe(true);
    expect(action(h.root, "export-selected").disabled).toBe(true);
  });

  test("Print PDF ▸ Export… hands over to the export dialog: nothing is sent or downloaded here", async () => {
    covers("panel:paged.export-center");
    const h = await mount();
    const from = h.mark();
    await h.click(action(h.root, "export-center-pdf-x4"));
    expect(h.sent(undefined, from)).toEqual([]);
    expect(capture.downloads).toEqual([]);
  });
});

describe("Export Center: findings", () => {
  // UX audit F-11: every new document fails the default PDF standard. The
  // Export Center's one PDF output is the X-4 target, and on a document
  // with no output intent it warns; Export… opens the dialog on X-4.
  test.failing(
    "PN-305 (UX F-11): a new document's PDF output is one it can meet (ready, not a warning)",
    async () => {
      covers("panel:paged.export-center");
      const h = await mount();
      expect(pill(h.root, "readiness-pdf-x4")?.tone).toBe("ready");
    },
  );

  // Each output row is a div with a click handler: no role, no tab stop.
  test.failing(
    "PN-306: an output can be chosen with the keyboard",
    async () => {
      covers("panel:paged.export-center");
      const h = await mount();
      const target = row(h, "image");
      expect(
        target.matches("button, [role=option], [role=row], [role=radio]"),
      ).toBe(true);
      expect(target.tabIndex).toBeGreaterThanOrEqual(0);
    },
  );

  // "Publish every format from one place": the Outputs nav lists the
  // plugins' exporters (paged.publish's IDML among them), the Export
  // Center's table lists only its five built-in outputs.
  test.failing(
    "PN-309: the Export Center lists the plugins' exporters too",
    async () => {
      covers("panel:paged.export-center");
      const h = await mount();
      h.registries.exporters.register({
        id: "test.exporter.idml",
        title: "IDML package",
        extension: ".idml",
        export: () => null,
      });
      // Re-render the table (selection is a store it reads).
      await h.click(row(h, "image"));
      expect(h.root.textContent).toContain("IDML package");
    },
  );
});
