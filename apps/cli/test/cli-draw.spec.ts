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

// `paged-node invoke` over paged.draw (plan G4): the width profile and the
// linked-recipe update reached through their typed twins, the draw bundle
// loaded from the workspace, the document written back.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import { cli, engineOptions, silent, tempDir } from "./helpers";

const DRAW_ENTRY = fileURLToPath(
  new URL(
    "../../../modules/draw/packages/draw-bundle/src/index.ts",
    import.meta.url,
  ),
);
const DRAW = `--plugins=${DRAW_ENTRY}`;
const C = "media.paged.draw.command";

let tmp: ReturnType<typeof tempDir>;
let docPath = "";
let openPath = "";

/** The SDK's minimal document (closed rectangle `urect`) plus one open
 *  three-anchor path, saved as .paged. */
async function writeDocument(dir: string): Promise<[string, string]> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const [pageId] = await h.load(minimalIdml());
    const made = (await h.host.document.mutate({
      op: "insertPath",
      args: {
        pageId: pageId!,
        open: true,
        anchors: (
          [
            [100, 400],
            [250, 500],
            [400, 400],
          ] as [number, number][]
        ).map((p) => ({ anchor: p, left: p, right: p })),
      },
    })) as { applied: boolean; createdId?: { kind: string; id: unknown } };
    if (!made.applied || !made.createdId) throw new Error("path refused");
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "drawing.paged");
    writeFileSync(path, bytes);
    return [path, `${made.createdId.kind}:${String(made.createdId.id)}`];
  } finally {
    h.dispose();
  }
}

beforeAll(async () => {
  tmp = tempDir();
  [docPath, openPath] = await writeDocument(tmp.dir);
});
afterAll(() => tmp.done());

describe("paged-node invoke — paged.draw", () => {
  it("widthProfile outlines the open path at the profile given", async () => {
    const r = await cli([
      "invoke",
      docPath,
      `${C}.widthProfile`,
      JSON.stringify({ targets: [openPath], widths: [0, 8, 0] }),
      "--no-save",
      DRAW,
    ]);
    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json.applied).toBe(true);
    expect(r.json.result).toEqual({ outlined: 1 });
  });

  it("widthProfile on a closed path fails with the reason", async () => {
    const r = await cli([
      "invoke",
      docPath,
      `${C}.widthProfile`,
      JSON.stringify({ targets: ["rectangle:urect"], widths: [4] }),
      "--no-save",
      DRAW,
    ]);
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json)).toMatch(/single-contour open path/);
  });

  it("updateLinkedRecipes says when the document holds no recipe", async () => {
    const r = await cli([
      "invoke",
      docPath,
      `${C}.updateLinkedRecipes`,
      JSON.stringify({ targets: [], all: true }),
      "--no-save",
      DRAW,
    ]);
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json)).toMatch(/has no pattern, repeat, blend/);
  });
});
