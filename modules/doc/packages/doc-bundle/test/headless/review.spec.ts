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

// Doc ADR 613 — Word's Review on the headless host (the real engine,
// engine ADRs 1037 and 1020): a .docx opened as the document gets the
// review chrome in its wordDocument context; with Track Changes on, typing
// and deleting record changes the engine lists; Accept and Reject resolve
// them; the markup views are the document's; comments are added, answered,
// resolved and deleted — every review command through its typed twin.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { docBundle } from "../../src";
import {
  REVIEW_BAND,
  REVIEW_COMMAND,
  REVIEW_KEYS,
  REVIEW_PANEL,
} from "../../src/word/review";
import {
  docxPresent,
  ENGINE_ANCHOR,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — review");

// template-letter.docx in story docx_s0 (see word-editing.spec.ts):
//   1 "Dear «Name»,"               content 17..31, chars 16..28
//   2 "Thank you for your order."  content 32..57, chars 28..53
const STORY = "docx_s0";

interface Change {
  id?: string | null;
  kind?: string | null;
  offset: number;
  end?: number | null;
  userName?: string | null;
  text?: string;
}
interface Comment {
  id: string;
  parentId?: string | null;
  text: string;
  resolved?: boolean;
  author?: string | null;
}

describe.skipIf(!docxPresent)(
  "doc headless — review @feat:plugin-doc.review",
  () => {
    let h: HeadlessHost;
    const invoke = (name: keyof typeof REVIEW_COMMAND, args = {}) =>
      h.host.objects.invoke(REVIEW_COMMAND[name], args) as Promise<{
        applied: boolean;
        id?: string;
      }>;
    const changes = async () =>
      (await h.host.document.collection(
        "trackedChanges" as never,
      )) as unknown as Change[];
    const comments = async () =>
      (await h.host.document.collection(
        "comments" as never,
      )) as unknown as Comment[];
    const docPath = async (path: string) => {
      const v = await h.host.objects.get("doc", path as never);
      const raw = v.kind === "value" ? (v.value as unknown) : undefined;
      return raw && typeof raw === "object" && "value" in raw
        ? (raw as { value: unknown }).value
        : raw;
    };

    beforeAll(async () => {
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      h.loadBundle(docBundle);
      const importer = h
        .importersContributed()
        .find((c) => c.id === "media.paged.doc.importer.docx")!;
      await h.newBlank(300, 300);
      await importer.import({
        name: "template-letter.docx",
        bytes: fixture("template-letter.docx"),
        mimeType: "",
        newDocument: true,
      });
    }, 60_000);
    afterAll(() => h?.dispose());

    it("contributes the review chrome in the wordDocument context", () => {
      expect(h.marginBandsContributed().map((b) => b.id)).toEqual([
        REVIEW_BAND,
      ]);
      expect(
        h.contributions.some((c) => c.kind === "panel" && c.id === REVIEW_PANEL),
      ).toBe(true);
      const bound = h.contributions
        .filter((c) => c.kind === "keybinding")
        .map((c) => c.value as { key: string; command: string });
      covers(
        "keybinding:cmd+shift+e→media.paged.doc.command.review.toggleTrackChanges",
      );
      covers("keybinding:cmd+alt+m→media.paged.doc.command.review.newComment");
      for (const k of REVIEW_KEYS) {
        expect(bound).toContainEqual(
          expect.objectContaining({
            key: k.key,
            command: k.command,
            scope: { editContext: "wordDocument" },
          }),
        );
      }
    });

    it("records typing and deleting while Track Changes is on", async () => {
      covers("command:media.paged.doc.command.review.toggleTrackChanges");
      expect((await invoke("toggleTrackChanges")).applied).toBe(true);
      expect(await docPath("documentTrackChanges")).toBe(true);
      expect(await docPath("documentTrackChangesAuthor")).toBe("Author");
      await h.host.document.mutate({
        op: "insertText",
        args: { storyId: STORY, offset: 32, text: "Very " },
      } as never);
      await h.host.document.mutate({
        op: "deleteRange",
        args: { storyId: STORY, start: 17, end: 21 },
      } as never);
      const listed = await changes();
      expect(listed).toContainEqual(
        expect.objectContaining({
          kind: "insert",
          offset: 28,
          end: 33,
          userName: "Author",
          text: "Very ",
        }),
      );
      expect(listed).toContainEqual(
        expect.objectContaining({ kind: "delete", offset: 16, text: "Dear" }),
      );
    });

    it("switches the markup view", async () => {
      covers("command:media.paged.doc.command.review.markupSimple");
      covers("command:media.paged.doc.command.review.markupNone");
      covers("command:media.paged.doc.command.review.markupOriginal");
      covers("command:media.paged.doc.command.review.markupAll");
      for (const [name, view] of [
        ["markupSimple", "simple"],
        ["markupNone", "none"],
        ["markupOriginal", "original"],
        ["markupAll", "all"],
      ] as const) {
        expect((await invoke(name)).applied).toBe(true);
        expect(await docPath("documentMarkupView")).toBe(view);
      }
    });

    it("steps through the changes and resolves them", async () => {
      covers("command:media.paged.doc.command.review.nextChange");
      expect((await invoke("nextChange")).applied).toBe(true);
      covers("command:media.paged.doc.command.review.previousChange");
      expect((await invoke("previousChange")).applied).toBe(true);
      const [first, second] = await changes();
      covers("command:media.paged.doc.command.review.acceptChange");
      expect((await invoke("acceptChange", { id: first!.id })).applied).toBe(
        true,
      );
      covers("command:media.paged.doc.command.review.rejectChange");
      expect((await invoke("rejectChange", { id: second!.id })).applied).toBe(
        true,
      );
      expect(await changes()).toEqual([]);
      const story = await h.host.document.storyContent(STORY);
      const texts = story!.paragraphs.map((p) =>
        p.runs.map((r) => r.text).join(""),
      );
      // The deletion rejected, the insertion accepted (whichever came first
      // in the list, both are resolved and the text reads as such).
      expect(texts.join("\n")).toContain("Dear «Name»,");
    });

    it("accepts and rejects all, and by author", async () => {
      await h.host.document.mutate({
        op: "insertText",
        args: { storyId: STORY, offset: 32, text: "Ok " },
      } as never);
      covers("command:media.paged.doc.command.review.rejectAll");
      expect((await invoke("rejectAll", { author: "Author" })).applied).toBe(
        true,
      );
      expect(await changes()).toEqual([]);
      await h.host.document.mutate({
        op: "insertText",
        args: { storyId: STORY, offset: 32, text: "Ok " },
      } as never);
      covers("command:media.paged.doc.command.review.acceptAll");
      expect((await invoke("acceptAll")).applied).toBe(true);
      expect(await changes()).toEqual([]);
      expect((await invoke("toggleTrackChanges")).applied).toBe(true);
      expect(await docPath("documentTrackChanges")).toBe(false);
    });

    it("adds, answers, resolves and deletes a comment", async () => {
      covers("command:media.paged.doc.command.review.newComment");
      // A collapsed caret in "Thank" comments the word.
      h.setTextSelection({ storyId: STORY, start: 37, end: 37 });
      const made = await invoke("newComment", { text: "Formal enough?" });
      expect(made.applied).toBe(true);
      const id = made.id!;
      expect(await comments()).toContainEqual(
        expect.objectContaining({ id, text: "Formal enough?", author: "Author" }),
      );
      covers("command:media.paged.doc.command.review.replyComment");
      expect(
        (await invoke("replyComment", { id, text: "Yes." })).applied,
      ).toBe(true);
      expect(await comments()).toContainEqual(
        expect.objectContaining({ parentId: id, text: "Yes." }),
      );
      covers("command:media.paged.doc.command.review.nextComment");
      expect((await invoke("nextComment")).applied).toBe(true);
      covers("command:media.paged.doc.command.review.previousComment");
      expect((await invoke("previousComment")).applied).toBe(true);
      covers("command:media.paged.doc.command.review.resolveComment");
      expect((await invoke("resolveComment", { id })).applied).toBe(true);
      expect(await comments()).toContainEqual(
        expect.objectContaining({ id, resolved: true }),
      );
      covers("command:media.paged.doc.command.review.deleteComment");
      expect((await invoke("deleteComment", { id })).applied).toBe(true);
      expect(await comments()).toEqual([]);
    });

    it("opens the Review panel", async () => {
      covers("command:media.paged.doc.command.review.showReview");
      expect((await invoke("showReview")).applied).toBe(true);
    });
  },
);
