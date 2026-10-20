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

// Page images (PNG) export, on the real engine: a document whose text asks
// for a face nobody has is drawn on the canvas with a pink highlight behind
// that text, and the exported PNG must not carry it (engine ADR 205).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";

import { CanvasClient } from "@paged-media/client";
import { storedZip } from "@paged-media/test-kit";

import { runImageExport } from "../../src/panels/cockpit/export-targets";
import { EngineWorker, headlessEngine } from "./engine-worker";

const NS = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';

/** One 400 pt page with one line of 24 pt text in `font`. */
function textPage(font: string): Uint8Array {
  return storedZip([
    { name: "mimetype", data: "application/vnd.adobe.indesign-idml-package" },
    {
      name: "designmap.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8"?><Document ${NS} Self="d1">` +
        `<idPkg:Spread src="Spreads/Spread_sp1.xml"/>` +
        `<idPkg:Story src="Stories/Story_s1.xml"/></Document>`,
    },
    {
      name: "Spreads/Spread_sp1.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8"?><idPkg:Spread ${NS}><Spread Self="sp1">` +
        `<Page Self="p1" GeometricBounds="0 0 400 400"/>` +
        `<TextFrame Self="frameA" ParentStory="s1" GeometricBounds="20 20 120 380"/>` +
        `</Spread></idPkg:Spread>`,
    },
    {
      name: "Stories/Story_s1.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story ${NS}><Story Self="s1">` +
        `<ParagraphStyleRange><CharacterStyleRange AppliedFont="${font}" PointSize="24">` +
        `<Content>Missing font text</Content>` +
        `</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`,
    },
  ]);
}

const INTER = new Uint8Array(
  readFileSync(join(import.meta.dir, "../../public/fonts/Inter.ttf")),
);

/** Pixels that read as the substituted-font pink (RGB 255, 133, 154 on
 *  white): red at full, blue clearly above green. The text is black and
 *  the page white, so nothing else on the page comes near it. */
function pinkPixels(png: Uint8Array): number {
  const { data } = PNG.sync.read(Buffer.from(png));
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 230 && g > 90 && g < 190 && b > g + 8 && b < r - 30) n++;
  }
  return n;
}

async function open(font: string): Promise<CanvasClient> {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.loadDocument(textPage(font), INTER);
  return client;
}

async function exportedPng(client: CanvasClient): Promise<Uint8Array> {
  const files: Uint8Array[] = [];
  const result = await runImageExport(
    client,
    {
      pageIds: ["p1"],
      pageSizesPt: [[400, 400]],
      settings: { dpi: 72, scope: "all", range: "", format: "png", quality: 1 },
    },
    (bytes) => files.push(bytes),
  );
  expect(result.files).toBe(1);
  return files[0];
}

describe("Page images export: no editor-only markers", () => {
  test("text in a substituted face exports without the pink highlight", async () => {
    const client = await open("Ghost Family");
    const thumbnail = await client.requestSnapshot(
      "p1" as never,
      400,
      undefined,
      {
        markers: true,
      },
    );
    // The canvas marks the substitution: the fixture does what it says.
    expect(pinkPixels(Uint8Array.from(thumbnail.pngBytes))).toBeGreaterThan(
      100,
    );
    expect(pinkPixels(await exportedPng(client))).toBe(0);
  });

  test("a document without a substitution exports as the canvas shows it", async () => {
    const client = await open("Inter");
    const png = await exportedPng(client);
    expect(pinkPixels(png)).toBe(0);
    const canvas = await client.requestSnapshot("p1" as never, 400, 72, {
      markers: true,
    });
    expect(Uint8Array.from(canvas.pngBytes)).toEqual(png);
  });
});
