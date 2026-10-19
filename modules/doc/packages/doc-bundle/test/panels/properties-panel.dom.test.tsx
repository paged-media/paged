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

// The Word properties panel: a schema panel of property rows and lists,
// RENDERED (happy-dom) through the SDK's schema-panel component and a
// minimal renderer (./schema-renderer.tsx) on the real engine. With the
// Word frame selected it shows the document's file name and block count,
// lists its merge fields, and writing a picked field's value pours it into
// the text as one undo step.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { docxPresent, requireDocx, storyTexts } from "../conformance/harness";
import { docHost, drive, mountSchema, type DocHarness } from "./harness";

const PANEL = "media.paged.doc.panel.properties";
let d: DocHarness;

const FIRST = "Dear «First Name», from «City» and «City», page 1";

async function selectWordFrame() {
  const [doc] = await d.host.objects.query(
    "plugin:media.paged.doc/docxDocument",
  );
  const frame = doc!.split("/").pop()!;
  await drive(() =>
    d.host.selection.set([{ kind: "textFrame", id: frame } as never]),
  );
  return frame;
}

requireDocx("doc component — the Word properties panel");

describe.skipIf(!docxPresent)(
  "the Word properties panel (unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh; REQUIRE_REAL_DOCX=1 fails instead)",
  () => {
    beforeEach(async () => {
      d = await docHost();
      await d.open("merge-letter.docx");
    }, 60_000);

    afterEach(() => {
      cleanup();
      d.dispose();
    });

    it("shows nothing for an empty selection, and the document's rows for the Word frame", async () => {
      covers("panel:media.paged.doc.panel.properties");
      const view = mountSchema(d, PANEL);
      const name = () =>
        view.container.querySelector<HTMLElement>('[data-path="fileName"]')!;
      expect(name().hasAttribute("data-empty")).toBe(true);
      await selectWordFrame();
      await waitFor(() => expect(name().textContent).toBe("merge-letter.docx"));
      expect(name().hasAttribute("data-readonly")).toBe(true);
      expect(
        view.container.querySelector('[data-path="blockCount"]')!.textContent,
      ).toBe("2");
    });

    it("lists the merge fields, and a value written for the picked field is poured into the text — one undo step", async () => {
      covers("panel:media.paged.doc.panel.properties");
      const view = mountSchema(d, PANEL);
      await selectWordFrame();
      const items = await waitFor(() => {
        const els = view.container.querySelectorAll<HTMLButtonElement>(
          '[data-list="doc.properties.mergeFields"] [data-list-item]',
        );
        expect(els.length).toBeGreaterThan(0);
        return [...els];
      });
      expect(items.map((b) => b.textContent)).toContain("OrderNo");
      const order = items.find((b) => b.textContent === "OrderNo")!;
      await drive(() => fireEvent.click(order));
      const value = await waitFor(() => {
        const el = view.container.querySelector<HTMLInputElement>(
          '[data-path="value"]',
        );
        expect(el?.dataset.target).toBe(order.dataset.listItem);
        return el!;
      });
      await drive(() => fireEvent.change(value, { target: { value: "A-17" } }));
      await drive(() => fireEvent.blur(value));
      const story = (
        await d.h.host.document.collection<{ selfId: string }>("stories")
      )[0]!.selfId;
      await waitFor(async () =>
        expect(await storyTexts(d.host, story)).toEqual([FIRST, "Order A-17"]),
      );
      await drive(() => d.host.document.undo());
      expect(await storyTexts(d.host, story)).toEqual([
        FIRST,
        "Order «OrderNo»",
      ]);
    });
  },
);
