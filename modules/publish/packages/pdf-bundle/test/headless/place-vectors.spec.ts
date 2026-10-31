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

// Place as vectors (publish ADR 658) on the real engine, headless, with the
// real PDFium and mapper wasm under Node: a PDF page lands in the open
// document as native items — a clip group, a gradient-filled path, an
// opacity mask, a text frame — in ONE undo step, with its loss report; an
// Illustrator file without PDF content is refused with the reason; a placed
// PDF frame converts in place.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  createHeadlessHost,
  validateValue,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";
import type { SceneTreeNode } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { pdfBundle } from "../../src/activate";
import {
  CONVERT_PLACED_COMMAND,
  INSPECT_PDF_COMMAND,
  PLACE_VECTORS_COMMAND,
} from "../../src/commands";
import { _resetPdfMapperCache } from "../../src/engine-loader";
import placeResult from "../../schema/place-vectors.result.json";
import type { ValueType } from "@paged-media/plugin-api";
import { aiWithoutPdfContent, vectorPdf } from "../fixtures/vector-pdf";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const IDML = new URL(
  "../../../../../../engine/core/crates/idml-export/tests/fixtures/indesign-20.0.1-navigation.idml",
  import.meta.url,
);

let h: HeadlessHost;

beforeEach(async () => {
  _resetPdfMapperCache();
  h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR });
  h.loadBundle(pdfBundle);
  await h.load(new Uint8Array(readFileSync(IDML)));
}, 60_000);

afterEach(() => h.dispose());

/** Every node of the scene tree, depth first. */
function nodes(tree: readonly SceneTreeNode[]): SceneTreeNode[] {
  const out: SceneTreeNode[] = [];
  const walk = (n: SceneTreeNode) => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of tree) walk(n);
  return out;
}

interface Placed {
  placed: boolean;
  format: string;
  counts: Record<string, number>;
  losses: { code: string; count: number; message: string }[];
  root?: { kind: string; id: string };
}

describe("[editor-shell.import-svg-pdf-vectors] place a PDF page as vectors", () => {
  it("inspects a file: its pages and format", async () => {
    covers("command:media.paged.pdf.inspectPdf");
    const info = (await h.objects.invoke(INSPECT_PDF_COMMAND, {
      bytes: vectorPdf(),
    })) as { format: string; pages: { width_pt: number }[] };
    expect(info.format).toBe("pdf");
    expect(info.pages).toEqual([{ width_pt: 300, height_pt: 300 }]);
  });

  it("lands as native items in one undo step, with a loss report", async () => {
    covers("command:media.paged.pdf.placeVectors");
    const before = nodes(await h.host.document.tree()).length;
    const out = (await h.objects.invoke(PLACE_VECTORS_COMMAND, {
      bytes: vectorPdf(),
      name: "art.pdf",
      page: 1,
    })) as Placed;
    expect(validateValue(placeResult as ValueType, out)).toBeNull();
    expect(out.placed).toBe(true);
    expect(out.counts.clip_groups).toBeGreaterThanOrEqual(1);
    expect(out.counts.gradients).toBe(1);
    expect(out.counts.opacity_masks).toBe(1);
    expect(out.counts.text_frames).toBe(1);
    expect(out.losses.map((l) => l.code)).toContain("colours");
    const after = nodes(await h.host.document.tree());
    expect(after.length).toBeGreaterThan(before);
    expect(out.root).toBeDefined();
    expect(after.some((n) => n.id?.id === out.root!.id)).toBe(true);
    // One undo takes the whole placement away.
    await h.host.document.undo();
    expect(nodes(await h.host.document.tree()).length).toBe(before);
  });

  it("refuses an Illustrator file saved without PDF content, with the reason", async () => {
    await expect(
      Promise.resolve(
        h.objects.invoke(PLACE_VECTORS_COMMAND, {
          bytes: aiWithoutPdfContent(),
          name: "art.ai",
          page: 1,
        }),
      ),
    ).rejects.toThrow(/aiWithoutPdf: .*Create PDF Compatible File/);
  });

  it("refuses a page the file lacks", async () => {
    await expect(
      Promise.resolve(
        h.objects.invoke(PLACE_VECTORS_COMMAND, {
          bytes: vectorPdf(),
          name: "art.pdf",
          page: 4,
        }),
      ),
    ).rejects.toThrow(/invalidValue/);
  });
});

describe("[editor-shell.import-svg-pdf-vectors] convert a placed PDF frame", () => {
  it("turns a placed PDF frame into its vectors, clipped, in one undo step", async () => {
    const pageId =
      (await h.host.document.meta()).activePage ??
      (await h.host.document.collection<{ selfId: string }>("pages"))[0]!
        .selfId;
    const minted = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId, bounds: [100, 100, 250, 250] },
    });
    expect(minted.applied, JSON.stringify(minted)).toBe(true);
    const frame = minted.applied ? minted.createdId! : null;
    const placed = await h.host.document.mutateWithBytes(
      {
        op: "replaceImageBytes",
        args: { elementId: String(frame!.id), bytes: [] },
      },
      vectorPdf(),
    );
    expect(placed.applied).toBe(true);
    // The engine serves a placed file's bytes once a build has resolved it.
    await h.host.render.snapshot(pageId, { widthPx: 64 }).catch(() => null);
    const before = nodes(await h.host.document.tree());
    const out = (await h.objects.invoke(CONVERT_PLACED_COMMAND, {
      elementId: String(frame!.id),
    })) as Placed;
    expect(out.placed).toBe(true);
    const after = nodes(await h.host.document.tree());
    expect(after.some((n) => n.id?.id === frame!.id)).toBe(false);
    expect(after.length).toBeGreaterThan(before.length);
    await h.host.document.undo();
    const back = nodes(await h.host.document.tree());
    expect(back.some((n) => n.id?.id === frame!.id)).toBe(true);
    expect(back.length).toBe(before.length);
  });

  it("refuses a frame that places no PDF", async () => {
    covers("command:media.paged.pdf.convertPlacedToVectors");
    await expect(
      Promise.resolve(
        h.objects.invoke(CONVERT_PLACED_COMMAND, {
          elementId: "no-such-frame",
        }),
      ),
    ).rejects.toThrow(/failed: /);
  });
});
