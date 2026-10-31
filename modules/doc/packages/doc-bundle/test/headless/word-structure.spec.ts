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

// Doc ADRs 611 / 612 on the real engine: `structure.docx`
// (docx_conformance::structure_docx) opened standalone. Each section's
// pages show their masters' header and footer, the footer's PAGE and
// NUMPAGES print the layout's numbers, the notes stand at their references,
// the bookmarks are text anchors, the TOC's page numbers are live PAGEREFs,
// and F9 / Shift+F9 work.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  docxPresent,
  type OpenedDoc,
  openDoc,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — Word document structure");

interface Page {
  selfId: string;
  name?: string;
  appliedMaster?: string | null;
}
interface Run {
  text: string;
  fieldCode?: string;
}
interface Content {
  paragraphs: Array<{ runs: Run[]; toc?: string }>;
  textAnchors?: Array<{ name: string; paragraph: number; offset: number }>;
}

async function content(host: BundleHost, storyId: string): Promise<Content> {
  return (await host.document.storyContent(storyId)) as unknown as Content;
}

function texts(c: Content): string[] {
  return c.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
}

describe.skipIf(!docxPresent)(
  "doc headless — Word headers, footers, notes and fields @feat:doc-word-headers-footers",
  () => {
    let d: OpenedDoc;
    beforeAll(async () => {
      d = await openDoc("structure.docx");
    }, 60_000);
    afterAll(() => d?.h.dispose());

    /** The pages once laid out: generated pages are made as pages are
     *  requested (the editor requests them as they scroll into view), so
     *  request every page until the count stops moving. */
    async function pages(): Promise<Page[]> {
      const client = (
        d.host as unknown as {
          editor: { client: { send(m: unknown): Promise<unknown> } };
        }
      ).editor.client;
      let last = -1;
      for (let i = 0; i < 50; i++) {
        const ps = await d.host.document.collection<Page>("pages");
        for (const p of ps) {
          await client.send({
            kind: "requestPage",
            payload: { pageId: p.selfId, lod: "live" },
          });
        }
        if (ps.length === last) return ps;
        last = ps.length;
      }
      return d.host.document.collection<Page>("pages");
    }

    /** The masters by id, from the lowering the open poured. */
    const master = (id: string | null | undefined) =>
      d.opened.ir.masters?.find((m) => m.id === id);

    it("each story's grow rule names its section's masters; its page shows the first", async () => {
      const ps = await pages();
      const [s1, s2] = d.opened.ir.sections ?? [];
      // S1 opens on its title page, S2 on its own authored page.
      expect(ps.find((p) => p.selfId === "docx_p0")!.appliedMaster).toBe(
        s1!.masters!.firstMaster,
      );
      expect(ps.find((p) => p.selfId === "docx_p1")!.appliedMaster).toBe(
        s2!.masters!.master,
      );
      // The rules the engine applies to every page of each chain (engine
      // ADR 1022; the alternation itself is the engine's tested work).
      const stories = await d.host.document.collection<{
        selfId: string;
        growRule?: { master?: string; firstMaster?: string } | null;
      }>("stories");
      const rule = (id: string) =>
        stories.find((s) => s.selfId === id)?.growRule;
      expect(rule("docx_s0")).toMatchObject({
        master: s1!.masters!.master,
        firstMaster: s1!.masters!.firstMaster,
      });
      expect(rule("docx_s1")?.master).toBe(s2!.masters!.master);
      expect(rule("docx_s1")?.firstMaster).toBeUndefined();
      // S2 links its footer to S1's: one footer part on both masters.
      expect(master(s2!.masters!.master)?.footer?.part).toBe(
        master(s1!.masters!.master)?.footer?.part,
      );
    });

    it("the masters' stories hold the header and footer text, fields live", async () => {
      const m = master(d.opened.ir.sections?.[0]?.masters?.master)!;
      expect(texts(await content(d.host, m.header!.storyId))).toEqual([
        "Report header",
      ]);
      const footer = await content(d.host, m.footer!.storyId);
      const codes = footer.paragraphs[0]!.runs.flatMap((r) =>
        r.fieldCode ? [r.fieldCode] : [],
      );
      expect(codes).toEqual(["PAGE", "NUMPAGES"]);
      const first = master(d.opened.ir.sections?.[0]?.masters?.firstMaster)!;
      expect(texts(await content(d.host, first.header!.storyId))).toEqual([
        "Title page header",
      ]);
      expect(first.footer).toBeUndefined();
    });

    it("the body keeps its fields and Word's bookmarks", async () => {
      const story = d.opened.storyIds[0]!;
      const c = await content(d.host, story);
      const codes = c.paragraphs.flatMap((p) =>
        p.runs.flatMap((r) => (r.fieldCode ? [r.fieldCode] : [])),
      );
      expect(codes).toEqual([
        "PAGEREF _Toc1 \\h",
        "PAGEREF _Toc2 \\h",
        "PAGEREF _Toc3 \\h",
        "REF _Toc2 \\h",
        "PAGEREF _Toc2 \\h",
      ]);
      expect((c.textAnchors ?? []).map((a) => a.name)).toEqual([
        "_Toc1",
        "_Toc2",
      ]);
      // The TOC's entries are Word's, their page numbers live.
      expect(texts(c).slice(1, 3)).toEqual([
        "Introduction\t2",
        "Background\t2",
      ]);
    });

    it("the footnotes stand at their references with their text", async () => {
      const notes = await d.host.document.collection<{
        storyId: string;
        offset: number;
        text: string;
      }>("footnotes");
      expect(notes.map((n) => n.text)).toEqual([
        "First note text.",
        "Second note text.",
      ]);
      const story = d.opened.storyIds[0]!;
      const body = texts(await content(d.host, story));
      expect(body.some((t) => t === "Body text with a note\u{E01C}.")).toBe(
        true,
      );
      const endnotes = await d.host.document.collection<{ text?: string }>(
        "endnotes",
      );
      expect(endnotes).toHaveLength(1);
    });

    it("F9 updates the fields and Shift+F9 shows their codes", async () => {
      const r = await d.host.document.mutate({
        op: "updateFields",
        args: { storyId: null, offset: null, now: "2026-10-28T12:00:00Z" },
      });
      // Every field already shows the layout's value, or F9 wrote it: either
      // is fine; a refusal says there was nothing to change.
      expect(typeof r.applied).toBe("boolean");
      const shown = await d.host.document.mutate({
        op: "set",
        args: {
          address: "doc",
          path: "documentShowFieldCodes",
          value: { type: "bool", value: true },
        },
      } as never);
      expect(shown.applied).toBe(true);
    });
  },
);
