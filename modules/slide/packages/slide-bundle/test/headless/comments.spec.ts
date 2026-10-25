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

// [plugin-slide.comments] Comments on the real engine (the published
// canvas-wasm, headless) and the real slide wasm (slide ADR 711, amendment
// 2026-10-25): a deck's comments are kept per slide when it opens, the
// typed commands change them, and export writes them back — an untouched
// deck still exports its own bytes, and a deck whose comments changed
// comes back, imported again, with exactly the comments the document held.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";
import { covers, waitFor } from "@paged-media/test-kit";

import type { ExporterContribution } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { DECK_CONTEXT } from "../../src/commands";
import type { SlideComment } from "../../src/comments-model";
import { slideEngine } from "../../src/engine";
import slideBundle from "../../src/index";
import {
  ADD_COMMENT_COMMAND,
  DELETE_COMMENT_COMMAND,
  IMPORT_PPTX_COMMAND,
  REPLY_COMMENT_COMMAND,
  RESOLVE_COMMENT_COMMAND,
} from "../../src/object-model";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const fixtureUrl = (name: string) =>
  new URL(
    `../../../../slide-conformance/fixtures/${name}.pptx`,
    import.meta.url,
  );
const fixture = (name: string) =>
  new Uint8Array(readFileSync(fixtureUrl(name)));

const hosts: HeadlessHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

/** A host with the bundle (and a pages backend standing in for the
 *  editor's viewport) and `bytes` opened through its import command. */
async function open(bytes: Uint8Array, name: string) {
  let active: string | null = null;
  const listeners = new Set<(p: string | null) => void>();
  const setActive = (id: string | null) => {
    active = id;
    for (const l of listeners) l(id);
  };
  const h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    pages: {
      goToPage: (id: string) => {
        setActive(id);
        return true;
      },
      activePage: () => active,
      onDidChangeActivePage: (l: (p: string | null) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  });
  hosts.push(h);
  h.loadBundle(slideBundle);
  const out = (await h.objects.invoke(IMPORT_PPTX_COMMAND, {
    bytes,
    name,
  })) as {
    slides: string[];
  };
  const exporter = h.exportersContributed()[0] as ExporterContribution;
  const exported = async () => {
    const r = await exporter.export();
    if (!r) throw new Error("the exporter wrote nothing");
    return r.bytes;
  };
  const pageIds = async () =>
    (await h.host.document.collection<{ selfId: string }>("pages")).map(
      (p) => p.selfId,
    );
  return { h, slides: out.slides, exported, setActive, pageIds };
}

/** A comment as the model holds it, without what a write may fill in. */
const modelled = (c: SlideComment) => ({
  author: c.author,
  initials: c.initials,
  text: c.text,
  x: c.x === null ? null : Math.round(c.x),
  y: c.y === null ? null : Math.round(c.y),
  shapeId: c.shapeId,
  status: c.status ?? null,
  replies: c.replies.map((r) => ({ author: r.author, text: r.text })),
});

