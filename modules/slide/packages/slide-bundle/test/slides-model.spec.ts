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

// The slides store and its mutations against the real engine (headless
// canvas-wasm): the store lists the deck's slides with their own state,
// reorders, writes notes and hidden state, and every one of those is a
// single undo step; thumbnails come from the engine's renderer.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { slideEngine } from "../src/engine";
import {
  encodeState,
  layouts,
  newSlide,
  moveMutation,
  parseState,
  SLIDE_KEY,
  setStateMutation,
  SlidesStore,
} from "../src/slides-model";

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("slide state", () => {
  it("round-trips through the envelope and drops what is empty", () => {
    const value = encodeState({ notes: "one\ntwo", hidden: true });
    expect(parseState([{ key: SLIDE_KEY, value: value! }])).toEqual({ notes: "one\ntwo", hidden: true });
    expect(encodeState({ notes: "  ", hidden: false })).toBeNull();
    expect(parseState([{ key: SLIDE_KEY, value: "not json" }])).toEqual({});
    expect(parseState([{ key: "x-paged:other", value: value! }])).toEqual({});
  });

  it("moves a slide to a position, or not at all", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveMutation(order, "c", 0)).toEqual({ op: "movePage", args: { page: "c", after: null } });
    expect(moveMutation(order, "a", 3)).toEqual({ op: "movePage", args: { page: "a", after: "d" } });
    expect(moveMutation(order, "b", 1)).toBeNull();
    expect(moveMutation(order, "zz", 0)).toBeNull();
  });
});

describe("the slides store on the engine", () => {
  async function open(name: string) {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../slide-conformance/fixtures/${name}.pptx`, import.meta.url)),
    );
    const { idml } = (await slideEngine()).importPptx(bytes, name);
    const h = await createHeadlessHost();
    await h.load(idml);
    // The slide plugin's own host: a page label is written under the
    // writer's own id, so the store runs as media.paged.slide.
    let host!: BundleHost;
    h.loadBundle({
      manifest: {
        id: "media.paged.slide",
        name: "paged.slide",
        version: "0.0.0",
        apiVersion: "^0.2",
        capabilities: { document: { read: "broad", write: "broad" } },
      },
      activate(x) {
        host = x;
        return { dispose() {} };
      },
    });
    const shots: Uint8Array[] = [];
    const store = new SlidesStore(
      host,
      (png) => {
        shots.push(png);
        return `blob:${shots.length}`;
      },
      () => {},
    );
    await store.refresh();
    return { h, host, store, shots };
  }

  it("lists the slides with their transitions", async () => {
    const { h, store } = await open("motion");
    try {
      const slides = store.list();
      expect(slides.length).toBeGreaterThan(1);
      expect(slides.map((s) => s.number)).toEqual(slides.map((_, i) => i + 1));
      expect(slides.some((s) => s.state.transition?.kind)).toBe(true);
    } finally {
      store.dispose();
      h.dispose();
    }
  }, 60_000);

  it("reorders, writes notes and hides, each one undo step", async () => {
    const { h, host, store } = await open("motion");
    try {
      const before = store.list().map((s) => s.pageId);
      const last = before[before.length - 1];

      await host.document.mutate(moveMutation(before, last, 0)!);
      await store.refresh();
      expect(store.list()[0].pageId).toBe(last);

      const first = store.list()[0];
      await host.document.mutate(
        setStateMutation(first.pageId, { ...first.state, notes: "Say hello\nthen go", hidden: true }),
      );
      await store.refresh();
      expect(store.list()[0].state).toMatchObject({ notes: "Say hello\nthen go", hidden: true });
      // The transition the import wrote is kept beside the new notes.
      expect(store.list()[0].state.transition).toEqual(first.state.transition);

      await host.document.undo();
      await store.refresh();
      expect(store.list()[0].state.notes).toBeUndefined();
      await host.document.undo();
      await store.refresh();
      expect(store.list().map((s) => s.pageId)).toEqual(before);
    } finally {
      store.dispose();
      h.dispose();
    }
  }, 60_000);

  it("renders a thumbnail through the engine", async () => {
    const { h, store, shots } = await open("geometry");
    try {
      const id = store.list()[0].pageId;
      expect(store.thumbnail(id)).toBeNull();
      await until(() => store.thumbnail(id) !== null);
      expect(Array.from(shots[0].slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      store.dispose();
      h.dispose();
    }
  }, 60_000);
});

describe("a new slide from a layout", () => {
  async function open(name: string) {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../slide-conformance/fixtures/${name}.pptx`, import.meta.url)),
    );
    const { idml } = (await slideEngine()).importPptx(bytes, name);
    const h = await createHeadlessHost();
    await h.load(idml);
    let host!: BundleHost;
    h.loadBundle({
      manifest: {
        id: "media.paged.slide",
        name: "paged.slide",
        version: "0.0.0",
        apiVersion: "^0.2",
        capabilities: { document: { read: "broad", write: "broad" } },
      },
      activate(x) {
        host = x;
        return { dispose() {} };
      },
    });
    const store = new SlidesStore(host, () => "blob:x", () => {});
    await store.refresh();
    return { h, host, store };
  }

  type Node = { id?: { id: string } | null; children?: Node[]; pluginMetadata?: { key: string; value: string }[] };

  it("offers the deck's layouts by name, each with a slide to copy", async () => {
    const { h, host, store } = await open("placeholders");
    try {
      const ls = await layouts(host, store.list());
      expect(ls.length).toBeGreaterThan(1);
      expect(ls.every((l) => l.name.length > 0 && l.templatePageId.length > 0)).toBe(true);
    } finally {
      store.dispose();
      h.dispose();
    }
  }, 60_000);

  it("keeps only the layout's placeholders, empty, after the given slide", async () => {
    const { h, host, store } = await open("geometry");
    try {
      const before = store.list();
      const ls = await layouts(host, before);
      expect(ls.length).toBeGreaterThan(0);
      const layout = ls[0];
      const id = await newSlide(host, layout, before[0].pageId);
      expect(id).not.toBeNull();
      await store.refresh();
      const after = store.list();
      expect(after.length).toBe(before.length + 1);
      expect(after[1].pageId, "right after the first slide").toBe(id);
      expect(after[1].state).toEqual({ layout: layout.masterId });

      // Only placeholders are left on it, and they hold no text.
      const tree = (await host.document.tree()) as Node[];
      const items = tree[1].children?.[0]?.children ?? [];
      // The copied slide had more than its placeholders: they were removed.
      const at = after.findIndex((s) => s.pageId === layout.templatePageId);
      const templateItems = tree[at].children?.[0]?.children ?? [];
      expect(templateItems.length, "the template carries art beside its placeholders").toBeGreaterThan(items.length);
      for (const n of items) {
        expect(
          n.pluginMetadata?.some((m) => m.key === "x-paged:media.paged.slide" && m.value.includes("placeholder")),
          "only placeholders remain",
        ).toBe(true);
      }
      const stories = await host.document.collection<{ selfId: string; characterCount: number }>("stories");
      for (const n of items) {
        const chain = await Promise.all(stories.map(async (s) => [s, await host.document.frameChain(s.selfId)] as const));
        const own = chain.find(([, links]) => links.some((l) => l.frameId === n.id?.id));
        if (own) expect(own[0].characterCount, "an emptied placeholder").toBe(0);
      }
    } finally {
      store.dispose();
      h.dispose();
    }
  }, 60_000);
});
