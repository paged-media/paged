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

// The GENERATIVE panel (WP8.3, draw ADR 369), RENDERED (happy-dom) against
// the real engine: a prompt and a button per job, the same commands behind
// them, one undo step each, and the host's refusal shown as it was said.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type {
  ElementId,
  ObjectModelContribution,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { drawBundle, GENERATIVE_PANEL_ID, leafIdsOf } from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { openHost } from "../headless/host";
import {
  mountContributed,
  settle,
  squareItem,
  teardownPanels,
} from "./harness";

const A = { kind: "polygon", id: "pa" } as ElementId;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#336699"/></svg>`;

const aiModel = (
  complete: (prompt: string) => string,
): ObjectModelContribution => ({
  kinds: [],
  commands: [
    {
      id: "paged.ai.complete",
      title: "Ask Claude for text",
      args: {
        kind: "struct",
        fields: { prompt: { kind: "text", multiline: true } },
      },
      result: { kind: "text", multiline: true },
      handler: async (_ctx, args) =>
        complete((args as { prompt: string }).prompt),
    },
  ],
});

describe("the Generative panel", () => {
  let h: HeadlessHost;
  let ai: { dispose(): void } | null = null;
  let answer: (prompt: string) => string;
  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(packageWithSpread(squareItem("pa", 40, 40, 60)));
    await h.host.selection.set([]);
    answer = () => SVG;
    ai?.dispose();
    ai = h.objects.register({
      plugin: "paged.ai",
      model: aiModel((p) => answer(p)),
    });
  });
  afterEach(() => teardownPanels(h));

  it("Text to vector: the Draw button needs a prompt, draws the agent's SVG in one undo step", async () => {
    covers("panel:media.paged.draw.panel.generative");
    const panel = await mountContributed(h, GENERATIVE_PANEL_ID);
    expect(panel.disabled("[data-draw-generative-draw]")).toBe(true);
    panel.change("[data-draw-generative-subject]", "a blue square");
    await settle();
    expect(panel.disabled("[data-draw-generative-draw]")).toBe(false);
    const before = leafIdsOf(await h.host.document.tree()).length;
    panel.change("[data-draw-generative-route]", "agent");
    await panel.click("[data-draw-generative-draw]");
    await settle();
    expect(leafIdsOf(await h.host.document.tree()).length).toBeGreaterThan(
      before,
    );
    await h.host.document.undo();
    expect(leafIdsOf(await h.host.document.tree()).length).toBe(before);
  });

  it("a refusal (no agent) is shown in the panel, in the host's words", async () => {
    covers("panel:media.paged.draw.panel.generative");
    ai?.dispose();
    ai = null;
    const panel = await mountContributed(h, GENERATIVE_PANEL_ID);
    panel.change("[data-draw-generative-subject]", "anything");
    panel.change("[data-draw-generative-route]", "agent");
    await settle();
    await panel.click("[data-draw-generative-draw]");
    await settle();
    expect(panel.text()).toContain("no Claude agent");
  });

  it("Generative recolor: the wish is sent, the selection's colour changes in one undo step", async () => {
    covers("panel:media.paged.draw.panel.generative");
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "createSwatch",
            args: {
              spec: {
                selfId: "Color/ugr",
                name: "#ff0000",
                space: "RGB",
                value: [255, 0, 0],
              },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: A,
              path: "frameFillColor",
              value: { type: "colorRef", value: "Color/ugr" },
            },
          },
        ] as never,
      },
    });
    await h.host.selection.set([A]);
    answer = () => '{"Color/ugr":"#003366"}';
    const panel = await mountContributed(h, GENERATIVE_PANEL_ID);
    expect(panel.disabled("[data-draw-generative-recolor]")).toBe(true);
    panel.change("[data-draw-generative-wish]", "deep navy");
    await settle();
    await panel.click("[data-draw-generative-recolor]");
    await settle();
    const props = await h.host.document.elementProperties(A);
    const ref = props?.entries.find((e) => e.path === "frameFillColor")?.value
      ?.value;
    expect(ref).not.toBe("Color/ugr");
    await h.host.document.undo();
    const back = await h.host.document.elementProperties(A);
    expect(
      back?.entries.find((e) => e.path === "frameFillColor")?.value?.value,
    ).toBe("Color/ugr");
  });
});
