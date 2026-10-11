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

// Conformance against the real engine (the published @paged-media/
// canvas-wasm, booted headlessly): every authored fixture opens with a page
// per slide, and every drawn top-level item sits where the import placed it
// (the importer's own geometry is held to PowerPoint's by the Rust oracle
// tests, so this closes the chain PowerPoint → import → engine).

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createHeadlessHost } from "@paged-media/plugin-sdk";
import type { ElementId } from "@paged-media/plugin-api";

import { slideEngine } from "../src/engine";

const FIXTURES = ["geometry", "placeholders", "text", "motion", "baselines"];

/** The engine's element bounds (top, left, bottom, right in the item's own
 *  space) through its item transform: page-space (l, t, r, b). */
function pageBox(
  b: [number, number, number, number],
  m: [number, number, number, number, number, number] | null,
): [number, number, number, number] {
  const [top, left, bottom, right] = b;
  const t = m ?? [1, 0, 0, 1, 0, 0];
  const pts = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ].map(([x, y]) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

describe.each(FIXTURES)("fixture %s in the engine", (name) => {
  it("opens a page per slide, each item where the import put it", async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../slide-conformance/fixtures/${name}.pptx`, import.meta.url)),
    );
    const { idml, report } = (await slideEngine()).importPptx(bytes, name);
    const h = await createHeadlessHost();
    try {
      const pageIds = await h.load(idml);
      expect(pageIds).toEqual(report.slides.map((s) => s.pageId));

      // Text frames grow to their text (the engine composes them), so only
      // drawn art is compared.
      const items = report.slides.flatMap((s) => s.items).filter((i) => i.kind !== "textFrame");
      const ids = items.map((i) => ({ kind: i.kind, id: i.id }) as ElementId);
      const geometry = await h.host.document.elementGeometry(ids);
      const byId = new Map(geometry.map((g) => [(g.id as { id: string }).id, g]));
      const off: string[] = [];
      for (const it of items) {
        const g = byId.get(it.id);
        if (!g) {
          off.push(`${it.name} (${it.kind} ${it.id}): no geometry`);
          continue;
        }
        const box = pageBox(g.bounds, g.itemTransform ?? null);
        const d = box.map((v, k) => Math.abs(v - it.bounds[k]));
        if (Math.max(...d) > 0.5) {
          off.push(`${it.name}: engine ${box.map((v) => v.toFixed(1))} vs import ${it.bounds.map((v) => v.toFixed(1))}`);
        }
      }
      expect(off).toEqual([]);
    } finally {
      h.dispose();
    }
  }, 60_000);
});

/** Read the slide's own state off its page, as the panels do. */
function slideState(meta: { key: string; value: string }[] | undefined) {
  const entry = meta?.find((m) => m.key === "x-paged:media.paged.slide");
  return entry ? (JSON.parse(entry.value) as { v: number; data: Record<string, unknown> }) : null;
}

describe("slide state rides the pages", () => {
  it.each([
    ["text", "notes"],
    ["motion", "transition"],
  ])("%s: each slide's %s is its page's plugin metadata", async (name, field) => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../slide-conformance/fixtures/${name}.pptx`, import.meta.url)),
    );
    const { idml, report } = (await slideEngine()).importPptx(bytes, name);
    const h = await createHeadlessHost();
    try {
      await h.load(idml);
      const pages = await h.host.document.collection<{
        selfId: string;
        pluginMetadata?: { key: string; value: string }[];
      }>("pages");
      const expected = report.slides.filter((s) =>
        field === "notes" ? !!s.notes?.trim() : !!(s as { transition?: unknown }).transition,
      );
      expect(expected.length, `the fixture has slides with ${field}`).toBeGreaterThan(0);
      for (const s of expected) {
        const page = pages.find((p) => p.selfId === s.pageId);
        const state = slideState(page?.pluginMetadata);
        expect(state?.v).toBe(1);
        if (field === "notes") {
          // Line breaks survive the attribute.
          expect(state?.data.notes).toBe(s.notes);
        } else {
          expect((state?.data.transition as { kind?: string })?.kind).toBeTruthy();
        }
      }
    } finally {
      h.dispose();
    }
  }, 60_000);
});
