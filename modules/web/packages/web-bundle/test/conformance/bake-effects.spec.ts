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

// Conformance — CSS effects onto native items (ADR 415), end to end: an HTML
// fixture with opacity, mix-blend-mode, isolation, a drop-shadow filter, an
// inset box shadow, a clip-path, a gradient mask and a blur rendered by the
// REAL Blitz engine wasm, baked through the REAL headless host (real
// canvas-wasm) in one batch, and read back from the document: the native
// items carry the blend modes, opacities and effects, the groups exist, and
// what has no native twin is reported.

import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { bakeWebFrameToDocument } from "../../src/bake-to-document";
import {
  engineExtras,
  parseFlowResult,
  parseSceneLayer,
  type WebEngine,
} from "../../src/engine-loader";
import { writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { blitzPresent, requireBlitz } from "./blitz";
import { openHost } from "./host";

requireBlitz("web conformance — CSS effects bake to native items");

const HTML =
  '<div class="fade"><p>Faded</p></div>' +
  '<div class="mul"></div>' +
  '<div class="shadow"></div>' +
  '<div class="inset"></div>' +
  '<div class="clip"></div>' +
  '<div class="mask"></div>' +
  '<div class="blur"></div>' +
  '<div class="both"></div>';
const CSS =
  // Two rows of boxes: everything inside the default 240 x 180 pt frame.
  "body{margin:0;display:flex;flex-wrap:wrap}div{width:64px;height:40px;margin:0 8px 8px 0}p{margin:0;font-size:14px}" +
  ".fade{opacity:0.5;background:#ff0000}" +
  ".mul{mix-blend-mode:multiply;background:#0000ff}" +
  ".shadow{filter:drop-shadow(4px 4px 0px rgba(0,0,0,0.5));background:#00ff00}" +
  ".inset{box-shadow:inset 4px 3px 6px rgba(0,0,0,0.6);background:#ffff00}" +
  ".clip{clip-path:circle(20px);background:#ff00ff}" +
  ".mask{mask-image:linear-gradient(to bottom,black,transparent);background:#00ffff}" +
  ".blur{filter:blur(3px);background:#888888}" +
  ".both{clip-path:inset(4px);mask-image:linear-gradient(black,transparent);mix-blend-mode:screen;background:#123456}";

/** Every node of the scene tree, depth first. */
function flatten(nodes: readonly SceneTreeNode[]): SceneTreeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}

