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

// INSERT A REFERENCE AT THE CARET — a footnote or an endnote, a bookmark
// (a named text destination: InDesign's hyperlink destination, Word's
// bookmark), a cross-reference to a bookmark or a paragraph, an index
// entry (a page reference to a topic). One implementation (P2): the
// editor's `paged.insert.*` commands and panels run it over the live text
// selection, and paged.doc's Word-styled References dialogs call those
// commands (or, on a host without them, run this same code through
// `host.text`). The writes are the engine's own ops; nothing here is Word's.

/** The command ids, host and typed alike. */
export const REFERENCE_INSERT_COMMANDS = {
  footnote: "paged.insert.footnote",
  endnote: "paged.insert.endnote",
  bookmark: "paged.insert.bookmark",
  crossReference: "paged.insert.crossReference",
  indexEntry: "paged.insert.indexEntry",
} as const;

/** What a cross-reference points at: a bookmark, or a paragraph (a
 *  heading) of a story. */
export type CrossReferenceTarget =
  { bookmark: string } | { storyId: string; paragraph: number };

/** How a cross-reference reads: the target's text, its page number, or
 *  "above" / "below". */
export type CrossReferenceKind = "text" | "pageNumber" | "aboveBelow";

/** One insert. */
export type ReferenceInsert =
  | { kind: "footnote" | "endnote"; text?: string }
  | { kind: "bookmark"; name: string }
  | {
      kind: "crossReference";
      target: CrossReferenceTarget;
      referTo?: CrossReferenceKind;
    }
  | { kind: "indexEntry"; topic: readonly string[] };

/** A caret or a selection: `start` / `end` in content offsets (the
 *  `insertText` convention), or in characters for `characterRange`. */
export interface ReferenceCaret {
  storyId: string;
  start: number;
  end: number;
}

/** What an insert needs of its host. */
export interface ReferenceDoor {
  /** The caret, in content offsets; null without one. */
  selection(): ReferenceCaret | null;
  /** The caret, in character offsets (a note's anchor); null without one. */
  characterRange(): Promise<ReferenceCaret | null>;
  /** Apply one engine mutation (one undo step). */
  mutate(mutation: unknown): Promise<{ applied: boolean; error?: string }>;
}

/** The engine's limit on an index topic's levels. */
export const MAX_INDEX_LEVELS = 4;

/** Insert `r` at the caret: one engine op, one undo step. */
export async function insertReference(
  door: ReferenceDoor,
  r: ReferenceInsert,
): Promise<{ applied: boolean; error?: string }> {
  if (r.kind === "footnote" || r.kind === "endnote") {
    const chars = await door.characterRange();
    if (!chars) return { applied: false, error: "no caret" };
    return door.mutate({
      op: r.kind === "endnote" ? "insertEndnote" : "insertFootnote",
      args: { storyId: chars.storyId, offset: chars.end, text: r.text ?? "" },
    });
  }
  const sel = door.selection();
  if (!sel) return { applied: false, error: "no caret" };
  const at = { storyId: sel.storyId, offset: 0, contentOffset: sel.start };
  switch (r.kind) {
    case "bookmark": {
      const name = r.name.trim();
      if (!name) return { applied: false, error: "a bookmark needs a name" };
      return door.mutate({ op: "insertTextAnchor", args: { ...at, name } });
    }
    case "crossReference":
      return door.mutate({
        op: "insertCrossReference",
        args: {
          ...at,
          target: r.target,
          referTo: r.referTo ?? "text",
          hyperlink: true,
        },
      });
    case "indexEntry": {
      const topic = r.topic.map((t) => t.trim()).filter((t) => t.length > 0);
      if (topic.length === 0 || topic.length > MAX_INDEX_LEVELS)
        return {
          applied: false,
          error: `an index topic has 1 to ${MAX_INDEX_LEVELS} levels`,
        };
      return door.mutate({ op: "insertIndexMarker", args: { ...at, topic } });
    }
  }
}

/** A topic typed as `Main:Sub:Detail` (Word's Mark Entry, InDesign's
 *  levels), at most four levels. */
export function topicOf(text: string): string[] {
  return text
    .split(":")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_INDEX_LEVELS);
}

const text = { kind: "text" } as const;
const optionalText = { ...text, optional: true } as const;

/** The inserts as TYPED commands (one per kind, `{ applied }` back), for a
 *  host's object registry: scripts, the CLI and paged.doc's dialogs call
 *  them by id (`host.objects.invoke`). A refusal throws its reason. */
export function referenceTypedCommands(door: ReferenceDoor) {
  const run = async (r: ReferenceInsert) => {
    const out = await insertReference(door, r);
    if (!out.applied) throw new Error(`refused: ${out.error ?? "refused"}`);
    return { applied: true };
  };
  const result = {
    kind: "struct",
    fields: { applied: { kind: "bool" } },
  } as const;
  return [
    {
      id: REFERENCE_INSERT_COMMANDS.footnote,
      title: "Insert footnote",
      args: { kind: "struct", fields: { text: optionalText } } as const,
      result,
      handler: (_ctx: unknown, a: { text?: string }) =>
        run({ kind: "footnote", text: a.text }),
    },
    {
      id: REFERENCE_INSERT_COMMANDS.endnote,
      title: "Insert endnote",
      args: { kind: "struct", fields: { text: optionalText } } as const,
      result,
      handler: (_ctx: unknown, a: { text?: string }) =>
        run({ kind: "endnote", text: a.text }),
    },
    {
      id: REFERENCE_INSERT_COMMANDS.bookmark,
      title: "Insert bookmark",
      args: { kind: "struct", fields: { name: text } } as const,
      result,
      handler: (_ctx: unknown, a: { name: string }) =>
        run({ kind: "bookmark", name: a.name }),
    },
    {
      id: REFERENCE_INSERT_COMMANDS.crossReference,
      title: "Insert cross-reference",
      args: {
        kind: "struct",
        fields: {
          bookmark: optionalText,
          storyId: optionalText,
          paragraph: { kind: "number", integer: true, optional: true },
          referTo: {
            kind: "enum",
            members: ["text", "pageNumber", "aboveBelow"],
            optional: true,
          },
        },
      } as const,
      result,
      handler: (
        _ctx: unknown,
        a: {
          bookmark?: string;
          storyId?: string;
          paragraph?: number;
          referTo?: CrossReferenceKind;
        },
      ) => {
        const target: CrossReferenceTarget | null = a.bookmark
          ? { bookmark: a.bookmark }
          : a.storyId !== undefined && a.paragraph !== undefined
            ? { storyId: a.storyId, paragraph: a.paragraph }
            : null;
        if (!target)
          throw new Error(
            "badArgs: name a bookmark, or a story and a paragraph",
          );
        return run({ kind: "crossReference", target, referTo: a.referTo });
      },
    },
    {
      id: REFERENCE_INSERT_COMMANDS.indexEntry,
      title: "Insert index entry",
      args: {
        kind: "struct",
        fields: {
          topic: { kind: "list", of: text, maxItems: MAX_INDEX_LEVELS },
        },
      } as const,
      result,
      handler: (_ctx: unknown, a: { topic: string[] }) =>
        run({ kind: "indexEntry", topic: a.topic }),
    },
  ];
}
