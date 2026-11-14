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

// Named checkpoints (editor ADR 1234): a checkpoint keeps the open state on
// the document's repository and needs a library document; every reported
// export keeps one automatically; a refusal is said in words.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import type { DocumentEntry } from "@paged-media/repository";
import {
  createEditorScope,
  operationFeedbackOf,
  setCurrentLibraryDocument,
  setLibrary,
} from "@paged-media/shell";

import {
  checkpointRefusal,
  keepCheckpoint,
  watchExports,
} from "../../../src/checkpoints/checkpoints";

const entry: DocumentEntry = {
  id: "doc-1",
  name: "Annual",
  createdAt: 0,
  updatedAt: 0,
  head: "a".repeat(64),
};

function editorWith(library: object | null, doc: DocumentEntry | null) {
  const scope = createEditorScope();
  if (library) setLibrary(scope, library as never);
  setCurrentLibraryDocument(scope, doc);
  const exported = new Uint8Array([1, 2, 3]);
  return {
    scope,
    client: { exportPaged: async () => exported },
    document: { handle: { pageCount: 4 } },
  } as never;
}

describe("named checkpoints", () => {
  test("a checkpoint keeps the open state, with its page count, on the library document", async () => {
    covers("panel:paged.library");
    const kept: unknown[] = [];
    const library = {
      checkpoint: async (id: string, bytes: Uint8Array, meta: object) => {
        kept.push({ id, bytes: [...bytes], meta });
        return { id: "c1", ...meta };
      },
    };
    await keepCheckpoint(
      editorWith(library, entry),
      "Typography pass",
      "named",
    );
    expect(kept).toEqual([
      {
        id: "doc-1",
        bytes: [1, 2, 3],
        meta: { name: "Typography pass", kind: "named", pages: 4 },
      },
    ]);
  });

  test("without a library document it says to save first; a refusal is worded", async () => {
    await expect(
      keepCheckpoint(editorWith({}, null), "x", "named"),
    ).rejects.toThrow("Save the document first");
    expect(checkpointRefusal(new Error("checkpoint refused: too-large"))).toBe(
      "The document is larger than a checkpoint may be (256 MB).",
    );
    expect(
      checkpointRefusal(new Error("checkpoint refused: too-many")),
    ).toMatch(/100 named checkpoints/);
  });

  test("every successful export keeps an automatic checkpoint, nothing else does", async () => {
    const kept: Array<{ name: string; kind: string }> = [];
    const library = {
      checkpoint: async (_id: string, _b: Uint8Array, meta: never) => {
        kept.push({
          name: (meta as { name: string }).name,
          kind: (meta as { kind: string }).kind,
        });
        return meta;
      },
    };
    const editor = editorWith(library, entry);
    const scope = (editor as unknown as { scope: never }).scope;
    const off = watchExports(scope, () => editor);
    const feedback = operationFeedbackOf(scope);
    feedback.report({
      action: "export Annual.pdf",
      outcome: "success",
      title: "Exported Annual.pdf · 4 pages · in your downloads",
      source: "paged.export",
    });
    feedback.report({
      action: "export the page images",
      outcome: "recoverable-failure",
      reason: "no space",
      source: "paged.export",
    });
    feedback.report({
      action: "paste",
      outcome: "success",
      source: "paged.clipboard",
    });
    await new Promise((r) => setTimeout(r, 0));
    off();
    feedback.report({
      action: "export again",
      outcome: "success",
      source: "paged.export",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(kept).toEqual([{ name: "Exported Annual.pdf", kind: "export" }]);
  });
});
