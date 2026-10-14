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
import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import { IMPORTER_ID } from "../src/activate";
import { slideEngine } from "../src/engine";
import { documentFontDoor, giveDocumentEmbeddedFonts, type DocumentFontOutcome } from "../src/fonts";
import { slideBundle } from "../src/index";

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

/** A row of the document's `fonts` collection (wire `FontSummary`). */
type FontSummary = { family: string; isMissing?: boolean };

/** The engine behind a headless host, through the editor facade. */
type EngineClient = { send(m: unknown): Promise<{ kind: string; payload: Record<string, unknown> }> };

/**
 * `host` with the document-font door: the host's own where its SDK has it,
 * else the messages that door sends (plugin-sdk ADR 328: is the face held,
 * else register it in the document's registry).
 */
function withDocumentFontDoor(host: BundleHost, client: EngineClient): BundleHost {
  if (documentFontDoor(host)) return host;
  const registerDocumentFont = async (bytes: Uint8Array, family: string, style?: string): Promise<DocumentFontOutcome> => {
    const held = await client.send({ kind: "requestFontFaceBytes", payload: { family, style: style ?? null } });
    if (held.payload.found && held.payload.style === style) return { status: "held" };
    const reply = await client.send({
      kind: "registerFont",
      payload: { family, style: style ?? null, bytes: Array.from(bytes), scope: "document" },
    });
    return reply.kind === "fontRegistered"
      ? { status: "registered", pageIds: (reply.payload.pageIds as string[]) ?? [] }
      : { status: "refused", reason: reply.kind };
  };
  return {
    ...host,
    supports: (f: string) => f === "assets.documentFont@1" || host.supports(f),
    assets: { ...host.assets, registerDocumentFont },
  } as BundleHost;
}

describe("a deck's embedded fonts", () => {
  it.each([
    ["fonts-full", 5],
    ["fonts", 7],
  ])("%s: its text is set in the faces it embeds, not substitutes", async (name, count) => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../slide-conformance/fixtures/${name}.pptx`, import.meta.url)),
    );
    const { idml, report, fonts } = (await slideEngine()).importPptx(bytes, name);
    expect(report.embeddedFonts).toHaveLength(count);
    expect(report.embeddedFonts.every((f) => f.use === "editable" && f.length > 0)).toBe(true);
    expect(report.diagnostics.filter((d) => d.includes("embedded font"))).toEqual([]);

    const h = await createHeadlessHost();
    try {
      // The bundle's own host: its manifest declares the fonts asset.
      h.loadBundle(slideBundle);
      const client = (h.host as unknown as { editor: { client: EngineClient } }).editor.client;
      const [page] = await h.load(idml);
      const families = [...new Set(report.embeddedFonts.map((f) => f.family))].sort();
      const missing = async () =>
        (await h.host.document.collection<FontSummary>("fonts"))
          .filter((f) => families.includes(f.family) && f.isMissing)
          .map((f) => f.family)
          .sort();
      // Before: every embedded family is missing; the text has no face.
      expect(await missing()).toEqual(families);
      const before = await h.host.render.snapshot(page, { widthPx: 960 });

      const refused = await giveDocumentEmbeddedFonts(withDocumentFontDoor(h.host, client), report.embeddedFonts, fonts);
      expect(refused).toEqual([]);

      // After: none is missing, and each style resolves to its own face.
      expect(await missing()).toEqual([]);
      for (const f of report.embeddedFonts) {
        const r = await client.send({ kind: "requestFontFaceBytes", payload: { family: f.family, style: f.style } });
        expect(r.payload.found, `${f.family} ${f.style}`).toBe(true);
        expect(r.payload.style).toBe(f.style);
        // The engine serves the very face the deck embedded.
        expect((r.payload.bytes as number[]).length).toBe(f.length);
      }
      const after = await h.host.render.snapshot(page, { widthPx: 960 });
      expect(Buffer.from(after!.png).equals(Buffer.from(before!.png))).toBe(false);

      // A second time, every face is already the document's.
      const again = await giveDocumentEmbeddedFonts(withDocumentFontDoor(h.host, client), report.embeddedFonts, fonts);
      expect(again).toEqual([]);
    } finally {
      h.dispose();
    }
  }, 60_000);
});

describe("File \u25b8 Open of a deck with embedded fonts", () => {
  it("opens the document with the deck's faces where the host has the door", async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL("../../../slide-conformance/fixtures/fonts-full.pptx", import.meta.url)),
    );
    const h = await createHeadlessHost();
    try {
      h.loadBundle(slideBundle);
      const importer = h.importersContributed().find((i) => i.id === IMPORTER_ID)!;
      await importer.import({ name: "fonts-full.pptx", bytes, mimeType: "" });
      expect(h.openedDocuments().map((d) => d.name)).toEqual(["fonts-full"]);
      const missing = (await h.host.document.collection<FontSummary>("fonts"))
        .filter((f) => f.isMissing)
        .map((f) => f.family);
      // The bundle's own host (its manifest declares the fonts asset).
      // Before the SDK has the document-font door, the faces cannot reach
      // the document and the import says so; with it, nothing is missing.
      expect(missing).toEqual(
        h.host.supports("assets.documentFont@1") ? [] : ["Gloria Hallelujah", "Lato"],
      );
    } finally {
      h.dispose();
    }
  }, 60_000);
});
