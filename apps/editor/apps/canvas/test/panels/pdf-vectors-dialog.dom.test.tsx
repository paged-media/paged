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

// File ▸ Import ▸ PDF or AI as Vectors… (paged.file.importPdfVectors,
// WP4.12, publish ADR 658): the menu row's command opens the dialog in its
// editor; without paged.pdf's object model the dialog says the import is
// not loaded and Place stays disabled; Cancel closes it. The placement
// itself, through the bundle's typed commands, is the e2e
// (tests/e2e/pdf-vectors.spec.ts) and the bundle's own specs.

import { afterEach, describe, expect, test } from "bun:test";
import { createCommandRegistry } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  IMPORT_PDF_VECTORS_COMMAND,
  PDF_VECTORS_COMMANDS,
  PDF_VECTORS_MENU_ITEMS,
  PdfVectorsDialog,
} from "../../src/panels/pdf-vectors-dialog";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const q = <T extends Element = HTMLElement>(
  h: PanelHarness<unknown>,
  sel: string,
) => document.querySelector<T>(sel) ?? h.root.querySelector<T>(sel);

describe("paged.file.importPdfVectors", () => {
  test("the File ▸ Import row opens the dialog; Cancel closes it", async () => {
    covers("command:paged.file.importPdfVectors");
    expect(PDF_VECTORS_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["File/Import/PDF or AI as Vectors…", IMPORT_PDF_VECTORS_COMMAND],
    ]);
    const h = await mountPanel(PdfVectorsDialog, {
      id: IMPORT_PDF_VECTORS_COMMAND,
      document: "blank",
    });
    const registry = createCommandRegistry(() => ({ scope: h.scope }));
    for (const c of PDF_VECTORS_COMMANDS) registry.register(c);
    expect(q(h, "[data-pdf-vectors-dialog]")).toBeNull();
    await h.act(() => registry.invoke(IMPORT_PDF_VECTORS_COMMAND));
    await h.settle();
    expect(q(h, "[data-pdf-vectors-dialog]")).not.toBeNull();
    // No file yet: Place waits for one.
    expect(q<HTMLButtonElement>(h, "[data-pdf-vectors-place]")!.disabled).toBe(
      true,
    );
    await h.click(q(h, "[data-pdf-vectors-cancel]")!);
    expect(q(h, "[data-pdf-vectors-dialog]")).toBeNull();
  });
});
