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

// DOCUMENT OPENED — one way to hear that the active document was replaced
// (a file opened, a new document made): auto render (auto-render.ts) resets
// its bookkeeping and renders the new document's web frames; the source-part
// collector (parts-gc.ts) marks what the opened file carried.
//
// Every host reports it through `document.onDidOpen` (static
// `document.onDidOpen@1`: the editor and the headless harness both fan the
// engine's `documentLoaded` out to it).

import type { BundleHost } from "@paged-media/plugin-api";

/** Call `listener` whenever another document opens; the returned function
 *  stops listening. Not called for the document already open. */
export function onDocumentOpened(
  host: BundleHost,
  listener: () => void,
): () => void {
  const sub = host.document.onDidOpen(() => listener());
  return () => sub.dispose();
}
