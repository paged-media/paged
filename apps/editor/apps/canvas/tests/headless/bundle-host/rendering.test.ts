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

// THE BUNDLEHOST CONTRACT — drawing into the document and the remaining
// reads: `contribute.sceneLayer`, `host.overlay`, `host.assets.registerFont`
// / `registerDocumentFont`, typed commands through `host.objects`,
// `contribute.bindingProvider`, and the document reads not covered in
// document.test.ts (pathAnchors, elementProperties, frameChain,
// placeholders, snapPoint, planarRegions, mutateWithBytes). What plugin-api
// documents, on every adapter it applies to (hosts.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { ElementId } from "@paged-media/plugin-api";
import {
  buildFixtureIdml,
  polygon,
  rect,
  textFrame,
} from "@paged-media/test-kit";

import {
  PROBE_ID,
  editorAdapter,
  headlessAdapter,
  probeManifest,
  type HostUnderTest,
} from "./hosts";

const DOC = buildFixtureIdml({
  name: "bundle-host-rendering",
  pages: [
    {
      id: "pg1",
      items: [
        rect("ubox", [100, 72, 200, 272]),
        rect("ubox2", [150, 150, 260, 350]),
        polygon(
          "utri",
          [
            [72, 600],
            [144, 680],
            [216, 600],
          ],
          true,
        ),
        textFrame("utf", [300, 72, 400, 400], "ust"),
      ],
    },
  ],
  stories: [{ id: "ust", paragraphs: ["Hello world"] }],
});
const BOX = { kind: "rectangle", id: "ubox" } as ElementId;
const BOX2 = { kind: "rectangle", id: "ubox2" } as ElementId;
const TRI = { kind: "polygon", id: "utri" } as ElementId;

/** A face the engine can register (the editor's own default face). */
const INTER = new Uint8Array(
  readFileSync(new URL("../../../public/fonts/Inter.ttf", import.meta.url)),
);

const ADAPTERS = [
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
] as const;

// ── the remaining document reads ─────────────────────────────────────

describe.each(ADAPTERS)("host.document reads — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("pathAnchors reads a path's anchors; elementProperties a frame's properties; unknown ids are null", async () => {
    const anchors = await t.host.document.pathAnchors(TRI);
    expect(anchors).not.toBeNull();
    expect(JSON.stringify(anchors)).toContain("144");
    const props = await t.host.document.elementProperties(BOX);
    expect(props).not.toBeNull();
    expect(
      await t.host.document.elementProperties({
        kind: "rectangle",
        id: "nope",
      } as ElementId),
    ).toBeNull();
  });

  test("frameChain: a one-frame story is one link with no next; an unknown story none", async () => {
    const chain = await t.host.document.frameChain("ust");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.next ?? null).toBeNull();
    expect(await t.host.document.frameChain("nope")).toEqual([]);
  });

  test("placeholders: none in a document without fields", async () => {
    expect(await t.host.document.placeholders()).toEqual([]);
  });

  test("snapPoint never throws and answers a point", async () => {
    const r = await t.host.document.snapPoint({
      pageId: "pg1",
      point: [73, 101],
    } as never);
    expect(Array.isArray((r as { point?: unknown }).point)).toBe(true);
  });

  test("planarRegions of two overlapping frames finds faces; an unresolvable id is a refusal, not an empty list", async () => {
    const r = await t.host.document.planarRegions([BOX, BOX2]);
    expect(r.found).toBe(true);
    const bad = await t.host.document.planarRegions([
      { kind: "rectangle", id: "nope" } as ElementId,
    ]);
    expect(bad.found).toBe(false);
  });

  test("mutateWithBytes without a bytes slot is refused, never applied without them", async () => {
    const out = await t.host.document.mutateWithBytes(
      {
        op: "setElementProperty",
        args: {
          elementId: BOX,
          path: "frameOpacity",
          value: { type: "length", value: 40 },
        },
      } as never,
      new Uint8Array([1, 2, 3]),
    );
    expect(out.applied).toBe(false);
  });
});

// ── typed commands through host.objects ──────────────────────────────

describe.each(ADAPTERS)(
  "contribute.objectModel typed commands — %s",
  (_name, make) => {
    let t: HostUnderTest;
    const MODEL_ID = "media.paged.probemodel";
    beforeAll(async () => {
      t = await make();
      await t.load(DOC);
    });
    afterAll(async () => {
      await t.dispose();
    });

    test("a declared typed command is listed and runs through host.objects with its args; an undeclared one is refused", async () => {
      const h = t.withManifest(
        probeManifest(MODEL_ID, {
          contributes: {
            objectModel: {
              kinds: [],
              commands: [
                {
                  id: `${MODEL_ID}.double`,
                  title: "Double",
                  args: {
                    kind: "struct",
                    fields: { n: { kind: "number" } },
                  },
                },
              ],
            },
          },
        }),
      );
      const handle = h.contribute.objectModel({
        kinds: [],
        commands: [
          {
            id: `${MODEL_ID}.double`,
            title: "Double",
            args: { kind: "struct", fields: { n: { kind: "number" } } },
            handler: (_ctx, args) => (args as { n: number }).n * 2,
          },
        ],
      });
      const listed = (await h.objects.commands()).map((c) => c.id);
      expect(listed).toContain(`${MODEL_ID}.double`);
      expect(await h.objects.invoke(`${MODEL_ID}.double`, { n: 21 })).toBe(42);
      expect(() =>
        h.contribute.objectModel({
          kinds: [],
          commands: [
            {
              id: `${MODEL_ID}.undeclared`,
              title: "x",
              args: { kind: "struct", fields: {} },
              handler: () => 0,
            },
          ],
        }),
      ).toThrow(/objectModel/);
      handle.dispose();
      expect((await h.objects.commands()).map((c) => c.id)).not.toContain(
        `${MODEL_ID}.double`,
      );
    });
  },
);

