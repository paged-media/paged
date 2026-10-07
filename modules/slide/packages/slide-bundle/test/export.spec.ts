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

// PPTX export end to end on the headless engine: the real bundle imports a
// deck through its importer, the document's slides are edited with the
// panels' mutations, and the exporter's deck is read back.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { BundleHost, ExporterContribution } from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { activate, FINGERPRINTS_PART, keepSource } from "../src/activate";
import { exportPlan } from "../src/deck-export";
import { slideEngine } from "../src/engine";
import {
  deleteMutation,
  duplicateMutation,
  moveMutation,
  parseState,
  setStateMutation,
  type PluginMetadataEntry,
} from "../src/slides-model";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as Parameters<Awaited<ReturnType<typeof createHeadlessHost>>["loadBundle"]>[0]["manifest"];

async function withDeck(name: string) {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../slide-conformance/fixtures/${name}.pptx`, import.meta.url)),
  );
  const h = await createHeadlessHost();
  let host!: BundleHost;
  h.loadBundle({
    manifest,
    activate(x) {
      host = x;
      return activate(x);
    },
  });
  const exporter = h.exportersContributed()[0] as ExporterContribution;
  // The importer's own steps: the package as the document (the headless
  // host has no native-open backend, so it is loaded directly), then what
  // the importer keeps beside it.
  const { idml, report } = (await slideEngine()).importPptx(bytes, name);
  await h.load(idml);
  await keepSource(host, bytes, report);
  return { h, host, bytes, exporter };
}

async function pages(host: BundleHost) {
  return host.document.collection<{ selfId: string; pluginMetadata?: PluginMetadataEntry[] }>("pages");
}

describe("PPTX export", () => {
  it("writes the original bytes back when nothing changed", async () => {
    const { h, bytes, exporter } = await withDeck("placeholders");
    try {
      const out = await exporter.export();
      expect(out).not.toBeNull();
      expect(Buffer.from(out!.bytes).equals(Buffer.from(bytes))).toBe(true);
      expect(out!.fileName.endsWith(".pptx")).toBe(true);
    } finally {
      h.dispose();
    }
  }, 60_000);

  it("carries reorder, duplicate, delete, hide and notes into the deck", async () => {
    const { h, host, exporter } = await withDeck("text");
    try {
      const before = await pages(host);
      const ids = before.map((p) => p.selfId);
      const parts = before.map((p) => parseState(p.pluginMetadata).part);
      expect(parts.every(Boolean)).toBe(true);

      // Duplicate slide 1, move the last first, delete what was slide 2,
      // hide slide 1, notes on the duplicate.
      await host.document.mutate(duplicateMutation(ids[0]));
      let now = (await pages(host)).map((p) => p.selfId);
      const copy = now.find((p) => !ids.includes(p))!;
      await host.document.mutate(moveMutation(now, ids[ids.length - 1], 0)!);
      if (ids.length > 2) await host.document.mutate(deleteMutation(ids[1]));
      const first = (await pages(host)).find((p) => p.selfId === ids[0])!;
      await host.document.mutate(setStateMutation(ids[0], { ...parseState(first.pluginMetadata), hidden: true }));
      const dup = (await pages(host)).find((p) => p.selfId === copy)!;
      await host.document.mutate(
        setStateMutation(copy, { ...parseState(dup.pluginMetadata), notes: "Copy & notes\nline two" }),
      );
      now = (await pages(host)).map((p) => p.selfId);

      const out = await exporter.export();
      expect(out).not.toBeNull();
      const back = (await slideEngine()).importPptx(out!.bytes, "back").report;
      expect(back.slides.length).toBe(now.length);
      const state = new Map((await pages(host)).map((p) => [p.selfId, parseState(p.pluginMetadata)]));
      back.slides.forEach((s, i) => {
        const want = state.get(now[i])!;
        expect(s.hidden, `slide ${i + 1} hidden`).toBe(!!want.hidden);
        expect(s.notes ?? null, `slide ${i + 1} notes`).toBe(want.notes ?? null);
      });
      // The copy is its own part; the deleted slide's part is gone.
      expect(new Set(back.slides.map((s) => s.part)).size).toBe(back.slides.length);
      if (ids.length > 2) expect(back.slides.some((s) => s.part === parts[1])).toBe(false);
    } finally {
      h.dispose();
    }
  }, 60_000);

  it("marks only the slide whose content changed as edited", async () => {
    const { h, host } = await withDeck("geometry");
    try {
      const prints = JSON.parse(
        new TextDecoder().decode((await host.parts.read(FINGERPRINTS_PART))!),
      ) as Record<string, string>;
      const clean = await exportPlan(host, prints);
      expect(clean.every((s) => !s.contentEdited)).toBe(true);

      // Move one item on slide 2.
      const tree = (await host.document.tree()) as {
        children?: { children?: { id?: { id: string } | null }[] }[];
      }[];
      const item = tree[1].children?.[0]?.children?.find((n) => n.id)?.id;
      expect(item).toBeTruthy();
      const moved = await host.document.mutate({
        op: "moveFrame",
        args: { frameId: item!.id, transform: [1, 0, 0, 1, 37, 41] },
      } as never);
      expect(moved.applied).toBe(true);
      const plan = await exportPlan(host, prints);
      expect(plan.map((s) => s.contentEdited)).toEqual(plan.map((_, i) => i === 1));
    } finally {
      h.dispose();
    }
  }, 60_000);
});
