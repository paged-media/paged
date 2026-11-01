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

// TEXT TO VECTOR and GENERATIVE RECOLOR (WP8.3, draw ADR 369) through the
// REAL engine. The agent is the host's typed command `paged.ai.complete`,
// registered here with a scripted answer (no model, no key); the local
// image model is the SDK's `fakeMlProvider`. What is asserted: what is
// asked, what is refused, what lands, and that ONE undo takes it back.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type {
  ElementId,
  MutationInput,
  ObjectModelContribution,
} from "@paged-media/plugin-api";
import {
  fakeMlProvider,
  mlUnavailable,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  applyGenerativeRecolor,
  applyTextToVector,
  drawBundle,
  extractSvg,
  leafIdsOf,
  parseColorMap,
  recolorPromptFor,
  svgPromptFor,
  svgRefusal,
  type ArtworkColor,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { squareItem } from "../panels/panel-document";
import { openHost } from "./host";
import { installPngRealm } from "./raster-realm";

const P = (id: string) => ({ kind: "polygon", id }) as ElementId;
const A = P("ga");
const B = P("gb");

const doc = () =>
  packageWithSpread(
    squareItem("ga", 40, 40, 60) + squareItem("gb", 140, 40, 60),
  );

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="sky"><stop offset="0" stop-color="#112244"/><stop offset="1" stop-color="#ff8844"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="300" fill="url(#sky)"/>
  <polygon points="200,316 256,120 312,316" fill="#eeeeee"/>
  <circle cx="400" cy="90" r="40" fill="#ffee88"/>
</svg>`;

const swatch = (
  selfId: string,
  name: string,
  value: number[],
): MutationInput => ({
  op: "createSwatch",
  args: { spec: { selfId, name, space: "RGB", value } },
});
const fill = (id: ElementId, ref: string): MutationInput => ({
  op: "setElementProperty",
  args: {
    elementId: id,
    path: "frameFillColor",
    value: { type: "colorRef", value: ref },
  },
});
async function refOf(h: HeadlessHost, id: ElementId): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  return (
    props?.entries.find((e) => e.path === "frameFillColor")?.value?.value ??
    null
  );
}

/** The host's `paged.ai.complete` (plugin-sdk ADR 325), answered by a script. */
const aiObjectModel = (
  complete: (prompt: string) => Promise<{ text: string }>,
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
      async handler(_ctx, args) {
        return (await complete((args as { prompt: string }).prompt)).text;
      },
    },
  ],
});

const color = (
  ref: string,
  rgb: [number, number, number],
  weight = 1,
): ArtworkColor => ({
  ref,
  name: ref,
  rgb,
  model: "process",
  weight,
});

describe("the pure halves", () => {
  it("extracts the SVG from a fenced, chatty answer", () => {
    expect(extractSvg("Here you go:\n```svg\n" + SVG + "\n```\nEnjoy!")).toBe(
      SVG,
    );
    expect(extractSvg("no drawing here")).toBeNull();
    expect(extractSvg("<svg></svg2>")).toBeNull();
  });

  it("refuses anything active or external, accepts a plain drawing", () => {
    expect(svgRefusal(SVG)).toBeNull();
    for (const bad of [
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/x)"/></svg>`,
      `<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:x()"/></svg>`,
    ]) {
      expect(svgRefusal(bad), bad).not.toBeNull();
    }
  });

  it("the SVG prompt carries the subject and the safety rules", () => {
    const p = svgPromptFor("a red fox");
    expect(p).toContain("Subject: a red fox");
    expect(p).toContain("no <script>");
  });

  it("a colour map keeps known refs and valid colours only, normalised", () => {
    const colors = [
      color("Color/a", [255, 0, 0]),
      color("Color/b", [0, 0, 255]),
    ];
    const reply =
      'Sure! {"Color/a": "#0F0", "Color/b": "not a colour", "Color/zzz": "#123456", "Color/x": 4}';
    expect(parseColorMap(reply, colors)).toEqual({ "Color/a": "#00ff00" });
    expect(parseColorMap("nothing", colors)).toEqual({});
    expect(parseColorMap("[1,2]", colors)).toEqual({});
    expect(recolorPromptFor(colors, "autumn")).toContain('"Color/a": #ff0000');
  });
});

