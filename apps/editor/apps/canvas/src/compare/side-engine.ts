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

// A second engine for reading a document that is not the open one
// (editor ADRs 1234 and 1235): a checkpoint's or a variant's state is
// loaded into its own worker and rendered there, so previewing or comparing
// it never touches the open document, its selection or its history. Made
// per use and disposed after; per editor (the app hands each editor the
// factory its own client was made with).

import type { CanvasClient, DocumentHandle } from "@paged-media/client";
import { decodePng } from "@paged-media/helpers";
import { createValueStore, scoped, type EditorScope } from "@paged-media/shell";

import type { Rgba } from "./diff";

const FACTORY = scoped("sideEngineFactory", () =>
  createValueStore<(() => CanvasClient) | null>(null),
);

/** How this editor makes a second engine (set once by the app). */
export function setSideEngineFactory(
  scope: EditorScope,
  make: (() => CanvasClient) | null,
): void {
  scope.get(FACTORY).set(make);
}

/** A document open in a second engine, read-only by construction. */
export interface SideDocument {
  client: CanvasClient;
  handle: DocumentHandle;
  dispose(): void;
}

/** Load `bytes` in a second engine. Null when the editor has none. */
export async function openSideDocument(
  scope: EditorScope,
  bytes: Uint8Array,
): Promise<SideDocument | null> {
  const make = scope.get(FACTORY).get();
  if (!make) return null;
  const client = make();
  try {
    const handle = await client.loadDocument(bytes.slice());
    return { client, handle, dispose: () => client.dispose() };
  } catch (err) {
    client.dispose();
    throw err;
  }
}

/** One page as rendered: its pixels and a URL to show them. */
export interface RenderedPage {
  pageId: string;
  image: Rgba;
  url: string;
}

/** Render `pageIds` of the document `client` holds at `widthPx` (the CPU
 *  snapshot every engine has). A page that does not render is left out. */
export async function renderPages(
  client: Pick<CanvasClient, "requestSnapshot">,
  pageIds: readonly string[],
  widthPx: number,
): Promise<RenderedPage[]> {
  const out: RenderedPage[] = [];
  for (const pageId of pageIds) {
    try {
      const snap = await client.requestSnapshot(pageId as never, widthPx);
      const png = Uint8Array.from(snap.pngBytes);
      const image = await decodePng(png);
      const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      out.push({ pageId, image, url });
    } catch {
      /* a page that does not render is compared as missing */
    }
  }
  return out;
}

/** Let go of the renders' URLs. */
export function releasePages(pages: readonly RenderedPage[]): void {
  for (const p of pages) URL.revokeObjectURL(p.url);
}