describe("[plugin-slide.comments] comments, headless", () => {
  it("a deck holds the slideDeck document context; another document drops it", async () => {
    const d = await open(fixture("placeholders"), "placeholders.pptx");
    await waitFor(() =>
      expect(d.h.documentContext()).toEqual({
        pluginId: "media.paged.slide",
        type: DECK_CONTEXT,
      }),
    );
    await d.h.newBlank(612, 792);
    await waitFor(() => expect(d.h.documentContext()).toBeNull());
  }, 120_000);

  it("marks the active slide's open threads on the overlay; a resolved one is not marked", async () => {
    const d = await open(fixture("placeholders"), "placeholders.pptx");
    const pages = await d.pageIds();
    d.setActive(pages[1]!);
    const layer = () =>
      d.h
        .overlayLayers()
        .find((l) => l.key === "media.paged.slide/media.paged.slide.comments");
    const { comment } = (await d.h.objects.invoke(ADD_COMMENT_COMMAND, {
      slide: d.slides[1]!,
      text: "Here",
      author: "Ana Lima",
      x: 200,
      y: 100,
    })) as { comment: string };
    await waitFor(() =>
      expect(layer()?.shapes).toEqual([
        { pageId: pages[1], rect: [100, 200, 118, 218] },
        {
          kind: "text",
          pageId: pages[1],
          x: 209,
          y: 100 + 18 * 0.7,
          text: "AL",
          anchor: "middle",
          background: true,
        },
      ]),
    );
    // Another slide: its own (none).
    d.setActive(pages[0]!);
    await waitFor(() => expect(layer()?.shapes).toEqual([]));
    d.setActive(pages[1]!);
    await waitFor(() => expect(layer()?.shapes.length).toBe(2));
    await d.h.objects.invoke(RESOLVE_COMMENT_COMMAND, {
      slide: d.slides[1]!,
      comment,
    });
    await waitFor(() => expect(layer()?.shapes).toEqual([]));
  }, 120_000);

  it("the typed commands add, reply, resolve and delete on a slide of an opened deck", async () => {
    covers(
      "command:media.paged.slide.command.addComment",
      "command:media.paged.slide.command.replyComment",
      "command:media.paged.slide.command.resolveComment",
      "command:media.paged.slide.command.deleteComment",
    );
    const d = await open(fixture("placeholders"), "placeholders.pptx");
    const slide = d.slides[1]!;
    const { comment } = (await d.h.objects.invoke(ADD_COMMENT_COMMAND, {
      slide,
      text: "Tighten the title",
      author: "Ana Lima",
    })) as { comment: string };
    const { reply } = (await d.h.objects.invoke(REPLY_COMMENT_COMMAND, {
      slide,
      comment,
      text: "Done",
      author: "Ben Ode",
    })) as { reply: string };
    expect(reply).toMatch(/^\{.+\}$/);
    await d.h.objects.invoke(RESOLVE_COMMENT_COMMAND, { slide, comment });
    await d.h.objects.invoke(DELETE_COMMENT_COMMAND, { slide, comment });
    await expect(
      d.h.objects.invoke(DELETE_COMMENT_COMMAND, { slide, comment }),
    ).rejects.toThrow(/unknownAddress: no comment/);
  }, 120_000);

  it("an untouched deck exports its own bytes; comments added, replied and resolved come back on import", async () => {
    covers("exporter:media.paged.slide.exporter.pptx");
    const original = fixture("placeholders");
    const d = await open(original, "placeholders.pptx");
    // Kept comments (every slide's list, empty) are not an edit.
    expect(Buffer.from(await d.exported()).equals(Buffer.from(original))).toBe(
      true,
    );

    const slide = d.slides[2]!;
    const { comment } = (await d.h.objects.invoke(ADD_COMMENT_COMMAND, {
      slide,
      text: "Use the brand blue\nand a larger title",
      author: "Ana Lima",
      x: 120,
      y: 48,
    })) as { comment: string };
    await d.h.objects.invoke(REPLY_COMMENT_COMMAND, {
      slide,
      comment,
      text: "Agreed",
      author: "Ben Ode",
    });
    await d.h.objects.invoke(ADD_COMMENT_COMMAND, {
      slide: d.slides[0]!,
      text: "Resolved one",
      author: "Ana Lima",
    });
    const resolvedId = (
      (await d.h.objects.invoke(ADD_COMMENT_COMMAND, {
        slide: d.slides[0]!,
        text: "Second on slide one",
        author: "Cleo Park",
      })) as { comment: string }
    ).comment;
    await d.h.objects.invoke(RESOLVE_COMMENT_COMMAND, {
      slide: d.slides[0]!,
      comment: resolvedId,
    });

    const bytes = await d.exported();
    expect(Buffer.from(bytes).equals(Buffer.from(original))).toBe(false);
    const { report } = (await slideEngine()).importPptx(bytes, "again.pptx");
    const again = report.slides.map((s) => (s.comments ?? []).map(modelled));
    expect(again[2]).toEqual([
      {
        author: "Ana Lima",
        initials: "AL",
        text: "Use the brand blue\nand a larger title",
        x: 120,
        y: 48,
        shapeId: null,
        status: null,
        replies: [{ author: "Ben Ode", text: "Agreed" }],
      },
    ]);
    expect(again[0]!.map((c) => [c.text, c.status, c.author])).toEqual([
      ["Resolved one", null, "Ana Lima"],
      ["Second on slide one", "resolved", "Cleo Park"],
    ]);
    // The other slides gained none.
    for (const [i, list] of again.entries())
      if (i !== 0 && i !== 2) expect(list, `slide ${i + 1}`).toEqual([]);
    // The ids round-trip, so a second export of the re-imported deck keeps them.
    expect(report.slides[2]!.comments![0]!.id).toBe(comment);

    // Opened again and exported untouched, the commented deck is its own bytes.
    const e = await open(bytes, "again.pptx");
    expect(Buffer.from(await e.exported()).equals(Buffer.from(bytes))).toBe(
      true,
    );
  }, 180_000);
});
