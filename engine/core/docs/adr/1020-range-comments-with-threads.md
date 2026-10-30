# ADR 1020 — Range comments with threads

- **Status:** Accepted 2026-10-29.
- **Scope:** rides protocol v78 as a rider. Extends [ADR 172](172-editorial-notes.md):
  InDesign's notes stay points in the text; a comment covers a range and holds a thread.
  Part of engine wave E3; tracked changes are [ADR 1040](1040-word-change-tracking.md).
  The plugin's `comments.xml`, `commentsExtended.xml` and `commentsIds.xml` are paged.doc
  work (doc ADR 613).
  - `paged-model`: `Comment`, `CharacterRun.comments`, `Story.comments`.
  - `paged-mutate`: `InsertComment` (a root on a range, or a reply), `ResolveComment`,
    `DeleteComment`, `EditComment`, undone through `RestoreStoryReview`.
  - `paged-canvas`: the `comments` collection; `replyComment` lowers to a reply in the
    parent's story, joining the thread's root.
  - `paged-wire`: `insertComment`, `replyComment`, `resolveComment`, `deleteComment`,
    `editComment`; `CommentSpec`; `CommentSummary`; `StoryContent.comments`,
    `RunContent.comments`.
  - `paged-renderer`: commented text is shaded in All Markup.

## Context

A Word comment is anchored to a range (`w:commentRangeStart` … `w:commentRangeEnd`), can be
answered (Word 2013's threads, `commentsExtended.xml` `w15:paraIdParent`) and resolved
(`w15:done`). The engine's notes (ADR 172) are a character standing in the text with a text
of their own: no range, no replies, no resolved state.

## Decision

- **A comment's range is the runs that name it.** `CharacterRun.comments` holds the ids of
  the thread roots whose range covers the run, so the range follows its text through every
  edit, as a tracked change does: text typed inside the range widens it (as in Word), a
  split or a join carries it. No marker character is added, so the story's character
  offsets do not change.
- **The thread is the story's** (`Story.comments`): the root (no `parent`) and its replies,
  each with author, initials, date, text (paragraphs separated by `\n`) and `resolved`.
  Resolving any comment of a thread resolves the thread, as Word's Resolve does; deleting
  the root takes its replies and its range. A reply to a reply joins the root.
- **Ids** are numeric strings unique in the document, minted past the largest when the
  caller gives none. Replies carry no `createdId` (it names elements), so a caller that
  needs to address a new comment passes its id.
- Every op is one undo step that restores the story's threads (and, for a root's insert or
  delete, its paragraphs) exactly.
- **Reads.** `documentCollection:comments` lists every comment, roots each followed by
  their replies, with the thread's range (`start`, `end` in story characters) and its
  text; a thread whose text was deleted reads without a range. The story content read
  carries the story's comments and each run's ids.

## Consequences

- A comment needs a non-empty range; a host commenting at a caret comments the word there.
- A comment inside a table cell is stored and drawn; the collection reports the body's
  ranges only.
- The margin band that shows the threads beside the page is the host's (editor ADR 300,
  extensions ADR 349).
