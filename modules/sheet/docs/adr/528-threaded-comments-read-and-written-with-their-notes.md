# ADR 528 — Threaded comments: read and written together with their legacy notes

- **Status:** Accepted, 2026-11-01. Amends 526 (decision 3: threads were preserved and their note refused).
- **Scope:** `sheet-xlsx/src/threaded/`, `sheet-xlsx/src/comment_edit.rs`,
  `sheet-js/src/core/annotations.rs` (the session and wasm doors; no editor wiring yet).

## Context

Threaded comments (Excel 365) were preserved as opaque parts and the note of a threaded cell was
refused. A panel could not show a thread and nothing could start, answer or resolve one.

## Format facts (verified against Microsoft Excel 16 for Mac)

A thread is four things in a package, and Excel opens a workbook that has all of them:

1. `xl/threadedComments/threadedCommentN.xml` (`application/vnd.ms-excel.threadedcomments+xml`),
   related from the sheet by `http://schemas.microsoft.com/office/2017/10/relationships/threadedComment`.
   Root `<ThreadedComments>` (namespace `…/office/spreadsheetml/2018/threadedcomments`); one
   `<threadedComment ref dT personId id [parentId] [done]><text>` per comment. A reply names the
   ROOT in `parentId`; `done="1"` sits on the root of a resolved thread. `dT` is
   `YYYY-MM-DDThh:mm:ss.ff`, kept as written.
2. `xl/persons/person.xml` (`application/vnd.ms-excel.person+xml`), related from the WORKBOOK by
   `…/2017/10/relationships/person`: `<person displayName id userId providerId/>`; Excel writes
   `providerId="None"` for an account-less person.
3. The legacy note: a `<comment>` in the sheet's comments part whose `<author>` is `tc={root id}`
   and whose text is `[Threaded comment]`, a fixed notice, `Comment:` and the root text indented
   four spaces, then `Reply:` and a reply text for each reply.
4. The note's VML shape (`ObjectType="Note"`), as for any note (526).

Excel rebuilds the note's text from the thread on load: a package whose note text disagreed with
the thread (stale text) came back from Excel with the note text of the thread. The note is a
cache; the thread part is the truth.

## Decision

- **Read:** `XlsxDocument::threads_of(sheet) -> Vec<CellThread>` (comments of a cell: root
  first, then replies in file order; person resolved from `person.xml`; `dT` verbatim; `done`),
  and `persons()`.
- **Write:** `add_thread`, `reply_thread`, `edit_thread_comment`, `delete_thread_comment`,
  `set_thread_done`. Each rewrites the threads part (through `XNode`, which keeps unknown
  attributes and children) and re-derives the note with the existing note writer, so the three
  stay in step. The first thread of a sheet creates the part, content type and relationship; the
  first person creates `person.xml` and the workbook relationship. A person is found by
  account (`userId` + `providerId`) and created on demand. Deleting a root deletes its replies and
  the note and shape; deleting the last comment of a sheet removes the threads part with its
  relationship and content type (`person.xml` stays, as Excel keeps it). Editing a text drops
  the comment's `mentions` (their offsets would no longer fit). Every other part keeps its bytes.
- **Ids and times come from the caller.** `GuidGen` is a seeded generator (splitmix64, version 4
  form, upper case in braces) so a test is deterministic and the crate needs no clock, OS
  randomness or new dependency (it builds for wasm32). `dT` is a caller-supplied string.
- **Refusals:** the note API (`set_note`, `delete_note`) still refuses a threaded cell, now
  naming the thread API. `add_thread` refuses a cell with a thread or a plain note (Excel's
  "convert note" is not offered).
- **Doors:** `SheetSession` and the wasm `SheetEngine` get `list_threads`, `add_thread`,
  `reply_thread`, `edit_thread_comment`, `delete_thread_comment`, `set_thread_done` (seed as a
  `u32`). The editor does not use them yet.

## Oracle (Excel 16, 2026-11-01)

The open-check packages are written by `cargo test -p sheet-xlsx -- --ignored write_oracle`
(`PAGED_TC_ORACLE_DIR`). Each was opened in Excel by AppleScript and saved again:

| Package | Excel on open | Re-saved package |
|---|---|---|
| add thread (new workbook, no comment parts) | loads, no dialog | thread, person and note kept; the note author `tc={id}` and the thread id are ours |
| add + reply by a second person | loads | both comments, `parentId` = root id, both persons |
| edit root text (`&` in it) | loads | new text in the thread and in the rebuilt note |
| resolve | loads | `done="1"` on the root only |
| two threads, delete a reply | loads | the reply is gone, both roots stay |
| delete a root | loads | its thread, note and shape are gone, the other thread stays |
| stale note text beside a thread | loads | note text rebuilt from the thread |

Excel changed on re-save: it wrote the comments part again (`xr:uid` on each comment,
`mc:Ignorable`), renumbered the sheet's relationship ids, listed persons in another order, and
kept our comment, person and thread ids and `dT` values. It did not change the threaded-comment
or person XML apart from this. AppleScript's `text of comment` returns nothing for a threaded
cell (the comment object is `missing value`), so the comment text was judged from the re-saved
package, not from the scripting reply.

## Consequences

- Threads are readable and editable in Rust; the editor wiring is a later step.
- A workbook another tool left with a thread but no note (or the reverse) gets its note
  rebuilt on the next thread write to that cell; reads never write.
- Sharing the same seed in two calls on the same workbook cannot collide ids: a drawn id is
  checked against the part's existing ids.
