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

// D-26 — the editor half of the plugin DOCUMENTS door (`host.documents`,
// ADR 219). The SDK door owns the capability gate and fills the requester
// from the bundle's manifest; this module owns what the SDK cannot: the
// serializer and loader over the live engine client, and the keep/discard
// DECISION when a plugin asks to replace a document with unsaved edits.
//
// The editor holds one document. A plugin-built document (paged.data's
// "Merge to new document") therefore REPLACES the active one, which is the
// same loss every other open guards against: it asks the one replace
// question (`confirmReplace`, ADR 230). Here a plugin asks, so the prompt
// names the plugin and the document, and Cancel KEEPS the document.

import type { OpenDocumentResult } from "@paged-media/plugin-api";
import type { DocumentsBackend } from "@paged-media/plugin-sdk";
import type { CanvasClient, DocumentHandle } from "@paged-media/client";
import { confirmReplace } from "@paged-media/shell";

export type { OpenDocumentResult };

/** What the SDK hands the backend with an open request. */
export type OpenDocumentRequest = Parameters<DocumentsBackend["open"]>[1];

/** The backend the SDK's `host.documents` door forwards to. */
export type EditorDocumentsBackend = DocumentsBackend;

/** What the app attaches once its document context exists. */
export interface DocumentsDeps {
  getClient: () => CanvasClient | null;
  /** The File > Open orchestration (load with the default font, set the
   *  handle, snapshot). Resolves the handle, or throws when the bytes do
   *  not load. */
  openBytes: (bytes: Uint8Array, name: string) => Promise<DocumentHandle>;
}

export interface EditorDocuments {
  backend: EditorDocumentsBackend;
  /** Bind the live client + open orchestration; returns the detach. */
  attach(deps: DocumentsDeps): () => void;
}

const DEFAULT_NAME = "Untitled document";

/** IDML and `.paged` are both ZIP packages. Checked BEFORE the prompt and
 *  before the open resets the view, so junk bytes cost the user nothing. */
function looksLikePackage(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function createEditorDocuments(): EditorDocuments {
  let deps: DocumentsDeps | null = null;
  let busy = false;

  const backend: EditorDocumentsBackend = {
    async exportPaged() {
      const client = deps?.getClient() ?? null;
      if (!client) throw new Error("no document is open");
      return client.exportPaged();
    },

    async open(bytes, request) {
      const d = deps;
      const client = d?.getClient() ?? null;
      if (!d || !client)
        throw new Error("no engine client to open the document in");
      if (!looksLikePackage(bytes)) {
        throw new Error("not an IDML or .paged package (no ZIP signature)");
      }
      // One replace at a time: a second request while the first is being
      // decided or loaded would race the view state it resets.
      if (busy) throw new Error("another document is being opened");
      busy = true;
      try {
        const name = request.name ?? DEFAULT_NAME;
        const proceed = await confirmReplace(client, {
          action: `Opening ${name}`,
          requester: request.requester.name,
          documentName: name,
        });
        if (!proceed) return { opened: false, reason: "declined" };
        const handle = await d.openBytes(bytes, name);
        return { opened: true, pageIds: [...handle.pageIds] };
      } finally {
        busy = false;
      }
    },
  };

  return {
    backend,
    attach(next) {
      deps = next;
      return () => {
        if (deps === next) deps = null;
      };
    },
  };
}
