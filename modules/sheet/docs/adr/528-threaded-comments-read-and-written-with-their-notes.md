# ADR 528 — Threaded comments: read and written together with their legacy notes

- **Status:** Accepted, 2026-11-01. Amends 526 (decision 3: threads were preserved and their note refused).
- **Scope:** `sheet-xlsx/src/threaded/`, `sheet-xlsx/src/comment_edit.rs`,
  `sheet-js/src/core/annotations.rs` (the session and wasm doors); the editor wiring is the amendment at the end.

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

- Threads are readable and editable in Rust and, through the amendment below, in the host's Comments panel.
- A workbook another tool left with a thread but no note (or the reverse) gets its note
  rebuilt on the next thread write to that cell; reads never write.
- Sharing the same seed in two calls on the same workbook cannot collide ids: a drawn id is
  checked against the part's existing ids.

## Amendment 2026-11-01 — the Comments panel (engine ADR 1055)

`sheet-bundle/src/comments-model.ts` keeps the workbook's threads and the document's comment threads in
step. A thread on a cell is an engine thread anchored `Cell { item, address }`: `item` is the sheet frame
that shows the cell (else the first frame of that sheet), `address` is `Sheet1!B3` (sheet names quoted as
in a formula). Comment ids are the workbook's GUIDs, so no mapping table is kept; the person ids are the
workbook's person ids. The workbook stays the truth of the xlsx and is saved as the document's container
part as before; the document's threads are what the panel reads and writes.

`sync` reconciles three ways against the snapshot of the last reconcile (kept in memory): a workbook-side
change is edited into the document, a panel-side change (reply, edit, resolve, reopen, delete) is written
to the workbook through the thread doors and queues its save; the workbook wins when both moved the same
text. It runs after a workbook is loaded and on every document change. A reply made in the panel gets the
workbook's GUID in place of the panel's id. Deleting the sheet frame orphans its threads (the engine's
rule); the workbook keeps them.

## Amendment 2026-11-01 (2) — where a pin sits, and New comment

Where: the bundle contributes `commentAnchor` (`media.paged.sheet.commentAnchor.cell`), so the canvas pins
a cell thread at its cell. `resolve(address, item)` reads the table the frame holds (`LoweredContent` of
the placed table): the rectangle of the cell in points from the frame's top-left, counting the printed
heading strip, the frozen rows and only the tracks that are shown (hidden rows and columns have no
track). It answers null, and the pin stays at the frame's top-left, when the address is not
`Sheet!A1[:B2]`, names another sheet than the frame shows, the frame is a continuation of a chain,
no table is known for it, or the cell is hidden, scrolled out of the window or past the content box. A
range answers the rectangle of its shown cells. The label is the address.

New comment: the command `media.paged.sheet.command.newComment` (Sheet menu, the grid's right-click) opens a
card under the sheet bar like the other cell cards (a text field, OK, Cancel; the sheet bar exists while
a frame is entered). OK calls `host.comments.startThread({ kind: "cell", item, address }, text)` for the
active cell, `item` being the entered frame when it shows the sheet. The next reconcile writes the thread
into the workbook (`addThread`, its replies after it) and swaps the document's thread for one with the
workbook's ids and the xlsx source. A cell that already has a thread takes the text as a reply (one thread
per cell, as in Excel). A cell thread started by another tool through the comments door is taken the same
way.

Not done: a thread started from the host's own Comments panel on a cell (the panel starts item, page and
text threads), plain notes as threads, thread edits in the sheet's own undo journal (the document's undo covers the panel's
side and the reconcile mirrors it), a sheet no frame shows (its threads wait for one).
