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

// ADR 289 (D-63): the vector clipboard against the real engine, through
// the keys. What is pinned: Copy writes the selection as an SVG document
// (`paged-svg`, the selection alone — no item of the page's master);
// that SVG, pasted as content from elsewhere, lands the same geometry and
// paint as native page items, centred on the view, selected, as ONE undo
// step; Illustrator's Edit ▸ Copy (recorded by the Illustrator oracle,
// modules/draw/scripts/illustrator/run-clipboard-probe.sh) pastes in place
// as the paths Illustrator drew; what an import approximates is reported.

import { afterEach, describe, expect, test } from "bun:test";

import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import { dumpDiff } from "@paged-media/test-kit/headless";

import { pageItemClipboard } from "../../src/clipboard-commands";
import { createHeadlessEditor, type HeadlessEditor } from "./harness";

const fixture = (name: string) =>
  new URL(`../../test/fixtures/clipboard/${name}`, import.meta.url);
const ILLUSTRATOR_SVG = await Bun.file(
  fixture("clipboard-copy.illustrator.svg"),
).text();
const ILLUSTRATOR = (await Bun.file(
  fixture("clipboard-copy.illustrator.json"),
).json()) as {
  produced_by: { app: string; version: string };
  cases: {
    measured: {
      paths: {
        bounds: [number, number, number, number];
        fill: [number, number, number];
      }[];
    };
  }[];
};

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  pageItemClipboard.set(null);
  await ed?.dispose();
  ed = null;
});

/** A key press runs its command without awaiting it: let it finish. */
async function settle(e: HeadlessEditor): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await e.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
}

type Bounds = [number, number, number, number];
type Dump = Awaited<ReturnType<HeadlessEditor["dump"]>>;

function entry(d: Dump, key: string, path: string): unknown {
  const el = d.elements[key] as unknown as {
    entries: { path: string; value: { value: unknown } }[];
  };
  return el.entries.find((x) => x.path === path)?.value.value;
}

/** `[top, left, bottom, right]` of an element. */
const boundsOf = (d: Dump, key: string) =>
  entry(d, key, "frameBounds") as Bounds;

const added = (before: Dump, after: Dump, kind: string) =>
  Object.keys(after.elements).filter(
    (k) => k.startsWith(`${kind}:`) && !(k in before.elements),
  );

/** The content from elsewhere: no marker, no copy of ours. */
function fromElsewhere(
  e: HeadlessEditor,
  forms: { text: string; svg: string },
) {
  pageItemClipboard.set(null);
  e.hostApp.systemClipboard.html = "";
  e.hostApp.systemClipboard.text = forms.text;
  e.hostApp.systemClipboard.svg = forms.svg;
}

const close = (a: number[], b: number[], digits = 2) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

