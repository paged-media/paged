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

// Doc ADR 614 — the page items a Word document's floats and text boxes
// become. The standalone skeleton (docx-skeleton) wrote their frames, the
// pictures, the wrap and the look; a text box's story is empty there, and
// the pour fills it with the box's paragraphs as it fills the masters'
// header and footer stories.

import type { LoweredDoc, LoweredPageItem } from "@paged-media/doc-host-model";
import { buildStoryBlocks } from "@paged-media/doc-host-model";
import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import { pourSteps } from "./pour.js";

/** The text boxes among the page items, with their story. */
export function textBoxItems(
  ir: LoweredDoc,
): Array<LoweredPageItem & { item: { kind: "textBox"; storyId: string } }> {
  return (ir.pageItems ?? []).filter(
    (
      i,
    ): i is LoweredPageItem & { item: { kind: "textBox"; storyId: string } } =>
      i.item.kind === "textBox",
  );
}

/** Pour every text box's story with its paragraphs. */
export async function pourPageItems(
  host: BundleHost,
  ir: LoweredDoc,
): Promise<void> {
  for (const item of textBoxItems(ir)) {
    if (item.item.kind !== "textBox") continue;
    const blocks = item.item.paragraphs.map((p) => ({
      kind: "paragraph" as const,
      ...p,
    }));
    await pourSteps(host, buildStoryBlocks(blocks, item.item.storyId));
  }
}

/** The page items an embedded placement can make on the host page `pageId`:
 *  those on the Word document's first page (its first story's), whose page
 *  coordinates the placed frame shares (it stands on the first section's
 *  margin box). Each is a frame made in the placement's batch, with its
 *  picture or poured text and its wrap; items on a later section's page or
 *  on a master have no page here. */
export function embeddedItemOps(
  ir: LoweredDoc,
  pageId: string,
  pour: (
    steps: ReturnType<typeof buildStoryBlocks>,
    prefix: string,
  ) => Mutation[],
): Mutation[] {
  const ops: Mutation[] = [];
  const first = "docx_p0";
  for (const [n, item] of (ir.pageItems ?? []).entries()) {
    if (item.host.kind !== "page" || item.host.pageId !== first) continue;
    const handle = `docItem${n}`;
    const ref = `$h:${handle}`;
    const kind = item.item.kind === "picture" ? "rectangle" : "textFrame";
    const elementId = { kind, id: ref };
    if (item.item.kind === "picture") {
      ops.push(
        {
          op: "insertFrame",
          args: { pageId, bounds: item.bounds },
        } as Mutation,
        { op: "bindCreated", args: { handle } } as Mutation,
        {
          op: "placeImage",
          args: { elementId: ref, uri: item.item.uri, fit: null },
        } as Mutation,
      );
    } else {
      const blocks = item.item.paragraphs.map((p) => ({
        kind: "paragraph" as const,
        ...p,
      }));
      ops.push(
        {
          op: "insertTextFrame",
          args: { pageId, bounds: item.bounds },
        } as Mutation,
        { op: "bindCreated", args: { handle } } as Mutation,
        ...pour(buildStoryBlocks(blocks, ref), `${handle}t`),
      );
    }
    if (item.wrap) {
      ops.push(
        {
          op: "setElementProperty",
          args: {
            elementId,
            path: "frameTextWrapMode",
            value: { type: "text", value: item.wrap.mode },
          },
        } as unknown as Mutation,
        {
          op: "setElementProperty",
          args: {
            elementId,
            path: "frameTextWrapOffsets",
            value: { type: "bounds", value: item.wrap.offsetsPt },
          },
        } as unknown as Mutation,
      );
    }
  }
  return ops;
}

/** Doc ADR 614 — every text box's story read back, by page item (what
 *  docx-export's `textbox::save_text_boxes` splices into the box). A box
 *  whose story the document does not hold (an embedded placement's, made
 *  under another id) is left out. */
export async function readTextBoxes(
  host: BundleHost,
  ir: LoweredDoc,
): Promise<Array<{ item: string; content: unknown }>> {
  const out: Array<{ item: string; content: unknown }> = [];
  for (const item of textBoxItems(ir)) {
    if (item.item.kind !== "textBox") continue;
    try {
      const content = await host.document.storyContent(item.item.storyId);
      if (content) out.push({ item: item.id, content });
    } catch {
      /* not this document's story */
    }
  }
  return out;
}
