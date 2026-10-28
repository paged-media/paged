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

// Editor ADR 2XX — the Asset Export panel (paged.object-export) over the
// real engine: assets collected from the selection, the pages and a
// Layers-panel drop; the export settings; and files the engine really
// wrote (PNG through the snapshot, JPEG / WebP / TIFF through paged-raster,
// SVG through paged-svg), delivered as one ZIP or one download each.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { AssetExportPanel } from "../../src/panels/asset-export-panel";
import {
  PAGED_ELEMENTS_MIME,
  assetExportStoreOf,
} from "../../src/asset-export/model";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

/** What the app's download door received (Blob → object URL → anchor). */
let downloads: Array<{ name: string; type: string; bytes: Uint8Array }> = [];
let restore: (() => void) | null = null;
const pending: Promise<void>[] = [];

beforeEach(() => {
  downloads = [];
  const blobs = new Map<string, Blob>();
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  let n = 0;
  URL.createObjectURL = (b: Blob) => {
    const url = `blob:test/${n++}`;
    blobs.set(url, b);
    return url;
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (!blob) return;
    const name = this.download;
    pending.push(
      blob.arrayBuffer().then((buf) => {
        downloads.push({ name, type: blob.type, bytes: new Uint8Array(buf) });
      }),
    );
  };
  restore = () => {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    HTMLAnchorElement.prototype.click = click;
  };
});

const delivered = async () => {
  await Promise.all(pending.splice(0));
  return downloads;
};

afterEach(() => {
  restore?.();
  unmountAll();
});

const mount = () =>
  mountPanel(AssetExportPanel, {
    id: "paged.object-export",
    scene: richScene,
  });

const q = (h: PanelHarness<RichScene>, sel: string) =>
  h.root.querySelector<HTMLElement>(sel);
const rows = (h: PanelHarness<RichScene>) => [
  ...h.root.querySelectorAll<HTMLElement>("[data-asset-row]"),
];
const state = (h: PanelHarness<RichScene>) => assetExportStoreOf(h.scope).get();

/** Wait for the panel's export to finish (the progress line goes away). */
async function exported(h: PanelHarness<RichScene>) {
  for (let i = 0; i < 400 && q(h, "[data-asset-progress]"); i++) {
    await h.settle();
    await new Promise((r) => setTimeout(r, 10));
  }
  await h.settle();
  return delivered();
}

const sig = (b: Uint8Array, n = 4) => [...b.subarray(0, n)];