// ── bindingProvider ──────────────────────────────────────────────────

describe.each(ADAPTERS)("contribute.bindingProvider — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a provider needs an edit context this bundle registered", () => {
    expect(() =>
      t.host.contribute.bindingProvider("probeFrame", {} as never),
    ).toThrow(/editContext/);
    const ctx = t.host.contribute.editContext({
      type: "probeFrame",
      entry: "doubleClick",
      matches: () => false,
    });
    const p = t.host.contribute.bindingProvider("probeFrame", {
      provides: { paths: ["frameOpacity"] },
      readProperty: () => null,
    } as never);
    expect(typeof p.dispose).toBe("function");
    p.dispose();
    ctx.dispose();
  });
});

// ── scene layers, image resources, overlay, fonts — the editor ───────

describe("contribute.sceneLayer, host.images, host.overlay, host.assets — the editor", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a scene layer submits into a frame, reports no fallback for a resolved face, and clears", async () => {
    expect(t.host.supports("rendering.sceneLayer@1")).toBe(true);
    const surface = t.host.contribute.sceneLayer();
    const result = await surface.submit("ubox", {
      items: [
        {
          kind: "fillPath",
          path: [
            { op: "moveTo", x: 0, y: 0 },
            { op: "lineTo", x: 50, y: 0 },
            { op: "lineTo", x: 50, y: 20 },
            { op: "close" },
          ],
          paint: { r: 1, g: 0, b: 0, a: 1 },
        },
      ],
    });
    expect(result.fontFallbacks).toEqual([]);
    await surface.clear("ubox");
    surface.dispose();
  });

  test("submitImageTiles before any submitImage rejects", async () => {
    const surface = t.host.contribute.sceneLayer();
    await expect(
      surface.submitImageTiles("ubox", [
        { x: 0, y: 0, width: 1, height: 1, rgba: new Uint8Array(4) },
      ]),
    ).rejects.toThrow();
    surface.dispose();
  });

  test("a scene layer needs capabilities.rendering ∋ sceneLayer", () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenoscene", {
        capabilities: { rendering: ["overlay"] },
      }),
    );
    expect(() => narrow.contribute.sceneLayer()).toThrow(/sceneLayer/);
  });

  test("an overlay layer id is unique while live and free again once disposed", () => {
    const a = t.host.overlay.layer("marks");
    expect(a.id).toBe("marks");
    expect(() => t.host.overlay.layer("marks")).toThrow();
    a.set([]);
    a.clear();
    a.dispose();
    const b = t.host.overlay.layer("marks");
    b.dispose();
    // Generated ids differ.
    const c = t.host.overlay.layer();
    const d = t.host.overlay.layer();
    expect(c.id).not.toBe(d.id);
    c.dispose();
    d.dispose();
  });

  test("the overlay needs capabilities.rendering ∋ overlay", () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenooverlay", {
        capabilities: { rendering: [] },
      }),
    );
    expect(() => narrow.overlay.setToolPreview(null)).toThrow(/overlay/);
  });

  test("registerFont gives scene text a face until the handle is disposed; it needs capabilities.assets ∋ fonts", async () => {
    const fonts = t.withManifest(
      probeManifest("media.paged.probefaces", {
        capabilities: { assets: ["fonts"], rendering: ["sceneLayer"] },
      }),
    );
    expect(fonts.supports("assets.registerFont@1")).toBe(true);
    const face = await fonts.assets.registerFont(INTER, "Probe Sans");
    expect(typeof face.dispose).toBe("function");
    face.dispose();
    await expect(
      t.host.assets.registerFont(INTER, "Probe Sans"),
    ).rejects.toThrow(/assets/);
  });

  test("registerDocumentFont fills a family the document lacks", async () => {
    expect(t.host.supports("assets.documentFont@2")).toBe(true);
    const fonts = t.withManifest(
      probeManifest("media.paged.probedocface", {
        capabilities: {
          assets: ["fonts"],
          document: { read: "broad", write: "broad" },
        },
      }),
    );
    const out = await fonts.assets.registerDocumentFont(INTER, "Probe Doc");
    expect(out).toMatchObject({ status: "registered" });
    void PROBE_ID;
  });
});

describe("contribute.sceneLayer and host.images, no channel — headless", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await headlessAdapter();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("the scene layer warns and no-ops; the claim is an inert handle; supports false", async () => {
    expect(t.host.supports("rendering.sceneLayer@1")).toBe(false);
    expect(t.host.supports("rendering.resourceProvider@1")).toBe(false);
    const surface = t.host.contribute.sceneLayer();
    const result = await surface.submit("ubox", { items: [] } as never);
    expect(result.fontFallbacks).toEqual([]);
    surface.dispose();
  });
});
