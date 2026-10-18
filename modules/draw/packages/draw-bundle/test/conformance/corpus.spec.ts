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

// Conformance — corpus parse + geometry round-trips. Every fixture in
// the corpus parses through the REAL engine and its path items expose
// the anchor table the draw planners read. This is the floor the replay
// specs stand on: if a fixture's geometry doesn't round-trip, a plan
// replayed against it would be meaningless.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { CORPUS, F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

describe("draw conformance — corpus geometry round-trips", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
  });
  afterAll(() => h?.dispose());

  it("boots a real engine pinned to the vendored wire protocol", () => {
    expect(h.protocolVersion).toBeGreaterThan(0);
    expect(h.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Per-fixture: parses, returns one page, and each declared path item
  // exposes an anchor table of the authored size. The headless host
  // supports RELOAD, so every fixture reuses the file-level host (one
  // wasm boot per suite-file, not per fixture).
  for (const fx of CORPUS) {
    describe(`fixture: ${fx.id} — ${fx.about}`, () => {
      it("parses and returns the page", async () => {
        const pages = await h.load(fx.bytes());
        expect(pages).toEqual([fx.pageId]);
      });

      it("exposes each path item's anchor table", async () => {
        await h.load(fx.bytes());
        if (fx.ids.polygon) {
          const r = await h.host.document.pathAnchors({
            kind: "polygon",
            id: fx.ids.polygon,
          } as never);
          expect(r).not.toBeNull();
          expect(r!.anchors.length).toBeGreaterThanOrEqual(2);
        }
        if (fx.ids.graphicLine) {
          const r = await h.host.document.pathAnchors({
            kind: "graphicLine",
            id: fx.ids.graphicLine,
          } as never);
          expect(r).not.toBeNull();
          expect(r!.anchors.length).toBeGreaterThanOrEqual(2);
        }
      });
    });
  }

  it("F1 multi-shape: the scene tree carries all three leaves", async () => {
    await h.load(F1_MULTI_SHAPE.bytes());
    const tree = await h.host.document.tree();
    const leaves: string[] = [];
    const walk = (nodes: { id?: { id?: string } | null; children?: unknown[] }[]) => {
      for (const n of nodes) {
        if (n.id?.id) leaves.push(n.id.id);
        if (n.children) walk(n.children as never);
      }
    };
    walk(tree as never);
    expect(leaves.sort()).toEqual(["uline", "upoly", "urect"]);
  });

  it("F1 open polygon: anchor coordinates round-trip verbatim", async () => {
    await h.load(F1_MULTI_SHAPE.bytes());
    const r = await h.host.document.pathAnchors({
      kind: "polygon",
      id: F1_MULTI_SHAPE.ids.polygon!,
    } as never);
    expect(r!.anchors.map((a) => a.anchor)).toEqual([
      [100, 400],
      [250, 600],
      [400, 400],
    ]);
    // Open contour: the single subpath is flagged open (the close-edge
    // add hit-zone is suppressed for it).
    expect(r!.subpathOpen).toEqual([true]);
  });

  it("F3 curved polygon: real Bezier handles survive the round-trip", async () => {
    const { F3_CURVED_OPEN } = await import("../fixtures/corpus");
    await h.load(F3_CURVED_OPEN.bytes());
    const r = await h.host.document.pathAnchors({
      kind: "polygon",
      id: F3_CURVED_OPEN.ids.polygon!,
    } as never);
    // The outgoing handle on anchor 0 is distinct from the anchor (a
    // genuine curve, not a collapsed corner) — the add tool must split
    // it curve-preservingly.
    expect(r!.anchors[0].right).not.toEqual(r!.anchors[0].anchor);
    expect(r!.anchors[1].left).not.toEqual(r!.anchors[1].anchor);
  });
});
