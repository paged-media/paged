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

// A PDF's review comments as engine operations (engine ADR 1055): the
// projection of the `pdf-import` wasm's report, and the import that applies it
// to an opened document. The report's shape is `paged_pdf_annots`' JSON
// (modules/publish/crates/pdf-import/tests/comments.rs holds the Rust half).

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import type { PdfMapper } from "../src/engine-loader";
import {
  commentMutations,
  importPdfComments,
  lossLine,
  personId,
  type PdfCommentsReport,
} from "../src/io/comments";

const REPORT: PdfCommentsReport = {
  threads: [
    {
      id: "n1",
      pageIndex: 0,
      anchor: { kind: "point", at: [50, 80] },
      subtype: "Text",
      comments: [
        {
          id: "n1",
          author: "Ann Author",
          date: "2026-11-01T10:30:00+01:00",
          text: "Why this word?",
          resolved: true,
          review_state: "completed",
        },
        {
          id: "n1.1",
          parent: "n1",
          author: "Bob",
          date: "2026-11-01T11:00:00Z",
          text: "Because",
        },
      ],
      source: [
        ["n1", { format: "pdf-annot", data: "<< /Subtype /Text >>" }],
        ["n1", { format: "pdf-annot", data: "<< /State <43> >>" }],
        ["n1.1", { format: "pdf-annot", data: "<< /Subtype /Text /RT /R >>" }],
      ],
    },
    {
      id: "h1",
      pageIndex: 1,
      anchor: { kind: "region", rect: [20, 38, 100, 12] },
      subtype: "Highlight",
      comments: [{ id: "h1", author: "Ann Author", text: "Too loose" }],
      source: [],
    },
    {
      id: "gone",
      pageIndex: 7,
      anchor: { kind: "point", at: [1, 2] },
      subtype: "Text",
      comments: [{ id: "gone", text: "past the cap" }],
      source: [],
    },
  ],
  losses: [
    {
      code: "Link",
      count: 2,
      pages: [0, 2],
      message: "a hyperlink or destination, not a review comment",
    },
  ],
};

describe("commentMutations", () => {
  const plan = commentMutations(REPORT, ["p1", "p2"]);

  it("enters each author once, then writes threads and replies in order", () => {
    expect(plan.ops.map((o) => o.op)).toEqual([
      "setPerson",
      "setPerson",
      "insertCommentThread",
      "replyComment",
      "insertCommentThread",
    ]);
    expect(plan.ops[0]!.args).toEqual({
      person: {
        id: personId("Ann Author"),
        name: "Ann Author",
        initials: "AA",
      },
    });
  });

  it("anchors a note on its page at its point and keeps the review fields", () => {
    const thread = plan.ops[2]!.args as {
      anchor: unknown;
      comment: Record<string, unknown>;
    };
    expect(thread.anchor).toEqual({ kind: "page", page: "p1", at: [50, 80] });
    expect(thread.comment).toMatchObject({
      id: "n1",
      author: "Ann Author",
      date: "2026-11-01T10:30:00+01:00",
      text: "Why this word?",
      resolved: true,
      reviewState: "completed",
      person: personId("Ann Author"),
    });
    // The annotation and its state annotation are one source, a line each.
    expect(thread.comment.source).toEqual({
      format: "pdf-annot",
      data: "<< /Subtype /Text >>\n<< /State <43> >>",
    });
  });

  it("puts a reply in the root's thread", () => {
    expect(plan.ops[3]!.args).toMatchObject({
      parentId: "n1",
      comment: { id: "n1.1", text: "Because", resolved: false },
    });
  });

  it("places a markup region at its top-left, and counts it", () => {
    expect((plan.ops[4]!.args as { anchor: unknown }).anchor).toEqual({
      kind: "page",
      page: "p2",
      at: [20, 38],
    });
    expect(plan.regionsAsPoints).toBe(1);
  });

  it("skips a thread whose page was not imported, and says so", () => {
    expect(plan.skippedThreads).toBe(1);
    expect(JSON.stringify(plan.ops)).not.toContain("past the cap");
  });
});

describe("importPdfComments", () => {
  function fakeHost(
    mutate: (m: unknown) => { applied: boolean; error?: string },
  ) {
    const logs: string[] = [];
    const sent: unknown[] = [];
    const host = {
      log: {
        info: (m: string) => void logs.push(`info ${m}`),
        warn: (m: string) => void logs.push(`warn ${m}`),
        error: (m: string) => void logs.push(`error ${m}`),
      },
      document: {
        collection: async () => [{ selfId: "p1" }, { selfId: "p2" }],
        mutate: async (m: unknown) => {
          sent.push(m);
          return mutate(m);
        },
      },
    } as unknown as BundleHost;
    return { host, logs, sent };
  }
  const mapper = (report: PdfCommentsReport | null): PdfMapper =>
    ({ comments: () => report }) as unknown as PdfMapper;

  it("applies one batch and logs the losses and the count", async () => {
    const { host, logs, sent } = fakeHost(() => ({ applied: true }));
    const n = await importPdfComments(
      host,
      mapper(REPORT),
      new Uint8Array(),
      "pdf",
    );
    expect(n).toBe(2);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { op: string }).op).toBe("batch");
    expect(logs).toContain(
      `warn pdf: comments not imported — ${lossLine(REPORT.losses[0]!)}`,
    );
    expect(logs).toContain("info pdf: imported 2 comment thread(s)");
    expect(lossLine(REPORT.losses[0]!)).toStartWith("2 x Link (page 1, 3):");
  });

  it("does nothing, quietly, for a wasm without the reader or a PDF without comments", async () => {
    const a = fakeHost(() => ({ applied: true }));
    expect(await importPdfComments(a.host, null, new Uint8Array(), "pdf")).toBe(
      0,
    );
    expect(
      await importPdfComments(a.host, mapper(null), new Uint8Array(), "pdf"),
    ).toBe(0);
    expect(
      await importPdfComments(
        a.host,
        mapper({ threads: [], losses: [] }),
        new Uint8Array(),
        "pdf",
      ),
    ).toBe(0);
    expect(a.sent).toHaveLength(0);
  });

  it("reports a refused batch and never throws", async () => {
    const refused = fakeHost(() => ({ applied: false, error: "no page" }));
    expect(
      await importPdfComments(
        refused.host,
        mapper(REPORT),
        new Uint8Array(),
        "pdf",
      ),
    ).toBe(0);
    expect(refused.logs.some((l) => l.includes("no page"))).toBe(true);
    const throwing = fakeHost(() => {
      throw new Error("boom");
    });
    expect(
      await importPdfComments(
        throwing.host,
        mapper(REPORT),
        new Uint8Array(),
        "pdf",
      ),
    ).toBe(0);
    expect(throwing.logs.some((l) => l.includes("boom"))).toBe(true);
  });
});
