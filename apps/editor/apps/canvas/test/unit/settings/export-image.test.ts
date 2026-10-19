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

// Setting `paged.export.image.v1` (panels/cockpit/export-targets.ts): the
// image output's DPI, page scope, range, format and JPEG quality. Read
// once when the module loads (a page load), merged over the defaults, and
// written back on every change; `runImageExport` is where a value takes
// effect (snapshot width, which pages, which extension).

import { afterEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { memoryStorage, type MemoryStorage } from "./memory-storage";

type ExportTargets =
  typeof import("../../../src/panels/cockpit/export-targets");
type ImageSettings =
  import("../../../src/panels/cockpit/export-targets").ImageSettings;

const KEY = "paged.export.image.v1";
const DEFAULTS = {
  dpi: 150,
  scope: "all",
  range: "",
  format: "png",
  quality: 0.9,
};

let loads = 0;
/** Evaluate the module afresh over `storage`: what a page load does. */
async function load(storage: MemoryStorage): Promise<ExportTargets> {
  stubGlobal("localStorage", storage);
  loads++;
  return import(`../../../src/panels/cockpit/export-targets.ts?load=${loads}`);
}

/** The settings the module holds now. `setImageSettings({})` writes the
 *  current value through unchanged, which is the one reader that needs
 *  no React. */
function current(mod: ExportTargets, storage: MemoryStorage): ImageSettings {
  mod.setImageSettings({});
  return JSON.parse(storage.getItem(KEY)!) as ImageSettings;
}

afterEach(() => unstubAllGlobals());

/** A client whose snapshots record the width asked for. */
function snapshotClient() {
  const widths: number[] = [];
  return {
    widths,
    client: {
      async requestSnapshot(pageId: string, widthPx: number) {
        widths.push(widthPx);
        return { pageId, pngBytes: [137, 80, 78, 71], widthPx, heightPx: 1 };
      },
    } as never,
  };
}

describe("setting paged.export.image.v1", () => {
  test("default: nothing stored → 150 dpi, every page, PNG, quality 0.9", async () => {
    covers("setting:paged.export.image.v1");
    const ls = memoryStorage();
    const mod = await load(ls);
    expect(current(mod, ls)).toEqual(DEFAULTS);
  });

  test("a change persists and the next page load reads it back", async () => {
    covers("setting:paged.export.image.v1");
    const ls = memoryStorage();
    const first = await load(ls);
    first.setImageSettings({ dpi: 300, format: "jpeg" });
    expect(JSON.parse(ls.getItem(KEY)!)).toEqual({
      ...DEFAULTS,
      dpi: 300,
      format: "jpeg",
    });
    const second = await load(ls);
    expect(current(second, ls)).toEqual({
      ...DEFAULTS,
      dpi: 300,
      format: "jpeg",
    });
  });

  test("an older, partial value is merged over the defaults", async () => {
    covers("setting:paged.export.image.v1");
    const ls = memoryStorage({ [KEY]: JSON.stringify({ dpi: 72 }) });
    expect(current(await load(ls), ls)).toEqual({ ...DEFAULTS, dpi: 72 });
  });

  test("an unreadable value falls back to the defaults", async () => {
    covers("setting:paged.export.image.v1");
    const ls = memoryStorage({ [KEY]: "{broken" });
    expect(current(await load(ls), ls)).toEqual(DEFAULTS);
  });

  test("the effect: DPI sets the snapshot width, scope and range pick pages, format the extension", async () => {
    covers("setting:paged.export.image.v1");
    const mod = await load(memoryStorage());
    const pages = {
      pageIds: ["p1", "p2", "p3"],
      pageSizesPt: [
        [612, 792],
        [612, 792],
        [306, 396],
      ] as const,
      baseName: "brochure.idml",
    };
    const run = async (settings: ImageSettings, activePageIndex?: number) => {
      const { client, widths } = snapshotClient();
      const files: string[] = [];
      const result = await mod.runImageExport(
        client,
        { ...pages, settings, activePageIndex },
        (_bytes, name) => void files.push(name),
      );
      return { result, widths, files };
    };
    const all = await run({ ...DEFAULTS, dpi: 300 } as ImageSettings);
    expect(all.widths).toEqual([2550, 2550, 1275]);
    expect(all.files).toEqual([
      "brochure-p1.png",
      "brochure-p2.png",
      "brochure-p3.png",
    ]);
    const one = await run(
      { ...DEFAULTS, scope: "current" } as ImageSettings,
      1,
    );
    expect(one.widths).toEqual([1275]);
    expect(one.files).toEqual(["brochure.png"]);
    const range = await run({
      ...DEFAULTS,
      scope: "range",
      range: "3,1",
    } as ImageSettings);
    expect(range.files).toEqual(["brochure-p1.png", "brochure-p3.png"]);
    const refused = await run({
      ...DEFAULTS,
      scope: "range",
      range: "9-12",
    } as ImageSettings);
    expect(refused.result).toEqual({ files: 0, refused: "range" });
    expect(refused.widths).toEqual([]);
  });

  // Finding SH-102: the stored value is spread over the defaults without
  // a check, so a DPI the UI never offers (a string, 0, 100000) becomes
  // the export's resolution: "huge" asks the engine for a NaN-wide
  // snapshot, 100000 for a 850000-px one. The other fields degrade by
  // luck (an unknown scope exports every page, an unknown format writes
  // PNG); dpi has no such fallback.
  test.failing(
    "SH-102: a stored DPI outside 72/150/300 falls back to the default",
    async () => {
      covers("setting:paged.export.image.v1");
      for (const dpi of ["huge", 0, 100000]) {
        const ls = memoryStorage({ [KEY]: JSON.stringify({ dpi }) });
        expect({ stored: dpi, dpi: current(await load(ls), ls).dpi }).toEqual({
          stored: dpi,
          dpi: 150,
        });
      }
    },
  );
});
