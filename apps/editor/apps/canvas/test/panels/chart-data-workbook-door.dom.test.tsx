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

// Extensions ADR 1102, slide ADR 724 amendment 1: a chart's data edited on
// paged.sheet's grid, end to end through the editor's broker. The editor's
// host options share ONE workbook editor registry; paged.sheet's host
// offers its editor there (the bundle's own contribution, the real engine);
// paged.slide's host opens a workbook through `host.workbooks` and mounts
// the editor's surface in its chart data sheet (the slide's frame). A cell
// typed in the sheet's grid comes back to slide as XLSX bytes, and the
// bytes open again with the new value. Unedited, slide gets its own bytes.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type {
  BundleHost,
  FrameSurfaceProps,
  PluginManifest,
  WorkbookEditSession,
} from "@paged-media/plugin-api";
import { createBundleHost } from "@paged-media/plugin-sdk";
import { createFakeEditor } from "@paged-media/plugin-sdk/gesture-kit";
import { contributeWorkbookEditor, sheetBundle } from "@paged-media/sheet";
import { makeChartDataSurface, slideBundle } from "@paged-media/slide";

import {
  createEditorHostOptions,
  hostOptionsForPlugin,
  type EditorHostOptionDeps,
} from "../../src/plugin-host-options";

const ROOT = new URL("../../../../../../", import.meta.url);
const SHEET_WASM = fileURLToPath(
  new URL("modules/sheet/packages/sheet-bundle/bin/sheet_js_bg.wasm", ROOT),
);
const XLSX = fileURLToPath(
  new URL("modules/sheet/corpus/xlsx-corpus/01-minimal.xlsx", ROOT),
);
// The editor tests build the module wasm; locally a checkout without it
// skips.
const built = existsSync(SHEET_WASM) || process.env.CI === "true";

afterEach(() => cleanup());

// Under happy-dom the sheet engine takes its browser boot, which fetches
// the wasm by the asset URL Bun resolves to a file path: answer that fetch
// from the disk (no wasm media type, so the glue instantiates the bytes).
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    typeof input === "string" && input.endsWith(".wasm")
      ? new Response(readFileSync(input))
      : realFetch(input, init)) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** The editor's shared host options, with only what the door needs. */
function editorHosts(): { sheet: BundleHost; slide: BundleHost } {
  const deps = {
    getEditor: () => null,
    panels: {},
    enterEditContext: () => false,
    workerResolvers: {},
    moduleManifest: { modules: {} },
    origin: "http://localhost",
    pages: {},
  } as unknown as EditorHostOptionDeps;
  const { shared } = createEditorHostOptions(deps);
  const fake = createFakeEditor();
  const host = (manifest: PluginManifest) =>
    createBundleHost(
      () => fake.editor,
      manifest,
      hostOptionsForPlugin(shared, manifest.id),
    ).host;
  return {
    sheet: host(sheetBundle.manifest),
    slide: host(slideBundle.manifest),
  };
}

function frameProps(): FrameSurfaceProps {
  return {
    elementId: "u1",
    widthPt: 480,
    heightPt: 320,
    pxPerPt: 1,
    presentation: "frame",
    frameBoxPt: { widthPt: 480, heightPt: 320 },
    toContentPt: () => null,
    requestPresentation: () => {},
    exit: () => {},
  };
}

/** Slide's chart data sheet over an open session. */
function mountChartSheet(session: WorkbookEditSession) {
  const Surface = makeChartDataSurface(
    {
      session: () => session,
      problem: () => null,
      subscribe: () => () => {},
    },
    () => false,
  );
  return render(<Surface {...frameProps()} />);
}

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 20)));

describe.skipIf(!built)("the workbook door in the editor", () => {
  it("slide edits a workbook on paged.sheet's grid and gets the bytes back", async () => {
    const { sheet, slide } = editorHosts();
    expect(slide.supports("workbooks@1")).toBe(true);
    expect(slide.workbooks.available()).toBe(false);
    contributeWorkbookEditor(sheet);
    expect(slide.workbooks.available()).toBe(true);

    const xlsx = new Uint8Array(readFileSync(XLSX));
    const session = await slide.workbooks.open({
      xlsx,
      name: "chart1.xlsx",
      ranges: [
        {
          sheet: "Sheet1",
          startRow: 1,
          startCol: 1,
          endRow: 1,
          endCol: 1,
          role: "value",
        },
      ],
    });
    expect(session.editor).toBe("media.paged.sheet.workbookEditor");
    const view = mountChartSheet(session);
    await settle();
    // Slide's frame around the sheet's grid, with slide's range tinted.
    const frame = view.container.querySelector("[data-slide-chart-surface]")!;
    const svg = frame.querySelector("[data-grid-svg-root]") as SVGElement;
    expect(svg).not.toBeNull();
    const tint = frame.querySelector("[data-grid-ranges] rect")!;
    expect(tint).not.toBeNull();
    expect(session.changed()).toBe(false);
    expect(session.xlsx()).toBe(xlsx);

    // Double-click B2 (the tinted cell) and type into it.
    const x = Number(tint.getAttribute("x")) + 4;
    const y = Number(tint.getAttribute("y")) + 4;
    fireEvent.doubleClick(svg, { clientX: x, clientY: y });
    await settle();
    const input = frame.querySelector("[data-grid-editor]") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "9.25" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    expect(session.changed()).toBe(true);
    const edited = session.xlsx();
    expect(edited).not.toBe(xlsx);
    view.unmount();
    session.close();

    // The bytes open again, with the value.
    const again = await slide.workbooks.open({ xlsx: edited });
    const view2 = mountChartSheet(again);
    await settle();
    const html = view2.container.querySelector(
      "[data-grid-svg-root]",
    )!.innerHTML;
    expect(html).toContain(">9.25</text>");
    view2.unmount();
    again.close();
  });
});