describe("ADR 289 (D-63): the vector clipboard [editor-shell.vector-clipboard]", () => {
  test("copy → SVG → paste: the same geometry and paint, centred on the view, selected, one undo step", async () => {
    covers("command:paged.edit.copy", "command:paged.edit.paste");
    const e = (ed = await createHeadlessEditor({
      idml: gestureFixture("targets"),
    }));
    await e.select([T.group.id]);
    expect(await e.press("cmd+c")).toBe(true);
    await settle(e);
    const svg = e.hostApp.systemClipboard.svg;
    expect(svg).toStartWith("<svg");
    // The selection alone: its two members, not the master's rectangle.
    expect(svg.match(/<path /g)?.length).toBe(2);
    // No frame text to carry: the plain text is the SVG code.
    expect(e.hostApp.systemClipboard.text).toBe(svg);
    expect(pageItemClipboard.current()?.svg).toBe(svg);

    fromElsewhere(e, { text: "", svg });
    const before = await e.dump();
    expect(await e.press("cmd+v")).toBe(true);
    await settle(e);
    const after = await e.dump();
    expect(e.problems()).toEqual([]);

    // One group of two paths, selected.
    const groups = added(before, after, "group");
    const paths = added(before, after, "polygon");
    expect(groups).toHaveLength(1);
    expect(paths).toHaveLength(2);
    expect(e.state.selection.elementSelection).toEqual([
      (after.elements[groups[0]] as unknown as { id: unknown }).id,
    ]);

    // Equal geometry: each member at the same place relative to its
    // group, the same size, the same paint.
    const src = boundsOf(before, "group:ugroup");
    const dst = boundsOf(after, groups[0]);
    close(
      [dst[2] - dst[0], dst[3] - dst[1]],
      [src[2] - src[0], src[3] - src[1]],
    );
    const rel = (b: Bounds, g: Bounds) => [
      b[0] - g[0],
      b[1] - g[1],
      b[2] - g[0],
      b[3] - g[1],
    ];
    const want = ["rectangle:ugA", "oval:ugB"]
      .map((k) => rel(boundsOf(before, k), src))
      .sort((a, b) => a[1] - b[1]);
    const got = paths
      .map((k) => rel(boundsOf(after, k), dst))
      .sort((a, b) => a[1] - b[1]);
    got.forEach((g, i) => close(g, want[i]));
    for (const k of paths) {
      expect(entry(after, k, "frameStrokeWeight")).toBe(1);
      // Gray (0.7 → #b3b3b3) and black, as RGB swatches.
      expect(entry(after, k, "frameFillColor")).toBe("Color/svg-b3b3b3");
      expect(entry(after, k, "frameStrokeColor")).toBe("Color/svg-000000");
    }
    // Centred on the view (the headless camera: scale 1, 1200 × 800).
    expect((dst[1] + dst[3]) / 2).toBeCloseTo(600, 0);
    expect((dst[0] + dst[2]) / 2).toBeCloseTo(400, 0);

    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("Illustrator's Edit ▸ Copy pastes in place as the paths Illustrator drew, in its colours", async () => {
    covers("command:paged.edit.pasteInPlace");
    const e = (ed = await createHeadlessEditor({
      idml: gestureFixture("targets"),
    }));
    // As Chromium exposes Illustrator's clipboard (ADR 289): the SVG
    // source as plain text, and its sanitised image/svg+xml without the
    // <style> that carries the paint.
    fromElsewhere(e, {
      text: ILLUSTRATOR_SVG,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 230"><rect class="cls-2" width="200" height="100"></rect></svg>',
    });
    const before = await e.dump();
    expect(await e.press("cmd+alt+shift+v")).toBe(true);
    await settle(e);
    const after = await e.dump();
    const paths = added(before, after, "polygon");
    expect(paths).toHaveLength(2);
    // Illustrator's paths, in its frame (left, top, right, bottom), moved
    // by its selection's corner: the SVG's user space starts there, and
    // Paste in place puts it on the page's origin.
    const drawn = ILLUSTRATOR.cases[0].measured.paths;
    const left = Math.min(...drawn.map((p) => p.bounds[0]));
    const top = Math.min(...drawn.map((p) => p.bounds[1]));
    const hex = (c: number[]) =>
      `Color/svg-${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    for (const p of drawn) {
      const [l, t, r, b] = p.bounds;
      const match = paths.find(
        (k) => entry(after, k, "frameFillColor") === hex(p.fill),
      );
      expect(match).toBeDefined();
      close(boundsOf(after, match!), [t - top, l - left, b - top, r - left]);
    }
    expect(e.problems()).toEqual([]);
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("what an SVG import approximates or leaves out is reported, not dropped", async () => {
    covers("command:paged.edit.paste");
    const e = (ed = await createHeadlessEditor({
      idml: gestureFixture("targets"),
    }));
    fromElsewhere(e, {
      text: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
        <filter id="b"><feGaussianBlur stdDeviation="3"/></filter>
        <rect width="50" height="50" fill="#ff0000" filter="url(#b)"/></svg>`,
      svg: "",
    });
    await e.invoke("paged.edit.paste");
    await settle(e);
    const rows = e.problems();
    expect(rows.some((r) => r.severity === "warning")).toBe(true);
  });
});
