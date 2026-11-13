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

// What a drop will do (editor ADR 1205, UXI-DND-001 to UXI-DND-004): one
// pure decision from the files, the target under the pointer, the
// document's state and the role.

import { describe, expect, test } from "bun:test";

import {
  resolveDropIntent,
  revalidateDrop,
  type DropFile,
  type DropIntentInput,
  type DropTarget,
} from "../../src/state/drop-intent";

const PAGE: DropTarget = { kind: "page", pageId: "p1" };
const EMPTY_FRAME: DropTarget = {
  kind: "frame",
  element: { kind: "rectangle", id: "r1" },
  pageId: "p1",
  graphic: true,
  hasImage: false,
  locked: false,
};
const PICTURE_FRAME: DropTarget = { ...EMPTY_FRAME, hasImage: true };

const importers: Record<string, string> = {
  ".xlsx": "Spreadsheet",
  ".docx": "Word document",
  ".svg": "SVG",
  ".psd": "Photoshop",
};

function input(
  files: DropFile[],
  target: DropTarget = PAGE,
  extra: Partial<DropIntentInput> = {},
): DropIntentInput {
  return {
    files,
    target,
    needsSave: false,
    role: "editor",
    canPlace: true,
    importer: (f) => {
      const ext = /\.[^.]+$/.exec(f.name ?? "")?.[0]?.toLowerCase() ?? "";
      const title = importers[ext];
      return title ? { title } : null;
    },
    ...extra,
  };
}

const png: DropFile = { name: "photo.png", type: "image/png" };

describe("resolveDropIntent", () => {
  test("UXI-T62: a picture over an empty page is placed, nothing replaced", () => {
    const r = resolveDropIntent(input([png]));
    expect(r.intent).toBe("place");
    expect(r.label).toBe("Place photo.png");
    expect(r.provisional).toBe(false);
  });

  test("a picture over an empty graphic frame goes into THAT frame", () => {
    const r = resolveDropIntent(input([png], EMPTY_FRAME));
    expect(r.intent).toBe("place-in-frame");
    expect(r.frame).toEqual({ kind: "rectangle", id: "r1" });
    expect(r.label).toBe("Place photo.png in this frame");
  });

  test("a picture over a frame that holds one replaces its picture", () => {
    expect(resolveDropIntent(input([png], PICTURE_FRAME)).intent).toBe(
      "replace-frame-content",
    );
  });

  test("a locked frame is not filled: the picture is placed on top", () => {
    expect(
      resolveDropIntent(input([png], { ...EMPTY_FRAME, locked: true })).intent,
    ).toBe("place");
  });

  test("a picture on the pasteboard is placed there", () => {
    expect(resolveDropIntent(input([png], { kind: "pasteboard" })).label).toBe(
      "Place photo.png on the pasteboard",
    );
  });

  test("with nothing open, a picture opens as a document (ADR 262)", () => {
    expect(resolveDropIntent(input([png], { kind: "empty" })).intent).toBe(
      "open",
    );
  });

  test("UXI-T63: a document over a dirty document replaces it after the question", () => {
    const r = resolveDropIntent(
      input([{ name: "Annual.idml", type: "" }], PAGE, { needsSave: true }),
    );
    expect(r.intent).toBe("replace-document");
    expect(r.label).toBe("Open Annual.idml in place of this document");
    expect(r.reason).toBe("You will be asked to save your changes first.");
  });

  test("a document with nothing open opens", () => {
    const r = resolveDropIntent(
      input([{ name: "a.paged", type: "" }], { kind: "empty" }),
    );
    expect(r.intent).toBe("open");
  });

  test("a file an importer claims is imported (the importer decides what it adds)", () => {
    const r = resolveDropIntent(
      input([{ name: "budget.xlsx", type: "" }], PAGE),
    );
    expect(r.intent).toBe("import");
    expect(r.label).toBe("Import budget.xlsx (Spreadsheet)");
  });

  test("an SVG is drawn by its importer, never placed as a picture", () => {
    const r = resolveDropIntent(
      input([{ name: "logo.svg", type: "image/svg+xml" }], EMPTY_FRAME),
    );
    expect(r.intent).toBe("import");
  });

  test("UXI-T64: an unsupported file is refused with the reason", () => {
    const r = resolveDropIntent(
      input([{ name: "notes.txt", type: "text/plain" }], PAGE),
    );
    expect(r.intent).toBe("reject");
    expect(r.label).toBe("Paged cannot open .txt files");
    expect(r.reason).toContain("It opens Paged and InDesign (IDML) documents");
  });

  test("several files are refused rather than all but one dropped silently", () => {
    expect(
      resolveDropIntent(input([png, { name: "b.png", type: "image/png" }]))
        .intent,
    ).toBe("reject");
  });

  test("a viewer or a filler drops nothing", () => {
    expect(
      resolveDropIntent(input([png], PAGE, { role: "viewer" })).intent,
    ).toBe("reject");
    expect(
      resolveDropIntent(input([png], PAGE, { role: "filler" })).intent,
    ).toBe("reject");
  });

  test("while dragging, the type decides provisionally; an unknown type promises nothing", () => {
    const picture = resolveDropIntent(
      input([{ name: null, type: "image/jpeg" }], EMPTY_FRAME),
    );
    expect(picture.intent).toBe("place-in-frame");
    expect(picture.provisional).toBe(true);
    for (const type of ["", "application/zip", "text/plain"]) {
      const unknown = resolveDropIntent(input([{ name: null, type }]));
      expect(unknown.provisional).toBe(true);
      expect(unknown.label).toBe("Drop to open or import this file");
      expect(unknown.intent).not.toBe("replace-document");
      expect(unknown.intent).not.toBe("reject");
    }
  });
});

describe("revalidateDrop (UXI-DND-004)", () => {
  test("a drop on the document the drag saw stands", () => {
    expect(
      revalidateDrop(
        { docId: "d1", context: null },
        { docId: "d1", context: null },
      ),
    ).toBeNull();
  });

  test("another document or context in between refuses the drop", () => {
    expect(
      revalidateDrop(
        { docId: "d1", context: null },
        { docId: "d2", context: null },
      )?.intent,
    ).toBe("reject");
    expect(
      revalidateDrop(
        { docId: "d1", context: null },
        { docId: "d1", context: "paged.sheet" },
      )?.intent,
    ).toBe("reject");
  });
});
