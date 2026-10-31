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

// The showcase's Ch.14 opener imports `annual-crest.svg` through
// paged.draw and counts the Polygons it lands. That count is the
// importer's plan of the file — since draw ADR 364 the engine's own
// (`document.importSvg`, paged-svg) — so it is held here to a headless
// engine: when the import changes how it lowers a shape, this fails in
// seconds instead of the nightly book failing two hours in (and every
// later chapter with it, since each starts from the one before's
// checkpoint).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { importSvg } from "@paged-media/draw";
import type { ElementId } from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  silentConsole,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import {
  CREST_NAME,
  CREST_POLYGON_CONTOURS,
  CREST_SHAPES,
} from "../../tests/showcase/pages/200-drawing-office/crest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CREST = readFileSync(
  join(HERE, "../../tests/showcase/assets", CREST_NAME),
);

describe("the showcase crest import", () => {
  let h: HeadlessHost;
  let ids: ElementId[] = [];

  beforeAll(async () => {
    h = await createHeadlessHost({
      console: silentConsole,
      resolveFrom: join(HERE, "../.."),
    });
    await h.load(minimalIdml());
    ids = await importSvg(h.host, {
      name: CREST_NAME,
      bytes: new Uint8Array(CREST),
      mimeType: "image/svg+xml",
    });
  });
  afterAll(() => h?.dispose());

  test("lands the Polygons the opener counts", () => {
    expect(ids.filter((id) => id.kind === "polygon")).toHaveLength(
      CREST_SHAPES,
    );
  });

  test("each Polygon carries the contours the opener checks, holes as even-odd", async () => {
    const polygons = ids.filter((id) => id.kind === "polygon");
    const contours = [];
    for (const id of polygons) {
      const table = await h.host.document.pathAnchors(id);
      contours.push(Math.max(1, table!.subpathStarts.length));
      if (table!.subpathStarts.length > 1) {
        const props = await h.host.document.elementProperties(id);
        expect(
          props!.entries.find((e) => e.path === "frameFillRule")?.value,
        ).toMatchObject({ value: "EvenOdd" });
      }
    }
    expect(contours).toEqual([...CREST_POLYGON_CONTOURS]);
  });
});
