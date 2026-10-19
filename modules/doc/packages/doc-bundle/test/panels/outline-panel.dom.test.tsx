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

// The Word outline panel, RENDERED (happy-dom) against the real engine:
// empty until a Word document arrives, then its file name, counts, outline
// and diagnostics; "Select frame" selects the frame the document lives in;
// "Insert Word document…" places a picked file, and is disabled on a host
// without a picker.

import { afterEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { NO_PICKER_REASON } from "../../src/panels/outline-panel";
import { docxPresent, fixture, requireDocx } from "../conformance/harness";
import { docHost, drive, mount, type DocHarness } from "./harness";

const PANEL = "media.paged.doc.panel.outline";
let d: DocHarness | null = null;

afterEach(() => {
  cleanup();
  d?.dispose();
  d = null;
});

const q = (root: HTMLElement, sel: string) =>
  root.querySelector<HTMLElement>(sel);

requireDocx("doc component — the Word outline panel");

describe.skipIf(!docxPresent)(
  "the Word outline panel (unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh; REQUIRE_REAL_DOCX=1 fails instead)",
  () => {
    it("is empty until a document arrives, and offers to insert one", async () => {
      covers("panel:media.paged.doc.panel.outline");
      d = await docHost({ picker: true });
      const view = mount(d.panel(PANEL));
      expect(q(view.container, '[data-doc-panel="empty"]')).not.toBeNull();
      const insert = q(
        view.container,
        "[data-doc-insert]",
      ) as HTMLButtonElement;
      expect(insert.disabled).toBe(false);
      expect(insert.textContent).toBe("Insert Word document…");
    });

    it("without a file picker the insert button is disabled and says why", async () => {
      covers("panel:media.paged.doc.panel.outline");
      d = await docHost();
      const view = mount(d.panel(PANEL));
      const insert = q(
        view.container,
        "[data-doc-insert]",
      ) as HTMLButtonElement;
      expect(insert.disabled).toBe(true);
      expect(insert.title).toBe(NO_PICKER_REASON);
    });

    it("after File ▸ Open shows the document's name and counts, and Select frame selects its frame", async () => {
      covers("panel:media.paged.doc.panel.outline");
      d = await docHost();
      const view = mount(d.panel(PANEL));
      await drive(() => d!.open("merge-letter.docx"));
      await waitFor(() =>
        expect(q(view.container, '[data-doc-panel="ready"]')).not.toBeNull(),
      );
      expect(view.container.textContent).toContain("merge-letter.docx");
      expect(q(view.container, "[data-doc-summary]")!.textContent).toContain(
        "2 paragraphs",
      );
      expect(q(view.container, "[data-doc-outline]")).not.toBeNull();
      await drive(() =>
        fireEvent.click(q(view.container, "[data-doc-select-frame]")!),
      );
      const selected = d.host.selection.get();
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({ kind: "textFrame" });
      // The frame selected is the one carrying the document.
      expect(
        await d.host.objects.query(
          `textFrame:${(selected[0] as { id: string }).id} > plugin:media.paged.doc/docxDocument`,
        ),
      ).toHaveLength(1);
    });

    it("Insert Word document… places the picked file into the open document", async () => {
      covers("panel:media.paged.doc.panel.outline");
      d = await docHost({ picker: true });
      const view = mount(d.panel(PANEL));
      const docs = () =>
        d!.host.objects.query("plugin:media.paged.doc/docxDocument");
      expect(await docs()).toEqual([]);
      d.nextPick.push({
        name: "letter.docx",
        bytes: fixture("merge-letter.docx"),
      });
      await drive(() =>
        fireEvent.click(q(view.container, "[data-doc-insert]")!),
      );
      await waitFor(async () => expect(await docs()).toHaveLength(1), {
        timeout: 4000,
      });
      await waitFor(() =>
        expect(view.container.textContent).toContain("letter.docx"),
      );
      expect(d.opened).toContain(PANEL);
    });
  },
);
