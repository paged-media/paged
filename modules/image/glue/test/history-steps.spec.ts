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

// Editor ADR 285 — while the rasterImage context is active the host's
// History panel lists the image's OWN journal (`historySteps`), and a click
// walks it (`step(delta)`); the in-panel list keeps working beside it.

import { describe, expect, it } from "bun:test";

import { C, bundleOnFake, quiesce } from "./command-kit";

describe("[editor-shell.panels.history] the rasterImage context's history steps", () => {
  it("lists the pixel steps oldest first and steps through them", async () => {
    const k = await bundleOnFake();
    // The steps alone (snapshots head the list: history-presets.spec.ts).
    k.session.setHistoryPrefs({ autoSnapshot: false });
    await k.ingest();
    const ctx = k.contexts.find((c) => c.type === "rasterImage");
    expect(ctx?.historySteps).toBeDefined();

    let changes = 0;
    const off = ctx!.onDidChangeHistory!(() => changes++);
    await k.run(`${C}.rotateCw`);
    await k.run(`${C}.flipHorizontal`);
    const h = ctx!.historySteps!()!;
    expect(h.undo).toEqual(["Rotate 90° clockwise", "Flip horizontal"]);
    expect(h.redo).toEqual([]);
    expect(changes).toBeGreaterThan(0);

    // Back two steps in one call: both become redo steps, next first.
    await h.step(-2);
    await quiesce(k.session);
    const back = ctx!.historySteps!()!;
    expect(back.undo).toEqual([]);
    expect(back.redo).toEqual(["Rotate 90° clockwise", "Flip horizontal"]);

    // Forward one.
    await back.step(1);
    await quiesce(k.session);
    expect(ctx!.historySteps!()!.undo).toEqual(["Rotate 90° clockwise"]);
    // The image's own panel reads the same journal.
    expect(k.session.state().history?.undoSteps).toEqual([
      "Rotate 90° clockwise",
    ]);
    off();
    k.dispose();
  });

  it("answers no list before an image is open", async () => {
    const k = await bundleOnFake({ select: false });
    const ctx = k.contexts.find((c) => c.type === "rasterImage")!;
    expect(ctx.historySteps!()).toBeNull();
    k.dispose();
  });
});
