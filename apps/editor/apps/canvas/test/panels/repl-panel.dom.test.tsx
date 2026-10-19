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

// REPL (paged.repl): one line, parsed (src/repl/parser.ts) and sent
// through the client: set, inspect, undo, redo. Each command is asserted
// as the wire message, the model after it and the log line.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ReplPanel } from "../../src/panels/repl-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ReplPanel, { id: "paged.repl", scene: richScene });

const entries = (h: H) =>
  [...h.root.querySelectorAll("[data-repl-entry]")].map((e) => ({
    prompt: e.firstElementChild?.textContent?.replace(/^›/, ""),
    result: e.querySelector("[data-repl-result]")?.textContent ?? "",
  }));

async function run(h: H, line: string, via: "enter" | "button" = "enter") {
  const input = h.root.querySelector<HTMLInputElement>("[data-repl-input]")!;
  await h.user.clear(input);
  if (via === "enter") await h.user.type(input, `${line}{Enter}`);
  else {
    await h.user.type(input, line);
    await h.user.click(h.root.querySelector("[data-repl-submit]")!);
  }
  await h.settle();
}

describe("REPL panel", () => {
  test("an empty log shows the hint", async () => {
    covers("panel:paged.repl");
    const h = await mount();
    expect(h.root.querySelector("[data-repl-log]")?.textContent).toContain(
      "inspect textFrame:",
    );
    expect(entries(h)).toEqual([]);
  });

  test("set: one setElementProperty, the model follows, the log says ok", async () => {
    covers("panel:paged.repl");
    const h = await mount();
    const id = String(h.scene.rect.id);
    const from = h.mark();
    await run(h, `set rectangle:${id} frameStrokeWeight length:3`);
    expect(h.mutations(from)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: h.scene.rect,
          path: "frameStrokeWeight",
          value: { type: "length", value: 3 },
        },
      },
    ] as never);
    expect(await h.get(`rectangle:${id}`, "frameStrokeWeight")).toEqual({
      type: "length",
      value: 3,
    });
    expect(entries(h).at(-1)?.result).toBe("ok (setElementProperty)");
  });

  test("undo and redo go to the engine and the log says so", async () => {
    covers("panel:paged.repl");
    const h = await mount();
    const id = String(h.scene.rect.id);
    const before = await h.get(`rectangle:${id}`, "frameStrokeWeight");
    await run(h, `set rectangle:${id} frameStrokeWeight length:6`);
    let from = h.mark();
    await run(h, "undo");
    expect(h.sent("undo", from)).toHaveLength(1);
    expect(await h.get(`rectangle:${id}`, "frameStrokeWeight")).toEqual(before);
    expect(entries(h).at(-1)?.result).toBe("ok (undo)");
    from = h.mark();
    await run(h, "redo", "button");
    expect(h.sent("redo", from)).toHaveLength(1);
    expect(await h.get(`rectangle:${id}`, "frameStrokeWeight")).toEqual({
      type: "length",
      value: 6,
    });
    expect(entries(h).at(-1)?.result).toBe("ok (redo)");
  });

  test("inspect: reads the element's properties into the log", async () => {
    covers("panel:paged.repl");
    const h = await mount();
    const from = h.mark();
    await run(h, `inspect rectangle:${String(h.scene.rect.id)}`);
    expect(h.sent("requestElementProperties", from)).toHaveLength(1);
    const result = entries(h).at(-1)!.result;
    expect(JSON.parse(result)).toMatchObject({ kind: "Rectangle" });
  });

  test("a line the parser refuses is reported and sends nothing", async () => {
    covers("panel:paged.repl");
    const h = await mount();
    const from = h.mark();
    await run(h, "frobnicate everything");
    expect(entries(h).at(-1)?.result).toBe(
      "error: unknown command: frobnicate",
    );
    expect(h.sent(undefined, from)).toEqual([]);
  });

  test("an empty line does nothing", async () => {
    covers("panel:paged.repl");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector("[data-repl-submit]")!);
    expect(entries(h)).toEqual([]);
    expect(h.sent(undefined, from)).toEqual([]);
  });
});