describe.skipIf(!blitzPresent)(
  "web conformance — CSS effects bake to native items (real host + real Blitz)",
  () => {
    let h: HeadlessHost;
    let frame: ElementId;
    let engine: WebEngine;

    beforeAll(async () => {
      h = await openHost();
      await h.load(W1_EMPTY_PAGE.bytes());
      h.loadBundle(webBundle);
      const insert = h.contributions.find(
        (x) =>
          x.kind === "command" &&
          x.id === "media.paged.web.command.insertWebFrame",
      )!.value as { handler: (a: unknown) => unknown };
      await insert.handler(undefined);
      frame = h.host.selection.get()[0];
      await writeWebSource(h.host, frame, {
        ...DEFAULT_SOURCE,
        html: HTML,
        css: CSS,
      });
      const glue = (await import(
        new URL("../../bin/blitz_web.js", import.meta.url).href
      )) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_frame: (html: string, w: number, h: number) => string;
        render_web_flow: (
          html: string,
          framesJson: string,
          flowRoot: string,
        ) => string;
      };
      glue.initSync({
        module: readFileSync(
          new URL("../../bin/blitz_web_bg.wasm", import.meta.url),
        ),
      });
      engine = {
        ...engineExtras(glue as never),
        render: (html, w, hh) =>
          parseSceneLayer(glue.render_web_frame(html, w, hh)),
        renderFlow: (html, frames, flowRoot) =>
          parseFlowResult(
            glue.render_web_flow(html, JSON.stringify(frames), flowRoot ?? ""),
          ),
      };
    });
    afterAll(() => h?.dispose());

    it("an HTML fixture's CSS effects land on native items in one applied batch @feat:plugin-web.css-effects", async () => {
      const before = flatten(await h.host.document.tree());
      const outcome = await bakeWebFrameToDocument(h.host, frame, engine);
      const messages = outcome.diagnostics.map((d) => d.message).join(" | ");
      expect(messages).not.toMatch(/refused/);
      expect(outcome.baked).toBe(true);

      // What has no native twin is reported, nothing else is.
      expect(outcome.deferred).toEqual({ "filter.blur": 1 });

      const after = flatten(await h.host.document.tree());
      const added = after.filter(
        (n) =>
          n.id &&
          !before.some((b) => JSON.stringify(b.id) === JSON.stringify(n.id)),
      );
      const props = new Map<string, Map<string, unknown>>();
      for (const n of added) {
        const p = await h.host.document.elementProperties(n.id!);
        props.set(
          JSON.stringify(n.id),
          new Map((p?.entries ?? []).map((e) => [e.path, e.value?.value])),
        );
      }
      const withProp = (path: string, value?: unknown) =>
        added.filter((n) => {
          const v = props.get(JSON.stringify(n.id))?.get(path);
          return value === undefined
            ? v !== undefined && v !== null
            : v === value;
        });

      // opacity: the red box and its text are one native group at 50 %.
      const groups = added.filter((n) => n.id!.kind === "group");
      expect(withProp("frameOpacity", 50).map((n) => n.id!.kind)).toEqual([
        "group",
      ]);
      // mix-blend-mode: the blue box multiplies.
      expect(
        withProp("frameBlendMode", "Multiply").map((n) => n.id!.kind),
      ).toEqual(["rectangle"]);
      // filter: drop-shadow(): the green box casts a native drop shadow of
      // 3 pt x 3 pt (4 px) at 50 %.
      const dropped = withProp("frameDropShadowOpacity", 50);
      expect(dropped).toHaveLength(1);
      expect(
        props.get(JSON.stringify(dropped[0].id))?.get("frameDropShadowXOffset"),
      ).toBeCloseTo(3, 3);
      // box-shadow: inset: the yellow box carries a native inner shadow,
      // composited Normal, at 60 %, 3.75 pt from (3 pt, 2.25 pt).
      const inner = withProp("frameInnerShadowOpacity", 60);
      expect(inner).toHaveLength(1);
      const ip = props.get(JSON.stringify(inner[0].id))!;
      expect(ip.get("frameInnerShadowBlendMode")).toBe("Normal");
      expect(ip.get("frameInnerShadowDistance")).toBeCloseTo(3.75, 2);
      // clip-path: clip groups — one of them, around a masked box, screens.
      expect(groups).toHaveLength(3);
      expect(withProp("groupClip", true)).toHaveLength(2);
      expect(
        withProp("frameBlendMode", "Screen").map((n) => n.id!.kind),
      ).toEqual(["group"]);

      // mask-image: each gradient rectangle became its box's opacity mask —
      // no longer a page item of its own: eight boxes, two clip paths.
      expect(added.filter((n) => n.id!.kind === "rectangle")).toHaveLength(8);
      expect(added.filter((n) => n.id!.kind === "polygon")).toHaveLength(2);
      // One undo step takes all of it back.
      await h.host.document.undo();
      const undone = flatten(await h.host.document.tree());
      expect(undone.length).toBe(before.length);
    });

    it("the engine reports each element's effect group beside the layer", () => {
      const layer = engine.render(
        `<html><head><style>${CSS}</style></head><body>${HTML}</body></html>`,
        200,
        400,
      );
      expect(layer).not.toBeNull();
      const [effects] = engine.takeEffects!();
      const blends = effects.groups.map((g) => g.blend).filter(Boolean);
      expect(blends).toEqual(["Multiply", "Screen"]);
      const mask = effects.groups.find((g) => (g.mask ?? []).length > 0);
      expect(mask?.mask?.[0].kind).toBe("fillPathGradient");
      expect(effects.groups.some((g) => g.clip !== undefined)).toBe(true);
    });
  },
);