describe("generation in draw on the real engine (WP8.3)", () => {
  let h: HeadlessHost;
  let uninstall: () => void;
  let prompts: string[];
  let answer: (prompt: string) => string;
  let ai: { dispose(): void } | null = null;

  beforeAll(async () => {
    uninstall = installPngRealm();
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => {
    h?.dispose();
    uninstall?.();
  });
  beforeEach(async () => {
    await h.load(doc());
    await h.host.selection.set([]);
    prompts = [];
    answer = () => SVG;
    ai?.dispose();
    ai = h.objects.register({
      plugin: "paged.ai",
      model: aiObjectModel(async (prompt) => {
        prompts.push(prompt);
        return { text: answer(prompt) };
      }),
    });
  });

  it("route 1: the agent's SVG lands as native artwork, selected, in ONE undo step", async () => {
    covers("command:media.paged.draw.command.textToVector");
    const before = leafIdsOf(await h.host.document.tree()).length;
    const out = await applyTextToVector(h.host, {
      prompt: "a mountain at dusk",
      route: "agent",
    });
    expect(out.applied).toBe(true);
    expect(out.route).toBe("agent");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Subject: a mountain at dusk");
    expect(leafIdsOf(await h.host.document.tree()).length).toBeGreaterThan(
      before,
    );
    expect(h.host.selection.get().length).toBe(1);
    await h.host.document.undo();
    expect(leafIdsOf(await h.host.document.tree()).length).toBe(before);
  });

  it("an SVG with anything active is refused and nothing is imported", async () => {
    covers("command:media.paged.draw.command.textToVector");
    answer = () =>
      `<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><rect width="9" height="9"/></svg>`;
    const before = leafIdsOf(await h.host.document.tree()).length;
    const out = await applyTextToVector(h.host, {
      prompt: "anything",
      route: "agent",
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("script");
    expect(leafIdsOf(await h.host.document.tree()).length).toBe(before);
  });

  it("an empty prompt and a missing agent are refused in words", async () => {
    covers("command:media.paged.draw.command.textToVector");
    expect(
      (await applyTextToVector(h.host, { prompt: "  " })).reason,
    ).toContain("prompt is empty");
    ai?.dispose();
    ai = null;
    const out = await applyTextToVector(h.host, {
      prompt: "x",
      route: "agent",
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("no Claude agent");
  });

  it("route 2: with no model running the registry's sentence is the refusal", async () => {
    covers("command:media.paged.draw.command.textToVector");
    const out = await applyTextToVector(h.host, {
      prompt: "x",
      route: "image",
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toContain(mlUnavailable("generate"));
  });

  it("route 2: ml.generate's picture is placed in a frame and traced into vector artwork", async () => {
    covers("command:media.paged.draw.command.textToVector");
    const fake = fakeMlProvider({ tier: "B", capabilities: ["generate"] });
    const handle = h.ml.register(fake);
    fake.attach(handle);
    const before = leafIdsOf(await h.host.document.tree()).length;
    const out = await applyTextToVector(h.host, {
      prompt: "a cat",
      route: "image",
    });
    const asked = fake.calls[0]!.request as { prompt: string };
    expect(asked.prompt).toContain("a cat");
    expect(asked.prompt).toContain("flat vector illustration");
    // The picture frame and the traced artwork are in the document.
    expect(leafIdsOf(await h.host.document.tree()).length).toBeGreaterThan(
      before,
    );
    expect(out.route).toBe("image");
    expect(out.ids.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it("auto: the agent failing falls back to the generated picture", async () => {
    covers("command:media.paged.draw.command.textToVector");
    ai?.dispose();
    ai = null;
    const fake = fakeMlProvider({ tier: "B", capabilities: ["generate"] });
    const handle = h.ml.register(fake);
    fake.attach(handle);
    const out = await applyTextToVector(h.host, { prompt: "a dog" });
    expect(out.route).toBe("image");
    expect(fake.calls).toHaveLength(1);
    handle.dispose();
  });

  describe("Generative recolor", () => {
    beforeEach(async () => {
      await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            swatch("Color/ured", "#ff0000", [255, 0, 0]),
            swatch("Color/ublue", "#0000ff", [0, 0, 255]),
            fill(A, "Color/ured"),
            fill(B, "Color/ublue"),
          ] as never,
        },
      });
      await h.host.selection.set([A, B]);
    });

    it("applies the agent's colour map with Recolor Artwork, one undo step; unknown refs and bad colours are dropped", async () => {
      covers("command:media.paged.draw.command.generativeRecolor");
      answer = () =>
        '{"Color/ured": "#22aa44", "Color/ublue": "banana", "Color/nope": "#000000"}';
      const out = await applyGenerativeRecolor(h.host, {
        prompt: "make it green",
      });
      expect(out.applied).toBe(true);
      expect(out.changed).toBe(1);
      expect(prompts[0]).toContain('"Color/ured": #ff0000');
      expect(prompts[0]).toContain("Wish: make it green");
      expect(await refOf(h, A)).not.toBe("Color/ured");
      expect(await refOf(h, B)).toBe("Color/ublue");
      const [display] = await h.host.document.swatchDisplay([
        String(await refOf(h, A)),
      ]);
      expect(display?.rgbHex.toLowerCase()).toBe("#22aa44");
      await h.host.document.undo();
      expect(await refOf(h, A)).toBe("Color/ured");
    });

    it("an answer without a usable map, or a selection without colour, changes nothing", async () => {
      covers("command:media.paged.draw.command.generativeRecolor");
      answer = () => "I would make it warmer.";
      const bad = await applyGenerativeRecolor(h.host, { prompt: "warmer" });
      expect(bad.applied).toBe(false);
      expect(bad.reason).toContain("no usable colour map");
      expect(await refOf(h, A)).toBe("Color/ured");
      await h.host.selection.set([]);
      const none = await applyGenerativeRecolor(h.host, { prompt: "x" });
      expect(none.reason).toContain("no colour");
      expect(prompts).toHaveLength(1);
    });
  });
});
