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

// The Typography Debugger panel (editor ADR 1238): the story's lines as the
// engine reports them, why the chosen one broke, and a preview that writes
// nothing until Apply, which is one write.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TypographyPanel } from "../../src/panels/typography-panel";
import { mountPanel, unmountAll } from "./harness";
import { XRAY, xrayFixture } from "../../tests/e2e/harness/xray-idml";

afterEach(unmountAll);

const inter = () =>
  new Uint8Array(
    readFileSync(join(import.meta.dir, "../../public/fonts/Inter.ttf")),
  );

describe("Typography debugger", () => {
  test("empty: asks for text", async () => {
    covers("panel:paged.typography");
    const h = await mountPanel(TypographyPanel, { id: "paged.typography" });
    expect(h.root.querySelector("[data-typography-empty]")).not.toBeNull();
  });

  test("the caret's story: the engine's lines, the why, a preview that writes nothing, Apply one write", async () => {
    covers("panel:paged.typography");
    const h = await mountPanel(TypographyPanel, {
      id: "paged.typography",
      document: xrayFixture(),
    });
    await h.act(() => h.client.registerFont("Inter", inter()));
    await h.caret(XRAY.justified.story, 2);
    await h.settle();
    const engine = await h.client.lineEvidence({
      story: XRAY.justified.story,
    });
    const rows = h.root.querySelectorAll("[data-typography-row]");
    expect(rows.length).toBe(engine.lines.length);
    expect(rows.length).toBeGreaterThan(3);
    engine.lines.forEach((l, i) => {
      expect(rows[i]!.getAttribute("data-tightness")).toBe(l.tightness);
      expect(rows[i]!.getAttribute("data-break")).toBe(l.breakKind);
    });
    // The caret's line explains itself.
    expect(h.root.querySelector('[data-typography-why="0:0"]')).not.toBeNull();
    // A preview: a read, no write.
    const from = h.mark();
    await h.click(h.root.querySelector("[data-typography-run]")!);
    await h.settle();
    expect(
      h.root.querySelector("[data-typography-preview-result]"),
    ).not.toBeNull();
    expect(h.mutations(from)).toEqual([]);
    expect(h.sent("requestLineEvidence", from).length).toBeGreaterThan(0);
    // Apply: the one write.
    await h.click(h.root.querySelector("[data-typography-apply]")!);
    await h.settle();
    expect(h.mutations(from).length).toBe(1);
  });
});