describe("Asset Export panel [editor-shell.panels.asset-export]", () => {
  test("empty: says how to collect; nothing to export", async () => {
    covers("panel:paged.object-export");
    const h = await mount();
    expect(q(h, '[data-asset-export-panel="ready"]')).not.toBe(null);
    expect(q(h, "[data-asset-empty]")).not.toBe(null);
    expect(
      (q(h, "[data-asset-export-all]") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("Add selection collects the item; a PNG at 1x and a JPEG at 2x come from the engine", async () => {
    covers("panel:paged.object-export");
    const h = await mount();
    // An unpainted frame draws nothing: give it a fill.
    await h.client.mutate({
      op: "set",
      args: {
        address: `rectangle:${String(h.scene.rect.id)}`,
        path: "frameFillColor",
        value: { type: "colorRef", value: h.scene.red },
      },
    } as never);
    await h.select([h.scene.rect]);
    await h.click(
      h.view.getByLabelText("Add selection (one asset per object)"),
    );
    expect(rows(h)).toHaveLength(1);
    expect(rows(h)[0]!.dataset.assetKind).toBe("object");
    // A second row: 2x, JPEG.
    await h.click(q(h, "[data-asset-add-scale]")!);
    const second = state(h).settings[1]!;
    await h.act(() =>
      assetExportStoreOf(h.scope).set({
        ...state(h),
        settings: [
          state(h).settings[0]!,
          { ...second, scale: 2, suffix: "@2x", format: "jpeg" },
        ],
        zip: false,
      }),
    );
    expect(q(h, "[data-asset-quality]")).not.toBe(null);
    const from = h.mark();
    await h.click(q(h, "[data-asset-export-all]")!);
    const files = await exported(h);
    expect(files.map((f) => f.type)).toEqual(["image/png", "image/jpeg"]);
    expect(files[0]!.name).toMatch(/\.png$/);
    expect(files[1]!.name).toMatch(/@2x\.jpg$/);
    expect(sig(files[0]!.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(sig(files[1]!.bytes, 3)).toEqual([0xff, 0xd8, 0xff]);
    // The engine drew the item alone, trimmed, at 72 and 144 ppi.
    const snaps = h.sent("requestSnapshot", from).map(
      (m) =>
        m.payload as {
          dpi: number;
          only: unknown[];
          trim: boolean;
          format?: string;
        },
    );
    expect(
      snaps.map((s) => [s.dpi, s.only, s.trim, s.format ?? "png"]),
    ).toEqual([
      [72, [h.scene.rect], true, "png"],
      [144, [h.scene.rect], true, "jpeg"],
    ]);
    // Read-only: an export changes nothing.
    expect(h.mutations(from)).toEqual([]);
    expect(q(h, "[data-asset-status-message]")!.textContent).toBe(
      "Exported 2 files.",
    );
  });

  test("pages: WebP, TIFF and SVG of every page go out as one ZIP", async () => {
    covers("panel:paged.object-export");
    const h = await mount();
    await h.click(h.view.getByLabelText("Add all artboards and pages"));
    const pages = rows(h);
    expect(pages.length).toBe(h.handle!.pageIds.length);
    expect(pages.every((r) => r.dataset.assetKind === "page")).toBe(true);
    await h.act(() =>
      assetExportStoreOf(h.scope).set({
        ...state(h),
        settings: [
          { id: "w", scale: 0.5, suffix: "", format: "webp" },
          { id: "t", scale: 0.5, suffix: "", format: "tiff" },
          { id: "v", scale: 1, suffix: "", format: "svg" },
        ],
      }),
    );
    expect(q(h, "[data-asset-vector-note]")).not.toBe(null);
    await h.click(q(h, "[data-asset-export-all]")!);
    const files = await exported(h);
    expect(files).toHaveLength(1);
    expect(files[0]!.type).toBe("application/zip");
    expect(files[0]!.name).toMatch(/-assets\.zip$/);
    const zip = files[0]!.bytes;
    expect(sig(zip)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder("latin1").decode(zip);
    for (const ext of [".webp", ".tif", ".svg"]) expect(text).toContain(ext);
    expect(text).toContain("RIFF");
    expect(text).toContain("<svg");
  });

  test("a Layers-panel row dropped on the list is collected; rows select, rename and remove", async () => {
    covers("panel:paged.object-export");
    const h = await mount();
    const list = q(h, "[data-asset-list]")!;
    const data = {
      types: [PAGED_ELEMENTS_MIME],
      getData: (t: string) =>
        t === PAGED_ELEMENTS_MIME ? JSON.stringify([h.scene.rect]) : "",
    };
    await act(async () => {
      fireEvent.dragOver(list, { dataTransfer: data });
    });
    expect(list.dataset.dropActive).toBe("true");
    await act(async () => {
      fireEvent.drop(list, { dataTransfer: data });
    });
    await h.settle();
    await h.settle();
    expect(rows(h)).toHaveLength(1);
    const row = rows(h)[0]!;
    expect(row.dataset.selected).toBe("true");
    const name = row.querySelector<HTMLInputElement>("[data-asset-name]")!;
    await h.user.clear(name);
    await h.user.type(name, "Badge{Enter}");
    await h.settle();
    expect(state(h).assets[0]!.name).toBe("Badge");
    await h.click(h.view.getByLabelText("Remove selected assets"));
    expect(rows(h)).toHaveLength(0);
  });
});
